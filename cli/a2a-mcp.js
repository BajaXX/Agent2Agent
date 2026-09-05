#!/usr/bin/env node
/**
 * Agent2Agent MCP Server（`a2a-mcp`）
 *
 * Model Context Protocol (stdio transport) 服务，把 a2a 平台的操作为结构化工具暴露给
 * 支持 MCP 的 agent 客户端（Claude Code / Cursor / Windsurf / dsh[启用了 MCP 插件] 等）。
 *
 * - 零第三方依赖：MCP stdio 即"换行分隔的 JSON-RPC 2.0"，用内置模块实现。
 * - 账号配置复用 CLI：从运行目录向上查找 `.a2a.json`（url/token/accountId），
 *   也可用环境变量 A2A_URL / A2A_TOKEN / A2A_ACCOUNT 覆盖。
 * - 所有工具都是对平台 REST API（/api/v1）的薄封装，返回结构化 JSON。
 *
 * 接入示例（项目目录内启动）：
 *   Claude Code : claude mcp add a2a -- node /path/to/a2a-mcp.js
 *   Cursor       : .cursor/mcp.json -> { "servers": { "a2a": { "command": "a2a-mcp" } } }
 *   Windsurf     : 设置 -> MCP -> 添加 stdio server，command = a2a-mcp
 *
 * 说明：本 MCP 是「操作层」通道（怎么调）；「何时调用 / 人类确认原则 / 任务工作流」
 * 等流程规范仍由 skills（SKILL.md / rules）承载，两通道规范一致。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const VERSION = '0.3.6';
const PROTOCOL_VERSION = '2024-11-05'; // MCP 当前稳定协议版本

/* ------------------------------------------------------------------ *
 * 配置与 HTTP 调用（与 CLI 同一套语义）
 * ------------------------------------------------------------------ */

function findConfig(startDir) {
  let dir = startDir || process.cwd();
  while (dir && dir !== path.parse(dir).root) {
    const f = path.join(dir, '.a2a.json');
    if (fs.existsSync(f)) {
      try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; }
    }
    dir = path.dirname(dir);
  }
  return null;
}

function resolveConfig() {
  const cfg = findConfig(process.cwd());
  return {
    url: process.env.A2A_URL || (cfg && cfg.url) || '',
    accountId: process.env.A2A_ACCOUNT || (cfg && cfg.accountId) || '',
    token: process.env.A2A_TOKEN || (cfg && cfg.token) || '',
  };
}

async function api(config, method, pathName, { query, body } = {}) {
  let url = String(config.url || '').replace(/\/+$/, '') + '/api/v1' + pathName;
  if (query) {
    const qs = new URLSearchParams(
      Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '')
    ).toString();
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
  }
  const headers = { Accept: 'application/json' };
  if (config.token) headers.Authorization = 'Bearer ' + config.token;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { data = text; }
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) ? data.error.message : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
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

/* ------------------------------------------------------------------ *
 * @账号/路径 引用解析
 * ------------------------------------------------------------------ */
async function resolveRef(config, ref) {
  // "@A项目开发/docs/x.md" 或 "A项目开发/docs/x.md" → 文档对象
  const clean = String(ref || '').replace(/^@/, '');
  const parts = clean.split('/');
  if (parts.length < 2) return null;
  const account = parts.shift();
  const name = parts.join('/');
  const list = asList(await api(config, 'GET', '/documents', { query: { account, name } }));
  return list.length ? list[0] : null;
}

/* ------------------------------------------------------------------ *
 * 工具定义
 * ------------------------------------------------------------------ */
