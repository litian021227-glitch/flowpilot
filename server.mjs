import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const port = Number(process.env.PORT || process.env.API_PORT || 8787);
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const aiProvider = process.env.AI_PROVIDER || (process.env.DEEPSEEK_API_KEY ? 'deepseek' : 'openai');
const aiApiKey = process.env.AI_API_KEY || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || '';
const aiBaseUrl = (process.env.AI_BASE_URL || (aiProvider === 'deepseek' ? 'https://api.deepseek.com' : 'https://api.openai.com/v1')).replace(/\/$/, '');
const aiModel = process.env.AI_MODEL || (aiProvider === 'deepseek' ? 'deepseek-flash' : process.env.OPENAI_MODEL || 'gpt-4.1-mini');
const memoryDocuments = [];
const memoryTeam = [{ id: 'member-1', user_id: 'demo-user', email: 'litian021227@gmail.com', role: 'owner', status: 'active' }];
const memoryIntegrations = [
  { id: 'integration-1', provider: 'slack', name: 'Slack', status: 'disabled' },
  { id: 'integration-2', provider: 'notion', name: 'Notion', status: 'disabled' },
  { id: 'integration-3', provider: 'webhook', name: '通用 Webhook', status: 'disabled' },
];
const memorySettings = { ai_model: aiModel, approval_required: true, max_concurrent_runs: 3 };
const memoryTasks = [
  { id: 'demo-1', title: 'Q2 销售策略分析', status: 'running', date: '2025-05-20', owner: 'AI Agent' },
  { id: 'demo-2', title: '重点客户跟进计划', status: 'approval', date: '2025-05-22', owner: '华东销售团队' },
  { id: 'demo-3', title: '华东区域市场调研', status: 'completed', date: '2025-05-18', owner: '李天恩' },
  { id: 'demo-4', title: '核心产品 A 系列复盘', status: 'pending', date: '2025-05-26', owner: 'AI Agent' },
];
const distRoot = join(process.cwd(), 'dist');
const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
const requestWindowMs = 60_000;
const requestLimit = Number(process.env.REQUEST_LIMIT || 120);
const requestLog = new Map();
const requireAuth = process.env.REQUIRE_AUTH === 'true';

function isRateLimited(request) {
  const address = request.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const timestamps = (requestLog.get(address) || []).filter((timestamp) => now - timestamp < requestWindowMs);
  timestamps.push(now);
  requestLog.set(address, timestamps);
  return timestamps.length > requestLimit;
}

async function isAuthorized(request) {
  if (!requireAuth) return true;
  if (!supabaseUrl || !supabaseKey) return false;
  const authorization = request.headers.authorization || '';
  if (!authorization.startsWith('Bearer ')) return false;
  const response = await fetch(`${supabaseUrl}/auth/v1/user`, { headers: { apikey: supabaseKey, Authorization: authorization } });
  return response.ok;
}

const demoResult = (task) => ({
  mode: 'demo',
  task,
  summary: '已完成任务拆解，当前使用演示数据返回结果。配置 AI_API_KEY 后即可切换到真实 Agent。',
  trace: [
    { title: '理解任务需求', detail: `识别意图：${task}` },
    { title: '检索相关数据', detail: '从企业知识库中找到 3 个相关来源' },
    { title: '数据分析与计算', detail: '调用 analytics 工具完成趋势和同比计算' },
    { title: '生成分析结果', detail: '整理关键发现并生成可视化结果' },
  ],
  requiresApproval: true,
});

async function runAgent(task) {
  const sources = await searchKnowledge(task, 3);
  if (!aiApiKey) return { ...demoResult(task), sources };
  const response = await fetch(`${aiBaseUrl}/responses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${aiApiKey}`,
    },
    body: JSON.stringify({
      model: aiModel,
      input: `你是 FlowPilot 企业工作流 Agent。请基于以下知识库来源分析任务并输出简洁的执行计划。任务：${task}\n来源：${sources.map((item) => item.content).join('\n')}`,
      tools: [],
    }),
  });
  if (!response.ok) {
    if (response.status === 429 || response.status >= 500) {
      return { ...demoResult(task), sources, mode: 'fallback', summary: 'AI 服务当前暂时不可用，已使用安全演示模式完成任务拆解；任务已进入待审批队列。', providerError: `AI provider returned ${response.status}` };
    }
    throw new Error(`AI provider returned ${response.status}`);
  }
  const data = await response.json();
  const text = data.output_text || '模型未返回文本结果';
  return { mode: 'live', task, summary: text, trace: demoResult(task).trace, sources, requiresApproval: true };
}

