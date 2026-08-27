#!/usr/bin/env node
/**
 * Agent2Agent 统一 CLI —— `a2a`
 *
 * 零第三方依赖：仅使用 Node 内置模块（fs / path / crypto）。
 * HTTP 使用 Node >= 20 的全局 fetch；multipart 上传使用全局 FormData / Blob。
 *
 * 用法：
 *   node cli/a2a.js <命令> [选项]
 *   （或 chmod +x 后直接 ./cli/a2a.js）
 *
 * 配置：项目根目录 .agent-platform.json（从当前目录逐级向上查找，或 --config 指定）
 * 状态：.agent-platform-state.json（与配置同目录，记录同步游标与本地 manifest）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ------------------------------------------------------------------------- *
 * 颜色 / 排版工具（纯文本可用，终端下自动着色，NO_COLOR 可关闭）
 * ------------------------------------------------------------------------- */

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const C = {
  reset: useColor ? '\x1b[0m' : '',
  bold: useColor ? '\x1b[1m' : '',
  dim: useColor ? '\x1b[2m' : '',
  red: useColor ? '\x1b[31m' : '',
  green: useColor ? '\x1b[32m' : '',
  yellow: useColor ? '\x1b[33m' : '',
  blue: useColor ? '\x1b[34m' : '',
  cyan: useColor ? '\x1b[36m' : '',
};
const paint = (color, s) => `${color}${s}${C.reset}`;
const hl = (s) => paint(C.bold + C.cyan, s); // 命令名高亮

/* 字符显示宽度（CJK 按 2 列） */
function charWidth(ch) {
  const code = ch.codePointAt(0);
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff)
  ) {
    return 2;
  }
  return 1;
}
function displayWidth(s) {
  return Array.from(String(s)).reduce((w, c) => w + charWidth(c), 0);
}
function padRight(s, w) {
  const d = w - displayWidth(s);
  return s + ' '.repeat(Math.max(0, d));
}
function padLeft(s, w) {
  const d = w - displayWidth(s);
  return ' '.repeat(Math.max(0, d)) + s;
}

function fmtTime(ms) {
  if (!ms && ms !== 0) return '-';
  const d = new Date(ms);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
function fmtAgo(ms) {
  if (!ms && ms !== 0) return '从未';
  const diff = Date.now() - ms;
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 3600 * 1000) return `${Math.floor(diff / 60000)}分钟前`;
  if (diff < 24 * 3600 * 1000) return `${Math.floor(diff / 3600000)}小时前`;
  return `${Math.floor(diff / 86400000)}天前`;
}
function fmtSize(n) {
  if (n == null) return '-';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}
function fmtTaskStats(stats) {
  if (!stats) return '-';
  const t = stats.todo ?? 0;
  const d = stats.doing ?? 0;
  const b = stats.blocked ?? 0;
  const dn = stats.done ?? 0;
  return `待${t}/做${d}/阻${b}/完${dn}`;
}

/* 通用表格渲染：headers 为列名数组，rows 为字符串数组的数组 */
function renderTable(headers, rows) {
  const widths = headers.map((h, i) => {
    let w = displayWidth(h);
    for (const r of rows) w = Math.max(w, displayWidth(String(r[i] ?? '-')));
    return w;
  });
  const line = (cells) => cells.map((c, i) => padRight(String(c ?? '-'), widths[i])).join('  ');
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  const out = [line(headers), sep];
  for (const r of rows) out.push(line(r));
  return out.join('\n');
}

/* ------------------------------------------------------------------------- *
 * 错误与退出
 * ------------------------------------------------------------------------- */

class ApiError extends Error {
  constructor(message, status, bodyText) {
    super(message);
    this.status = status;
    this.bodyText = bodyText;
  }
}

/** 打印错误到 stderr 并以非零码退出 */
function fail(msg) {
  process.stderr.write(paint(C.red, '错误: ') + String(msg) + '\n');
  process.exit(1);
}

/** 从服务端错误正文里解析出 message（统一错误格式 {error:{message}}） */
function parseErrorMessage(text, status) {
  try {
    const j = JSON.parse(text);
    if (j && j.error && typeof j.error === 'object') {
      if (j.error.message) {
        return `${j.error.message}${j.error.code != null ? ` (code ${j.error.code})` : ''}`;
      }
      return JSON.stringify(j.error);
    }
    if (j && typeof j.error === 'string') return j.error;
    if (j && j.message) return j.message;
  } catch {
    /* 非 JSON 正文，走下方兜底 */
  }
  const firstLine = (text || '').split('\n')[0].trim();
  if (firstLine) return firstLine.slice(0, 300);
  return `HTTP ${status}`;
}

/* ------------------------------------------------------------------------- *
 * 参数解析（零依赖）
 *
 *   --flag            → true（布尔）
 *   --key value       → 'value'
 *   --key=value       → 'value'
 *   重复的 --key      → 累积为数组
 *   -- 之后全部为位置参数
 * ------------------------------------------------------------------------- */

