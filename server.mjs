import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const port = Number(process.env.PORT || process.env.API_PORT || 8787);
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const memoryDocuments = [];
const memoryTasks = [
  { id: 'demo-1', title: 'Q2 销售策略分析', status: 'running', date: '2025-05-20', owner: 'AI Agent' },
  { id: 'demo-2', title: '重点客户跟进计划', status: 'approval', date: '2025-05-22', owner: '华东销售团队' },
  { id: 'demo-3', title: '华东区域市场调研', status: 'completed', date: '2025-05-18', owner: '李天恩' },
  { id: 'demo-4', title: '核心产品 A 系列复盘', status: 'pending', date: '2025-05-26', owner: 'AI Agent' },
];
const distRoot = join(process.cwd(), 'dist');
const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

const demoResult = (task) => ({
  mode: 'demo',
  task,
  summary: '已完成任务拆解，当前使用演示数据返回结果。配置 OPENAI_API_KEY 后即可切换到真实 Agent。',
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
  if (!process.env.OPENAI_API_KEY) return { ...demoResult(task), sources };
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
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
      body: JSON.stringify({ task_id: taskId, status: 'completed', model: process.env.OPENAI_MODEL || 'demo', input: { task: result.task }, output: result }),
    });
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

async function approveTask(taskId, action) {
  const task = memoryTasks.find(item => item.id === taskId);
  if (!supabaseUrl || !supabaseKey) {
    if (task) task.status = 'completed';
    return { approved: true, mode: 'memory', taskId, action };
  }
  const response = await fetch(`${supabaseUrl}/rest/v1/tasks?id=eq.${encodeURIComponent(taskId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, Prefer: 'return=representation' },
    body: JSON.stringify({ status: 'completed', result: { approvedAction: action, approvedAt: new Date().toISOString() } }),
  });
  if (!response.ok) throw new Error(`Task approval failed: ${response.status}`);
  return { approved: true, mode: 'supabase', taskId, action };
}

const server = createServer(async (request, response) => {
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Access-Control-Allow-Origin', '*');
  if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
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
