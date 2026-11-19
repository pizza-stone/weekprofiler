// Local-only bridge to the user's installed, ChatGPT-authenticated Codex CLI.
// No token files are read or copied. There is deliberately no API fallback.
import { spawn as nodeSpawn } from 'node:child_process';
import { access, lstat, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { AI_MAX_REQUEST_BYTES, AI_PROPOSAL_SCHEMA, validateAIContext, validateAIProposal, buildAIResponseRequest } from './ai-planner.mjs';

let codexActive = false;
const codexOwnedDirectories = new Set();
const codexAuthArgs = ['-c', 'forced_login_method="chatgpt"', '-c', 'model_provider="openai"'];
const codexModelLabel = 'Codex（当前默认模型）';
const codexDisabledFeatures = ['shell_tool', 'apps', 'multi_agent', 'view_image', 'plugins', 'remote_plugin'];
const codexScopeArgs = codexDisabledFeatures.flatMap(name => ['-c', `features.${name}=false`]).concat(['-c', 'web_search="disabled"']);

function codexJson(value, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
}
function codexError(code, error, status) { return codexJson({ code, error }, status); }
function codexChildEnvironment(env) {
  return Object.fromEntries(Object.entries(env || {}).filter(([key, value]) => value !== undefined
    && !/^(OPENAI_API_KEY|CODEX_API_KEY|OPENAI_BASE_URL|CODEX_ACCESS_TOKEN)$/i.test(key)));
}
async function codexFileExists(file) { try { await access(file); return true; } catch { return false; } }

// A .cmd shim cannot be launched safely with shell:false on Windows. For the
// standard npm installation, launch its documented Node entrypoint directly.
async function codexExecutable(env, options) {
  if (options.command) return { command: options.command, prefix: options.commandArgs || [] };
  const explicit = env.WEEKPROFILER_CODEX_BIN || env.DAYLOOM_CODEX_BIN;
  if (explicit) {
    if (!path.isAbsolute(explicit) || !await codexFileExists(explicit)) throw new Error('CODEX_NOT_INSTALLED');
    if (/\.m?js$/i.test(explicit)) return { command: process.execPath, prefix: [explicit] };
    if (process.platform === 'win32' && !/\.exe$/i.test(explicit)) throw new Error('CODEX_NOT_INSTALLED');
    return { command: explicit, prefix: [] };
  }
  const pathValue = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] || '';
  for (const entry of pathValue.split(path.delimiter).filter(Boolean)) {
    if (!path.isAbsolute(entry)) continue;
    if (process.platform !== 'win32') {
      const binary = path.join(entry, 'codex');
      if (await codexFileExists(binary)) return { command: binary, prefix: [] };
    } else {
      const binary = path.join(entry, 'codex.exe');
      if (await codexFileExists(binary)) return { command: binary, prefix: [] };
      const shim = path.join(entry, 'codex.cmd');
      const script = path.join(entry, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      if (await codexFileExists(shim) && await codexFileExists(script)) return { command: process.execPath, prefix: [script] };
    }
  }
  throw new Error('CODEX_NOT_INSTALLED');
}

async function codexTemporaryDirectory() {
  const base = await realpath(os.tmpdir());
  const directory = path.resolve(await mkdtemp(path.join(base, 'weekprofiler-codex-')));
  if (path.dirname(directory) !== path.resolve(base) || !path.basename(directory).startsWith('weekprofiler-codex-')) throw new Error('TEMP_DIRECTORY_INVALID');
  codexOwnedDirectories.add(directory);
  return directory;
}
async function codexCleanup(directory) {
  if (!directory || !codexOwnedDirectories.has(directory)) return;
  const absolute = path.resolve(directory);
  const base = await realpath(os.tmpdir());
  const info = await lstat(absolute).catch(() => null);
  // Validate the resolved absolute target immediately before recursive removal.
  if (!info) { codexOwnedDirectories.delete(directory); return; }
  if (absolute !== directory || path.dirname(absolute) !== path.resolve(base)
    || !path.basename(absolute).startsWith('weekprofiler-codex-') || info.isSymbolicLink()
    || await realpath(absolute) !== absolute) throw new Error('TEMP_DIRECTORY_INVALID');
  await rm(absolute, { recursive: true, force: true });
  codexOwnedDirectories.delete(directory);
}

function codexTerminate(child, options) {
  if (options.terminateImpl) { options.terminateImpl(child); return; }
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) { child.kill?.(); return; }
  if (process.platform === 'win32') {
    const killer = nodeSpawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => { try { child.kill('SIGKILL'); } catch {} });
    killer.on('close', code => { if (code) { try { child.kill('SIGKILL'); } catch {} } });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
  }
}