function parseArgs(argv) {
  const pos = [];
  const opts = {};
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--') {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      let key;
      let val;
      if (eq >= 0) {
        key = a.slice(2, eq);
        val = a.slice(eq + 1);
      } else {
        key = a.slice(2);
        if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
          val = argv[i + 1];
          i++;
        } else {
          val = true;
        }
      }
      if (key in opts) {
        if (Array.isArray(opts[key])) opts[key].push(val);
        else opts[key] = [opts[key], val];
      } else {
        opts[key] = val;
      }
    } else {
      pos.push(a);
    }
    i++;
  }
  return { pos, opts };
}

/** 把「单值或数组」规整为数组 */
function listOpt(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/** 逗号分隔列表（--capabilities a,b / --tech x,y）规整为去空字符串数组 */
function splitList(v) {
  return listOpt(v)
    .flatMap((x) => String(x).split(','))
    .map((s) => s.trim())
    .filter(Boolean);
}

/* ------------------------------------------------------------------------- *
 * 配置与状态文件
 * ------------------------------------------------------------------------- */

/** 从 startDir 逐级向上查找 .agent-platform.json */
function findConfigFile(startDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, '.agent-platform.json');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** 加载配置，返回 { config, dir, file } */
function requireConfig(configPath) {
  const file = configPath ? path.resolve(process.cwd(), configPath) : findConfigFile(process.cwd());
  if (!file) {
    fail('未找到 .agent-platform.json（已从当前目录逐级向上查找）。请先运行 a2a init 注册账号。');
  }
  if (!fs.existsSync(file)) fail(`配置文件不存在: ${file}`);
  let config;
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    fail(`配置文件解析失败: ${file}（${e.message}）`);
  }
  if (!config.url) fail(`配置文件缺少 url 字段: ${file}`);
  if (!config.accountId) fail(`配置文件缺少 accountId 字段: ${file}`);
  if (!config.token) fail(`配置文件缺少 token 字段: ${file}`);
  return { config, dir: path.dirname(file), file };
}

function defaultState() {
  return { lastSync: 0, lastSeq: 0, manifest: {} };
}

function stateFile(dir) {
  return path.join(dir, '.agent-platform-state.json');
}

function loadState(dir) {
  const p = stateFile(dir);
  if (fs.existsSync(p)) {
    try {
      const s = JSON.parse(fs.readFileSync(p, 'utf8'));
      return {
        lastSync: s.lastSync || 0,
        lastSeq: s.lastSeq || 0,
        manifest: s.manifest && typeof s.manifest === 'object' ? s.manifest : {},
      };
    } catch {
      return defaultState();
    }
  }
  return defaultState();
}

function saveState(dir, state) {
  fs.writeFileSync(stateFile(dir), JSON.stringify(state, null, 2) + '\n');
}

/** 解析 doc 目录为绝对路径（相对路径相对于配置文件所在目录） */
function resolveDocDir(config, configDir) {
  const d = config.docDir || '.agent-platform/docs';
  return path.isAbsolute(d) ? d : path.resolve(configDir, d);
}

/* ------------------------------------------------------------------------- *
 * HTTP 调用
 * ------------------------------------------------------------------------- */

function baseUrl(config) {
  let b = String(config.url || '').replace(/\/+$/, '');
  if (!/\/api\/v1$/.test(b)) b += '/api/v1';
  return b;
}

/**
 * 统一 API 调用。
 * opts:
 *   query : 查询参数对象
 *   body  : JSON 对象（自动 Content-Type: application/json）
 *   form  : FormData（fetch 自动设置 multipart boundary）
 *   raw   : true 时返回 { res, buf }（buf 为 Buffer，用于下载二进制）
 */
async function api(config, method, pathName, opts = {}) {
  const { query, body, form, raw } = opts;
  let url = baseUrl(config) + pathName;
  if (query) {
    const qs = new URLSearchParams(query).toString();
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
  }

  const headers = {};
  if (config && config.token) headers['Authorization'] = 'Bearer ' + config.token;

  let fetchBody;
  if (form) {
    fetchBody = form; // FormData：由 fetch 生成 multipart 头
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    fetchBody = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(url, { method, headers, body: fetchBody });
  } catch (e) {
    throw new ApiError(`网络请求失败: ${e.message}`, 0, '');
  }

  if (!res.ok) {
    let text = '';
    try {
      text = await res.text();
    } catch {
      /* ignore */
    }
    throw new ApiError(parseErrorMessage(text, res.status), res.status, text);
  }

  if (raw) {
    const buf = Buffer.from(await res.arrayBuffer());
    return { res, buf };
  }

  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    try {
      return await res.json();
    } catch {
      return await res.text();
    }
  }
  return await res.text();
}

/** 把「数组 / {items:[...]} / {documents:[...]} / {tasks:[...]}」统一为数组 */
function toArray(res) {
  if (Array.isArray(res)) return res;
  if (res && Array.isArray(res.items)) return res.items;
  if (res && Array.isArray(res.documents)) return res.documents;
  if (res && Array.isArray(res.tasks)) return res.tasks;
  return [];
}

