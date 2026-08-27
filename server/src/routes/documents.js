'use strict';
/**
 * Agent2Agent — 文档路由 + 双向镜像同步
 * design.md §6.4, §11；docs/api.md §4, §5
 */
const path = require('path');
const express = require('express');
const multer = require('multer');
const { getDb, getSeq, genId, now } = require('../db');
const { requireAuth, optionalAuth } = require('../auth');
const storage = require('../storage');
const { emit } = require('../sse');
const { err, ok, withIdempotency, serializeDocument } = require('../helpers');

const router = express.Router();

const MAX_FILE_MB = Number(process.env.A2A_MAX_FILE_MB) || 50;
const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;
const INLINE_CONTENT_LIMIT = 512 * 1024; // sync 内联 content 上限

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 100 },
});

const TEXT_EXT = new Set(['md', 'txt', 'json', 'js', 'mjs', 'cjs', 'ts', 'py', 'yaml', 'yml', 'html', 'css', 'xml', 'csv', 'log', 'ini', 'conf', 'sh', 'sql', 'java', 'go', 'rb', 'c', 'cpp', 'h', 'toml', 'env', 'diff', 'patch']);
function isTextMime(mime, name) {
  const ext = path.extname(name || '').slice(1).toLowerCase();
  return (typeof mime === 'string' && mime.startsWith('text/')) || TEXT_EXT.has(ext);
}

/** 某账号下按文件名找当前文档 */
function findDocByName(accountId, name) {
  return getDb().prepare('SELECT * FROM documents WHERE account_id = ? AND name = ? AND deleted = 0').get(accountId, name);
}

/** 创建文档记录 + 落盘；返回完整行 */
function createDocRecord(accountId, name, buffer, mime, description, extra = {}) {
  const db = getDb();
  const saved = storage.saveDocFile(accountId, name, buffer);
  const doc = {
    id: genId('d'),
    seq: getSeq('documents'),
    account_id: accountId,
    name: saved.storedName,
    stored_path: saved.storedPath,
    size: buffer.length,
    mime: mime || 'application/octet-stream',
    description: description || '',
    sha256: storage.sha256Buffer(buffer),
    created_at: extra.createdAt || now(),
    updated_at: extra.updatedAt || now(),
    deleted: 0,
  };
  db.prepare(`INSERT INTO documents
    (id, seq, account_id, name, stored_path, size, mime, description, sha256, created_at, updated_at, deleted)
    VALUES (@id, @seq, @account_id, @name, @stored_path, @size, @mime, @description, @sha256, @created_at, @updated_at, @deleted)`)
    .run(doc);
  return db.prepare('SELECT * FROM documents WHERE id = ?').get(doc.id);
}

/** 软删除某文档（墓碑，同步传播） */
function softDeleteDoc(row) {
  const db = getDb();
  db.prepare('UPDATE documents SET deleted = 1, updated_at = ? WHERE id = ?').run(now(), row.id);
  storage.deleteDocFile(row.account_id, row.stored_path);
}

/** POST /api/v1/documents — 上传（需鉴权，multipart: file + description?） */
router.post('/documents', requireAuth, upload.single('file'), (req, res) => {
  withIdempotency(req, res, () => {
    if (!req.file) return err(res, 400, '缺少 file 字段（multipart 上传）');
    const accountId = req.account.id;
    const description = typeof req.body.description === 'string' ? req.body.description : '';
    const name = req.file.originalname || 'file';

    // 同名替换：软删除旧记录
    const existing = findDocByName(accountId, name);
    if (existing) softDeleteDoc(existing);

    const doc = createDocRecord(accountId, name, req.file.buffer, req.file.mimetype, description);
    emit('doc', accountId, doc.id, {
      summary: `${accountId} 上传文档：${doc.name}`,
      name: doc.name, size: doc.size,
    });
    return { document: serializeDocument(doc) };
  });
});

/** GET /api/v1/documents — 列表（公开） */
router.get('/documents', (req, res) => {
  const db = getDb();
  let sql = 'SELECT * FROM documents WHERE deleted = 0';
  const params = [];
  if (typeof req.query.account === 'string') { sql += ' AND account_id = ?'; params.push(req.query.account); }
  if (typeof req.query.name === 'string') { sql += ' AND name = ?'; params.push(req.query.name); }
  sql += ' ORDER BY updated_at DESC LIMIT 1000';
  return ok(res, db.prepare(sql).all(...params).map(serializeDocument));
});

/** GET /api/v1/documents/:id — 元数据（公开） */
router.get('/documents/:id', (req, res) => {
  const row = getDb().prepare('SELECT * FROM documents WHERE id = ? AND deleted = 0').get(req.params.id);
  if (!row) return err(res, 404, `文档 ${req.params.id} 不存在`);
  return ok(res, serializeDocument(row));
});

