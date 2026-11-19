// Loopback-only integration preview. This identity adapter is NEVER deployed.
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import worker from './dist/cloudflare/index.js';
import { handleSync } from './worker/sync-api.mjs';

const port = Number(process.env.WEEKPROFILER_CLOUD_PREVIEW_PORT || 5190);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid preview port');
mkdirSync('.sites-runtime', { recursive: true });
const sqlite = new DatabaseSync('.sites-runtime/cloud-preview-' + port + '.sqlite');
sqlite.exec('CREATE TABLE IF NOT EXISTS preview_migrations (name TEXT PRIMARY KEY)');
for (const name of readdirSync('drizzle').filter(name => name.endsWith('.sql')).sort()) {
  if (sqlite.prepare('SELECT name FROM preview_migrations WHERE name = ?').get(name)) continue;
  sqlite.exec('BEGIN');
  try { sqlite.exec(readFileSync('drizzle/' + name, 'utf8')); sqlite.prepare('INSERT INTO preview_migrations VALUES (?)').run(name); sqlite.exec('COMMIT'); }
  catch (error) { sqlite.exec('ROLLBACK'); throw error; }
}
const statement = (sql, values = []) => ({ sql, values,
  bind(...params) { return statement(sql, params); },
  async first() { return sqlite.prepare(sql).get(...values) || null; },
});
const env = { DB: { prepare: statement, async batch(statements) {
  sqlite.exec('BEGIN');
  try { const results = statements.map(s => sqlite.prepare(s.sql).run(...s.values)); sqlite.exec('COMMIT'); return results; }
  catch (error) { sqlite.exec('ROLLBACK'); throw error; }
} } };
const server = createServer(async (req, res) => {
  try {
    if (!['127.0.0.1:' + port, 'localhost:' + port].includes(req.headers.host)) { res.writeHead(403); res.end('Loopback preview only'); return; }
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 5_000_000) { res.writeHead(413); res.end(); return; } chunks.push(chunk); }
    const url = new URL(req.url, 'http://' + req.headers.host);
    const request = new Request(url, { method: req.method, headers: req.headers,
      ...(['GET', 'HEAD'].includes(req.method) ? {} : { body: Buffer.concat(chunks) }) });
    const response = url.pathname === '/api/session'
      ? Response.json({ userId: 'local-cloud-preview-owner', email: '本机同步测试', sync: 'operations-v1' })
      : url.pathname === '/api/sync' ? await handleSync(request, env, 'local-cloud-preview-owner')
      : await worker.fetch(request, env);
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
  } catch { res.writeHead(500); res.end('Preview error'); }
});
server.listen(port, '127.0.0.1', () => console.log('Cloud sync integration preview (local test data only): http://127.0.0.1:' + port));