/* ------------------------------------------------------------------------- *
 * 双向镜像同步（§11.2 / api.md §5）
 * ------------------------------------------------------------------------- */

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 递归扫描 doc 目录（排除 _inbox 子目录与状态/配置文件），返回 relpath → {abs,sha256,mtime,size} */
function scanDocDir(config, configDir) {
  const root = resolveDocDir(config, configDir);
  const result = {};
  function walk(dir, rel) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 目录不存在
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const relp = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name === '_inbox') continue; // 拉取镜像目录，不回推
        walk(abs, relp);
      } else if (e.isFile()) {
        if (e.name === '.agent-platform-state.json' || e.name === '.agent-platform.json') continue;
        const buf = fs.readFileSync(abs);
        result[relp] = {
          abs,
          sha256: sha256(buf),
          mtime: Math.floor(fs.statSync(abs).mtimeMs),
          size: buf.length,
        };
      }
    }
  }
  walk(root, '');
  return result;
}

/** 计算本地 → 平台 的增量计划（新增/修改 + 删除） */
function computePushPlan(scan, manifest) {
  const toPush = [];
  const toDelete = [];
  for (const [rel, info] of Object.entries(scan)) {
    const prev = manifest[rel];
    if (!prev || prev.sha256 !== info.sha256) toPush.push(rel);
  }
  for (const rel of Object.keys(manifest)) {
    if (!(rel in scan)) toDelete.push(rel);
  }
  return { toPush, toDelete };
}

function printConflicts(conflicts) {
  if (!conflicts || !conflicts.length) return;
  for (const c of conflicts) {
    if (c.message) console.log(paint(C.yellow, `⚠ 冲突: ${c.message}`));
    else if (c.name) console.log(paint(C.yellow, `⚠ 冲突: ${c.name} 已保留平台版本，副本另存 ${c.savedAs || '(未知)'}`));
    else console.log(paint(C.yellow, `⚠ 冲突: ${JSON.stringify(c)}`));
  }
}

/** 推送：扫描 doc 目录 → 对比 manifest → FormData 上传 files + deletes。会就地更新 state。 */
async function pushOnce(config, configDir, state) {
  const manifest = state.manifest;
  const scan = scanDocDir(config, configDir);
  const { toPush, toDelete } = computePushPlan(scan, manifest);

  if (toPush.length === 0 && toDelete.length === 0) {
    console.log(paint(C.dim, '[同步·推送] 本地无变更'));
    return { pushed: [], deleted: [], conflicts: [] };
  }

  const form = new FormData();
  for (const rel of toPush) {
    const buf = fs.readFileSync(scan[rel].abs);
    form.append('files', new Blob([buf]), rel);
  }
  if (toDelete.length) form.append('deletes', JSON.stringify(toDelete));

  const res = await api(config, 'POST', '/sync', { form });
  const pushed = res.pushed || [];
  const deleted = res.deleted || [];
  const conflicts = res.conflicts || [];

  console.log(paint(C.bold, `[同步·推送] 上传 ${pushed.length} 个文件，删除 ${deleted.length} 个`));
  for (const p of pushed) console.log(`  + ${p.name || p}`);
  for (const d of deleted) console.log(`  - ${d}`);
  printConflicts(conflicts);

  // 仅当推送成功后再更新本地 manifest
  for (const rel of toPush) {
    manifest[rel] = { sha256: scan[rel].sha256, mtime: scan[rel].mtime, size: scan[rel].size };
  }
  for (const rel of toDelete) delete manifest[rel];
  if (res.cursor) state.lastSync = Math.max(state.lastSync || 0, res.cursor);

  return { pushed, deleted, conflicts };
}

/** 拉取：GET /sync?since= → 写 _inbox/<accountId>/<name>。会就地更新 state。 */
async function pullOnce(config, configDir, state) {
  const since = state.lastSync || 0;
  const res = await api(config, 'GET', '/sync', { query: { since } });
  const changes = res.changes || [];
  const docRoot = resolveDocDir(config, configDir);
  let written = 0;
  let removed = 0;

  for (const ch of changes) {
    const accountId = String(ch.accountId || 'unknown').replace(/\.\./g, '_');
    const name = String(ch.name || ch.id || 'file').replace(/\.\./g, '_');
    const file = path.join(docRoot, '_inbox', accountId, name);
    if (ch.deleted) {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
        removed++;
      }
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      let buf;
      if (ch.content != null && ch.content !== '') {
        buf = Buffer.from(ch.content, 'base64');
      } else {
        const dl = await api(config, 'GET', `/documents/${ch.id}/content`, { raw: true });
        buf = dl.buf;
      }
      fs.writeFileSync(file, buf);
      written++;
    }
  }

  const cursor = Math.max(res.cursor || 0, res.time || 0);
  if (cursor > (state.lastSync || 0)) state.lastSync = cursor;

  console.log(paint(C.bold, `[同步·拉取] 拉取 ${written} 个文档${removed ? `，删除 ${removed} 个` : ''}`));
  printConflicts(res.conflicts);
  return { written, removed, changes, conflicts: res.conflicts || [] };
}

