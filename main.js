/**
 * 代理项目 - 支持包方法和原始请求
 * headers和flag由主项目传入，避免额外请求
 */

import express from 'express';
import { TwitterOpenApi, TwitterOpenApiClient } from 'twitter-openapi-typescript';
import { Configuration } from 'twitter-openapi-typescript-generated';
import { generateTransactionId } from 'x-client-transaction-id-generater';
import { config as dotenvConfig } from 'dotenv';

// 加载环境变量（静默模式）
// 临时屏蔽console.log以避免dotenv 17.x的提示信息
const originalLog = console.log;
console.log = () => {};
dotenvConfig();
console.log = originalLog;

const CONFIG = {
    port: parseInt(process.env.PORT || '3003', 10),
    apiToken: process.env.API_TOKEN || ''
};

if (!CONFIG.apiToken) process.exit(1);

class TwitterProxyApi {
    /**
     * 设置Cookie到请求上下文
     */
    setCookies(context, cookies) {
        const cookieString = Object.entries(cookies).map(([key, value]) => `${key}=${value}`).join('; ');
        if (!context.init.headers) context.init.headers = {};
        context.init.headers.cookie = cookieString;
    }

    /**
     * 创建Twitter客户端 - 使用传来的headers和flag
     */
    async createClient(authToken, ct0Token, headers, flag, pairData) {
        const cookies = { auth_token: authToken };
        if (ct0Token) cookies.ct0 = ct0Token;

        // 使用传来的headers构建API key配置
        const api_key = { ...headers.api };
        if (ct0Token) {
            api_key['x-twitter-auth-type'] = 'OAuth2Session';
            api_key['x-csrf-token'] = ct0Token;
        }

        // 创建配置
        const config = {
            fetchApi: TwitterOpenApi.fetchApi,
            middleware: [{ pre: async (context) => this.setCookies(context, cookies) }],
            apiKey: (key) => api_key[key.toLowerCase()],
            accessToken: TwitterOpenApi.bearer,
        };

        // 创建自定义的initOverrides使用传来的pairData生成transaction ID
        const initOverrides = async ({ context, init }) => {
            const urlPath = `/i/api${context.path}`;
            if (pairData?.verification && pairData?.animationKey) {
                const transactionId = await generateTransactionId(
                    context.method, urlPath, pairData.verification, pairData.animationKey
                );
                if (transactionId) init.headers = { ...init.headers, 'x-client-transaction-id': transactionId };
            }
            return init;
        };

        return new TwitterOpenApiClient(new Configuration(config), flag, initOverrides);
    }

    /**
     * 读取Response Body（支持ReadableStream）
     */
    async readResponseBody(response) {
        if (!response || response.bodyUsed) return '';
        
        try {
            const jsonBody = await response.json();
            return JSON.stringify(jsonBody);
        } catch (e) {
            try {
                return await response.text();
            } catch (e2) {
                return '';
            }
        }
    }

