# Twitter API 代理服务

Twitter API 代理服务，用于分布式架构中转发 Twitter API 请求，支持部署到 Vercel、Netlify 等 Serverless 平台。

## 功能特性

- 支持包方法调用（通过 `apiMethod`）
- 支持原始请求转发（通过 `endpoint`）
- 自动生成 `x-client-transaction-id`
- 兼容 Vercel/Netlify Serverless 环境
- Token 认证保护

## 支持的 API 方法

| 方法名 | 说明 |
|--------|------|
| `getUserByScreenName` | 通过用户名获取用户信息 |
| `getHomeLatestTimeline` | 获取主页最新时间线 |
| `getUserTweets` | 获取用户推文 |
| `getFollowing` | 获取关注列表 |
| `postCreateFriendships` | 关注用户 |
| `postDestroyFriendships` | 取消关注用户 |

## 部署方式

### 方式一：Vercel 部署

1. Fork 本仓库到你的 GitHub
2. 在 Vercel 中导入项目
3. 配置环境变量 `API_TOKEN`
4. 部署完成

### 方式二：Netlify 部署

1. Fork 本仓库到你的 GitHub
2. 在 Netlify 中导入项目
3. 配置环境变量 `API_TOKEN`
4. 部署完成

### 方式三：本地运行

```bash
# 安装依赖
npm install

# 配置环境变量
cp .example.env .env
# 编辑 .env 文件，设置 API_TOKEN

# 启动服务
npm start
```

## 环境变量

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `PORT` | 服务端口 | 3003 |
| `API_TOKEN` | API 认证 Token | 必填 |

## API 接口

### POST /api/twitter/proxy

Twitter API 代理接口

**请求头：**
```
Content-Type: application/json
Authorization: Bearer <API_TOKEN>
```

**请求体参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `authToken` | string | 是 | Twitter auth_token |
| `ct0Token` | string | 是 | Twitter ct0 (CSRF token) |
| `headers` | object | 是 | 主项目传来的 headers 配置 |
| `flag` | object | 是 | 主项目传来的 flag 配置 |
| `pairData` | object | 否 | transaction ID 生成数据 |
| `apiMethod` | string | 二选一 | 包方法名 |
| `apiParams` | object | 否 | 包方法参数 |
| `endpoint` | string | 二选一 | 原始请求端点 |
| `queryParams` | object | 否 | 原始请求查询参数 |
| `body` | object | 否 | 原始请求体 |
| `extraHeaders` | object | 否 | 额外请求头 |

**响应示例：**

成功：
```json
{
  "success": true,
  "data": { ... }
}
```

失败：
```json
{
  "success": false,
  "error": "错误信息",
  "statusCode": 400,
  "details": { ... }
}
```

## 主项目配置

在主项目的 `.env` 中配置：

```env
# 启用代理
TWITTER_PROXY_ENABLED=true

# 代理服务器地址和 Token
PROXY_1_API_URL=https://your-proxy.vercel.app
PROXY_1_API_TOKEN=your_api_token_here
```

## 技术栈

- Node.js >= 20
- Express 5.x
- twitter-openapi-typescript

## License

MIT
