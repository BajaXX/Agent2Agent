'use strict';
/**
 * Agent2Agent 平台服务端 — SSE 事件分发
 * GET /api/v1/events（公开）：看板不带 accountId 收全部；agent 带 accountId 只收自己的。
 * 每 25s 发注释行保活；连接时可选 ?after=<seq> 重放最近事件。
 */
const { getDb, getSeq, genId, now } = require('./db');

const clients = new Set(); // { res, accountId|null }

function eventPayload(type, accountId, refId, payload) {
  return {
    id: genId('e'),
    type,
    accountId: accountId || '',
    refId: refId || '',
    payload: payload || {},
    createdAt: now(),
  };
}

/** 记录事件（DB）并广播（SSE） */
function emit(type, accountId, refId, payload) {
  const db = getDb();
  const ev = eventPayload(type, accountId, refId, payload);
  db.prepare(
    'INSERT INTO events (id, seq, type, account_id, ref_id, payload, created_at) VALUES (?,?,?,?,?,?,?)'
  ).run(ev.id, getSeq('events'), ev.type, ev.accountId, ev.refId, JSON.stringify(ev.payload), ev.createdAt);
  broadcast(ev);
  return ev;
}

function broadcast(ev) {
  const data = JSON.stringify(ev);
  for (const c of clients) {
    if (c.accountId && c.accountId !== ev.accountId) continue; // 只推该账号相关
    try {
      c.res.write(`event: ${ev.type}\n`);
      c.res.write(`data: ${data}\n\n`);
    } catch (e) {
      /* 客户端断开，交给 close 清理 */
    }
  }
}

/** Express handler：SSE 连接 */
function sseHandler(req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const accountId = typeof req.query.accountId === 'string' ? req.query.accountId : null;

  // 可选重放：?after=<seq>
  const after = Number(req.query.after || 0);
  if (after > 0) {
    try {
      const rows = getDb()
        .prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq DESC LIMIT 200')
        .all(after)
        .reverse();
      for (const row of rows) {
        if (accountId && row.account_id !== accountId) continue;
        const ev = {
          id: row.id, type: row.type, accountId: row.account_id, refId: row.ref_id,
          payload: JSON.parse(row.payload || '{}'), createdAt: row.created_at,
        };
        res.write(`event: ${ev.type}\n`);
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
      }
    } catch (e) { /* 重放失败忽略 */ }
  }

  const client = { res, accountId };
  clients.add(client);

  res.write(`event: ready\ndata: {"ok":true,"time":${Date.now()}}\n\n`);

  const keepAlive = setInterval(() => {
    try {
      res.write(': keep-alive\n\n');
    } catch (e) {
      clearInterval(keepAlive);
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    clients.delete(client);
  });
}

module.exports = { emit, broadcast, sseHandler };
