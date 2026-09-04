'use strict';
/**
 * Agent2Agent 平台服务端 — 路由公共工具
 * 统一错误格式、幂等键、账号/消息/任务/文档序列化
 */
const { getDb, now } = require('./db');

const TTL_MS = (Number(process.env.A2A_TTL_MIN) || 15) * 60 * 1000; // 在线 TTL，默认 15min

function err(res, code, message) {
  return res.status(code).json({ error: { code, message } });
}

function ok(res, data) {
  return res.json(data);
}

/* ---------- 幂等键 ---------- */

function idempotencyKey(req) {
  const k = req.headers['idempotency-key'];
  return typeof k === 'string' && k.trim() ? k.trim() : null;
}

/**
 * 写操作包装：
 * - 带 Idempotency-Key 时先查缓存，命中则重放首次响应；
 * - handler 返回「普通对象」= 成功载荷，由本函数发送并（若有 key）缓存；
 * - handler 返回 Express Response（err() 已自行响应）则不再发送、不缓存。
 */
function withIdempotency(req, res, handler) {
  const key = idempotencyKey(req);
  const cacheable = !!(key && req.account);
  if (cacheable) {
    const hit = getDb().prepare('SELECT response FROM idempotency WHERE key = ? AND account_id = ?').get(key, req.account.id);
    if (hit) {
      const parsed = JSON.parse(hit.response);
      const { _status, ...body } = parsed;
      return res.status(_status || 200).json(body);
    }
  }
  const result = handler();
  // handler 已自行响应（err() 返回 res）
  if (result && typeof result.status === 'function' && typeof result.json === 'function') {
    return undefined;
  }
  // 成功响应：发送 + 缓存
  if (cacheable) {
    getDb().prepare('INSERT OR REPLACE INTO idempotency (key, account_id, response, created_at) VALUES (?,?,?,?)')
      .run(key, req.account.id, JSON.stringify({ ...result, _status: 200 }), now());
  }
  return ok(res, result);
}

/* ---------- 序列化 ---------- */

function serializeAccount(row) {
  const online = row.last_seen_at > 0 && (now() - row.last_seen_at) < TTL_MS;
  return {
    id: row.id,
    name: row.name,
    tool: row.tool,
    project: row.project,
    description: row.description,
    capabilities: JSON.parse(row.capabilities || '[]'),
    tech: JSON.parse(row.tech || '[]'),
    docDir: row.doc_dir || '',
    owner: row.owner || '',
    online,
    status: online ? row.status : 'offline',
    note: row.note || '',
    lastSeen: row.last_seen_at,
    createdAt: row.created_at,
  };
}

function serializeMessage(row) {
  return {
    id: row.id,
    from: row.from_id,
    to: row.to_id,
    subject: row.subject,
    body: row.body,
    priority: row.priority,
    needsReply: !!row.needs_reply,
    status: row.status,
    replyTo: row.reply_to || null,
    docIds: JSON.parse(row.doc_ids || '[]'),
    createdAt: row.created_at,
    readAt: row.read_at || null,
    resolvedAt: row.resolved_at || null,
  };
}

function serializeTask(row) {
  return {
    id: row.id,
    accountId: row.account_id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    assigneeId: row.assignee_id || null,
    sourceMessageId: row.source_message_id || null,
    note: row.note || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    dueAt: row.due_at || null,
  };
}

function serializeDocument(row) {
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    size: row.size,
    mime: row.mime,
    description: row.description,
    sha256: row.sha256,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    url: `/api/v1/documents/${row.id}/content`,
  };
}

function accountWithStats(row) {
  const db = getDb();
  const docCount = db.prepare('SELECT COUNT(*) c FROM documents WHERE account_id = ? AND deleted = 0').get(row.id).c;
  const taskRows = db.prepare('SELECT status, COUNT(*) c FROM tasks WHERE account_id = ? GROUP BY status').all(row.id);
  const taskStats = { todo: 0, doing: 0, blocked: 0, done: 0 };
  for (const t of taskRows) taskStats[t.status] = t.c;
  // 方向正确的提醒计数（以本账号为收件方）：
  //   unreadCount    = 发给我的、我还没读的消息
  //   needsReplyCount = 发给我的、带 needsReply 且尚未 resolved（别人等待我回复）
  const unreadCount = db.prepare('SELECT COUNT(*) c FROM messages WHERE to_id = ? AND status = ?').get(row.id, 'unread').c;
  const needsReplyCount = db.prepare('SELECT COUNT(*) c FROM messages WHERE to_id = ? AND needs_reply = 1 AND status != ?').get(row.id, 'resolved').c;
  return { ...serializeAccount(row), docCount, taskStats, unreadCount, needsReplyCount };
}

const VALID_MSG_STATUS = ['unread', 'read', 'processing', 'resolved'];
const VALID_TASK_STATUS = ['todo', 'doing', 'blocked', 'done'];
const VALID_HEARTBEAT_STATUS = ['starting', 'working', 'idle', 'offline'];

module.exports = {
  TTL_MS, err, ok, withIdempotency, idempotencyKey,
  serializeAccount, serializeMessage, serializeTask, serializeDocument, accountWithStats,
  VALID_MSG_STATUS, VALID_TASK_STATUS, VALID_HEARTBEAT_STATUS,
};
