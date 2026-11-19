import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { googleAuthEnabled, handleGoogleAuth, authenticateGoogleRequest, assertGoogleSameOrigin } from '../worker/google-auth.mjs';

const origin = 'https://weekprofiler.example.test';
const sessionName = '__Host-weekprofiler-session', stateName = '__Host-weekprofiler-oauth';
const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid: 'google-test-key', alg: 'RS256', use: 'sig' };
const hash = async value => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))).toString('base64url');
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const request = (path, headers = {}, method = 'GET') => new Request(origin + path, { method, headers });
const count = (env, table) => env.DB.sqlite.prepare('SELECT COUNT(*) AS total FROM ' + table).get().total;

function environment() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../drizzle/0002_auth.sql', import.meta.url), 'utf8'));
  const DB = {
    sqlite,
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      return { values: [], bind(...values) { this.values = values; return this; },
        async first() { return statement.get(...this.values) || null; },
        async run() { return statement.run(...this.values); } };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try { const result = []; for (const statement of statements) result.push(await statement.run()); sqlite.exec('COMMIT'); return result; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  return { GOOGLE_CLIENT_ID: '123456789012-test-client.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'test-only-oauth-secret', ALLOWED_EMAIL: 'owner@example.com', DB };
}
function cookie(response, name) { return response.headers.getSetCookie().find(value => value.startsWith(name + '='))?.split(';')[0]; }
async function begin(env, headers = {}) {
  const response = await handleGoogleAuth(request('/api/auth/login', headers), env);
  assert.equal(response.status, 302);
  const url = new URL(response.headers.get('Location'));
  return { response, url, state: url.searchParams.get('state'), cookie: cookie(response, stateName), row: env.DB.sqlite.prepare('SELECT * FROM auth_oauth_states WHERE state_hash = ?').get(await hash(url.searchParams.get('state'))) };
}
async function signed(env, nonce, claims = {}, headerOverrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: 'RS256', typ: 'JWT', kid: jwk.kid, ...headerOverrides });
  const payload = encode({ iss: 'https://accounts.google.com', aud: env.GOOGLE_CLIENT_ID, exp: now + 3600, iat: now, sub: 'google-owner-subject', email: 'owner@example.com', email_verified: true, nonce, ...claims });
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(header + '.' + payload));
  return header + '.' + payload + '.' + Buffer.from(signature).toString('base64url');
}
async function provider(action, responseForToken, responseForKeys = () => Response.json({ keys: [jwk] })) {
  const previous = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.redirect, 'manual', 'Workers accepts manual redirects and credentials must never follow redirects');
    assert.ok(options.signal instanceof AbortSignal);
    if (url === 'https://www.googleapis.com/oauth2/v3/certs') return responseForKeys(url, options);
    assert.equal(url, 'https://oauth2.googleapis.com/token');
    return responseForToken(url, options);
  };
  try { return await action(calls); } finally { globalThis.fetch = previous; }
}
const callback = (env, flow, suffix = '') => handleGoogleAuth(request('/api/auth/callback?state=' + flow.state + '&code=test-code' + suffix, { Cookie: flow.cookie }), env);
async function login(env) {
  const flow = await begin(env);
  return provider(async () => {
    const response = await callback(env, flow);
    assert.equal(response.status, 303);
    return { response, flow, cookie: cookie(response, sessionName) };
  }, async () => Response.json({ id_token: await signed(env, flow.row.nonce), access_token: 'must-not-persist' }));
}

test('Google configuration fails closed, including partial settings, and missing cookies cannot spoof identity', async () => {
  assert.equal(googleAuthEnabled({}), false);
  assert.equal(googleAuthEnabled({ GOOGLE_CLIENT_ID: '' }), true);
  for (const env of [{}, { ...environment(), GOOGLE_CLIENT_SECRET: '' }, { ...environment(), ALLOWED_EMAIL: '*' }]) {
    const response = await handleGoogleAuth(request('/api/auth/login'), env);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'AUTH_NOT_CONFIGURED');
  }
  await assert.rejects(authenticateGoogleRequest(request('/api/session', { 'oai-authenticated-user-id': 'cloudflare-owner', 'Cf-Access-Authenticated-User-Email': 'owner@example.com' }), environment()), error => error.status === 401);
});