function splitText(text, size = 700) {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  const chunks = [];
  for (let start = 0; start < normalized.length; start += size) {
    const content = normalized.slice(start, start + size).trim();
    if (content) chunks.push(content);
  }
  return chunks;
}

async function searchKnowledge(query, limit = 5) {
  if (!supabaseUrl || !supabaseKey) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return memoryDocuments
      .map((item) => ({ ...item, score: terms.reduce((score, term) => score + (item.content.toLowerCase().includes(term) ? 1 : 0), 0) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
  const response = await fetch(`${supabaseUrl}/rest/v1/knowledge_chunks?select=id,content,metadata&limit=${limit}`, {
    headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
  });
  if (!response.ok) throw new Error(`Knowledge search failed: ${response.status}`);
  return response.json();
}

async function ingestKnowledge({ title, content }) {
  const chunks = splitText(content);
  if (!supabaseUrl || !supabaseKey) {
    const inserted = chunks.map((chunk, index) => ({ id: `memory-${Date.now()}-${index}`, title, content: chunk, metadata: { title, chunk: index } }));
    memoryDocuments.push(...inserted);
    return { mode: 'memory', title, chunks: inserted.length };
  }
  const workspaceResponse = await fetch(`${supabaseUrl}/rest/v1/workspaces?select=id&limit=1`, { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } });
  const workspaceRows = await workspaceResponse.json();
  const workspaceId = workspaceRows?.[0]?.id;
  if (!workspaceId) throw new Error('Create a workspace before ingesting documents');
  const documentResponse = await fetch(`${supabaseUrl}/rest/v1/knowledge_documents`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, Prefer: 'return=representation' },
    body: JSON.stringify({ workspace_id: workspaceId, title }),
  });
  const documents = await documentResponse.json();
  const documentId = documents?.[0]?.id;
  if (!documentId) throw new Error('Knowledge document insert failed');
  const chunkResponse = await fetch(`${supabaseUrl}/rest/v1/knowledge_chunks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
    body: JSON.stringify(chunks.map((chunk, index) => ({ document_id: documentId, content: chunk, metadata: { title, chunk: index } }))),
  });
  if (!chunkResponse.ok) throw new Error(`Knowledge chunks insert failed: ${chunkResponse.status}`);
  return { mode: 'supabase', title, chunks: chunks.length, documentId };
}

async function listKnowledgeDocuments() {
  if (!supabaseUrl || !supabaseKey) {
    return [...new Map(memoryDocuments.map((item) => [item.title, item])).values()].map((item) => ({ title: item.title, source_type: 'memory', created_at: null }));
  }
  const response = await fetch(`${supabaseUrl}/rest/v1/knowledge_documents?select=id,title,source_type,created_at&order=created_at.desc`, {
    headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
  });
  if (!response.ok) throw new Error(`Knowledge document list failed: ${response.status}`);
  return response.json();
}

async function listApprovals() {
  if (!supabaseUrl || !supabaseKey) return memoryTasks.filter((item) => item.status === 'approval').map((item) => ({ id: item.id, task_id: item.id, action: 'generate_report', status: 'pending', task: item.title }));
  const response = await fetch(`${supabaseUrl}/rest/v1/approval_requests?select=id,task_id,action,payload,status,created_at,resolved_at,tasks(title,status)&order=created_at.desc`, {
    headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
  });
  if (!response.ok) throw new Error(`Approval list failed: ${response.status}`);
  return response.json();
}

async function listAgentRuns(taskId) {
  if (!supabaseUrl || !supabaseKey) return [];
  const filter = taskId ? `&task_id=eq.${encodeURIComponent(taskId)}` : '';
  const response = await fetch(`${supabaseUrl}/rest/v1/agent_runs?select=id,task_id,status,model,input,output,started_at,finished_at&order=started_at.desc&limit=100${filter}`, {
    headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
  });
  if (!response.ok) throw new Error(`Agent run list failed: ${response.status}`);
  return response.json();
}

async function listAuditEvents(taskId) {
  if (!supabaseUrl || !supabaseKey) return [];
  const filter = taskId ? `&task_id=eq.${encodeURIComponent(taskId)}` : '';
  const response = await fetch(`${supabaseUrl}/rest/v1/audit_events?select=id,workspace_id,task_id,event_type,payload,created_at&order=created_at.desc&limit=100${filter}`, {
    headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
  });
  if (!response.ok) throw new Error(`Audit event list failed: ${response.status}`);
  return response.json();
}

async function getWorkspaceSummary() {
  const [tasks, approvals, documents, runs, events] = await Promise.all([
    listTasks(),
    listApprovals(),
    listKnowledgeDocuments(),
    listAgentRuns(),
    listAuditEvents(),
  ]);
  return {
    counts: {
      tasks: tasks.length,
      pendingApprovals: approvals.filter((item) => item.status === 'pending').length,
      documents: documents.length,
      agentRuns: runs.length,
      auditEvents: events.length,
    },
    tasks,
    approvals,
    documents,
    runs,
    events,
  };
}

async function writeAuditEvent({ workspaceId, taskId, eventType, payload = {} }) {
  if (!supabaseUrl || !supabaseKey) return;
  await fetch(`${supabaseUrl}/rest/v1/audit_events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
    body: JSON.stringify({ workspace_id: workspaceId, task_id: taskId || null, event_type: eventType, payload }),
  });
}

