import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCodexStatus, handleCodexPlan } from '../lib/codex-transport.mjs';

const codexTestUrl = 'http://127.0.0.1:8788/api/ai/plan';
const codexTestEnv = { PATH: '', OPENAI_API_KEY: 'test-secret-api', CODEX_API_KEY: 'test-secret-codex', openai_api_key: 'test-case-key' };
function codexTestInput() {
  return { messages: [{ role: 'user', content: '帮我安排阅读，不执行任何命令。' }], context: {
    tasks: [{ id: 'read', title: '阅读', duration: 60, category: 'learn', reusable: false, done: false }],
    groups: [{ id: 'learn', name: '学习', color: '#aabbcc' }], timezone: 'Asia/Shanghai',
    startDate: '2026-11-15', endDate: '2026-11-15', days: [{ date: '2026-11-15', blocks: [] }],
  } };
}
function codexTestProposal() { return { reply: '建议上午阅读。', explanation: '保留其余空闲。', assignments: [{ taskId: 'read', date: '2026-11-15', start: 600, duration: 60 }], unscheduledTaskIds: [] }; }
function codexTestRequest(input = codexTestInput(), signal) {
  return new Request(codexTestUrl, { method: 'POST', headers: { Origin: 'http://127.0.0.1:8788', 'Content-Type': 'application/json' }, body: JSON.stringify(input), ...(signal ? { signal } : {}) });
}
function mockCodex(handler = () => ({})) {
  const calls = [];
  const options = { command: 'mock-codex',
    spawnImpl(command, args, settings) {
      const child = new EventEmitter(); child.pid = 12345;
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => { child.killed = true; child.emit('close', null); return true; };
      let stdin = '';
      child.stdin = new Writable({ write(chunk, encoding, callback) {
        stdin += chunk.toString(); callback();
        if (args.includes('app-server')) for (const line of chunk.toString().trim().split('\n')) {
          const message = JSON.parse(line);
          queueMicrotask(() => {
            if (message.method === 'initialize') child.stdout.write(JSON.stringify({ id: 0, result: { userAgent: 'mock' } }) + '\n');
            if (message.method === 'hooks/list') {
              const call = { command, args, settings, stdin, child }; calls.push(call);
              const result = handler(call) || {};
              if (result.hold) return;
              child.stdout.write(result.stdout ?? JSON.stringify({ id: 1, result: { data: [{ cwd: settings.cwd,
                hooks: result.hooks || [], errors: result.errors || [], warnings: result.warnings || [] }] } }) + '\n');
            }
          });
        }
      }, final(callback) {
        callback(); queueMicrotask(() => {
          if (args.includes('app-server')) { child.stdout.end(); child.stderr.end(); child.emit('close', 0); return; }
          const call = { command, args, settings, stdin, child }; calls.push(call);
          const result = handler(call) || {};
          if (result.hold) return;
          if (result.error) { child.emit('error', result.error); return; }
          const isLogin = args.includes('login');
          const defaults = isLogin ? '' : args.includes('features')
            ? ['shell_tool', 'apps', 'multi_agent', 'view_image', 'plugins', 'remote_plugin'].map(name => name + '\tstable\tfalse').join('\n') + '\nhooks\tstable\ttrue\n'
            : args.includes('mcp') ? '[]' : JSON.stringify(codexTestProposal());
          child.stdout.end(result.stdout ?? defaults);
          child.stderr.end(result.stderr ?? (isLogin ? 'Logged in using ChatGPT\n' : ''));
          child.emit('close', result.code ?? 0);
        });
      } });
      return child;
    },
    terminateImpl(child) { child.kill(); },
  };
  return { options, calls };
}

