import dotenv from 'dotenv';
// 加载环境变量
dotenv.config();

import express from 'express';
import cors from 'cors';
import { authRoutes } from './routes/auth';
import { staffRoutes } from './routes/staff';
import { agentRoutes } from './routes/agents';
import { crownAutomationRoutes } from './routes/crown-automation';
import { accountRoutes } from './routes/accounts';
import { groupRoutes } from './routes/groups';
import { matchRoutes } from './routes/matches';
import { betRoutes } from './routes/bets';
import { whitelabelRoutes } from './routes/whitelabels';
import { coinRoutes } from './routes/coins';
import { aliasRoutes } from './routes/aliases';
import { crownMatchRoutes } from './routes/crown-matches';
import isportsMatchRoutes from './routes/isports-matches';
import oddsapiRoutes from './routes/oddsapi';
import { errorHandler } from './middleware/errorHandler';
import { requestLogger } from './middleware/logger';
import { getCrownAutomation } from './services/crown-automation';

const app = express();
const PORT = process.env.PORT || 3001;

// Optional comma-separated override for isolated local verification environments.
const corsOrigins = String(process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);

// API 返回数据不走 ETag 缓存（浏览器可能发起 304，axios 会当成错误导致前端“没数据”）
app.set('etag', false);

// 中间件
app.use(cors({
    origin: process.env.NODE_ENV === 'production'
        ? ['https://aibcbot.top', 'http://aibcbot.top']
        : [
            'http://localhost:3000',
            'http://localhost:5173',
            'http://localhost:10086',
            'http://localhost:10087',
            'http://localhost:10088',
            'http://localhost:10089',
            'http://127.0.0.1:10087'
        ].concat(corsOrigins),
    credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(requestLogger);

// 健康检查
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV
    });
});

// API路由
app.use('/api/auth', authRoutes);
app.use('/api/agents', agentRoutes);
app.use('/api/staff', staffRoutes);
app.use('/api/crown-automation', crownAutomationRoutes);
app.use('/api/accounts', accountRoutes);
app.use('/api/groups', groupRoutes);
app.use('/api/matches', matchRoutes);
app.use('/api/bets', betRoutes);
app.use('/api/coins', coinRoutes);
app.use('/api/aliases', aliasRoutes);
app.use('/api/crown-matches', crownMatchRoutes);
app.use('/api/isports-matches', isportsMatchRoutes);
app.use('/api/oddsapi', oddsapiRoutes);
app.use('/api/whitelabels', whitelabelRoutes);

// 错误处理中间件
app.use(errorHandler);

// 404处理
app.use((req, res) => {
    res.status(404).json({ error: '接口不存在' });
});

export { app };

// 启动服务器
app.listen(Number(PORT), process.env.HOST || '0.0.0.0', async () => {
    console.log(`🚀 智投后端服务启动成功！`);
    console.log(`📍 服务地址: http://localhost:${PORT}`);
    console.log(`🌍 环境: ${process.env.NODE_ENV || 'development'}`);
    console.log(`⏰ 启动时间: ${new Date().toLocaleString()}`);

    // 初始化 Crown 自动化服务（触发预热）
    getCrownAutomation();

    // 内置的独立赛事抓取服务已禁用，使用外部独立进程（fetcher/）
    console.log('ℹ️ 内置赛事抓取服务已禁用，使用外部独立进程');
});
