import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
test('new tasks inherit the active group while edited tasks retain their own group', () => {
 const h=harness();h.state.tab='tasks';h.state.filter='learn';
 h.taskForm();assert.match(h.context.lastModal.content, /value="learn" selected/);
 h.taskForm('task-focus');assert.match(h.context.lastModal.content, /value="work" selected/);
 h.state.tab='week';h.state.weekFilter='rest';h.taskForm();assert.match(h.context.lastModal.content, /value="rest" selected/);
 h.state.tab='templates';h.state.weekTemplateId=h.state.data.weekTemplates[0].id;h.taskForm();assert.match(h.context.lastModal.content, /value="rest" selected/);
});
test('next-day clock labels and calendar exports agree on the 04:00 end boundary',()=>{
 const h=harness();
 assert.equal(h.time(1440),'次日 00:00');assert.equal(h.time(1680),'次日 04:00');
 assert.equal(h.utcDate('2026-11-14',1650,'Asia/Shanghai'),'20261114T193000Z');
 assert.equal(h.utcDate('2026-11-14',1680,'Asia/Shanghai'),'20261114T200000Z');
});
import { readFileSync } from 'node:fs';
import { seedData, validateData, migrateData, resolveDay, materializeDay, snapshotWeek, mondayOf, addDays, MAX_STATE_BYTES, DAY_START, DAY_END, planningDate } from '../lib/planner.mjs';

function harness(fetch) {
  const listeners = {};
  const modal = { open: false };
  const context = vm.createContext({
    seedData, validateData, migrateData, resolveDay, materializeDay, snapshotWeek, mondayOf, addDays, MAX_STATE_BYTES, DAY_START, DAY_END, planningDate, TextEncoder, Intl, Date, URL, Blob,
    Uint8Array, crypto: { getRandomValues: array => crypto.getRandomValues(array) },
    document: {
      addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
      querySelector(selector) { return selector === '#modal' ? modal : null; },
      querySelectorAll() { return []; },
    },
    window: { addEventListener() {} },
    setTimeout() { return 1; }, clearTimeout() {}, setInterval() {},
    localStorage: { setItem() {} }, fetch,
  });
  const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/\nboot\(\);\s*$/, '');
  vm.runInContext(source + '\nrender=()=>{};cache=()=>{};updateStatus=()=>{};toast=()=>{};blockForm=value=>{globalThis.lastForm=value;};modal=(title,content)=>{globalThis.lastModal={title,content};};globalThis.api={state,refresh,save,commit,uid,dropMinute,utcDate,taskForm,taskCard,timeline,time};', context);
  context.api.state.data = seedData();
  context.api.state.ready = true;
  context.api.state.revision = 1;
  return { ...context.api, listeners, context, modal };
}

test('task completion can be toggled, saved, reopened, and undone without opening the editor', async () => {
  const writes=[];
  const h=harness(async (path,options)=>{
    writes.push(JSON.parse(options.body));
    return {ok:true,json:async()=>({revision:2})};
  });
  h.state.tab='tasks';
  const task=h.state.data.tasks.find(t=>!t.done);
  const beforeSchedules=JSON.stringify([h.state.data.days,h.state.data.templates,h.state.data.cycle]);
  const click=action=>h.listeners.click[0]({target:{closest:()=>({dataset:{action,id:task.id}})}});
  await click('toggle-task');
  assert.equal(task.done,true);
  assert.equal(h.state.dirty,true);
  assert.equal(h.state.undo.length,1);
  assert.equal(h.context.lastModal,undefined);
  assert.match(h.taskCard(task),/aria-pressed="true"/);
  assert.match(h.taskCard(task),/<svg[^>]*[\s\S]*M5 12/);
  assert.equal(JSON.stringify([h.state.data.days,h.state.data.templates,h.state.data.cycle]),beforeSchedules);
  await h.save();
  assert.equal(writes[0].data.tasks.find(t=>t.id===task.id).done,true);
  assert.equal(h.state.dirty,false);
  await click('toggle-task');
  assert.equal(task.done,false);
  assert.match(h.taskCard(task),/aria-pressed="false"/);
  await click('undo');
  assert.equal(h.state.data.tasks.find(t=>t.id===task.id).done,true);
  assert.equal(h.state.dirty,true);
});

