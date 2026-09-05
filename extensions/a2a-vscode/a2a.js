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
 * 配置：项目根目录 .a2a.json（从当前目录逐级向上查找，或 --config 指定）
 * 状态：.a2a-state.json（与配置同目录，记录同步游标与本地 manifest）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

/* 当前 CLI 版本：优先读 package.json（npm 包内自动同步），单文件拷贝场景回退 */
let VERSION = null;
try {
  VERSION = require('./package.json').version;
} catch (e) { /* 单文件拷贝场景无 package.json */ }

const REPO = 'BajaXX/Agent2Agent'; // 更新检查用的 GitHub 仓库
const NPM_PACKAGE = 'agent2agent-cli';

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

/** 从 startDir 逐级向上查找 .a2a.json */
function findConfigFile(startDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, '.a2a.json');
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
    fail('未找到 .a2a.json（已从当前目录逐级向上查找）。请先运行 a2a init 注册账号。');
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
  return path.join(dir, '.a2a-state.json');
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
  const d = config.docDir || '.a2a/docs';
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



function printConflicts(conflicts) {
  if (!conflicts || !conflicts.length) return;
  for (const c of conflicts) {
    if (c.message) console.log(paint(C.yellow, `⚠ 冲突: ${c.message}`));
    else if (c.name) console.log(paint(C.yellow, `⚠ 冲突: ${c.name} 已保留平台版本，副本另存 ${c.savedAs || '(未知)'}`));
    else console.log(paint(C.yellow, `⚠ 冲突: ${JSON.stringify(c)}`));
  }
}

/** 推送：扫描 doc 目录 → 对比 manifest → FormData 上传 files + deletes。会就地更新 state。 */
/** 计算本地 → 平台 的增量计划（新增/修改 + 删除） */
function computePushPlan(files, manifest) {
  const toPush = [];
  const toDelete = [];
  for (const [rel, info] of Object.entries(files)) {
    const prev = manifest[rel];
    if (!prev || prev.sha256 !== info.sha256) toPush.push(rel);
  }
  for (const rel of Object.keys(manifest)) {
    if (!(rel in files)) toDelete.push(rel);
  }
  return { toPush, toDelete };
}

async function pushOnce(config, configDir, state) {
  const manifest = state.manifest;
  const { files, privateFiles } = scanDocDir(config, configDir);
  const { toPush, toDelete } = computePushPlan(files, manifest);
  // [PRIVATE] 文件：若之前已同步（manifest 有记录），从平台移除（本地加 PRIVATE = 撤回共享）
  const privateToRemove = privateFiles.filter((rel) => manifest[rel]);
  const allDelete = Array.from(new Set([...toDelete, ...privateToRemove]));

  if (toPush.length === 0 && allDelete.length === 0) {
    console.log(paint(C.dim, '[同步·推送] 本地无变更'));
    if (privateFiles.length) console.log(paint(C.dim, `  （跳过 ${privateFiles.length} 个 [PRIVATE] 私有文件）`));
    return { pushed: [], deleted: [], conflicts: [] };
  }

  const form = new FormData();
  for (const rel of toPush) {
    const buf = fs.readFileSync(files[rel].abs);
    form.append('files', new Blob([buf]), rel);
  }
  if (allDelete.length) form.append('deletes', JSON.stringify(allDelete));

  const res = await api(config, 'POST', '/sync', { form });
  const pushed = res.pushed || [];
  const deleted = res.deleted || [];
  const conflicts = res.conflicts || [];

  console.log(paint(C.bold, `[同步·推送] 上传 ${pushed.length} 个文件，删除 ${deleted.length} 个`));
  for (const p of pushed) console.log(`  + ${p.name || p}`);
  for (const d of deleted) console.log(`  - ${d}`);
  if (privateFiles.length) console.log(paint(C.yellow, `  （跳过 ${privateFiles.length} 个 [PRIVATE] 私有文件${privateToRemove.length ? `，撤回 ${privateToRemove.length} 个已共享的私有文件` : ''}）`));
  printConflicts(conflicts);

  // 仅当推送成功后再更新本地 manifest
  for (const rel of toPush) {
    manifest[rel] = { sha256: files[rel].sha256, mtime: files[rel].mtime, size: files[rel].size };
  }
  for (const rel of allDelete) delete manifest[rel];
  if (res.cursor) state.lastSync = Math.max(state.lastSync || 0, res.cursor);

  return { pushed, deleted, conflicts };
}

