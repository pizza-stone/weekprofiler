import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createLocalAIRequestHandler } from '../local-ai-server.mjs';

async function fixture(handlers = {}) {
  const htmlPath = fileURLToPath(new URL('./fixtures/local-ai.html', import.meta.url));
  const calls = [];
  const handleRequest = createLocalAIRequestHandler({
    htmlPath,
    env: { OPENAI_API_KEY: 'test-only-secret-do-not-echo', OPENAI_MODEL: 'test-model' },
    statusHandler: () => ({ configured: true, provider: 'codex', authMethod: 'chatgpt', model: 'test-model', apiKey: 'test-only-secret-do-not-echo' }),
    planHandler: async (request, env, userId) => {
      calls.push({ body: await request.json(), userId });
      return Response.json({ proposal: { reply: 'Mock plan', assignments: [] } });
    },
    ...handlers,
  });
  const port = 5173;
  const origin = 'http://127.0.0.1:' + port;
  async function request(path, { method = 'GET', headers = {}, body = '', peer = '127.0.0.1', observe } = {}) {
    const req = Readable.from(body ? [Buffer.from(body)] : []);
    Object.assign(req, {
      url: path, method, socket: { remoteAddress: peer },
      headers: Object.fromEntries(Object.entries({ Host: '127.0.0.1:' + port, ...headers }).map(([key,value]) => [key.toLowerCase(),value])),
    });
    const result = {};
    const response = Object.assign(new EventEmitter(), {
      headersSent: false,
      writableEnded: false,
      destroyed: false,
      writeHead(status, values) {
        this.headersSent = true;
        result.status = status;
        result.headers = Object.fromEntries(Object.entries(values).map(([key,value]) => [key.toLowerCase(),value]));
      },
      end(value) {
        result.text = value === undefined ? '' : Buffer.from(value).toString();
        this.writableEnded = true;
        this.emit('close');
      },
    });
    observe?.(req, response);
    await handleRequest(req, response);
    return result;
  }
  return {
    request, origin, calls,
    async close() {},
  };
}

test('loopback HTML and status are served without secret fields', async () => {
  const f = await fixture();
  try {
    const page = await f.request('/');
    assert.equal(page.status, 200);
    assert.match(page.text, /weekprofiler test/);
    assert.equal(page.headers['cache-control'], 'no-store');
    for (const path of ['/weekprofiler-preview.html', '/dayloom-preview.html']) {
      const alias = await f.request(path);
      assert.equal(alias.status, 200);
      assert.equal(alias.text, page.text);
    }
    const status = await f.request('/api/ai/status');
    assert.equal(status.status, 200);
    assert.deepEqual(JSON.parse(status.text), { configured: true, provider: 'codex', authMethod: 'chatgpt', model: 'test-model', code: '', message: '', mode: 'local' });
    assert.doesNotMatch(page.text + status.text, /test-only-secret|apiKey/);
  } finally { await f.close(); }
});