const TOOLS = [
  {
    name: 'check_in',
    description: '启动报到（等价 CLI a2a checkin 的核心）：标记在线、拉取收件箱（自动已读）、待办任务、记忆摘要。agent 会话开始时调用一次。返回 { pending, memory, inbox, tasks, platformVersion }。',
    inputSchema: { type: 'object', properties: { since: { type: 'number', description: '增量游标（毫秒时间戳），省略拉全部' } } },
  },
  {
    name: 'list_messages',
    description: '收件箱/发件箱列表。dir=in 看发给我的（拉取后平台自动标已读）；dir=out 看我发出的。结果含 status 与 needsReply（"需你回复"= needsReply 且未 resolved）。',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string', enum: ['in', 'out'], description: 'in=收件箱 out=发件箱（缺省 in）' },
        status: { type: 'string', enum: ['unread', 'read', 'processing', 'resolved'], description: '按状态过滤' },
        limit: { type: 'number', description: '条数上限' },
      },
    },
  },
  {
    name: 'send_message',
    description: '发送消息给另一个账号。to 为目标账号名。涉及文档引用时把 docIds/ref 填上。发送需求类消息建议 needsReply=true（对方看板会显示等待回复）。',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '目标账号（如 B项目开发）' },
        subject: { type: 'string' },
        body: { type: 'string', description: '正文；引用文档写 @账号/路径/文件.md' },
        needsReply: { type: 'boolean', description: '是否需要对方回复（需求/提问类=true）' },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
        docIds: { type: 'array', items: { type: 'string' }, description: '已上传文档 id 列表' },
      },
      required: ['to', 'subject'],
    },
  },
  {
    name: 'reply_message',
    description: '回复消息（仅收件方可回）。回复后原消息自动标记 read；若对方需要回复，请随后调用 mark_message 置 resolved 结束该轮。回复内容给结论 + 依据（可引文档）。',
    inputSchema: {
      type: 'object',
      properties: {
        messageId: { type: 'string' },
        body: { type: 'string' },
        docIds: { type: 'array', items: { type: 'string' } },
      },
      required: ['messageId', 'body'],
    },
  },
  {
    name: 'mark_message',
    description: '标记消息状态（仅收件方可）。处理完带 needsReply 的消息后置 resolved（告诉对方已解决）；开始处理可置 processing。',
    inputSchema: {
      type: 'object',
      properties: {
        messageId: { type: 'string' },
        status: { type: 'string', enum: ['unread', 'read', 'processing', 'resolved'] },
      },
      required: ['messageId', 'status'],
    },
  },
  {
    name: 'list_agents',
    description: '平台目录：所有账号及在线状态、任务统计、发给我的未读/待回复计数（unreadCount / needsReplyCount）。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'create_task',
    description: '在自己的任务工作表上建任务。接到需求后按流程判断：全新需求用本工具建任务（sourceMessageId 关联来源消息）；已有任务延续请用 update_task，勿重复建。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        assigneeId: { type: 'string', description: '需要他人配合时指派（任务仍挂你名下）' },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
        sourceMessageId: { type: 'string', description: '来源消息 id（看板显示 ← 消息）' },
        dueAt: { type: 'number' },
      },
      required: ['title'],
    },
  },
  {
    name: 'list_tasks',
    description: '任务列表。account 缺省返回自己的任务；status 过滤。任务是你的工作表：todo/doing/blocked/done，updatedAt 可用于判断滞留（>24h 的 doing 请评估是否 blocked）。',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: '账号（缺省自己）' },
        status: { type: 'string', enum: ['todo', 'doing', 'blocked', 'done'] },
      },
    },
  },
  {
    name: 'update_task',
    description: '推进任务状态（自己工作表）。doing(开始) → done(完成，附 note 说明)；依赖他人/人类介入超过 24h → blocked 并 note 写明原因；解除后转回 doing。',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        status: { type: 'string', enum: ['todo', 'doing', 'blocked', 'done'] },
        note: { type: 'string', description: '完成说明 / 阻塞原因' },
        assigneeId: { type: 'string' },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'list_documents',
    description: '文档列表。account 缺省列出全部（含他人公开文档）；给定 account 查看该账号全部文档。文档在平台全员公开只读。',
    inputSchema: {
      type: 'object',
      properties: { account: { type: 'string', description: '查看某账号的全部文档' } },
    },
  },
  {
    name: 'view_document',
    description: '按 @引用 或文档 id 查看任意账号的公开文档内容（只读，不能修改）。ref 形如 @B项目开发/docs/api.md 或 B项目开发/docs/api.md。',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: '@账号/路径/文件.md 或文档 id' },
        id: { type: 'string', description: '或直接传文档 id（与 ref 二选一）' },
      },
    },
  },
  {
    name: 'get_memory',
    description: '读取记忆（当前账号或指定账号的 memory.md）与版本号。会话开始可调用载入上下文；version 用于 update_memory 的乐观锁。',
    inputSchema: {
      type: 'object',
      properties: { account: { type: 'string', description: '账号（缺省自己）' } },
    },
  },
  {
    name: 'update_memory',
    description: '更新记忆（仅自己的）。content 为完整 memory.md 文本，version 必须来自最新 get_memory（乐观锁）；冲突(409)时重新 get 合并。建议会话结束/里程碑时写，避免噪音版本。',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string' },
        version: { type: 'number', description: '当前版本号（先 get_memory 获取）' },
        note: { type: 'string' },
      },
      required: ['content', 'version'],
    },
  },
];