/** 双向镜像同步（先推后拉） */
async function doSync(config, configDir) {
  const state = loadState(configDir);
  await pushOnce(config, configDir, state);
  await pullOnce(config, configDir, state);
  saveState(configDir, state);
  return state;
}

/* ------------------------------------------------------------------------- *
 * 命令实现
 * ------------------------------------------------------------------------- */

/** 交互式提问：依次向用户询问缺失的字段（仅 TTY 下启用） */
function createLineReader() {
  // 自研逐行读取：输入提前到达时缓存到队列，等待者按序消费（兼容人机/伪终端/管道）
  let buffer = '';
  const queue = [];
  const waiters = [];
  process.stdin.setEncoding('utf8');
  process.stdin.resume();
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).replace(/\r$/, '');
      buffer = buffer.slice(i + 1);
      const w = waiters.shift();
      if (w) w(line);
      else queue.push(line);
    }
  });
  return function nextLine() {
    if (queue.length) return Promise.resolve(queue.shift());
    return new Promise((resolve) => waiters.push(resolve));
  };
}

async function promptInteractive(fields) {
  const nextLine = createLineReader();
  const answers = {};
  for (const f of fields) {
    const def = f.default;
    let val = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      process.stdout.write(f.prompt + (def !== undefined && def !== '' ? `（默认: ${def}）: ` : ': '));
      const raw = (await nextLine()).trim();
      val = raw || (def !== undefined ? def : '');
      if (val || !f.required) break;
      if (attempt < 2) process.stdout.write(paint(C.yellow, `「${f.key}」为必填项，请重新输入：\n`));
    }
    answers[f.key] = val;
  }
  return answers;
}

async function cmdInit(opts) {
  let url = opts.url;
  let name = opts.name;
  let tool = opts.tool;
  let project = opts.project;
  let description = opts.description;
  let docDir = opts['doc-dir'];

  // 交互模式：终端下且必填参数缺失时，逐个提问（已通过 --xxx 提供的跳过）
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (interactive && (!url || !name || !tool || !project)) {
    console.log(paint(C.bold, 'a2a init —— 交互式注册向导（输入值后回车；可 Ctrl+C 取消）'));
    console.log('');
    const fields = [];
    if (!url) fields.push({ key: 'url', prompt: '平台地址', default: 'http://127.0.0.1:3081' });
    if (!name) fields.push({ key: 'name', prompt: '账号名（端+项目，全局唯一，如 A项目开发）', required: true });
    if (!tool) fields.push({ key: 'tool', prompt: '工具类型', default: 'cursor' });
    if (!project) fields.push({ key: 'project', prompt: '项目名称', required: true });
    if (description === undefined) fields.push({ key: 'description', prompt: '一句话简介（可回车跳过）', default: '' });
    if (!docDir) fields.push({ key: 'docDir', prompt: '文档同步目录（项目内任意目录，如 docs/ 或 .agent-platform/docs）', default: '.agent-platform/docs' });
    const ans = await promptInteractive(fields);
    if (!ans.url && !url) return fail('未提供平台地址（--url），已取消注册。');
    if (!ans.name && !name) return fail('未提供账号名（--name），已取消注册。');
    url = url || ans.url;
    name = name || ans.name;
    tool = tool || ans.tool;
    project = project || ans.project;
    if (description === undefined) description = ans.description;
    if (!docDir) docDir = ans.docDir;
  }

  if (!url) fail('init 需要 --url <平台地址>');
  if (!name) fail('init 需要 --name <账号名（端+项目，全局唯一）>');
  if (!tool) fail('init 需要 --tool <dsh|cursor|claude-code|other>');
  if (!project) fail('init 需要 --project <项目名>');

  const capabilities = splitList(opts.capabilities);
  const tech = splitList(opts.tech);
  if (!docDir) docDir = '.agent-platform/docs';
  docDir = String(docDir).replace(/\/+$/, '') || '.agent-platform/docs';

  const body = { name, tool, projectName: project, docDir };
  if (description) body.description = description;
  if (capabilities.length) body.capabilities = capabilities;
  if (tech.length) body.tech = tech;

  console.log(paint(C.bold, '正在注册账号...'));
  const res = await api({ url }, 'POST', '/register', { body });

  const accountId = res.accountId || name;
  const token = res.token;
  const cwd = process.cwd();
  const configFile = path.join(cwd, '.agent-platform.json');
  if (fs.existsSync(configFile)) {
    fail(`已存在 .agent-platform.json（${configFile}），请先备份或删除后再 init，以免覆盖已有 token。`);
  }

  const config = { url: String(url).replace(/\/+$/, ''), accountId, token, docDir };
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
  saveState(cwd, defaultState());

  const docRoot = resolveDocDir(config, cwd);
  fs.mkdirSync(docRoot, { recursive: true });

  console.log('');
  console.log(paint(C.green, '注册成功'));
  console.log(`  账号 (accountId): ${hl(accountId)}`);
  console.log(`  平台地址:         ${config.url}`);
  console.log(`  文档目录:         ${docRoot}`);
  console.log(`  token:            ${paint(C.yellow, token)}（仅此一次显示，请妥善保存）`);
  console.log(`  配置文件:         ${configFile}`);
  console.log('');
  console.log(paint(C.dim, '提示: 请将 .agent-platform.json 与 .agent-platform-state.json 加入 .gitignore。'));

  // 立即全量推送 doc 目录内文件（首次，manifest 为空 → 全部为新增）
  const state = loadState(cwd);
  await pushOnce(config, cwd, state);
  saveState(cwd, state);
}

