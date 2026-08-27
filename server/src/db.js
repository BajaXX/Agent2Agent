'use strict';
/**
 * Agent2Agent 平台服务端 — 数据库层（better-sqlite3 初始化与迁移）
 * 数据模型见 design.md §7 / docs/api.md
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.A2A_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = process.env.A2A_DB_PATH || path.join(DATA_DIR, 'agent2agent.db');

let db = null;

function genId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function now() {
  return Date.now();
}

function migrate(db) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    tool TEXT NOT NULL DEFAULT 'other',
    project TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    capabilities TEXT NOT NULL DEFAULT '[]',
    tech TEXT NOT NULL DEFAULT '[]',
    doc_dir TEXT NOT NULL DEFAULT '',
    owner TEXT NOT NULL DEFAULT '',
    token_hash TEXT NOT NULL DEFAULT '',
    dir TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL DEFAULT 0,
    online INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'offline',
    note TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    seq INTEGER NOT NULL,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    priority TEXT NOT NULL DEFAULT 'normal',
    needs_reply INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'unread',
    reply_to TEXT,
    doc_ids TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    read_at INTEGER,
    resolved_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_id, seq);
  CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_id, seq);
  CREATE INDEX IF NOT EXISTS idx_messages_seq ON messages(seq);

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'todo',
    priority TEXT NOT NULL DEFAULT 'normal',
    assignee_id TEXT,
    source_message_id TEXT,
    note TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    due_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_account ON tasks(account_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    seq INTEGER NOT NULL,
    account_id TEXT NOT NULL,
    name TEXT NOT NULL,
    stored_path TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    mime TEXT NOT NULL DEFAULT 'application/octet-stream',
    description TEXT NOT NULL DEFAULT '',
    sha256 TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_documents_account ON documents(account_id);
  CREATE INDEX IF NOT EXISTS idx_documents_seq ON documents(seq);

  CREATE TABLE IF NOT EXISTS memory_versions (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_memory_account ON memory_versions(account_id, version);

  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    seq INTEGER NOT NULL,
    type TEXT NOT NULL,
    account_id TEXT NOT NULL DEFAULT '',
    ref_id TEXT NOT NULL DEFAULT '',
    payload TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_seq ON events(seq);

  CREATE TABLE IF NOT EXISTS idempotency (
    key TEXT NOT NULL,
    account_id TEXT NOT NULL,
    response TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (key, account_id)
  );

  CREATE TABLE IF NOT EXISTS seq_counter (
    name TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  );
  `);
  // 初始化序列计数器
  const stmts = {
    messages: db.prepare('INSERT OR IGNORE INTO seq_counter (name, value) VALUES (?, 0)'),
  };
  stmts.messages.run('messages');
  stmts.messages.run('documents');
  stmts.messages.run('events');
}

function getSeq(name) {
  const row = db.prepare('SELECT value FROM seq_counter WHERE name = ?').get(name);
  const value = (row ? row.value : 0) + 1;
  db.prepare('UPDATE seq_counter SET value = ? WHERE name = ?').run(value, name);
  return value;
}

function init() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function getDb() {
  if (!db) init();
  return db;
}

/** 账号目录（sanitize 后） */
function sanitizeDir(name) {
  return String(name || '')
    .replace(/[^\w\u4e00-\u9fa5.-]+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120) || 'account';
}

module.exports = { init, getDb, getSeq, genId, now, DATA_DIR, DB_PATH, sanitizeDir };
