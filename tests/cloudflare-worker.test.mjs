import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../worker/cloudflare.js', import.meta.url), 'utf8')
  .replace(/^import .+;\r?\n/gm, '').replace('export default ', 'globalThis.worker = ');
function worker({ auth = async () => ({ userId: 'cloudflare-owner', email: 'owner@example.com' }), sync = async () => Response.json({ data: null, revision: 0 }), google = auth, authRoute = async () => new Response(null, { status: 302, headers: { Location: 'https://accounts.google.com/' } }) } = {}) {
  const calls = { auth: [], sync: [], google: [], authRoute: [] };
  const context = vm.createContext({
    URL, Headers, Request, Response,
    STATIC_FILES: {
      '/': { body: '<!doctype html><title>周谱</title>', type: 'text/html; charset=utf-8' },
      '/sw.js': { body: "self.addEventListener('fetch', () => {});", type: 'application/javascript; charset=utf-8' },
    },
    authenticateCloudRequest: async (...args) => { calls.auth.push(args); return auth(...args); },
    googleAuthEnabled: env => env.GOOGLE_CLIENT_ID !== undefined || env.GOOGLE_CLIENT_SECRET !== undefined,
    authenticateGoogleRequest: async (...args) => { calls.google.push(args); return google(...args); },
    assertGoogleSameOrigin: request => { if (request.headers.get('Origin') !== new URL(request.url).origin) throw Object.assign(new Error('请求来源不正确'), { status: 403, code: 'AUTH_CSRF' }); },
    handleGoogleAuth: async (...args) => { calls.authRoute.push(args); return authRoute(...args); },
    handleSync: async (...args) => { calls.sync.push(args); return sync(...args); },
  });
  vm.runInContext(source, context);
  return { instance: context.worker, calls };
}
const request = (path, method = 'GET', headers = {}) => new Request('https://weekprofiler.example' + path, { method, headers });

