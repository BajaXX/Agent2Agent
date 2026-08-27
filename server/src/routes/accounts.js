'use strict';
/**
 * Agent2Agent — 账号路由：register / agents / heartbeat / checkin
 * design.md §6.1, §8, §9
 */
const express = require('express');
const { getDb, getSeq, genId, now, sanitizeDir } = require('../db');
const { issueToken, hashToken, requireAuth } = require('../auth');
const storage = require('../storage');
const { emit } = require('../sse');
const {
  err, ok, withIdempotency, accountWithStats, serializeAccount,
  serializeMessage, serializeTask, VALID_HEARTBEAT_STATUS, TTL_MS,
} = require('../helpers');

const router = express.Router();

const VALID_TOOLS = ['dsh', 'cursor', 'claude-code', 'other'];

/** POST /api/v1/register */
router.post('/register', (req, res) => {
  const { name, tool, projectName, description, capabilities, tech, docDir, owner } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) return err(res, 400, 'name 必填（端+项目，全局唯一）');
  if (!tool) return err(res, 400, 'tool 必填（dsh|cursor|claude-code|other）');
  if (!VALID_TOOLS.includes(tool)) return err(res, 400, `tool 必须为 ${VALID_TOOLS.join('|')}`);
  if (!projectName || typeof projectName !== 'string') return err(res, 400, 'projectName 必填');

  const db = getDb();
  const exists = db.prepare('SELECT id FROM accounts WHERE name = ?').get(name.trim());
  if (exists) return err(res, 409, `账号 ${name.trim()} 已存在（name 全局唯一）`);

  const token = issueToken();
  const id = name.trim();
  const account = {
    id,
    name: id,
    tool,
    project: projectName,
    description: typeof description === 'string' ? description : '',
    capabilities: JSON.stringify(Array.isArray(capabilities) ? capabilities : []),
    tech: JSON.stringify(Array.isArray(tech) ? tech : []),
    doc_dir: typeof docDir === 'string' ? docDir : '',
    owner: typeof owner === 'string' ? owner : '',
    token_hash: hashToken(token),
    dir: sanitizeDir(id),
    created_at: now(),
    last_seen_at: 0,
    online: 0,
    status: 'offline',
    note: '',
  };
  db.prepare(`INSERT INTO accounts
    (id, name, tool, project, description, capabilities, tech, doc_dir, owner, token_hash, dir,
     created_at, last_seen_at, online, status, note)
    VALUES (@id, @name, @tool, @project, @description, @capabilities, @tech, @doc_dir, @owner, @token_hash, @dir,
     @created_at, @last_seen_at, @online, @status, @note)`).run(account);
  storage.ensureAccountDirs(id);

  emit('presence', id, id, { summary: `新账号注册：${id}（${tool} × ${projectName}）`, kind: 'registered' });

  return ok(res, { accountId: id, token, docDir: account.doc_dir });
});

/** GET /api/v1/agents — 目录（公开） */
router.get('/agents', (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM accounts ORDER BY created_at ASC').all();
  return ok(res, rows.map(accountWithStats));
});

/** GET /api/v1/agents/:id — 详情（公开） */
router.get('/agents/:id', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM accounts WHERE id = ? OR name = ?').get(req.params.id, req.params.id);
  if (!row) return err(res, 404, `账号 ${req.params.id} 不存在`);
  const memory = (() => {
    const mv = db.prepare('SELECT version, content FROM memory_versions WHERE account_id = ? ORDER BY version DESC LIMIT 1').get(row.id);
    return mv ? { version: mv.version, content: mv.content } : { version: 0, content: storage.readMemoryFile(row.id) };
  })();
  const recentEvents = db
    .prepare('SELECT * FROM events WHERE account_id = ? ORDER BY seq DESC LIMIT 10')
    .all(row.id)
    .reverse()
    .map((e) => ({ id: e.id, type: e.type, refId: e.ref_id, payload: JSON.parse(e.payload || '{}'), createdAt: e.created_at }));
  return ok(res, { ...accountWithStats(row), memory, recentEvents });
});

/** POST /api/v1/heartbeat — 心跳（需鉴权） */
router.post('/heartbeat', requireAuth, (req, res) => {
  const db = getDb();
  const { status, note } = req.body || {};
  const st = status || 'working';
  if (!VALID_HEARTBEAT_STATUS.includes(st)) {
    return err(res, 400, `status 必须为 ${VALID_HEARTBEAT_STATUS.join('|')}`);
  }
  const account = req.account;
  db.prepare('UPDATE accounts SET last_seen_at = ?, status = ?, note = ?, online = 1 WHERE id = ?')
    .run(now(), st, typeof note === 'string' ? note : '', account.id);

  const unread = db.prepare('SELECT COUNT(*) c FROM messages WHERE to_id = ? AND status = ?').get(account.id, 'unread').c;
  const todo = db.prepare('SELECT COUNT(*) c FROM tasks WHERE account_id = ? AND status IN (?,?)').get(account.id, 'todo', 'blocked').c;

  if (st === 'offline') {
    db.prepare('UPDATE accounts SET online = 0 WHERE id = ?').run(account.id);
  }
  emit('presence', account.id, account.id, { summary: `${account.name} 状态：${st}`, status: st });

  return ok(res, { online: st !== 'offline', status: st, pending: { unreadMessages: unread, todoTasks: todo } });
});

/** GET /api/v1/checkin — 组合报到（需鉴权），design.md §8.2 */
router.get('/checkin', requireAuth, (req, res) => {
  const db = getDb();
  const account = req.account;
  const since = Number(req.query.since || 0) || 0;

  // 等价一次 starting 心跳
  db.prepare('UPDATE accounts SET last_seen_at = ?, status = ?, online = 1 WHERE id = ?')
    .run(now(), 'starting', account.id);
  const freshAccount = db.prepare('SELECT * FROM accounts WHERE id = ?').get(account.id);
  emit('presence', account.id, account.id, { summary: `${account.name} check-in 上线`, status: 'starting' });

  const unread = db.prepare('SELECT COUNT(*) c FROM messages WHERE to_id = ? AND status = ?').get(account.id, 'unread').c;
  const todo = db.prepare('SELECT COUNT(*) c FROM tasks WHERE account_id = ? AND status IN (?,?)').get(account.id, 'todo', 'blocked').c;

  const inboxRows = db.prepare('SELECT * FROM messages WHERE to_id = ? AND created_at > ? ORDER BY seq ASC').all(account.id, since);
  const inboxCursor = inboxRows.length ? Math.max(...inboxRows.map((m) => m.created_at), since) : since;
  const inbox = inboxRows.map(serializeMessage);

  const taskRows = db.prepare('SELECT * FROM tasks WHERE account_id = ? AND updated_at > ? ORDER BY updated_at ASC').all(account.id, since);
  const taskCursor = taskRows.length ? Math.max(...taskRows.map((t) => t.updated_at), since) : since;
  const tasks = taskRows.map(serializeTask);

  const memory = (() => {
    const mv = db.prepare('SELECT version, content FROM memory_versions WHERE account_id = ? ORDER BY version DESC LIMIT 1').get(account.id);
    return mv ? { version: mv.version, content: mv.content } : { version: 0, content: storage.readMemoryFile(account.id) };
  })();

  return ok(res, {
    account: serializeAccount(freshAccount),
    pending: { unreadMessages: unread, todoTasks: todo },
    memory,
    inbox: { items: inbox, cursor: inboxCursor },
    tasks: { items: tasks, cursor: taskCursor },
    time: now(),
  });
});

module.exports = router;
module.exports.TTL_MS = TTL_MS;
