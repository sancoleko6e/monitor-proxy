/**
 * Netlify Serverless Function
 */
import serverless from 'serverless-http';
import { app } from '../../main.js';

// 预处理 event.body
const wrappedHandler = serverless(app);
export const handler = async (event, context) => {
    // 情况1: event.body 是字符串
    if (event.body && typeof event.body === 'string') {
        try { event.body = JSON.parse(event.body); } catch {}
    }
    // 情况2: event.body 是类数组对象 {0:'x', 1:'y', ...}
    else if (event.body && typeof event.body === 'object') {
        const keys = Object.keys(event.body);
        if (keys.length > 0 && keys[0] === '0') {
            // 是类数组，需要转换
            try {
                const jsonStr = Object.values(event.body).join('');
                event.body = JSON.parse(jsonStr);
            } catch {}
        }
    }
    return wrappedHandler(event, context);
};
