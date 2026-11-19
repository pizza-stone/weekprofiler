import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { seedData, legacySeedData, validateData, migrateData, resolveDay, materializeDay, mondayOf, addDays } from '../lib/planner.mjs';
import { startTracking, pauseTracking, resumeTracking, stopTracking } from '../lib/tracking.mjs';
import { validateAIContext, validateAIProposal } from '../lib/ai-planner.mjs';
import { handlePlanner } from '../worker/api.mjs';

const date = '2026-11-16';
const beginning = Date.parse('2026-11-16T02:10:13.427Z');
const endpoint = 'https://planner.example/api/planner';
const clone = value => JSON.parse(JSON.stringify(value));

function trackedData() {
  const data = seedData();
  const block = { id: 'tracked-occurrence', title: 'Current plan', category: 'learn', start: 600, duration: 60, done: false };
  data.days[date] = [block];
  startTracking(data, date, block, beginning, 'timer-one');
  pauseTracking(data, beginning + 61001, 'segment-one');
  resumeTracking(data, beginning + 91003);
  return data;
}

function legacyData(version) {
  const data = migrateData(legacySeedData());
  data.version = version;
  if (version === 1) {
    delete data.groups;
    delete data.dayMeta;
    delete data.weekTemplates;
    delete data.cycle;
  }
  return data;
}

function environment() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../drizzle/0000_planner.sql', import.meta.url), 'utf8'));
  return {
    DB: { prepare(sql) { return { bind(...params) { return { async first() { return sqlite.prepare(sql).get(...params) ?? null; } }; } }; } },
    close() { sqlite.close(); },
  };
}

function put(data, baseRevision, mutationId) {
  return new Request(endpoint, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: 'https://planner.example' },
    body: JSON.stringify({ data, baseRevision, mutationId }),
  });
}

test('old V1/V2/V3 backups without tracking still migrate without inventing actual records', () => {
  for (const version of [1, 2, 3]) {
    const data = legacyData(version), before = clone(data);
    assert.equal(validateData(data), true);
    const migrated = migrateData(data);
    assert.equal(migrated.version, 3);
    assert.equal(validateData(migrated), true);
    assert.equal(Object.hasOwn(migrated, 'tracking'), false);
    assert.deepEqual(data, before);
  }
});

test('backup JSON and migration retain millisecond sessions and both running and paused timers independently', () => {
  for (const paused of [false, true]) {
    const original = trackedData();
    if (paused) pauseTracking(original, beginning + 151007, 'segment-two');
    const backup = JSON.parse(JSON.stringify({ app: 'weekprofiler', data: original }));
    const restored = migrateData(backup.data);
    assert.equal(validateData(restored), true);
    assert.deepEqual(restored.tracking, original.tracking);
    assert.equal(restored.tracking.sessions[0].startedAt, beginning);
    assert.equal(restored.tracking.sessions[0].endedAt, beginning + 61001);
    assert.equal(restored.tracking.timer.startedAt, paused ? null : beginning + 91003);
    restored.tracking.sessions[0].title = 'Restored copy';
    restored.tracking.timer.title = 'Independent timer';
    assert.equal(original.tracking.sessions[0].title, 'Current plan');
    assert.equal(original.tracking.timer.title, 'Current plan');
  }
});

test('planner validation rejects malformed tracking rather than silently accepting or dropping it', () => {
  const mutations = [
    data => { data.tracking = null; },
    data => { delete data.tracking.timer; },
    data => { data.tracking.sessions[0].endedAt = data.tracking.sessions[0].startedAt; },
    data => { data.tracking.sessions[0].startedAt = '2026-11-16T02:10:13Z'; },
    data => { data.tracking.sessions.push({ ...data.tracking.sessions[0] }); },
    data => { data.tracking.timer.planDate = '2026-02-30'; },
    data => { data.tracking.timer.startedAt = data.tracking.sessions[0].startedAt; },
  ];
  for (const mutate of mutations) {
    const data = trackedData(); mutate(data);
    const before = clone(data);
    assert.equal(validateData(data), false);
    assert.throws(() => migrateData(data));
    assert.deepEqual(data, before);
  }
});

test('removing a plan and its group retains stoppable timer and historical actual records', () => {
  const data = trackedData();
  data.days[date] = [];
  data.tracking.timer.category = 'removed-group';
  data.tracking.sessions[0].category = 'removed-group';
  assert.equal(data.groups.some(group => group.id === 'removed-group'), false);
  assert.equal(validateData(data), true);
  const restored = migrateData(clone(data));
  stopTracking(restored, beginning + 151007, 'segment-two');
  assert.equal(validateData(restored), true);
  assert.equal(restored.tracking.timer, null);
  assert.equal(restored.tracking.sessions.length, 2);
  assert.ok(restored.tracking.sessions.every(session => session.title === 'Current plan'));
  assert.deepEqual(restored.days[date], []);
});

