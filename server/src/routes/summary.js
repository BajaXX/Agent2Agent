'use strict';
/**
 * Agent2Agent — 看板聚合 summary（design.md §6.6 / docs/api.md §7）
 */
const express = require('express');
const { getDb, now } = require('../db');
const { accountWithStats } = require('../helpers');

const router = express.Router();

/** GET /api/v1/summary — 看板聚合（公开） */
router.get('/summary', (req, res) => {
  const db = getDb();
  const accountRows = db.prepare('SELECT * FROM accounts ORDER BY created_at ASC').all();
  const agents = accountRows.map(accountWithStats);

  const unreadTotal = db.prepare('SELECT COUNT(*) c FROM messages WHERE status = ?').get('unread').c;
  const needsReplyPending = db.prepare('SELECT COUNT(*) c FROM messages WHERE needs_reply = 1 AND status != ?').get('resolved').c;

  const taskRows = db.prepare('SELECT status, COUNT(*) c FROM tasks GROUP BY status').all();
  const taskStats = { todo: 0, doing: 0, blocked: 0, done: 0 };
  for (const t of taskRows) taskStats[t.status] = t.c;

  const recentActivity = db
    .prepare('SELECT * FROM events ORDER BY seq DESC LIMIT 20')
    .all()
    .reverse()
    .map((e) => ({
      id: e.id, type: e.type, accountId: e.account_id, refId: e.ref_id,
      payload: JSON.parse(e.payload || '{}'), createdAt: e.created_at,
    }));

  return res.json({
    agents,
    unreadTotal,
    needsReplyPending,
    taskStats,
    recentActivity,
    time: now(),
  });
});

module.exports = router;
