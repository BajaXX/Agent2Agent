'use strict';
/**
 * Agent2Agent (a2a) — VSCode 扩展（兼容 Cursor / Windsurf / Trae 等 VSCode 系 IDE）
 *
 * 功能：
 *  - 打开项目自动检测：工作区无 .a2a.json 时询问是否接入（程序级，非规则驱动）
 *  - 命令面板：接入向导 / check-in / 收件箱 / 发消息 / 同步 / 任务 / 记忆 / 平台目录 / 看板
 *  - 资源管理器树视图：收件箱（未读消息）、任务（按状态分组）
 *  - 状态栏：接入状态 + 未读消息数
 *
 * 展示类数据直接调用平台 REST API（读取 .a2a.json 配置）；
 * 操作类（init / checkin / sync）调用扩展内置的 a2a CLI（a2a.js 副本）。
 */
const vscode = require('vscode');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

let outputChannel = null;
let statusBar = null;
let inboxProvider = null;
let taskProvider = null;

/* ---------------- 基础工具 ---------------- */

function workspaceRoot() {
  const f = vscode.workspace.workspaceFolders;
  return f && f.length ? f[0].uri.fsPath : null;
}

function configPath(root) {
  return path.join(root, '.a2a.json');
}

function readConfig(root) {
  try {
    return JSON.parse(fs.readFileSync(configPath(root), 'utf8'));
  } catch (e) {
    return null;
  }
}

function log(msg) {
  if (!outputChannel) return;
  outputChannel.appendLine(msg);
}

function showError(msg) {
  vscode.window.showErrorMessage(msg);
  log('错误: ' + msg);
}

/** 调用内置 a2a CLI（非交互子进程） */
function runCli(args, cwd) {
  const a2aJs = path.join(__dirname, 'a2a.js');
  return new Promise((resolve) => {
    execFile('node', [a2aJs, ...args], { cwd: cwd || '' }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/** 直接调用平台 REST API（展示类数据） */
async function api(config, method, pathName, body) {
  const base = String(config.url || '').replace(/\/+$/, '') + '/api/v1';
  let url = base + pathName;
  if (method === 'GET' && body && typeof body === 'object') {
    const qs = new URLSearchParams(body).toString();
    if (qs) url += '?' + qs;
  }
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: 'Bearer ' + config.token,
        ...(body && method !== 'GET' ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body && method !== 'GET' ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) { data = text; }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: null, error: e.message };
  }
}

/* ---------------- 命令实现 ---------------- */

async function cmdInit() {
  const root = workspaceRoot();
  if (!root) return showError('请先打开一个项目文件夹（File > Open Folder）。');
  if (fs.existsSync(configPath(root))) {
    const ans = await vscode.window.showWarningMessage(
      '本项目已存在 .a2a.json，重新接入会覆盖现有 token。确认继续？',
      '覆盖', '取消'
    );
    if (ans !== '覆盖') return;
  }

  const url = await vscode.window.showInputBox({
    prompt: '平台地址', value: 'http://127.0.0.1:3081', ignoreFocusOut: true,
  });
  if (url === undefined || !url.trim()) return;

  const name = await vscode.window.showInputBox({
    prompt: '账号名（端+项目，全局唯一，如 A项目开发）', ignoreFocusOut: true,
  });
  if (!name || !name.trim()) return showError('账号名必填，已取消接入。');

  const tool = await vscode.window.showQuickPick(
    ['cursor', 'claude-code', 'dsh', 'other'],
    { placeHolder: '工具类型（当前 IDE 的 agent 工具）' }
  );
  if (!tool) return;

  const project = await vscode.window.showInputBox({
    prompt: '项目名称', ignoreFocusOut: true,
  });
  if (!project || !project.trim()) return showError('项目名称必填，已取消接入。');

  const docDir = await vscode.window.showInputBox({
    prompt: '文档同步目录（项目内任意目录，如 docs/ 或 .a2a/docs）',
    value: '.a2a/docs', ignoreFocusOut: true,
  });
  if (docDir === undefined) return;

  vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '正在接入 Agent2Agent…' }, async () => {
    const r = await runCli(['init', '--url', url.trim(), '--name', name.trim(), '--tool', tool,
      '--project', project.trim(), '--doc-dir', docDir.trim()], root);
    if (!r.ok) return showError(r.stderr || r.stdout || '接入失败');
    outputChannel.show(true);
    log('===== 接入成功（token 仅此一次显示，请妥善保存）=====');
    log(r.stdout);
    vscode.window.showInformationMessage(`已接入 Agent2Agent（账号: ${name.trim()}）`);
    refreshAll();
  });
}