    /**
     * 调用客户端方法
     */
    async invokeClientMethod(client, apiMethod, apiParams) {
        try {
            switch (apiMethod) {
                case 'getUserByScreenName':
                    return await client.getUserApi().getUserByScreenName(apiParams);
                case 'getHomeLatestTimeline':
                    return await client.getTweetApi().getHomeLatestTimeline(apiParams);
                case 'getUserTweets':
                    return await client.getTweetApi().getUserTweets(apiParams);
                case 'getFollowing':
                    return await client.getUserListApi().getFollowing(apiParams);
                case 'postCreateFriendships':
                    return await client.getV11PostApi().postCreateFriendships(apiParams);
                case 'postDestroyFriendships':
                    return await client.getV11PostApi().postDestroyFriendships(apiParams);
                default:
                    throw new Error(`不支持的API方法: ${apiMethod}`);
            }
        } catch (error) {
            if (!error.response) throw error;
            
            const response = error.response;
            const responseBody = error.data ? JSON.stringify(error.data)
                : error.errors ? JSON.stringify({ errors: error.errors })
                : await this.readResponseBody(response);
            
            // 精简URL（移除过长的参数）
            let simplifiedUrl = response.url;
            if (simplifiedUrl && simplifiedUrl.length > 200) {
                const urlObj = new URL(simplifiedUrl);
                simplifiedUrl = `${urlObj.origin}${urlObj.pathname}?[参数已省略]`;
            }
            
            // 构建详细的错误消息
            let errorMessage = `HTTP ${response.status}: ${response.statusText || 'Unknown'}`;
            
            // 尝试从responseBody中提取Twitter API的详细错误
            try {
                const parsedBody = typeof responseBody === 'string' ? JSON.parse(responseBody) : responseBody;
                if (parsedBody && parsedBody.errors && parsedBody.errors.length > 0) {
                    const apiError = parsedBody.errors[0];
                    const errDetail = apiError.message || apiError.detail || '';
                    if (errDetail) {
                        errorMessage = `HTTP ${response.status}: ${errDetail}`;
                        if (apiError.code) {
                            errorMessage += ` (code=${apiError.code})`;
                        }
                    }
                } else if (parsedBody && parsedBody.error) {
                    errorMessage = `HTTP ${response.status}: ${parsedBody.error}`;
                }
            } catch (parseError) {
                // JSON解析失败，使用默认消息
            }
            
            const enhancedError = new Error(errorMessage);
            enhancedError.response = {
                status: response.status,
                statusText: response.statusText,
                url: simplifiedUrl,
                body: responseBody,
                headers: {} // 精简：移除headers
            };
            throw enhancedError;
        }
    }

    /**
     * 原始Twitter API请求 - 使用传来的headers
     */
    async makeDirectRequest({ authToken, ct0Token, method, endpoint, queryParams, body, extraHeaders, headers, pairData }) {
        if (!ct0Token) throw new Error('CT0令牌缺失');

        // 使用传来的headers
        const requestHeaders = { ...headers.api, ...extraHeaders };
        requestHeaders['x-twitter-auth-type'] = 'OAuth2Session';
        requestHeaders['x-csrf-token'] = ct0Token;
        requestHeaders['cookie'] = `auth_token=${authToken}; ct0=${ct0Token};`;

        // 构建URL
        let url = `https://api.x.com${endpoint}`;
        if (queryParams && Object.keys(queryParams).length > 0) {
            const searchParams = new URLSearchParams();
            for (const [key, value] of Object.entries(queryParams)) {
                if (value !== null && value !== undefined) searchParams.append(key, String(value));
            }
            url += `?${searchParams.toString()}`;
        }

        // 生成transaction ID
        if (pairData?.verification && pairData?.animationKey) {
            const urlPath = new URL(url).pathname;
            const transactionId = await generateTransactionId(method, urlPath, pairData.verification, pairData.animationKey);
            if (transactionId) requestHeaders['x-client-transaction-id'] = transactionId;
        }

        // 发送请求
        const requestOptions = { method: method.toUpperCase(), headers: requestHeaders };
        if (body) {
            requestOptions.body = typeof body === 'string' ? body : JSON.stringify(body);
            requestHeaders['content-type'] = 'application/json';
        }

        const response = await TwitterOpenApi.fetchApi(url, requestOptions);
        if (!response.ok) {
            // 捕获完整错误信息
            const responseBody = await response.text().catch(() => '');
            const error = new Error(`HTTP ${response.status}: ${response.statusText}`);
            error.response = {
                status: response.status,
                statusText: response.statusText,
                url: response.url,
                body: responseBody,
                headers: Object.fromEntries(response.headers.entries())
            };
            throw error;
        }
        return await response.json();
    }

