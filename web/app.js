'use strict';

/* =========================================================================
 * Agent2Agent 人类看板（只读，原生 JS，无外部依赖）
 * 布局（v0.3）：
 *   左栏：顶部「全局看板」卡片（含统计）→ Agents 列表
 *   主区：全局视图（任务看板 / 消息流水）｜ Agent 视图（该账号的消息 / 文档 / 记忆）
 * 点击左侧某个 Agent → 主区切换为该 Agent 的消息、文档、记忆。
 * ========================================================================= */

/* ---------- 工具函数 ---------- */
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function relativeTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - Number(ts);
  if (diff < 0) return '刚刚';
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return '刚刚';
  const min = Math.floor(sec / 60);
  if (min < 60) return min + '分钟前';
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + '小时前';
  const day = Math.floor(hr / 24);
  return day + '天前';
}

function formatSize(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / (1024 * 1024)).toFixed(1) + ' MB';
}

function formatDateTime(ts) {
  if (!ts) return '';
  const d = new Date(Number(ts));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ---------- 稳定配色（按 accountId） ---------- */
const PALETTE = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6',
  '#ef4444', '#14b8a6', '#f97316', '#06b6d4', '#84cc16', '#a855f7'];
function accountColor(id) {
  let h = 0;
  const s = String(id || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

/* ---------- 标签映射 ---------- */
const MSG_STATUS_LABEL = { unread: '未读', read: '已读', processing: '处理中', resolved: '已解决' };
const AGENT_STATUS_LABEL = { starting: '启动中', working: '工作中', idle: '空闲', offline: '离线' };
const PRIORITY_LABEL = { low: '低', normal: '普通', high: '高', urgent: '紧急' };
const EVENT_TYPE_LABEL = { message: '消息', task: '任务', doc: '文档', memory: '记忆', presence: '在线' };
const KANBAN_COLS = [['todo', '待办'], ['doing', '进行中'], ['blocked', '阻塞'], ['done', '已完成']];
const STATUS_COLOR = { todo: '#f59e0b', doing: '#3b82f6', blocked: '#ef4444', done: '#10b981' };

/* ---------- 全局状态 ---------- */
const state = {
  summary: null,        // GET /summary
  agents: [],           // GET /agents
  tasks: [],            // GET /tasks（全局）
  feedMessages: [],     // GET /messages（全局流水）
  documents: [],        // GET /documents（全局，供 docIds 引用展示）
  view: 'global',       // 'global' | 'agent'
  globalTab: 'kanban',  // 'kanban' | 'feed'
  selected: null,       // 当前选中的 agent id
  agentTab: 'messages', // 'messages' | 'docs' | 'memory'
  agent: null,          // 选中账号（agents 中的条目）
  agentDetail: null,    // GET /agents/:id 详情
  agentMessages: [],    // ?account= 该账号消息
  agentDocs: [],        // ?account= 该账号文档
  agentMemory: null,    // {content, version}
  agentVersions: [],    // 记忆版本历史
  msgFilter: 'all',     // all | reply | unread
};

/* ---------- API 封装 ---------- */
async function api(path) {
  const res = await fetch(path, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`请求失败 ${path} (${res.status})`);
  return res.json();
}

async function apiText(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`请求失败 ${path} (${res.status})`);
  return res.text();
}

function asList(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    if (Array.isArray(data.items)) return data.items;
    if (Array.isArray(data.tasks)) return data.tasks;
    if (Array.isArray(data.documents)) return data.documents;
  }
  return [];
}

/* ---------- 名称/状态辅助 ---------- */
function agentName(id) {
  if (!id) return '';
  const a = state.agents.find((x) => x.id === id);
  return a ? a.name : id;
}

function agentStatusText(agent) {
  const st = agent.online ? (AGENT_STATUS_LABEL[agent.status] || agent.status || '在线') : '离线';
  const last = agent.lastSeen ? ' · ' + relativeTime(agent.lastSeen) : '';
  return st + last;
}

function agentById(id) {
  return state.agents.find((a) => a.id === id) || null;
}

/* =========================================================================
 * 数据加载
 * ========================================================================= */
async function loadSummary() {
  try {
    const s = await api('/api/v1/summary');
    state.summary = s;
    if (s.agents) {
      // 用 summary 的在线信息更新 agents
      const m = new Map(s.agents.map((a) => [a.id, a]));
      state.agents.forEach((a) => {
        const s2 = m.get(a.id);
        if (s2) Object.assign(a, s2);
      });
    }
  } catch (e) { state.summary = null; }
  renderTopBar();
  renderGlobalCard();
  renderAgentList();
  if (state.view === 'global') renderGlobalStats();
  else if (state.selected) renderAgentHead();
}