async function cmdWhoami(ctx) {
  const res = await api(ctx.config, 'GET', `/agents/${ctx.config.accountId}`);
  console.log(paint(C.bold, '账号信息'));
  console.log(`  ID:        ${res.id || res.name || '-'}`);
  console.log(`  名称:      ${res.name || '-'}`);
  console.log(`  工具:      ${res.tool || '-'}`);
  console.log(`  项目:      ${res.project || '-'}`);
  console.log(`  简介:      ${res.description || '-'}`);
  console.log(`  能力:      ${(res.capabilities || []).join(', ') || '-'}`);
  console.log(`  技术栈:    ${(res.tech || []).join(', ') || '-'}`);
  console.log(`  在线:      ${res.online ? '是' : '否'}（${res.status || '-'}${res.note ? ' · ' + res.note : ''}）`);
  console.log(`  最后活跃:  ${fmtTime(res.lastSeen)}`);
  console.log(`  文档数:    ${res.docCount ?? 0}`);
  console.log(`  任务统计:  ${fmtTaskStats(res.taskStats)}`);
  if (res.memory) console.log(`  记忆版本:  v${res.memory.version ?? 0}`);
}

async function cmdAgents(ctx) {
  const list = await api(ctx.config, 'GET', '/agents');
  const items = Array.isArray(list) ? list : (list && list.agents) || [];
  if (items.length === 0) {
    console.log('（平台上暂无账号）');
    return;
  }
  const headers = ['名称', '工具', '项目', '在线', '最后活跃', '任务统计(待/做/阻/完)'];
  const rows = items.map((a) => [
    a.name || a.id || '-',
    a.tool || '-',
    a.project || '-',
    a.online ? '在线' : '离线',
    fmtAgo(a.lastSeen),
    fmtTaskStats(a.taskStats),
  ]);
  console.log(renderTable(headers, rows));
}

async function cmdCheckin(opts, ctx) {
  const { config, dir } = ctx;
  const state = loadState(dir);

  // 1) 双向镜像同步（先 push 再 pull）
  await pushOnce(config, dir, state);
  await pullOnce(config, dir, state);

  // 2) 组合报到（自带 status=starting 心跳）
  const since = state.lastSeq || 0;
  const res = await api(config, 'GET', '/checkin', { query: { since } });

  // 3) 更新 check-in 游标
  const cursor = Math.max(res.time || 0, (res.inbox && res.inbox.cursor) || 0, (res.tasks && res.tasks.cursor) || 0);
  state.lastSeq = Math.max(state.lastSeq || 0, cursor);
  saveState(dir, state);

  // 可选：显式指定状态时，追加一次心跳（checkin 接口默认 starting）
  if (opts.status) {
    await api(config, 'POST', '/heartbeat', { body: { status: opts.status } });
  }

  // 4) 输出摘要
  const mem = res.memory || {};
  const pending = res.pending || {};
  const inboxItems = (res.inbox && res.inbox.items) || [];
  const taskItems = (res.tasks && res.tasks.items) || [];
  const acct = res.account || {};

  console.log('');
  console.log(hl('========== a2a checkin =========='));
  console.log(`账号: ${acct.name || acct.id || ctx.config.accountId}   状态: ${acct.status || 'starting'}`);
  console.log(`记忆版本: v${mem.version ?? 0}`);
  console.log(`未读消息: ${pending.unreadMessages ?? inboxItems.length} 条   待办任务: ${pending.todoTasks ?? taskItems.length} 个`);

  console.log('');
  console.log(paint(C.bold, '未读消息:'));
  if (inboxItems.length === 0) {
    console.log('  （无）');
  } else {
    inboxItems.forEach((m, i) => console.log(`  [${i + 1}] ${m.subject || '(无主题)'} — 来自 ${m.from || '?'}`));
  }

  console.log('');
  console.log(paint(C.bold, '待办任务:'));
  if (taskItems.length === 0) {
    console.log('  （无）');
  } else {
    taskItems.forEach((t, i) => console.log(`  [${i + 1}] ${t.title || '(无标题)'}（${t.status || '?'}）`));
  }

  console.log('');
  if ((pending.unreadMessages ?? inboxItems.length) > 0) {
    console.log(paint(C.yellow, '→ 有未读消息：用 a2a inbox --unread 查看'));
  }
  if ((pending.todoTasks ?? taskItems.length) > 0) {
    console.log(paint(C.yellow, '→ 有待办任务：用 a2a task list --status todo 查看'));
  }
  console.log(hl('======================================='));
}