    /**
     * 执行API调用 - 统一入口
     */
    async executeApiCall(params) {
        const { authToken, ct0Token, headers, flag, pairData } = params;
        if (!headers || !flag) throw new Error('缺少必要参数: headers 和 flag 必须由主项目传入');

        // 判断调用方式：包方法或原始请求
        if (params.apiMethod) {
            const { apiMethod, apiParams } = params;
            const client = await this.createClient(authToken, ct0Token, headers, flag, pairData);
            return await this.invokeClientMethod(client, apiMethod, apiParams);
        } else if (params.endpoint) {
            return await this.makeDirectRequest(params);
        } else {
            throw new Error('缺少必要参数: apiMethod 或 endpoint');
        }
    }
}

// Express应用
const app = express();
const twitterApi = new TwitterProxyApi();

app.use(express.json({ limit: '10mb' }));

// Token认证
app.use((req, res, next) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token || token !== CONFIG.apiToken) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    next();
});

// Twitter代理接口
app.post('/api/twitter/proxy', async (req, res) => {
    try {
        const { authToken, ct0Token, headers, flag, apiMethod, endpoint, apiParams, queryParams } = req.body;

        // 参数验证
        if (!authToken || !ct0Token) {
            return res.status(400).json({ success: false, error: '缺少必要参数: authToken, ct0Token' });
        }
        if (!headers || !flag) {
            return res.status(400).json({ success: false, error: '缺少必要参数: headers, flag' });
        }
        if (!apiMethod && !endpoint) {
            return res.status(400).json({ success: false, error: '必须提供 apiMethod 或 endpoint' });
        }

        const result = await twitterApi.executeApiCall(req.body);
        
        res.json({ success: true, data: result });
    } catch (error) {
        // 提取HTTP状态码
        let statusCode = 500;
        if (error.response?.status) {
            statusCode = error.response.status;
        } else {
            const match = error.message.match(/HTTP (\d+)/);
            if (match) statusCode = parseInt(match[1], 10);
        }
        
        // 构建详细的错误消息
        let errorMessage = error.message || 'API调用失败';
        let errorBody = null;
        
        // 尝试解析响应体以获取Twitter API的详细错误
        if (error.response?.body) {
            try {
                errorBody = typeof error.response.body === 'string'
                    ? JSON.parse(error.response.body)
                    : error.response.body;
                
                // 从Twitter API错误中提取详细信息
                if (errorBody.errors && errorBody.errors.length > 0) {
                    const apiError = errorBody.errors[0];
                    const errDetail = apiError.message || apiError.detail || '';
                    if (errDetail) {
                        errorMessage = `HTTP ${statusCode}: ${errDetail}`;
                        if (apiError.code) {
                            errorMessage += ` (code=${apiError.code})`;
                        }
                    }
                } else if (errorBody.error) {
                    errorMessage = `HTTP ${statusCode}: ${errorBody.error}`;
                }
            } catch (parseError) {
                // JSON解析失败，使用原始body
                if (typeof error.response.body === 'string' && error.response.body) {
                    errorMessage = `HTTP ${statusCode}: ${error.response.body.substring(0, 200)}`;
                }
            }
        }
        
        // 返回详细错误信息，包括原始Twitter API的错误
        const errorResponse = {
            success: false,
            error: errorMessage,
            statusCode: statusCode,
            // 尝试提取更详细的错误信息
            details: {
                message: error.message,
                // 如果错误对象有response属性，尝试提取
                ...(error.response && {
                    status: error.response.status,
                    statusText: error.response.statusText,
                    url: error.response.url,
                    body: errorBody || error.response.body
                })
            }
        };
        
        res.status(statusCode >= 400 && statusCode < 600 ? statusCode : 500).json(errorResponse);
    }
});

// 404处理
app.use((req, res) => {
    res.status(404).json({ success: false, error: 'Not Found' });
});

// 启动服务器
const server = app.listen(CONFIG.port);
server.on('error', () => process.exit(1));
