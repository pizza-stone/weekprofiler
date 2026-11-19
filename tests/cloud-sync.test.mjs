import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloudSync, loadCloudSession } from '../web/cloud-sync.js';
import { createChanges, applyChanges, rebaseChanges, isTimerChange } from '../lib/sync.mjs';
import { seedData, validateData, migrateData, legacySeedData } from '../lib/planner.mjs';
import { startTracking, pauseTracking } from '../lib/tracking.mjs';

const copy = value => value === undefined ? undefined : structuredClone(value);
const json = (value, status = 200) => Response.json(value, { status });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function disk() {
  const records = new Map();
  const result = { records, identity: null, failWrite: false, events: [],
    async read(userId) { return copy(records.get(userId) || null); },
    async write(userId, value) {
      result.events.push('persist');
      if (result.failWrite) throw new Error('storage full');
      records.set(userId, copy(value));
    },
    async readIdentity() { return copy(result.identity); },
    async writeIdentity(identity) { result.identity = copy(identity); },
    async clear(userId) { records.delete(userId); },
  };
  return result;
}
function harness(options = {}) {
  const initial = seedData();
  const state = { userId: 'alice', ready: true, data: initial, baseData: copy(initial), revision: 1,
    timerRevision: 0, dirty: false, pending: null, conflict: false, busy: false, needsLogin: false, undo: [] };
  const storage = options.storage || disk(), scheduled = new Map(), notices = [];
  let visible = true, editing = false, id = 0;
  const controller = createCloudSync({ state, storage, createChanges, applyChanges, rebaseChanges,
    validateData, migrateData, seedData, uid: () => 'operation-' + (++id), render() {}, updateStatus() {},
    toast: message => notices.push(message), isVisible: () => visible, isEditing: () => editing,
    schedule: callback => { scheduled.set(++id, callback); return id; }, cancel: key => scheduled.delete(key),
    now: () => 123456,
    request: options.request || (async () => { throw new Error('unconfigured'); }),
  });
  return { state, storage, scheduled, notices, controller,
    setVisible(value) { visible = value; }, setEditing(value) { editing = value; } };
}

function beforeLabels(withTimer = false) {
  const data=migrateData(legacySeedData());delete data.tags;delete data.tagDefaultsVersion;
  const strip=value=>{if(!value||typeof value!=='object')return;delete value.tagId;for(const child of Object.values(value))strip(child);};
  strip(data);
  if(withTimer){
    data.days['2026-11-16']=[{id:'planned',title:'项目任务',category:'work',start:600,duration:60,done:false}];
    data.tracking={sessions:[],timer:{id:'timer-old',planDate:'2026-11-16',blockId:'planned',title:'项目任务',category:'work',startedAt:1000}};
  }
  return data;
}

test('online boot migrates legacy labels as guarded pending edits against the untouched server baseline',async()=>{
  let server=beforeLabels(true),revision=4,timerRevision=2;const original=copy(server),sent=[];
  const h=harness({request:async(_path,options)=>{
    if(options?.method!=='POST')return json({data:server,revision,timerRevision});
    const payload=JSON.parse(options.body);sent.push(payload);
    assert.equal(payload.baseTimerRevision,timerRevision);
    server=applyChanges(server,payload.changes);revision++;if(payload.changes.some(isTimerChange))timerRevision++;
    return json({data:server,revision,timerRevision,ackMutationId:payload.mutationId});
  }});
  await h.controller.boot({userId:'alice'});
  assert.deepEqual(h.state.baseData,original);assert.equal(h.state.data.tags.length,original.groups.length+1);
  assert.equal(h.state.data.tracking.timer.tagId,'work');assert.equal(h.state.dirty,true);
  await h.controller.save();assert.equal(sent.length,1);assert.ok(sent[0].changes.some(change=>change.path[0]==='tags'));
  assert.ok(sent[0].changes.some(isTimerChange));assert.equal(h.state.timerRevision,3);
  assert.equal(h.state.dirty,false);assert.deepEqual(h.state.data,h.state.baseData);assert.equal(server.tracking.timer.tagId,'work');
});