async function cmdSend(opts, ctx) {
  const to = opts.to;
  const subject = opts.subject;
  const body = opts.body;
  if (!to) fail('send 需要 --to <收件账号名>');
  if (!subject) fail('send 需要 --subject <主题>');
  if (body === undefined || body === null) fail('send 需要 --body <正文>');

  const payload = { to, subject, body };
  if (opts.priority) payload.priority = opts.priority;
  if (opts['need-reply']) payload.needsReply = true;
  const docs = listOpt(opts.doc);
  if (docs.length) payload.docIds = docs;

  const res = await api(ctx.config, 'POST', '/messages', { body: payload });
  const id = res.messageId || res.id;
  console.log(`已发送消息 ${hl(id)} → ${to}（主题: ${subject}）`);
}

async function cmdInbox(opts, ctx, dir) {
  const query = { dir };
  if (opts.unread) query.status = 'unread';
  if (opts.limit) query.limit = opts.limit;
  const res = await api(ctx.config, 'GET', '/messages', { query });
  const items = toArray(res);
  if (items.length === 0) {
    console.log('（无消息）');
    return;
  }
  const headers = dir === 'in' ? ['ID', '编号', '来自', '主题', '状态', '时间'] : ['ID', '编号', '发给', '主题', '状态', '时间'];
  const rows = items.map((m, i) => {
    const peer = dir === 'in' ? m.from : m.to;
    return [m.id || '-', String(i + 1), peer || '-', m.subject || '-', m.status || '-', fmtTime(m.createdAt)];
  });
  console.log(renderTable(headers, rows));
}

async function cmdReply(opts, ctx) {
  const id = opts.msg;
  const body = opts.body;
  if (!id) fail('reply 需要 --msg <消息ID>');
  if (body === undefined || body === null) fail('reply 需要 --body <正文>');

  const payload = { body };
  const docs = listOpt(opts.doc);
  if (docs.length) payload.docIds = docs;

  const res = await api(ctx.config, 'POST', `/messages/${id}/reply`, { body: payload });
  const mid = res.messageId || res.id || '';
  console.log(`已回复消息 ${id}${mid ? ` → 新消息 ${hl(mid)}` : ''}`);
}

async function cmdMark(opts, ctx) {
  const id = opts.msg;
  const status = opts.status;
  if (!id) fail('mark 需要 --msg <消息ID>');
  if (!status) fail('mark 需要 --status <unread|read|processing|resolved>');
  await api(ctx.config, 'POST', `/messages/${id}/status`, { body: { status } });
  console.log(`消息 ${id} 已标记为 ${status}`);
}

async function cmdTaskNew(opts, ctx) {
  const title = opts.title;
  if (!title) fail('task new 需要 --title <标题>');
  const payload = { title };
  if (opts.desc) payload.description = opts.desc;
  if (opts.assignee) payload.assigneeId = opts.assignee;
  if (opts.priority) payload.priority = opts.priority;
  if (opts['source-msg']) payload.sourceMessageId = opts['source-msg'];
  const res = await api(ctx.config, 'POST', '/tasks', { body: payload });
  console.log(`已创建任务 ${hl(res.taskId || res.id || '')}`);
}

async function cmdTaskList(opts, ctx) {
  const query = {};
  if (opts.status) query.status = opts.status;
  if (opts.account) query.account = opts.account;
  const res = await api(ctx.config, 'GET', '/tasks', { query });
  const items = toArray(res);
  if (items.length === 0) {
    console.log('（无任务）');
    return;
  }
  const headers = ['ID', '编号', '标题', '状态', '优先级', '负责人', '更新时间'];
  const rows = items.map((t, i) => [
    t.id || '-',
    String(i + 1),
    t.title || '-',
    t.status || '-',
    t.priority || '-',
    t.assigneeId || '-',
    fmtTime(t.updatedAt),
  ]);
  console.log(renderTable(headers, rows));
}

async function cmdTaskUpdate(opts, ctx) {
  const id = opts.id;
  if (!id) fail('task update 需要 --id <任务ID>');
  const payload = {};
  if (opts.status) payload.status = opts.status;
  if (opts.note) payload.note = opts.note;
  if (opts.assignee) payload.assigneeId = opts.assignee;
  if (Object.keys(payload).length === 0) fail('task update 至少需要 --status / --note / --assignee 之一');
  await api(ctx.config, 'PATCH', `/tasks/${id}`, { body: payload });
  console.log(`任务 ${id} 已更新`);
}

