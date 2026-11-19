// Official Wrangler wrapper. It never reads, writes, or prints authentication tokens.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const configPath = resolve(root, 'wrangler.jsonc');
const examplePath = resolve(root, 'wrangler.example.jsonc');
const cliPath = resolve(root, 'node_modules/wrangler/bin/wrangler.js');
const loginScopes = ['account:read', 'user:read', 'workers:write', 'workers_scripts:write', 'd1:write'];
const [command = 'help', ...args] = process.argv.slice(2);
const fail = message => { console.error(message); process.exit(1); };
const load = () => JSON.parse(readFileSync(existsSync(configPath) ? configPath : examplePath, 'utf8'));
function run(parameters) {
  if (!existsSync(cliPath)) fail('尚未安装官方 Wrangler。请先在项目目录运行 pnpm install --frozen-lockfile。');
  const result = spawnSync(process.execPath, [cliPath, ...parameters], { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) fail(result.error.message);
  process.exit(result.status ?? 1);
}
function configured() {
  if (!existsSync(configPath)) fail('请先运行 configure --database-id <返回的 UUID>，生成本机部署配置 wrangler.jsonc。');
  const config = load();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(config.d1_databases?.[0]?.database_id || '')) {
    fail('尚未配置真实 D1 数据库 ID。创建数据库后运行 configure --database-id <返回的 UUID>。');
  }
  return config;
}
if (command === 'help') {
  console.log(`周谱 Cloudflare 免费部署助手
  node scripts/cloudflare.mjs login [--device] [--no-browser]
  node scripts/cloudflare.mjs whoami
  node scripts/cloudflare.mjs create-db
  node scripts/cloudflare.mjs configure --database-id <UUID> [--account-id <ID>]
  node scripts/cloudflare.mjs migrate
  node scripts/cloudflare.mjs dry-run
  node scripts/cloudflare.mjs deploy
  node scripts/cloudflare.mjs secret ACCESS_TEAM_DOMAIN
  node scripts/cloudflare.mjs secret ACCESS_AUD
  node scripts/cloudflare.mjs secret ALLOWED_EMAIL
  node scripts/cloudflare.mjs secret GOOGLE_CLIENT_ID
  node scripts/cloudflare.mjs secret GOOGLE_CLIENT_SECRET

configure 会从 wrangler.example.jsonc 生成 Git 忽略的 wrangler.jsonc。再次运行时会保留本机配置中的其他设置。
secret 命令只接收变量名，值在 Wrangler 的交互输入中填写。
login 仅申请账号读取、用户读取、Workers 编辑和 D1 编辑权限；--device 使用设备码授权。
这些命令不购买套餐或域名。请先确认 Cloudflare 控制台显示 Workers Free，详见 docs/cloudflare-setup.md。`);
} else if (command === 'configure') {
  const allowed = new Set(['--database-id', '--account-id']);
  const values = new Map();
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.has(args[i]) || !args[i + 1] || values.has(args[i])) fail('configure 参数无效。请运行 help 查看用法。');
    values.set(args[i], args[i + 1]);
  }
  const id = values.get('--database-id');
  const account = values.get('--account-id');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id || '')) fail('database-id 必须是 Cloudflare 返回的真实 UUID。');
  if (account !== undefined && !/^[0-9a-f]{32}$/i.test(account)) fail('account-id 格式无效。');
  const config = load();
  config.d1_databases[0].database_id = id;
  if (account) config.account_id = account;
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  console.log('已将 D1 绑定写入本机 wrangler.jsonc。');
} else if (command === 'login') {
  if (args.some(arg => !['--device', '--no-browser'].includes(arg)) || new Set(args).size !== args.length) {
    fail('login 只接受 --device 和 --no-browser；部署权限已固定为最小范围。');
  }
  run(['login', '--scopes', ...loginScopes, ...args]);
} else if (command === 'whoami') {
  if (args.length) fail('该命令不接受额外参数。');
  run([command]);
} else if (command === 'create-db') {
  if (args.length) fail('该命令不接受额外参数。');
  const config = load();
  const bootstrapPath = resolve(root, '.wrangler/weekprofiler-bootstrap.json');
  mkdirSync(dirname(bootstrapPath), { recursive: true });
  writeFileSync(bootstrapPath, JSON.stringify({ name: config.name, ...(config.account_id ? { account_id: config.account_id } : {}) }));
  run(['d1', 'create', config.d1_databases[0].database_name, '--config', bootstrapPath]);
} else if (command === 'migrate') {
  if (args.length) fail('该命令不接受额外参数。');
  configured();
  run(['d1', 'migrations', 'apply', 'DB', '--remote', '--config', configPath]);
} else if (command === 'deploy' || command === 'dry-run') {
  if (args.length) fail('该命令不接受额外参数。');
  const config = configured();
  if (!existsSync(resolve(root, config.main))) fail('尚未构建云端版本，请先运行 node build.mjs。');
  run(['deploy', '--config', configPath, ...(command === 'dry-run' ? ['--dry-run'] : [])]);
} else if (command === 'secret') {
  if (args.length !== 1 || !['ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'ALLOWED_EMAIL', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'].includes(args[0])) fail('只允许设置 Google 登录、Access 登录和允许邮箱的配置项。');
  configured();
  run(['secret', 'put', args[0], '--config', configPath]);
} else {
  fail('未知命令。运行 node scripts/cloudflare.mjs help 查看用法。');
}