function codexRun(executable, args, env, directory, options = {}) {
  return new Promise(resolve => {
    let child, finished = false, stopReason = null, stdout = '', stderr = '', bytes = 0;
    const stdoutDecoder = new StringDecoder('utf8'), stderrDecoder = new StringDecoder('utf8');
    let forceFinish;
    const finish = extra => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); clearTimeout(forceFinish);
      options.signal?.removeEventListener('abort', cancelled);
      resolve({ stdout: stdout + stdoutDecoder.end(), stderr: stderr + stderrDecoder.end(), stopReason, ...extra });
    };
    const stop = reason => {
      if (finished || stopReason) return;
      stopReason = reason;
      forceFinish = setTimeout(() => finish({ code: null }), 2000);
      if (child) codexTerminate(child, options);
    };
    const cancelled = () => stop('cancelled');
    const timeout = Math.max(1, Math.min(options.timeoutMs || 120000, 300000));
    const timer = setTimeout(() => stop('timeout'), timeout);
    if (options.signal?.aborted) { finish({ code: null, stopReason: 'cancelled' }); return; }
    options.signal?.addEventListener('abort', cancelled, { once: true });
    try {
      child = (options.spawnImpl || nodeSpawn)(executable.command, [...executable.prefix, ...args], {
        cwd: directory, env: codexChildEnvironment(env), shell: false, windowsHide: true,
        detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
      });
      const receive = (channel, chunk) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > (options.maxOutputBytes || 512 * 1024)) { stop('output_limit'); return; }
        if (channel === 'stdout') {
          const text = stdoutDecoder.write(Buffer.from(chunk)); stdout += text;
          try { options.onStdout?.(text, child); } catch { stop('protocol_error'); }
        } else stderr += stderrDecoder.write(Buffer.from(chunk));
      };
      child.stdout?.on('data', chunk => receive('stdout', chunk));
      child.stderr?.on('data', chunk => receive('stderr', chunk));
      child.on('error', error => finish({ code: null, failure: error.code === 'ENOENT' ? 'missing' : 'process_error' }));
      child.on('close', code => finish({ code }));
      child.stdin?.on('error', () => {});
      if (options.onStdout) child.stdin?.write(options.stdin || '');
      else child.stdin?.end(options.stdin || '');
    } catch (error) { finish({ code: null, failure: error.code === 'ENOENT' ? 'missing' : 'process_error' }); }
  });
}