test('offline migration keeps a legacy pending request exact and uploads labels after its acknowledgement',async()=>{
  const storage=disk(),base=beforeLabels(true),snapshot=copy(base);snapshot.tasks[0].done=true;
  const payload={mutationId:'legacy-exact-request',baseRevision:1,baseTimerRevision:2,changes:createChanges(base,snapshot)};
  const pending={payload,snapshot,replacementGeneration:0},exact=JSON.stringify(pending);
  await storage.write('alice',{data:snapshot,baseData:base,revision:1,timerRevision:2,dirty:true,pending});
  let requests=0,server=copy(snapshot),revision=2,timerRevision=2;
  const h=harness({storage,request:async(_path,options)=>{
    const input=JSON.parse(options.body);requests++;
    if(requests===1)assert.deepEqual(input,payload);
    else {server=applyChanges(server,input.changes);revision++;if(input.changes.some(isTimerChange))timerRevision++;}
    return json({data:server,revision,timerRevision,ackMutationId:input.mutationId});
  }});
  await h.controller.boot({userId:'alice',offline:true});
  assert.equal(JSON.stringify(h.state.pending),exact);assert.deepEqual(h.state.baseData,base);
  assert.equal(h.state.data.tracking.timer.tagId,'work');
  await h.controller.save();
  assert.equal(h.state.pending,null);assert.equal(h.state.conflict,false);assert.equal(h.state.dirty,true);
  assert.equal(h.state.baseData.tags,undefined);assert.equal(h.state.data.tasks[0].done,true);
  await h.controller.save();assert.equal(requests,2);assert.equal(h.state.dirty,false);
  assert.equal(server.tracking.timer.tagId,'work');assert.equal(server.tasks[0].done,true);assert.ok(server.tags.length);
});

test('migration of legacy timer labels cannot bypass a concurrent timer revision after an old request is acknowledged',async()=>{
  const storage=disk(),base=beforeLabels(true),snapshot=copy(base);snapshot.tasks[0].done=true;
  const payload={mutationId:'old-in-flight',baseRevision:1,baseTimerRevision:2,changes:createChanges(base,snapshot)};
  await storage.write('alice',{data:snapshot,baseData:base,revision:1,timerRevision:2,dirty:true,pending:{payload,snapshot,replacementGeneration:0}});
  const remote=copy(snapshot);remote.tracking.timer.id='new-remote-timer';remote.tracking.timer.startedAt=2000;
  const h=harness({storage,request:async()=>json({data:remote,revision:4,timerRevision:4,ackMutationId:payload.mutationId})});
  await h.controller.boot({userId:'alice',offline:true});await h.controller.save();
  assert.equal(h.state.conflict,true);assert.equal(h.state.pending,null);assert.equal(h.state.dirty,true);
  assert.equal(h.state.data.tracking.timer.id,'timer-old');assert.equal(h.state.data.tracking.timer.tagId,'work');
  assert.equal(h.state.syncConflict.remote.data.tracking.timer.id,'new-remote-timer');
  assert.deepEqual(h.state.syncConflict.paths,[['tracking','timer']]);
});

test('refresh and remote conflict resolution keep legacy label migrations dirty instead of acknowledging them locally',async()=>{
  const remote=beforeLabels(),h=harness({request:async()=>json({data:remote,revision:2,timerRevision:0})});
  await h.controller.refresh(true);
  assert.equal(h.state.data.tags.length,remote.groups.length+1);assert.equal(h.state.baseData.tags,undefined);assert.equal(h.state.dirty,true);
  h.state.conflict=true;h.state.syncConflict={remote:{data:remote,revision:2,timerRevision:0},paths:[['tasks']],changes:[]};
  assert.equal(await h.controller.resolve('remote'),true);
  assert.equal(h.state.conflict,false);assert.equal(h.state.dirty,true);assert.equal(h.state.baseData.tags,undefined);
  assert.ok(h.storage.records.get('alice').data.tags.length);assert.equal(h.storage.records.get('alice').baseData.tags,undefined);
});