async function loadAgents() {
  try {
    state.agents = asList(await api('/api/v1/agents'));
  } catch (e) { state.agents = []; }
  renderAgentList();
  renderGlobalCard();
}

async function loadTasks() {
  try {
    state.tasks = asList(await api('/api/v1/tasks'));
  } catch (e) { state.tasks = []; }
  renderGlobalCard();
  if (state.view === 'global' && state.globalTab === 'kanban') renderGlobalKanban();
}

async function loadFeedMessages() {
  try {
    state.feedMessages = asList(await api('/api/v1/messages'));
  } catch (e) { state.feedMessages = []; }
  if (state.view === 'global' && state.globalTab === 'feed') renderGlobalFeed();
}

async function loadAllDocuments() {
  try {
    state.documents = asList(await api('/api/v1/documents'));
  } catch (e) { state.documents = []; }
}

/* =========================================================================
 * 顶栏
 * ========================================================================= */
function renderTopBar() {
  const s = state.summary;
  if (!s) return;
  const agents = s.agents || [];
  const online = agents.filter((a) => a.online).length;
  const total = agents.length;
  const ts = s.taskStats || {};
  const cards = (ts.todo || 0) + (ts.doing || 0) + (ts.blocked || 0) + (ts.done || 0);
  $('#stat-online').textContent = `在线 ${online}/${total}`;
  $('#stat-unread').textContent = `未读 ${s.unreadTotal || 0}`;
  $('#stat-reply').textContent = `待回复 ${s.needsReplyPending || 0}`;
  $('#stat-cards').textContent = `全局看板 ${cards} 卡`;
}

/* =========================================================================
 * 左栏：全局卡片 + Agent 列表
 * ========================================================================= */
function renderGlobalCard() {
  const el = $('#global-mini-stats');
  if (!el) return;
  el.classList.toggle('active', state.view === 'global');
  const agents = state.summary && state.summary.agents ? state.summary.agents : state.agents;
  const online = agents.filter((a) => a.online).length;
  const ts = (state.summary && state.summary.taskStats) || countTaskStats(state.tasks);
  const tasks = Object.values(ts).reduce((x, y) => x + (y || 0), 0);
  el.innerHTML =
    `<div class="gms-row"><span>在线</span><b>${online}/${agents.length || 0}</b></div>` +
    `<div class="gms-row"><span>任务</span><b>${tasks}</b> ` +
    `<span class="gms-dots">` +
    `<i style="background:${STATUS_COLOR.todo}" title="待办 ${ts.todo || 0}"></i>` +
    `<i style="background:${STATUS_COLOR.doing}" title="进行中 ${ts.doing || 0}"></i>` +
    `<i style="background:${STATUS_COLOR.blocked}" title="阻塞 ${ts.blocked || 0}"></i>` +
    `<i style="background:${STATUS_COLOR.done}" title="完成 ${ts.done || 0}"></i>` +
    `</span></div>` +
    `<div class="gms-row"><span>未读</span><b>${(state.summary && state.summary.unreadTotal) || 0}</b>` +
    `&nbsp;<span>待回复</span><b>${(state.summary && state.summary.needsReplyPending) || 0}</b></div>`;
}

function countTaskStats(tasks) {
  const ts = { todo: 0, doing: 0, blocked: 0, done: 0 };
  (tasks || []).forEach((t) => { if (ts[t.status] !== undefined) ts[t.status]++; });
  return ts;
}

function renderAgentList() {
  const list = $('#agent-list');
  if (!list) return;
  list.innerHTML = '';
  if (!state.agents.length) {
    list.innerHTML = '<div class="empty">暂无 Agent</div>';
    return;
  }
  state.agents.forEach((agent) => {
    const item = document.createElement('div');
    item.className = 'agent-item' + (state.view === 'agent' && state.selected === agent.id ? ' selected' : '');
    item.dataset.id = agent.id;
    const color = accountColor(agent.id);
    const ts = agent.taskStats || {};
    const doing = ts.doing || 0;
    const todo = ts.todo || 0;
    item.innerHTML =
      '<div class="agent-row">' +
        '<span class="dot ' + (agent.online ? 'on' : 'off') + '"></span>' +
        '<span class="agent-color" style="background:' + color + '"></span>' +
        '<div class="agent-main">' +
          '<div class="agent-name">' + esc(agent.name) +
            (agent.tool ? ' <span class="tool-tag">' + esc(agent.tool) + '</span>' : '') + '</div>' +
          '<div class="agent-sub">' + esc(agentStatusText(agent)) +
            ((doing || todo) ? ' · <b style="color:' + color + '">' + (doing + todo) + '</b> 进行中' : '') +
          '</div>' +
        '</div>' +
      '</div>';
    item.addEventListener('click', () => selectAgent(agent.id));
    list.appendChild(item);
  });
}