/** GET /api/v1/documents/:id/content — 下载 / 预览（公开） */
router.get('/documents/:id/content', (req, res) => {
  const row = getDb().prepare('SELECT * FROM documents WHERE id = ? AND deleted = 0').get(req.params.id);
  if (!row) return err(res, 404, `文档 ${req.params.id} 不存在`);
  let buf;
  try {
    buf = storage.readDocFile(row.account_id, row.stored_path);
  } catch (e) {
    return err(res, 404, '文档文件已丢失');
  }
  const inline = req.query.inline === '1' && isTextMime(row.mime, row.name);
  const disposition = inline ? 'inline' : 'attachment';
  res.setHeader('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(row.name)}`);
  res.setHeader('Content-Type', inline ? (row.mime || 'text/plain') : 'application/octet-stream');
  res.setHeader('X-Doc-Mime', row.mime || '');
  return res.send(buf);
});

/* ---------------- 双向镜像同步（design.md §11.2 / §11.3） ---------------- */

/** GET /api/v1/sync?since= — 平台 → 本地 增量清单（需鉴权） */
router.get('/sync', requireAuth, (req, res) => {
  const since = Number(req.query.since || 0) || 0;
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM documents WHERE updated_at > ? ORDER BY updated_at ASC LIMIT 2000')
    .all(since);

  const changes = rows.map((row) => {
    const ch = {
      id: row.id,
      accountId: row.account_id,
      name: row.name,
      mime: row.mime,
      size: row.size,
      sha256: row.sha256,
      updatedAt: row.updated_at,
      deleted: !!row.deleted,
      content: null,
    };
    if (!row.deleted && row.size <= INLINE_CONTENT_LIMIT && isTextMime(row.mime, row.name)) {
      try {
        ch.content = storage.readDocFile(row.account_id, row.stored_path).toString('base64');
      } catch (e) { /* 文件丢失则跳过 content */ }
    }
    return ch;
  });
  const cursor = rows.length ? Math.max(...rows.map((r) => r.updated_at), since) : since;
  return ok(res, { cursor, time: now(), changes });
});

/** POST /api/v1/sync — 本地 → 平台（需鉴权，multipart：files + deletes + manifest） */
router.post('/sync', requireAuth, upload.array('files', 100), (req, res) => {
  withIdempotency(req, res, () => {
    const accountId = req.account.id;
    const db = getDb();

  // 可选 per-file 元数据：manifest = JSON [{name, mtime}]
  let manifest = [];
  if (typeof req.body.manifest === 'string') {
    try { manifest = JSON.parse(req.body.manifest); } catch (e) { manifest = []; }
  }
  const mtimeOf = (name) => {
    const m = manifest.find((x) => x && x.name === name);
    return m && Number(m.mtime) ? Number(m.mtime) : now();
  };

  // 1) 删除（deletes：multipart 表单字符串 JSON，或直接 JSON 数组 body）
  let deletes = [];
  if (Array.isArray(req.body.deletes)) {
    deletes = req.body.deletes;
  } else if (typeof req.body.deletes === 'string') {
    try { deletes = JSON.parse(req.body.deletes); } catch (e) { deletes = []; }
  }
  const deletedNames = [];
  for (const delName of Array.isArray(deletes) ? deletes : []) {
    const row = findDocByName(accountId, String(delName));
    if (row) {
      softDeleteDoc(row);
      deletedNames.push(row.name);
    }
  }

  // 2) 推送文件（LWW 冲突处理）
  const pushed = [];
  const conflicts = [];
  const files = req.files || [];
  for (const file of files) {
    const name = file.originalname || 'file';
    const buffer = file.buffer;
    const sha = storage.sha256Buffer(buffer);
    const mtime = mtimeOf(name);
    const existing = findDocByName(accountId, name);

    if (existing && existing.sha256 === sha) {
      pushed.push({ id: existing.id, name: existing.name, unchanged: true });
      continue;
    }

    if (existing) {
      const platformTime = existing.updated_at;
      if (platformTime > mtime) {
        // 平台版本更新 → 保留平台，本地版本另存冲突副本
        const conflictName = storage.saveConflictCopy(accountId, name, buffer);
        const saved = storage.saveDocFile(accountId, conflictName, buffer);
        db.prepare(`INSERT INTO documents
          (id, seq, account_id, name, stored_path, size, mime, description, sha256, created_at, updated_at, deleted)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,0)`)
          .run(genId('d'), getSeq('documents'), accountId, saved.storedName, saved.storedPath,
            buffer.length, file.mimetype || 'application/octet-stream', '冲突副本', sha, now(), now());
        conflicts.push({ name, kept: 'platform', savedAs: conflictName });
        emit('doc', accountId, null, {
          summary: `同步冲突：${name} 已保留平台版本，本地版本另存 ${conflictName}（人工处置）`,
          conflict: true, name, savedAs: conflictName,
        });
        continue;
      }
      // 本地版本更新 → 覆盖平台
      softDeleteDoc(existing);
    }

    const doc = createDocRecord(accountId, name, buffer, file.mimetype, '（sync 推送）', { updatedAt: mtime });
    pushed.push({ id: doc.id, name: doc.name, unchanged: false });
  }

  if (pushed.length || deletedNames.length || conflicts.length) {
    emit('doc', accountId, null, {
      summary: `${accountId} sync 推送：+${pushed.length} 文档，-${deletedNames.length} 删除${conflicts.length ? `，${conflicts.length} 冲突` : ''}`,
      pushed: pushed.length, deleted: deletedNames.length, conflicts: conflicts.length,
    });
  }

  // 返回新的游标：平台当前最新文档时间
  const last = db.prepare('SELECT MAX(updated_at) m FROM documents').get().m || 0;
  return { pushed, deleted: deletedNames, conflicts, cursor: last, time: now() };
  });
});

module.exports = router;
