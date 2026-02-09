/**
 * Twitter API 代理服务
 * - 支持包方法调用（通过 apiMethod）和原始请求（通过 endpoint）
 * - headers 和 flag 由主项目传入，避免额外请求
 */
import express from 'express';
import { TwitterOpenApi, TwitterOpenApiClient } from 'twitter-openapi-typescript';
import { Configuration } from 'twitter-openapi-typescript-generated';
import { generateTransactionId } from 'x-client-transaction-id-generater';
import { fetch as undiciFetch, Agent } from 'undici';
import 'dotenv/config';

// 创建带有连接复用和超时配置的 undici Agent
const undiciAgent = new Agent({
    keepAliveTimeout: 30000,      // 连接保活超时 30 秒
    keepAliveMaxTimeout: 60000,   // 最大保活超时 60 秒
    connections: 10,              // 每个 origin 最多 10 个连接
    pipelining: 1,                // 管道化请求
    connect: {
        timeout: 10000            // 连接超时 10 秒
    }
});

// 创建带有 Agent 配置的自定义 fetch
const customFetch = (url, options = {}) => {
    return undiciFetch(url, {
        ...options,
        dispatcher: undiciAgent
    });
};

// 使用自定义 fetch 替换 TwitterOpenApi 的 fetchApi
TwitterOpenApi.fetchApi = customFetch;

const API_TOKEN = process.env.API_TOKEN || '';
// 注意: Serverless 环境下不能 process.exit，改为在请求时检查

/**
 * API方法映射表
 * 格式: { 方法名: (client, params) => Promise }
 * 新增方法只需在此添加一行
 */
const API_METHODS = {
    getUserByScreenName: (c, p) => c.getUserApi().getUserByScreenName(p),
    getUserByRestId: (c, p) => c.getUserApi().getUserByRestId(p),
    getHomeLatestTimeline: (c, p) => c.getTweetApi().getHomeLatestTimeline(p),
    getUserTweets: (c, p) => c.getTweetApi().getUserTweets(p),
    getTweetDetail: (c, p) => c.getTweetApi().getTweetDetail(p),        // 删推监控：获取推文详情
    getFollowing: (c, p) => c.getUserListApi().getFollowing(p),
    postCreateFriendships: (c, p) => c.getV11PostApi().postCreateFriendships(p),
    postDestroyFriendships: (c, p) => c.getV11PostApi().postDestroyFriendships(p),
    postCreateRetweet: (c, p) => c.getPostApi().postCreateRetweet(p),   // 删推监控：转发推文
    postDeleteRetweet: (c, p) => c.getPostApi().postDeleteRetweet(p),   // 删推监控：取消转发
};

/**
 * 读取 Response Body（支持 ReadableStream）
 * @param {Response} response - fetch response 对象
 * @returns {Promise<string>} 响应体字符串
 */
const readResponseBody = async (response) => {
    if (!response || response.bodyUsed) return '';
    try {
        return JSON.stringify(await response.json());
    } catch {
        try { return await response.text(); } catch { return ''; }
    }
};

/**
 * 解析错误信息，提取 Twitter API 的详细错误
 * @param {Error} error - 错误对象
 * @returns {{ status: number, message: string, body: object|null }}
 */
const parseError = (error) => {
    const status = error.response?.status || parseInt(error.message.match(/HTTP (\d+)/)?.[1]) || 500;
    let message = error.message || 'API调用失败';
    let body = null;
    
    // 添加 cause 信息（用于调试 fetch 底层错误）
    if (error.cause) {
        const causeMsg = error.cause instanceof Error 
            ? error.cause.message 
            : (error.cause?.message || String(error.cause));
        if (causeMsg && !message.includes(causeMsg)) {
            message = `${message} (原因: ${causeMsg})`;
        }
    }
    
    if (error.response?.body) {
        try {
            body = typeof error.response.body === 'string' ? JSON.parse(error.response.body) : error.response.body;
            const apiErr = body.errors?.[0];
            if (apiErr?.message || apiErr?.detail) {
                message = `HTTP ${status}: ${apiErr.message || apiErr.detail}${apiErr.code ? ` (code=${apiErr.code})` : ''}`;
            } else if (body.error) {
                message = `HTTP ${status}: ${body.error}`;
            }
        } catch {}
    }
    return { status, message, body };
};

