'use strict';
/**
 * Agent2Agent — SSE 事件流（design.md §6.6 / docs/api.md §7）
 */
const express = require('express');
const { sseHandler } = require('../sse');

const router = express.Router();

router.get('/events', sseHandler);

module.exports = router;