/* =========================================================================
 * 视图切换
 * ========================================================================= */
function showView(v) {
  state.view = v;
  $('#view-global').classList.toggle('hidden', v !== 'global');
  $('#view-agent').classList.toggle('hidden', v !== 'agent');
  $('#global-card').classList.toggle('active', v === 'global');
  renderAgentList();
}

function selectGlobal() {
  showView('global');
  renderGlobalStats();
  if (state.globalTab === 'kanban') renderGlobalKanban();
  else renderGlobalFeed();
}

function selectAgent(id) {
  const agent = agentById(id);
  if (!agent) return;
  state.selected = id;
  state.agent = agent;
  state.agentDetail = null;
  showView('agent');
  renderAgentHead();
  // 按需加载：消息 / 文档 / 记忆
  if (state.agentTab === 'messages') loadAgentMessages();
  else if (state.agentTab === 'docs') loadAgentDocs();
  else loadAgentMemory();
}

/* =========================================================================
 * 全局视图
 * ========================================================================= */
function renderGlobalStats() {
  const box = $('#global-stats');
  if (!box) return;
  const ts = countTaskStats(state.tasks);
  const agents = state.summary && state.summary.agents ? state.summary.agents : state.agents;
  const online = agents.filter((a) => a.online).length;
  const perAgent = new Map();
  state.tasks.forEach((t) => {
    const k = t.accountId || '?';
    if (!perAgent.has(k)) perAgent.set(k, { todo: 0, doing: 0, blocked: 0, done: 0 });
    const st = t.status;
    if (perAgent.get(k)[st] !== undefined) perAgent.get(k)[st]++;
  });
  let html = '<div class="stat-chips">';
  html += `<span class="chip"><i class="sq" style="background:${STATUS_COLOR.todo}"></i>待办 <b>${ts.todo}</b></span>`;
  html += `<span class="chip"><i class="sq" style="background:${STATUS_COLOR.doing}"></i>进行中 <b>${ts.doing}</b></span>`;
  html += `<span class="chip"><i class="sq" style="background:${STATUS_COLOR.blocked}"></i>阻塞 <b>${ts.blocked}</b></span>`;
  html += `<span class="chip"><i class="sq" style="background:${STATUS_COLOR.done}"></i>完成 <b>${ts.done}</b></span>`;
  html += `<span class="chip sep">在线 <b>${online}/${agents.length || 0}</b></span>`;
  html += `<span class="chip">未读 <b>${(state.summary && state.summary.unreadTotal) || 0}</b></span>`;
  html += `<span class="chip">待回复 <b>${(state.summary && state.summary.needsReplyPending) || 0}</b></span>`;
  html += '</div>';
  // 各账号任务分布
  if (perAgent.size) {
    html += '<div class="agent-task-dist">';
    html += perAgent.size > 1 ? '<div class="atd-title">各账号任务分布</div>' : '';
    perAgent.forEach((st2, acc) => {
      const c = accountColor(acc);
      const total = Object.values(st2).reduce((x, y) => x + y, 0);
      const pct = (k) => (total ? Math.round((st2[k] / total) * 100) : 0);
      html += `<div class="atd-row"><span class="atd-name" style="color:${c}">${esc(agentName(acc))}</span>` +
        `<span class="atd-bar"><i style="width:${pct('todo')}%;background:${STATUS_COLOR.todo}"></i>` +
        `<i style="width:${pct('doing')}%;background:${STATUS_COLOR.doing}"></i>` +
        `<i style="width:${pct('blocked')}%;background:${STATUS_COLOR.blocked}"></i>` +
        `<i style="width:${pct('done')}%;background:${STATUS_COLOR.done}"></i></span>` +
        `<span class="atd-num">${total}</span></div>`;
    });
    html += '</div>';
  }
  box.innerHTML = html;
}

function renderGlobalKanban() {
  const kb = $('#global-kanban');
  if (!kb) return;
  kb.innerHTML = '';
  KANBAN_COLS.forEach(([key, title]) => {
    const col = document.createElement('div');
    col.className = 'kanban-col col-' + key;
    const head = document.createElement('div');
    head.className = 'kanban-col-head';
    const tasks = state.tasks
      .filter((t) => (t.status || 'todo') === key)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    head.innerHTML = '<span class="col-title">' + title + '</span><span class="col-count">' + tasks.length + '</span>';
    col.appendChild(head);
    const body = document.createElement('div');
    body.className = 'kanban-col-body';
    if (!tasks.length) body.innerHTML = '<div class="empty">暂无任务</div>';
    else tasks.forEach((t) => body.appendChild(taskCard(t)));
    col.appendChild(body);
    kb.appendChild(col);
  });
}