function codexStatusResult(configured, code, message) {
  return { configured, provider: 'codex', authMethod: configured ? 'chatgpt' : null, code, message, model: codexModelLabel };
}
function codexLoginResult(result) {
  if (result.failure === 'missing') return codexStatusResult(false, 'CODEX_NOT_INSTALLED', '未找到 Codex CLI，请安装后使用 ChatGPT 登录。');
  if (result.stopReason === 'timeout') return codexStatusResult(false, 'CODEX_STATUS_TIMEOUT', '检查 Codex 登录状态超时，请稍后重试。');
  if (result.stopReason === 'cancelled') return codexStatusResult(false, 'AI_CANCELLED', '已取消本次生成。');
  const output = (result.stdout + '\n' + result.stderr).replace(/\u001b\[[0-9;]*m/g, '');
  if (result.code === 0 && /^Logged in using ChatGPT\s*$/im.test(output)) return codexStatusResult(true, 'CODEX_READY', '已连接本机 Codex 的 ChatGPT 登录，可使用订阅额度。');
  if (/using an? API key|using API key|API key authentication|API key configured|forced_login_method/i.test(output)) return codexStatusResult(false, 'CODEX_CHATGPT_LOGIN_REQUIRED', '此功能只使用 ChatGPT 订阅登录，请在 Codex CLI 中切换到 ChatGPT 登录。');
  if (/not logged in|not authenticated|login required/i.test(output)) return codexStatusResult(false, 'CODEX_LOGIN_REQUIRED', '请先在终端运行 codex login，并使用 ChatGPT 账号登录。');
  return codexStatusResult(false, 'CODEX_STATUS_UNAVAILABLE', '无法确认 Codex 的 ChatGPT 登录状态，请更新 CLI 并运行 codex login status 检查。');
}

// Inspect effective settings without executing a model turn or reading secret
// files. Never disable hooks: they may implement the user's security checks.
// Instead inspect actual hooks without starting a thread or model turn. The
// hooks feature defaults on even when a clean installation has no hooks.
async function codexInspectHooks(executable, args, env, directory, options) {
  let pending = '', stage = 0, hookResult = null;
  const result = await codexRun(executable, [...args, 'app-server'], env, directory, {
    ...options,
    stdin: JSON.stringify({ id: 0, method: 'initialize', params: {
      clientInfo: { name: 'weekprofiler_hook_inspector', title: 'weekprofiler', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    } }) + '\n',
    onStdout(text, child) {
      pending += text;
      while (pending.includes('\n')) {
        const split = pending.indexOf('\n'), line = pending.slice(0, split).trim();
        pending = pending.slice(split + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.error) { child.stdin.end(); continue; }
        if (message.id === 0 && stage === 0 && message.result) {
          stage = 1;
          child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
          child.stdin.write(JSON.stringify({ id: 1, method: 'hooks/list', params: { cwds: [directory] } }) + '\n');
        } else if (message.id === 1 && stage === 1) {
          stage = 2; hookResult = message.result; child.stdin.end();
        }
      }
    },
  });
  if (result.stopReason === 'cancelled') return 'cancelled';
  if (result.code !== 0 || result.stopReason || !Array.isArray(hookResult?.data) || hookResult.data.length !== 1) return 'unknown';
  const entry = hookResult.data[0];
  if (!entry || typeof entry.cwd !== 'string' || path.resolve(entry.cwd) !== directory
    || !Array.isArray(entry.hooks) || entry.hooks.length > 1000
    || !Array.isArray(entry.errors) || entry.errors.length
    || !Array.isArray(entry.warnings) || entry.warnings.length
    || entry.hooks.some(hook => !hook || typeof hook.enabled !== 'boolean')) return 'unknown';
  return entry.hooks.some(hook => hook.enabled) ? 'active' : 'clear';
}

async function codexInspectIsolation(executable, env, directory, options) {
  const inspectOptions = { ...options, timeoutMs: options.statusTimeoutMs || 10000, maxOutputBytes: 256 * 1024 };
  const base = [...codexAuthArgs, ...codexScopeArgs];
  const failed = () => ({ ok: false, code: 'CODEX_ISOLATION_UNAVAILABLE', message: '无法确认 Codex 工具隔离，暂不启动自动排程。请更新 CLI 后重试；已有安全配置保持不变。' });
  const features = await codexRun(executable, [...base, 'features', 'list'], env, directory, inspectOptions);
  if (features.stopReason === 'cancelled') return { ok: false, code: 'AI_CANCELLED', message: '已取消本次生成。' };
  if (features.code !== 0 || features.stopReason) return failed();
  const states = new Map();
  for (const line of features.stdout.replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Za-z0-9_]+)\s+.+?\s+(true|false)$/);
    if (match) states.set(match[1], match[2] === 'true');
  }
  if (!states.has('hooks') || codexDisabledFeatures.some(name => states.get(name) !== false)) return failed();

  const inspectMcp = async args => {
    const result = await codexRun(executable, [...base, ...args, 'mcp', 'list', '--json'], env, directory, inspectOptions);
    if (result.code !== 0 || result.stopReason) return null;
    try {
      const servers = JSON.parse(result.stdout);
      // Only safe bare TOML keys are accepted. Unexpected CLI formats or names
      // fail closed rather than risk constructing a different config override.
      if (!Array.isArray(servers) || servers.length > 100 || !servers.every(server => server && typeof server === 'object'
        && typeof server.name === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(server.name)
        && typeof server.enabled === 'boolean') || new Set(servers.map(server => server.name)).size !== servers.length) return null;
      return servers.map(({ name, enabled }) => ({ name, enabled }));
    } catch { return null; }
  };
  const servers = await inspectMcp([]);
  if (!servers) return failed();
  const mcpArgs = servers.flatMap(({ name }) => ['-c', `mcp_servers.${name}.enabled=false`]);
  if (servers.length) {
    const checked = await inspectMcp(mcpArgs);
    if (!checked || checked.some(server => server.enabled)) return failed();
  }
  if (states.get('hooks') || states.get('codex_hooks')) {
    const hooks = await codexInspectHooks(executable, [...base, ...mcpArgs], env, directory, inspectOptions);
    if (hooks === 'cancelled') return { ok: false, code: 'AI_CANCELLED', message: '已取消本次生成。' };
    if (hooks === 'active') return { ok: false, code: 'CODEX_HOOKS_ACTIVE', message: '当前 Codex 配置包含已启用的 hooks，与此排程桥接暂不兼容。周谱保留这些可能包含安全检查的配置，不会关闭它们；普通排程仍可使用。' };
    if (hooks !== 'clear') return failed();
  }
  return { ok: true, args: [...codexScopeArgs, ...mcpArgs] };
}