async function requireConfig() {
  const root = workspaceRoot();
  if (!root) { showError('请先打开一个项目文件夹。'); return null; }
  const cfg = readConfig(root);
  if (!cfg) {
    const ans = await vscode.window.showInformationMessage(
      '本项目尚未接入 Agent2Agent，是否现在接入？', '立即接入', '暂不'
    );
    if (ans === '立即接入') await cmdInit();
    return null;
  }
  return cfg;
}

async function cmdCheckin() {
  const root = workspaceRoot();
  const cfg = await requireConfig();
  if (!cfg || !root) return;
  const r = await runCli(['checkin'], root);
  outputChannel.show(true);
  log(r.stdout || r.stderr);
  if (!r.ok) vscode.window.showWarningMessage('check-in 失败，请确认平台在线。');
  await refreshAll();
}

async function cmdInbox() {
  const cfg = await requireConfig();
  if (!cfg) return;
  const r = await api(cfg, 'GET', '/messages', { dir: 'in' });
  if (!r.ok) return showError('获取收件箱失败: ' + (r.data && r.data.error ? r.data.error.message : r.status));
  const items = (r.data && (r.data.items || r.data)) || [];
  outputChannel.show(true);
  log('===== 收件箱（共 ' + items.length + ' 条）=====');
  if (!items.length) log('（空）');
  for (const m of items) {
    log(`[${m.status}] ${m.from} → ${m.to} ｜ ${m.subject}`);
    if (m.body) log('    ' + String(m.body).split('\n').join('\n    '));
    if (m.needsReply && m.status !== 'resolved') log('    ⚠ 需回复');
    log('');
  }
}

async function cmdSend() {
  const cfg = await requireConfig();
  if (!cfg) return;
  const to = await vscode.window.showInputBox({ prompt: '收件账号（如 A项目开发）', ignoreFocusOut: true });
  if (!to || !to.trim()) return;
  const subject = await vscode.window.showInputBox({ prompt: '主题', ignoreFocusOut: true });
  if (!subject || !subject.trim()) return;
  const body = await vscode.window.showInputBox({ prompt: '正文（可留空）', ignoreFocusOut: true });
  if (body === undefined) return;
  const needReply = await vscode.window.showQuickPick(['否', '是'], { placeHolder: '需要对方回复？' });
  if (!needReply) return;
  const r = await api(cfg, 'POST', '/messages', {
    to: to.trim(), subject: subject.trim(), body: body || '',
    needsReply: needReply === '是',
  });
  if (!r.ok) return showError('发送失败: ' + (r.data && r.data.error ? r.data.error.message : r.status));
  vscode.window.showInformationMessage(`已发送 → ${to.trim()}（${subject.trim()}）`);
  await refreshAll();
}

async function cmdSync() {
  const root = workspaceRoot();
  const cfg = await requireConfig();
  if (!cfg || !root) return;
  const r = await runCli(['sync'], root);
  outputChannel.show(true);
  log(r.stdout || r.stderr);
  if (!r.ok) vscode.window.showWarningMessage('同步失败，请确认平台在线。');
}

async function cmdTasks() {
  const cfg = await requireConfig();
  if (!cfg) return;
  const r = await api(cfg, 'GET', '/tasks', { account: cfg.accountId });
  if (!r.ok) return showError('获取任务失败: ' + (r.data && r.data.error ? r.data.error.message : r.status));
  const items = r.data || [];
  outputChannel.show(true);
  log('===== 我的任务（共 ' + items.length + ' 个）=====');
  const by = { todo: [], doing: [], blocked: [], done: [] };
  for (const t of items) (by[t.status] || (by[t.status] = [])).push(t);
  for (const [k, label] of [['todo', '待办'], ['doing', '进行中'], ['blocked', '阻塞'], ['done', '已完成']]) {
    log(`-- ${label} --`);
    if (!by[k] || !by[k].length) { log('  （无）'); continue; }
    for (const t of by[k]) log(`  [${t.id}] ${t.title}${t.note ? ' ｜ ' + t.note : ''}`);
  }
}

