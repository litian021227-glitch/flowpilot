import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

const port = Number(process.env.PORT || process.env.API_PORT || 8787);
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const aiProvider = process.env.AI_PROVIDER || (process.env.DEEPSEEK_API_KEY ? 'deepseek' : 'openai');
const aiApiKey = process.env.AI_API_KEY || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || '';
const aiBaseUrl = (process.env.AI_BASE_URL || (aiProvider === 'deepseek' ? 'https://api.deepseek.com' : 'https://api.openai.com/v1')).replace(/\/$/, '');
const aiModel = process.env.AI_MODEL || (aiProvider === 'deepseek' ? 'deepseek-flash' : process.env.OPENAI_MODEL || 'gpt-4.1-mini');
const aiTimeoutMs = Math.max(2_000, Number(process.env.AI_TIMEOUT_MS || 30_000));
const aiMaxRetries = Math.min(4, Math.max(0, Number(process.env.AI_MAX_RETRIES || 2)));
const requestBodyLimitBytes = Math.max(64 * 1024, Number(process.env.REQUEST_BODY_LIMIT_BYTES || 2 * 1024 * 1024));
const knowledgeFileLimitBytes = Math.max(256 * 1024, Number(process.env.KNOWLEDGE_FILE_LIMIT_BYTES || 10 * 1024 * 1024));
const knowledgeStorageBucket = process.env.KNOWLEDGE_STORAGE_BUCKET || 'flowpilot-knowledge';
const webhookSigningSecret = process.env.WEBHOOK_SIGNING_SECRET || '';
const invitationBaseUrl = process.env.INVITATION_BASE_URL || 'http://localhost:5173';
const invitationExpiresHours = Math.min(168, Math.max(1, Number(process.env.INVITATION_EXPIRES_HOURS || 168)));
const requestContextStorage = new AsyncLocalStorage();
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
const memoryIdempotency = new Map();
const memoryWebhookEvents = new Set();

function httpError(status, message, code = 'request_error') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function currentScope() {
  return requestContextStorage.getStore() || { userId: null, token: null, workspaceId: null, role: 'owner', requestId: null, demo: true };
}

function isDemoScope() {
  return currentScope().demo === true && !requireAuth;
}

function redact(value) {
  if (value === undefined || value === null) return value;
  return String(value).replace(/(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/g, '$1…').replace(/(Bearer\s+)[^\s]+/gi, '$1…');
}

function logEvent(event, fields = {}) {
  console.log(JSON.stringify({ event, ...fields, request_id: currentScope().requestId || null, user_id: currentScope().userId || null, workspace_id: currentScope().workspaceId || null }));
}

function validateStatusTransition(from, to) {
  if (!from || from === to) return;
  const allowed = { pending: ['running', 'approval', 'failed', 'cancelled'], running: ['approval', 'completed', 'failed', 'cancelled'], approval: ['completed', 'failed', 'cancelled'], completed: [], failed: ['pending', 'running'], cancelled: ['pending'] };
  if (!allowed[from]?.includes(to)) throw httpError(409, `Illegal task status transition: ${from} -> ${to}`, 'invalid_status_transition');
}

async function fetchWithTimeout(url, options = {}, timeoutMs = aiTimeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

async function readJsonBody(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body, 'utf8') > requestBodyLimitBytes) throw httpError(413, 'request body is too large', 'payload_too_large');
  }
  try { return JSON.parse(body || '{}'); } catch { throw httpError(400, 'invalid JSON body', 'invalid_json'); }
}

async function readRawBody(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body, 'utf8') > requestBodyLimitBytes) throw httpError(413, 'request body is too large', 'payload_too_large');
  }
  return body;
}

function verifyWebhookSignature(request, rawBody) {
  if (!webhookSigningSecret) throw httpError(503, 'Webhook signing secret is not configured', 'webhook_unavailable');
  const timestamp = request.headers['x-flowpilot-timestamp'];
  const signatureHeader = request.headers['x-flowpilot-signature'] || '';
  const eventId = request.headers['x-flowpilot-event-id'];
  const timestampNumber = Number(timestamp);
  if (!timestamp || !Number.isFinite(timestampNumber) || Math.abs(Date.now() - timestampNumber * 1000) > 5 * 60 * 1000) throw httpError(401, 'Webhook timestamp is invalid or expired', 'webhook_replay_rejected');
  const expected = createHmac('sha256', webhookSigningSecret).update(`${timestamp}.${rawBody}`).digest('hex');
  const supplied = String(signatureHeader).replace(/^sha256=/, '');
  if (!supplied || supplied.length !== expected.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) throw httpError(401, 'Webhook signature is invalid', 'webhook_signature_invalid');
  if (!eventId) throw httpError(400, 'Webhook event id is required', 'webhook_event_id_required');
  if (memoryWebhookEvents.has(eventId)) return { duplicate: true, eventId };
  memoryWebhookEvents.add(eventId);
  if (memoryWebhookEvents.size > 10_000) memoryWebhookEvents.delete(memoryWebhookEvents.values().next().value);
  return { duplicate: false, eventId };
}

function isRateLimited(request) {
  const address = request.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const timestamps = (requestLog.get(address) || []).filter((timestamp) => now - timestamp < requestWindowMs);
  timestamps.push(now);
  requestLog.set(address, timestamps);
  return timestamps.length > requestLimit;
}

async function authenticateRequest(request) {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const requestedWorkspaceId = request.headers['x-workspace-id'] || url.searchParams.get('workspaceId') || null;
  const authorization = request.headers.authorization || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';

  const requestId = request.headers['x-request-id'] || randomUUID();
  if (!token) {
    if (requireAuth) throw httpError(401, 'Authentication required', 'auth_required');
    return { userId: null, token: null, workspaceId: requestedWorkspaceId, role: 'owner', requestId, demo: true };
  }
  if (!supabaseUrl || !supabaseKey) throw httpError(503, 'Authentication service is not configured', 'auth_unavailable');
  const response = await fetchWithTimeout(`${supabaseUrl}/auth/v1/user`, { headers: { apikey: supabaseKey, Authorization: `Bearer ${token}` } }, 10_000);
  if (!response.ok) throw httpError(401, 'Invalid or expired authentication token', 'auth_invalid');
  const user = await response.json();
  if (!user?.id) throw httpError(401, 'Authentication response did not contain a user', 'auth_invalid');
  return { userId: user.id, email: user.email || null, token, workspaceId: requestedWorkspaceId, role: null, requestId, demo: false };
}

