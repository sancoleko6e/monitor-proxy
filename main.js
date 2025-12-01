/**
 * Twitter API 代理服务
 * - 支持包方法调用（通过 apiMethod）和原始请求（通过 endpoint）
 * - headers 和 flag 由主项目传入，避免额外请求
 */
import express from 'express';
import { TwitterOpenApi, TwitterOpenApiClient } from 'twitter-openapi-typescript';
import { Configuration } from 'twitter-openapi-typescript-generated';
import { generateTransactionId } from 'x-client-transaction-id-generater';
import 'dotenv/config';

const API_TOKEN = process.env.API_TOKEN || '';
// 注意: Serverless 环境下不能 process.exit，改为在请求时检查

/**
 * API方法映射表
 * 格式: { 方法名: (client, params) => Promise }
 * 新增方法只需在此添加一行
 */
const API_METHODS = {
    getUserByScreenName: (c, p) => c.getUserApi().getUserByScreenName(p),
    getHomeLatestTimeline: (c, p) => c.getTweetApi().getHomeLatestTimeline(p),
    getUserTweets: (c, p) => c.getTweetApi().getUserTweets(p),
    getFollowing: (c, p) => c.getUserListApi().getFollowing(p),
    postCreateFriendships: (c, p) => c.getV11PostApi().postCreateFriendships(p),
    postDestroyFriendships: (c, p) => c.getV11PostApi().postDestroyFriendships(p),
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
    
    const config = {
        fetchApi: TwitterOpenApi.fetchApi,
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
    
    return new TwitterOpenApiClient(new Configuration(config), flag, initOverrides);
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
    
    // 构建 URL
    let url = `https://api.x.com${endpoint}`;
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

// Serverless 兼容：处理 Vercel/Netlify 请求体解析差异
app.use((req, res, next) => {
    // 情况1: 已经是对象（Vercel 预解析）
    if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
        return next();
    }
    // 情况2: 是字符串（Netlify 可能传递字符串形式的 JSON）
    if (req.body && typeof req.body === 'string') {
        try {
            req.body = JSON.parse(req.body);
            return next();
        } catch (e) {
            // 解析失败，继续使用 express.json()
        }
    }
    // 情况3: 使用 express.json() 解析
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
    
    // 参数验证（附带调试信息帮助排查解析问题）
    if (!authToken || !ct0Token) {
        return res.status(400).json({ 
            success: false, 
            error: '缺少: authToken, ct0Token',
            debug: { bodyType: typeof req.body, hasBody: !!req.body, keys: req.body ? Object.keys(req.body) : [] }
        });
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
        // 统一错误处理
        const { status, message, body } = parseError(error);
        res.status(status >= 400 && status < 600 ? status : 500).json({
            success: false, error: message, statusCode: status,
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