/* ------------------------------------------------------------------ *
 * 工具执行
 * ------------------------------------------------------------------ */
async function callTool(config, name, args) {
  const a = args || {};
  switch (name) {
    case 'check_in': {
      const r = await api(config, 'GET', '/checkin', { query: { since: a.since || 0 } });
      return {
        account: r.account, platformVersion: r.platformVersion,
        pending: r.pending, memory: r.memory,
        inbox: r.inbox, tasks: r.tasks,
        note: '收件箱消息已自动标为已读；带 needsReply 且未 resolved 的为「需你回复」，处理完请 mark_message 置 resolved。',
      };
    }
    case 'list_messages': {
      const dir = a.dir || 'in';
      const r = await api(config, 'GET', '/messages', { query: { dir, status: a.status, limit: a.limit } });
      return { items: r.items || [] };
    }
    case 'send_message': {
      const body = {
        to: a.to, subject: a.subject, body: a.body || '',
        needsReply: !!a.needsReply, priority: a.priority || 'normal', docIds: a.docIds || [],
      };
      const r = await api(config, 'POST', '/messages', { body });
      return r;
    }
    case 'reply_message': {
      const r = await api(config, 'POST', `/messages/${a.messageId}/reply`, {
        body: { body: a.body, docIds: a.docIds || [] },
      });
      return { ...r, tip: '如需结束本轮，请 mark_message 将原消息置 resolved' };
    }
    case 'mark_message': {
      return api(config, 'POST', `/messages/${a.messageId}/status`, { body: { status: a.status } });
    }
    case 'list_agents': {
      const list = asList(await api(config, 'GET', '/agents'));
      return {
        items: list.map((x) => ({
          id: x.id, tool: x.tool, description: x.description,
          online: x.online, status: x.status, lastSeen: x.lastSeen,
          unreadCount: x.unreadCount || 0, needsReplyCount: x.needsReplyCount || 0,
          docCount: x.docCount, taskStats: x.taskStats,
        })),
      };
    }
    case 'create_task': {
      const r = await api(config, 'POST', '/tasks', {
        body: {
          title: a.title, description: a.description || '',
          assigneeId: a.assigneeId, priority: a.priority || 'normal',
          sourceMessageId: a.sourceMessageId, dueAt: a.dueAt,
        },
      });
      return r;
    }
    case 'list_tasks': {
      return { items: asList(await api(config, 'GET', '/tasks', { query: { account: a.account, status: a.status } })) };
    }
    case 'update_task': {
      const body = {};
      if (a.status) body.status = a.status;
      if (a.note !== undefined) body.note = a.note;
      if (a.assigneeId) body.assigneeId = a.assigneeId;
      return api(config, 'PATCH', `/tasks/${a.taskId}`, { body });
    }
    case 'list_documents': {
      const q = a.account ? { account: a.account } : undefined;
      return { items: asList(await api(config, 'GET', '/documents', { query: q })) };
    }
    case 'view_document': {
      let doc = null;
      if (a.id) {
        doc = await api(config, 'GET', `/documents/${a.id}`);
      } else if (a.ref) {
        doc = await resolveRef(config, a.ref);
        if (!doc) throw new Error(`未找到文档 ${a.ref}`);
      } else {
        throw new Error('需要 ref（@账号/路径/文件.md）或 id');
      }
      const text = await apiText(config, `/documents/${doc.id}/content?inline=1`);
      return { document: { id: doc.id, accountId: doc.accountId, name: doc.name, description: doc.description, size: doc.size }, content: text };
    }
    case 'get_memory': {
      const q = a.account ? { account: a.account } : undefined;
      return api(config, 'GET', '/memory', { query: q });
    }
    case 'update_memory': {
      return api(config, 'PUT', '/memory', { body: { content: a.content, version: a.version, note: a.note } });
    }
    default:
      throw new Error(`未知工具: ${name}`);
  }
}

