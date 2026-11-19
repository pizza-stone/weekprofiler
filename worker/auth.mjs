// Cloudflare Access authentication for the directly deployed private Worker.
// Never accept a client-supplied email or the Sites platform's identity header.
const accessKeySets = new Map();
const ACCESS_KEY_TTL = 15 * 60 * 1000;
const ACCESS_KEY_REFRESH_COOLDOWN = 30 * 1000;
const ACCESS_CLOCK_SKEW = 30;

function accessError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function accessConfiguration(env) {
  const rawDomain = typeof env?.ACCESS_TEAM_DOMAIN === 'string' ? env.ACCESS_TEAM_DOMAIN.trim() : '';
  const domain = rawDomain.replace(/^https:\/\//, '').replace(/\/$/, '').toLowerCase();
  const audience = typeof env?.ACCESS_AUD === 'string' ? env.ACCESS_AUD.trim() : '';
  const email = typeof env?.ALLOWED_EMAIL === 'string' ? env.ALLOWED_EMAIL.trim().toLowerCase() : '';
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(domain)
      || !/^[A-Za-z0-9_-]{16,256}$/.test(audience)
      || !/^[^\s@,;<>*]+@[^\s@,;<>*]+\.[^\s@,;<>*]+$/.test(email)
      || email.length > 254) {
    throw accessError(503, 'AUTH_NOT_CONFIGURED', '云端登录尚未配置完成，请先设置个人访问权限。');
  }
  return { issuer: 'https://' + domain, audience, email };
}

function accessDecode(value) {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('base64url');
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64 + '='.repeat((4 - base64.length % 4) % 4)), char => char.charCodeAt(0));
}

function accessJSON(value) {
  const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(accessDecode(value)));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object');
  return parsed;
}

async function accessReadKeySet(issuer, force = false) {
  const now = Date.now();
  let cached = accessKeySets.get(issuer);
  if (cached?.pending) return cached.pending;
  if (cached?.failedAt && now - cached.failedAt < ACCESS_KEY_REFRESH_COOLDOWN) {
    throw accessError(503, 'AUTH_KEYS_UNAVAILABLE', '暂时无法验证登录，请稍后重试。');
  }
  if (cached && now < cached.expiresAt && (!force || now - cached.fetchedAt < ACCESS_KEY_REFRESH_COOLDOWN)) return cached;
  if (!cached) {
    if (accessKeySets.size >= 8) accessKeySets.delete(accessKeySets.keys().next().value);
    cached = { keys: [], imported: new Map(), fetchedAt: 0, expiresAt: 0, pending: null };
    accessKeySets.set(issuer, cached);
  }
  const previous = cached;
  const pending = (async () => {
    try {
      const response = await fetch(issuer + '/cdn-cgi/access/certs', {
        headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(5000),
      });
      if (!response.ok || Number(response.headers.get('Content-Length')) > 65536) throw new Error('certs');
      const reader = response.body?.getReader();
      if (!reader) throw new Error('certs');
      let text = '', bytes = 0;
      const decoder = new TextDecoder();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 65536) { await reader.cancel(); throw new Error('certs'); }
        text += decoder.decode(chunk.value, { stream: true });
      }
      const value = JSON.parse(text + decoder.decode());
      if (!Array.isArray(value.keys) || !value.keys.length || value.keys.length > 32) throw new Error('certs');
      const keys = value.keys.filter(key => key?.kty === 'RSA' && (!key.alg || key.alg === 'RS256')
        && (!key.use || key.use === 'sig') && typeof key.kid === 'string' && key.kid.length <= 256
        && typeof key.n === 'string' && typeof key.e === 'string');
      if (!keys.length) throw new Error('certs');
      const next = { keys, imported: new Map(), fetchedAt: Date.now(), expiresAt: Date.now() + ACCESS_KEY_TTL, pending: null };
      accessKeySets.set(issuer, next);
      return next;
    } catch {
      previous.pending = null;
      // Retry after the cooldown rather than fetching once for every failed request.
      previous.failedAt = Date.now();
      throw accessError(503, 'AUTH_KEYS_UNAVAILABLE', '暂时无法验证登录，请稍后重试。');
    }
  })();
  previous.pending = pending;
  return pending;
}

async function accessVerificationKey(issuer, kid) {
  let keySet = await accessReadKeySet(issuer);
  let jwk = keySet.keys.find(key => key.kid === kid);
  if (!jwk) {
    keySet = await accessReadKeySet(issuer, true);
    jwk = keySet.keys.find(key => key.kid === kid);
  }
  if (!jwk) throw accessError(401, 'AUTH_INVALID', '登录凭据已失效，请重新登录。');
  if (!keySet.imported.has(kid)) {
    keySet.imported.set(kid, crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
  }
  try { return await keySet.imported.get(kid); }
  catch { throw accessError(503, 'AUTH_KEYS_UNAVAILABLE', '暂时无法验证登录，请稍后重试。'); }
}

/** Authenticates the one allowed owner; errors expose only safe status/code/message. */
export async function authenticateCloudRequest(request, env) {
  const { issuer, audience, email } = accessConfiguration(env);
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) throw accessError(401, 'AUTH_REQUIRED', '请先登录你的周谱账号。');
  if (token.length > 16384) throw accessError(401, 'AUTH_INVALID', '登录凭据无效，请重新登录。');
  let header, claims, parts, signature;
  try {
    parts = token.split('.');
    if (parts.length !== 3) throw new Error('parts');
    header = accessJSON(parts[0]); claims = accessJSON(parts[1]); signature = accessDecode(parts[2]);
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid || header.kid.length > 256
        || (header.typ !== undefined && header.typ !== 'JWT') || header.crit !== undefined) throw new Error('header');
    const now = Date.now() / 1000;
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== issuer || !audiences.includes(audience)
        || !Number.isFinite(claims.exp) || claims.exp <= now - ACCESS_CLOCK_SKEW
        || (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now + ACCESS_CLOCK_SKEW))
        || (claims.iat !== undefined && (!Number.isFinite(claims.iat) || claims.iat > now + ACCESS_CLOCK_SKEW))
        || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 256
        || typeof claims.email !== 'string') throw new Error('claims');
  } catch { throw accessError(401, 'AUTH_INVALID', '登录凭据已失效，请重新登录。'); }
  const key = await accessVerificationKey(issuer, header.kid);
  let valid = false;
  try {
    valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, new TextEncoder().encode(parts[0] + '.' + parts[1]));
  } catch {}
  if (!valid) throw accessError(401, 'AUTH_INVALID', '登录凭据无效，请重新登录。');
  if (claims.email.trim().toLowerCase() !== email) throw accessError(403, 'AUTH_FORBIDDEN', '这个账号没有访问此周谱的权限。');
  // This is a single-owner deployment. Changing Access applications does not orphan its data.
  return { userId: 'cloudflare-owner', email };
}