test('completing a scheduled one-off task exposes its checkmark and updates the task pool', async () => {
  const h=harness();
  h.state.date='2026-11-15';
  const task=h.state.data.tasks[0];task.reusable=false;task.done=false;
  h.state.data.days[h.state.date]=[{id:'completion-block',title:task.title,category:task.category,taskId:task.id,start:540,duration:30,done:false}];
  const click=()=>h.listeners.click[0]({target:{closest:()=>({dataset:{action:'toggle',id:'completion-block'}})}});
  await click();
  assert.equal(task.done,true);
  assert.equal(h.state.data.days[h.state.date][0].done,true);
  assert.match(h.timeline(),/data-action="toggle"[^>]*aria-pressed="true"[^>]*><svg/);
  await click();
  assert.equal(task.done,false);
  assert.match(h.timeline(),/data-action="toggle"[^>]*aria-pressed="false"[^>]*><\/button>/);
});

test('a delayed cloud read cannot erase a local edit made while it was in flight', async () => {
  let resolve;
  const h = harness(() => new Promise(r => { resolve = r; }));
  const pending = h.refresh();
  h.commit(data => { data.tasks[0].title = 'New local edit'; });
  const remote = seedData();
  remote.tasks[0].title = 'Remote update';
  resolve({ ok: true, json: async () => ({ data: remote, revision: 2 }) });
  await pending;
  assert.equal(h.state.data.tasks[0].title, 'New local edit');
  assert.equal(h.state.revision, 1);
  assert.equal(h.state.dirty, true);
});

test('a cloud refresh does not replace the data underneath an open editor', async () => {
  let calls = 0;
  const h = harness(() => { calls++; throw Error('Should not fetch'); });
  h.modal.open = true;
  await h.refresh();
  assert.equal(calls, 0);
});

test('next-day midnight slot opens at 1440, not the default 09:00', async () => {
  const h = harness();
  const element = { dataset: { action: 'new-block', minute: '1440' } };
  await h.listeners.click[0]({ target: { closest() { return element; } } });
  assert.equal(h.context.lastForm.start, 1440);
});

test('dragging over an event overlay resolves the underlying 30-minute slot', () => {
  const h = harness();
  const timeline = { getBoundingClientRect() { return { top: -200 }; } };
  const eventOverlay = { closest(selector) { return selector === '.timeline' ? timeline : null; } };
  assert.equal(h.dropMinute({ target: eventOverlay, clientY: 294 }), 810);
  assert.equal(h.dropMinute({ target: eventOverlay, clientY: -201 }), null);
  assert.equal(h.dropMinute({ target: eventOverlay, clientY: 1048 }), null);
});

test('UUID fallback works without crypto.randomUUID on older browsers', () => {
  const h = harness();
  const ids = Array.from({ length: 100 }, () => h.uid());
  assert.equal(new Set(ids).size, 100);
  for (const id of ids) assert.match(id, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
});

test('invalid local edits cannot poison the synchronization queue', () => {
  const h = harness();
  h.commit(data => { data.tasks[0].duration = 45; });
  assert.equal(h.state.data.tasks[0].duration, 60);
  assert.equal(h.state.dirty, false);
  assert.equal(h.state.undo.length, 0);
});

test('calendar exports preserve Beijing times and reject nonexistent DST times', () => {
  const h = harness();
  assert.equal(h.utcDate('2026-11-14',540,'Asia/Shanghai'),'20261114T010000Z');
  assert.equal(h.utcDate('2026-11-14',1440,'Asia/Shanghai'),'20261114T160000Z');
  assert.throws(()=>h.utcDate('2027-03-14',150,'America/Los_Angeles'));
});