/** 判断文件是否标记 [PRIVATE]（首行；仅文本类文件检测，二进制按公开处理） */
function isPrivateFile(absPath) {
  try {
    const fd = fs.openSync(absPath, 'r');
    const buf = Buffer.alloc(512);
    const n = fs.readSync(fd, buf, 0, 512, 0);
    fs.closeSync(fd);
    const head = buf.slice(0, n).toString('utf8');
    // 二进制（含 NUL）跳过；首行去 BOM 后匹配 [PRIVATE]
    if (head.includes('\u0000')) return false;
    return /^[\s\S]*?^\uFEFF?\[PRIVATE\]/m.test(head) || /^\uFEFF?\[PRIVATE\]/.test(head);
  } catch (e) {
    return false;
  }
}

/**
 * 同步扫描：跳过 [PRIVATE] 文件；
 * 若某文件之前已同步（manifest 有记录）但现在标记 [PRIVATE]，返回 true（需要从平台移除）。
 */
function scanDocDir(config, configDir) {
  const root = resolveDocDir(config, configDir);
  const result = {};
  const privateFiles = [];
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
        if (e.name === '.a2a-state.json' || e.name === '.a2a.json') continue;
        if (isPrivateFile(abs)) {
          privateFiles.push(relp); // [PRIVATE]：不同步
          continue;
        }
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
  return { files: result, privateFiles };
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
    const accountId = String(ch.accountId || 'unknown').replace(/[\\/]/g, '_').replace(/\.\./g, '_');
    // 保留平台端的相对目录结构（name 可能含子目录），并做路径防护
    const relParts = String(ch.name || ch.id || 'file')
      .split(/[\\/]+/)
      .filter((p) => p && p !== '.' && p !== '..');
    const file = path.join(docRoot, '_inbox', accountId, ...relParts);
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
 * 更新检查（update-check）
 * 检查三块的最新版本：CLI（npm registry）、Skills（GitHub raw）、平台（GitHub raw vs 当前实例）
 * 网络失败一律静默跳过，不阻断正常命令。
 * ------------------------------------------------------------------------- */

async function fetchJson(url, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'a2a-cli' } });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, timeoutMs = 4000) {
  const j = await fetchJson(url, timeoutMs);
  return j;
}

/**
 * 执行一次更新检查。返回提示数组 [{area, text}]；网络不可达时返回空数组。
 */