test('foreign hosts, cross-origin pages, file URLs and missing POST Origin are rejected', async () => {
  const f = await fixture();
  try {
    for (const headers of [
      { Host: 'evil.example' },
      { Origin: 'https://evil.example' },
      { Origin: 'null' },
      { 'Sec-Fetch-Site': 'cross-site' },
      {},
    ]) {
      const result = await f.request('/api/ai/plan', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}',
      });
      assert.equal(result.status, 403);
    }
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('same-origin requests invoke the provider adapter with only the requested body', async () => {
  const f = await fixture();
  try {
    const body = { messages: [{ role: 'user', content: 'Plan tomorrow' }], context: { tasks: [] } };
    const result = await f.request('/api/ai/plan', {
      method: 'POST', headers: { Origin: f.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(result.status, 200);
    assert.deepEqual(f.calls, [{ body, userId: 'local-user' }]);
    assert.doesNotMatch(result.text, /test-only-secret/);
  } finally { await f.close(); }
});

test('request size and content-type are bounded before invoking the provider', async () => {
  const f = await fixture();
  try {
    const badType = await f.request('/api/ai/plan', { method: 'POST', headers: { Origin: f.origin }, body: '{}' });
    assert.equal(badType.status, 415);
    const tooLarge = await f.request('/api/ai/plan', {
      method: 'POST', headers: { Origin: f.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'x'.repeat(129 * 1024) }),
    });
    assert.equal(tooLarge.status, 413);
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('provider failure does not expose environment or exception content', async () => {
  const f = await fixture({ planHandler: async () => { throw new Error('test-only-secret-do-not-echo'); } });
  try {
    const result = await f.request('/api/ai/plan', {
      method: 'POST', headers: { Origin: f.origin, 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(result.status, 500);
    assert.equal(JSON.parse(result.text).code, 'local_service_error');
    assert.doesNotMatch(result.text, /test-only-secret/);
  } finally { await f.close(); }
});

test('an unconfigured provider keeps ordinary local planning available', async () => {
  const f = await fixture({
    env: {},
    statusHandler: () => ({ configured: false, provider: 'codex', authMethod: null, model: 'test-model' }),
    planHandler: async () => Response.json({ error: 'Not configured', code: 'ai_not_configured' }, { status: 503 }),
  });
  try {
    assert.equal((await f.request('/')).status, 200);
    assert.equal(JSON.parse((await f.request('/api/ai/status')).text).configured, false);
    const result = await f.request('/api/ai/plan', {
      method: 'POST', headers: { Origin: f.origin, 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(result.status, 503);
  } finally { await f.close(); }
});

test('status does not treat API-key authentication as a configured subscription', async () => {
  const f = await fixture({
    statusHandler: () => ({
      configured: true, provider: 'codex', authMethod: 'apiKey',
      model: 'test-model', message: 'test-only-secret-do-not-echo',
    }),
  });
  try {
    const result = await f.request('/api/ai/status');
    const status = JSON.parse(result.text);
    assert.equal(status.configured, false);
    assert.equal(status.authMethod, null);
    assert.doesNotMatch(result.text, /test-only-secret/);
  } finally { await f.close(); }
});

test('browser disconnect aborts the provider request and removes transport listeners', async () => {
  let signal, incoming, outgoing, signalEntered;
  const entered = new Promise(resolve => { signalEntered = resolve; });
  const f = await fixture({
    planHandler: async request => {
      signal = request.signal;
      signalEntered();
      return new Promise(resolve => {
        signal.addEventListener('abort', () => resolve(Response.json({ error: 'Canceled' }, { status: 499 })), { once: true });
      });
    },
  });
  try {
    const pending = f.request('/api/ai/plan', {
      method: 'POST', headers: { Origin: f.origin, 'Content-Type': 'application/json' }, body: '{}',
      observe(request, response) { incoming = request; outgoing = response; },
    });
    await entered;
    assert.equal(signal.aborted, false);
    outgoing.destroyed = true;
    outgoing.emit('close');
    const result = await pending;
    assert.equal(signal.aborted, true);
    assert.equal(result.status, undefined);
    assert.equal(incoming.listenerCount('aborted'), 0);
    assert.equal(outgoing.listenerCount('close'), 0);
  } finally { await f.close(); }
});

test('normal request-body close and completed response do not cancel provider work', async () => {
  let signal, incoming, outgoing, signalEntered, finish;
  const entered = new Promise(resolve => { signalEntered = resolve; });
  const f = await fixture({
    planHandler: async request => {
      signal = request.signal;
      signalEntered();
      return new Promise(resolve => { finish = () => resolve(Response.json({ proposal: { assignments: [] } })); });
    },
  });
  try {
    const pending = f.request('/api/ai/plan', {
      method: 'POST', headers: { Origin: f.origin, 'Content-Type': 'application/json' }, body: '{}',
      observe(request, response) { incoming = request; outgoing = response; },
    });
    await entered;
    incoming.emit('close');
    assert.equal(signal.aborted, false);
    finish();
    assert.equal((await pending).status, 200);
    assert.equal(signal.aborted, false);
    assert.equal(incoming.listenerCount('aborted'), 0);
    assert.equal(outgoing.listenerCount('close'), 0);
  } finally { await f.close(); }
});

test('an aborted incoming request cancels an already-started provider', async () => {
  let signal, incoming, signalEntered;
  const entered = new Promise(resolve => { signalEntered = resolve; });
  const f = await fixture({
    planHandler: async request => {
      signal = request.signal;
      signalEntered();
      return new Promise(resolve => {
        signal.addEventListener('abort', () => resolve(Response.json({ error: 'Canceled' }, { status: 499 })), { once: true });
      });
    },
  });
  try {
    const pending = f.request('/api/ai/plan', {
      method: 'POST', headers: { Origin: f.origin, 'Content-Type': 'application/json' }, body: '{}',
      observe(request) { incoming = request; },
    });
    await entered;
    incoming.emit('aborted');
    await pending;
    assert.equal(signal.aborted, true);
    assert.equal(incoming.listenerCount('aborted'), 0);
  } finally { await f.close(); }
});
