/**
 * Netlify Serverless Function
 */
import serverless from 'serverless-http';
import { app } from '../../main.js';

// 规范化 Netlify event，使 body 始终为 JSON 字符串
function normalizeEvent(event) {
  event.headers = event.headers || {};
  const headers = event.headers;
  const getHeader = (key) => headers[key] || headers[key?.toLowerCase?.()] || headers[key?.toUpperCase?.()];

  // 如果 body 是对象
  if (event.body && typeof event.body === 'object') {
    const keys = Object.keys(event.body);
    // 类数组对象：{0:'{',1:'"',...} -> 拼接还原字符串
    if (keys.length > 0 && keys[0] === '0') {
      try {
        event.body = Object.values(event.body).join('');
      } catch {}
    } else {
      try {
        event.body = JSON.stringify(event.body);
      } catch {}
    }
  }

  // 如果是 base64 编码
  if (typeof event.body === 'string' && event.isBase64Encoded) {
    try {
      event.body = Buffer.from(event.body, 'base64').toString();
      event.isBase64Encoded = false;
    } catch {}
  }

  // 确保 Content-Type 为 application/json（避免平台误判）
  if (!getHeader('content-type')) {
    headers['content-type'] = 'application/json';
  }

  return event;
}

const wrapped = serverless(app);
export const handler = async (event, context) => {
  return wrapped(normalizeEvent(event || {}), context);
};