test('save persists its exact request first and retains edits made while the response is in flight', async () => {
  const sent = deferred(), reply = deferred(), storage = disk();
  let payload;
  const h = harness({ storage, request: async (path, options) => {
    storage.events.push('send'); payload = JSON.parse(options.body); sent.resolve(); return reply.promise;
  } });
  h.state.data.tasks[0].title = 'First local title'; h.state.dirty = true;
  const saving = h.controller.save(); await sent.promise;
  assert.deepEqual(storage.events, ['persist', 'send']);
  assert.equal(storage.records.get('alice').pending.payload.mutationId, payload.mutationId);
  h.state.data.tasks[1].title = 'Typed during upload';
  const remote = applyChanges(seedData(), payload.changes);
  remote.templates[0].notes = 'Independent phone note';
  reply.resolve(json({ ackMutationId: payload.mutationId, data: remote, revision: 3, timerRevision: 0 }));
  await saving;
  assert.equal(h.state.data.tasks[0].title, 'First local title');
  assert.equal(h.state.data.tasks[1].title, 'Typed during upload');
  assert.equal(h.state.data.templates[0].notes, 'Independent phone note');
  assert.equal(h.state.baseData.tasks[1].title, seedData().tasks[1].title);
  assert.equal(h.state.pending, null); assert.equal(h.state.dirty, true);
  assert.equal(h.state.conflict, false); assert.ok(h.scheduled.size > 0);
});

test('logout refuses unsynchronized, conflicted or busy state without sending requests or deleting data', async () => {
  for (const blocked of [{ dirty: true }, { pending: { payload: {} } }, { conflict: true }, { busy: true }]) {
    let requests = 0;
    const h = harness({ request: async () => { requests++; return json({ ok: true }); } });
    await h.controller.persist();
    h.storage.identity = { userId: 'alice' };
    Object.assign(h.state, blocked);
    assert.equal(await h.controller.signOut(), false);
    assert.equal(requests, 0);
    assert.ok(h.storage.records.has('alice'));
    assert.deepEqual(h.storage.identity, { userId: 'alice' });
  }
});

test('logout waits for an existing local write and prevents later requests or writes from restoring the copy', async () => {
  const started = deferred(), release = deferred(), sent = deferred(), reply = deferred(), storage = disk();
  const write = storage.write;
  storage.write = async (...args) => { started.resolve(); await release.promise; return write(...args); };
  let requests = 0;
  const h = harness({ storage, request: async (path, options) => {
    requests++;
    assert.equal(path, '/api/auth/logout');
    assert.equal(options.method, 'POST'); assert.equal(options.credentials, 'same-origin');
    assert.equal(options.headers['Content-Type'], 'application/json'); assert.deepEqual(JSON.parse(options.body), {});
    assert.ok(storage.records.has('alice'));
    sent.resolve(); return reply.promise;
  } });
  storage.identity = { userId: 'alice' };
  const saving = h.controller.persist(); await started.promise;
  h.controller.queue(); assert.equal(h.scheduled.size, 1);
  const logout = h.controller.signOut();
  assert.equal(h.controller.signOut(), logout, 'concurrent logout calls share one operation');
  assert.equal(h.scheduled.size, 0); assert.equal(requests, 0);
  await assert.rejects(h.controller.persist(), /正在退出/);
  await h.controller.refresh(true); h.controller.queue();
  release.resolve(); await saving; await sent.promise;
  assert.equal(requests, 1); assert.equal(h.scheduled.size, 0);
  reply.resolve(json({ ok: true })); assert.equal(await logout, true);
  assert.equal(storage.identity, null); assert.equal(storage.records.has('alice'), false);
  await h.controller.refresh(true); h.controller.queue();
  await assert.rejects(h.controller.persist(), /正在退出/);
  assert.equal(await h.controller.signOut(), true); assert.equal(requests, 1);
});

