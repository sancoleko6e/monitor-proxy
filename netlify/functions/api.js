/**
 * Netlify Serverless Function
 */
import serverless from 'serverless-http';
import { app } from '../../main.js';

// 预处理 event.body（Netlify 传递的是字符串）
const wrappedHandler = serverless(app);
export const handler = async (event, context) => {
    if (event.body && typeof event.body === 'string') {
        try { event.body = JSON.parse(event.body); } catch {}
    }
    return wrappedHandler(event, context);
};