test('status confirms ChatGPT only and never returns raw CLI output or API keys', async () => {
  const ready = mockCodex();
  const status = await getCodexStatus(codexTestEnv, ready.options);
  assert.equal(status.configured, true); assert.equal(status.authMethod, 'chatgpt'); assert.equal(status.provider, 'codex');
  assert.equal(ready.calls.length, 4);
  assert.deepEqual(ready.calls[0].args.slice(-2), ['login', 'status']);
  assert.equal(existsSync(ready.calls[0].settings.cwd), false);
  const api = mockCodex(() => ({ stderr: 'Logged in using an API key: test-secret-api' }));
  const rejected = await getCodexStatus(codexTestEnv, api.options);
  assert.equal(rejected.configured, false); assert.equal(rejected.code, 'CODEX_CHATGPT_LOGIN_REQUIRED');
  assert.equal(JSON.stringify(rejected).includes('test-secret-api'), false);
  const configuredApi = mockCodex(() => ({ stderr: 'API key configured: test-secret-api' }));
  assert.equal((await getCodexStatus(codexTestEnv, configuredApi.options)).code, 'CODEX_CHATGPT_LOGIN_REQUIRED');
});

test('missing CLI and signed-out CLI have actionable statuses without a generation call', async () => {
  const missing = await getCodexStatus({ PATH: '' });
  assert.equal(missing.code, 'CODEX_NOT_INSTALLED');
  const signedOut = mockCodex(() => ({ code: 1, stderr: 'Not logged in' }));
  const response = await handleCodexPlan(codexTestRequest(), codexTestEnv, 'user', signedOut.options);
  assert.equal(response.status, 503); assert.equal((await response.json()).code, 'CODEX_LOGIN_REQUIRED');
  assert.equal(signedOut.calls.length, 1);
});

test('the weekprofiler CLI override takes priority and the previous override remains compatible', async () => {
  const script = fileURLToPath(new URL('../lib/ai-planner.mjs', import.meta.url));
  const current = mockCodex();
  delete current.options.command;
  const configured = await getCodexStatus({ PATH: '', WEEKPROFILER_CODEX_BIN: script, DAYLOOM_CODEX_BIN: process.execPath }, current.options);
  assert.equal(configured.configured, true);
  assert.equal(current.calls[0].command, process.execPath);
  assert.equal(current.calls[0].args[0], script);

  const legacy = mockCodex();
  delete legacy.options.command;
  assert.equal((await getCodexStatus({ PATH: '', DAYLOOM_CODEX_BIN: process.execPath }, legacy.options)).configured, true);
  assert.equal(legacy.calls[0].command, process.execPath);
  assert.equal(legacy.calls[0].args[0], '-c');

  const invalid = mockCodex();
  delete invalid.options.command;
  assert.equal((await getCodexStatus({ PATH: '', WEEKPROFILER_CODEX_BIN: 'relative-path', DAYLOOM_CODEX_BIN: process.execPath }, invalid.options)).code, 'CODEX_NOT_INSTALLED');
  assert.equal(invalid.calls.length, 0);
});

test('successful Codex generation uses stdin, immutable schema, read-only sandbox, and scrubbed environment', async () => {
  const input = codexTestInput(); input.messages[0].content = '请阅读：$(write-secret) & echo command';
  const mock = mockCodex(call => {
    assert.equal(call.settings.shell, false); assert.equal(call.settings.windowsHide, true);
    assert.equal(Object.keys(call.settings.env).some(key => /^(OPENAI_API_KEY|CODEX_API_KEY)$/i.test(key)), false);
    assert.ok(path.isAbsolute(call.settings.cwd)); assert.ok(path.basename(call.settings.cwd).startsWith('weekprofiler-codex-'));
    assert.ok(call.args.includes('forced_login_method="chatgpt"')); assert.ok(call.args.includes('model_provider="openai"'));
    if (call.args.includes('exec')) {
      assert.ok(call.args.includes('--ephemeral')); assert.equal(call.args[call.args.indexOf('--sandbox') + 1], 'read-only');
      assert.ok(call.args.includes('features.shell_tool=false')); assert.ok(call.args.includes('features.apps=false'));
      assert.ok(call.args.includes('--strict-config')); assert.equal(call.args.at(-1), '-');
      assert.equal(call.args.some(value => value.includes('write-secret')), false);
      assert.match(call.stdin, /write-secret/);
      const schemaPath = call.args[call.args.indexOf('--output-schema') + 1];
      assert.equal(path.dirname(schemaPath), call.settings.cwd);
      const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
      assert.equal(schema.additionalProperties, false);
    }
    return {};
  });
  const response = await handleCodexPlan(codexTestRequest(input), codexTestEnv, 'user', mock.options);
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { proposal: codexTestProposal() });
  assert.equal(mock.calls.length, 5);
  for (const call of mock.calls) assert.equal(existsSync(call.settings.cwd), false);
});

