import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { seedData, legacySeedData, validateData, migrateData } from '../lib/planner.mjs';
import { handlePlanner } from '../worker/api.mjs';

const endpoint = 'https://planner.example/api/planner';
function environment() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../drizzle/0000_planner.sql', import.meta.url), 'utf8'));
  return {
    DB: {
      prepare(sql) {
        return { bind(...params) { return { async first() { return sqlite.prepare(sql).get(...params) ?? null; } }; } };
      },
    },
    close: () => sqlite.close(),
  };
}
function put(data, baseRevision, mutationId, headers = {}) {
  return new Request(endpoint, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', 'Origin': 'https://planner.example', ...headers },
    body: JSON.stringify({ data, baseRevision, mutationId }),
  });
}

test('starter suggestions are valid, independent, and have no scheduled dates', () => {
  assert.equal(validateData(seedData()), true);
  assert.deepEqual(seedData().days, {});
  const changed = seedData();
  changed.tasks[0].done = true;
  assert.equal(seedData().tasks[0].done, false);
});

test('completion preferences are optional booleans and survive backup migration without changing defaults', () => {
  const defaults = seedData();
  assert.ok(defaults.groups.every(group => group.countTowardsCompletion === undefined));
  assert.deepEqual(migrateData(defaults).groups, defaults.groups);
  for (const version of [2, 3]) {
    const data = migrateData(legacySeedData()); data.version = version;
    data.groups.find(group => group.id === 'life').countTowardsCompletion = false;
    data.groups.find(group => group.id === 'work').countTowardsCompletion = true;
    const backup = JSON.parse(JSON.stringify(data));
    assert.equal(validateData(backup), true);
    const migrated = migrateData(backup);
    assert.deepEqual(migrated.groups, data.groups);
    migrated.groups.find(group => group.id === 'life').countTowardsCompletion = true;
    assert.equal(data.groups.find(group => group.id === 'life').countTowardsCompletion, false);
  }
  for (const invalid of ['false', 0, null, {}, []]) {
    const data = seedData(); data.groups[0].countTowardsCompletion = invalid;
    assert.equal(validateData(data), false);
    assert.throws(() => migrateData(data));
  }
});

test('validation rejects invalid times, impossible dates, duplicate IDs, overlap, and timezones', () => {
  for (const mutate of [
    data => { data.tasks[0].duration = 45; },
    data => { data.tasks.push({ ...data.tasks[0] }); },
    data => { data.templates[0].blocks[1].start = data.templates[0].blocks[0].start; },
    data => { data.days['2026-02-30'] = []; },
    data => { data.templates[0].blocks[0].start = -30; },
    data => { data.templates[0].blocks[0].duration = 1440; },
    data => { data.timezone = 'Not/A_Timezone'; },
    data => { data.tasks[0].title = ' '; },
  ]) {
    const data = seedData(); mutate(data); assert.equal(validateData(data), false);
  }
  const adjacent = seedData();
  adjacent.days['2028-02-29'] = [
    { id: 'b1', title: 'A', start: 240, duration: 30, category: 'work', done: false },
    { id: 'b2', title: 'B', start: 270, duration: 30, category: 'work', done: false },
  ];
  assert.equal(validateData(adjacent), true);
});

test('persistent state is scoped by authenticated user and initial create is revisioned', async () => {
  const env = environment();
  try {
    const blank = await handlePlanner(new Request(endpoint), env, 'alice');
    assert.deepEqual(await blank.json(), { data: null, revision: 0 });
    const saved = await handlePlanner(put(seedData(), 0, 'create-a'), env, 'alice');
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), { revision: 1 });
    const read = await handlePlanner(new Request(endpoint), env, 'alice');
    assert.equal((await read.json()).data.tasks[0].title, '阅读一篇论文');
    assert.match(read.headers.get('Cache-Control'), /no-store/);
    const other = await handlePlanner(new Request(endpoint), env, 'bob');
    assert.deepEqual(await other.json(), { data: null, revision: 0 });
    assert.equal((await handlePlanner(new Request(endpoint), env, null)).status, 401);
  } finally { env.close(); }
});

test('lost-response retries are idempotent and concurrent devices cannot overwrite each other', async () => {
  const env = environment();
  try {
    const initial = seedData();
    await handlePlanner(put(initial, 0, 'initial'), env, 'alice');
    const retry = await handlePlanner(put(initial, 0, 'initial'), env, 'alice');
    assert.deepEqual(await retry.json(), { revision: 1 });
    const desktop = seedData(); desktop.tasks[0].title = '电脑的修改';
    const mobile = seedData(); mobile.tasks[0].title = '手机的修改';
    const results = await Promise.all([
      handlePlanner(put(desktop, 1, 'desktop'), env, 'alice'),
      handlePlanner(put(mobile, 1, 'mobile'), env, 'alice'),
    ]);
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
    const current = await (await handlePlanner(new Request(endpoint), env, 'alice')).json();
    assert.equal(current.revision, 2);
    const winner = current.data.tasks[0].title === '电脑的修改' ? { data: desktop, id: 'desktop' } : { data: mobile, id: 'mobile' };
    assert.equal((await handlePlanner(put(winner.data, 1, winner.id), env, 'alice')).status, 200);
    assert.equal((await handlePlanner(put(initial, 0, 'old-create'), env, 'alice')).status, 409);
  } finally { env.close(); }
});

test('invalid writes and cross-origin requests leave saved state intact', async () => {
  const env = environment();
  try {
    await handlePlanner(put(seedData(), 0, 'good'), env, 'alice');
    const invalid = seedData(); invalid.tasks[0].duration = 15;
    assert.equal((await handlePlanner(put(invalid, 1, 'bad'), env, 'alice')).status, 400);
    assert.equal((await handlePlanner(put(seedData(), 1, 'cross', { Origin: 'https://elsewhere.example' }), env, 'alice')).status, 403);
    assert.equal((await handlePlanner(put(seedData(), 1, 'form', { 'Content-Type': 'text/plain' }), env, 'alice')).status, 415);
    const current = await (await handlePlanner(new Request(endpoint), env, 'alice')).json();
    assert.equal(current.revision, 1);
  } finally { env.close(); }
});