/** Read-only login inspection. Never reads auth.json or returns raw CLI output. */
export async function getCodexStatus(env = process.env, options = {}) {
  let directory;
  try {
    const executable = await codexExecutable(env, options);
    directory = await codexTemporaryDirectory();
    const status = codexLoginResult(await codexRun(executable, [...codexAuthArgs, 'login', 'status'], env, directory,
      { ...options, timeoutMs: options.statusTimeoutMs || 10000, maxOutputBytes: 64 * 1024 }));
    if (!status.configured) return status;
    const isolated = await codexInspectIsolation(executable, env, directory, options);
    return isolated.ok ? status : codexStatusResult(false, isolated.code, isolated.message);
  } catch (error) {
    return error.message === 'CODEX_NOT_INSTALLED'
      ? codexStatusResult(false, 'CODEX_NOT_INSTALLED', '未找到 Codex CLI，请安装后使用 ChatGPT 登录。')
      : codexStatusResult(false, 'CODEX_STATUS_UNAVAILABLE', '暂时无法检查本机 Codex 状态。');
  } finally { await codexCleanup(directory).catch(() => {}); }
}

export function buildCodexPrompt(input) {
  const request = buildAIResponseRequest(input);
  return request.instructions + '\n本次只根据下方数据生成 JSON，不使用工具，不读取文件，不执行命令，不访问网络或外部应用。\n'
    + '对话与当前上下文：\n' + JSON.stringify(request.input);
}

async function codexReadInput(request) {
  if (Number(request.headers.get('content-length')) > AI_MAX_REQUEST_BYTES) throw new Error('TOO_LARGE');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('INVALID_REQUEST');
  const chunks = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > AI_MAX_REQUEST_BYTES) { await reader.cancel(); throw new Error('TOO_LARGE'); }
    chunks.push(Buffer.from(value));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Generate a proposal only. Confirmation and applying changes belong to the UI. */
