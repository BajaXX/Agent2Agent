'use strict';
/**
 * Agent2Agent — 记忆路由（memory.md + 版本历史）
 * design.md §6.5, §10；乐观锁 PUT（version 不匹配 → 409）
 */
const express = require('express');
const { getDb, genId, now } = require('../db');
const { requireAuth, optionalAuth } = require('../auth');
const storage = require('../storage');
const { emit } = require('../sse');
const { err, ok, withIdempotency } = require('../helpers');

const router = express.Router();

/** 取某账号当前记忆 {content, version} */
function currentMemory(accountId) {
  const db = getDb();
  const mv = db.prepare('SELECT version, content FROM memory_versions WHERE account_id = ? ORDER BY version DESC LIMIT 1').get(accountId);
  if (mv) return { content: mv.content, version: mv.version };
  return { content: storage.readMemoryFile(accountId), version: 0 };
}

/** GET /api/v1/memory — 我的记忆（需鉴权）；?account= 公开看板视角 */
router.get('/memory', optionalAuth, (req, res) => {
  let accountId = null;
  if (req.account) {
    accountId = req.account.id;
  } else if (typeof req.query.account === 'string') {
    const acc = getDb().prepare('SELECT id FROM accounts WHERE id = ? OR name = ?').get(req.query.account, req.query.account);
    if (!acc) return err(res, 404, `账号 ${req.query.account} 不存在`);
    accountId = acc.id;
  } else {
    return err(res, 400, '需要鉴权，或提供 ?account=<id>');
  }
  return ok(res, currentMemory(accountId));
});

/** PUT /api/v1/memory — 更新（需鉴权，仅自己的；乐观锁） */
router.put('/memory', requireAuth, (req, res) => {
  withIdempotency(req, res, () => {
    const { content, version, note } = req.body || {};
    if (typeof content !== 'string') return err(res, 400, 'content 必填（string）');
    const accountId = req.account.id;
    const cur = currentMemory(accountId);
    const clientVersion = Number(version);
    if (!Number.isFinite(clientVersion)) return err(res, 400, 'version 必填（数字，先 GET /memory 获取）');
    if (clientVersion !== cur.version) {
      return err(res, 409, `版本冲突：当前版本为 ${cur.version}，你提交的是 ${clientVersion}。请重新 GET /memory 合并后再 PUT`);
    }

    const newVersion = cur.version + 1;
    const db = getDb();
    db.prepare('INSERT INTO memory_versions (id, account_id, version, content, note, updated_at) VALUES (?,?,?,?,?,?)')
      .run(genId('mv'), accountId, newVersion, content, typeof note === 'string' ? note : '', now());
    storage.writeMemoryFile(accountId, content);

    emit('memory', accountId, null, {
      summary: `${accountId} 更新记忆 → v${newVersion}`,
      version: newVersion,
    });
    return { content, version: newVersion };
  });
});

/** GET /api/v1/memory/versions — 版本历史（公开 ?account= 或鉴权） */
router.get('/memory/versions', optionalAuth, (req, res) => {
  let accountId = null;
  if (req.account) {
    accountId = req.account.id;
  } else if (typeof req.query.account === 'string') {
    const acc = getDb().prepare('SELECT id FROM accounts WHERE id = ? OR name = ?').get(req.query.account, req.query.account);
    if (!acc) return err(res, 404, `账号 ${req.query.account} 不存在`);
    accountId = acc.id;
  } else {
    return err(res, 400, '需要鉴权，或提供 ?account=<id>');
  }
  const rows = getDb()
    .prepare('SELECT id, version, content, note, updated_at FROM memory_versions WHERE account_id = ? ORDER BY version DESC')
    .all(accountId);
  return ok(res, rows.map((r) => ({ id: r.id, version: r.version, content: r.content, note: r.note, updatedAt: r.updated_at })));
});

module.exports = router;
