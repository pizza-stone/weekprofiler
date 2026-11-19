import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { authenticateCloudRequest } from '../worker/auth.mjs';

const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid: 'test-signing-key', alg: 'RS256', use: 'sig' };
const audience = 'a'.repeat(64);
let sequence = 0;
const configuration = () => ({ ACCESS_TEAM_DOMAIN: 'test-' + (++sequence) + '.cloudflareaccess.com', ACCESS_AUD: audience, ALLOWED_EMAIL: 'owner@example.com' });
const encode = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
async function signed(env, overrides = {}, headerOverrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: 'RS256', typ: 'JWT', kid: jwk.kid, ...headerOverrides });
  const body = encode({ iss: 'https://' + env.ACCESS_TEAM_DOMAIN, aud: [audience], exp: now + 3600, iat: now, sub: 'access-subject', email: 'owner@example.com', ...overrides });
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(header + '.' + body));
  return header + '.' + body + '.' + Buffer.from(sig).toString('base64url');
}
const request = (token, headers = {}) => new Request('https://weekprofiler.example/api/session', { headers: { ...(token ? { 'Cf-Access-Jwt-Assertion': token } : {}), ...headers } });
async function withKeys(fn, handler) {
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (...args) => { calls++; return handler ? handler(...args) : Response.json({ keys: [jwk] }); };
  try { return await fn(() => calls); } finally { globalThis.fetch = previous; }
}
const rejects = (promise, status, code) => assert.rejects(promise, error => error.status === status && error.code === code);

test('cloud authentication is closed until all owner settings are valid', async () => {
  for (const env of [{}, { ...configuration(), ALLOWED_EMAIL: '*' }, { ...configuration(), ACCESS_TEAM_DOMAIN: 'https://attacker.example' }, { ...configuration(), ACCESS_AUD: '' }]) {
    await rejects(authenticateCloudRequest(request(null), env), 503, 'AUTH_NOT_CONFIGURED');
  }
});

test('unsigned identity headers cannot authenticate a caller', async () => {
  await rejects(authenticateCloudRequest(request(null, {
    'oai-authenticated-user-id': 'cloudflare-owner', 'Cf-Access-Authenticated-User-Email': 'owner@example.com',
  }), configuration()), 401, 'AUTH_REQUIRED');
});

test('a signed allowed owner token authenticates, caching the public keys', async () => {
  const env = configuration(), token = await signed(env);
  await withKeys(async calls => {
    assert.deepEqual(await authenticateCloudRequest(request(token), env), { userId: 'cloudflare-owner', email: 'owner@example.com' });
    assert.deepEqual(await authenticateCloudRequest(request(token), env), { userId: 'cloudflare-owner', email: 'owner@example.com' });
    assert.equal(calls(), 1);
  }, async (url, options) => {
    assert.equal(url, 'https://' + env.ACCESS_TEAM_DOMAIN + '/cdn-cgi/access/certs');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Accept, 'application/json');
    return Response.json({ keys: [jwk] });
  });
});

test('wrong issuer, audience, expiry, future claims and malformed JWTs are rejected without fetching keys', async () => {
  const env = configuration(), now = Math.floor(Date.now() / 1000);
  await withKeys(async calls => {
    for (const claims of [{ iss: 'https://attacker.example' }, { aud: ['another-application'] }, { exp: now - 60 }, { exp: 'tomorrow' }, { nbf: now + 120 }, { iat: now + 120 }, { sub: '' }]) {
      await rejects(authenticateCloudRequest(request(await signed(env, claims)), env), 401, 'AUTH_INVALID');
    }
    for (const token of ['bad', 'a.b.c', 'x'.repeat(17000), await signed(env, {}, { alg: 'none' }), await signed(env, {}, { crit: ['test'] })]) {
      await rejects(authenticateCloudRequest(request(token), env), 401, 'AUTH_INVALID');
    }
    assert.equal(calls(), 0);
  });
});