export async function handleCodexPlan(request, env = process.env, userId = 'local-user', options = {}) {
  if (!userId) return codexError('AUTH_REQUIRED', '请先登录后使用 AI 排程。', 401);
  if (request.method !== 'POST') return codexError('METHOD_NOT_ALLOWED', '仅接受排程请求。', 405);
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return codexError('JSON_REQUIRED', '请使用 JSON 提交排程请求。', 415);
  if (request.headers.get('origin') !== new URL(request.url).origin) return codexError('INVALID_ORIGIN', '请求来源不正确，请从本地周谱页面使用 AI。', 403);
  if (request.signal.aborted) return codexError('AI_CANCELLED', '已取消本次生成。', 499);
  if (codexActive) return codexError('AI_BUSY', '已有一个排程请求正在生成，请等待或取消后再试。', 429);
  let input;
  try { input = await codexReadInput(request); }
  catch (error) { return codexError('INVALID_REQUEST', '请求过大或格式不正确，请缩小任务范围。', error.message === 'TOO_LARGE' ? 413 : 400); }
  if (!validateAIContext(input)) return codexError('INVALID_CONTEXT', '请检查日期范围、任务与已有安排；每次可整理一天或连续七天。', 400);
  if (!input.context.tasks.length) return codexError('NO_TASKS', '请先添加或选择需要安排的任务。', 422);
  if (codexActive) return codexError('AI_BUSY', '已有一个排程请求正在生成，请稍后再试。', 429);
  codexActive = true;
  let directory;
  try {
    const executable = await codexExecutable(env, options);
    directory = await codexTemporaryDirectory();
    const status = codexLoginResult(await codexRun(executable, [...codexAuthArgs, 'login', 'status'], env, directory,
      { ...options, signal: request.signal, timeoutMs: options.statusTimeoutMs || 10000, maxOutputBytes: 64 * 1024 }));
    if (!status.configured) return codexError(status.code, status.message, status.code === 'AI_CANCELLED' ? 499 : 503);
    const isolated = await codexInspectIsolation(executable, env, directory, { ...options, signal: request.signal });
    if (!isolated.ok) return codexError(isolated.code, isolated.message, isolated.code === 'AI_CANCELLED' ? 499 : 503);
    const schemaPath = path.join(directory, 'proposal.schema.json');
    await writeFile(schemaPath, JSON.stringify(AI_PROPOSAL_SCHEMA), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const args = [...codexAuthArgs, '--strict-config', ...isolated.args,
      'exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--color', 'never',
      '--output-schema', schemaPath, '-'];
    const result = await codexRun(executable, args, env, directory, { ...options, signal: request.signal, stdin: buildCodexPrompt(input) });
    if (result.stopReason === 'cancelled') return codexError('AI_CANCELLED', '已取消本次生成。', 499);
    if (result.stopReason === 'timeout') return codexError('AI_TIMEOUT', 'Codex 生成超时，请稍后重试或缩小任务范围。', 504);
    if (result.stopReason === 'output_limit') return codexError('AI_OUTPUT_TOO_LARGE', 'Codex 返回内容过多，请缩小任务范围后重试。', 502);
    if (result.code !== 0) {
      if (/usage limit|rate.?limit|quota|limit reached|try again at/i.test(result.stderr + result.stdout)) return codexError('CODEX_LIMIT_REACHED', 'Codex 订阅额度或调用频率暂时受限，请等待恢复后重试；不会改用付费 API。', 429);
      if (/not logged in|unauthorized|authentication|token.*expired/i.test(result.stderr + result.stdout)) return codexError('CODEX_LOGIN_REQUIRED', 'Codex 登录可能已失效，请重新使用 ChatGPT 登录后重试。', 503);
      return codexError('CODEX_EXEC_FAILED', 'Codex 未能完成排程，请检查 CLI 版本、网络与本机安全设置后重试。', 502);
    }
    let proposal;
    try { proposal = JSON.parse(result.stdout.trim()); }
    catch { return codexError('AI_INVALID_RESPONSE', 'Codex 返回的方案格式不正确，请重新生成。', 502); }
    if (!validateAIProposal(proposal, input.context)) return codexError('AI_INVALID_PROPOSAL', '生成的安排存在冲突或不符合任务要求，请重新生成。', 502);
    if (request.signal.aborted) return codexError('AI_CANCELLED', '已取消本次生成。', 499);
    return codexJson({ proposal });
  } catch (error) {
    return error.message === 'CODEX_NOT_INSTALLED'
      ? codexError('CODEX_NOT_INSTALLED', '未找到 Codex CLI，请安装并使用 ChatGPT 登录。', 503)
      : codexError('CODEX_UNAVAILABLE', '暂时无法启动本机 Codex，请检查安装与目录权限。', 503);
  } finally {
    await codexCleanup(directory).catch(() => {});
    codexActive = false;
  }
}