test('logout network failure retains local identity and copy and permits a subsequent retry', async () => {
  let fail = true;
  const h = harness({ request: async () => { if (fail) throw new Error('offline'); return json({ ok: true }); } });
  await h.controller.persist(); h.storage.identity = { userId: 'alice' };
  assert.equal(await h.controller.signOut(), false);
  assert.ok(h.storage.records.has('alice')); assert.deepEqual(h.storage.identity, { userId: 'alice' });
  assert.match(h.state.status, /退出未完成/);
  await h.controller.persist();
  fail = false;
  assert.equal(await h.controller.signOut(), true);
  assert.equal(h.storage.records.has('alice'), false);
});

test('logout reports partial cleanup failure and retries idempotently without re-enabling uploads', async () => {
  const h = harness({ request: async () => json({ ok: true }) });
  await h.controller.persist(); h.storage.identity = { userId: 'alice' };
  h.storage.clear = async () => { throw new Error('disk unavailable'); };
  assert.equal(await h.controller.signOut(), false);
  assert.equal(h.state.needsLogin, true); assert.ok(h.storage.records.has('alice'));
  assert.match(h.state.status, /本机副本清理失败/);
  assert.match(h.notices.at(-1), /未能完全清理/);
  h.storage.clear = async userId => h.storage.records.delete(userId);
  assert.equal(await h.controller.signOut(), true);
  assert.equal(h.storage.records.has('alice'), false);
});

test('logout does not clear data or send logout if a previously started local save fails', async () => {
  const started = deferred(), release = deferred(), storage = disk();
  let requests = 0;
  const h = harness({ storage, request: async () => { requests++; return json({ ok: true }); } });
  await h.controller.persist(); storage.identity = { userId: 'alice' };
  storage.write = async () => { started.resolve(); await release.promise; throw new Error('disk full'); };
  const saving = h.controller.remember(); await started.promise;
  const logout = h.controller.signOut(); release.resolve(); await saving;
  assert.equal(await logout, false); assert.equal(requests, 0);
  assert.ok(storage.records.has('alice')); assert.deepEqual(storage.identity, { userId: 'alice' });
  assert.equal(h.state.syncStorageError, true);
});

test('lost-response pending requests survive a restart and retry the same mutation exactly', async () => {
  const storage = disk(); let firstPayload;
  const first = harness({ storage, request: async (path, options) => {
    firstPayload = JSON.parse(options.body); throw new Error('response lost');
  } });
  first.state.data.tasks[0].done = true; first.state.dirty = true;
  await first.controller.save();
  assert.ok(storage.records.get('alice').pending);
  const restored = harness({ storage, request: async (path, options) => {
    const retried = JSON.parse(options.body);
    assert.deepEqual(retried, firstPayload);
    return json({ ackMutationId: retried.mutationId, revision: 2, timerRevision: 0,
      data: applyChanges(seedData(), retried.changes) });
  } });
  await restored.controller.boot({ userId: 'alice', offline: true });
  assert.equal(restored.state.data.tasks[0].done, true);
  await restored.controller.save();
  assert.equal(restored.state.pending, null); assert.equal(restored.state.dirty, false);
  assert.equal(restored.state.status, '已同步');
});

test('refresh merges independent remote changes with a local edit made during the read', async () => {
  const sent = deferred(), reply = deferred();
  const h = harness({ request: async () => { sent.resolve(); return reply.promise; } });
  const refreshing = h.controller.refresh(); await sent.promise;
  h.state.data.tasks[0].done = true; h.state.dirty = true;
  const remote = seedData(); remote.templates[0].notes = 'Phone template note';
  reply.resolve(json({ data: remote, revision: 2, timerRevision: 0 }));
  await refreshing;
  assert.equal(h.state.data.tasks[0].done, true);
  assert.equal(h.state.data.templates[0].notes, 'Phone template note');
  assert.equal(h.state.baseData.tasks[0].done, false);
  assert.equal(h.state.revision, 2); assert.equal(h.state.dirty, true);
});