test('login redirects to Google with PKCE, nonce, fixed callback and a secure browser-bound state', async () => {
  const env = environment(), flow = await begin(env);
  assert.equal(flow.url.origin, 'https://accounts.google.com');
  assert.equal(flow.url.pathname, '/o/oauth2/v2/auth');
  assert.equal(flow.url.searchParams.get('scope'), 'openid email');
  assert.equal(flow.url.searchParams.get('redirect_uri'), origin + '/api/auth/callback');
  assert.equal(flow.url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(flow.url.searchParams.get('code_challenge'), await hash(flow.row.verifier));
  assert.equal(flow.url.searchParams.get('nonce'), flow.row.nonce);
  assert.equal(flow.row.state_hash, await hash(flow.state));
  assert.notEqual(flow.row.binding_hash, flow.cookie.split('=')[1]);
  assert.match(flow.response.headers.get('Set-Cookie'), /Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600/);
  assert.equal(flow.response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(flow.response.headers.get('Referrer-Policy'), 'no-referrer');
  assert.doesNotMatch(flow.url.href, /secret|access_type=offline/);
});

test('successful callback validates PKCE exchange and caches keys, creates only hashed sessions, and is single-use', async () => {
  const env = environment(), flow = await begin(env);
  await provider(async calls => {
    const response = await callback(env, flow);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('Location'), '/');
    const authCookie = cookie(response, sessionName), token = authCookie.split('=')[1];
    const row = env.DB.sqlite.prepare('SELECT * FROM auth_sessions').get();
    assert.equal(row.token_hash, await hash(token));
    assert.equal(row.email, env.ALLOWED_EMAIL);
    assert.equal(row.subject, 'google-owner-subject');
    assert.doesNotMatch(JSON.stringify(row), /must-not-persist|id_token|access_token/);
    assert.match(response.headers.getSetCookie().find(value => value.startsWith(sessionName)), /Secure; HttpOnly; SameSite=Lax; Max-Age=2592000/);
    assert.match(response.headers.getSetCookie().find(value => value.startsWith(stateName)), /Max-Age=0/);
    assert.deepEqual(await authenticateGoogleRequest(request('/api/session', { Cookie: authCookie }), env), { userId: 'cloudflare-owner', email: 'owner@example.com' });
    assert.equal(count(env, 'auth_oauth_states'), 0);
    assert.equal((await callback(env, flow)).status, 401);
    const another = await begin(env);
    const secondToken = await signed(env, another.row.nonce);
    const oldFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => url.includes('/token') ? Response.json({ id_token: secondToken }) : oldFetch(url, options);
    try { assert.equal((await callback(env, another)).status, 303); } finally { globalThis.fetch = oldFetch; }
    assert.equal(calls.filter(call => call.url.includes('/certs')).length, 1);
  }, async (_, options) => {
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'manual');
    const body = new URLSearchParams(options.body);
    assert.equal(body.get('code_verifier'), flow.row.verifier);
    assert.equal(body.get('client_secret'), env.GOOGLE_CLIENT_SECRET);
    assert.equal(body.get('redirect_uri'), origin + '/api/auth/callback');
    return Response.json({ id_token: await signed(env, flow.row.nonce), access_token: 'must-not-persist', refresh_token: 'must-not-persist' });
  });
});

