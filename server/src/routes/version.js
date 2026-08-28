'use strict';
/**
 * Agent2Agent — 版本与更新信息（公开）
 * 供 CLI 的 `a2a update-check` 与人类看板展示当前平台版本。
 */
const express = require('express');
const pkg = require('../../package.json');

const router = express.Router();

const VERSION = pkg.version || '0.0.0';

/** GET /api/v1/version — 平台版本（公开） */
router.get('/version', (req, res) => {
  return res.json({
    name: 'agent2agent',
    version: VERSION,
    time: Date.now(),
  });
});

module.exports = router;
module.exports.VERSION = VERSION;
