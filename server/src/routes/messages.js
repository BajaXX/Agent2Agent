'use strict';
/**
 * Agent2Agent — 消息路由（异步邮箱）
 * design.md §6.2, §8.1；状态机 unread → read → processing → resolved
 */
const express = require('express');
const { getDb, getSeq, genId, now } = require('../db');
const { requireAuth, optionalAuth } = require('../auth');
const { emit } = require('../sse');
const { err, ok, withIdempotency, serializeMessage, VALID_MSG_STATUS } = require('../helpers');

const router = express.Router();

/** POST /api/v1/messages — 发送（需鉴权） */
router.post('/messages', requireAuth, (req, res) => {
  withIdempotency(req, res, () => {
    const { to, subject, body, priority, needsReply, docIds } = req.body || {};
    if (!to || typeof to !== 'string') return err(res, 400, 'to 必填（接收方账号 id）');
    if (!subject || typeof subject !== 'string' || !subject.trim()) return err(res, 400, 'subject 必填');

    const db = getDb();
    const target = db.prepare('SELECT id FROM accounts WHERE id = ? OR name = ?').get(to, to);
    if (!target) return err(res, 404, `接收方账号 ${to} 不存在（可先 POST /register 注册）`);

    const validDocs = Array.isArray(docIds)
      ? docIds.filter((d) => db.prepare('SELECT id FROM documents WHERE id = ? AND deleted = 0').get(d))
      : [];

    const msg = {
      id: genId('m'),
      seq: getSeq('messages'),
      from_id: req.account.id,
      to_id: target.id,
      subject: String(subject),
      body: typeof body === 'string' ? body : '',
      priority: priority || 'normal',
      needs_reply: needsReply ? 1 : 0,
      status: 'unread',
      reply_to: null,
      doc_ids: JSON.stringify(validDocs),
      created_at: now(),
      read_at: null,
      resolved_at: null,
    };
    db.prepare(`INSERT INTO messages
      (id, seq, from_id, to_id, subject, body, priority, needs_reply, status, reply_to, doc_ids, created_at, read_at, resolved_at)
      VALUES (@id, @seq, @from_id, @to_id, @subject, @body, @priority, @needs_reply, @status, @reply_to, @doc_ids, @created_at, @read_at, @resolved_at)`)
      .run(msg);

    emit('message', target.id, msg.id, {
      summary: `${req.account.name} → ${target.id}：${msg.subject}`,
      from: req.account.id, to: target.id, subject: msg.subject, needsReply: !!msg.needs_reply, docIds: validDocs,
    });
    return { messageId: msg.id };
  });
});

/** GET /api/v1/messages — 列表（公开：?account= 看板视角；带 token：自己的收/发件箱） */
router.get('/messages', optionalAuth, (req, res) => {
  const db = getDb();
  let accountId = null;
  if (req.account) {
    accountId = req.account.id;
  } else if (typeof req.query.account === 'string') {
    const acc = db.prepare('SELECT id FROM accounts WHERE id = ? OR name = ?').get(req.query.account, req.query.account);
    if (!acc) return err(res, 404, `账号 ${req.query.account} 不存在`);
    accountId = acc.id;
  } else {
    // 无 token 无 account：返回全部（看板消息流水全局视图）
    const all = db.prepare('SELECT * FROM messages ORDER BY seq DESC LIMIT ?').all(Math.min(Number(req.query.limit || 200), 500));
    const cursor = all.length ? Math.max(...all.map((m) => m.created_at)) : 0;
    return ok(res, { items: all.reverse().map(serializeMessage), cursor });
  }

  const dir = req.query.dir === 'out' ? 'out' : req.query.dir === 'in' ? 'in' : null;
  const status = typeof req.query.status === 'string' ? req.query.status : null;
  if (status && !VALID_MSG_STATUS.includes(status)) return err(res, 400, `status 必须为 ${VALID_MSG_STATUS.join('|')}`);
  const since = Number(req.query.since || 0) || 0;
  const limit = Math.min(Number(req.query.limit || 100), 500);

  let sql = 'SELECT * FROM messages WHERE created_at > ?';
  const params = [since];
  if (dir === 'in') { sql += ' AND to_id = ?'; params.push(accountId); }
  else if (dir === 'out') { sql += ' AND from_id = ?'; params.push(accountId); }
  else { sql += ' AND (to_id = ? OR from_id = ?)'; params.push(accountId, accountId); }
  if (status) { sql += ' AND status = ?'; params.push(status); }
  sql += ' ORDER BY seq ASC LIMIT ?';
  params.push(limit);

  const rows = db.prepare(sql).all(...params);
  const cursor = rows.length ? Math.max(...rows.map((m) => m.created_at), since) : since;

  // 自动已读：agent 用本人 token 拉取收件箱时，把本次返回的、发给自己的 unread 消息标记 read。
  // （看板用 ?account= 浏览不带 token，不改变任何状态 —— 只读旁观）
  if (req.account && dir !== 'out') {
    const mine = rows.filter((m) => m.to_id === req.account.id && m.status === 'unread');
    if (mine.length) {
      const ts = now();
      const upd = db.prepare('UPDATE messages SET status = ?, read_at = ? WHERE id = ? AND status = ?');
      db.transaction(() => {
        for (const m of mine) upd.run('read', ts, m.id, 'unread');
      })();
      // 返回给调用方前把内存行同步为已读（API 响应反映最新状态）
      for (const m of mine) { m.status = 'read'; m.read_at = ts; }
    }
  }

  return ok(res, { items: rows.map(serializeMessage), cursor });
});