async function persistTask(result) {
  if (!supabaseUrl || !supabaseKey) {
    memoryTasks.unshift({ id: `memory-task-${Date.now()}`, title: result.task, status: 'approval', date: new Date().toISOString().slice(0, 10), owner: 'AI Agent' });
    return { persisted: false, mode: 'memory' };
  }
  const headers = {
    'Content-Type': 'application/json',
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
    Prefer: 'return=representation',
  };
  const workspace = await fetch(`${supabaseUrl}/rest/v1/workspaces?select=id&limit=1`, { headers });
  const workspaceRows = await workspace.json();
  const workspaceId = workspaceRows?.[0]?.id;
  if (!workspaceId) return { persisted: false, reason: 'Create a workspace row first' };
  const taskResponse = await fetch(`${supabaseUrl}/rest/v1/tasks`, {
    method: 'POST', headers,
    body: JSON.stringify({ workspace_id: workspaceId, title: result.task, status: 'approval', input: { source: 'agent' }, result }),
  });
  if (!taskResponse.ok) throw new Error(`Supabase task insert failed: ${taskResponse.status}`);
  const taskRows = await taskResponse.json();
  const taskId = taskRows?.[0]?.id;
  if (taskId) {
    await fetch(`${supabaseUrl}/rest/v1/agent_runs`, {
      method: 'POST', headers,
      body: JSON.stringify({ task_id: taskId, status: 'completed', model: aiModel || 'demo', input: { task: result.task }, output: result }),
    });
    await fetch(`${supabaseUrl}/rest/v1/approval_requests`, {
      method: 'POST', headers,
      body: JSON.stringify({ task_id: taskId, action: 'generate_report', payload: { source: 'agent', requiresApproval: true }, status: 'pending' }),
    });
    await writeAuditEvent({ workspaceId, taskId, eventType: 'agent.completed', payload: { mode: result.mode } });
  }
  return { persisted: true, taskId };
}

async function listTasks() {
  if (!supabaseUrl || !supabaseKey) return memoryTasks;
  const response = await fetch(`${supabaseUrl}/rest/v1/tasks?select=id,title,status,created_at,updated_at&order=updated_at.desc`, {
    headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
  });
  if (!response.ok) throw new Error(`Task list failed: ${response.status}`);
  return response.json();
}

async function listWorkspaces() {
  if (!supabaseUrl || !supabaseKey) return [{ id: 'memory-workspace', name: '华东销售团队', created_at: null }];
  const response = await fetch(`${supabaseUrl}/rest/v1/workspaces?select=id,name,created_at&order=created_at.asc`, {
    headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
  });
  if (!response.ok) throw new Error(`Workspace list failed: ${response.status}`);
  return response.json();
}

