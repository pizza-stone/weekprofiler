import { authenticateCloudRequest } from './auth.mjs';
import { googleAuthEnabled, authenticateGoogleRequest, assertGoogleSameOrigin, handleGoogleAuth } from './google-auth.mjs';
import { handleSync } from './sync-api.mjs';

// build.mjs injects STATIC_FILES and the dependency-free modules into this entry.
const cloudSecurityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
};

function cloudJson(value, status = 200, extra = {}) {
  return Response.json(value, { status, headers: {
    ...cloudSecurityHeaders,
    'Cache-Control': 'private, no-store',
    'Vary': 'Cookie, Cf-Access-Jwt-Assertion',
    ...extra,
  } });
}

function cloudProtectedResponse(response) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(cloudSecurityHeaders)) headers.set(name, value);
  headers.set('Cache-Control', 'private, no-store');
  headers.set('Vary', 'Cookie, Cf-Access-Jwt-Assertion');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      if (['/api/auth/login', '/api/auth/callback', '/api/auth/logout'].includes(url.pathname)) {
        const response = cloudProtectedResponse(await handleGoogleAuth(request, env));
        response.headers.set('Referrer-Policy', 'no-referrer');
        return response;
      }
      let identity;
      try {
        if (googleAuthEnabled(env)) {
          identity = await authenticateGoogleRequest(request, env);
          if (!['GET', 'HEAD'].includes(request.method)) assertGoogleSameOrigin(request);
        } else identity = await authenticateCloudRequest(request, env);
      }
      catch (error) {
        const known = ['AUTH_NOT_CONFIGURED', 'AUTH_REQUIRED', 'AUTH_INVALID', 'AUTH_KEYS_UNAVAILABLE', 'AUTH_FORBIDDEN', 'AUTH_CSRF'].includes(error?.code);
        return cloudJson({ code: known ? error.code : 'AUTH_UNAVAILABLE', error: known ? error.message : '暂时无法验证登录，请稍后重试。' },
          known && [401, 403, 503].includes(error.status) ? error.status : 503);
      }
      if (url.pathname === '/api/session') {
        if (request.method !== 'GET') return cloudJson({ error: '不支持的请求方式。' }, 405, { Allow: 'GET' });
        return cloudJson({ ...identity, sync: 'operations-v1' });
      }
      if (url.pathname === '/api/sync' || (url.pathname === '/api/planner' && request.method === 'GET')) {
        try { return cloudProtectedResponse(await handleSync(request, env, identity.userId)); }
        catch { return cloudJson({ error: '暂时无法同步，已保留本机修改，请稍后重试。' }, 503); }
      }
      if (url.pathname === '/api/planner') {
        return cloudJson({ code: 'CLIENT_UPDATE_REQUIRED', error: '云端已使用新版同步，请刷新页面后继续。本机修改仍然保留。' }, 410);
      }
      if (url.pathname === '/api/ai/status') {
        if (request.method !== 'GET') return cloudJson({ error: '不支持的请求方式。' }, 405, { Allow: 'GET' });
        return cloudJson({ configured: false, provider: 'codex', message: 'Codex 订阅接入需要电脑上的本机服务。请运行 start-weekprofiler.cmd 后在本机网址使用。云同步不会调用收费模型 API。' });
      }
      return cloudJson({ error: '没有这个接口。' }, 404);
    }

    // The application shell has no personal data; every data API requires a
    // verified Google session, or a verified Access JWT for older deployments.
    if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', {
      status: 405, headers: { ...cloudSecurityHeaders, 'Cache-Control': 'private, no-store', Allow: 'GET, HEAD' },
    });
    const asset = Object.prototype.hasOwnProperty.call(STATIC_FILES, url.pathname) ? STATIC_FILES[url.pathname] : null;
    if (!asset) return new Response('Not found', { status: 404, headers: { ...cloudSecurityHeaders, 'Cache-Control': 'private, no-store' } });
    const body = request.method === 'HEAD' ? null : asset.base64 ? Uint8Array.from(atob(asset.base64), c => c.charCodeAt(0)) : asset.body;
    return new Response(body, { headers: {
      ...cloudSecurityHeaders,
      'Content-Type': asset.type,
      'Cache-Control': 'private, no-cache',
      ...(url.pathname === '/sw.js' ? { 'Service-Worker-Allowed': '/' } : {}),
    } });
  },
};