async function isAuthorized(request) {
  try { await authenticateRequest(request); return true; } catch { return false; }
}

async function getWorkspaceAccess() {
  const scope = currentScope();
  if (!supabaseUrl || !supabaseKey) return { id: scope.workspaceId || 'memory-workspace', name: '华东销售团队', role: 'owner' };
  if (scope.demo && !requireAuth) {
    const response = await fetchWithTimeout(`${supabaseUrl}/rest/v1/workspaces?select=id,name,created_at&order=created_at.asc&limit=1`, { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }, 10_000);
    if (!response.ok) throw httpError(502, 'Workspace lookup failed', 'workspace_lookup_failed');
    const rows = await response.json();
    if (!rows?.[0]) throw httpError(404, 'No workspace has been created', 'workspace_missing');
    return { ...rows[0], role: 'owner' };
  }
  if (!scope.userId) throw httpError(401, 'Authentication required', 'auth_required');
  const memberFilter = scope.workspaceId
    ? `workspace_id=eq.${encodeURIComponent(scope.workspaceId)}&user_id=eq.${encodeURIComponent(scope.userId)}&limit=1`
    : `user_id=eq.${encodeURIComponent(scope.userId)}&order=created_at.asc&limit=1`;
  const memberResponse = await fetchWithTimeout(`${supabaseUrl}/rest/v1/workspace_members?select=workspace_id,role,workspaces(id,name,created_at)&${memberFilter}`, { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }, 10_000);
  if (!memberResponse.ok) throw httpError(502, 'Workspace membership lookup failed', 'membership_lookup_failed');
  const members = await memberResponse.json();
  const member = members?.[0];
  if (!member) throw httpError(403, 'You are not a member of this workspace', 'workspace_forbidden');
  const workspace = Array.isArray(member.workspaces) ? member.workspaces[0] : member.workspaces;
  if (!workspace) throw httpError(404, 'Workspace not found', 'workspace_missing');
  return { ...workspace, role: member.role };
}

async function requireWorkspaceMember(roles = []) {
  const access = await getWorkspaceAccess();
  if (roles.length && !roles.includes(access.role)) throw httpError(403, 'Insufficient workspace permissions', 'role_forbidden');
  return access;
}

async function findIdempotentTask(idempotencyKey) {
  if (!idempotencyKey) return null;
  if (!supabaseUrl || !supabaseKey) {
    const cached = memoryIdempotency.get(idempotencyKey);
    return cached ? { ...cached, duplicate: true, persistence: { ...(cached.persistence || {}), duplicate: true } } : null;
  }
  const workspace = await requireWorkspaceMember(['owner', 'admin', 'member']);
  const response = await fetchWithTimeout(`${supabaseUrl}/rest/v1/tasks?select=id,status,result&workspace_id=eq.${encodeURIComponent(workspace.id)}&idempotency_key=eq.${encodeURIComponent(idempotencyKey)}&limit=1`, { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }, 10_000);
  if (!response.ok) return null;
  const rows = await response.json();
  const existing = rows?.[0];
  return existing ? { ...(existing.result || {}), persistence: { persisted: true, duplicate: true, taskId: existing.id, status: existing.status } } : null;
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
  const requestBody = JSON.stringify({
    model: aiModel,
    input: `你是 FlowPilot 企业工作流 Agent。请基于以下知识库来源分析任务并输出简洁的执行计划。任务：${task}\n来源：${sources.map((item) => item.content).join('\n')}`,
    tools: [],
  });
  let lastFailure = null;
  for (let attempt = 0; attempt <= aiMaxRetries; attempt += 1) {
    try {
      const response = await fetchWithTimeout(`${aiBaseUrl}/responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aiApiKey}` },
        body: requestBody,
      });
      if (response.ok) {
        const data = await response.json();
        const text = typeof data.output_text === 'string' ? data.output_text.trim() : '';
        if (!text) throw httpError(502, 'AI provider returned an empty response', 'provider_invalid_response');
        logEvent('agent.provider_success', { provider: aiProvider, model: aiModel, attempt: attempt + 1 });
        return { mode: 'live', task, summary: text, trace: demoResult(task).trace, sources, requiresApproval: true };
      }
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      lastFailure = { status: response.status, retryable };
      logEvent('agent.provider_error', { provider: aiProvider, model: aiModel, status: response.status, attempt: attempt + 1 });
      if (!retryable || attempt >= aiMaxRetries) break;
    } catch (error) {
      const retryable = error.name === 'AbortError' || error.code === 'UND_ERR_CONNECT_TIMEOUT' || error.status >= 500;
      lastFailure = { status: error.name === 'AbortError' ? 408 : 0, retryable, message: error.message };
      logEvent('agent.provider_exception', { provider: aiProvider, model: aiModel, code: error.name || error.code || 'unknown', attempt: attempt + 1, message: redact(error.message) });
      if (!retryable || attempt >= aiMaxRetries) break;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(2_000, 250 * (2 ** attempt))));
  }
  const failureCode = lastFailure?.status === 401 || lastFailure?.status === 403 ? 'provider_auth_failed' : lastFailure?.status === 429 ? 'provider_rate_limited' : lastFailure?.status === 408 ? 'provider_timeout' : 'provider_unavailable';
  return { ...demoResult(task), sources, mode: 'fallback', summary: `AI 服务未能完成本次请求（${failureCode}），已安全降级为演示结果。`, providerError: failureCode, failure: { code: failureCode, retryable: Boolean(lastFailure?.retryable) } };
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

