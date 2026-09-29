import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';

const port = 8789;
let child;
const authPort = 8790;
let authChild;

async function waitForHealth() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('test server did not become healthy');
}

before(async () => {
  child = spawn(process.execPath, ['server.mjs'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, PORT: String(port), API_PORT: String(port), REQUIRE_AUTH: 'false', SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', AI_API_KEY: '', WEBHOOK_SIGNING_SECRET: 'test-webhook-secret' },
    stdio: 'ignore',
  });
  await waitForHealth();
});

after(() => { child?.kill(); authChild?.kill(); });

test('health endpoint is public and reports service status', async () => {
  const response = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
});

test('demo agent fallback persists only one result per idempotency key', async () => {
  const headers = { 'content-type': 'application/json', 'idempotency-key': 'test-idempotency-001' };
  const body = JSON.stringify({ task: '测试 fallback' });
  const first = await fetch(`http://127.0.0.1:${port}/api/agent/run`, { method: 'POST', headers, body });
  const second = await fetch(`http://127.0.0.1:${port}/api/agent/run`, { method: 'POST', headers, body });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal((await first.json()).mode, 'demo');
  assert.equal((await second.json()).duplicate, true);
});

test('file upload rejects MIME and extension mismatch', async () => {
  const base64 = Buffer.from('not a pdf').toString('base64');
  const response = await fetch(`http://127.0.0.1:${port}/api/knowledge/files`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'bad.pdf', mimeType: 'text/plain', base64 }),
  });
  assert.equal(response.status, 415);
  assert.equal((await response.json()).code, 'mime_mismatch');
});

test('signed webhook accepts once and rejects replay', async () => {
  const timestamp = Math.floor(Date.now() / 1000);
  const eventId = 'webhook-test-001';
  const body = JSON.stringify({ type: 'task.updated' });
  const signature = createHmac('sha256', 'test-webhook-secret').update(`${timestamp}.${body}`).digest('hex');
  const headers = { 'content-type': 'application/json', 'x-flowpilot-timestamp': String(timestamp), 'x-flowpilot-signature': `sha256=${signature}`, 'x-flowpilot-event-id': eventId };
  const first = await fetch(`http://127.0.0.1:${port}/api/integrations/webhook`, { method: 'POST', headers, body });
  const second = await fetch(`http://127.0.0.1:${port}/api/integrations/webhook`, { method: 'POST', headers, body });
  assert.equal(first.status, 202);
  assert.equal((await first.json()).duplicate, false);
  assert.equal(second.status, 200);
  assert.equal((await second.json()).duplicate, true);
});

test('production auth mode rejects anonymous business requests', async () => {
  authChild = spawn(process.execPath, ['server.mjs'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, PORT: String(authPort), API_PORT: String(authPort), REQUIRE_AUTH: 'true', SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', AI_API_KEY: '' },
    stdio: 'ignore',
  });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { if ((await fetch(`http://127.0.0.1:${authPort}/api/health`)).ok) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const health = await fetch(`http://127.0.0.1:${authPort}/api/health`);
  const tasks = await fetch(`http://127.0.0.1:${authPort}/api/tasks`);
  assert.equal(health.status, 200);
  assert.equal(tasks.status, 401);
  authChild.kill();
  authChild = null;
});
