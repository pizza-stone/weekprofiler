import { createServer } from 'node:http';
import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const MAX_BODY_BYTES = 128 * 1024;
const baseHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
};

function sendJSON(response, status, value, extra = {}) {
  response.writeHead(status, { ...baseHeaders, 'Content-Type': 'application/json; charset=utf-8', ...extra });
  response.end(JSON.stringify(value));
}

async function defaultHTMLPath() {
  for (const path of ['./weekprofiler-preview.html', './outputs/weekprofiler-preview.html', './dayloom-preview.html', './outputs/dayloom-preview.html']) {
    const candidate = fileURLToPath(new URL(path, import.meta.url));
    try { await access(candidate); return candidate; } catch {}
  }
  throw new Error('missing_html');
}

function readBody(request) {
  return new Promise((resolveBody, reject) => {
    const parts = [];
    let total = 0, settled = false;
    function cleanup() {
      request.removeListener('data', onData);
      request.removeListener('end', onEnd);
      request.removeListener('error', onError);
      request.removeListener('aborted', onAborted);
    }
    function fail(code) {
      if (settled) return;
      settled = true;
      cleanup();
      request.resume();
      reject(new Error(code));
    }
    function onData(chunk) {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) { fail('too_large'); return; }
      parts.push(chunk);
    }
    function onEnd() {
      if (settled) return;
      settled = true;
      cleanup();
      resolveBody(Buffer.concat(parts));
    }
    function onError() { fail('body_error'); }
    function onAborted() { fail('body_error'); }
    request.on('data', onData);
    request.on('end', onEnd);
    request.on('error', onError);
    request.on('aborted', onAborted);
  });
}

async function defaultPlanHandler(request, env, userId) {
  const { handleCodexPlan } = await import('./lib/codex-transport.mjs');
  return handleCodexPlan(request, env, userId);
}

async function defaultStatusHandler(env) {
  const { getCodexStatus } = await import('./lib/codex-transport.mjs');
  return getCodexStatus(env);
}

/**
 * Loopback bridge; planner records remain in the HTML's localStorage adapter.
 * Production handlers use Codex ChatGPT subscription authentication only.
 * Handler injection exists for tests and is not configurable over HTTP.
 */
