'use strict';
/**
 * Agent2Agent 平台服务端 — Express 入口（API + 静态托管）
 * design.md §4, §15：监听 0.0.0.0:3081（可用环境变量 A2A_PORT 覆盖）
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');

const { init, DATA_DIR } = require('./db');

const PORT = Number(process.env.A2A_PORT) || 3081;
const HOST = process.env.A2A_HOST || '0.0.0.0';
const WEB_DIR = process.env.A2A_WEB_DIR || path.join(__dirname, '..', '..', 'web');

// 初始化数据库
init();
fs.mkdirSync(DATA_DIR, { recursive: true });

const app = express();
app.disable('x-powered-by');

// 全局 JSON 解析（限制 body 大小，防 413 滥用）
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 请求日志（简洁）
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    if (req.path.startsWith('/api/')) {
      console.log(`${new Date().toISOString()} ${req.method} ${req.path} ${res.statusCode} ${ms}ms`);
    }
  });
  next();
});

// API 路由
app.use('/api/v1', require('./routes/accounts'));
app.use('/api/v1', require('./routes/messages'));
app.use('/api/v1', require('./routes/tasks'));
app.use('/api/v1', require('./routes/documents'));
app.use('/api/v1', require('./routes/memory'));
app.use('/api/v1', require('./routes/summary'));
app.use('/api/v1', require('./routes/events'));
app.use('/api/v1', require('./routes/version'));

// 未知 API 路径 → 404 JSON
app.use('/api', (req, res) => {
  res.status(404).json({ error: { code: 404, message: `接口不存在：${req.method} ${req.path}` } });
});

// 静态托管看板（design.md §12：无构建链）
app.use(express.static(WEB_DIR, { index: 'index.html' }));

// 兜底：SPA 入口
app.get('/', (req, res) => {
  res.sendFile(path.join(WEB_DIR, 'index.html'));
});

// 统一错误处理（含 multer 413）
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    const mb = Number(process.env.A2A_MAX_FILE_MB) || 50;
    return res.status(413).json({ error: { code: 413, message: `文件超过大小限制（${mb}MB）` } });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 413, message: '请求体过大' } });
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ error: { code: 500, message: '服务器内部错误' } });
});

const server = http.createServer(app);
server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  ┌──────────────────────────────────────────────┐');
  console.log('  │   Agent2Agent 平台已启动                       │');
  console.log(`  │   看板:      http://127.0.0.1:${PORT}          │`);
  console.log(`  │   API:       http://127.0.0.1:${PORT}/api/v1   │`);
  console.log(`  │   数据目录:  ${DATA_DIR}`);
  console.log('  └──────────────────────────────────────────────┘');
  console.log('');
});

// 优雅退出
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  process.exit(0);
});
process.on('SIGTERM', () => {
  process.exit(0);
});

module.exports = { app, server };