test('exchange failures expose only fixed safe categories, consume state and never create a session', async () => {
  const cases = [
    [() => { throw new Error('provider-private-detail'); }, 503, 'AUTH_EXCHANGE_NETWORK'],
    [() => Response.json({ error: 'invalid_client', error_description: 'provider-private-detail' }, { status: 401 }), 503, 'AUTH_CLIENT_REJECTED'],
    [() => Response.json({ error: 'invalid_grant', error_description: 'provider-private-detail' }, { status: 400 }), 401, 'AUTH_GRANT_REJECTED'],
    [() => Response.json({ error: 'provider-private-detail' }, { status: 500 }), 503, 'AUTH_EXCHANGE_REJECTED'],
    [() => new Response('provider-private-detail', { status: 502 }), 503, 'AUTH_EXCHANGE_RESPONSE'],
    [() => Response.json({ access_token: 'provider-private-detail' }), 503, 'AUTH_EXCHANGE_RESPONSE'],
    [() => new Response(new Uint8Array([0xc3, 0x28])), 503, 'AUTH_EXCHANGE_RESPONSE'],
    [() => Response.json({ error: 'invalid_client' }, { status: 400, headers: { 'Content-Length': '32769' } }), 503, 'AUTH_EXCHANGE_RESPONSE'],
    [() => new Response('{"id_token":"' + 'x'.repeat(32769) + '"}'), 503, 'AUTH_EXCHANGE_RESPONSE'],
    ...[301, 302, 303, 307, 308].map(status => [() => new Response(null, { status, headers: { Location: 'https://untrusted.example/provider-private-detail' } }), 503, 'AUTH_EXCHANGE_RESPONSE']),
  ];
  for (const [responseForToken, status, code] of cases) {
    const env = environment(), flow = await begin(env);
    await provider(async calls => {
      const response = await callback(env, flow), value = await response.json();
      assert.equal(response.status, status); assert.equal(value.code, code);
      assert.deepEqual(Object.keys(value).sort(), ['code', 'error']);
      assert.doesNotMatch(JSON.stringify(value), /provider-private-detail|test-only-oauth-secret|test-code|untrusted/);
      assert.match(response.headers.get('Set-Cookie'), /Max-Age=0/);
      assert.equal(count(env, 'auth_sessions'), 0); assert.equal(count(env, 'auth_oauth_states'), 0);
      assert.equal(calls.length, 1, 'exchange failures never follow redirects or request keys');
    }, responseForToken);
  }
});

test('public-key redirects are rejected without forwarding the request or establishing a session', async () => {
  const fresh = await import('../worker/google-auth.mjs?key-redirect-regression');
  const env = environment(), flow = await begin(env);
  await provider(async calls => {
    const response = await fresh.handleGoogleAuth(request('/api/auth/callback?state=' + flow.state + '&code=test-code', { Cookie: flow.cookie }), env);
    assert.equal(response.status, 503); assert.equal((await response.json()).code, 'AUTH_KEYS_UNAVAILABLE');
    assert.equal(count(env, 'auth_sessions'), 0); assert.equal(calls.length, 2);
  }, async () => Response.json({ id_token: await signed(env, flow.row.nonce) }),
  () => new Response(null, { status: 302, headers: { Location: 'https://untrusted.example/keys' } }));
});

test('callback requires matching state and browser cookie, rejects duplicates and expires atomically', async () => {
  const env = environment(), flow = await begin(env);
  await provider(async calls => {
    const attempts = [
      request('/api/auth/callback?state=' + flow.state + '&code=test-code'),
      request('/api/auth/callback?state=' + 'a'.repeat(43) + '&code=test-code', { Cookie: flow.cookie }),
      request('/api/auth/callback?state=' + flow.state + '&state=' + flow.state + '&code=test-code', { Cookie: flow.cookie }),
      request('/api/auth/callback?state=' + flow.state + '&code=test-code', { Cookie: flow.cookie + '; ' + flow.cookie }),
    ];
    for (const incoming of attempts) assert.equal((await handleGoogleAuth(incoming, env)).status, 401);
    assert.equal(count(env, 'auth_oauth_states'), 1);
    env.DB.sqlite.exec('UPDATE auth_oauth_states SET expires_at = 0');
    assert.equal((await callback(env, flow)).status, 401);
    assert.equal(calls.length, 0);
    assert.equal(count(env, 'auth_sessions'), 0);
  }, () => { throw new Error('must not exchange'); });
});