test('same-field conflicts retain the local draft, pending request and remote alternative', async () => {
  const remote = seedData(); remote.tasks[0].title = 'Phone title';
  const h = harness({ request: async () => json({ data: remote, revision: 2, timerRevision: 0,
    error: 'conflict', paths: [['tasks', { id: remote.tasks[0].id }, 'title']] }, 409) });
  h.state.data.tasks[0].title = 'Computer title'; h.state.dirty = true;
  await h.controller.save();
  assert.equal(h.state.data.tasks[0].title, 'Computer title');
  assert.equal(h.state.syncConflict.remote.data.tasks[0].title, 'Phone title');
  assert.equal(h.state.conflict, true); assert.ok(h.state.pending);
  assert.equal(h.state.status, '有冲突待处理');
  assert.equal(h.storage.records.get('alice').data.tasks[0].title, 'Computer title');
});

test('cached identity after 401 allows local viewing but never authorizes uploads', async () => {
  const storage = disk(); storage.identity = { userId: 'alice', email: 'alice@example.test', sync: 'operations-v1' };
  const initial = seedData(); initial.tasks[0].done = true;
  await storage.write('alice', { data: initial, baseData: seedData(), dirty: true, pending: null, revision: 1 });
  const identity = await loadCloudSession(storage, async () => json({ error: 'login' }, 401));
  assert.equal(identity.needsLogin, true);
  let requests = 0;
  const h = harness({ storage, request: async () => { requests++; throw new Error('must not request'); } });
  await h.controller.boot(identity);
  await h.controller.save(); await h.controller.refresh();
  assert.equal(requests, 0); assert.equal(h.state.data.tasks[0].done, true);
  assert.equal(h.state.status, '请重新登录');
});

test('background pages and active editing do not poll; explicit refresh can wake a hidden page', async () => {
  let requests = 0;
  const h = harness({ request: async () => { requests++; return json({ unchanged: true, revision: 1 }); } });
  h.setVisible(false); await h.controller.refresh(); assert.equal(requests, 0);
  await h.controller.refresh(true); assert.equal(requests, 1);
  h.setVisible(true); h.setEditing(true); await h.controller.refresh(); assert.equal(requests, 1);
  await h.controller.refresh(true); assert.equal(requests, 2);
  h.setEditing(false); await h.controller.refresh(); assert.equal(requests, 3);
});

test('failed local persistence prevents upload and preserves the pending edit in memory', async () => {
  let requests = 0;
  const h = harness({ request: async () => { requests++; throw new Error('must not upload'); } });
  h.storage.failWrite = true;
  h.state.data.tasks[0].done = true; h.state.dirty = true;
  await h.controller.save();
  assert.equal(requests, 0); assert.equal(h.state.data.tasks[0].done, true);
  assert.equal(h.state.dirty, true); assert.equal(h.state.syncStorageError, true);
  assert.match(h.state.status, /本机保存失败/);
});

test('authentication expiry during upload stops further writes and retains its request for later login', async () => {
  let requests = 0;
  const h = harness({ request: async () => { requests++; return json({ error: 'login' }, 401); } });
  h.state.data.tasks[0].done = true; h.state.dirty = true;
  await h.controller.save(); await h.controller.save();
  assert.equal(requests, 1); assert.equal(h.state.needsLogin, true);
  assert.ok(h.state.pending); assert.equal(h.state.dirty, true);
  assert.equal(h.state.status, '请重新登录');
});

test('offline boot requires an existing validated local copy, and stopped controllers make no requests', async () => {
  const storage = disk();
  await assert.rejects(loadCloudSession(storage, async () => { throw new Error('offline'); }), /首次使用需要联网/);
  const h = harness({ storage });
  await assert.rejects(h.controller.boot({ userId: 'alice', offline: true }), /没有离线副本/);
  h.state.data = seedData(); h.state.dirty = true;
  h.controller.stop(); await h.controller.save(); await h.controller.refresh(); h.controller.queue();
  assert.equal(h.scheduled.size, 0);
});