async function listTeam() {
  if (!supabaseUrl || !supabaseKey) return memoryTeam;
  const workspaces = await listWorkspaces();
  const workspaceId = workspaces?.[0]?.id;
  if (!workspaceId) return [];
  const response = await fetch(`${supabaseUrl}/rest/v1/workspace_members?select=id,user_id,role,created_at&workspace_id=eq.${encodeURIComponent(workspaceId)}&order=created_at.asc`, {
    headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
  });
  if (!response.ok) throw new Error(`Team list failed: ${response.status}`);
  return response.json();
}

async function inviteTeamMember({ email, role = 'member' }) {
  if (!supabaseUrl || !supabaseKey) {
    const invitation = { id: `invite-${Date.now()}`, email, role, status: 'pending', created_at: new Date().toISOString() };
    memoryTeam.push(invitation);
    return invitation;
  }
  const workspaces = await listWorkspaces();
  const workspaceId = workspaces?.[0]?.id;
  if (!workspaceId) throw new Error('Create a workspace before inviting members');
  const response = await fetch(`${supabaseUrl}/rest/v1/workspace_invitations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, Prefer: 'return=representation' },
    body: JSON.stringify({ workspace_id: workspaceId, email, role }),
  });
  if (!response.ok) throw new Error(`Invitation create failed: ${response.status}`);
  const rows = await response.json();
  return rows?.[0] || null;
}

async function listIntegrations() {
  if (!supabaseUrl || !supabaseKey) return memoryIntegrations;
  const workspaces = await listWorkspaces();
  const workspaceId = workspaces?.[0]?.id;
  if (!workspaceId) return [];
  const response = await fetch(`${supabaseUrl}/rest/v1/integrations?select=id,provider,name,status,created_at,updated_at&workspace_id=eq.${encodeURIComponent(workspaceId)}&order=created_at.asc`, {
    headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
  });
  if (!response.ok) throw new Error(`Integration list failed: ${response.status}`);
  return response.json();
}

async function updateIntegration(provider, status) {
  if (!['disabled', 'connected', 'error'].includes(status)) throw new Error('Invalid integration status');
  if (!supabaseUrl || !supabaseKey) {
    const item = memoryIntegrations.find((integration) => integration.provider === provider);
    if (!item) throw new Error('Integration not found');
    item.status = status;
    return item;
  }
  const workspaces = await listWorkspaces();
  const workspaceId = workspaces?.[0]?.id;
  if (!workspaceId) throw new Error('Create a workspace before configuring integrations');
  const response = await fetch(`${supabaseUrl}/rest/v1/integrations?workspace_id=eq.${encodeURIComponent(workspaceId)}&provider=eq.${encodeURIComponent(provider)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, Prefer: 'return=representation' },
    body: JSON.stringify({ status, updated_at: new Date().toISOString() }),
  });
  if (!response.ok) throw new Error(`Integration update failed: ${response.status}`);
  const rows = await response.json();
  return rows?.[0] || null;
}

async function getSettings() {
  if (!supabaseUrl || !supabaseKey) return memorySettings;
  const workspaces = await listWorkspaces();
  const workspaceId = workspaces?.[0]?.id;
  if (!workspaceId) return memorySettings;
  const response = await fetch(`${supabaseUrl}/rest/v1/workspace_settings?select=workspace_id,ai_model,approval_required,max_concurrent_runs,updated_at&workspace_id=eq.${encodeURIComponent(workspaceId)}&limit=1`, {
    headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
  });
  if (!response.ok) throw new Error(`Settings load failed: ${response.status}`);
  const rows = await response.json();
  return rows?.[0] || { ai_model: aiModel, approval_required: true, max_concurrent_runs: 3 };
}

