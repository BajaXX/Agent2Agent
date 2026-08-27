'use strict';

/* =========================================================================
 * Agent2Agent 人类看板（只读，原生 JS，无外部依赖）
 * 数据契约见 docs/api.md；本文件不猜测字段名，严格按契约渲染。
 * 布局：顶栏 + 左栏 Agent 列表 + 主区 Tabs（看板/消息/文档/记忆）。
 * ========================================================================= */

/* ---------- 工具函数 ---------- */
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

/** HTML 转义（所有用户内容渲染前必须转义） */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 相对时间：x分钟前 / x小时前 / x天前 */
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

/* ---------- 全局状态 ---------- */
const state = {
  agents: [],           // GET /agents 或 /summary.agents
  summary: null,        // GET /summary
  tasks: [],            // GET /tasks（数组）
  messages: [],         // GET /messages（items）
  documents: [],        // GET /documents（数组）
  agentDetail: {},      // GET /agents/:id 缓存
  expanded: new Set(),  // 左栏展开的 agent id
  activeTab: 'kanban',
  msgFilter: 'all',
  memoryAccount: null,
  memory: null,
  memoryVersions: [],
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

/** 兼容「裸数组」与「{ items / tasks / documents / messages }」两种列表形状 */
function asList(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    if (Array.isArray(data.items)) return data.items;
    if (Array.isArray(data.tasks)) return data.tasks;
    if (Array.isArray(data.documents)) return data.documents;
    if (Array.isArray(data.messages)) return data.messages;
  }
  return [];
}

/* ---------- 数据加载 ---------- */
async function loadSummary() {
  try {
    const s = await api('/api/v1/summary');
    state.summary = s;
    mergePresence(s && s.agents);
  } catch (e) {
    state.summary = null;
  }
  renderTopBar();
  if (state.agents.length) renderAgentList();
}

async function loadAgents() {
  try {
    state.agents = asList(await api('/api/v1/agents'));
  } catch (e) {
    state.agents = [];
  }
  renderAgentList();
}

async function loadTasks() {
  try {
    state.tasks = asList(await api('/api/v1/tasks'));
  } catch (e) {
    state.tasks = [];
  }
  renderKanban();
}

async function loadMessages() {
  try {
    const data = await api('/api/v1/messages');
    state.messages = asList(data);
  } catch (e) {
    state.messages = [];
  }
  renderMessages();
}

async function loadDocuments() {
  try {
    state.documents = asList(await api('/api/v1/documents'));
  } catch (e) {
    state.documents = [];
  }
  renderDocuments();
}

/** 用 /summary.agents 的在线信息刷新 /agents 列表的在线状态 */
function mergePresence(summaryAgents) {
  if (!Array.isArray(summaryAgents) || !state.agents.length) return;
  const m = new Map(summaryAgents.map((a) => [a.id, a]));
  state.agents.forEach((a) => {
    const s = m.get(a.id);
    if (s) {
      a.online = s.online;
      a.status = s.status;
      a.lastSeen = s.lastSeen;
      a.note = s.note;
    }
  });
}

/* ---------- 顶栏 ---------- */
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

/* ---------- 名称解析 ---------- */
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

/* ---------- 左栏 Agent 列表 ---------- */
function renderAgentList() {
  const list = $('#agent-list');
  list.innerHTML = '';
  if (!state.agents.length) {
    list.innerHTML = '<div class="empty">暂无 Agent</div>';
    return;
  }
  state.agents.forEach((agent) => {
    const item = document.createElement('div');
    item.className = 'agent-item';

    const row = document.createElement('div');
    row.className = 'agent-row';
    row.dataset.id = agent.id;

    const dot = document.createElement('span');
    dot.className = 'dot ' + (agent.online ? 'on' : 'off');
    row.appendChild(dot);

    const main = document.createElement('div');
    main.className = 'agent-main';
    main.innerHTML =
      '<div class="agent-name">' + esc(agent.name) +
      (agent.tool ? ' <span class="tool-tag">' + esc(agent.tool) + '</span>' : '') +
      '</div><div class="agent-sub">' + esc(agentStatusText(agent)) + '</div>';
    row.appendChild(main);

    item.appendChild(row);

    const detail = document.createElement('div');
    detail.className = 'agent-detail hidden';
    detail.dataset.detail = agent.id;
    item.appendChild(detail);

    list.appendChild(item);

    if (state.expanded.has(agent.id)) {
      detail.classList.remove('hidden');
      renderAgentDetail(agent.id, detail);
    }
  });
}

function findDetailEl(id) {
  return Array.from(document.querySelectorAll('.agent-detail')).find((el) => el.dataset.detail === id);
}