async function checkUpdates(config) {
  const notices = [];
  const cmp = (a, b) => {
    // 简单 semver 比较：x.y.z
    const pa = String(a || '').split('.').map(Number);
    const pb = String(b || '').split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      const x = pa[i] || 0;
      const y = pb[i] || 0;
      if (x !== y) return x > y ? 1 : -1;
    }
    return 0;
  };

  // 1) CLI：npm registry 最新版 vs 本地
  if (VERSION) {
    const pkg = await fetchJson(`https://registry.npmjs.org/${NPM_PACKAGE}/latest`);
    if (pkg && pkg.version && cmp(pkg.version, VERSION) > 0) {
      notices.push({
        area: 'CLI',
        text: `CLI 有新版本：当前 v${VERSION} → 最新 v${pkg.version}（更新：a2a self-update，或 npm install -g ${NPM_PACKAGE}@latest）`,
      });
    }
  }

  // 2) Skills：GitHub raw 最新 VERSION
  const skillsVer = await fetchText(`https://raw.githubusercontent.com/${REPO}/main/skills/a2a/VERSION`);
  if (skillsVer && typeof skillsVer === 'string' && skillsVer.trim()) {
    notices.push({
      area: 'Skills',
      text: `Skills 最新版本：v${skillsVer.trim()}（更新：git pull 仓库后重新拷贝 skills/a2a/ 到对应位置，见 INSTALL.md）`,
    });
  } else {
    const skillsJson = await fetchJson(`https://raw.githubusercontent.com/${REPO}/main/skills/a2a/package.json`);
    if (skillsJson && skillsJson.version) {
      notices.push({
        area: 'Skills',
        text: `Skills 最新版本：v${skillsJson.version}（更新：git pull 仓库后重新拷贝 skills/a2a/，见 INSTALL.md）`,
      });
    }
  }

  // 3) 平台：当前实例版本（/api/v1/version）vs GitHub 最新（server/package.json）
  if (config && config.url) {
    const cur = await fetchJson(String(config.url).replace(/\/+$/, '') + '/api/v1/version');
    const latest = await fetchJson(`https://raw.githubusercontent.com/${REPO}/main/server/package.json`);
    if (cur && latest && cmp(latest.version, cur.version) > 0) {
      notices.push({
        area: '平台',
        text: `平台有新版本：当前 v${cur.version} → 最新 v${latest.version}（更新：cd <仓库> && git pull && docker compose up -d --build）`,
      });
    }
  }

  return notices;
}

/** 输出更新检查结果；全部最新时输出一行确认 */
function printUpdateResult(notices) {
  console.log('');
  console.log(hl('===== a2a 更新检查 ====='));
  if (!notices.length) {
    console.log('  全部组件已是最新版本 ✓');
  } else {
    for (const n of notices) {
      console.log(paint(C.yellow, `  [${n.area}] `) + n.text);
    }
  }
  console.log(hl('========================='));
}

/** `a2a update-check`：强制检查 */
async function cmdUpdateCheck(ctx) {
  const notices = await checkUpdates(ctx.config);
  printUpdateResult(notices);
}

/** `a2a self-update`：更新 CLI 自身（人类确认后执行） */
async function cmdSelfUpdate() {
  if (!VERSION) {
    console.log(paint(C.yellow, '当前为单文件拷贝安装（无版本信息），请改用 npm 安装：npm install -g ' + NPM_PACKAGE));
    return;
  }
  console.log(`正在从 npm 更新 ${NPM_PACKAGE}（当前 v${VERSION}）...`);
  try {
    execSync(`npm install -g ${NPM_PACKAGE}@latest`, { stdio: 'inherit' });
    console.log(paint(C.green, 'CLI 更新完成 ✅ 新版本已生效（重新打开终端或运行 a2a help 确认）'));
  } catch (e) {
    console.log(paint(C.red, '更新失败，请手动执行：npm install -g ' + NPM_PACKAGE + '@latest'));
    process.exitCode = 1;
  }
}

/* ------------------------------------------------------------------------- *
 * Skills 更新（update-skills / update）
 * 从 GitHub 下载最新 skills/a2a/ 到本地安装位置（探测常见位置，支持 --to 与 --yes）
 * ------------------------------------------------------------------------- */

const SKILLS_RAW_BASE = (process.env.A2A_SKILLS_URL || '').replace(/\/+$/, '') ||
  'https://raw.githubusercontent.com/BajaXX/Agent2Agent/main/skills/a2a';

const SKILL_FILES = [
  'SKILL.md', 'INSTALL.md', 'VERSION',
  'hooks/session-start.sh', 'hooks/session-start.ps1',
  'rules/cursor.mdc',
];

