/**
 * Netlify Serverless Function - 包装 main.js
 */
import serverless from 'serverless-http';
import { app } from '../../main.js';

export const handler = serverless(app);