test('simultaneous callbacks consume the state once and only one browser session is created', async () => {
  const env = environment(), flow = await begin(env);
  await provider(async calls => {
    const responses = await Promise.all([callback(env, flow), callback(env, flow)]);
    assert.deepEqual(responses.map(response => response.status).sort(), [303, 401]);
    assert.equal(calls.filter(call => call.url.includes('/token')).length, 1);
    assert.equal(count(env, 'auth_sessions'), 1);
  }, async () => Response.json({ id_token: await signed(env, flow.row.nonce) }));
});

test('provider cancellation consumes state and clears cookie without displaying provider-supplied text', async () => {
  const env = environment(), flow = await begin(env);
  const response = await callback(env, flow, '&error=access_denied&error_description=private-unsafe-content');
  assert.equal(response.status, 401);
  assert.match(response.headers.get('Set-Cookie'), /Max-Age=0/);
  assert.doesNotMatch(await response.text(), /private-unsafe-content/);
  assert.equal(count(env, 'auth_oauth_states'), 0);
});

test('browser login failures offer safe Chinese retry links while API clients retain JSON errors', async () => {
  const response = await handleGoogleAuth(request('/api/auth/callback?code=private-code&error_description=%3Cscript%3E', { Accept: 'text/html' }), environment());
  assert.equal(response.status, 401);
  assert.match(response.headers.get('Content-Type'), /text\/html/);
  const html = await response.text();
  assert.match(html, /重新登录/);
  assert.match(html, /href="\/api\/auth\/login"/);
  assert.match(html, /href="\/"/);
  assert.doesNotMatch(html, /private-code|<script>/);
  assert.match(response.headers.get('Set-Cookie'), /Max-Age=0/);
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
});

test('wrong email and unverified email cannot create sessions', async () => {
  for (const [claims, status] of [[{ email: 'other@example.com' }, 403], [{ email_verified: false }, 401], [{ email_verified: 'true' }, 401]]) {
    const env = environment(), flow = await begin(env);
    await provider(async () => {
      assert.equal((await callback(env, flow)).status, status);
      assert.equal(count(env, 'auth_sessions'), 0);
    }, async () => Response.json({ id_token: await signed(env, flow.row.nonce, claims) }));
  }
});

test('invalid nonce, issuer, audience, expiry and authorized party fail before session creation', async () => {
  const now = Math.floor(Date.now() / 1000);
  for (const claims of [{ nonce: 'wrong' }, { iss: 'https://attacker.example' }, { aud: 'other-client' }, { exp: now - 120 }, { iat: now + 120 }, { azp: 'other-client' }, { aud: ['123456789012-test-client.apps.googleusercontent.com', 'extra'] }]) {
    const env = environment(), flow = await begin(env);
    await provider(async () => {
      assert.equal((await callback(env, flow)).status, 401);
      assert.equal(count(env, 'auth_sessions'), 0);
    }, async () => Response.json({ id_token: await signed(env, flow.row.nonce, claims) }));
  }
});

test('unsigned, tampered and unknown-key tokens never authenticate', async () => {
  for (const mode of ['none', 'tamper', 'unknown-key']) {
    const env = environment(), flow = await begin(env);
    let token = await signed(env, flow.row.nonce, {}, mode === 'none' ? { alg: 'none' } : mode === 'unknown-key' ? { kid: 'unknown' } : {});
    if (mode === 'tamper') { const parts = token.split('.'); parts[1] = encode({ ...JSON.parse(Buffer.from(parts[1], 'base64url').toString()), sub: 'tampered-subject' }); token = parts.join('.'); }
    await provider(async () => {
      assert.equal((await callback(env, flow)).status, 401);
      assert.equal(count(env, 'auth_sessions'), 0);
    }, async () => Response.json({ id_token: token }));
  }
});

test('code exchange failures are safe and require a fresh login state', async () => {
  const env = environment(), flow = await begin(env);
  await provider(async () => {
    const response = await callback(env, flow);
    assert.equal(response.status, 503);
    const text = await response.text();
    assert.match(text, /AUTH_EXCHANGE_RESPONSE/);
    assert.doesNotMatch(text, /private Google error/);
    assert.equal((await callback(env, flow)).status, 401);
    assert.equal(count(env, 'auth_sessions'), 0);
  }, () => new Response('private Google error', { status: 400 }));
});

