import { MAX_STATE_BYTES, validateData } from '../lib/planner.mjs';

const MAX_REQUEST_BYTES = MAX_STATE_BYTES + 1024;

function plannerJson(value, status = 200) {
  return Response.json(value, {
    status,
    headers: { 'Cache-Control': 'private, no-store', 'Vary': 'Cookie', 'X-Content-Type-Options': 'nosniff' },
  });
}

async function readBoundedPlannerJson(request) {
  if (Number(request.headers.get('content-length')) > MAX_REQUEST_BYTES) throw new Error('too_large');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('invalid_json');
  const parts = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_REQUEST_BYTES) { await reader.cancel(); throw new Error('too_large'); }
    parts.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** userId must be derived only from platform-authenticated request identity. */
export async function handlePlanner(request, env, userId) {
  if (!userId) return plannerJson({ error: '请先登录后同步日程。' }, 401);
  if (!['GET', 'PUT'].includes(request.method)) return plannerJson({ error: '不支持的请求方式。' }, 405);
  if (!env.DB) return plannerJson({ error: '云端存储暂不可用，请保留本地修改。' }, 503);
  if (request.method === 'GET') {
    try {
      const row = await env.DB.prepare('SELECT data, revision FROM planner_states WHERE user_id = ?').bind(userId).first();
      return plannerJson(row ? { data: JSON.parse(row.data), revision: row.revision } : { data: null, revision: 0 });
    } catch { return plannerJson({ error: '暂时无法读取云端日程，请稍后重试。' }, 503); }
  }

  // JSON and same-origin checks prevent a cross-site form from changing a plan.
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return plannerJson({ error: '仅接受 JSON 数据。' }, 415);
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return plannerJson({ error: '请求来源不正确。' }, 403);
  let input;
  try { input = await readBoundedPlannerJson(request); }
  catch (error) { return plannerJson({ error: '日程文件过大或格式不正确。' }, error.message === 'too_large' ? 413 : 400); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return plannerJson({ error: '日程数据格式不正确。' }, 400);
  const { data, baseRevision, mutationId } = input;
  if (!validateData(data) || !Number.isSafeInteger(baseRevision) || baseRevision < 0 || baseRevision >= Number.MAX_SAFE_INTEGER - 1
      || typeof mutationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(mutationId)) {
    return plannerJson({ error: '请检查任务时间、重复编号或日程冲突。' }, 400);
  }
  try {
    const serialized = JSON.stringify(data);
    // Both writes are atomic compare-and-swap. A stale device cannot overwrite
    // newer data; retrying the last mutation after a lost response is harmless.
    const statement = baseRevision === 0
      ? env.DB.prepare('INSERT INTO planner_states (user_id, data, revision, mutation_id) VALUES (?, ?, 1, ?) ON CONFLICT(user_id) DO NOTHING RETURNING revision').bind(userId, serialized, mutationId)
      : env.DB.prepare('UPDATE planner_states SET data = ?, revision = ?, mutation_id = ? WHERE user_id = ? AND revision = ? RETURNING revision').bind(serialized, baseRevision + 1, mutationId, userId, baseRevision);
    const written = await statement.first();
    if (written) return plannerJson({ revision: written.revision });
    const current = await env.DB.prepare('SELECT revision, mutation_id FROM planner_states WHERE user_id = ?').bind(userId).first();
    if (current?.mutation_id === mutationId) return plannerJson({ revision: current.revision });
    return plannerJson({ error: '另一台设备已修改日程，请保留当前修改后加载云端版本。', revision: current?.revision ?? 0 }, 409);
  } catch { return plannerJson({ error: '暂时无法保存到云端，请保留本地修改后重试。' }, 503); }
}
