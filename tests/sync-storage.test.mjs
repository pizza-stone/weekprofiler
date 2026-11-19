import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createSyncStorage } from '../web/sync-storage.js';

function memoryStorage() {
  const values = new Map();
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}
function fakeIndexedDB() {
  const values = new Map();
  const control = { failOpen: false, failWrite: false, abortedWrite: false };
  const db = {
    objectStoreNames: { contains: () => true }, close() {},
    transaction() {
      const tx = { abort() { tx.onabort?.(); }, objectStore() {
        return { get(key) { return request(false, key); }, put(value, key) { return request(true, key, value); } };
      } };
      function request(write, key, value) {
        const req = {};
        queueMicrotask(() => {
          if (write && control.failWrite) {
            tx.error = new Error('quota'); tx.onerror?.(); return;
          }
          req.result = write ? key : structuredClone(values.get(key)); req.onsuccess?.();
          queueMicrotask(() => {
            if (write && control.abortedWrite) { tx.error = new Error('aborted'); tx.onabort?.(); return; }
            if (write) values.set(key, structuredClone(value));
            tx.oncomplete?.();
          });
        });
        return req;
      }
      return tx;
    },
  };
  return { values, control, open() {
    const req = { result: db };
    queueMicrotask(() => {
      if (control.failOpen) { req.error = new Error('unavailable'); req.onerror?.(); }
      else req.onsuccess?.();
    });
    return req;
  } };
}
const draft = () => ({ data: { title: '本机修改' }, baseData: { title: '云端原值' }, revision: 7,
  dirty: true, pending: { mutationId: 'pending-1', changes: [{ path: 'title', value: '本机修改' }] } });

test('IndexedDB commits the full pending record and snapshots it before asynchronous writes', async () => {
  const indexedDB = fakeIndexedDB(), storage = createSyncStorage({ indexedDB, localStorage: undefined });
  const record = draft(), writing = storage.write('alice', record);
  record.pending.mutationId = 'changed-after-write';
  record.data.title = 'later-edit';
  await writing;
  const reopened = createSyncStorage({ indexedDB, localStorage: undefined });
  assert.deepEqual(await reopened.read('alice'), draft());
  const read = await reopened.read('alice'); read.data.title = 'mutated-result';
  assert.equal((await reopened.read('alice')).data.title, '本机修改');
});

test('localStorage fallback preserves identity separately and isolates account data', async () => {
  const localStorage = memoryStorage(), storage = createSyncStorage({ indexedDB: undefined, localStorage });
  await storage.writeIdentity({ userId: 'alice', email: 'alice@example.test' });
  await storage.write('alice', draft());
  await storage.write('bob', { data: { title: 'Bob' }, dirty: false });
  assert.equal((await storage.readIdentity()).userId, 'alice');
  assert.deepEqual(await storage.read('alice'), draft());
  assert.equal((await storage.read('bob')).data.title, 'Bob');
  assert.equal(await storage.read('unknown'), null);
  await storage.writeIdentity(null);
  assert.equal(await storage.readIdentity(), null);
  assert.deepEqual(await storage.read('alice'), draft());
});

test('a newer fallback wins over stale IndexedDB after a storage failure and restart', async () => {
  const indexedDB = fakeIndexedDB(), localStorage = memoryStorage();
  const storage = createSyncStorage({ indexedDB, localStorage });
  await storage.write('alice', { data: { title: 'old' } });
  indexedDB.control.failWrite = true;
  await storage.write('alice', draft());
  indexedDB.control.failWrite = false;
  const reopened = createSyncStorage({ indexedDB, localStorage });
  assert.deepEqual(await reopened.read('alice'), draft());
  await reopened.write('alice', { data: { title: 'recovered' } });
  assert.equal((await createSyncStorage({ indexedDB, localStorage }).read('alice')).data.title, 'recovered');
});

test('writes remain ordered after an earlier failure and do not report uncommitted IndexedDB writes as saved', async () => {
  const indexedDB = fakeIndexedDB(), storage = createSyncStorage({ indexedDB, localStorage: undefined });
  indexedDB.control.abortedWrite = true;
  await assert.rejects(storage.write('alice', draft()), /保存失败/);
  assert.equal(await storage.read('alice'), null);
  indexedDB.control.abortedWrite = false;
  const first = storage.write('alice', { number: 1 }), second = storage.write('alice', { number: 2 });
  await Promise.all([first, second]);
  assert.deepEqual(await storage.read('alice'), { number: 2 });
});

test('clearing an account cannot resurrect an older fallback copy', async () => {
  const indexedDB = fakeIndexedDB(), localStorage = memoryStorage();
  const storage = createSyncStorage({ indexedDB, localStorage });
  indexedDB.control.failWrite = true;
  await storage.write('alice', draft());
  indexedDB.control.failWrite = false;
  await storage.clear('alice');
  assert.equal(await createSyncStorage({ indexedDB, localStorage }).read('alice'), null);
  assert.equal(JSON.parse(localStorage.values.get('weekprofiler-sync:user:alice')).deleted, true);
});