/**
 * 生成 x-client-transaction-id
 * @param {string} method - HTTP 方法
 * @param {string} path - URL 路径
 * @param {object} pairData - 包含 verification 和 animationKey
 * @returns {Promise<string|null>}
 */
const genTxId = async (method, path, pairData) => {
    if (!pairData?.verification || !pairData?.animationKey) return null;
    return generateTransactionId(method, path, pairData.verification, pairData.animationKey);
};

/**
 * 创建 Twitter 客户端
 * @param {string} authToken - auth_token cookie
 * @param {string} ct0Token - ct0 cookie (CSRF token)
 * @param {object} headers - 主项目传来的 headers 配置
 * @param {object} flag - 主项目传来的 flag 配置
 * @param {object} pairData - transaction ID 生成所需数据
 * @returns {Promise<TwitterOpenApiClient>}
 */
const createClient = async (authToken, ct0Token, headers, flag, pairData) => {
    const cookies = { auth_token: authToken, ...(ct0Token && { ct0: ct0Token }) };
    const apiKey = { ...headers.api, ...(ct0Token && { 'x-twitter-auth-type': 'OAuth2Session', 'x-csrf-token': ct0Token }) };
    
    // 包装 fetchApi，捕获原始 HTTP 响应信息（用于诊断包内部解析错误）
    const responseCapture = { status: null, statusText: null, url: null, _clonedResponse: null };
    const originalFetchApi = TwitterOpenApi.fetchApi;
    const wrappedFetchApi = async (...args) => {
        const response = await originalFetchApi(...args);
        try {
            const cloned = response.clone();
            const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
            responseCapture.status = response.status;
            responseCapture.statusText = response.statusText;
            responseCapture.url = url.length > 200 ? url.substring(0, 200) + '...' : url;
            responseCapture._clonedResponse = cloned;
        } catch (e) { /* 忽略捕获失败 */ }
        return response;
    };

    const config = {
        fetchApi: wrappedFetchApi,
        middleware: [{
            // 设置 Cookie 到请求上下文
            pre: async (ctx) => {
                ctx.init.headers = { ...ctx.init.headers, cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ') };
            }
        }],
        apiKey: (key) => apiKey[key.toLowerCase()],
        accessToken: TwitterOpenApi.bearer,
    };
    
    // 使用 pairData 生成 transaction ID
    const initOverrides = async ({ context, init }) => {
        const txId = await genTxId(context.method, `/i/api${context.path}`, pairData);
        if (txId) init.headers = { ...init.headers, 'x-client-transaction-id': txId };
        return init;
    };
    
    const client = new TwitterOpenApiClient(new Configuration(config), flag, initOverrides);
    client._responseCapture = responseCapture;
    return client;
};

/**
 * 执行包方法调用
 * @param {TwitterOpenApiClient} client - Twitter 客户端
 * @param {string} method - API 方法名
 * @param {object} params - 方法参数
 * @returns {Promise<any>}
 */
const invokeMethod = async (client, method, params) => {
    const fn = API_METHODS[method];
    if (!fn) throw new Error(`不支持的API方法: ${method}`);
    
    try {
        return await fn(client, params);
    } catch (error) {
        // 检查是否为包内部解析错误（如 Cannot read properties of undefined）
        const errorMsg = error?.message || '';
        if (errorMsg.includes('Cannot read properties of undefined') ||
            errorMsg.includes('Denied by access control')) {
            // 从 client._responseCapture 获取原始 HTTP 响应信息
            let rawStatusCode = null;
            let rawBodyPreview = null;
            let rawResponseDiag = '';
            const capture = client?._responseCapture;
            if (capture && capture.status !== null) {
                rawStatusCode = capture.status;
                rawResponseDiag = ` [HTTP ${rawStatusCode} ${capture.statusText || ''}]`;
                try {
                    if (capture._clonedResponse) {
                        const bodyText = await capture._clonedResponse.text();
                        rawBodyPreview = bodyText.substring(0, 500);
                        rawResponseDiag += ` body: ${rawBodyPreview.substring(0, 200)}`;
                        capture._clonedResponse = null;
                    }
                } catch (e) { /* 忽略读取失败 */ }
            }

            // HTTP 200 + 响应体无错误标识 = 空数据响应（如空时间线），非账号异常
            if (rawStatusCode === 200 && rawBodyPreview) {
                const hasErrorIndicator = rawBodyPreview.includes('"errors"') ||
                                          rawBodyPreview.includes('"code"') ||
                                          rawBodyPreview.includes('suspended') ||
                                          rawBodyPreview.includes('locked');
                if (!hasErrorIndicator) {
                    // 返回null表示空数据，主项目会正常处理
                    return null;
                }
            }

            const enhanced = new Error(`API响应异常，数据解析失败${rawResponseDiag}[${errorMsg}]`);
            enhanced.response = {
                status: rawStatusCode || 500,
                statusText: 'API Response Parse Error',
                body: rawBodyPreview
            };
            throw enhanced;
        }

        if (!error.response) throw error;
        
        const { status, statusText, url } = error.response;
        // 尝试多种方式获取响应体
        const body = error.data ? JSON.stringify(error.data)
            : error.errors ? JSON.stringify({ errors: error.errors })
            : await readResponseBody(error.response);
        
        // 精简过长的 URL
        let simplifiedUrl = url;
        if (url?.length > 200) {
            try {
                const urlObj = new URL(url);
                simplifiedUrl = `${urlObj.origin}${urlObj.pathname}?[参数已省略]`;
            } catch { /* 保持原 URL */ }
        }
        
        const enhanced = new Error(`HTTP ${status}: ${statusText || 'Unknown'}`);
        enhanced.response = { status, statusText, url: simplifiedUrl, body };
        throw enhanced;
    }
};

/**
 * 执行原始 Twitter API 请求
 * @param {object} params - 请求参数
 * @returns {Promise<any>}
 * 
 * 重要：Twitter API 域名说明
 * - GraphQL API (/i/api/graphql/..., /i/api/1.1/...) 必须使用 https://x.com
 * - REST API (/1.1/..., /2/...) 使用 https://api.x.com
 * 使用错误的域名会导致 HTTP 404 错误
 */
const directRequest = async ({ authToken, ct0Token, method, endpoint, queryParams, body, extraHeaders, headers, pairData }) => {
    if (!ct0Token) throw new Error('CT0令牌缺失');
    
    // 构建请求头
    const reqHeaders = {
        ...headers.api, ...extraHeaders,
        'x-twitter-auth-type': 'OAuth2Session',
        'x-csrf-token': ct0Token,
        cookie: `auth_token=${authToken}; ct0=${ct0Token};`,
    };
    
    // 构建 URL - GraphQL API使用x.com，REST API使用api.x.com
    const baseUrl = endpoint.startsWith('/i/api/') ? 'https://x.com' : 'https://api.x.com';
    let url = `${baseUrl}${endpoint}`;
    if (queryParams) {
        const params = new URLSearchParams();
        Object.entries(queryParams).forEach(([k, v]) => v != null && params.append(k, String(v)));
        if (params.toString()) url += `?${params}`;
    }
    
    // 生成 transaction ID
    const txId = await genTxId(method, new URL(url).pathname, pairData);
    if (txId) reqHeaders['x-client-transaction-id'] = txId;
    
    // 构建请求选项
    const opts = { method: method.toUpperCase(), headers: reqHeaders };
    if (body) {
        opts.body = typeof body === 'string' ? body : JSON.stringify(body);
        reqHeaders['content-type'] = 'application/json';
    }
    
    // 发送请求
    const response = await TwitterOpenApi.fetchApi(url, opts);
    if (!response.ok) {
        const error = new Error(`HTTP ${response.status}: ${response.statusText}`);
        error.response = {
            status: response.status,
            statusText: response.statusText,
            url: response.url,
            body: await response.text().catch(() => ''),
        };
        throw error;
    }
    return response.json();
};

// ============ Express 应用 ============
const app = express();

// 请求体解析：先修正 serverless-http 的 Buffer 问题，再用标准解析
app.use((req, res, next) => {
    // serverless-http 可能把 JSON 字符串解析成 Buffer，需要手动修正
    if (Buffer.isBuffer(req.body)) {
        try {
            req.body = JSON.parse(req.body.toString());
            return next();
        } catch (e) {
            return res.status(400).json({ success: false, error: 'Invalid JSON' });
        }
    }
    // 其他情况用标准 JSON 解析
    express.json({ limit: '10mb' })(req, res, next);
});

// Token 认证中间件
app.use((req, res, next) => {
    // 检查服务器配置
    if (!API_TOKEN) {
        return res.status(500).json({ success: false, error: 'Server configuration error: API_TOKEN not set' });
    }
    // 验证请求 Token
    if (req.headers.authorization?.replace('Bearer ', '') !== API_TOKEN) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    next();
});

/**
 * Twitter 代理接口
 * POST /api/twitter/proxy
 * 
 * 请求体参数:
 * - authToken: Twitter auth_token
 * - ct0Token: Twitter ct0 (CSRF token)
 * - headers: 主项目传来的 headers 配置
 * - flag: 主项目传来的 flag 配置
 * - pairData: { verification, animationKey } 用于生成 transaction ID
 * - apiMethod: 包方法名 (与 endpoint 二选一)
 * - apiParams: 包方法参数
 * - endpoint: 原始请求端点 (与 apiMethod 二选一)
 * - queryParams: 原始请求查询参数
 * - body: 原始请求体
 * - extraHeaders: 额外请求头
 */
app.post('/api/twitter/proxy', async (req, res) => {
    const { authToken, ct0Token, headers, flag, apiMethod, endpoint } = req.body || {};
    
    // 参数验证
    if (!authToken || !ct0Token) {
        return res.status(400).json({ success: false, error: '缺少: authToken, ct0Token' });
    }
    if (!headers || !flag) return res.status(400).json({ success: false, error: '缺少: headers, flag' });
    if (!apiMethod && !endpoint) return res.status(400).json({ success: false, error: '需提供 apiMethod 或 endpoint' });
    
    try {
        let result;
        if (apiMethod) {
            // 包方法调用
            const client = await createClient(authToken, ct0Token, headers, flag, req.body.pairData);
            result = await invokeMethod(client, apiMethod, req.body.apiParams);
        } else {
            // 原始请求
            result = await directRequest(req.body);
        }
        res.json({ success: true, data: result });
    } catch (error) {
        // 统一错误处理，包含 apiMethod/endpoint 便于调试
        const { status, message, body } = parseError(error);
        const method = apiMethod || endpoint || 'unknown';
        res.status(status >= 400 && status < 600 ? status : 500).json({
            success: false, 
            error: `[${method}] ${message}`, 
            statusCode: status,
            apiMethod: method,
            details: { message: error.message, ...(error.response && { status: error.response.status, body: body || error.response.body }) }
        });
    }
});

// 404 处理
app.use((_, res) => res.status(404).json({ success: false, error: 'Not Found' }));

// 导出 app 供 Vercel/Netlify Serverless 使用
export { app };
export default app;

// 本地运行时启动服务器（Serverless 环境下不执行）
if (process.argv[1]?.includes('main.js')) {
    app.listen(process.env.PORT || 3003).on('error', () => process.exit(1));
}