export function createLocalAIRequestHandler({
  env = process.env,
  htmlPath,
  planHandler = defaultPlanHandler,
  statusHandler = defaultStatusHandler,
  getPort = () => 5173,
} = {}) {
  return async (request, response) => {
    const port = getPort();
    const host = request.headers.host?.toLowerCase();
    const peer = request.socket.remoteAddress;
    if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(peer)
        || !['127.0.0.1:' + port, 'localhost:' + port].includes(host)) {
      request.resume();
      sendJSON(response, 403, { error: '仅允许本机访问。', code: 'local_access_only' });
      return;
    }
    const origin = 'http://' + host;
    // Origin:null (including file://) must not access the local AI process.
    const suppliedOrigin = request.headers.origin;
    const fetchSite = request.headers['sec-fetch-site'];
    if ((suppliedOrigin !== undefined && suppliedOrigin !== origin)
        || (fetchSite && !['same-origin', 'none'].includes(fetchSite))) {
      request.resume();
      sendJSON(response, 403, { error: '请从本机服务打开周谱页面。', code: 'same_origin_required' });
      return;
    }
    if (!request.url?.startsWith('/') || request.url.startsWith('//')) {
      request.resume();
      sendJSON(response, 400, { error: '请求地址无效。', code: 'invalid_url' });
      return;
    }
    let path;
    try { path = new URL(request.url, origin).pathname; }
    catch { sendJSON(response, 400, { error: '请求地址无效。', code: 'invalid_url' }); return; }
    try {
      if (path === '/' || path === '/weekprofiler-preview.html' || path === '/dayloom-preview.html') {
        if (!['GET', 'HEAD'].includes(request.method)) {
          request.resume();
          sendJSON(response, 405, { error: '请求方式不支持。', code: 'method_not_allowed' }, { Allow: 'GET, HEAD' });
          return;
        }
        const html = await readFile(htmlPath || await defaultHTMLPath());
        response.writeHead(200, {
          ...baseHeaders,
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
        });
        response.end(request.method === 'HEAD' ? undefined : html);
        return;
      }
      if (path === '/api/ai/status') {
        if (request.method !== 'GET') {
          request.resume();
          sendJSON(response, 405, { error: '请求方式不支持。', code: 'method_not_allowed' }, { Allow: 'GET' });
          return;
        }
        const status = await statusHandler(env);
        const publicText = (value, limit) => {
          let text = typeof value === 'string' ? value.slice(0, limit) : '';
          for (const [name, secret] of Object.entries(env)) {
            if (/^(OPENAI_API_KEY|CODEX_API_KEY)$/i.test(name) && typeof secret === 'string' && secret.length > 0) {
              text = text.split(secret).join('[redacted]');
            }
          }
          return text;
        };
        sendJSON(response, 200, {
          configured: Boolean(status.configured && status.provider === 'codex' && status.authMethod === 'chatgpt'),
          provider: 'codex',
          authMethod: status.authMethod === 'chatgpt' ? 'chatgpt' : null,
          model: publicText(status.model, 128),
          code: publicText(status.code, 80),
          message: publicText(status.message, 1200),
          mode: 'local',
        });
        return;
      }
      if (path === '/api/ai/plan') {
        if (request.method !== 'POST') {
          request.resume();
          sendJSON(response, 405, { error: '请求方式不支持。', code: 'method_not_allowed' }, { Allow: 'POST' });
          return;
        }
        if (suppliedOrigin !== origin) {
          request.resume();
          sendJSON(response, 403, { error: '请从本机服务打开周谱页面后使用 AI。', code: 'same_origin_required' });
          return;
        }
        if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
          request.resume();
          sendJSON(response, 415, { error: '需要 JSON 请求。', code: 'json_required' });
          return;
        }
        if (Number(request.headers['content-length']) > MAX_BODY_BYTES) {
          request.resume();
          sendJSON(response, 413, { error: '任务上下文过大，请缩小范围。', code: 'request_too_large' }, { Connection: 'close' });
          return;
        }
        const controller = new AbortController();
        const onRequestAborted = () => controller.abort();
        const onResponseClosed = () => {
          if (!response.writableEnded) controller.abort();
        };
        request.once('aborted', onRequestAborted);
        response.once('close', onResponseClosed);
        try {
          if (request.aborted || response.destroyed) controller.abort();
          if (controller.signal.aborted) return;
          const body = await readBody(request);
          if (controller.signal.aborted) return;
          const aiRequest = new Request(origin + '/api/ai/plan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Origin: origin },
            body,
            signal: controller.signal,
          });
          const result = await planHandler(aiRequest, env, 'local-user');
          if (controller.signal.aborted || response.destroyed || response.writableEnded) return;
          const resultBody = Buffer.from(await result.arrayBuffer());
          if (controller.signal.aborted || response.destroyed || response.writableEnded) return;
          response.writeHead(result.status, { ...baseHeaders, 'Content-Type': 'application/json; charset=utf-8' });
          response.end(resultBody);
        } finally {
          request.removeListener('aborted', onRequestAborted);
          response.removeListener('close', onResponseClosed);
        }
        return;
      }
      request.resume();
      sendJSON(response, 404, { error: '未找到此地址。', code: 'not_found' });
    } catch (error) {
      if (response.destroyed || response.writableEnded) return;
      if (response.headersSent) { response.end(); return; }
      if (error?.message === 'too_large') {
        sendJSON(response, 413, { error: '任务上下文过大，请缩小范围。', code: 'request_too_large' }, { Connection: 'close' });
      } else {
        // Never print or expose provider exceptions, headers, credentials, or env.
        sendJSON(response, 500, { error: '本机服务暂时不可用，请检查文件是否完整后重试。', code: 'local_service_error' });
      }
    }
  };
}

export function createLocalAIServer(options = {}) {
  const server = createServer(createLocalAIRequestHandler({
    ...options, getPort: () => server.address()?.port,
  }));
  server.requestTimeout = 15_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

const directlyInvoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (directlyInvoked) {
  const port = Number(process.env.WEEKPROFILER_PORT || process.env.DAYLOOM_PORT || 5173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('WEEKPROFILER_PORT must be a port between 1 and 65535.');
    process.exitCode = 1;
  } else {
    try {
      const htmlPath = await defaultHTMLPath();
      const server = createLocalAIServer({ htmlPath });
      server.on('error', () => {
        console.error('Unable to start. The port may already be in use. Set WEEKPROFILER_PORT to another port and retry.');
        process.exitCode = 1;
      });
      server.listen(port, '127.0.0.1', () => {
        console.log('weekprofiler: http://127.0.0.1:' + port);
        console.log('Keep this window open. Press Ctrl+C to stop.');
      });
      const stop = () => {
        server.close();
        server.closeAllConnections();
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    } catch {
      console.error('weekprofiler-preview.html was not found. Keep this server with the complete weekprofiler package.');
      process.exitCode = 1;
    }
  }
}