function renderAgentDetail(id, container) {
  const base = state.agents.find((a) => a.id === id);
  const d = state.agentDetail[id] || base;
  if (!d) return;
  const ts = d.taskStats || {};
  const caps = d.capabilities || [];
  const tech = d.tech || [];
  let html = '';
  html += '<div class="detail-desc">' + (d.description ? esc(d.description) : '（无描述）') + '</div>';
  html += '<div class="detail-line"><span class="k">能力</span>' + (caps.length ? caps.map(esc).join('、') : '—') + '</div>';
  html += '<div class="detail-line"><span class="k">技术栈</span>' + (tech.length ? tech.map(esc).join('、') : '—') + '</div>';
  html += '<div class="detail-line"><span class="k">文档</span>' + (d.docCount || 0) + ' 篇</div>';
  html += '<div class="detail-line"><span class="k">任务</span>待办 ' + (ts.todo || 0) +
    ' · 进行中 ' + (ts.doing || 0) + ' · 阻塞 ' + (ts.blocked || 0) + ' · 完成 ' + (ts.done || 0) + '</div>';
  const events = d.recentEvents;
  if (events && events.length) {
    html += '<div class="detail-events"><span class="k">最近动态</span>';
    html += events.slice(0, 10).map((ev) => {
      const summary = ev.payload && ev.payload.summary ? ev.payload.summary : '';
      return '<div class="event-row">' +
        '<span class="event-type">' + esc(EVENT_TYPE_LABEL[ev.type] || ev.type) + '</span>' +
        '<span class="event-summary">' + esc(summary) + '</span>' +
        '<span class="event-time">' + relativeTime(ev.createdAt) + '</span>' +
        '</div>';
    }).join('');
    html += '</div>';
  }
  container.innerHTML = html;
}

async function fetchAgentDetail(id) {
  try {
    const d = await api('/api/v1/agents/' + encodeURIComponent(id));
    state.agentDetail[id] = d;
    const detail = findDetailEl(id);
    if (detail && !detail.classList.contains('hidden')) renderAgentDetail(id, detail);
  } catch (e) { /* 忽略，保持基础信息展示 */ }
}

/* ---------- 全局看板 ---------- */
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
  return card;
}

function renderKanban() {
  const kb = $('#kanban');
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
    if (!tasks.length) {
      body.innerHTML = '<div class="empty">暂无任务</div>';
    } else {
      tasks.forEach((t) => body.appendChild(taskCard(t)));
    }
    col.appendChild(body);
    kb.appendChild(col);
  });
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
  if (t.note) html += '<div class="m-block"><div class="k">完成说明</div><div class="m-text">' + esc(t.note) + '</div></div>';
  openModal('任务详情', html);
}

/* ---------- 消息流水 ---------- */
function msgFilterPredicate(m) {
  if (state.msgFilter === 'reply') return m.needsReply && m.status !== 'resolved';
  if (state.msgFilter === 'unread') return m.status === 'unread';
  return true;
}

/** 计算每条消息的回复链深度（缩进用），带环保护 */
function messageDepthFn() {
  const map = new Map(state.messages.map((m) => [m.id, m]));
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
    body.textContent = m.body;
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

function renderMessages() {
  const box = $('#messages');
  const msgs = state.messages
    .filter(msgFilterPredicate)
    .slice()
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  box.innerHTML = '';
  if (!msgs.length) {
    box.innerHTML = '<div class="empty">暂无消息</div>';
    return;
  }
  const depth = messageDepthFn();
  msgs.forEach((m) => box.appendChild(messageRow(m, depth(m))));
}

/* ---------- 文档 ---------- */
function docName(id) {
  const d = state.documents.find((x) => x.id === id);
  return d ? d.name : id;
}

function renderDocuments() {
  const box = $('#docs');
  box.innerHTML = '';
  if (!state.documents.length) {
    box.innerHTML = '<div class="empty">暂无文档</div>';
    return;
  }
  const groups = new Map();
  state.documents.forEach((d) => {
    const key = d.accountId || '未分组';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(d);
  });
  Array.from(groups.keys()).sort().forEach((key) => {
    const sec = document.createElement('div');
    sec.className = 'doc-group';
    const head = document.createElement('div');
    head.className = 'doc-group-head';
    head.innerHTML =
      '<span class="account-chip" style="color:' + accountColor(key) + '">' + esc(agentName(key)) + '</span>' +
      '<span class="count">' + groups.get(key).length + ' 个文件</span>';
    sec.appendChild(head);
    const list = document.createElement('div');
    list.className = 'doc-list';
    groups.get(key).forEach((d) => list.appendChild(docRow(d)));
    sec.appendChild(list);
    box.appendChild(sec);
  });
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
  const d = state.documents.find((x) => x.id === id);
  if (!d) return;
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
    $('#modal-body').innerHTML =
      '<div class="m-text">预览失败，请下载查看。</div>' +
      '<a class="btn-link" href="' + downloadUrl + '" download>下载文件</a>';
  }
}

/* ---------- 记忆 ---------- */
function renderMemoryTab() {
  const accounts = $('#memory-accounts');
  accounts.innerHTML = '';
  if (!state.agents.length) {
    accounts.innerHTML = '<div class="empty">暂无账号</div>';
  }
  state.agents.forEach((a) => {
    const btn = document.createElement('button');
    btn.className = 'memory-account' + (state.memoryAccount === a.id ? ' active' : '');
    btn.dataset.id = a.id;
    btn.innerHTML = '<span class="dot ' + (a.online ? 'on' : 'off') + '"></span>' + esc(a.name);
    btn.addEventListener('click', () => {
      state.memoryAccount = a.id;
      renderMemoryTab(); // 末尾会自动 loadMemory 当前账号
    });
    accounts.appendChild(btn);
  });
  if (state.memoryAccount) loadMemory(state.memoryAccount);
  else clearMemory();
}