/** 下载单个文件到目标（带超时，避免网络挂起；失败抛明确错误） */
async function downloadTo(relPath, destDir) {
  const url = `${SKILLS_RAW_BASE}/${relPath}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000); // 20s 超时
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': 'a2a-cli' }, signal: ctrl.signal });
  } catch (e) {
    clearTimeout(timer);
    throw new Error(`连接超时/失败（${SKILLS_RAW_BASE.replace(/^https?:\/\//, '')}），无法访问 GitHub 下载源；可稍后重试，或设置镜像源：A2A_SKILLS_URL=<可访问的镜像地址>`);
  }
  clearTimeout(timer);
  if (!res.ok) throw new Error(`下载失败 ${relPath} (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const dest = path.join(destDir, ...relPath.split('/'));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  if (relPath.endsWith('.sh')) {
    try { fs.chmodSync(dest, 0o755); } catch (e) { /* Windows 忽略 */ }
  }
  return dest;
}

/** 探测已安装的 skills 位置（存在才返回） */
function detectSkillLocations() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const found = [];
  const claudeDir = path.join(home, '.claude', 'skills', 'a2a');
  if (fs.existsSync(claudeDir)) found.push({ type: 'claude', dir: claudeDir, label: 'Claude Code skill' });
  const cursorRules = path.join(home, '.cursor', 'rules');
  if (fs.existsSync(cursorRules)) {
    if (fs.existsSync(path.join(cursorRules, 'a2a.mdc')) || fs.existsSync(path.join(cursorRules, 'agent-platform.mdc')) || fs.existsSync(path.join(cursorRules, 'cursor.mdc'))) {
      found.push({ type: 'cursor', dir: cursorRules, label: 'Cursor 规则' });
    }
  }
  const windsurfRules = path.join(home, '.windsurf', 'rules');
  if (fs.existsSync(path.join(windsurfRules, 'a2a.md'))) {
    found.push({ type: 'windsurf', dir: windsurfRules, label: 'Windsurf 规则' });
  }
  return found;
}

/** `a2a update-skills`：更新已安装的 skills（Claude/…/--to 指定目录） */
async function cmdUpdateSkills(opts) {
  const autoYes = Boolean(opts.yes || opts['yes'] || opts.y);
  const targets = [];

  if (opts.to) {
    const abs = path.resolve(process.cwd(), String(opts.to));
    targets.push({ type: 'dir', dir: abs, label: `指定目录 ${abs}` });
  } else {
    targets.push(...detectSkillLocations());
    if (!targets.length) {
      console.log(paint(C.yellow, '未检测到已安装的 skills。可用：'));
      console.log('  a2a update-skills --to <目录>   # 下载整个技能包到指定目录（如 ~/.claude/skills/a2a）');
      console.log('  （Claude Code 安装到 ~/.claude/skills/a2a 后，之后可直接 a2a update-skills）');
      return;
    }
  }

  console.log(hl('===== a2a update-skills ====='));
  for (const t of targets) console.log(`  将更新: [${t.label}]`);

  if (!autoYes && process.stdin.isTTY) {
    console.log('');
    process.stdout.write(paint(C.dim, '确认更新？(y/N，30 秒无输入自动取消) '));
    const nextLine = createLineReader();
    let confirmTimer = null;
    const ans = await Promise.race([
      nextLine(),
      new Promise((r) => { confirmTimer = setTimeout(() => r(''), 30000); }),
    ]);
    if (confirmTimer) clearTimeout(confirmTimer);
    nextLine.close();
    if (!/^y/i.test(String(ans || ''))) {
      console.log(paint(C.yellow, '已取消（可用 a2a update-skills --yes 跳过确认）'));
      return;
    }
  } else if (!autoYes && !process.stdin.isTTY) {
    console.log(paint(C.yellow, '（非交互环境：加 --yes 跳过确认）'));
    if (!process.env.A2A_AUTO_UPDATE) return;
  }

  console.log(paint(C.dim, `下载源: ${SKILLS_RAW_BASE}（网络较慢时可用 A2A_SKILLS_URL 指定镜像）`));
  let okCount = 0;
  for (const t of targets) {
    try {
      if (t.type === 'cursor') {
        // 规则目录：写入 a2a.mdc，删除旧文件名
        process.stdout.write(`  ⏳ ${t.label} 下载中...`);
        const dest = await downloadTo('rules/cursor.mdc', t.dir);
        const renamed = path.join(t.dir, 'a2a.mdc');
        fs.renameSync(dest, renamed);
        for (const old of ['agent-platform.mdc', 'cursor.mdc']) {
          const p = path.join(t.dir, old);
          if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch (e) { /* ignore */ } }
        }
        console.log(`\r  ✓ ${t.label} → ${renamed}`);
      } else {
        process.stdout.write(`  ⏳ ${t.label} 下载中...`);
        for (const rel of SKILL_FILES) await downloadTo(rel, t.dir);
        console.log(`\r  ✓ ${t.label} → ${t.dir}（${SKILL_FILES.length} 个文件）`);
      }
      okCount++;
    } catch (e) {
      console.log(`\r  ✗ ${t.label} 更新失败: ${paint(C.red, e.message)}`);
    }
  }
  console.log(hl(`更新完成（成功 ${okCount}/${targets.length}）`));
  if (okCount < targets.length) process.exitCode = 1;
}

/** `a2a update`：一键更新 CLI + Skills（平台由运维执行 docker 命令） */
async function cmdUpdate(opts) {
  console.log(hl('===== a2a update ====='));
  let updated = false;
  if (VERSION) {
    // 先检查 CLI 版本
    const pkg = await fetchJson('https://registry.npmjs.org/' + NPM_PACKAGE + '/latest');
    if (pkg && pkg.version && VERSION !== pkg.version) {
      console.log(`[CLI] 当前 v${VERSION} → 最新 v${pkg.version}，正在更新...`);
      try {
        execSync(`npm install -g ${NPM_PACKAGE}@latest`, { stdio: 'inherit' });
        console.log(paint(C.green, '[CLI] 更新完成 ✅'));
        updated = true;
      } catch (e) {
        console.log(paint(C.red, `[CLI] 更新失败，请手动：npm install -g ${NPM_PACKAGE}@latest`));
      }
    } else {
      console.log(`[CLI] 已是最新 v${VERSION} ✓`);
    }
  } else {
    console.log(paint(C.yellow, '[CLI] 单文件安装无版本信息，建议：npm install -g ' + NPM_PACKAGE));
  }
  if (updated) {
    // 本进程仍是旧代码：让用户退出后重跑，以用新版本完成其余更新
    const pkg2 = await fetchJson('https://registry.npmjs.org/' + NPM_PACKAGE + '/latest').catch(() => null);
    console.log(paint(C.yellow, 'CLI 已更新到 v' + (pkg2 ? pkg2.version : '最新') + '。请退出后重新运行 a2a update（或直接运行 a2a update-skills）完成 skills 更新。'));
    return;
  }
  await cmdUpdateSkills({ yes: opts.yes || opts.y });
  console.log('');
  console.log('平台更新（在部署服务器执行）：cd <仓库> && git pull && docker compose up -d --build（或 docker compose -f docker-compose.pull.yml up -d）');
}

/* ------------------------------------------------------------------------- *
 * 命令实现
 * ------------------------------------------------------------------------- */

/** 交互式提问：依次向用户询问缺失的字段（仅 TTY 下启用） */
/** 交互式 stdin 行读取器（供 init 向导 / update-skills 确认使用） */
function createLineReader() {
  // 自研逐行读取：输入提前到达时缓存到队列，等待者按序消费（兼容人机/伪终端/管道）
  let buffer = '';
  const queue = [];
  const waiters = [];
  let closed = false;
  process.stdin.setEncoding('utf8');
  const handler = (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).replace(/\r$/, '');
      buffer = buffer.slice(i + 1);
      const w = waiters.shift();
      if (w) w(line);
      else queue.push(line);
    }
  };
  process.stdin.on('data', handler);
  process.stdin.resume();
  const nextLine = () => {
    if (queue.length) return Promise.resolve(queue.shift());
    return new Promise((resolve) => waiters.push(resolve));
  };
  // close：移除监听并暂停 stdin——否则 TTY（永不 EOF）会保持事件循环，命令结束后进程不退出
  nextLine.close = () => {
    if (closed) return;
    closed = true;
    process.stdin.removeListener('data', handler);
    process.stdin.pause();
  };
  return nextLine;
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
  nextLine.close();
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
    if (!docDir) fields.push({ key: 'docDir', prompt: '文档同步目录（项目内任意目录，如 docs/ 或 .a2a/docs）', default: '.a2a/docs' });
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
  if (!docDir) docDir = '.a2a/docs';
  docDir = String(docDir).replace(/\/+$/, '') || '.a2a/docs';

  const body = { name, tool, projectName: project, docDir };
  if (description) body.description = description;
  if (capabilities.length) body.capabilities = capabilities;
  if (tech.length) body.tech = tech;

  console.log(paint(C.bold, '正在注册账号...'));
  const res = await api({ url }, 'POST', '/register', { body });

  const accountId = res.accountId || name;
  const token = res.token;
  const cwd = process.cwd();
  const configFile = path.join(cwd, '.a2a.json');
  if (fs.existsSync(configFile)) {
    fail(`已存在 .a2a.json（${configFile}），请先备份或删除后再 init，以免覆盖已有 token。`);
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
  console.log(paint(C.dim, '提示: 请将 .a2a.json 与 .a2a-state.json 加入 .gitignore。'));

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
  // 记忆维护提示：空记忆 / 版本过低时提醒 agent 写回（记忆由 agent 自己维护）
  const memEmpty = !mem.content || !String(mem.content || '').trim();
  if (memEmpty) {
    console.log(paint(C.yellow, '  ⚠ 记忆为空：本账号尚无 memory.md。请在会话中/结束时把「进展、决策、待办、协作关系」整理成记忆文件，用 a2a memory set <file> 写回（跨会话保持上下文的关键）。'));
  } else if ((mem.version || 0) < 2) {
    console.log(paint(C.dim, '  （提示：建议每次会话结束前用 a2a memory set 更新记忆，保持 v' + (mem.version || 0) + ' → 演进）'));
  }
  // 待我回复的消息（发给我的、needsReply、未 resolved）—— 别人等待我回复
  const needMyReply = inboxItems.filter((m) => m.needsReply && m.status !== 'resolved');
  const unreadNow = (pending.unreadMessages ?? 0);
  console.log(`未读消息: ${unreadNow} 条   待你回复: ${needMyReply.length} 条   待办任务: ${pending.todoTasks ?? taskItems.length} 个`);

  console.log('');
  console.log(paint(C.bold, '收件箱消息:'));
  if (inboxItems.length === 0) {
    console.log('  （无新消息）');
  } else {
    inboxItems.forEach((m, i) => {
      const needReply = m.needsReply && m.status !== 'resolved' ? ' ' + paint(C.yellow, '[需你回复]') : '';
      console.log(`  [${i + 1}] ${m.subject || '(无主题)'} — 来自 ${m.from || '?'}${needReply}`);
    });
  }

  console.log('');
  console.log(paint(C.bold, '我的任务（todo / doing / blocked）:'));
  const myTasks = toArray(await api(config, 'GET', '/tasks', { query: { account: ctx.config.accountId } }))
    .filter((t) => t.status !== 'done');
  if (myTasks.length === 0) {
    console.log('  （无）');
  } else {
    myTasks.forEach((t, i) => {
      const stayH = t.updatedAt ? Math.floor((Date.now() - t.updatedAt) / 3600000) : 0;
      const stay = stayH > 24
        ? ' ' + paint(C.yellow, `（滞留 ${Math.floor(stayH / 24)}d${stayH % 24}h：若等待他人/人类介入请 a2a task update 标 blocked 并说明原因）`)
        : (stayH > 4 ? `（已 ${stayH}h）` : '');
      console.log(`  [${i + 1}] ${t.title || '(无标题)'}（${t.status || '?'}）${t.assigneeId ? '→ ' + t.assigneeId : ''}${stay}`);
    });
  }

  console.log('');
  if (needMyReply.length > 0) {
    console.log(paint(C.yellow, `→ 有 ${needMyReply.length} 条消息等待你回复：用 a2a inbox 查看后 a2a reply --msg ID --body "..."，处理完 a2a mark --msg ID --status resolved`));
  }
  if ((pending.todoTasks ?? 0) > 0 || myTasks.length > 0) {
    console.log(paint(C.yellow, '→ 推进任务：a2a task list 查看 → 完成 a2a task update --id ID --status done --note 说明'));
  }
  console.log(hl('======================================='));

  // 更新检查（≤24h 一次；网络不可达静默跳过；有更新才提示）
  const lastCheck = state.lastUpdateCheckAt || 0;
  if (Date.now() - lastCheck > 24 * 3600 * 1000) {
    try {
      const notices = await checkUpdates(config);
      state.lastUpdateCheckAt = Date.now();
      saveState(dir, state);
      if (notices.length) {
        console.log('');
        console.log(paint(C.yellow, '→ 检测到可用更新（运行 a2a update-check 查看详情）：'));
        for (const n of notices) console.log(`    [${n.area}] ${n.text}`);
      }
    } catch (e) { /* 静默 */ }
  }
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
  // 方向正确的提醒标记：in = 发给我的（needsReply 未解决 → 需你回复）；out = 我发出的（未解决 → 等待对方回复）
  const headers = dir === 'in'
    ? ['ID', '编号', '来自', '主题', '状态', '提醒', '时间']
    : ['ID', '编号', '发给', '主题', '状态', '提醒', '时间'];
  const rows = items.map((m, i) => {
    const peer = dir === 'in' ? m.from : m.to;
    let flag = '';
    if (m.needsReply && m.status !== 'resolved') {
      flag = dir === 'in' ? paint(C.yellow, '需你回复') : paint(C.dim, '等待回复');
    }
    return [m.id || '-', String(i + 1), peer || '-', m.subject || '-', m.status || '-', flag || '-', fmtTime(m.createdAt)];
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

const TEXT_EXT_SET = new Set(['md', 'txt', 'json', 'js', 'mjs', 'cjs', 'ts', 'py', 'yaml', 'yml', 'html', 'css', 'xml', 'csv', 'log', 'ini', 'conf', 'sh', 'sql', 'toml']);
function isLikelyText(mime, name) {
  if (typeof mime === 'string' && mime.startsWith('text/')) return true;
  const ext = String(name || '').split('.').pop().toLowerCase();
  return TEXT_EXT_SET.has(ext);
}

/**
 * `a2a doc view @账号/路径/文件.md` —— 按 @引用 查看公开文档（只读，他人文档也可看）。
 * 引用格式：@<accountId>/<doc目录相对路径>，如 @B项目开发/docs/api.md 或 @dsh-预研/A项目需求.md。
 */
async function cmdDocView(ctx, pos) {
  const ref = pos[0];
  if (!ref) fail('doc view 需要 <@账号/路径/文件>，如 a2a doc view @B项目开发/docs/api.md');
  const clean = String(ref).replace(/^@/, '');
  const parts = clean.split('/');
  if (parts.length < 2) fail('引用格式：@账号/路径/文件（至少 @账号/文件）');
  const account = parts.shift();
  const name = parts.join('/');
  if (!account || !name) fail('引用格式：@账号/路径/文件');

  const listRes = await api(ctx.config, 'GET', '/documents', { query: { account, name } });
  const list = toArray(listRes);
  if (!list.length) fail(`未找到文档 @${account}/${name}（该账号未上传此文档，或已被删除）`);
  const doc = list[0];

  const dl = await api(ctx.config, 'GET', `/documents/${doc.id}/content`, { raw: true, query: { inline: 1 } });
  const buf = dl.buf;

  console.log(`===== @${account}/${doc.name}（${fmtSize(doc.size)}，${doc.description || '无描述'}）=====`);
  if (isLikelyText(doc.mime, doc.name)) {
    const text = buf.toString('utf8');
    process.stdout.write(text);
    if (text && !text.endsWith('\n')) process.stdout.write('\n');
  } else {
    const outAbs = path.resolve(process.cwd(), doc.name.split('/').pop() || 'doc.bin');
    fs.mkdirSync(path.dirname(outAbs), { recursive: true });
    fs.writeFileSync(outAbs, buf);
    console.log(`（二进制/非文本文件，已保存到 ${outAbs}）`);
  }
  console.log('==========================================');
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
    ['update-check', '检查各组件是否有新版本'],
    ['update', '一键更新 CLI + skills'],
    ['update-skills', '更新已安装的 skills（--to 指定目录 / --yes 免确认）'],
    ['self-update', '更新 CLI 自身（npm）'],
    ['help', '显示本帮助'],
  ];
  for (const [c, d] of cmds) console.log(`  ${paint(C.cyan, c.padEnd(10))} ${d}`);

  console.log('');
  console.log(paint(C.bold, '全局选项:'));
  console.log('  --config <path>  指定配置文件路径（默认从当前目录逐级向上查找 .a2a.json）');

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
  console.log('  a2a doc view <@账号/路径/文件>   # 按 @引用 查看文档（只读）');
  console.log('  a2a doc ls [--account A]');
  console.log('  a2a doc get <id> [--out FILE] [--inline]');
  console.log('  a2a sync');
  console.log('  a2a memory get');
  console.log('  a2a memory set <file>');
  console.log('  a2a heartbeat [--status S] [--note N]');
  console.log('  a2a update-check / a2a self-update   # 检查更新 / 更新 CLI 自身');

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

/** 打印版本号：a2a version / -v / --version */
function printVersion() {
  if (VERSION) {
    console.log(`a2a ${VERSION}（${NPM_PACKAGE}）`);
  } else {
    console.log('a2a 单文件版（无版本信息，建议改用 npm 安装：npm install -g ' + NPM_PACKAGE + '）');
  }
  console.log('Agent2Agent 协作平台客户端 · https://github.com/BajaXX/Agent2Agent');
}

/* ------------------------------------------------------------------------- *
 * 入口
 * ------------------------------------------------------------------------- */

async function main() {
  const { pos, opts } = parseArgs(process.argv.slice(2));
  const cmd = pos[0];

  // 版本号：a2a version / a2a --version / a2a -v
  if (cmd === 'version' || cmd === '--version' || cmd === '-v' || opts.version) {
    printVersion();
    return;
  }

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    printHelp();
    return;
  }

  if (cmd === 'init') {
    await cmdInit(opts);
    return;
  }

  // 更新类命令不依赖项目配置（操作的是本地 CLI / skills）
  if (cmd === 'self-update') {
    await cmdSelfUpdate();
    return;
  }
  if (cmd === 'update-skills') {
    await cmdUpdateSkills(opts);
    return;
  }
  if (cmd === 'update') {
    await cmdUpdate(opts);
    return;
  }
  if (cmd === 'update-check') {
    // 有 .a2a.json 则附带平台版本对比；无配置只检查 CLI / skills
    let cfg = null;
    try { cfg = requireConfig(opts.config); } catch (e) { cfg = null; }
    await cmdUpdateCheck(cfg || { config: null });
    return;
  }

  let ctx = null;
  try {
    ctx = requireConfig(opts.config);
  } catch (e) {
    process.stderr.write(String(e.message || e) + '\n');
    process.exit(1);
  }
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
      else if (sub === 'view') await cmdDocView(ctx, pos.slice(2));
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

main()
  .catch((err) => {
    const msg = err && err.message ? err.message : String(err);
    fail(msg);
  })
  .finally(() => {
    // 统一「跑完即退」守卫：命令逻辑完成后，若仍有残留句柄（stdin 监听、定时器等）
    // 阻止事件循环退出，短暂等待 stdout flush 后强制退出，回到 shell。
    const guard = setTimeout(() => {
      try {
        process.stdin.pause();
        if (process.stdin.removeAllListeners) process.stdin.removeAllListeners('data');
      } catch (e) { /* ignore */ }
      process.exit(process.exitCode || 0);
    }, 600);
    if (guard.unref) guard.unref();
  });