function renderGlobalFeed() {
  const box = $('#global-feed');
  if (!box) return;
  renderMessageList(box, state.feedMessages);
}

function renderMessageList(box, allMsgs) {
  const pred = state.msgFilter === 'reply'
    ? (m) => m.needsReply && m.status !== 'resolved'
    : state.msgFilter === 'unread' ? (m) => m.status === 'unread' : () => true;
  const filterHtml =
    '<div class="filters">' +
      '<button class="filter' + (state.msgFilter === 'all' ? ' active' : '') + '" data-f="all">全部</button>' +
      '<button class="filter' + (state.msgFilter === 'reply' ? ' active' : '') + '" data-f="reply">待回复</button>' +
      '<button class="filter' + (state.msgFilter === 'unread' ? ' active' : '') + '" data-f="unread">未读</button>' +
    '</div>';
  const msgs = (allMsgs || []).filter(pred).slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  box.innerHTML = filterHtml + '<div class="msg-list"></div>';
  const listBox = $('.msg-list', box);
  if (!msgs.length) { listBox.innerHTML = '<div class="empty">暂无消息</div>'; return; }
  const depth = messageDepthFn(allMsgs || []);
  msgs.forEach((m) => listBox.appendChild(messageRow(m, depth(m))));
}

/* =========================================================================
 * Agent 视图
 * ========================================================================= */
function renderAgentHead() {
  const box = $('#agent-head');
  if (!box) return;
  const a = state.agent;
  if (!a) return;
  const color = accountColor(a.id);
  const detail = state.agentDetail || a;
  const ts = a.taskStats || {};
  const caps = a.capabilities || [];
  const tech = a.tech || [];
  let html =
    '<div class="ah-row">' +
      '<span class="ah-color" style="background:' + color + '">' + esc((a.name || '?')[0]) + '</span>' +
      '<div class="ah-main">' +
        '<div class="ah-name">' + esc(a.name) +
          (a.tool ? ' <span class="tool-tag">' + esc(a.tool) + '</span>' : '') +
          '<span class="dot ' + (a.online ? 'on' : 'off') + '"></span>' +
          '<span class="ah-status">' + esc(agentStatusText(a)) + '</span>' +
        '</div>' +
        '<div class="ah-desc">' + esc(a.project || '') + (a.description ? ' · ' + esc(a.description) : '') + '</div>' +
        '<div class="ah-tags">' +
          (caps.length ? caps.map((c) => '<span class="cap">' + esc(c) + '</span>').join('') : '') +
          (tech.length ? tech.map((t) => '<span class="tech">' + esc(t) + '</span>').join('') : '') +
        '</div>' +
      '</div>' +
    '</div>';
  html += '<div class="ah-stats">' +
    `<span class="ah-stat"><i style="background:${STATUS_COLOR.todo}"></i>待办 <b>${ts.todo || 0}</b></span>` +
    `<span class="ah-stat"><i style="background:${STATUS_COLOR.doing}"></i>进行中 <b>${ts.doing || 0}</b></span>` +
    `<span class="ah-stat"><i style="background:${STATUS_COLOR.blocked}"></i>阻塞 <b>${ts.blocked || 0}</b></span>` +
    `<span class="ah-stat"><i style="background:${STATUS_COLOR.done}"></i>完成 <b>${ts.done || 0}</b></span>` +
    `<span class="ah-stat">文档 <b>${a.docCount || 0}</b></span>` +
    '</div>';
  box.innerHTML = html;
}

async function loadAgentDetail(id) {
  try {
    const d = await api('/api/v1/agents/' + encodeURIComponent(id));
    state.agentDetail = d;
    renderAgentHead();
  } catch (e) { /* 忽略 */ }
}

async function loadAgentMessages() {
  if (!state.selected) return;
  state.agentTab = 'messages';
  try {
    const res = await api('/api/v1/messages?account=' + encodeURIComponent(state.selected));
    state.agentMessages = asList(res);
  } catch (e) { state.agentMessages = []; }
  const box = $('#agent-messages');
  renderMessageList(box, state.agentMessages);
}

async function loadAgentDocs() {
  if (!state.selected) return;
  state.agentTab = 'docs';
  try {
    const res = await api('/api/v1/documents?account=' + encodeURIComponent(state.selected));
    state.agentDocs = asList(res);
  } catch (e) { state.agentDocs = []; }
  renderAgentDocs();
}