/** GET /api/v1/messages/:id — 单条详情（公开） */
router.get('/messages/:id', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
  if (!row) return err(res, 404, `消息 ${req.params.id} 不存在`);
  return ok(res, serializeMessage(row));
});

/** POST /api/v1/messages/:id/reply — 回复（需鉴权，仅收件方） */
router.post('/messages/:id/reply', requireAuth, (req, res) => {
  withIdempotency(req, res, () => {
    const db = getDb();
    const original = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
    if (!original) return err(res, 404, `消息 ${req.params.id} 不存在`);
    if (original.to_id !== req.account.id) return err(res, 403, '仅收件方可回复该消息');
    const { body, docIds } = req.body || {};
    if (typeof body !== 'string' || !body.trim()) return err(res, 400, 'body 必填');

    const validDocs = Array.isArray(docIds)
      ? docIds.filter((d) => db.prepare('SELECT id FROM documents WHERE id = ? AND deleted = 0').get(d))
      : [];

    const msg = {
      id: genId('m'),
      seq: getSeq('messages'),
      from_id: req.account.id,
      to_id: original.from_id,
      subject: `Re: ${original.subject}`,
      body,
      priority: original.priority,
      needs_reply: 0,
      status: 'unread',
      reply_to: original.id,
      doc_ids: JSON.stringify(validDocs),
      created_at: now(),
      read_at: null,
      resolved_at: null,
    };
    db.prepare(`INSERT INTO messages
      (id, seq, from_id, to_id, subject, body, priority, needs_reply, status, reply_to, doc_ids, created_at, read_at, resolved_at)
      VALUES (@id, @seq, @from_id, @to_id, @subject, @body, @priority, @needs_reply, @status, @reply_to, @doc_ids, @created_at, @read_at, @resolved_at)`)
      .run(msg);

    // 原消息标记已读
    db.prepare('UPDATE messages SET status = ?, read_at = ? WHERE id = ? AND status = ?').run('read', now(), original.id, 'unread');

    emit('message', original.from_id, msg.id, {
      summary: `${req.account.name} 回复了 ${original.from_id}：${msg.subject}`,
      from: req.account.id, to: original.from_id, subject: msg.subject, replyTo: original.id,
    });
    return { messageId: msg.id };
  });
});

/** POST /api/v1/messages/:id/status — 标记状态（需鉴权，仅收件方） */
router.post('/messages/:id/status', requireAuth, (req, res) => {
  const db = getDb();
  const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
  if (!msg) return err(res, 404, `消息 ${req.params.id} 不存在`);
  if (msg.to_id !== req.account.id) return err(res, 403, '仅收件方可标记该消息');
  const { status } = req.body || {};
  if (!VALID_MSG_STATUS.includes(status)) return err(res, 400, `status 必须为 ${VALID_MSG_STATUS.join('|')}`);

  const ts = now();
  const patch = { status, read_at: msg.read_at, resolved_at: msg.resolved_at };
  if (status !== 'unread' && !patch.read_at) patch.read_at = ts;
  if (status === 'resolved' && !patch.resolved_at) patch.resolved_at = ts;
  if (status === 'resolved') patch.status = 'resolved';

  db.prepare('UPDATE messages SET status = ?, read_at = ?, resolved_at = ? WHERE id = ?')
    .run(patch.status, patch.read_at, patch.resolved_at, msg.id);

  emit('message', msg.to_id, msg.id, {
    summary: `${req.account.name} 将消息「${msg.subject}」标记为 ${patch.status}`,
    status: patch.status, subject: msg.subject,
  });
  return ok(res, { id: msg.id, status: patch.status, readAt: patch.read_at, resolvedAt: patch.resolved_at });
});

module.exports = router;