test('refresh cannot report local persistence failure as safely saved offline', async () => {
  const remote = seedData(); remote.tasks[0].title = 'Phone change';
  const h = harness({ request: async () => json({ data: remote, revision: 2, timerRevision: 0 }) });
  h.storage.failWrite = true;
  await h.controller.refresh();
  assert.equal(h.state.syncStorageError, true);
  assert.match(h.state.status, /本机保存失败/);
});

test('a backup imported during an outstanding refresh stays an exact replacement', async () => {
  const sent = deferred(), reply = deferred();
  const h = harness({ request: async () => { sent.resolve(); return reply.promise; } });
  const refreshing = h.controller.refresh(); await sent.promise;
  const imported = seedData(); imported.tasks[0].title = 'Imported backup title';
  h.controller.replaceNext(); h.state.data = copy(imported); h.state.dirty = true;
  const remote = seedData(); remote.templates[0].notes = 'Remote-only note absent from backup';
  reply.resolve(json({ data: remote, revision: 2, timerRevision: 0 }));
  await refreshing;
  assert.deepEqual(h.state.data, imported);
  assert.equal(h.state.replaceRequested, true); assert.equal(h.state.dirty, true);
});

test('permanently rejected edits remain paused across polling, queued saves and reload', async () => {
  const storage = disk(); let requests = 0;
  const h = harness({ storage, request: async () => { requests++; return json({ error: 'invalid payload' }, 400); } });
  h.state.data.tasks[0].done = true; h.state.dirty = true;
  await h.controller.save(); h.controller.queue(); await h.controller.refresh(); await h.controller.save();
  assert.equal(requests, 1); assert.equal(h.scheduled.size, 0);
  assert.equal(h.state.status, '云端未接受 · 请调整修改');
  assert.equal(storage.records.get('alice').syncRejected, true);
  const reopened = harness({ storage, request: async () => { requests++; throw new Error('must not retry'); } });
  await reopened.controller.boot({ userId: 'alice', offline: true });
  reopened.controller.queue(); await reopened.controller.refresh(); await reopened.controller.save();
  assert.equal(requests, 1); assert.equal(reopened.state.syncRejected, true);
  assert.equal(reopened.state.status, '云端未接受 · 请调整修改');
});

test('a correction made while a rejected request is pending can be saved normally', async () => {
  const sent = deferred(), reply = deferred(); let requests = 0;
  const h = harness({ request: async (path, options) => {
    requests++;
    if (requests === 1) { sent.resolve(); return reply.promise; }
    const payload = JSON.parse(options.body);
    return json({ ackMutationId: payload.mutationId, data: applyChanges(seedData(), payload.changes), revision: 2 });
  } });
  h.state.data.tasks[0].title = 'Rejected title'; h.state.dirty = true;
  const saving = h.controller.save(); await sent.promise;
  h.state.data.tasks[0].title = 'Corrected title';
  reply.resolve(json({ error: 'invalid payload' }, 400)); await saving;
  assert.equal(h.state.syncRejected, false); assert.ok(h.scheduled.size);
  await h.controller.save();
  assert.equal(requests, 2); assert.equal(h.state.dirty, false);
  assert.equal(h.state.data.tasks[0].title, 'Corrected title');
});

test('resolving a conflict cannot replace the original draft if local storage fails', async () => {
  const remote = seedData(); remote.tasks[0].title = 'Phone title';
  const h = harness({ request: async () => json({ data: remote, revision: 2 }) });
  h.state.data.tasks[0].title = 'Computer title'; h.state.dirty = true;
  h.state.conflict = true; h.state.syncConflict = { remote: { data: remote, revision: 2 } };
  const original = copy(h.state.data);
  await h.controller.persist(); h.storage.failWrite = true;
  assert.equal(await h.controller.resolve('remote'), false);
  assert.deepEqual(h.state.data, original); assert.equal(h.state.conflict, true);
  assert.deepEqual(h.storage.records.get('alice').data, original);
  assert.match(h.state.status, /本机保存失败/);
});

