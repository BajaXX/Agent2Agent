'use strict';
/**
 * Agent2Agent — 任务路由（看板）
 * design.md §6.3；状态机 todo → doing → blocked ⇄ doing → done
 */
const express = require('express');
const { getDb, genId, now } = require('../db');
const { requireAuth } = require('../auth');
const { emit } = require('../sse');
const { err, ok, withIdempotency, serializeTask, VALID_TASK_STATUS } = require('../helpers');

const router = express.Router();

/** POST /api/v1/tasks — 创建（需鉴权） */
router.post('/tasks', requireAuth, (req, res) => {
  withIdempotency(req, res, () => {
    const { title, description, assigneeId, priority, sourceMessageId, dueAt } = req.body || {};
    if (!title || typeof title !== 'string' || !title.trim()) return err(res, 400, 'title 必填');

    const db = getDb();
    const task = {
      id: genId('t'),
      account_id: req.account.id,
      title: String(title).trim(),
      description: typeof description === 'string' ? description : '',
      status: 'todo',
      priority: priority || 'normal',
      assignee_id: typeof assigneeId === 'string' ? assigneeId : null,
      source_message_id: typeof sourceMessageId === 'string' ? sourceMessageId : null,
      note: null,
      created_at: now(),
      updated_at: now(),
      due_at: typeof dueAt === 'number' ? dueAt : null,
    };
    db.prepare(`INSERT INTO tasks
      (id, account_id, title, description, status, priority, assignee_id, source_message_id, note, created_at, updated_at, due_at)
      VALUES (@id, @account_id, @title, @description, @status, @priority, @assignee_id, @source_message_id, @note, @created_at, @updated_at, @due_at)`)
      .run(task);

    emit('task', req.account.id, task.id, {
      summary: `${req.account.name} 新建任务：${task.title}`,
      title: task.title, status: task.status,
    });
    return { taskId: task.id };
  });
});

/** GET /api/v1/tasks — 列表（公开，全局看板聚合数据源） */
router.get('/tasks', (req, res) => {
  const db = getDb();
  let sql = 'SELECT * FROM tasks WHERE 1=1';
  const params = [];
  if (typeof req.query.account === 'string') { sql += ' AND account_id = ?'; params.push(req.query.account); }
  if (typeof req.query.status === 'string') {
    if (!VALID_TASK_STATUS.includes(req.query.status)) return err(res, 400, `status 必须为 ${VALID_TASK_STATUS.join('|')}`);
    sql += ' AND status = ?'; params.push(req.query.status);
  }
  if (typeof req.query.assignee === 'string') { sql += ' AND assignee_id = ?'; params.push(req.query.assignee); }
  if (Number(req.query.since)) { sql += ' AND updated_at > ?'; params.push(Number(req.query.since)); }
  sql += ' ORDER BY updated_at DESC LIMIT 500';
  const rows = db.prepare(sql).all(...params);
  return ok(res, rows.map(serializeTask));
});

/** PATCH /api/v1/tasks/:id — 更新（需鉴权：任务所属账号或 assignee） */
router.patch('/tasks/:id', requireAuth, (req, res) => {
  const db = getDb();
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return err(res, 404, `任务 ${req.params.id} 不存在`);

  const isOwner = task.account_id === req.account.id;
  const isAssignee = task.assignee_id && task.assignee_id === req.account.id;
  if (!isOwner && !isAssignee) return err(res, 403, '仅任务所属账号或 assignee 可更新');

  const { status, note, assigneeId } = req.body || {};
  if (status !== undefined) {
    if (!VALID_TASK_STATUS.includes(status)) return err(res, 400, `status 必须为 ${VALID_TASK_STATUS.join('|')}`);
    const blockedRule = status === 'blocked' && !note && typeof note !== 'string';
    if (blockedRule) return err(res, 400, '置为 blocked 需附说明 note');
  }

  const update = {
    status: status !== undefined ? status : task.status,
    note: note !== undefined ? String(note) : task.note,
    assignee_id: assigneeId !== undefined ? assigneeId : task.assignee_id,
    updated_at: now(),
  };
  db.prepare('UPDATE tasks SET status = ?, note = ?, assignee_id = ?, updated_at = ? WHERE id = ?')
    .run(update.status, update.note, update.assignee_id, update.updated_at, task.id);

  emit('task', task.account_id, task.id, {
    summary: `${req.account.name} 更新任务「${task.title}」→ ${update.status}`,
    title: task.title, status: update.status, note: update.note,
  });
  return ok(res, serializeTask({ ...task, ...update }));
});

module.exports = router;