async function cmdMemory() {
  const cfg = await requireConfig();
  if (!cfg) return;
  const r = await api(cfg, 'GET', '/memory');
  if (!r.ok) return showError('获取记忆失败: ' + (r.data && r.data.error ? r.data.error.message : r.status));
  outputChannel.show(true);
  log(`===== 记忆（v${(r.data && r.data.version) || 0}）=====`);
  log((r.data && r.data.content) || '（空）');
}

async function cmdAgents() {
  const r = await api({ url: '' }, 'GET', '/agents');
  if (!r.ok) return showError('获取平台目录失败');
  const items = r.data || [];
  outputChannel.show(true);
  log('===== 平台目录（共 ' + items.length + ' 个账号）=====');
  for (const a of items) {
    log(`${a.online ? '●' : '○'} ${a.name}（${a.tool}）｜ ${a.status}${a.description ? ' ｜ ' + a.description : ''}`);
  }
}

function cmdDashboard() {
  const cfg = readConfig(workspaceRoot() || '');
  const url = cfg && cfg.url ? cfg.url.replace(/\/+$/, '') : 'http://127.0.0.1:3081';
  vscode.env.openExternal(vscode.Uri.parse(url));
}

/* ---------------- 树视图（收件箱 / 任务） ---------------- */

class InboxProvider {
  constructor() { this._onDidChange = new vscode.EventEmitter(); }
  get onDidChangeTreeData() { return this._onDidChange.event; }
  refresh() { this._onDidChange.fire(); }

  async getChildren() {
    const root = workspaceRoot();
    const cfg = root ? readConfig(root) : null;
    if (!cfg) return [new Item('（未接入：运行 a2a.init 接入）', 'info', '')];
    const r = await api(cfg, 'GET', '/messages', { dir: 'in', status: 'unread' });
    const items = r.ok ? ((r.data && r.data.items) || []) : [];
    if (!items.length) return [new Item('（暂无未读消息）', 'info', '')];
    return items.map((m) => new Item(
      `${m.subject || '（无主题）'}`, m.from + ' ｜ ' + m.status, m.id
    ));
  }

  getTreeItem(el) {
    const it = new vscode.TreeItem(el.label);
    it.description = el.description;
    it.tooltip = el.tooltip;
    it.contextValue = el.kind;
    it.command = el.id ? { command: 'a2a.inbox', title: '查看收件箱' } : undefined;
    return it;
  }
}

class TaskProvider {
  constructor() { this._onDidChange = new vscode.EventEmitter(); }
  get onDidChangeTreeData() { return this._onDidChange.event; }
  refresh() { this._onDidChange.fire(); }

  async getChildren() {
    const root = workspaceRoot();
    const cfg = root ? readConfig(root) : null;
    if (!cfg) return [new Item('（未接入：运行 a2a.init 接入）', 'info', '')];
    const r = await api(cfg, 'GET', '/tasks', { account: cfg.accountId });
    const tasks = r.ok ? (r.data || []) : [];
    if (!tasks.length) return [new Item('（暂无任务）', 'info', '')];
    const groups = [['todo', '待办'], ['doing', '进行中'], ['blocked', '阻塞'], ['done', '已完成']];
    const out = [];
    for (const [key, label] of groups) {
      const inGroup = tasks.filter((t) => (t.status || 'todo') === key);
      out.push(new Item(`${label}（${inGroup.length}）`, key, '', 'group'));
      for (const t of inGroup) out.push(new Item(t.title, key, t.id, 'task'));
    }
    return out;
  }