test('a successfully resolved conflict durably retains its original draft for recovery', async () => {
  const remote = seedData(); remote.tasks[0].title = 'Phone title';
  const h = harness({ request: async () => json({ data: remote, revision: 2 }) });
  h.state.data.tasks[0].title = 'Computer title'; h.state.dirty = true;
  h.state.conflict = true; h.state.syncConflict = { remote: { data: remote, revision: 2 } };
  assert.equal(await h.controller.resolve('remote'), true);
  assert.equal(h.state.data.tasks[0].title, 'Phone title'); assert.equal(h.state.conflict, false);
  const record = h.storage.records.get('alice');
  assert.equal(record.data.tasks[0].title, 'Phone title');
  assert.equal(record.conflictDraft.data.tasks[0].title, 'Computer title');
  const reopened = harness({ storage: h.storage });
  await reopened.controller.boot({ userId: 'alice', offline: true });
  assert.equal(reopened.state.conflictDraft.data.tasks[0].title, 'Computer title');
});

test('edits made while a conflict resolution is being persisted remain pending for review', async () => {
  const started = deferred(), resume = deferred(), storage = disk();
  const write = storage.write; let writes = 0;
  storage.write = async (userId, value) => {
    if (++writes === 1) { started.resolve(); await resume.promise; }
    return write(userId, value);
  };
  const remote = seedData(); remote.tasks[0].title = 'Phone title';
  const h = harness({ storage, request: async () => json({ data: remote, revision: 2 }) });
  h.state.data.tasks[0].title = 'Computer title'; h.state.dirty = true;
  h.state.conflict = true; h.state.syncConflict = { remote: { data: remote, revision: 2 } };
  const resolving = h.controller.resolve('remote'); await started.promise;
  h.state.data.tasks[1].title = 'New edit during resolution';
  resume.resolve(); assert.equal(await resolving, false);
  assert.equal(h.state.data.tasks[0].title, 'Computer title');
  assert.equal(h.state.data.tasks[1].title, 'New edit during resolution');
  assert.equal(h.state.conflict, true);
  assert.equal(storage.records.get('alice').data.tasks[1].title, 'New edit during resolution');
});

test('an import made during an upload stays exact and the next request is a whole-state replacement', async () => {
  const sent = deferred(), reply = deferred(); let requests = 0, firstPayload;
  const imported = seedData(); imported.tasks[0].title = 'Imported title';
  const h = harness({ request: async (path, options) => {
    const payload = JSON.parse(options.body);
    if (++requests === 1) { firstPayload = payload; sent.resolve(); return reply.promise; }
    assert.equal(payload.replace, true); assert.deepEqual(payload.data, imported);
    return json({ ackMutationId: payload.mutationId, data: payload.data, revision: 4 });
  } });
  h.state.data.tasks[0].title = 'Earlier edit'; h.state.dirty = true;
  const saving = h.controller.save(); await sent.promise;
  h.controller.replaceNext(); h.state.data = copy(imported); h.state.dirty = true;
  const remote = applyChanges(seedData(), firstPayload.changes); remote.templates[0].notes = 'Remote-only note';
  reply.resolve(json({ ackMutationId: firstPayload.mutationId, data: remote, revision: 3 })); await saving;
  assert.deepEqual(h.state.data, imported); assert.equal(h.state.replaceRequested, true);
  await h.controller.save(); assert.equal(h.state.replaceRequested, false); assert.equal(h.state.dirty, false);
});

test('an empty cloud database does not make an existing local copy appear synchronized', async () => {
  const h = harness({ request: async () => json({ data: null, revision: 0 }) });
  h.state.data.tasks[0].title = 'Preserved local title'; await h.controller.persist();
  await h.controller.boot({ userId: 'alice' });
  assert.equal(h.state.data.tasks[0].title, 'Preserved local title');
  assert.equal(h.state.conflict, true); assert.equal(h.state.status, '有冲突待处理');
});

