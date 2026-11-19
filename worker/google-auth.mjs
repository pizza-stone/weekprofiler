// Server-side Google OIDC: tokens never leave this module or enter persistent storage.
const GOOGLE_SESSION_COOKIE = '__Host-weekprofiler-session';
const GOOGLE_STATE_COOKIE = '__Host-weekprofiler-oauth';
const GOOGLE_SESSION_SECONDS = 30 * 24 * 60 * 60;
const GOOGLE_STATE_SECONDS = 10 * 60;
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
let googleKeyCache = { expires: 0, fetched: 0, failed: 0, keys: [], imported: new Map(), pending: null };

function googleError(status, code, message) { return Object.assign(new Error(message), { status, code }); }
function googleRequired() { return googleError(401, 'AUTH_REQUIRED', '请先登录你的周谱账号。'); }
function googleInvalid() { return googleError(401, 'AUTH_INVALID', '登录已失效，请重新登录。'); }
export function googleAuthEnabled(env) {
  // Partial Google configuration must never silently fall back to another provider.
  return env?.GOOGLE_CLIENT_ID !== undefined || env?.GOOGLE_CLIENT_SECRET !== undefined;
}
function googleConfig(env) {
  const clientId = typeof env?.GOOGLE_CLIENT_ID === 'string' ? env.GOOGLE_CLIENT_ID.trim() : '';
  const secret = typeof env?.GOOGLE_CLIENT_SECRET === 'string' ? env.GOOGLE_CLIENT_SECRET.trim() : '';
  const email = typeof env?.ALLOWED_EMAIL === 'string' ? env.ALLOWED_EMAIL.trim().toLowerCase() : '';
  if (!/^[A-Za-z0-9_-]{10,200}\.apps\.googleusercontent\.com$/.test(clientId)
      || !/^[^\s]{10,512}$/.test(secret)
      || !/^[^\s@,;<>*]+@[^\s@,;<>*]+\.[^\s@,;<>*]+$/.test(email) || email.length > 254
      || typeof env?.DB?.prepare !== 'function') {
    throw googleError(503, 'AUTH_NOT_CONFIGURED', 'Google 登录尚未配置完成，请先设置个人访问权限。');
  }
  return { clientId, secret, email };
}
function googleEncode(bytes) { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function googleRandom() { return googleEncode(crypto.getRandomValues(new Uint8Array(32))); }
async function googleHash(value) { return googleEncode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))); }
function googleCookieValue(request, name) {
  const values = (request.headers.get('Cookie') || '').split(';').map(value => value.trim()).filter(value => value.startsWith(name + '='));
  if (values.length !== 1) return null;
  const value = values[0].slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
function googleCookie(name, value, seconds) { return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${seconds}`; }
function googleResponse(body, status = 200, headers = {}) {
  return new Response(body, { status, headers: { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', ...headers } });
}
function googleFailureResponse(request, code, message, status) {
  if (request.method === 'GET' && request.headers.get('Accept')?.includes('text/html')) {
    const text = message.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
    return googleResponse('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录周谱</title>'
      + '<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:12vh auto;padding:1.5rem;line-height:1.8;color:#24352e;background:#fafbf8"><main><h1>暂时未能登录周谱</h1><p>'
      + text + '</p><p><a href="/api/auth/login">重新登录</a>　<a href="/">返回周谱</a></p></main></body></html>', status, { 'Content-Type': 'text/html; charset=utf-8' });
  }
  return googleResponse(JSON.stringify({ code, error: message }), status, { 'Content-Type': 'application/json; charset=utf-8' });
}
export function assertGoogleSameOrigin(request) {
  const site = request.headers.get('Sec-Fetch-Site');
  if (request.headers.get('Origin') !== new URL(request.url).origin || (site && site !== 'same-origin')) {
    throw googleError(403, 'AUTH_CSRF', '请求来源不正确，请在周谱页面重试。');
  }
}
async function googleReadJSON(response, limit = 65536, allowError = false) {
  if ((!response.ok && !allowError) || Number(response.headers.get('Content-Length')) > limit) throw new Error('response');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('response');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '', bytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > limit) { await reader.cancel(); throw new Error('response'); }
    text += decoder.decode(chunk.value, { stream: true });
  }
  const value = JSON.parse(text + decoder.decode());
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('response');
  return value;
}
async function googleKeys(force = false) {
  const now = Date.now(), cache = googleKeyCache;
  if (cache.pending) return cache.pending;
  if (cache.failed && now - cache.failed < 30000) throw googleError(503, 'AUTH_KEYS_UNAVAILABLE', '暂时无法验证 Google 登录，请稍后重试。');
  if (now < cache.expires && (!force || now - cache.fetched < 30000)) return cache;
  cache.pending = (async () => {
    try {
      const value = await googleReadJSON(await fetch(GOOGLE_JWKS_URL, { redirect: 'manual', signal: AbortSignal.timeout(5000), headers: { Accept: 'application/json' } }));
      if (!Array.isArray(value.keys) || !value.keys.length || value.keys.length > 32) throw new Error('keys');
      const keys = value.keys.filter(key => key?.kty === 'RSA' && (!key.alg || key.alg === 'RS256') && (!key.use || key.use === 'sig')
        && typeof key.kid === 'string' && key.kid.length > 0 && key.kid.length <= 256 && typeof key.n === 'string' && typeof key.e === 'string');
      if (!keys.length) throw new Error('keys');
      googleKeyCache = { keys, imported: new Map(), fetched: Date.now(), expires: Date.now() + 15 * 60 * 1000, failed: 0, pending: null };
      return googleKeyCache;
    } catch {
      cache.failed = Date.now(); cache.pending = null;
      throw googleError(503, 'AUTH_KEYS_UNAVAILABLE', '暂时无法验证 Google 登录，请稍后重试。');
    }
  })();
  return cache.pending;
}
function googleDecode(value) {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('base64url');
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64 + '='.repeat((4 - base64.length % 4) % 4)), char => char.charCodeAt(0));
}
function googleJWTObject(value) {
  const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(googleDecode(value)));
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('object');
  return result;
}
async function googleVerifyToken(token, config, nonce) {
  let parts, header, claims, signature;
  try {
    if (typeof token !== 'string' || token.length > 16384) throw new Error('token');
    parts = token.split('.');
    if (parts.length !== 3) throw new Error('parts');
    header = googleJWTObject(parts[0]); claims = googleJWTObject(parts[1]); signature = googleDecode(parts[2]);
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid || header.kid.length > 256
        || (header.typ !== undefined && header.typ !== 'JWT') || header.crit !== undefined) throw new Error('header');
    const now = Date.now() / 1000, audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss)
        || !audiences.includes(config.clientId) || (audiences.length > 1 && claims.azp !== config.clientId)
        || (claims.azp !== undefined && claims.azp !== config.clientId)
        || !Number.isFinite(claims.exp) || claims.exp <= now - 30
        || !Number.isFinite(claims.iat) || claims.iat > now + 30
        || (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now + 30))
        || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255
        || claims.nonce !== nonce || typeof claims.email !== 'string' || claims.email_verified !== true) throw new Error('claims');
  } catch { throw googleInvalid(); }
  let cache = await googleKeys(), jwk = cache.keys.find(key => key.kid === header.kid);
  if (!jwk) { cache = await googleKeys(true); jwk = cache.keys.find(key => key.kid === header.kid); }
  if (!jwk) throw googleInvalid();
  if (!cache.imported.has(header.kid)) cache.imported.set(header.kid, crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
  let valid = false;
  try { valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', await cache.imported.get(header.kid), signature, new TextEncoder().encode(parts[0] + '.' + parts[1])); }
  catch { throw googleError(503, 'AUTH_KEYS_UNAVAILABLE', '暂时无法验证 Google 登录，请稍后重试。'); }
  if (!valid) throw googleInvalid();
  if (claims.email.trim().toLowerCase() !== config.email) throw googleError(403, 'AUTH_FORBIDDEN', '这个 Google 账号没有访问此周谱的权限。');
  return { email: config.email, sub: claims.sub };
}

export async function authenticateGoogleRequest(request, env) {
  const config = googleConfig(env), token = googleCookieValue(request, GOOGLE_SESSION_COOKIE);
  if (!token) throw googleRequired();
  const row = await env.DB.prepare('SELECT email, subject, client_id, expires_at FROM auth_sessions WHERE token_hash = ?').bind(await googleHash(token)).first();
  if (!row || row.expires_at <= Date.now() || row.email !== config.email || row.client_id !== config.clientId || !row.subject) throw googleRequired();
  return { userId: 'cloudflare-owner', email: config.email };
}

async function googleBegin(request, env, config) {
  const url = new URL(request.url);
  if (url.protocol !== 'https:') throw googleError(503, 'AUTH_NOT_CONFIGURED', 'Google 登录需要 HTTPS 地址。');
  const state = googleRandom(), binding = googleRandom(), verifier = googleRandom(), nonce = googleRandom(), now = Date.now();
  const redirectUri = url.origin + '/api/auth/callback';
  const previous = googleCookieValue(request, GOOGLE_STATE_COOKIE);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM auth_oauth_states WHERE expires_at <= ? OR binding_hash = ?').bind(now, previous ? await googleHash(previous) : ''),
    env.DB.prepare('INSERT INTO auth_oauth_states (state_hash, binding_hash, verifier, nonce, redirect_uri, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(await googleHash(state), await googleHash(binding), verifier, nonce, redirectUri, now, now + GOOGLE_STATE_SECONDS * 1000),
    env.DB.prepare('DELETE FROM auth_oauth_states WHERE state_hash NOT IN (SELECT state_hash FROM auth_oauth_states ORDER BY created_at DESC, rowid DESC LIMIT 32)'),
  ]);
  const destination = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  destination.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'openid email',
    state, nonce, code_challenge: await googleHash(verifier), code_challenge_method: 'S256', prompt: 'select_account' }).toString();
  return googleResponse(null, 302, { Location: destination.href, 'Set-Cookie': googleCookie(GOOGLE_STATE_COOKIE, binding, GOOGLE_STATE_SECONDS) });
}
async function googleCallback(request, env, config) {
  const url = new URL(request.url), state = url.searchParams.get('state'), binding = googleCookieValue(request, GOOGLE_STATE_COOKIE);
  if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state) || !binding || url.searchParams.getAll('state').length !== 1) throw googleInvalid();
  // DELETE ... RETURNING consumes the state atomically; even simultaneous callbacks cannot reuse it.
  const pending = await env.DB.prepare('DELETE FROM auth_oauth_states WHERE state_hash = ? AND binding_hash = ? AND expires_at > ? RETURNING verifier, nonce, redirect_uri')
    .bind(await googleHash(state), await googleHash(binding), Date.now()).first();
  if (!pending || pending.redirect_uri !== url.origin + '/api/auth/callback') throw googleInvalid();
  if (url.searchParams.has('error')) throw googleError(401, 'AUTH_CANCELLED', 'Google 登录未完成，请重新登录。');
  const code = url.searchParams.get('code');
  if (!code || code.length > 4096 || url.searchParams.getAll('code').length !== 1) throw googleInvalid();
  let exchange;
  try {
    // Workers does not support redirect: 'error'. Manual mode keeps the secret
    // at this fixed endpoint; redirects are rejected below without following.
    exchange = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(8000), headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: config.clientId, client_secret: config.secret,
        code, code_verifier: pending.verifier, redirect_uri: pending.redirect_uri }).toString(),
    });
  } catch { throw googleError(503, 'AUTH_EXCHANGE_NETWORK', '暂时无法连接 Google 登录服务，请重新登录后重试。'); }
  if (exchange.status >= 300 && exchange.status < 400) {
    throw googleError(503, 'AUTH_EXCHANGE_RESPONSE', 'Google 登录服务返回异常响应，请重新登录后重试。');
  }
  let tokens;
  try { tokens = await googleReadJSON(exchange, 32768, true); }
  catch { throw googleError(503, 'AUTH_EXCHANGE_RESPONSE', 'Google 登录服务返回异常响应，请重新登录后重试。'); }
  if (!exchange.ok || tokens.error !== undefined) {
    // Only controlled OAuth error identifiers affect the fixed public message.
    // Never log or return the provider response, descriptions, or credentials.
    if ([400, 401].includes(exchange.status) && tokens.error === 'invalid_client') {
      throw googleError(503, 'AUTH_CLIENT_REJECTED', 'Google 登录配置未通过验证，请检查配置后重试。');
    }
    if ([400, 401].includes(exchange.status) && tokens.error === 'invalid_grant') {
      throw googleError(401, 'AUTH_GRANT_REJECTED', '本次 Google 授权未被接受，请重新登录。');
    }
    throw googleError(503, 'AUTH_EXCHANGE_REJECTED', 'Google 暂未接受本次登录，请重新登录后重试。');
  }
  if (typeof tokens.id_token !== 'string' || !tokens.id_token) {
    throw googleError(503, 'AUTH_EXCHANGE_RESPONSE', 'Google 登录服务返回异常响应，请重新登录后重试。');
  }
  const owner = await googleVerifyToken(tokens.id_token, config, pending.nonce);
  const token = googleRandom(), now = Date.now(), previous = googleCookieValue(request, GOOGLE_SESSION_COOKIE);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM auth_sessions WHERE expires_at <= ? OR token_hash = ?').bind(now, previous ? await googleHash(previous) : ''),
    env.DB.prepare('INSERT INTO auth_sessions (token_hash, email, subject, client_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(await googleHash(token), owner.email, owner.sub, config.clientId, now, now + GOOGLE_SESSION_SECONDS * 1000),
    env.DB.prepare('DELETE FROM auth_sessions WHERE token_hash NOT IN (SELECT token_hash FROM auth_sessions ORDER BY created_at DESC, rowid DESC LIMIT 16)'),
  ]);
  const response = googleResponse(null, 303, { Location: '/', 'Set-Cookie': googleCookie(GOOGLE_SESSION_COOKIE, token, GOOGLE_SESSION_SECONDS) });
  response.headers.append('Set-Cookie', googleCookie(GOOGLE_STATE_COOKIE, '', 0));
  return response;
}

/** Public login endpoints still enforce configuration, callback binding, and logout CSRF. */
export async function handleGoogleAuth(request, env) {
  const path = new URL(request.url).pathname;
  const method = path === '/api/auth/logout' ? 'POST' : 'GET';
  if (request.method !== method) return googleResponse(JSON.stringify({ error: '不支持的请求方式。' }), 405, { Allow: method, 'Content-Type': 'application/json; charset=utf-8' });
  try {
    const config = googleConfig(env);
    if (path === '/api/auth/login') return await googleBegin(request, env, config);
    if (path === '/api/auth/callback') return await googleCallback(request, env, config);
    if (path === '/api/auth/logout') {
      assertGoogleSameOrigin(request);
      if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) return googleResponse(JSON.stringify({ error: '仅接受 JSON 请求。' }), 415, { 'Content-Type': 'application/json; charset=utf-8' });
      const token = googleCookieValue(request, GOOGLE_SESSION_COOKIE);
      if (token) await env.DB.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').bind(await googleHash(token)).run();
      const response = googleResponse(JSON.stringify({ ok: true }), 200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': googleCookie(GOOGLE_SESSION_COOKIE, '', 0) });
      response.headers.append('Set-Cookie', googleCookie(GOOGLE_STATE_COOKIE, '', 0));
      return response;
    }
    return googleResponse(null, 404);
  } catch (error) {
    const known = ['AUTH_NOT_CONFIGURED', 'AUTH_REQUIRED', 'AUTH_INVALID', 'AUTH_FORBIDDEN', 'AUTH_CSRF', 'AUTH_CANCELLED', 'AUTH_KEYS_UNAVAILABLE',
      'AUTH_EXCHANGE_NETWORK', 'AUTH_EXCHANGE_RESPONSE', 'AUTH_CLIENT_REJECTED', 'AUTH_GRANT_REJECTED', 'AUTH_EXCHANGE_REJECTED'].includes(error?.code);
    const response = googleFailureResponse(request, known ? error.code : 'AUTH_UNAVAILABLE', known ? error.message : '暂时无法登录，请稍后重试。', known ? error.status : 503);
    if (path === '/api/auth/callback') response.headers.set('Set-Cookie', googleCookie(GOOGLE_STATE_COOKIE, '', 0));
    return response;
  }
}