  getTreeItem(el) {
    const it = new vscode.TreeItem(el.label);
    it.description = el.description;
    it.tooltip = el.tooltip;
    it.collapsibleState = el.kind === 'group' ? vscode.TreeItemCollapsibleState.None
      : vscode.TreeItemCollapsibleState.None;
    it.contextValue = el.kind;
    it.command = el.kind === 'task' ? { command: 'a2a.tasks', title: '查看任务' } : undefined;
    return it;
  }
}

class Item {
  constructor(label, description, id, kind) {
    this.label = label;
    this.description = description;
    this.id = id;
    this.kind = kind || 'item';
    this.tooltip = id ? `${id} ｜ ${label}` : label;
  }
}

/* ---------------- 状态栏 ---------------- */

async function updateStatusBar() {
  const root = workspaceRoot();
  const cfg = root ? readConfig(root) : null;
  if (!cfg) {
    statusBar.text = '$(link) a2a: 未接入';
    statusBar.tooltip = '点击接入 Agent2Agent 平台';
    return;
  }
  const r = await api(cfg, 'GET', '/messages', { dir: 'in', status: 'unread' });
  const unread = r.ok ? ((r.data && r.data.items) || []).length : '?';
  statusBar.text = `$(broadcast) a2a: 已接入 · 未读 ${unread}`;
  statusBar.tooltip = '点击执行 check-in';
}

async function refreshAll() {
  await updateStatusBar();
  if (inboxProvider) inboxProvider.refresh();
  if (taskProvider) taskProvider.refresh();
}

/* ---------------- 激活 ---------------- */

function activate(context) {
  outputChannel = vscode.window.createOutputChannel('Agent2Agent');

  const register = (cmd, fn) => context.subscriptions.push(vscode.commands.registerCommand(cmd, fn));
  register('a2a.init', cmdInit);
  register('a2a.checkin', cmdCheckin);
  register('a2a.inbox', cmdInbox);
  register('a2a.send', cmdSend);
  register('a2a.sync', cmdSync);
  register('a2a.tasks', cmdTasks);
  register('a2a.memory', cmdMemory);
  register('a2a.agents', cmdAgents);
  register('a2a.dashboard', cmdDashboard);
  register('a2a.refresh', refreshAll);

  // 状态栏
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'a2a.checkin';
  statusBar.show();
  context.subscriptions.push(statusBar);

  // 树视图
  inboxProvider = new InboxProvider();
  taskProvider = new TaskProvider();
  vscode.window.registerTreeDataProvider('a2a.inbox', inboxProvider);
  vscode.window.registerTreeDataProvider('a2a.tasks', taskProvider);

  // 打开项目自动检查：工作区无 .a2a.json 时询问是否接入
  setTimeout(() => {
    const root = workspaceRoot();
    if (root && !fs.existsSync(configPath(root))) {
      vscode.window.showInformationMessage(
        '检测到本项目尚未接入 Agent2Agent 协作平台，是否现在接入？',
        '立即接入', '暂不'
      ).then((ans) => {
        if (ans === '立即接入') cmdInit();
        else refreshAll();
      });
    } else {
      refreshAll();
    }
  }, 1500);

  // 每 5 分钟刷新一次状态栏未读数
  setInterval(() => { updateStatusBar().catch(() => {}); }, 5 * 60 * 1000);

  // 静默检查扩展新版本（GitHub raw，失败不打扰）
  setTimeout(() => { checkExtensionUpdate().catch(() => {}); }, 5000);
}

/** 静默检查扩展是否有新版本（对比 GitHub 仓库中的扩展版本） */
async function checkExtensionUpdate() {
  const current = require('./package.json').version || '0.0.0';
  const res = await fetch('https://raw.githubusercontent.com/BajaXX/Agent2Agent/main/extensions/a2a-vscode/package.json');
  if (!res.ok) return;
  const latest = (await res.json()).version;
  if (!latest || latest === current) return;
  const ans = await vscode.window.showInformationMessage(
    'Agent2Agent 扩展有新版本 v' + latest + '（当前 v' + current + '），是否查看更新方式？',
    '查看更新方式', '暂不'
  );
  if (ans === '查看更新方式') {
    vscode.env.openExternal(vscode.Uri.parse('https://github.com/BajaXX/Agent2Agent/blob/main/extensions/a2a-vscode/README.md'));
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