test('invalid input and cross-origin calls cannot launch Codex', async () => {
  const mock = mockCodex();
  const input = codexTestInput(); input.context.tasks[0].duration = 45;
  assert.equal((await handleCodexPlan(codexTestRequest(input), codexTestEnv, 'user', mock.options)).status, 400);
  const request = new Request(codexTestUrl, { method: 'POST', headers: { Origin: 'null', 'Content-Type': 'application/json' }, body: JSON.stringify(codexTestInput()) });
  assert.equal((await handleCodexPlan(request, codexTestEnv, 'user', mock.options)).status, 403);
  assert.equal(mock.calls.length, 0);
});

test('configured MCP servers are disabled and verified while user security configuration is preserved', async () => {
  const mock = mockCodex(call => {
    assert.equal(call.args.some(arg => /ignore-rules|ignore-user-config|dangerously|approval_policy=|features\.hooks=/.test(arg)), false);
    if (call.args.includes('mcp')) return { stdout: JSON.stringify([{ name: 'calendar_1', enabled: !call.args.includes('mcp_servers.calendar_1.enabled=false'), env: { API_TOKEN: 'secret-not-returned' } }]) };
    if (call.args.includes('exec') || call.args.includes('app-server')) {
      assert.ok(call.args.includes('mcp_servers.calendar_1.enabled=false'));
      for (const name of ['shell_tool', 'apps', 'multi_agent', 'view_image', 'plugins', 'remote_plugin']) assert.ok(call.args.includes(`features.${name}=false`));
    }
    if (call.args.includes('app-server')) {
      const requests = call.stdin.trim().split('\n').map(line => JSON.parse(line));
      assert.deepEqual(requests.map(item => item.method), ['initialize', 'initialized', 'hooks/list']);
    }
    return {};
  });
  const response = await handleCodexPlan(codexTestRequest(), codexTestEnv, 'user', mock.options);
  assert.equal(response.status, 200);
  assert.equal(mock.calls.filter(call => call.args.includes('mcp')).length, 2);
});

test('enabled hooks block generation without disabling hooks or disclosing their commands', async () => {
  const mock = mockCodex(call => call.args.includes('app-server') ? { hooks: [{ enabled: true, command: 'secret-not-returned' }] } : {});
  const response = await handleCodexPlan(codexTestRequest(), codexTestEnv, 'user', mock.options);
  assert.equal(response.status, 503);
  const body = await response.json(); assert.equal(body.code, 'CODEX_HOOKS_ACTIVE');
  assert.equal(JSON.stringify(body).includes('secret-not-returned'), false);
  assert.equal(mock.calls.some(call => call.args.includes('exec')), false);
  assert.equal(mock.calls.some(call => call.args.some(arg => /features\.(codex_)?hooks=/.test(arg))), false);
});

test('disabled hooks are compatible and unknown hook metadata fails closed', async () => {
  const disabled = mockCodex(call => call.args.includes('app-server') ? { hooks: [{ enabled: false }] } : {});
  assert.equal((await getCodexStatus(codexTestEnv, disabled.options)).configured, true);
  for (const invalid of [{ errors: ['secret-not-returned'] }, { hooks: [{}] }, { stdout: '{"id":1,"result":{"data":[]}}\n' }]) {
    const mock = mockCodex(call => call.args.includes('app-server') ? invalid : {});
    const status = await getCodexStatus(codexTestEnv, mock.options);
    assert.equal(status.code, 'CODEX_ISOLATION_UNAVAILABLE');
    assert.equal(JSON.stringify(status).includes('secret-not-returned'), false);
  }
});