async function cmdDocUp(opts, ctx, pos) {
  const file = pos[0];
  if (!file) fail('doc up 需要 <文件路径>');
  const abs = path.resolve(process.cwd(), file);
  if (!fs.existsSync(abs)) fail(`文件不存在: ${file}`);
  const buf = fs.readFileSync(abs);
  const form = new FormData();
  form.append('file', new Blob([buf]), path.basename(abs));
  if (opts.desc) form.append('description', opts.desc);
  const res = await api(ctx.config, 'POST', '/documents', { form });
  const doc = res.document || res;
  console.log(`已上传文档 ${hl(doc.id || '')}（${doc.name || path.basename(abs)}，${fmtSize(doc.size ?? buf.length)}）`);
}

async function cmdDocLs(opts, ctx) {
  const query = {};
  if (opts.account) query.account = opts.account;
  const res = await api(ctx.config, 'GET', '/documents', { query });
  const items = toArray(res);
  if (items.length === 0) {
    console.log('（无文档）');
    return;
  }
  const headers = ['ID', '名称', '账号', '大小', '时间'];
  const rows = items.map((d) => [d.id || '-', d.name || '-', d.accountId || '-', fmtSize(d.size), fmtTime(d.createdAt)]);
  console.log(renderTable(headers, rows));
}

async function cmdDocGet(opts, ctx, pos) {
  const id = pos[0];
  if (!id) fail('doc get 需要 <文档ID>');

  const dl = await api(ctx.config, 'GET', `/documents/${id}/content`, {
    raw: true,
    query: opts.inline ? { inline: 1 } : undefined,
  });
  const buf = dl.buf;

  if (opts.inline) {
    const text = buf.toString('utf8');
    process.stdout.write(text);
    if (text && !text.endsWith('\n')) process.stdout.write('\n');
    return;
  }

  let out = opts.out;
  if (!out) {
    let name = id;
    try {
      const meta = await api(ctx.config, 'GET', `/documents/${id}`);
      if (meta && meta.name) name = meta.name;
    } catch {
      /* 元数据获取失败时用 id 兜底 */
    }
    out = name;
  }
  const outAbs = path.resolve(process.cwd(), out);
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  fs.writeFileSync(outAbs, buf);
  console.log(`已保存到 ${outAbs}（${fmtSize(buf.length)}）`);
}

async function cmdMemoryGet(ctx) {
  const res = await api(ctx.config, 'GET', '/memory');
  const version = res.version ?? 0;
  const content = res.content ?? '';
  console.log(`记忆版本: v${version}`);
  console.log('--- memory.md ---');
  process.stdout.write(content);
  if (content && !content.endsWith('\n')) process.stdout.write('\n');
}