function renderAgentDocs() {
  const box = $('#agent-docs');
  if (!box) return;
  box.innerHTML = '';
  if (!state.agentDocs.length) { box.innerHTML = '<div class="empty">该账号暂无文档</div>'; return; }
  const list = document.createElement('div');
  list.className = 'doc-list';
  state.agentDocs.forEach((d) => list.appendChild(docRow(d)));
  box.appendChild(list);
}

async function loadAgentMemory() {
  if (!state.selected) return;
  state.agentTab = 'memory';
  const acc = encodeURIComponent(state.selected);
  try {
    const [mem, versions] = await Promise.all([
      api('/api/v1/memory?account=' + acc),
      api('/api/v1/memory/versions?account=' + acc),
    ]);
    state.agentMemory = mem;
    state.agentVersions = asList(versions);
  } catch (e) {
    state.agentMemory = null;
    state.agentVersions = [];
  }
  renderAgentMemory();
}

function renderAgentMemory() {
  const box = $('#agent-memory');
  if (!box) return;
  const mem = state.agentMemory;
  const versions = state.agentVersions || [];
  const content = mem ? (mem.content || '') : '';
  const version = mem ? mem.version : 0;
  let html = '';
  if (content) {
    html += '<div class="memory-md">' + renderMarkdown(content) + '</div>';
  } else {
    html += '<div class="empty">该账号尚未维护记忆（memory.md 为空）。建议其 agent 在会话结束时用 <code>a2a memory set</code> 写回「进展、决策、待办、协作关系」。</div>';
  }
  html += '<div class="memory-versions"><span class="k">版本历史（当前 v' + version + '）</span>';
  if (!versions.length) html += '<div class="empty">暂无历史版本</div>';
  else {
    versions.forEach((v, i) => {
      html += '<button class="version-item" data-idx="' + i + '">' +
        '<span class="v-num">v' + v.version + '</span>' +
        '<span class="v-note">' + esc(v.note || '（无说明）') + '</span>' +
        '<span class="time">' + formatDateTime(v.updatedAt) + '</span>' +
        '</button>';
    });
  }
  html += '</div><div id="memory-diff"></div>';
  box.innerHTML = html;
  $$('.version-item', box).forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.idx);
      showMemoryDiff(versions[idx + 1], versions[idx]);
    });
  });
}

function showMemoryDiff(prev, cur) {
  const box = $('#memory-diff');
  if (!box || !cur) return;
  const rows = lineDiff(prev ? (prev.content || '') : '', cur.content || '');
  let html = '<div class="diff-head">v' + (prev ? prev.version : 0) + ' → v' + cur.version + '</div><div class="diff">';
  if (!rows.length) html += '<div class="empty">无差异</div>';
  rows.forEach((r) => {
    if (r.t === 'same') html += '<div class="d-same">  ' + esc(r.l) + '</div>';
    else if (r.t === 'add') html += '<div class="d-add">+ ' + esc(r.l) + '</div>';
    else html += '<div class="d-del">- ' + esc(r.l) + '</div>';
  });
  html += '</div>';
  box.innerHTML = html;
}