function earlierCompletedTimer(data) {
  const block = data.templates[0].blocks[0];
  data.tracking = { timer: null, sessions: [{ id: 'remote-session', planDate: '2026-11-16',
    blockId: block.id, title: block.title, category: block.category,
    startedAt: Date.UTC(2026, 10, 16, 7), endedAt: Date.UTC(2026, 10, 16, 8) }] };
  return data;
}
function startLocalTimer(h) {
  startTracking(h.state.data, '2026-11-16', h.state.data.templates[0].blocks[0], Date.UTC(2026, 10, 16, 10), 'local-timer');
  h.state.dirty = true;
}

test('refresh does not silently rebase a local timer start across a remote start-and-stop cycle', async () => {
  const sent = deferred(), reply = deferred();
  const h = harness({ request: async () => { sent.resolve(); return reply.promise; } });
  const refreshing = h.controller.refresh(); await sent.promise;
  startLocalTimer(h);
  reply.resolve(json({ data: earlierCompletedTimer(seedData()), revision: 3, timerRevision: 2 }));
  await refreshing;
  assert.equal(h.state.conflict, true);
  assert.equal(h.state.data.tracking.timer.id, 'local-timer');
  assert.deepEqual(h.state.syncConflict.paths, [['tracking', 'timer']]);
  assert.equal(h.state.timerRevision, 0);
});

test('an acknowledged upload cannot give a later local timer start a newer remote timer version', async () => {
  const sent = deferred(), reply = deferred(); let payload;
  const h = harness({ request: async (path, options) => { payload = JSON.parse(options.body); sent.resolve(); return reply.promise; } });
  h.state.data.tasks[0].title = 'Acknowledged title'; h.state.dirty = true;
  const saving = h.controller.save(); await sent.promise; startLocalTimer(h);
  const remote = earlierCompletedTimer(applyChanges(seedData(), payload.changes));
  reply.resolve(json({ ackMutationId: payload.mutationId, data: remote, revision: 4, timerRevision: 2 }));
  await saving;
  assert.equal(h.state.conflict, true); assert.equal(h.state.pending, null);
  assert.equal(h.state.data.tracking.timer.id, 'local-timer');
  assert.deepEqual(h.state.syncConflict.paths, [['tracking', 'timer']]);
});

test('timer edits after an upload accept the single version advance caused by that same upload', async () => {
  const sent = deferred(), reply = deferred(); let payload;
  const h = harness({ request: async (path, options) => { payload = JSON.parse(options.body); sent.resolve(); return reply.promise; } });
  startLocalTimer(h);
  const saving = h.controller.save(); await sent.promise;
  pauseTracking(h.state.data, Date.UTC(2026, 10, 16, 10, 30), 'local-session');
  reply.resolve(json({ ackMutationId: payload.mutationId, data: applyChanges(seedData(), payload.changes), revision: 2, timerRevision: 1 }));
  await saving;
  assert.equal(h.state.conflict, false); assert.equal(h.state.dirty, true);
  assert.equal(h.state.data.tracking.timer.startedAt, null);
  assert.equal(h.state.data.tracking.sessions[0].id, 'local-session');
  assert.equal(h.state.timerRevision, 1);
});

test('Access login redirects are authentication expiry, not an offline session', async () => {
  const storage = disk(); storage.identity = { userId: 'alice', sync: 'operations-v1' };
  const redirect = () => new Response(null, { status: 302, headers: { Location: 'https://login.example/' } });
  const identity = await loadCloudSession(storage, async (path, options) => {
    assert.equal(options.redirect, 'manual'); return redirect();
  });
  assert.equal(identity.needsLogin, true); assert.equal(identity.offline, undefined);
  await assert.rejects(loadCloudSession(disk(), async () => redirect()), /请先登录/);
  const h = harness({ request: async (path, options) => {
    assert.equal(options.redirect, 'manual');
    const response = new Response(null); Object.defineProperty(response, 'type', { value: 'opaqueredirect' });
    return response;
  } });
  h.state.data.tasks[0].done = true; h.state.dirty = true;
  await h.controller.save();
  assert.equal(h.state.needsLogin, true); assert.ok(h.state.pending);
  assert.equal(h.state.status, '请重新登录');
});