test('SQLite persistence restores running and paused timers, rejects stale writers, and retries stops idempotently', async () => {
  const env = environment();
  const read = async () => (await handlePlanner(new Request(endpoint), env, 'owner')).json();
  try {
    const data = trackedData();
    assert.equal((await handlePlanner(put(data, 0, 'initial-timer'), env, 'owner')).status, 200);
    const running = await read();
    assert.deepEqual(running.data, data);
    assert.equal(running.revision, 1);

    const paused = migrateData(running.data);
    pauseTracking(paused, beginning + 151007, 'segment-two');
    assert.equal((await handlePlanner(put(paused, 1, 'pause-timer'), env, 'owner')).status, 200);
    const savedPause = await read();
    assert.equal(savedPause.data.tracking.timer.startedAt, null);
    assert.deepEqual(savedPause.data.tracking, paused.tracking);

    const stale = clone(running.data);
    stopTracking(stale, beginning + 180000, 'stale-segment');
    assert.equal((await handlePlanner(put(stale, 1, 'stale-stop'), env, 'owner')).status, 409);
    assert.deepEqual(await read(), savedPause);

    const resumed = migrateData(savedPause.data);
    resumeTracking(resumed, beginning + 211009);
    assert.equal((await handlePlanner(put(resumed, 2, 'resume-timer'), env, 'owner')).status, 200);
    const reloaded = await read();
    assert.equal(reloaded.data.tracking.timer.startedAt, beginning + 211009);
    stopTracking(reloaded.data, beginning + 271011, 'segment-three');
    const stopped = await handlePlanner(put(reloaded.data, 3, 'stop-timer'), env, 'owner');
    assert.deepEqual(await stopped.json(), { revision: 4 });
    const retry = await handlePlanner(put(reloaded.data, 3, 'stop-timer'), env, 'owner');
    assert.deepEqual(await retry.json(), { revision: 4 });
    const final = await read();
    assert.equal(final.data.tracking.timer, null);
    assert.equal(final.data.tracking.sessions.length, 3);
    assert.deepEqual(final.data.tracking, reloaded.data.tracking);

    const invalid = clone(final.data);
    invalid.tracking.sessions[0].endedAt = invalid.tracking.sessions[0].startedAt - 1;
    assert.equal((await handlePlanner(put(invalid, 4, 'invalid-record'), env, 'owner')).status, 400);
    assert.deepEqual(await read(), final);
    assert.deepEqual(await (await handlePlanner(new Request(endpoint), env, 'another-owner')).json(), { data: null, revision: 0 });
  } finally { env.close(); }
});

test('portable local storage retains precise tracking and uses the same stale-write protection', async () => {
  const storage = new Map();
  const context = vm.createContext({
    validateData, Response,
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
  });
  vm.runInContext(readFileSync(new URL('../portable-adapter.js', import.meta.url), 'utf8') + '\nglobalThis.portableFetch=fetch;', context);
  const fetch = context.portableFetch;
  const write = (data, baseRevision, mutationId) => fetch('/api/planner', { method: 'PUT', body: JSON.stringify({ data, baseRevision, mutationId }) });
  const data = trackedData();
  assert.equal((await write(data, 0, 'portable-start')).status, 200);
  assert.ok(storage.has('dayloom-portable-db'));
  const saved = await (await fetch('/api/planner')).json();
  assert.deepEqual(saved.data.tracking, data.tracking);
  const paused = migrateData(saved.data);
  pauseTracking(paused, beginning + 151007, 'segment-two');
  assert.equal((await write(paused, 1, 'portable-pause')).status, 200);
  assert.equal((await write(data, 1, 'stale-window')).status, 409);
  assert.equal((await write(paused, 1, 'portable-pause')).status, 200);
  const restored = await (await fetch('/api/planner')).json();
  assert.equal(restored.revision, 2);
  assert.deepEqual(restored.data.tracking, paused.tracking);
});

test('AI never receives tracking and applies a proposal while preserving timer changes made after generation', () => {
  const context = vm.createContext({ resolveDay, materializeDay, mondayOf, addDays, validateData, validateAIContext, validateAIProposal });
  const source = readFileSync(new URL('../web/ai.js', import.meta.url), 'utf8')
    .replace(/^import .+;\r?\n/gm, '').replace(/^export /gm, '');
  vm.runInContext(source + '\nglobalThis.aiApi={aiContextFor,aiApplyCandidate};', context);
  const { aiContextFor, aiApplyCandidate } = context.aiApi;
  const data = trackedData();
  data.tracking.timer.title = 'Private running activity';
  data.tracking.sessions[0].title = 'Private actual history';
  const planningContext = aiContextFor(data, date, 'day', 'all');
  assert.equal(Object.hasOwn(planningContext, 'tracking'), false);
  assert.equal(JSON.stringify(planningContext).includes('Private'), false);
  const task = planningContext.tasks[0];
  const proposal = {
    reply: 'Suggested plan', explanation: '',
    assignments: [{ taskId: task.id, date, start: 900, duration: task.duration }],
    unscheduledTaskIds: planningContext.tasks.filter(item => item.id !== task.id).map(item => item.id),
  };
  pauseTracking(data, beginning + 151007, 'segment-two');
  assert.deepEqual(clone(aiContextFor(data, date, 'day', 'all')), clone(planningContext));
  const before = clone(data);
  const applied = aiApplyCandidate(data, proposal, aiContextFor(data, date, 'day', 'all'), () => 'ai-added');
  assert.deepEqual(clone(applied.tracking), data.tracking);
  assert.equal(applied.tracking.timer.startedAt, null);
  assert.equal(applied.tracking.sessions.length, 2);
  assert.equal(applied.days[date].at(-1).id, 'ai-added');
  assert.equal(validateData(applied), true);
  assert.deepEqual(data, before);
});