const supportedKnowledgeFiles = new Map([
  ['.pdf', ['application/pdf']],
  ['.docx', ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/octet-stream']],
  ['.xlsx', ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/octet-stream']],
  ['.csv', ['text/csv', 'application/csv', 'application/octet-stream']],
  ['.txt', ['text/plain', 'application/octet-stream']],
]);

function safeFileName(name) {
  return String(name || 'upload').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'upload';
}

function validateFileBuffer({ name, mimeType, buffer }) {
  const extension = extname(name).toLowerCase();
  const allowedMimeTypes = supportedKnowledgeFiles.get(extension);
  if (!allowedMimeTypes) throw httpError(415, 'Only PDF, DOCX, XLSX, CSV and TXT files are supported', 'unsupported_file_type');
  if (buffer.length > knowledgeFileLimitBytes) throw httpError(413, `File exceeds ${knowledgeFileLimitBytes} bytes`, 'file_too_large');
  if (!allowedMimeTypes.includes(mimeType || 'application/octet-stream')) throw httpError(415, 'File MIME type does not match the supported extension', 'mime_mismatch');
  const isPdf = extension === '.pdf' && buffer.subarray(0, 5).toString() === '%PDF-';
  const isZipDocument = ['.docx', '.xlsx'].includes(extension) && buffer.subarray(0, 2).toString() === 'PK';
  const isText = ['.csv', '.txt'].includes(extension);
  if (!isPdf && !isZipDocument && !isText) throw httpError(415, 'File signature is invalid for the declared type', 'invalid_file_signature');
  return extension;
}

async function extractFileText({ name, mimeType, buffer }) {
  const extension = validateFileBuffer({ name, mimeType, buffer });
  if (extension === '.txt' || extension === '.csv') return buffer.toString('utf8');
  if (extension === '.pdf') {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    await parser.destroy?.();
    return result.text || '';
  }
  if (extension === '.docx') {
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return result.value || '';
  }
  const xlsx = await import('xlsx');
  const workbook = xlsx.read(buffer, { type: 'buffer', dense: true, cellDates: true });
  return workbook.SheetNames.map((sheetName) => `## ${sheetName}\n${xlsx.utils.sheet_to_csv(workbook.Sheets[sheetName])}`).join('\n\n');
}

async function storageRequest(path, options = {}) {
  if (!supabaseUrl || !supabaseKey) throw httpError(503, 'Supabase Storage is not configured', 'storage_unavailable');
  const response = await fetchWithTimeout(`${supabaseUrl}/storage/v1/${path}`, { ...options, headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, ...(options.headers || {}) } }, 20_000);
  if (!response.ok) throw httpError(response.status === 404 ? 503 : response.status, `Storage request failed: ${response.status}`, 'storage_request_failed');
  return response;
}

async function uploadKnowledgeFile({ name, mimeType, buffer }) {
  const workspace = await requireWorkspaceMember(['owner', 'admin', 'member']);
  const extension = validateFileBuffer({ name, mimeType, buffer });
  const storagePath = `${workspace.id}/${randomUUID()}-${safeFileName(name)}`;
  await storageRequest(`object/${encodeURIComponent(knowledgeStorageBucket)}/${storagePath}`, { method: 'POST', headers: { 'Content-Type': mimeType, 'x-upsert': 'false' }, body: buffer });
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const headers = { 'Content-Type': 'application/json', apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, Prefer: 'return=representation' };
  const documentResponse = await fetchWithTimeout(`${supabaseUrl}/rest/v1/knowledge_documents`, { method: 'POST', headers, body: JSON.stringify({ workspace_id: workspace.id, owner_id: currentScope().userId || null, title: name, source_type: 'upload', file_name: name, storage_path: storagePath, mime_type: mimeType, file_size_bytes: buffer.length, sha256, status: 'uploaded' }) }, 10_000);
  if (!documentResponse.ok) {
    try { await storageRequest(`object/${encodeURIComponent(knowledgeStorageBucket)}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([storagePath]) }); } catch {}
    throw httpError(503, 'Knowledge file migration is not applied; run the production hardening migration first', 'knowledge_schema_required');
  }
  const rows = await documentResponse.json();
  const document = rows?.[0];
  if (!document?.id) throw httpError(502, 'Knowledge document was not created', 'document_create_failed');
  setImmediate(() => processKnowledgeDocument({ documentId: document.id, workspaceId: workspace.id, storagePath, name, mimeType, buffer }).catch((error) => logEvent('knowledge.processing_failed', { document_id: document.id, code: error.code || 'processing_error', message: redact(error.message) })));
  return { mode: 'supabase', documentId: document.id, title: name, status: 'uploaded', extension };
}

async function processKnowledgeDocument({ documentId, workspaceId, storagePath, name, mimeType, buffer }) {
  const headers = { 'Content-Type': 'application/json', apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, Prefer: 'return=representation' };
  await fetchWithTimeout(`${supabaseUrl}/rest/v1/knowledge_documents?id=eq.${encodeURIComponent(documentId)}&workspace_id=eq.${encodeURIComponent(workspaceId)}`, { method: 'PATCH', headers, body: JSON.stringify({ status: 'processing', error_message: null }) }, 10_000);
  try {
    const text = await extractFileText({ name, mimeType, buffer });
    const chunks = splitText(text);
    if (!chunks.length) throw httpError(422, 'The file did not contain extractable text', 'empty_document');
    await fetchWithTimeout(`${supabaseUrl}/rest/v1/knowledge_chunks`, { method: 'POST', headers, body: JSON.stringify(chunks.map((content, index) => ({ document_id: documentId, content, metadata: { title: name, chunk: index, source: 'file' } }))) }, 20_000);
    await fetchWithTimeout(`${supabaseUrl}/rest/v1/knowledge_documents?id=eq.${encodeURIComponent(documentId)}&workspace_id=eq.${encodeURIComponent(workspaceId)}`, { method: 'PATCH', headers, body: JSON.stringify({ status: 'indexed', indexed_at: new Date().toISOString() }) }, 10_000);
    logEvent('knowledge.indexed', { document_id: documentId, chunks: chunks.length });
  } catch (error) {
    await fetchWithTimeout(`${supabaseUrl}/rest/v1/knowledge_documents?id=eq.${encodeURIComponent(documentId)}&workspace_id=eq.${encodeURIComponent(workspaceId)}`, { method: 'PATCH', headers, body: JSON.stringify({ status: 'failed', error_message: redact(error.message) }) }, 10_000).catch(() => {});
    throw error;
  }
}

async function deleteKnowledgeDocument(documentId) {
  const workspace = await requireWorkspaceMember(['owner', 'admin']);
  const headers = { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` };
  const documentResponse = await fetchWithTimeout(`${supabaseUrl}/rest/v1/knowledge_documents?select=id,storage_path&workspace_id=eq.${encodeURIComponent(workspace.id)}&id=eq.${encodeURIComponent(documentId)}&limit=1`, { headers }, 10_000);
  if (!documentResponse.ok) throw new Error(`Knowledge document lookup failed: ${documentResponse.status}`);
  const document = (await documentResponse.json())?.[0];
  if (!document) throw httpError(404, 'Document not found', 'document_not_found');
  if (document.storage_path) await storageRequest(`object/${encodeURIComponent(knowledgeStorageBucket)}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([document.storage_path]) });
  await fetchWithTimeout(`${supabaseUrl}/rest/v1/knowledge_documents?id=eq.${encodeURIComponent(documentId)}&workspace_id=eq.${encodeURIComponent(workspace.id)}`, { method: 'DELETE', headers }, 10_000);
  return { deleted: true, documentId };
}

async function reindexKnowledgeDocument(documentId) {
  const workspace = await requireWorkspaceMember(['owner', 'admin', 'member']);
  const headers = { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` };
  const documentResponse = await fetchWithTimeout(`${supabaseUrl}/rest/v1/knowledge_documents?select=id,file_name,storage_path,mime_type&workspace_id=eq.${encodeURIComponent(workspace.id)}&id=eq.${encodeURIComponent(documentId)}&limit=1`, { headers }, 10_000);
  if (!documentResponse.ok) throw new Error(`Knowledge document lookup failed: ${documentResponse.status}`);
  const document = (await documentResponse.json())?.[0];
  if (!document?.storage_path) throw httpError(422, 'Document has no stored source file', 'document_source_missing');
  const fileResponse = await storageRequest(`object/${encodeURIComponent(knowledgeStorageBucket)}/${document.storage_path}`, { headers });
  const buffer = Buffer.from(await fileResponse.arrayBuffer());
  await processKnowledgeDocument({ documentId: document.id, workspaceId: workspace.id, storagePath: document.storage_path, name: document.file_name || 'document', mimeType: document.mime_type || 'application/octet-stream', buffer });
  return { documentId, status: 'indexed' };
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
  const workspace = await requireWorkspaceMember();
  const params = new URLSearchParams({ select: 'id,content,metadata,knowledge_documents!inner(workspace_id)', limit: String(limit), order: 'created_at.desc' });
  params.set('knowledge_documents.workspace_id', `eq.${workspace.id}`);
  if (query.trim()) params.set('content', `ilike.*${query.trim().replace(/[,*]/g, ' ')}*`);
  const response = await fetchWithTimeout(`${supabaseUrl}/rest/v1/knowledge_chunks?${params.toString()}`, { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }, 10_000);
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
  const workspace = await requireWorkspaceMember(['owner', 'admin', 'member']);
  const workspaceId = workspace.id;
  const documentResponse = await fetchWithTimeout(`${supabaseUrl}/rest/v1/knowledge_documents`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, Prefer: 'return=representation' },
    body: JSON.stringify({ workspace_id: workspaceId, title }),
  });
  const documents = await documentResponse.json();
  const documentId = documents?.[0]?.id;
  if (!documentId) throw new Error('Knowledge document insert failed');
  const chunkResponse = await fetchWithTimeout(`${supabaseUrl}/rest/v1/knowledge_chunks`, {
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
  const workspace = await requireWorkspaceMember();
  const response = await fetchWithTimeout(`${supabaseUrl}/rest/v1/knowledge_documents?select=*&workspace_id=eq.${encodeURIComponent(workspace.id)}&order=created_at.desc`, { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }, 10_000);
  if (!response.ok) throw new Error(`Knowledge document list failed: ${response.status}`);
  return response.json();
}

async function listApprovals() {
  if (!supabaseUrl || !supabaseKey) return memoryTasks.filter((item) => item.status === 'approval').map((item) => ({ id: item.id, task_id: item.id, action: 'generate_report', status: 'pending', task: item.title }));
  const workspace = await requireWorkspaceMember();
  const response = await fetchWithTimeout(`${supabaseUrl}/rest/v1/approval_requests?select=id,task_id,action,payload,status,created_at,resolved_at,tasks!inner(title,status,workspace_id)&tasks.workspace_id=eq.${encodeURIComponent(workspace.id)}&order=created_at.desc`, { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }, 10_000);
  if (!response.ok) throw new Error(`Approval list failed: ${response.status}`);
  return response.json();
}

async function listAgentRuns(taskId) {
  if (!supabaseUrl || !supabaseKey) return [];
  const workspace = await requireWorkspaceMember();
  const filter = taskId ? `&task_id=eq.${encodeURIComponent(taskId)}` : '';
  const response = await fetchWithTimeout(`${supabaseUrl}/rest/v1/agent_runs?select=id,task_id,status,model,input,output,started_at,finished_at,tasks!inner(workspace_id)&tasks.workspace_id=eq.${encodeURIComponent(workspace.id)}&order=started_at.desc&limit=100${filter}`, { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }, 10_000);
  if (!response.ok) throw new Error(`Agent run list failed: ${response.status}`);
  return response.json();
}

async function listAuditEvents(taskId) {
  if (!supabaseUrl || !supabaseKey) return [];
  const workspace = await requireWorkspaceMember();
  const filter = taskId ? `&task_id=eq.${encodeURIComponent(taskId)}` : '';
  const response = await fetchWithTimeout(`${supabaseUrl}/rest/v1/audit_events?select=id,workspace_id,task_id,event_type,payload,created_at&workspace_id=eq.${encodeURIComponent(workspace.id)}&order=created_at.desc&limit=100${filter}`, { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }, 10_000);
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
  const workspace = workspaceId ? { id: workspaceId } : await requireWorkspaceMember();
  await fetchWithTimeout(`${supabaseUrl}/rest/v1/audit_events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
    body: JSON.stringify({ workspace_id: workspace.id, task_id: taskId || null, event_type: eventType, payload }),
  }, 10_000);
}

async function persistTask(result, idempotencyKey = null) {
  if (!supabaseUrl || !supabaseKey) {
    memoryTasks.unshift({ id: `memory-task-${Date.now()}`, title: result.task, status: 'approval', date: new Date().toISOString().slice(0, 10), owner: 'AI Agent' });
    const persisted = { persisted: false, mode: 'memory' };
    return persisted;
  }
  const workspace = await requireWorkspaceMember(['owner', 'admin', 'member']);
  const headers = {
    'Content-Type': 'application/json',
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
    Prefer: 'return=representation',
  };
  if (idempotencyKey) {
    const existingResponse = await fetchWithTimeout(`${supabaseUrl}/rest/v1/tasks?select=id,status&workspace_id=eq.${encodeURIComponent(workspace.id)}&idempotency_key=eq.${encodeURIComponent(idempotencyKey)}&limit=1`, { headers }, 10_000);
    if (existingResponse.ok) {
      const existing = await existingResponse.json();
      if (existing?.[0]) return { persisted: true, duplicate: true, taskId: existing[0].id, status: existing[0].status };
    }
  }
  const taskStatus = result.mode === 'fallback' ? 'failed' : 'approval';
  const taskPayload = { workspace_id: workspace.id, title: result.task, status: taskStatus, input: { source: 'agent', idempotency_key: idempotencyKey }, result, idempotency_key: idempotencyKey };
  let migrationWarning = null;
  let taskResponse = await fetchWithTimeout(`${supabaseUrl}/rest/v1/tasks`, {
    method: 'POST', headers,
    body: JSON.stringify(taskPayload),
  }, 10_000);
  if (!taskResponse.ok && idempotencyKey) {
    migrationWarning = 'task_idempotency_migration_required';
    const legacyPayload = { ...taskPayload };
    delete legacyPayload.idempotency_key;
    taskResponse = await fetchWithTimeout(`${supabaseUrl}/rest/v1/tasks`, { method: 'POST', headers, body: JSON.stringify(legacyPayload) }, 10_000);
  }
  if (!taskResponse.ok) throw new Error(`Supabase task insert failed: ${taskResponse.status}`);
  const taskRows = await taskResponse.json();
  const taskId = taskRows?.[0]?.id;
  if (taskId) {
    await fetchWithTimeout(`${supabaseUrl}/rest/v1/agent_runs`, {
      method: 'POST', headers,
      body: JSON.stringify({ task_id: taskId, status: 'completed', model: aiModel || 'demo', input: { task: result.task }, output: result }),
    }, 10_000);
    if (taskStatus === 'approval') await fetchWithTimeout(`${supabaseUrl}/rest/v1/approval_requests`, {
      method: 'POST', headers,
      body: JSON.stringify({ task_id: taskId, action: 'generate_report', payload: { source: 'agent', requiresApproval: true }, status: 'pending' }),
    }, 10_000);
    await writeAuditEvent({ workspaceId: workspace.id, taskId, eventType: result.mode === 'fallback' ? 'agent.failed' : 'agent.completed', payload: { mode: result.mode, providerError: result.providerError || null } });
  }
  return { persisted: true, taskId, migrationWarning };
}

async function listTasks() {
  if (!supabaseUrl || !supabaseKey) return memoryTasks;
  const workspace = await requireWorkspaceMember();
  const response = await fetchWithTimeout(`${supabaseUrl}/rest/v1/tasks?select=id,title,status,created_at,updated_at&workspace_id=eq.${encodeURIComponent(workspace.id)}&order=updated_at.desc`, { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }, 10_000);
  if (!response.ok) throw new Error(`Task list failed: ${response.status}`);
  return response.json();
}

async function listWorkspaces() {
  if (!supabaseUrl || !supabaseKey) return [{ id: 'memory-workspace', name: '华东销售团队', created_at: null }];
  const scope = currentScope();
  if (scope.demo && !requireAuth) {
    const response = await fetchWithTimeout(`${supabaseUrl}/rest/v1/workspaces?select=id,name,created_at&order=created_at.asc&limit=1`, { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }, 10_000);
    if (!response.ok) throw new Error(`Workspace list failed: ${response.status}`);
    return response.json();
  }
  const workspace = await requireWorkspaceMember();
  return [{ id: workspace.id, name: workspace.name, created_at: workspace.created_at }];
}

async function listTeam() {
  if (!supabaseUrl || !supabaseKey) return memoryTeam;
  const workspace = await requireWorkspaceMember();
  const response = await fetchWithTimeout(`${supabaseUrl}/rest/v1/workspace_members?select=id,user_id,role,created_at&workspace_id=eq.${encodeURIComponent(workspace.id)}&order=created_at.asc`, { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }, 10_000);
  if (!response.ok) throw new Error(`Team list failed: ${response.status}`);
  return response.json();
}

async function updateTeamMember(memberId, role) {
  if (!['admin', 'member', 'viewer'].includes(role)) throw httpError(400, 'invalid member role', 'invalid_role');
  const workspace = await requireWorkspaceMember(['owner', 'admin']);
  const headers = { 'Content-Type': 'application/json', apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, Prefer: 'return=representation' };
  const lookup = await fetchWithTimeout(`${supabaseUrl}/rest/v1/workspace_members?select=id,role&workspace_id=eq.${encodeURIComponent(workspace.id)}&id=eq.${encodeURIComponent(memberId)}&limit=1`, { headers }, 10_000);
  const member = (await lookup.json())?.[0];
  if (!member) throw httpError(404, 'Member not found', 'member_not_found');
  if (member.role === 'owner') throw httpError(409, 'Workspace owner role cannot be changed', 'owner_protected');
  const response = await fetchWithTimeout(`${supabaseUrl}/rest/v1/workspace_members?id=eq.${encodeURIComponent(memberId)}&workspace_id=eq.${encodeURIComponent(workspace.id)}`, { method: 'PATCH', headers, body: JSON.stringify({ role }) }, 10_000);
  if (!response.ok) throw new Error(`Member role update failed: ${response.status}`);
  return (await response.json())?.[0] || null;
}

async function removeTeamMember(memberId) {
  const workspace = await requireWorkspaceMember(['owner', 'admin']);
  const headers = { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` };
  const lookup = await fetchWithTimeout(`${supabaseUrl}/rest/v1/workspace_members?select=id,role&workspace_id=eq.${encodeURIComponent(workspace.id)}&id=eq.${encodeURIComponent(memberId)}&limit=1`, { headers }, 10_000);
  const member = (await lookup.json())?.[0];
  if (!member) throw httpError(404, 'Member not found', 'member_not_found');
  if (member.role === 'owner') throw httpError(409, 'Workspace owner cannot be removed', 'owner_protected');
  const response = await fetchWithTimeout(`${supabaseUrl}/rest/v1/workspace_members?id=eq.${encodeURIComponent(memberId)}&workspace_id=eq.${encodeURIComponent(workspace.id)}`, { method: 'DELETE', headers }, 10_000);
  if (!response.ok) throw new Error(`Member removal failed: ${response.status}`);
  return { removed: true, memberId };
}

async function inviteTeamMember({ email, role = 'member' }) {
  if (!supabaseUrl || !supabaseKey) {
    const token = randomUUID();
    const invitation = { id: `invite-${Date.now()}`, email, role, status: 'pending', created_at: new Date().toISOString(), expires_at: new Date(Date.now() + invitationExpiresHours * 3_600_000).toISOString(), invite_url: `${invitationBaseUrl}/#invite=${token}`, delivery: 'manual_test_link' };
    memoryTeam.push(invitation);
    return invitation;
  }
  const workspace = await requireWorkspaceMember(['owner', 'admin']);
  const token = randomUUID();
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const response = await fetchWithTimeout(`${supabaseUrl}/rest/v1/workspace_invitations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, Prefer: 'return=representation' },
    body: JSON.stringify({ workspace_id: workspace.id, email, role, token_hash: tokenHash, expires_at: new Date(Date.now() + invitationExpiresHours * 3_600_000).toISOString() }),
  }, 10_000);
  if (!response.ok) throw new Error(`Invitation create failed: ${response.status}`);
  const rows = await response.json();
  const invitation = rows?.[0] || null;
  return invitation ? { ...invitation, invite_url: `${invitationBaseUrl}/#invite=${token}`, delivery: 'manual_test_link' } : null;
}

async function respondToInvitation(token, action = 'accept') {
  if (!token || !['accept', 'reject'].includes(action)) throw httpError(400, 'valid invitation token and action are required', 'invalid_invitation');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  if (!supabaseUrl || !supabaseKey) {
    const invitation = memoryTeam.find((item) => item.invite_url?.endsWith(token));
    if (!invitation || invitation.status !== 'pending' || new Date(invitation.expires_at) <= new Date()) throw httpError(410, 'Invitation is expired or already used', 'invitation_expired');
    invitation.status = action === 'accept' ? 'accepted' : 'revoked';
    return { status: invitation.status, mode: 'memory' };
  }
  const scope = currentScope();
  if (!scope.userId) throw httpError(401, 'Login is required to accept an invitation', 'auth_required');
  const headers = { 'Content-Type': 'application/json', apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, Prefer: 'return=representation' };
  const response = await fetchWithTimeout(`${supabaseUrl}/rest/v1/workspace_invitations?select=id,workspace_id,email,role,status,expires_at&token_hash=eq.${encodeURIComponent(tokenHash)}&limit=1`, { headers }, 10_000);
  if (!response.ok) throw new Error(`Invitation lookup failed: ${response.status}`);
  const invitation = (await response.json())?.[0];
  if (!invitation || invitation.status !== 'pending' || new Date(invitation.expires_at) <= new Date()) throw httpError(410, 'Invitation is expired or already used', 'invitation_expired');
  const nextStatus = action === 'accept' ? 'accepted' : 'revoked';
  if (action === 'accept') {
    const memberResponse = await fetchWithTimeout(`${supabaseUrl}/rest/v1/workspace_members?on_conflict=workspace_id,user_id`, { method: 'POST', headers, body: JSON.stringify({ workspace_id: invitation.workspace_id, user_id: scope.userId, role: invitation.role }) }, 10_000);
    if (!memberResponse.ok) throw new Error(`Membership create failed: ${memberResponse.status}`);
  }
  await fetchWithTimeout(`${supabaseUrl}/rest/v1/workspace_invitations?id=eq.${encodeURIComponent(invitation.id)}&status=eq.pending`, { method: 'PATCH', headers, body: JSON.stringify({ status: nextStatus, accepted_at: action === 'accept' ? new Date().toISOString() : null }) }, 10_000);
  return { status: nextStatus, workspaceId: invitation.workspace_id };
}

async function listIntegrations() {
  if (!supabaseUrl || !supabaseKey) return memoryIntegrations;
  const workspace = await requireWorkspaceMember();
  const response = await fetchWithTimeout(`${supabaseUrl}/rest/v1/integrations?select=id,provider,name,status,created_at,updated_at&workspace_id=eq.${encodeURIComponent(workspace.id)}&order=created_at.asc`, { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }, 10_000);
  if (!response.ok) throw new Error(`Integration list failed: ${response.status}`);
  return response.json();
}

async function updateIntegration(provider, status) {
  if (!['disabled', 'pending', 'error'].includes(status)) throw httpError(409, 'OAuth or webhook verification is required before an integration can be connected', 'integration_not_configured');
  if (!supabaseUrl || !supabaseKey) {
    const item = memoryIntegrations.find((integration) => integration.provider === provider);
    if (!item) throw new Error('Integration not found');
    item.status = status;
    return item;
  }
  const workspace = await requireWorkspaceMember(['owner', 'admin']);
  const response = await fetchWithTimeout(`${supabaseUrl}/rest/v1/integrations?workspace_id=eq.${encodeURIComponent(workspace.id)}&provider=eq.${encodeURIComponent(provider)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, Prefer: 'return=representation' },
    body: JSON.stringify({ status, updated_at: new Date().toISOString() }),
  }, 10_000);
  if (!response.ok) throw new Error(`Integration update failed: ${response.status}`);
  const rows = await response.json();
  return rows?.[0] || null;
}

async function getSettings() {
  if (!supabaseUrl || !supabaseKey) return memorySettings;
  const workspace = await requireWorkspaceMember();
  const response = await fetchWithTimeout(`${supabaseUrl}/rest/v1/workspace_settings?select=workspace_id,ai_model,approval_required,max_concurrent_runs,updated_at&workspace_id=eq.${encodeURIComponent(workspace.id)}&limit=1`, { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }, 10_000);
  if (!response.ok) throw new Error(`Settings load failed: ${response.status}`);
  const rows = await response.json();
  return rows?.[0] || { ai_model: aiModel, approval_required: true, max_concurrent_runs: 3 };
}

async function updateSettings(patch) {
  const next = { ai_model: patch.ai_model || aiModel, approval_required: patch.approval_required !== false, max_concurrent_runs: Math.min(20, Math.max(1, Number(patch.max_concurrent_runs || 3))) };
  if (!supabaseUrl || !supabaseKey) { Object.assign(memorySettings, next); return memorySettings; }
  const workspace = await requireWorkspaceMember(['owner', 'admin']);
  const response = await fetchWithTimeout(`${supabaseUrl}/rest/v1/workspace_settings?on_conflict=workspace_id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({ workspace_id: workspace.id, ...next, updated_at: new Date().toISOString() }),
  }, 10_000);
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
  const workspace = await requireWorkspaceMember(['owner', 'admin', 'member']);
  const response = await fetchWithTimeout(`${supabaseUrl}/rest/v1/tasks`, { method: 'POST', headers, body: JSON.stringify({ workspace_id: workspace.id, title, status, input }) }, 10_000);
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
  const workspace = await requireWorkspaceMember(['owner', 'admin', 'member']);
  const response = await fetchWithTimeout(`${supabaseUrl}/rest/v1/tasks?id=eq.${encodeURIComponent(taskId)}&workspace_id=eq.${encodeURIComponent(workspace.id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, Prefer: 'return=representation' },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  }, 10_000);
  if (!response.ok) throw new Error(`Task update failed: ${response.status}`);
  const rows = await response.json();
  return rows?.[0] || null;
}

async function getTask(taskId) {
  if (!supabaseUrl || !supabaseKey) {
    const task = memoryTasks.find((item) => item.id === taskId);
    return task || null;
  }
  const workspace = await requireWorkspaceMember();
  const response = await fetchWithTimeout(`${supabaseUrl}/rest/v1/tasks?select=*&id=eq.${encodeURIComponent(taskId)}&workspace_id=eq.${encodeURIComponent(workspace.id)}&limit=1`, { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }, 10_000);
  if (!response.ok) throw new Error(`Task detail failed: ${response.status}`);
  const rows = await response.json();
  return rows?.[0] || null;
}

async function listKnowledgeChunks(documentId) {
  if (!supabaseUrl || !supabaseKey) {
    return memoryDocuments.filter((item) => !documentId || item.document_id === documentId).map(({ content, metadata, ...item }) => ({ ...item, content, metadata }));
  }
  const workspace = await requireWorkspaceMember();
  const filter = documentId ? `&document_id=eq.${encodeURIComponent(documentId)}` : '';
  const response = await fetchWithTimeout(`${supabaseUrl}/rest/v1/knowledge_chunks?select=id,document_id,content,metadata,created_at,knowledge_documents!inner(workspace_id)&knowledge_documents.workspace_id=eq.${encodeURIComponent(workspace.id)}&order=created_at.asc&limit=200${filter}`, { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }, 10_000);
  if (!response.ok) throw new Error(`Knowledge chunk list failed: ${response.status}`);
  return response.json();
}

async function approveTask(taskId, action) {
  if (!['approve', 'reject', 'generate_report'].includes(action)) throw httpError(400, 'invalid approval action', 'invalid_approval_action');
  const task = memoryTasks.find(item => item.id === taskId);
  if (!supabaseUrl || !supabaseKey) {
    if (task) task.status = 'completed';
    return { approved: true, mode: 'memory', taskId, action };
  }
  const workspace = await requireWorkspaceMember(['owner', 'admin', 'member']);
  const response = await fetchWithTimeout(`${supabaseUrl}/rest/v1/tasks?id=eq.${encodeURIComponent(taskId)}&workspace_id=eq.${encodeURIComponent(workspace.id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, Prefer: 'return=representation' },
    body: JSON.stringify({ status: action === 'reject' ? 'failed' : 'completed', result: { approvedAction: action, approvedAt: new Date().toISOString() } }),
  }, 10_000);
  if (!response.ok) throw new Error(`Task approval failed: ${response.status}`);
  const approvalResponse = await fetchWithTimeout(`${supabaseUrl}/rest/v1/approval_requests?task_id=eq.${encodeURIComponent(taskId)}&status=eq.pending&order=created_at.desc&limit=1`, { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }, 10_000);
  const approvals = await approvalResponse.json();
  if (approvals?.[0]?.id) {
    await fetchWithTimeout(`${supabaseUrl}/rest/v1/approval_requests?id=eq.${encodeURIComponent(approvals[0].id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
      body: JSON.stringify({ status: action === 'reject' ? 'rejected' : 'approved', resolved_at: new Date().toISOString() }),
    }, 10_000);
  }
  await writeAuditEvent({ taskId, eventType: action === 'reject' ? 'approval.rejected' : 'approval.approved', payload: { action } });
  return { approved: action !== 'reject', mode: 'supabase', taskId, action };
}

async function handleRequest(request, response) {
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'SAMEORIGIN');
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
  if (request.method === 'POST' && isRateLimited(request)) {
    response.writeHead(429, { 'Retry-After': '60' });
    response.end(JSON.stringify({ error: 'Too many requests. Please retry later.' }));
    return;
  }
  if (request.method === 'GET' && request.url === '/api/health') {
    response.writeHead(200); response.end(JSON.stringify({ ok: true, service: 'flowpilot-api', aiConfigured: Boolean(aiApiKey), supabaseConfigured: Boolean(supabaseUrl && supabaseKey), time: new Date().toISOString() })); return;
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
  if (request.method === 'POST' && request.url === '/api/integrations/webhook') {
    try {
      const rawBody = await readRawBody(request);
      const verification = verifyWebhookSignature(request, rawBody);
      if (verification.duplicate) { response.writeHead(200); response.end(JSON.stringify({ accepted: true, duplicate: true, eventId: verification.eventId })); return; }
      let payload = {};
      try { payload = JSON.parse(rawBody || '{}'); } catch { throw httpError(400, 'Webhook payload must be valid JSON', 'webhook_invalid_json'); }
      const workspaceId = request.headers['x-workspace-id'] || payload.workspace_id;
      if (supabaseUrl && supabaseKey) {
        if (!workspaceId) throw httpError(400, 'x-workspace-id is required for webhook delivery', 'webhook_workspace_required');
        await fetchWithTimeout(`${supabaseUrl}/rest/v1/audit_events`, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` }, body: JSON.stringify({ workspace_id: workspaceId, event_type: 'integration.webhook_received', payload: { event_id: verification.eventId, type: payload.type || 'unknown' } }) }, 10_000);
      }
      response.writeHead(202); response.end(JSON.stringify({ accepted: true, duplicate: false, eventId: verification.eventId, mode: supabaseUrl ? 'supabase' : 'memory' }));
    } catch (error) { response.writeHead(Number(error.status) || 500); response.end(JSON.stringify({ error: error.message, code: error.code || 'webhook_failed' })); }
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
  if (request.method === 'POST' && request.url === '/api/team/invitations/respond') {
    try {
      const payload = await readJsonBody(request);
      response.writeHead(200); response.end(JSON.stringify(await respondToInvitation(payload.token, payload.action || 'accept')));
    } catch (error) { response.writeHead(Number(error.status) || 500); response.end(JSON.stringify({ error: error.message, code: error.code || 'invitation_failed' })); }
    return;
  }
  if (request.method === 'PATCH' && request.url.startsWith('/api/team/members/')) {
    try {
      const memberId = request.url.split('/')[4];
      const payload = await readJsonBody(request);
      response.writeHead(200); response.end(JSON.stringify({ member: await updateTeamMember(memberId, payload.role) }));
    } catch (error) { response.writeHead(Number(error.status) || 500); response.end(JSON.stringify({ error: error.message, code: error.code || 'member_update_failed' })); }
    return;
  }
  if (request.method === 'DELETE' && request.url.startsWith('/api/team/members/')) {
    try {
      const memberId = request.url.split('/')[4];
      response.writeHead(200); response.end(JSON.stringify(await removeTeamMember(memberId)));
    } catch (error) { response.writeHead(Number(error.status) || 500); response.end(JSON.stringify({ error: error.message, code: error.code || 'member_remove_failed' })); }
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
        if (['pending', 'running', 'approval', 'completed', 'failed', 'cancelled'].includes(payload.status)) allowed.status = payload.status;
        if (!Object.keys(allowed).length) { response.writeHead(400); response.end(JSON.stringify({ error: 'title or valid status is required' })); return; }
        if (allowed.status) {
          const existing = await getTask(taskId);
          if (!existing) { response.writeHead(404); response.end(JSON.stringify({ error: 'Task not found' })); return; }
          validateStatusTransition(existing.status, allowed.status);
        }
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
  if (request.method === 'POST' && request.url === '/api/knowledge/files') {
    try {
      const payload = await readJsonBody(request);
      const name = safeFileName(payload.name);
      const mimeType = String(payload.mimeType || 'application/octet-stream');
      const raw = String(payload.base64 || '').replace(/^data:[^;]+;base64,/, '');
      if (!raw) throw httpError(400, 'base64 file content is required', 'file_content_required');
      const buffer = Buffer.from(raw, 'base64');
      validateFileBuffer({ name, mimeType, buffer });
      if (!supabaseUrl || !supabaseKey) {
        const text = await extractFileText({ name, mimeType, buffer });
        const chunks = splitText(text);
        memoryDocuments.push(...chunks.map((content, index) => ({ id: `memory-file-${Date.now()}-${index}`, title: name, content, metadata: { title: name, chunk: index, source: 'file' } })));
        response.writeHead(202); response.end(JSON.stringify({ mode: 'memory', title: name, status: 'indexed', chunks: chunks.length })); return;
      }
      response.writeHead(202); response.end(JSON.stringify(await uploadKnowledgeFile({ name, mimeType, buffer }))); return;
    } catch (error) { response.writeHead(Number(error.status) || 500); response.end(JSON.stringify({ error: error.message, code: error.code || 'file_upload_failed' })); }
    return;
  }
  if (request.method === 'DELETE' && request.url.startsWith('/api/knowledge/documents/')) {
    try {
      const documentId = request.url.split('/')[4];
      response.writeHead(200); response.end(JSON.stringify(await deleteKnowledgeDocument(documentId)));
    } catch (error) { response.writeHead(Number(error.status) || 500); response.end(JSON.stringify({ error: error.message, code: error.code || 'document_delete_failed' })); }
    return;
  }
  if (request.method === 'POST' && request.url.startsWith('/api/knowledge/documents/') && request.url.endsWith('/reindex')) {
    try {
      const documentId = request.url.split('/')[4];
      response.writeHead(202); response.end(JSON.stringify(await reindexKnowledgeDocument(documentId)));
    } catch (error) { response.writeHead(Number(error.status) || 500); response.end(JSON.stringify({ error: error.message, code: error.code || 'document_reindex_failed' })); }
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
  try {
      const payload = await readJsonBody(request);
      if (request.url === '/api/knowledge/ingest') {
        if (!payload.title?.trim() || !payload.content?.trim()) { response.writeHead(400); response.end(JSON.stringify({ error: 'title and content are required' })); return; }
        response.writeHead(200); response.end(JSON.stringify(await ingestKnowledge(payload))); return;
      }
      const { task } = payload;
      if (!task?.trim()) { response.writeHead(400); response.end(JSON.stringify({ error: 'task is required' })); return; }
      const idempotencyKey = String(request.headers['idempotency-key'] || payload.idempotencyKey || '').trim().slice(0, 160) || null;
      const existing = await findIdempotentTask(idempotencyKey);
      if (existing) { response.writeHead(200); response.end(JSON.stringify(existing)); return; }
      const result = await runAgent(task.trim());
      const persistence = await persistTask(result, idempotencyKey);
      const output = { ...result, persistence };
      if (idempotencyKey && !supabaseUrl) memoryIdempotency.set(idempotencyKey, output);
      response.writeHead(200); response.end(JSON.stringify(output));
  } catch (error) {
      response.writeHead(Number(error.status) || 500); response.end(JSON.stringify({ error: error.message, code: error.code || 'internal_error' }));
  }
}

const server = createServer(async (request, response) => {
  const startedAt = Date.now();
  try {
    const isPublicHealth = request.method === 'GET' && request.url === '/api/health';
    const isSignedWebhook = request.method === 'POST' && request.url === '/api/integrations/webhook';
    const scope = isPublicHealth || isSignedWebhook || !request.url.startsWith('/api/') ? { userId: null, token: null, workspaceId: request.headers['x-workspace-id'] || null, role: 'owner', requestId: request.headers['x-request-id'] || randomUUID(), demo: true } : await authenticateRequest(request);
    await requestContextStorage.run(scope, async () => {
      response.setHeader('X-Request-Id', scope.requestId);
      try { await handleRequest(request, response); }
      finally { logEvent('request.completed', { route: new URL(request.url, 'http://localhost').pathname, method: request.method, duration_ms: Date.now() - startedAt }); }
    });
  } catch (error) {
    const status = Number(error.status) || 500;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.writeHead(status);
    response.end(JSON.stringify({ error: error.message || 'Internal server error', code: error.code || 'internal_error' }));
  }
});

const host = process.env.HOST || '0.0.0.0';
server.listen(port, host, () => console.log(`FlowPilot API listening on http://${host}:${port}`));