async function apiText(config, pathName) {
  let url = String(config.url || '').replace(/\/+$/, '') + '/api/v1' + pathName;
  const headers = {};
  if (config.token) headers.Authorization = 'Bearer ' + config.token;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/* ------------------------------------------------------------------ *
 * MCP stdio 传输（换行分隔 JSON-RPC 2.0）
 * ------------------------------------------------------------------ */
// 兼容的 MCP 协议版本（Cursor 可能请求较新版本，回显客户端请求值）
const KNOWN_PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18'];

/* 崩溃兜底：任何未捕获异常/拒绝都打印真实堆栈到 stderr（Cursor 会显示出来），便于定位 */
process.on('uncaughtException', (err) => {
  console.error('[a2a-mcp] uncaughtException:', err && err.stack ? err.stack : err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('[a2a-mcp] unhandledRejection:', err && err.stack ? err.stack : err);
  process.exit(1);
});

function main() {
  // 找不到配置不再退出：server 照常启动（tools 可用），调用工具时才给出明确指引
  const config = resolveConfig();
  const cfgMissing = !config.url;
  // 握手完成前不打 stderr（避免客户端将 stderr 视为错误干扰握手）；仅配置缺失时提示
  if (cfgMissing) {
    console.error(`[a2a-mcp v${VERSION}] 未找到平台配置（cwd=${process.cwd()}）。请在含 .a2a.json 的项目目录使用，或设置 A2A_URL/A2A_TOKEN/A2A_ACCOUNT。首次接入：a2a init`);
  }

  let warnedCfg = false;
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let serverReady = false;

  function send(msg) {
    if (process.stdout.writable) process.stdout.write(JSON.stringify(msg) + '\n');
  }

  function respond(id, result) {
    send({ jsonrpc: '2.0', id, result });
  }

  function respondError(id, code, message) {
    send({ jsonrpc: '2.0', id, error: { code, message: String(message) } });
  }

  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch (e) {
      // 非法 JSON 忽略（stdio 上不应出现非 JSON 行）
      return;
    }
    const { id, method, params } = msg;

    // 处理请求（有 id）；通知忽略
    if (!id || id === undefined) return;

    const finish = (result) => respond(id, result);
    const fail = (err) => respondError(id, err && err.code === 'invalid-params' ? -32602 : -32603,
      err && err.message ? err.message : String(err));

    switch (method) {
      case 'initialize': {
        serverReady = true;
        // 协议版本协商：回显客户端请求的已知版本，避免较新客户端不兼容
        const reqVer = params && params.protocolVersion;
        const ver = KNOWN_PROTOCOLS.includes(reqVer) ? reqVer : PROTOCOL_VERSION;
        finish({
          protocolVersion: ver,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'a2a-mcp', version: VERSION },
        });
        break;
      }
      case 'ping':
        finish({});
        break;
      case 'tools/list':
        // 握手已完成，此时 stderr 不再影响握手——打印配置状态便于排查
        if (!cfgMissing && !warnedCfg) { warnedCfg = true; console.error(`[a2a-mcp v${VERSION}] 已加载配置: ${config.url}（账号: ${config.accountId || '?'}）`); }
        finish({ tools: TOOLS });
        break;
      case 'tools/call': {
        const { name, arguments: args } = params || {};
        if (cfgMissing) {
          const errText = '平台未配置：请在含 .a2a.json 的项目目录使用本 MCP（Cursor 的项目级 .cursor/mcp.json 会把工作目录设为项目根），或设置 A2A_URL/A2A_TOKEN/A2A_ACCOUNT 环境变量。首次接入运行 a2a init。';
          finish({ isError: true, content: [{ type: 'text', text: errText }] });
          break;
        }
        callTool(config, name, args || {})
          .then((result) => {
            const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
            finish({ content: [{ type: 'text', text }] });
          })
          .catch((err) => {
            finish({
              isError: true,
              content: [{ type: 'text', text: `错误: ${err && err.message ? err.message : err}` }],
            });
          });
        break;
      }
      default:
        respondError(id, -32601, `Method not found: ${method}`);
    }
  });

  rl.on('close', () => process.exit(0));
}

main();