async function loadMemory(accountId) {
  try {
    const [mem, versions] = await Promise.all([
      api('/api/v1/memory?account=' + encodeURIComponent(accountId)),
      api('/api/v1/memory/versions?account=' + encodeURIComponent(accountId)),
    ]);
    state.memory = mem;
    state.memoryVersions = asList(versions);
    renderMemoryContent(accountId);
  } catch (e) {
    $('#memory').innerHTML = '<div class="empty">无法加载记忆</div>';
  }
}

function clearMemory() {
  state.memory = null;
  state.memoryVersions = [];
  $('#memory').innerHTML = '<div class="empty">请选择左侧账号查看记忆</div>';
}

function renderMemoryContent(accountId) {
  const box = $('#memory');
  const mem = state.memory;
  const versions = state.memoryVersions || [];
  const content = mem ? mem.content : '';
  const version = mem ? mem.version : 0;
  let html = '';
  html += '<div class="memory-head"><h3>' + esc(agentName(accountId)) + ' 的记忆</h3>' +
    '<span class="ver">版本 v' + version + '</span></div>';
  if (content) {
    html += '<div class="memory-md">' + renderMarkdown(content) + '</div>';
  } else {
    html += '<div class="empty">（暂无记忆内容）</div>';
  }
  html += '<div class="memory-versions"><span class="k">版本历史</span>';
  if (!versions.length) {
    html += '<div class="empty">暂无历史版本</div>';
  } else {
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

/** 行级 diff：上一版本 → 选中版本，高亮增删行 */
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

/** 行内渲染：输入已转义文本，输出安全 HTML */
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
  let list = null; // { ordered: boolean }
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
      i++; // 跳过结束 ```
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

/* ---------- 弹层 ---------- */
function openModal(title, html) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = html;
  $('#modal').classList.remove('hidden');
}

function closeModal() {
  $('#modal').classList.add('hidden');
}

/* ---------- SSE 实时刷新 ---------- */
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

function handleEvent(type, data) {
  let evt = null;
  try { evt = JSON.parse(data); } catch (e) { evt = null; }
  switch (type) {
    case 'message':
      loadMessages();
      loadSummary();
      break;
    case 'task':
      loadTasks();
      loadSummary();
      break;
    case 'doc':
      loadDocuments();
      break;
    case 'memory':
      if (state.activeTab === 'memory' && state.memoryAccount &&
          (!evt || !evt.accountId || evt.accountId === state.memoryAccount)) {
        loadMemory(state.memoryAccount);
      }
      break;
    case 'presence':
      loadAgents();
      loadSummary();
      break;
    default:
      break;
  }
}

/* ---------- 事件绑定 ---------- */
function bindEvents() {
  // Tabs
  $$('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      state.activeTab = tab;
      $$('.tab').forEach((b) => b.classList.toggle('active', b === btn));
      $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + tab));
      if (tab === 'memory') renderMemoryTab();
    });
  });

  // 消息筛选
  $$('.filter').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.msgFilter = btn.dataset.filter;
      $$('.filter').forEach((b) => b.classList.toggle('active', b === btn));
      renderMessages();
    });
  });

  // Agent 列表展开/收起（事件委托）
  $('#agent-list').addEventListener('click', (e) => {
    const row = e.target.closest('.agent-row');
    if (!row) return;
    const id = row.dataset.id;
    const detail = row.parentElement.querySelector('.agent-detail');
    if (state.expanded.has(id)) {
      state.expanded.delete(id);
      detail.classList.add('hidden');
    } else {
      state.expanded.add(id);
      detail.classList.remove('hidden');
      renderAgentDetail(id, detail);
      fetchAgentDetail(id);
    }
  });

  // 看板卡片点击
  $('#kanban').addEventListener('click', (e) => {
    const card = e.target.closest('.task-card');
    if (!card) return;
    const t = state.tasks.find((x) => x.id === card.dataset.id);
    if (t) showTaskModal(t);
  });

  // 文档点击
  $('#docs').addEventListener('click', (e) => {
    const btn = e.target.closest('.doc-name');
    if (!btn) return;
    e.preventDefault();
    openDocPreview(btn.dataset.id);
  });

  // 弹层
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
}

/* ---------- 初始化 ---------- */
async function init() {
  bindEvents();
  await Promise.allSettled([
    loadSummary(),
    loadAgents(),
    loadTasks(),
    loadMessages(),
    loadDocuments(),
  ]);
  connectSSE();
  // 兜底轮询：SSE 断线时页面仍可用
  setInterval(() => { loadSummary().catch(() => {}); }, 10000);
}

document.addEventListener('DOMContentLoaded', init);
