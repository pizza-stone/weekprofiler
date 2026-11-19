import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { MAX_TEMPLATE_NOTES, seedData, validateData, migrateData, snapshotWeek } from '../lib/planner.mjs';
import { handlePlanner } from '../worker/api.mjs';

function fixture(version) {
  const data = seedData();
  data.version = version;
  if (version === 1) {
    delete data.groups;
    delete data.dayMeta;
    delete data.weekTemplates;
    delete data.cycle;
  }
  return data;
}

test('old V1/V2/V3 backups without template notes remain valid and migrate without a schema bump', () => {
  for (const version of [1, 2, 3]) {
    const data = fixture(version), before = structuredClone(data);
    assert.equal(validateData(data), true);
    const migrated = migrateData(data);
    assert.equal(migrated.version, 3);
    assert.equal(validateData(migrated), true);
    assert.deepEqual(data, before);
    assert.ok(migrated.templates.every(template => !Object.hasOwn(template, 'notes')));
    assert.ok(migrated.weekTemplates.every(template => !Object.hasOwn(template, 'notes')));
  }
});

test('V1/V2/V3 migration preserves independent multiline notes without replacing descriptions', () => {
  for (const version of [1, 2, 3]) {
    const data = fixture(version);
    data.templates[0].notes = '  每日重点\n复盘：保留空白\n<script>这只是备注</script>  ';
    data.templates[1].notes = '';
    if (version >= 2) data.weekTemplates[0].notes = '周目标\n每周五复盘。';
    const before = structuredClone(data), migrated = migrateData(data);
    assert.equal(validateData(migrated), true);
    assert.equal(migrated.templates[0].notes, before.templates[0].notes);
    assert.equal(migrated.templates[0].description, before.templates[0].description);
    assert.equal(migrated.templates[1].notes, '');
    if (version >= 2) {
      assert.equal(migrated.weekTemplates[0].notes, before.weekTemplates[0].notes);
      assert.equal(migrated.weekTemplates[0].description, before.weekTemplates[0].description);
    } else {
      assert.ok(migrated.weekTemplates.every(template => template.notes === undefined));
    }
    migrated.templates[0].notes = '只修改副本';
    migrated.templates[0].blocks[0].title = '只修改副本的安排';
    migrated.weekTemplates[0].notes = '只修改周模板副本';
    assert.deepEqual(data, before);
    assert.equal(migrated.templates[1].notes, '');
  }
});

test('template notes accept blank text and the exact shared maximum length', () => {
  assert.equal(MAX_TEMPLATE_NOTES, 5000);
  for (const version of [1, 2, 3]) {
    const data = fixture(version);
    data.templates[0].notes = '记'.repeat(MAX_TEMPLATE_NOTES);
    data.templates[1].notes = '\n  \n';
    if (version >= 2) data.weekTemplates[0].notes = '周'.repeat(MAX_TEMPLATE_NOTES);
    assert.equal(validateData(data), true);
    assert.equal(migrateData(data).templates[0].notes.length, MAX_TEMPLATE_NOTES);
  }
});

test('invalid notes types or excessive length reject both day and week templates in supported versions', () => {
  for (const version of [1, 2, 3]) {
    for (const collection of version === 1 ? ['templates'] : ['templates', 'weekTemplates']) {
      for (const notes of [null, false, 42, [], {}, 'x'.repeat(MAX_TEMPLATE_NOTES + 1)]) {
        const data = fixture(version);
        data[collection][0].notes = notes;
        assert.equal(validateData(data), false, `${version} ${collection}: ${typeof notes}`);
        assert.throws(() => migrateData(data), /数据格式不正确/);
      }
    }
  }
});

test('week snapshots contain schedule blocks independently of day and week template notes', () => {
  const data = seedData();
  data.templates[0].notes = '日模板备注';
  data.weekTemplates[0].notes = '周模板备注';
  data.cycle.enabled = true;
  data.cycle.startDate = '2026-11-16';
  data.cycle.days = structuredClone(data.weekTemplates[0].days);
  const snapshot = snapshotWeek(data, '2026-11-16');
  const originalSnapshot = structuredClone(snapshot);
  data.templates[0].notes = '修改日备注';
  data.weekTemplates[0].notes = '修改周备注';
  data.cycle.days[0].blocks[0].title = '修改循环';
  assert.deepEqual(snapshot, originalSnapshot);
  assert.ok(snapshot.every(day => !Object.hasOwn(day, 'notes')));
  assert.equal(data.templates[0].notes, '修改日备注');
  assert.equal(data.weekTemplates[0].notes, '修改周备注');
});

test('planner persistence round-trips template notes and rejects an invalid update without losing saved notes', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../drizzle/0000_planner.sql', import.meta.url), 'utf8'));
  const env = { DB: { prepare(sql) { return { bind(...params) { return { async first() { return sqlite.prepare(sql).get(...params) ?? null; } }; } }; } } };
  const endpoint = 'https://planner.example/api/planner';
  const request = (data, baseRevision, mutationId) => new Request(endpoint, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: 'https://planner.example' },
    body: JSON.stringify({ data, baseRevision, mutationId }),
  });
  try {
    const data = seedData();
    data.templates[0].notes = '日模板：检查清单\n一、阅读\n二、记录';
    data.weekTemplates[0].notes = '周模板：本周重点';
    assert.equal((await handlePlanner(request(data, 0, 'save-notes'), env, 'owner')).status, 200);
    const saved = await (await handlePlanner(new Request(endpoint), env, 'owner')).json();
    assert.deepEqual(saved.data, data);
    const invalid = structuredClone(data);
    invalid.weekTemplates[0].notes = 'x'.repeat(MAX_TEMPLATE_NOTES + 1);
    assert.equal((await handlePlanner(request(invalid, 1, 'invalid-notes'), env, 'owner')).status, 400);
    const retained = await (await handlePlanner(new Request(endpoint), env, 'owner')).json();
    assert.deepEqual(retained, saved);
    data.templates[0].notes = '';
    data.weekTemplates[0].notes = '更新后的周目标';
    assert.equal((await handlePlanner(request(data, 1, 'edit-notes'), env, 'owner')).status, 200);
    const edited = await (await handlePlanner(new Request(endpoint), env, 'owner')).json();
    assert.equal(edited.revision, 2);
    assert.deepEqual(edited.data, data);
  } finally {
    sqlite.close();
  }
});