test('tampering with a signed payload is rejected and another valid email is forbidden', async () => {
  const env = configuration();
  await withKeys(async () => {
    const token = await signed(env), parts = token.split('.');
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    parts[1] = encode({ ...claims, sub: 'tampered-subject' });
    await rejects(authenticateCloudRequest(request(parts.join('.')), env), 401, 'AUTH_INVALID');
    await rejects(authenticateCloudRequest(request(await signed(env, { email: 'other@example.com' }), { 'Cf-Access-Authenticated-User-Email': 'owner@example.com' }), env), 403, 'AUTH_FORBIDDEN');
    const accepted = await authenticateCloudRequest(request(await signed(env, { email: 'OWNER@example.com' })), env);
    assert.equal(accepted.email, 'owner@example.com');
  });
});

test('unknown signing keys fail closed without repeated public-key fetches', async () => {
  const env = configuration();
  await withKeys(async calls => {
    const token = await signed(env, {}, { kid: 'unknown' });
    await rejects(authenticateCloudRequest(request(token), env), 401, 'AUTH_INVALID');
    await rejects(authenticateCloudRequest(request(token), env), 401, 'AUTH_INVALID');
    assert.equal(calls(), 1);
  });
});

test('key endpoint failure is a retriable authentication failure, never a bypass', async () => {
  const env = configuration(), token = await signed(env);
  await withKeys(async calls => {
    await rejects(authenticateCloudRequest(request(token), env), 503, 'AUTH_KEYS_UNAVAILABLE');
    await rejects(authenticateCloudRequest(request(token), env), 503, 'AUTH_KEYS_UNAVAILABLE');
    assert.equal(calls(), 1);
  }, () => new Response('unavailable', { status: 503 }));
});

test('malformed or oversized key responses fail closed', async () => {
  for (const response of [Response.json({ keys: [] }), new Response('x'.repeat(70000))]) {
    const env = configuration(), token = await signed(env);
    await withKeys(() => rejects(authenticateCloudRequest(request(token), env), 503, 'AUTH_KEYS_UNAVAILABLE'), () => response);
  }
});

test('checked-in deployment configuration contains no owner identity or paid resource binding', () => {
  const config = JSON.parse(readFileSync(new URL('../wrangler.example.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.workers_dev, true);
  assert.equal(config.preview_urls, false);
  assert.equal(config.keep_vars, true);
  assert.equal(config.main, 'dist/cloudflare/index.js');
  assert.equal(config.d1_databases.length, 1);
  assert.equal(config.d1_databases[0].binding, 'DB');
  assert.equal(config.d1_databases[0].database_id, '');
  for (const key of ['account_id', 'vars', 'ai', 'r2_buckets', 'queues', 'containers', 'durable_objects']) assert.equal(config[key], undefined);
  const ignore = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');
  assert.match(ignore, /^\/?wrangler\.jsonc\s*$/m);
  assert.match(ignore, /^\/?\.openai\/\s*$/m);
});

test('self-host setup writes only the local config and retains settings on reconfiguration', t => {
  const root = mkdtempSync(join(tmpdir(), 'weekprofiler-setup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts'));
  const cli = join(root, 'scripts', 'cloudflare.mjs');
  const example = join(root, 'wrangler.example.jsonc');
  const local = join(root, 'wrangler.jsonc');
  copyFileSync(new URL('../scripts/cloudflare.mjs', import.meta.url), cli);
  copyFileSync(new URL('../wrangler.example.jsonc', import.meta.url), example);
  const original = readFileSync(example, 'utf8');
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' });
  const unconfigured = run('deploy');
  assert.equal(unconfigured.status, 1);
  assert.match(unconfigured.stderr, /configure --database-id/);
  assert.equal(existsSync(local), false);
  const databaseId = crypto.randomUUID();
  assert.equal(run('configure', '--database-id', databaseId).status, 0);
  const config = JSON.parse(readFileSync(local, 'utf8'));
  assert.equal(config.d1_databases[0].database_id, databaseId);
  config.name = 'my-planner';
  writeFileSync(local, JSON.stringify(config));
  assert.equal(run('configure', '--database-id', crypto.randomUUID()).status, 0);
  assert.equal(JSON.parse(readFileSync(local, 'utf8')).name, 'my-planner');
  assert.equal(readFileSync(example, 'utf8'), original);
});