test('expired sessions and changed owner or client configuration require another login', async () => {
  const env = environment(), auth = await login(env), incoming = request('/api/session', { Cookie: auth.cookie });
  for (const changed of [{ ...env, ALLOWED_EMAIL: 'new-owner@example.com' }, { ...env, GOOGLE_CLIENT_ID: '123456789012-other-client.apps.googleusercontent.com' }]) {
    await assert.rejects(authenticateGoogleRequest(incoming, changed), error => error.status === 401 && error.code === 'AUTH_REQUIRED');
  }
  env.DB.sqlite.exec('UPDATE auth_sessions SET expires_at = 0');
  await assert.rejects(authenticateGoogleRequest(incoming, env), error => error.status === 401);
});

test('logout requires same-origin JSON POST, revokes only this session, and is idempotent', async () => {
  const env = environment(), auth = await login(env), second = await login(env);
  assert.equal(count(env, 'auth_sessions'), 2);
  assert.equal((await handleGoogleAuth(request('/api/auth/logout', { Cookie: auth.cookie }), env)).status, 405);
  for (const headers of [{}, { Origin: 'https://attacker.example' }, { Origin: origin, 'Sec-Fetch-Site': 'same-site' }]) {
    const rejected = await handleGoogleAuth(request('/api/auth/logout', { Cookie: auth.cookie, 'Content-Type': 'application/json', ...headers }, 'POST'), env);
    assert.equal(rejected.status, 403);
  }
  assert.equal(count(env, 'auth_sessions'), 2);
  assert.equal((await handleGoogleAuth(request('/api/auth/logout', { Origin: origin, Cookie: auth.cookie }, 'POST'), env)).status, 415);
  const incoming = request('/api/auth/logout', { Cookie: auth.cookie, Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' }, 'POST');
  const response = await handleGoogleAuth(incoming, env);
  assert.equal(response.status, 200);
  assert.match(response.headers.getSetCookie().find(value => value.startsWith(sessionName)), /Max-Age=0/);
  assert.equal(count(env, 'auth_sessions'), 1);
  await assert.rejects(authenticateGoogleRequest(request('/api/session', { Cookie: auth.cookie }), env), error => error.status === 401);
  assert.equal((await authenticateGoogleRequest(request('/api/session', { Cookie: second.cookie }), env)).email, env.ALLOWED_EMAIL);
  assert.equal((await handleGoogleAuth(incoming, env)).status, 200);
});

test('same-origin protection rejects missing, cross-origin and sibling-site origins', () => {
  for (const headers of [{}, { Origin: 'https://attacker.example' }, { Origin: origin, 'Sec-Fetch-Site': 'same-site' }, { Origin: origin, 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.throws(() => assertGoogleSameOrigin(request('/api/sync', headers, 'POST')), error => error.status === 403);
  }
  assert.doesNotThrow(() => assertGoogleSameOrigin(request('/api/sync', { Origin: origin, 'Sec-Fetch-Site': 'same-origin' }, 'POST')));
});

test('login cleanup bounds pending state and session storage and replaces old browser state', async () => {
  const env = environment(), old = await begin(env);
  const replacement = await begin(env, { Cookie: old.cookie });
  assert.notEqual(old.state, replacement.state);
  assert.equal(count(env, 'auth_oauth_states'), 1);
  for (let i = 0; i < 34; i++) await begin(env);
  assert.equal(count(env, 'auth_oauth_states'), 32);
  for (let i = 0; i < 18; i++) await login(env);
  assert.equal(count(env, 'auth_sessions'), 16);
  env.DB.sqlite.exec('UPDATE auth_oauth_states SET expires_at = 0; UPDATE auth_sessions SET expires_at = 0;');
  await login(env);
  assert.equal(count(env, 'auth_oauth_states'), 0);
  assert.equal(count(env, 'auth_sessions'), 1);
});
