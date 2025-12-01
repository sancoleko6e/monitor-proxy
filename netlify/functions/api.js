/**
 * Netlify Serverless Function
 * 只处理 Netlify 特殊情况（字符数组对象），其余交给 Express
 */
import serverless from 'serverless-http';
import { app } from '../../main.js';

const wrapped = serverless(app);

export const handler = async (event, context) => {
  // 只处理 Netlify 的字符数组对象问题
  if (event.body && typeof event.body === 'object' && !Array.isArray(event.body)) {
    const keys = Object.keys(event.body);
    // 字符数组对象 {0:'{', 1:'"', ...} → 还原为字符串
    if (keys.length > 0 && keys[0] === '0') {
      event.body = Object.values(event.body).join('');
    }
  }
  
  return wrapped(event, context);
};