async function cmdMemorySet(ctx, pos) {
  const file = pos[0];
  if (!file) fail('memory set 需要 <文件路径>');
  const abs = path.resolve(process.cwd(), file);
  if (!fs.existsSync(abs)) fail(`文件不存在: ${file}`);
  const content = fs.readFileSync(abs, 'utf8');

  const cur = await api(ctx.config, 'GET', '/memory');
  const version = cur.version ?? 0;

  try {
    const res = await api(ctx.config, 'PUT', '/memory', { body: { content, version } });
    const newVer = res.version != null ? res.version : version + 1;
    console.log(`已更新记忆到 v${newVer}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      fail(`记忆版本冲突（当前平台版本 v${cur.version ?? '?'}）。请先 a2a memory get 获取最新内容并合并，再重新 a2a memory set。`);
    }
    throw e;
  }
}

async function cmdHeartbeat(opts, ctx) {
  const payload = {};
  if (opts.status) payload.status = opts.status;
  if (opts.note) payload.note = opts.note;
  const res = await api(ctx.config, 'POST', '/heartbeat', { body: payload });
  const pending = res.pending || {};
  console.log(
    `心跳成功：在线=${res.online ? '是' : '否'} 状态=${res.status || opts.status || '-'} ` +
      `未读=${pending.unreadMessages ?? 0} 待办=${pending.todoTasks ?? 0}`
  );
}

/* ------------------------------------------------------------------------- *
 * 帮助
 * ------------------------------------------------------------------------- */

function printHelp() {
  console.log(hl('Agent2Agent 统一 CLI · a2a'));
  console.log('Agent ↔ Agent 异步协作平台的零依赖接入工具。');
  console.log('');
  console.log(paint(C.bold, '用法:') + '  a2a <命令> [选项]');
  console.log('');
  console.log(paint(C.bold, '命令:'));
  const cmds = [
    ['init', '注册账号、生成配置并全量推送文档目录'],
    ['whoami', '查看当前账号信息'],
    ['agents', '查看平台目录（谁是谁、在做什么）'],
    ['checkin', '启动报到：双向同步 + 拉取收件箱/待办/记忆摘要'],
    ['send', '发送消息'],
    ['inbox', '收件箱'],
    ['outbox', '发件箱'],
    ['reply', '回复消息'],
    ['mark', '标记消息状态'],
    ['task', '任务看板（new / list / update）'],
    ['doc', '文档（up / ls / get）'],
    ['sync', '双向镜像同步本地 doc 目录 ↔ 平台'],
    ['memory', '记忆（get / set）'],
    ['heartbeat', '心跳'],
    ['help', '显示本帮助'],
  ];
  for (const [c, d] of cmds) console.log(`  ${paint(C.cyan, c.padEnd(10))} ${d}`);

  console.log('');
  console.log(paint(C.bold, '全局选项:'));
  console.log('  --config <path>  指定配置文件路径（默认从当前目录逐级向上查找 .agent-platform.json）');

  console.log('');
  console.log(paint(C.bold, '命令用法:'));
  console.log('  a2a init --url <U> --name <N> --tool <T> --project <P> [--description D] [--capabilities a,b] [--tech x,y] [--doc-dir D]');
  console.log('  a2a whoami');
  console.log('  a2a agents');
  console.log('  a2a checkin [--status S]');
  console.log('  a2a send --to <X> --subject <S> --body <B> [--doc id]... [--need-reply] [--priority P]');
  console.log('  a2a inbox [--unread] [--limit N]');
  console.log('  a2a outbox [--limit N]');
  console.log('  a2a reply --msg <ID> --body <B> [--doc id]...');
  console.log('  a2a mark --msg <ID> --status <S>');
  console.log('  a2a task new --title <T> [--desc D] [--assignee A] [--priority P] [--source-msg M]');
  console.log('  a2a task list [--status S] [--account A]');
  console.log('  a2a task update --id <ID> [--status S] [--note N] [--assignee A]');
  console.log('  a2a doc up <file> [--desc D]');
  console.log('  a2a doc ls [--account A]');
  console.log('  a2a doc get <id> [--out FILE] [--inline]');
  console.log('  a2a sync');
  console.log('  a2a memory get');
  console.log('  a2a memory set <file>');
  console.log('  a2a heartbeat [--status S] [--note N]');

  console.log('');
  console.log(paint(C.bold, '示例:'));
  console.log('  a2a init --url http://127.0.0.1:3081 --name A项目开发 --tool cursor --project A项目');
  console.log('  a2a checkin');
  console.log('  a2a send --to B项目开发 --subject 需要API --body "请提供接口清单" --need-reply');
  console.log('  a2a inbox --unread');
  console.log('  a2a task new --title 实现登录 --priority high');
  console.log('  a2a doc up ./需求.md');
  console.log('  a2a sync');
}

/* ------------------------------------------------------------------------- *
 * 入口
 * ------------------------------------------------------------------------- */

async function main() {
  const { pos, opts } = parseArgs(process.argv.slice(2));
  const cmd = pos[0];

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    printHelp();
    return;
  }

  if (cmd === 'init') {
    await cmdInit(opts);
    return;
  }

  const ctx = requireConfig(opts.config);
  const sub = pos[1];

  switch (cmd) {
    case 'whoami':
      await cmdWhoami(ctx);
      break;
    case 'agents':
      await cmdAgents(ctx);
      break;
    case 'checkin':
      await cmdCheckin(opts, ctx);
      break;
    case 'send':
      await cmdSend(opts, ctx);
      break;
    case 'inbox':
      await cmdInbox(opts, ctx, 'in');
      break;
    case 'outbox':
      await cmdInbox(opts, ctx, 'out');
      break;
    case 'reply':
      await cmdReply(opts, ctx);
      break;
    case 'mark':
      await cmdMark(opts, ctx);
      break;
    case 'sync':
      await doSync(ctx.config, ctx.dir);
      break;
    case 'heartbeat':
      await cmdHeartbeat(opts, ctx);
      break;
    case 'task':
      if (sub === 'new') await cmdTaskNew(opts, ctx);
      else if (sub === 'list') await cmdTaskList(opts, ctx);
      else if (sub === 'update') await cmdTaskUpdate(opts, ctx);
      else fail('task 子命令: new | list | update（用 a2a help 查看用法）');
      break;
    case 'doc':
      if (sub === 'up') await cmdDocUp(opts, ctx, pos.slice(2));
      else if (sub === 'ls') await cmdDocLs(opts, ctx);
      else if (sub === 'get') await cmdDocGet(opts, ctx, pos.slice(2));
      else fail('doc 子命令: up | ls | get（用 a2a help 查看用法）');
      break;
    case 'memory':
      if (sub === 'get') await cmdMemoryGet(ctx);
      else if (sub === 'set') await cmdMemorySet(ctx, pos.slice(2));
      else fail('memory 子命令: get | set（用 a2a help 查看用法）');
      break;
    default:
      fail(`未知命令: ${cmd}（用 a2a help 查看全部命令）`);
  }
}

main().catch((err) => {
  const msg = err && err.message ? err.message : String(err);
  fail(msg);
});