/** 按行 LCS diff */
function lineDiff(aText, bText) {
  const A = String(aText).split('\n');
  const B = String(bText).split('\n');
  const n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const rows = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { rows.push({ t: 'same', l: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { rows.push({ t: 'del', l: A[i] }); i++; }
    else { rows.push({ t: 'add', l: B[j] }); j++; }
  }
  while (i < n) { rows.push({ t: 'del', l: A[i] }); i++; }
  while (j < m) { rows.push({ t: 'add', l: B[j] }); j++; }
  return rows;
}

/* ---------- 简易 Markdown 渲染（自写，输出已转义） ---------- */
function isSafeUrl(u) {
  const s = String(u).trim();
  if (/^https?:\/\//i.test(s)) return true;
  if (/^mailto:/i.test(s)) return true;
  if (s.startsWith('/') && !s.startsWith('//')) return true;
  if (s.startsWith('#') || s.startsWith('./') || s.startsWith('../')) return true;
  return false;
}

function renderInline(text) {
  const codes = [];
  text = text.replace(/`([^`]+)`/g, (m, c) => { codes.push(c); return '\u0000C' + (codes.length - 1) + '\u0000'; });
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t, u) => {
    return isSafeUrl(u) ? '<a href="' + u + '" target="_blank" rel="noopener">' + t + '</a>' : t;
  });
  text = text.replace(/\u0000C(\d+)\u0000/g, (m, i) => '<code>' + codes[Number(i)] + '</code>');
  return text;
}

function renderMarkdown(src) {
  if (!src) return '';
  const lines = String(src).split('\n');
  const out = [];
  const para = [];
  let list = null;
  const flushPara = () => {
    if (para.length) { out.push('<p>' + para.map(renderInline).join(' ') + '</p>'); para.length = 0; }
  };
  const flushList = () => {
    if (list) { out.push(list.ordered ? '</ol>' : '</ul>'); list = null; }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flushPara(); flushList();
      const code = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { code.push(lines[i]); i++; }
      i++;
      out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>');
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara(); flushList();
      const lvl = h[1].length;
      out.push('<h' + lvl + '>' + renderInline(esc(h[2])) + '</h' + lvl + '>');
      i++; continue;
    }
    if (/^\s*>\s?/.test(line)) {
      flushPara(); flushList();
      out.push('<blockquote>' + renderInline(esc(line.replace(/^\s*>\s?/, ''))) + '</blockquote>');
      i++; continue;
    }
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      flushPara();
      if (!list || list.ordered) { flushList(); list = { ordered: false }; out.push('<ul>'); }
      out.push('<li>' + renderInline(esc(ul[1])) + '</li>');
      i++; continue;
    }
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) {
      flushPara();
      if (!list || !list.ordered) { flushList(); list = { ordered: true }; out.push('<ol>'); }
      out.push('<li>' + renderInline(esc(ol[1])) + '</li>');
      i++; continue;
    }
    if (line.trim() === '') { flushPara(); flushList(); i++; continue; }
    flushList();
    para.push(esc(line));
    i++;
  }
  flushPara(); flushList();
  return out.join('\n');
}

/* =========================================================================
 * 通用组件：任务卡片 / 消息行 / 文档行 / 弹层
 * ========================================================================= */
function kanbanStatusLabel(status) {
  const c = KANBAN_COLS.find((x) => x[0] === status);
  return c ? c[1] : (status || '未知');
}

function priorityChip(p) {
  if (!p || p === 'normal') return '';
  return '<span class="prio prio-' + esc(p) + '">' + (PRIORITY_LABEL[p] || p) + '</span>';
}

function taskCard(t) {
  const card = document.createElement('div');
  card.className = 'task-card';
  card.dataset.id = t.id;
  const color = accountColor(t.accountId);
  card.innerHTML =
    '<div class="task-accent" style="background:' + color + '"></div>' +
    '<div class="task-title">' + esc(t.title) + '</div>' +
    '<div class="task-meta">' +
      '<span class="account-chip" style="color:' + color + '">' + esc(agentName(t.accountId)) + '</span>' +
      (t.assigneeId ? '<span class="assignee"> → ' + esc(agentName(t.assigneeId)) + '</span>' : '') +
    '</div>' +
    '<div class="task-foot">' +
      (t.sourceMessageId ? '<span class="src-msg">← 消息</span>' : '') +
      priorityChip(t.priority) +
      '<span class="time">' + relativeTime(t.updatedAt || t.createdAt) + '</span>' +
    '</div>';
  card.addEventListener('click', () => showTaskModal(t));
  return card;
}

function showTaskModal(t) {
  let html = '';
  html += '<div class="m-title">' + esc(t.title) + '</div>';
  html += '<div class="m-row"><span class="k">状态</span>' + esc(kanbanStatusLabel(t.status)) + '</div>';
  html += '<div class="m-row"><span class="k">优先级</span>' + esc(PRIORITY_LABEL[t.priority] || t.priority || '普通') + '</div>';
  html += '<div class="m-row"><span class="k">所属账号</span>' + esc(agentName(t.accountId)) + '</div>';
  if (t.assigneeId) html += '<div class="m-row"><span class="k">指派给</span>' + esc(agentName(t.assigneeId)) + '</div>';
  if (t.dueAt) html += '<div class="m-row"><span class="k">截止</span>' + formatDateTime(t.dueAt) + '</div>';
  if (t.sourceMessageId) html += '<div class="m-row"><span class="k">来源消息</span>' + esc(t.sourceMessageId) + '</div>';
  if (t.description) html += '<div class="m-block"><div class="k">描述</div><div class="m-text">' + esc(t.description) + '</div></div>';
  if (t.note) html += '<div class="m-block"><div class="k">说明</div><div class="m-text">' + esc(t.note) + '</div></div>';
  openModal('任务详情', html);
}

/** 计算每条消息的回复链深度（缩进用），带环保护 */
function messageDepthFn(allMsgs) {
  const map = new Map(allMsgs.map((m) => [m.id, m]));
  const memo = new Map();
  return function depth(m) {
    if (memo.has(m.id)) return memo.get(m.id);
    let d = 0;
    if (m.replyTo) {
      const seen = new Set([m.id]);
      let cur = map.get(m.replyTo);
      while (cur && !seen.has(cur.id)) {
        seen.add(cur.id);
        d++;
        cur = cur.replyTo ? map.get(cur.replyTo) : null;
      }
    }
    memo.set(m.id, d);
    return d;
  };
}

function messageRow(m, d) {
  const row = document.createElement('div');
  row.className = 'msg-row' + (d > 0 ? ' reply' : '');
  row.style.marginLeft = Math.min(d, 5) * 20 + 'px';
  const head = document.createElement('div');
  head.className = 'msg-head';
  head.innerHTML =
    '<span class="msg-route">' + esc(agentName(m.from)) + '<span class="arrow">→</span>' + esc(agentName(m.to)) + '</span>' +
    '<span class="msg-status st-' + esc(m.status) + '">' + esc(MSG_STATUS_LABEL[m.status] || m.status) + '</span>' +
    (m.needsReply ? '<span class="needs-reply">需回复</span>' : '') +
    '<span class="time">' + relativeTime(m.createdAt) + '</span>';
  row.appendChild(head);
  const subject = document.createElement('div');
  subject.className = 'msg-subject';
  subject.textContent = m.subject || '（无主题）';
  row.appendChild(subject);
  if (m.body) {
    const body = document.createElement('div');
    body.className = 'msg-body clamp';
    // 高亮 @账号/路径 引用
    body.innerHTML = esc(m.body).replace(/(@[\w\u4e00-\u9fa5.-]+\/[\w\u4e00-\u9fa5.\/\-() ]+)/g, '<span class="doc-ref">$1</span>');
    row.appendChild(body);
    const toggle = document.createElement('button');
    toggle.className = 'expand-btn';
    toggle.textContent = '展开';
    toggle.addEventListener('click', () => {
      const collapsed = body.classList.toggle('clamp');
      toggle.textContent = collapsed ? '展开' : '收起';
    });
    row.appendChild(toggle);
  }
  if (m.docIds && m.docIds.length) {
    const docs = document.createElement('div');
    docs.className = 'msg-docs';
    m.docIds.forEach((did) => {
      const a = document.createElement('a');
      a.className = 'doc-link';
      a.href = '#';
      a.textContent = '📄 ' + docName(did);
      a.addEventListener('click', (ev) => { ev.preventDefault(); openDocPreview(did); });
      docs.appendChild(a);
    });
    row.appendChild(docs);
  }
  return row;
}

function docName(id) {
  const d = state.documents.find((x) => x.id === id);
  return d ? d.name : id;
}

function docRow(d) {
  const row = document.createElement('div');
  row.className = 'doc-row';
  const nameBtn = document.createElement('button');
  nameBtn.className = 'doc-name';
  nameBtn.dataset.id = d.id;
  nameBtn.textContent = d.name;
  row.appendChild(nameBtn);
  if (d.description) {
    const desc = document.createElement('span');
    desc.className = 'doc-desc';
    desc.textContent = d.description;
    row.appendChild(desc);
  }
  const size = document.createElement('span');
  size.className = 'doc-size';
  size.textContent = formatSize(d.size);
  row.appendChild(size);
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = relativeTime(d.updatedAt || d.createdAt);
  row.appendChild(time);
  return row;
}

function isTextDoc(d) {
  const mime = (d.mime || '').toLowerCase();
  const name = (d.name || '').toLowerCase();
  return mime.startsWith('text/') || mime.includes('markdown') || mime.includes('json') ||
    /\.(md|txt|json|js|mjs|cjs|ts|py|yaml|yml|html|css|xml|csv|log|ini|conf|sh|sql|java|go|rb|c|h|cpp|toml|env|diff|patch)$/.test(name);
}

async function openDocPreview(id) {
  // 从全局文档列表或当前账号文档列表找
  const d = state.documents.find((x) => x.id === id) || state.agentDocs.find((x) => x.id === id);
  if (!d) {
    // 未加载到元数据：直接尝试抓取元数据
    try {
      const meta = await api('/api/v1/documents/' + encodeURIComponent(id));
      state.documents.push(meta);
      return openDocPreview(id);
    } catch (e) {
      return openModal('文档', '<div class="m-text muted">无法加载文档</div>');
    }
  }
  const downloadUrl = d.url || ('/api/v1/documents/' + encodeURIComponent(id) + '/content');
  if (!isTextDoc(d)) {
    openModal('文档 · ' + d.name,
      '<div class="m-text muted">该文件为二进制 / 非文本类型，请下载查看。</div>' +
      '<a class="btn-link" href="' + downloadUrl + '" download>下载文件</a>');
    return;
  }
  openModal('文档 · ' + d.name, '<div class="m-text muted">加载中…</div>');
  try {
    const text = await apiText('/api/v1/documents/' + encodeURIComponent(id) + '/content?inline=1');
    const isMd = /\.md$/i.test(d.name || '') || (d.mime || '').includes('markdown');
    const bodyHtml = isMd ? renderMarkdown(text) : ('<pre class="doc-pre">' + esc(text) + '</pre>');
    $('#modal-body').innerHTML = bodyHtml;
  } catch (e) {
    $('#modal-body').innerHTML = '<div class="m-text muted">加载失败，请下载查看。</div>' +
      '<a class="btn-link" href="' + downloadUrl + '" download>下载文件</a>';
  }
}

/* ---------- 弹层 ---------- */
function openModal(title, html) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = html;
  $('#modal').classList.remove('hidden');
}

function closeModal() {
  $('#modal').classList.add('hidden');
}

/* =========================================================================
 * SSE 实时刷新
 * ========================================================================= */
function connectSSE() {
  let es;
  try {
    es = new EventSource('/api/v1/events');
  } catch (e) {
    setConn(false);
    return;
  }
  ['message', 'task', 'doc', 'memory', 'presence'].forEach((t) => {
    es.addEventListener(t, (ev) => handleEvent(t, ev.data));
  });
  es.onopen = () => setConn(true);
  es.onerror = () => setConn(false);
}

function setConn(ok) {
  const el = $('#conn-ind');
  if (!el) return;
  el.textContent = ok ? '实时已连接' : '实时已断开';
  el.className = 'conn ' + (ok ? 'on' : 'off');
}

async function handleEvent(type, data) {
  let evt = null;
  try { evt = JSON.parse(data); } catch (e) { evt = null; }
  const accountOf = evt && evt.accountId;
  switch (type) {
    case 'message':
      await Promise.all([loadFeedMessages(), loadAllDocuments()]);
      if (state.view === 'agent' && state.agentTab === 'messages' && (!accountOf || accountOf === state.selected)) loadAgentMessages();
      loadSummary();
      break;
    case 'task':
      loadTasks();
      if (state.view === 'agent' && accountOf === state.selected) { loadAgentMessages(); }
      break;
    case 'doc':
      await loadAllDocuments();
      if (state.view === 'agent' && state.agentTab === 'docs' && accountOf === state.selected) loadAgentDocs();
      break;
    case 'memory':
      if (state.view === 'agent' && state.agentTab === 'memory' && accountOf === state.selected) loadAgentMemory();
      break;
    case 'presence':
      loadSummary();
      loadAgents();
      break;
    default:
      break;
  }
  renderTopBar();
}

/* =========================================================================
 * 事件绑定与初始化
 * ========================================================================= */
function bindEvents() {
  // 全局卡片 → 全局视图
  const gc = $('#global-card');
  gc.addEventListener('click', selectGlobal);
  gc.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectGlobal(); } });

  // 全局视图 tabs
  $$('.tab[data-gtab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.globalTab = btn.dataset.gtab;
      $$('.tab[data-gtab]').forEach((b) => b.classList.toggle('active', b === btn));
      $('#global-kanban').classList.toggle('hidden', state.globalTab !== 'kanban');
      $('#global-feed').classList.toggle('hidden', state.globalTab !== 'feed');
      if (state.globalTab === 'kanban') renderGlobalKanban();
      else renderGlobalFeed();
    });
  });

  // Agent 视图 tabs
  $$('.tab[data-atab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.atab;
      $$('.tab[data-atab]').forEach((b) => b.classList.toggle('active', b === btn));
      $('#agent-messages').classList.toggle('hidden', tab !== 'messages');
      $('#agent-docs').classList.toggle('hidden', tab !== 'docs');
      $('#agent-memory').classList.toggle('hidden', tab !== 'memory');
      if (tab === 'messages') loadAgentMessages();
      else if (tab === 'docs') loadAgentDocs();
      else loadAgentMemory();
    });
  });

  // 消息筛选（事件委托：全局 feed / agent messages 里的 .filter）
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.filter');
    if (!btn) return;
    state.msgFilter = btn.dataset.f;
    const box = btn.closest('.messages, #global-feed');
    if (box) {
      $$('.filter', box).forEach((b) => b.classList.toggle('active', b === btn));
      if (state.view === 'agent') renderMessageList($('#agent-messages'), state.agentMessages);
      else renderMessageList($('#global-feed'), state.feedMessages);
    }
  });

  // 弹层
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
}

async function init() {
  bindEvents();
  await Promise.allSettled([
    loadSummary(),
    loadAgents(),
    loadTasks(),
    loadFeedMessages(),
    loadAllDocuments(),
  ]);
  selectGlobal();
  connectSSE();
  // 兜底轮询：SSE 断线时页面仍可用
  setInterval(() => { loadSummary().catch(() => {}); }, 10000);
}

document.addEventListener('DOMContentLoaded', init);