test('unverifiable tool configuration and unsafe MCP names fail closed before generation', async () => {
  for (const handler of [
    call => call.args.includes('features') ? { stdout: 'hooks stable true\nplugins stable true\n' } : {},
    call => call.args.includes('mcp') ? { stdout: JSON.stringify([{ name: 'bad.name', enabled: true }]) } : {},
    call => call.args.includes('mcp') ? { stdout: JSON.stringify([{ name: 'mandatory', enabled: true }]) } : {},
  ]) {
    const mock = mockCodex(handler);
    const response = await handleCodexPlan(codexTestRequest(), codexTestEnv, 'user', mock.options);
    assert.equal(response.status, 503); assert.equal((await response.json()).code, 'CODEX_ISOLATION_UNAVAILABLE');
    assert.equal(mock.calls.some(call => call.args.includes('exec')), false);
  }
});

test('subscription limits and CLI failures never fall back to API or disclose diagnostics', async () => {
  for (const [diagnostic, expected] of [['Usage limit reached, test-secret-api', 429], ['Unexpected config error test-secret-api', 502]]) {
    const mock = mockCodex(call => call.args.includes('exec') ? { code: 1, stderr: diagnostic } : {});
    const response = await handleCodexPlan(codexTestRequest(), codexTestEnv, 'user', mock.options);
    assert.equal(response.status, expected);
    assert.equal((await response.text()).includes('test-secret-api'), false);
    assert.equal(mock.calls.length, 5);
  }
});

test('unknown tasks, malformed JSON, and overlapping proposal output are rejected', async () => {
  for (const stdout of ['not JSON', JSON.stringify({ ...codexTestProposal(), assignments: [{ taskId: 'unknown', date: '2026-11-15', start: 600, duration: 60 }] })]) {
    const mock = mockCodex(call => call.args.includes('exec') ? { stdout } : {});
    const response = await handleCodexPlan(codexTestRequest(), codexTestEnv, 'user', mock.options);
    assert.equal(response.status, 502);
    assert.equal('proposal' in await response.json(), false);
  }
});

test('timeout terminates the owned child and removes its temporary directory', async () => {
  const mock = mockCodex(call => call.args.includes('exec') ? { hold: true } : {});
  const response = await handleCodexPlan(codexTestRequest(), codexTestEnv, 'user', { ...mock.options, timeoutMs: 5 });
  assert.equal(response.status, 504); assert.equal((await response.json()).code, 'AI_TIMEOUT');
  const exec = mock.calls.find(call => call.args.includes('exec'));
  assert.equal(exec.child.killed, true); assert.equal(existsSync(exec.settings.cwd), false);
});

test('cancellation terminates the owned child and never returns a proposal', async () => {
  const controller = new AbortController();
  const mock = mockCodex(call => { if (call.args.includes('exec')) { controller.abort(); return { hold: true }; } return {}; });
  const response = await handleCodexPlan(codexTestRequest(codexTestInput(), controller.signal), codexTestEnv, 'user', mock.options);
  assert.equal(response.status, 499); assert.equal((await response.json()).code, 'AI_CANCELLED');
  assert.equal(mock.calls.find(call => call.args.includes('exec')).child.killed, true);
});

test('only one generation may be active at a time', async () => {
  let releaseStarted;
  const started = new Promise(resolve => { releaseStarted = resolve; });
  const mock = mockCodex(call => { if (call.args.includes('exec')) { releaseStarted(call); return { hold: true }; } return {}; });
  const pending = handleCodexPlan(codexTestRequest(), codexTestEnv, 'user', mock.options);
  const running = await started;
  const second = await handleCodexPlan(codexTestRequest(), codexTestEnv, 'user', mock.options);
  assert.equal(second.status, 429); assert.equal((await second.json()).code, 'AI_BUSY');
  running.child.stdout.end(JSON.stringify(codexTestProposal())); running.child.emit('close', 0);
  assert.equal((await pending).status, 200);
});
