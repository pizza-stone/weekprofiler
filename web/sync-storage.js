// Browser-only copies of cloud data. Cached identity enables offline viewing,
// never authentication: the server must authenticate every network request.
const SYNC_DB_NAME = 'weekprofiler-sync';
const SYNC_DB_STORE = 'records';
const SYNC_FALLBACK_PREFIX = 'weekprofiler-sync:';

function browserStorage(name) {
  try { return globalThis[name]; } catch { return undefined; }
}
function copyStoredValue(value) {
  const text = JSON.stringify(value);
  if (text === undefined) throw new TypeError('不能保存空的同步记录。');
  return JSON.parse(text);
}
function userStorageKey(userId) {
  if (typeof userId !== 'string' || !userId || userId.length > 512) throw new TypeError('同步用户编号无效。');
  return 'user:' + userId;
}
function decodeEnvelope(value) {
  if (value === null || value === undefined) return null;
  if (value?.version !== 1 || !Number.isSafeInteger(value.stamp) || value.stamp < 0
      || typeof value.deleted !== 'boolean' || (!value.deleted && !Object.hasOwn(value, 'value'))) {
    throw new Error('本机同步副本格式不正确，请保留备份。');
  }
  return value;
}

/**
 * Each complete record is committed atomically, including its pending request.
 * Writes capture their value immediately and run in call order. A timestamped
 * fallback prevents a stale IndexedDB copy winning after an IndexedDB failure.
 */
export function createSyncStorage(options = {}) {
  const indexedDB = Object.hasOwn(options, 'indexedDB') ? options.indexedDB : browserStorage('indexedDB');
  const localStorage = Object.hasOwn(options, 'localStorage') ? options.localStorage : browserStorage('localStorage');
  const timeoutMs = options.timeoutMs ?? 2500;
  let databasePromise, tail = Promise.resolve(), lastStamp = 0;

  function database() {
    if (!indexedDB) return Promise.resolve(null);
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      let finished = false;
      const finish = (error, db) => {
        if (finished) { db?.close(); return; }
        finished = true; clearTimeout(timer);
        if (error) reject(error); else resolve(db);
      };
      const timer = setTimeout(() => finish(new Error('本机数据库打开超时。')), timeoutMs);
      let request;
      try { request = indexedDB.open(SYNC_DB_NAME, 1); }
      catch (error) { finish(error); return; }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(SYNC_DB_STORE)) db.createObjectStore(SYNC_DB_STORE);
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); databasePromise = undefined; };
        finish(null, db);
      };
      request.onerror = () => finish(request.error || new Error('无法打开本机数据库。'));
      request.onblocked = () => finish(new Error('本机数据库正在被其他页面使用。'));
    });
    return databasePromise;
  }

  async function idbRecord(key, envelope) {
    const db = await database();
    if (!db) return { available: false };
    return new Promise((resolve, reject) => {
      const writing = envelope !== undefined;
      let transaction, request, result, finished = false;
      const finish = error => {
        if (finished) return;
        finished = true; clearTimeout(timer);
        if (error) reject(error); else resolve({ available: true, value: writing ? envelope : decodeEnvelope(result) });
      };
      const timer = setTimeout(() => {
        finish(new Error('本机数据库保存或读取超时。'));
        try { transaction?.abort(); } catch {}
      }, timeoutMs);
      try {
        transaction = db.transaction(SYNC_DB_STORE, writing ? 'readwrite' : 'readonly');
        const store = transaction.objectStore(SYNC_DB_STORE);
        request = writing ? store.put(envelope, key) : store.get(key);
        request.onsuccess = () => { result = request.result; };
        transaction.oncomplete = () => {
          try { finish(); } catch (error) { reject(error); }
        };
        transaction.onerror = () => finish(transaction.error || request.error || new Error('本机数据库操作失败。'));
        transaction.onabort = () => finish(transaction.error || new Error('本机数据库操作已取消。'));
      } catch (error) { finish(error); }
    });
  }

  function fallbackRecord(key, envelope) {
    if (!localStorage) return { available: false };
    if (envelope !== undefined) localStorage.setItem(SYNC_FALLBACK_PREFIX + key, JSON.stringify(envelope));
    const text = localStorage.getItem(SYNC_FALLBACK_PREFIX + key);
    return { available: true, value: text === null ? null : decodeEnvelope(JSON.parse(text)) };
  }

  async function readEnvelope(key) {
    const attempts = await Promise.allSettled([
      idbRecord(key), Promise.resolve().then(() => fallbackRecord(key)),
    ]);
    const available = attempts.filter(result => result.status === 'fulfilled' && result.value.available);
    if (!available.length) throw new Error('无法读取本机同步副本，请检查浏览器存储权限。', {
      cause: attempts.find(result => result.status === 'rejected')?.reason,
    });
    const records = available.map(result => result.value.value).filter(Boolean);
    const newest = records.sort((a, b) => b.stamp - a.stamp)[0] || null;
    lastStamp = Math.max(lastStamp, newest?.stamp || 0);
    return newest;
  }

  function ordered(action) {
    const next = tail.then(action);
    tail = next.catch(() => {});
    return next;
  }
  function read(key) {
    return ordered(async () => {
      const envelope = await readEnvelope(key);
      return !envelope || envelope.deleted ? null : copyStoredValue(envelope.value);
    });
  }
  function write(key, value, deleted = false) {
    // Snapshot before the first await; callers can immediately edit their state.
    const snapshot = deleted ? undefined : copyStoredValue(value);
    return ordered(async () => {
      // Reading also obtains the newest fallback timestamp after a restart.
      await readEnvelope(key).catch(() => {});
      const envelope = { version: 1, stamp: lastStamp = Math.max(Date.now(), lastStamp + 1), deleted };
      if (!deleted) envelope.value = snapshot;
      const failures = []; let savedToIndexedDB = false;
      try {
        const saved = await idbRecord(key, envelope);
        if (saved.available) {
          savedToIndexedDB = true;
          if (!deleted) return;
        }
      } catch (error) { failures.push(error); }
      try {
        const saved = fallbackRecord(key, envelope);
        if (saved.available) return;
      } catch (error) { failures.push(error); }
      if (savedToIndexedDB) return;
      throw new Error('本机保存失败，请保持页面打开并导出备份。', { cause: failures[0] });
    });
  }

  return {
    read(userId) { return read(userStorageKey(userId)); },
    write(userId, record) { return write(userStorageKey(userId), record); },
    readIdentity() { return read('identity'); },
    writeIdentity(identity) {
      if (identity !== null) userStorageKey(identity?.userId);
      return write('identity', identity, identity === null);
    },
    // A tombstone also hides any older fallback record after recovery.
    clear(userId) { return write(userStorageKey(userId), undefined, true); },
  };
}
