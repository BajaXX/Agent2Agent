'use strict';
/**
 * Agent2Agent 平台服务端 — 鉴权层
 * 注册签发 token（tk_ 前缀），服务端仅存 sha256 摘要。
 * 支持 Authorization: Bearer <token> 与 ?token= 双通道（design.md §5.1）。
 */
const crypto = require('crypto');
const { getDb } = require('./db');

const TOKEN_PREFIX = 'tk_';

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function issueToken() {
  return TOKEN_PREFIX + crypto.randomBytes(24).toString('hex');
}

function hashToken(token) {
  return sha256(token);
}

/** 用 token 找账号；找不到返回 null */
function findAccountByToken(token) {
  if (!token || typeof token !== 'string') return null;
  const hash = hashToken(token);
  return getDb().prepare('SELECT * FROM accounts WHERE token_hash = ?').get(hash) || null;
}

/** 解析请求中的 token：Header 优先，其次 ?token= */
function extractToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  if (req.query && typeof req.query.token === 'string') return req.query.token.trim();
  return null;
}

/** Express 中间件：保护路由，挂载 req.account */
function requireAuth(req, res, next) {
  const token = extractToken(req);
  const account = token ? findAccountByToken(token) : null;
  if (!account) {
    return res.status(401).json({
      error: { code: 401, message: '未授权：缺少或无效的 token（使用 Authorization: Bearer <token> 或 ?token=）' },
    });
  }
  req.account = account;
  req.token = token;
  next();
}

/** 可选鉴权：有合法 token 则挂载 req.account（用于公开接口的账号视角） */
function optionalAuth(req, res, next) {
  const token = extractToken(req);
  req.account = token ? findAccountByToken(token) : null;
  req.token = token;
  next();
}

module.exports = { issueToken, hashToken, findAccountByToken, extractToken, requireAuth, optionalAuth };
