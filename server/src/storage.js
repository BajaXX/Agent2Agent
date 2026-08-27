'use strict';
/**
 * Agent2Agent 平台服务端 — 文件存储层
 * data/accounts/<dir>/documents/ 文档 + memory.md 记忆（版本历史在 DB）
 * 见 design.md §7 / §11
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DATA_DIR, sanitizeDir } = require('./db');

function accountRoot(accountId) {
  const dir = sanitizeDir(accountId);
  return path.join(DATA_DIR, 'accounts', dir);
}

function ensureAccountDirs(accountId) {
  const root = accountRoot(accountId);
  const docs = path.join(root, 'documents');
  fs.mkdirSync(docs, { recursive: true });
  return { root, docs };
}

/**
 * 恢复 multipart 文件名：busboy/multer 默认按 latin1 解码 filename，
 * UTF-8 中文名会变成乱码。仅当字符串含 latin1 高字节且可按 UTF-8 无损还原时才转换。
 * （真实 UTF-8 中文字符的码点 > 0xFF，不会命中 \x80-\xff 分支，安全跳过。）
 */
function decodeFilename(name) {
  const s = String(name || '');
  if (/[\x80-\xff]/.test(s)) {
    try {
      const recovered = Buffer.from(s, 'latin1').toString('utf8');
      if (!recovered.includes('\uFFFD')) return recovered;
    } catch (e) { /* 保持原样 */ }
  }
  return s;
}

/** 清洗文件名：去掉路径、禁 ..、限制长度 */
function sanitizeFilename(name) {
  let base = decodeFilename(name).split(/[\\/]/).pop();
  base = base.replace(/\.\.+/g, '.').replace(/[^\w\u4e00-\u9fa5.\-() ]/g, '_');
  if (!base || base === '.' || base === '..') base = 'file';
  if (base.length > 180) {
    const ext = path.extname(base);
    base = base.slice(0, 180 - ext.length) + ext;
  }
  return base;
}

function fileExists(accountId, filename) {
  const { docs } = ensureAccountDirs(accountId);
  return fs.existsSync(path.join(docs, sanitizeFilename(filename)));
}

/** 保存上传文件到账号文档目录；同名冲突时追加时间戳避免覆盖 */
function saveUploadedFile(accountId, originalName, buffer) {
  const { docs } = ensureAccountDirs(accountId);
  const name = sanitizeFilename(originalName);
  let storedName = name;
  let finalPath = path.join(docs, storedName);
  const base = path.parse(name).name;
  const ext = path.extname(name);
  let i = 1;
  while (fs.existsSync(finalPath)) {
    storedName = `${base}.${i}${ext}`;
    finalPath = path.join(docs, storedName);
    i += 1;
  }
  fs.writeFileSync(finalPath, buffer);
  return { storedName, storedPath: finalPath, size: buffer.length, sha256: sha256File(finalPath) };
}

function saveDocFile(accountId, name, buffer) {
  const { docs } = ensureAccountDirs(accountId);
  const safeName = sanitizeFilename(name);
  const finalPath = path.join(docs, safeName);
  fs.writeFileSync(finalPath, buffer);
  return { storedName: safeName, storedPath: finalPath, size: buffer.length, sha256: sha256File(finalPath) };
}

/** 冲突副本：<name>.conflict-<ts>.<ext> */
function saveConflictCopy(accountId, name, buffer) {
  const { docs } = ensureAccountDirs(accountId);
  const safe = sanitizeFilename(name);
  const base = path.parse(safe).name;
  const ext = path.extname(safe);
  const conflictName = `${base}.conflict-${Date.now()}${ext}`;
  const finalPath = path.join(docs, conflictName);
  fs.writeFileSync(finalPath, buffer);
  return conflictName;
}

function readDocFile(accountId, storedPath) {
  // storedPath 为绝对路径（来自 DB）；做安全性校验：必须位于账号文档目录内
  const { docs } = ensureAccountDirs(accountId);
  const resolved = path.resolve(storedPath);
  if (!resolved.startsWith(path.resolve(docs) + path.sep)) {
    throw new Error('非法文档路径');
  }
  return fs.readFileSync(resolved);
}

function deleteDocFile(accountId, storedPath) {
  const { docs } = ensureAccountDirs(accountId);
  const resolved = path.resolve(storedPath);
  if (!resolved.startsWith(path.resolve(docs) + path.sep)) return;
  try {
    fs.unlinkSync(resolved);
  } catch (e) {
    /* 文件可能已不存在 */
  }
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/* ---------- 记忆 ---------- */

function memoryPath(accountId) {
  const root = accountRoot(accountId);
  fs.mkdirSync(root, { recursive: true });
  return path.join(root, 'memory.md');
}

function readMemoryFile(accountId) {
  const p = memoryPath(accountId);
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    return '';
  }
}

function writeMemoryFile(accountId, content) {
  const p = memoryPath(accountId);
  fs.writeFileSync(p, content, 'utf8');
}

module.exports = {
  accountRoot,
  ensureAccountDirs,
  sanitizeFilename,
  fileExists,
  saveUploadedFile,
  saveDocFile,
  saveConflictCopy,
  readDocFile,
  deleteDocFile,
  sha256File,
  sha256Buffer,
  readMemoryFile,
  writeMemoryFile,
  memoryPath,
};