test('the static shell and scoped service worker contain no user data and have security headers', async () => {
  const { instance, calls } = worker({ auth: () => { throw new Error('must not authenticate shell'); } });
  const shell = await instance.fetch(request('/'), {});
  assert.equal(shell.status, 200);
  assert.match(await shell.text(), /周谱/);
  assert.equal(shell.headers.get('Cache-Control'), 'private, no-cache');
  assert.equal(shell.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.match(shell.headers.get('Content-Security-Policy'), /worker-src 'self'/);
  assert.match(shell.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  const serviceWorker = await instance.fetch(request('/sw.js'), {});
  assert.equal(serviceWorker.headers.get('Service-Worker-Allowed'), '/');
  assert.match(serviceWorker.headers.get('Content-Type'), /javascript/);
  assert.equal((await instance.fetch(request('/', 'HEAD'), {})).status, 200);
  assert.equal(await (await instance.fetch(request('/', 'HEAD'), {})).text(), '');
  assert.equal(calls.auth.length, 0);
});

test('static misses and unsupported methods do not fall through to personal data', async () => {
  const { instance } = worker();
  assert.equal((await instance.fetch(request('/missing'), {})).status, 404);
  assert.equal((await instance.fetch(request('/constructor'), {})).status, 404);
  const rejected = await instance.fetch(request('/', 'POST'), {});
  assert.equal(rejected.status, 405);
  assert.equal(rejected.headers.get('Allow'), 'GET, HEAD');
});

test('session exposes only verified identity and the operations sync capability', async () => {
  const { instance, calls } = worker();
  const response = await instance.fetch(request('/api/session'), {});
  assert.deepEqual(await response.json(), { userId: 'cloudflare-owner', email: 'owner@example.com', sync: 'operations-v1' });
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(response.headers.get('Vary'), 'Cookie, Cf-Access-Jwt-Assertion');
  assert.equal(calls.auth.length, 1);
  assert.equal((await instance.fetch(request('/api/session', 'POST'), {})).status, 405);
});

test('all API routes require authentication, including old and nonexistent routes', async () => {
  const failure = Object.assign(new Error('请登录'), { status: 401, code: 'AUTH_REQUIRED' });
  const { instance, calls } = worker({ auth: () => { throw failure; } });
  for (const path of ['/api/session', '/api/sync', '/api/planner', '/api/ai/status', '/api/missing']) {
    const result = await instance.fetch(request(path, 'GET', { 'oai-authenticated-user-id': 'forged' }), {});
    assert.equal(result.status, 401);
    assert.deepEqual(await result.json(), { code: 'AUTH_REQUIRED', error: '请登录' });
    assert.equal(result.headers.get('Cache-Control'), 'private, no-store');
  }
  assert.equal(calls.sync.length, 0);
});

test('configuration failures stay closed and unexpected authentication errors reveal no internal details', async () => {
  const setup = worker({ auth: () => { throw Object.assign(new Error('请配置'), { status: 503, code: 'AUTH_NOT_CONFIGURED' }); } });
  assert.equal((await setup.instance.fetch(request('/api/session'), {})).status, 503);
  const unexpected = worker({ auth: () => { throw new Error('private internal stack or secret'); } });
  const result = await unexpected.instance.fetch(request('/api/session'), {});
  assert.equal(result.status, 503);
  assert.doesNotMatch(await result.text(), /private|secret|stack/);
});

test('sync receives verified user identity and responses are never publicly cached', async () => {
  const env = { DB: {} };
  const { instance, calls } = worker({ sync: async () => Response.json({ revision: 3 }, { headers: { 'Cache-Control': 'public, max-age=3600' } }) });
  const incoming = request('/api/sync?revision=2');
  const response = await instance.fetch(incoming, env);
  assert.deepEqual(await response.json(), { revision: 3 });
  assert.equal(calls.sync[0][0], incoming);
  assert.equal(calls.sync[0][1], env);
  assert.equal(calls.sync[0][2], 'cloudflare-owner');
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
});

test('legacy reads remain possible but full-state legacy writes require an updated client', async () => {
  const { instance, calls } = worker();
  assert.equal((await instance.fetch(request('/api/planner'), {})).status, 200);
  assert.equal(calls.sync.length, 1);
  for (const method of ['PUT', 'POST', 'DELETE']) {
    const response = await instance.fetch(request('/api/planner', method), {});
    assert.equal(response.status, 410);
    assert.equal((await response.json()).code, 'CLIENT_UPDATE_REQUIRED');
  }
  assert.equal(calls.sync.length, 1);
});

test('cloud AI is unavailable and unexpected sync failures preserve a safe retry response', async () => {
  const { instance } = worker({ sync: () => { throw new Error('database secret'); } });
  const ai = await instance.fetch(request('/api/ai/status'), {});
  assert.equal((await ai.json()).configured, false);
  assert.equal((await instance.fetch(request('/api/ai/status', 'POST'), {})).status, 405);
  const failure = await instance.fetch(request('/api/sync'), {});
  assert.equal(failure.status, 503);
  assert.doesNotMatch(await failure.text(), /database secret/);
  assert.equal((await instance.fetch(request('/api/missing'), {})).status, 404);
});

test('Google configuration takes precedence without falling back to Access credentials', async () => {
  const { instance, calls } = worker({ google: () => { throw Object.assign(new Error('请登录'), { status: 401, code: 'AUTH_REQUIRED' }); } });
  const result = await instance.fetch(request('/api/session'), { GOOGLE_CLIENT_ID: 'configured' });
  assert.equal(result.status, 401);
  assert.equal(calls.google.length, 1);
  assert.equal(calls.auth.length, 0);
});

test('Google auth routes are public, private-cache, and never leak callback URL via referrer', async () => {
  const { instance, calls } = worker();
  const result = await instance.fetch(request('/api/auth/login'), {});
  assert.equal(result.status, 302);
  assert.equal(result.headers.get('Referrer-Policy'), 'no-referrer');
  assert.equal(result.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(calls.auth.length, 0);
  assert.equal(calls.authRoute.length, 1);
  const cookieRoute = worker({ authRoute: async () => {
    const response = new Response(null, { status: 303, headers: { Location: '/', 'Set-Cookie': '__Host-weekprofiler-session=token; Path=/; Secure; HttpOnly' } });
    response.headers.append('Set-Cookie', '__Host-weekprofiler-oauth=; Path=/; Secure; HttpOnly; Max-Age=0');
    return response;
  } });
  const callback = await cookieRoute.instance.fetch(request('/api/auth/callback'), {});
  assert.equal(callback.headers.getSetCookie().length, 2);
  assert.equal(callback.headers.get('Referrer-Policy'), 'no-referrer');
});

test('Google cookie sessions require a same-origin request before writing sync data', async () => {
  const { instance, calls } = worker(), env = { GOOGLE_CLIENT_ID: 'configured' };
  for (const headers of [{}, { Origin: 'https://attacker.example' }]) {
    const result = await instance.fetch(request('/api/sync', 'POST', headers), env);
    assert.equal(result.status, 403);
    assert.equal((await result.json()).code, 'AUTH_CSRF');
  }
  assert.equal(calls.sync.length, 0);
  assert.equal((await instance.fetch(request('/api/sync', 'POST', { Origin: 'https://weekprofiler.example' }), env)).status, 200);
  assert.equal(calls.sync.length, 1);
});