async function updateSettings(patch) {
  const next = { ai_model: patch.ai_model || aiModel, approval_required: patch.approval_required !== false, max_concurrent_runs: Math.min(20, Math.max(1, Number(patch.max_concurrent_runs || 3))) };
  if (!supabaseUrl || !supabaseKey) { Object.assign(memorySettings, next); return memorySettings; }
  const workspaces = await listWorkspaces();
  const workspaceId = workspaces?.[0]?.id;
  if (!workspaceId) throw new Error('Create a workspace before saving settings');
  const response = await fetch(`${supabaseUrl}/rest/v1/workspace_settings?on_conflict=workspace_id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({ workspace_id: workspaceId, ...next, updated_at: new Date().toISOString() }),
  });
  if (!response.ok) throw new Error(`Settings update failed: ${response.status}`);
  const rows = await response.json();
  return rows?.[0] || next;
}

async function createTask({ title, input = {}, status = 'pending' }) {
  if (!supabaseUrl || !supabaseKey) {
    const task = { id: `memory-task-${Date.now()}`, title, status, input, date: new Date().toISOString().slice(0, 10), owner: '团队成员' };
    memoryTasks.unshift(task);
    return task;
  }
  const headers = { 'Content-Type': 'application/json', apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, Prefer: 'return=representation' };
  const workspaces = await listWorkspaces();
  const workspaceId = workspaces?.[0]?.id;
  if (!workspaceId) throw new Error('Create a workspace before creating tasks');
  const response = await fetch(`${supabaseUrl}/rest/v1/tasks`, { method: 'POST', headers, body: JSON.stringify({ workspace_id: workspaceId, title, status, input }) });
  if (!response.ok) throw new Error(`Task create failed: ${response.status}`);
  const rows = await response.json();
  return rows?.[0] || null;
}

async function updateTask(taskId, patch) {
  if (!supabaseUrl || !supabaseKey) {
    const task = memoryTasks.find((item) => item.id === taskId);
    if (!task) return null;
    Object.assign(task, patch);
    return task;
  }
  const response = await fetch(`${supabaseUrl}/rest/v1/tasks?id=eq.${encodeURIComponent(taskId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, Prefer: 'return=representation' },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
  if (!response.ok) throw new Error(`Task update failed: ${response.status}`);
  const rows = await response.json();
  return rows?.[0] || null;
}

async function getTask(taskId) {
  if (!supabaseUrl || !supabaseKey) {
    const task = memoryTasks.find((item) => item.id === taskId);
    return task || null;
  }
  const response = await fetch(`${supabaseUrl}/rest/v1/tasks?select=*&id=eq.${encodeURIComponent(taskId)}&limit=1`, {
    headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
  });
  if (!response.ok) throw new Error(`Task detail failed: ${response.status}`);
  const rows = await response.json();
  return rows?.[0] || null;
}

async function listKnowledgeChunks(documentId) {
  if (!supabaseUrl || !supabaseKey) {
    return memoryDocuments.filter((item) => !documentId || item.document_id === documentId).map(({ content, metadata, ...item }) => ({ ...item, content, metadata }));
  }
  const filter = documentId ? `&document_id=eq.${encodeURIComponent(documentId)}` : '';
  const response = await fetch(`${supabaseUrl}/rest/v1/knowledge_chunks?select=id,document_id,content,metadata,created_at&order=created_at.asc&limit=200${filter}`, {
    headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
  });
  if (!response.ok) throw new Error(`Knowledge chunk list failed: ${response.status}`);
  return response.json();
}

async function approveTask(taskId, action) {
  const task = memoryTasks.find(item => item.id === taskId);
  if (!supabaseUrl || !supabaseKey) {
    if (task) task.status = 'completed';
    return { approved: true, mode: 'memory', taskId, action };
  }
  const response = await fetch(`${supabaseUrl}/rest/v1/tasks?id=eq.${encodeURIComponent(taskId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, Prefer: 'return=representation' },
    body: JSON.stringify({ status: action === 'reject' ? 'failed' : 'completed', result: { approvedAction: action, approvedAt: new Date().toISOString() } }),
  });
  if (!response.ok) throw new Error(`Task approval failed: ${response.status}`);
  const approvalResponse = await fetch(`${supabaseUrl}/rest/v1/approval_requests?task_id=eq.${encodeURIComponent(taskId)}&status=eq.pending&order=created_at.desc&limit=1`, {
    headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
  });
  const approvals = await approvalResponse.json();
  if (approvals?.[0]?.id) {
    await fetch(`${supabaseUrl}/rest/v1/approval_requests?id=eq.${encodeURIComponent(approvals[0].id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
      body: JSON.stringify({ status: action === 'reject' ? 'rejected' : 'approved', resolved_at: new Date().toISOString() }),
    });
  }
  await writeAuditEvent({ taskId, eventType: action === 'reject' ? 'approval.rejected' : 'approval.approved', payload: { action } });
  return { approved: action !== 'reject', mode: 'supabase', taskId, action };
}

const server = createServer(async (request, response) => {
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'SAMEORIGIN');
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
  if (requireAuth && request.url.startsWith('/api/') && request.url !== '/api/health' && !(await isAuthorized(request))) {
    response.writeHead(401); response.end(JSON.stringify({ error: 'Authentication required' })); return;
  }
  if (request.method === 'POST' && isRateLimited(request)) {
    response.writeHead(429, { 'Retry-After': '60' });
    response.end(JSON.stringify({ error: 'Too many requests. Please retry later.' }));
    return;
  }
  if (request.method === 'GET' && request.url === '/api/health') {
    response.writeHead(200); response.end(JSON.stringify({ ok: true, service: 'flowpilot-api', time: new Date().toISOString() })); return;
  }
  if (request.method === 'GET' && !request.url.startsWith('/api/')) {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      const filePath = join(distRoot, relativePath);
      const body = await readFile(filePath);
      response.writeHead(200, { 'Content-Type': contentTypes[extname(filePath)] || 'application/octet-stream' }); response.end(body); return;
    } catch {
      try { const body = await readFile(join(distRoot, 'index.html')); response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(body); return; } catch {}
    }
  }
  if (request.method === 'GET' && request.url.startsWith('/api/knowledge/search')) {
    const query = new URL(request.url, `http://${request.headers.host}`).searchParams.get('q') || '';
    response.writeHead(200); response.end(JSON.stringify({ results: await searchKnowledge(query) })); return;
  }
  if (request.method === 'GET' && request.url === '/api/tasks') {
    response.writeHead(200); response.end(JSON.stringify({ tasks: await listTasks() })); return;
  }
  if (request.method === 'GET' && request.url === '/api/workspaces') {
    try { response.writeHead(200); response.end(JSON.stringify({ workspaces: await listWorkspaces() })); }
    catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: error.message })); }
    return;
  }
  if (request.method === 'GET' && request.url === '/api/team') {
    try { response.writeHead(200); response.end(JSON.stringify({ members: await listTeam() })); }
    catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: error.message })); }
    return;
  }
  if (request.method === 'POST' && request.url === '/api/team/invite') {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email || '')) { response.writeHead(400); response.end(JSON.stringify({ error: 'valid email is required' })); return; }
        if (!['admin', 'member', 'viewer'].includes(payload.role || 'member')) { response.writeHead(400); response.end(JSON.stringify({ error: 'invalid role' })); return; }
        const invitation = await inviteTeamMember({ email: payload.email.trim().toLowerCase(), role: payload.role || 'member' });
        response.writeHead(201); response.end(JSON.stringify({ invitation }));
      } catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: error.message })); }
    });
    return;
  }
  if (request.method === 'GET' && request.url === '/api/integrations') {
    try { response.writeHead(200); response.end(JSON.stringify({ integrations: await listIntegrations() })); }
    catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: error.message })); }
    return;
  }
  if (request.method === 'PATCH' && request.url.startsWith('/api/integrations/')) {
    const provider = request.url.split('/')[3];
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const integration = await updateIntegration(provider, payload.status);
        response.writeHead(200); response.end(JSON.stringify({ integration }));
      } catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: error.message })); }
    });
    return;
  }
  if (request.method === 'GET' && request.url === '/api/settings') {
    try { response.writeHead(200); response.end(JSON.stringify({ settings: await getSettings() })); }
    catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: error.message })); }
    return;
  }
  if (request.method === 'PATCH' && request.url === '/api/settings') {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', async () => {
      try { const settings = await updateSettings(JSON.parse(body || '{}')); response.writeHead(200); response.end(JSON.stringify({ settings })); }
      catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: error.message })); }
    });
    return;
  }
  if (request.method === 'POST' && request.url === '/api/tasks') {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        if (!payload.title?.trim()) { response.writeHead(400); response.end(JSON.stringify({ error: 'title is required' })); return; }
        const task = await createTask({ title: payload.title.trim(), input: payload.input || {}, status: payload.status || 'pending' });
        response.writeHead(201); response.end(JSON.stringify({ task }));
      } catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: error.message })); }
    });
    return;
  }
  if (request.method === 'PATCH' && request.url.startsWith('/api/tasks/')) {
    const taskId = request.url.split('/')[3];
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const allowed = {};
        if (typeof payload.title === 'string' && payload.title.trim()) allowed.title = payload.title.trim();
        if (['pending', 'running', 'approval', 'completed', 'failed'].includes(payload.status)) allowed.status = payload.status;
        if (!Object.keys(allowed).length) { response.writeHead(400); response.end(JSON.stringify({ error: 'title or valid status is required' })); return; }
        const task = await updateTask(taskId, allowed);
        if (!task) { response.writeHead(404); response.end(JSON.stringify({ error: 'Task not found' })); return; }
        response.writeHead(200); response.end(JSON.stringify({ task }));
      } catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: error.message })); }
    });
    return;
  }
  if (request.method === 'GET' && request.url.startsWith('/api/tasks/')) {
    const taskId = request.url.split('/')[3];
    try {
      const task = await getTask(taskId);
      if (!task) { response.writeHead(404); response.end(JSON.stringify({ error: 'Task not found' })); return; }
      const [taskRuns, taskEvents] = await Promise.all([listAgentRuns(taskId), listAuditEvents(taskId)]);
      response.writeHead(200); response.end(JSON.stringify({ task, runs: taskRuns, events: taskEvents }));
    } catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: error.message })); }
    return;
  }
  if (request.method === 'GET' && request.url === '/api/knowledge/documents') {
    try { response.writeHead(200); response.end(JSON.stringify({ documents: await listKnowledgeDocuments() })); }
    catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: error.message })); }
    return;
  }
  if (request.method === 'GET' && request.url === '/api/approvals') {
    try { response.writeHead(200); response.end(JSON.stringify({ approvals: await listApprovals() })); }
    catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: error.message })); }
    return;
  }
  if (request.method === 'GET' && request.url.startsWith('/api/agent/runs')) {
    try {
      const taskId = new URL(request.url, `http://${request.headers.host}`).searchParams.get('taskId');
      response.writeHead(200); response.end(JSON.stringify({ runs: await listAgentRuns(taskId) }));
    } catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: error.message })); }
    return;
  }
  if (request.method === 'GET' && request.url.startsWith('/api/audit')) {
    try {
      const taskId = new URL(request.url, `http://${request.headers.host}`).searchParams.get('taskId');
      response.writeHead(200); response.end(JSON.stringify({ events: await listAuditEvents(taskId) }));
    } catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: error.message })); }
    return;
  }
  if (request.method === 'GET' && request.url === '/api/workspace/summary') {
    try { response.writeHead(200); response.end(JSON.stringify(await getWorkspaceSummary())); }
    catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: error.message })); }
    return;
  }
  if (request.method === 'GET' && request.url.startsWith('/api/knowledge/chunks')) {
    try {
      const documentId = new URL(request.url, `http://${request.headers.host}`).searchParams.get('documentId');
      response.writeHead(200); response.end(JSON.stringify({ chunks: await listKnowledgeChunks(documentId) }));
    } catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: error.message })); }
    return;
  }
  if (request.method === 'POST' && request.url.startsWith('/api/tasks/') && request.url.endsWith('/approve')) {
    const taskId = request.url.split('/')[3];
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', async () => {
      try { const result = await approveTask(taskId, JSON.parse(body || '{}').action || 'generate_report'); response.writeHead(200); response.end(JSON.stringify(result)); }
      catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: error.message })); }
    });
    return;
  }
  if (request.method !== 'POST' || !['/api/agent/run', '/api/knowledge/ingest'].includes(request.url)) {
    response.writeHead(404); response.end(JSON.stringify({ error: 'Not found' })); return;
  }
  let body = '';
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', async () => {
    try {
      const payload = JSON.parse(body || '{}');
      if (request.url === '/api/knowledge/ingest') {
        if (!payload.title?.trim() || !payload.content?.trim()) { response.writeHead(400); response.end(JSON.stringify({ error: 'title and content are required' })); return; }
        response.writeHead(200); response.end(JSON.stringify(await ingestKnowledge(payload))); return;
      }
      const { task } = payload;
      if (!task?.trim()) { response.writeHead(400); response.end(JSON.stringify({ error: 'task is required' })); return; }
      const result = await runAgent(task.trim());
      const persistence = await persistTask(result);
      response.writeHead(200); response.end(JSON.stringify({ ...result, persistence }));
    } catch (error) {
      response.writeHead(500); response.end(JSON.stringify({ error: error.message }));
    }
  });
});

const host = process.env.HOST || '0.0.0.0';
server.listen(port, host, () => console.log(`FlowPilot API listening on http://${host}:${port}`));