test('unavailable, quota-exhausted, or corrupt storage reports failures', async () => {
  const unavailable = createSyncStorage({ indexedDB: undefined, localStorage: undefined });
  await assert.rejects(unavailable.read('alice'), /无法读取/);
  await assert.rejects(unavailable.write('alice', draft()), /保存失败/);
  const localStorage = memoryStorage();
  localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
  await assert.rejects(createSyncStorage({ indexedDB: undefined, localStorage }).write('alice', draft()), /保存失败/);
  localStorage.values.set('weekprofiler-sync:user:alice', '{bad json');
  await assert.rejects(createSyncStorage({ indexedDB: undefined, localStorage }).read('alice'), /无法读取/);
});

const shell = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
function serviceWorker() {
  const listeners = new Map(), stores = new Map(), fetched = [];
  const cacheFailures = { open: false, write: false };
  let fetchImpl = async request => {
    fetched.push(new URL(request.url).pathname);
    return new Response(shell, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  };
  const cacheStorage = {
    async open(name) {
      if (cacheFailures.open) throw new Error('CacheStorage disabled');
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name);
      return {
        async put(key, value) { if (cacheFailures.write) throw new Error('cache full'); entries.set(key, value.clone()); },
        async match(key) { return entries.get(key)?.clone(); },
      };
    },
    async keys() { return [...stores.keys()]; }, async delete(name) { return stores.delete(name); },
  };
  const self = { location: { origin: 'https://weekprofiler.example' }, clients: { async claim() {} },
    addEventListener(name, handler) { listeners.set(name, handler); },
    skipWaiting() { throw new Error('Must not force activation'); } };
  class AppRequest extends Request {
    constructor(url, options) { super(typeof url === 'string' ? new URL(url, self.location.origin) : url, options); }
  }
  vm.runInNewContext(readFileSync(new URL('../web/sw.js', import.meta.url), 'utf8'), {
    self, caches: cacheStorage, fetch: request => fetchImpl(request), Request: AppRequest, URL, Map, Promise,
  });
  return { stores, fetched, cacheStorage, cacheFailures,
    setFetch(fn) { fetchImpl = fn; },
    async lifecycle(name) { let promise; listeners.get(name)({ waitUntil(value) { promise = value; } }); await promise; },
    request(path, method = 'GET') {
      let response;
      listeners.get('fetch')({ request: new AppRequest(path, { method }), respondWith(promise) { response = promise; } });
      return response;
    },
  };
}

test('service worker installs only known shell resources and never precaches API data', async () => {
  const sw = serviceWorker();
  await sw.lifecycle('install');
  assert.ok(sw.fetched.includes('/'));
  assert.ok(sw.fetched.includes('/sync-storage.js'));
  assert.ok(sw.fetched.every(path => !path.startsWith('/api/')));
  // The fake server serves HTML for scripts: MIME checks prevent caching it.
  assert.deepEqual([...sw.stores.values()][0].size, 1);
  for (const path of ['/api/planner', '/api/session', '/api/sync', '/cdn-cgi/access/login', 'https://other.example/app.js', '/app.js?login=1']) {
    assert.equal(sw.request(path), undefined);
  }
  assert.equal(sw.request('/', 'POST'), undefined);
});

test('service worker serves the cached shell only on network failure, and keeps login responses out of cache', async () => {
  const sw = serviceWorker(); await sw.lifecycle('install');
  const login = new Response('<html>Log in to Cloudflare Access</html>', { headers: { 'Content-Type': 'text/html' } });
  sw.setFetch(async () => login.clone());
  assert.match(await (await sw.request('/')).text(), /Log in/);
  sw.setFetch(async () => { throw new Error('offline'); });
  assert.equal(await (await sw.request('/')).text(), shell);
});

test('redirected shell responses and authentication errors cannot replace the offline copy', async () => {
  const sw = serviceWorker(); await sw.lifecycle('install');
  sw.setFetch(async () => {
    const response = new Response(shell.replace('正在打开你的时间表', 'redirected copy'), { headers: { 'Content-Type': 'text/html' } });
    Object.defineProperty(response, 'redirected', { value: true }); return response;
  });
  await sw.request('/');
  sw.setFetch(async () => new Response('Unauthorized', { status: 401 }));
  assert.equal((await sw.request('/')).status, 401);
  sw.setFetch(async () => { throw new Error('offline'); });
  assert.equal(await (await sw.request('/')).text(), shell);
});

test('service worker activation removes only older weekprofiler shell caches', async () => {
  const sw = serviceWorker(); await sw.lifecycle('install');
  await sw.cacheStorage.open('weekprofiler-shell-old');
  await sw.cacheStorage.open('unrelated-application-cache');
  await sw.lifecycle('activate');
  assert.equal(sw.stores.has('weekprofiler-shell-old'), false);
  assert.equal(sw.stores.has('unrelated-application-cache'), true);
  assert.ok([...sw.stores.keys()].some(name => name.startsWith('weekprofiler-shell-')));
});

test('disabled or full shell cache does not prevent a successful online page load', async () => {
  const sw = serviceWorker(); await sw.lifecycle('install');
  const fresh = shell.replace('正在打开你的时间表', '新的应用界面');
  sw.setFetch(async () => new Response(fresh, { headers: { 'Content-Type': 'text/html' } }));
  sw.cacheFailures.write = true;
  assert.equal(await (await sw.request('/')).text(), fresh);
  sw.cacheFailures.open = true;
  assert.equal(await (await sw.request('/')).text(), fresh);
});
