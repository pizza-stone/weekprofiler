// Cloud synchronization is separate from the portable, browser-only adapter.
const syncCopy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const syncEqual = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const syncLoginResponse = response => response.status === 401 || response.type === 'opaqueredirect'
  || (response.status >= 300 && response.status < 400);
const syncTouchesTimer = changes => changes.some(change => change.path?.[0] === 'tracking'
  && (change.path.length === 1 || change.path[1] === 'timer'));
function syncCheckTimerRevision(changes, actual, expected) {
  if (syncTouchesTimer(changes) && (actual || 0) !== expected) {
    const error = new Error('另一台设备已操作计时器，本机计时修改已保留，请核对后处理。');
    error.paths = [['tracking', 'timer']]; throw error;
  }
}

export async function loadCloudSession(storage, request = fetch) {
  let response;
  try { response = await request('/api/session', { cache: 'no-store', redirect: 'manual' }); }
  catch {
    const identity = await storage.readIdentity();
    if (identity?.userId) return { ...identity, offline: true };
    throw new Error('首次使用需要联网登录；本机还没有可用的离线副本。');
  }
  if (syncLoginResponse(response)) {
    const identity = await storage.readIdentity();
    if (identity?.userId) return { ...identity, needsLogin: true };
    throw new Error('请先登录周谱，再读取云端数据。');
  }
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(value.error || '云端连接尚未配置完成。');
  }
  if (!value.userId || value.sync !== 'operations-v1') throw new Error('云端同步版本不兼容，请刷新页面。');
  const identity = { userId: value.userId, email: value.email || '', sync: value.sync };
  await storage.writeIdentity(identity);
  return identity;
}

export function createCloudSync({ state, storage, createChanges, applyChanges, rebaseChanges,
  validateData, migrateData, seedData, uid, render, updateStatus, toast,
  isEditing = () => false, isVisible = () => true, request = fetch,
  schedule = setTimeout, cancel = clearTimeout, now = Date.now }) {
  let timeout, needsRender = false, replacementGeneration = 0, stopped = false, signingOut = false;
  let signOutPromise = null, signedOut = false;
  const activePersistence = new Set();
  const emit = changed => {
    if (changed) needsRender = true;
    if (needsRender && !isEditing()) { needsRender = false; render(); }
    updateStatus();
  };
  const record = () => syncCopy({ data: state.data, baseData: state.baseData, revision: state.revision,
    timerRevision: state.timerRevision, dirty: state.dirty, pending: state.pending,
    syncConflict: state.syncConflict || null, replaceRequested: !!state.replaceRequested,
    syncRejected: !!state.syncRejected,
    replacementGeneration, lastSyncedAt: state.lastSyncedAt || null,
    conflictDraft: state.conflictDraft || null });
  async function persist(value = record()) {
    if (stopped || signingOut) throw new Error('正在退出账号，未继续写入本机副本。');
    const operation = Promise.resolve().then(() => storage.write(state.userId, value));
    activePersistence.add(operation);
    try { await operation; state.syncStorageError = false; }
    catch (error) {
      state.syncStorageError = true;
      state.status = '本机保存失败 · 请导出备份'; emit(false);
      throw error;
    }
    finally { activePersistence.delete(operation); }
  }
  function remember() { return persist().catch(() => { toast('无法保存离线副本，请保持页面打开并导出备份。'); }); }
  function queue() {
    if (stopped || signingOut) return;
    state.status = state.syncStorageError ? '本机保存失败 · 请导出备份' : state.conflict ? '有冲突待处理' : state.needsLogin ? '请重新登录'
      : state.syncRejected ? '云端未接受 · 请调整修改' : '待同步修改';
    emit(false); cancel(timeout);
    if (state.conflict || state.needsLogin || state.syncRejected) return;
    timeout = schedule(() => { void save(); }, 550);
  }
  function setConflict(remote, changes, paths = [], error = '两端修改需要核对。') {
    state.conflict = true;
    state.syncConflict = syncCopy({ remote, changes, paths, error });
    state.status = '有冲突待处理'; emit(true);
  }
  function checkedData(data) {
    if (!validateData(data)) throw new Error('收到的日程数据无效，已保留本机内容。');
    return migrateData(data);
  }
  async function readResponse(response) {
    if (syncLoginResponse(response)) { state.needsLogin = true; throw new Error('AUTH'); }
    const value = await response.json().catch(() => ({}));
    if (!response.ok && response.status !== 409) throw new Error(value.error || 'NETWORK');
    return value;
  }
  async function boot(identity) {
    state.userId = identity.userId; state.email = identity.email || '';
    state.needsLogin = !!identity.needsLogin;
    let cached = await storage.read(identity.userId);
    if (cached && !validateData(cached.data)) throw new Error('本机离线数据校验失败，请保留备份后重试。');
    let remote;
    if (!identity.offline && !identity.needsLogin) {
      try { const response = await request('/api/sync', { cache: 'no-store', redirect: 'manual' }); remote = await readResponse(response); }
      catch (error) { if (!cached) throw error; }
    }
    if (!remote && !cached) throw new Error('暂时无法连接云端，本机也没有离线副本。');
    if (cached) {
      Object.assign(state, cached);
      state.data = checkedData(cached.data);
      state.baseData = cached.baseData ?? null;
      state.timerRevision = cached.timerRevision || 0;
      replacementGeneration = cached.replacementGeneration || 0;
      state.conflict = !!cached.syncConflict;
      if (!cached.dirty && !cached.pending && !cached.syncConflict && remote?.data) {
        state.data = checkedData(remote.data); state.baseData = syncCopy(remote.data);
        state.revision = remote.revision; state.timerRevision = remote.timerRevision;
      }
    } else {
      state.data = remote.data ? checkedData(remote.data) : seedData();
      state.baseData = remote.data ? syncCopy(remote.data) : null;
      state.revision = remote.revision; state.timerRevision = remote.timerRevision || 0;
      state.pending = null; state.dirty = !remote.data; state.conflict = false;
    }
    // The baseline is exactly what the server acknowledged. Local migrations
    // must remain an ordinary guarded edit, including any timer metadata change.
    state.dirty = !!state.pending || !!state.replaceRequested || !state.baseData
      || createChanges(state.baseData, state.data).length > 0;
    if (cached && remote && !remote.data && cached.baseData) {
      state.dirty = true;
      setConflict(remote, [], [], '云端数据为空，本机副本已保留，请先导出备份再核对。');
    }
    state.status = state.conflict ? '有冲突待处理' : state.needsLogin ? '请重新登录'
      : state.syncRejected ? '云端未接受 · 请调整修改' : state.dirty ? '待同步修改' : remote ? '已同步' : '离线 · 已保存本机';
    await persist();
  }
  function replaceNext() { state.replaceRequested = true; replacementGeneration++; }
  async function save() {
    if (stopped || signingOut || !state.ready || state.busy || state.conflict || state.needsLogin || state.syncRejected || !state.dirty) return;
    state.busy = true; state.status = '正在同步'; emit(false);
    let succeeded = false;
    try {
      if (!state.pending) {
        const snapshot = syncCopy(state.data);
        const payload = { mutationId: uid(), baseRevision: state.revision, baseTimerRevision: state.timerRevision || 0 };
        if (!state.baseData || state.replaceRequested) Object.assign(payload, { replace: true, data: snapshot });
        else {
          payload.changes = createChanges(state.baseData, snapshot);
          if (!payload.changes.length) { state.dirty = false; state.status = '已同步'; await persist(); return; }
        }
        state.pending = { payload, snapshot, replacementGeneration };
      }
      // Persist the exact request before sending: a lost response can safely retry its ID.
      await persist();
      const pending = state.pending;
      const response = await request('/api/sync', { method: 'POST', redirect: 'manual',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pending.payload) });
      if ([400,413,415].includes(response.status)) {
        const rejected = await response.json().catch(() => ({}));
        state.pending = null;
        // A corrected edit/import made during the rejected request may be retried.
        state.syncRejected = syncEqual(state.data, pending.snapshot) && pending.replacementGeneration === replacementGeneration;
        state.status = state.syncRejected ? '云端未接受 · 请调整修改' : '待同步修改';
        succeeded = !state.syncRejected;
        await persist(); toast(rejected.error || '云端未接受这次修改，本机内容已保留。'); return;
      }
      const result = await readResponse(response);
      if (response.status === 409) {
        setConflict(result, state.baseData ? createChanges(state.baseData, state.data) : [], result.paths, result.error);
        await persist(); return;
      }
      if (result.ackMutationId !== pending.payload.mutationId) throw new Error('同步确认不匹配，已保留本机修改。');
      const remote = checkedData(result.data), rawRemote = syncCopy(result.data);
      const current = syncCopy(state.data), tail = createChanges(pending.snapshot, current);
      state.pending = null;
      state.revision = result.revision; state.timerRevision = result.timerRevision || 0;
      if (pending.replacementGeneration === replacementGeneration) state.replaceRequested = false;
      if (!syncEqual(remote, pending.snapshot)) state.undo = [];
      try {
        // Changes typed while this request was in flight are replayed onto the acknowledged state.
        const expectedTimerRevision = (pending.payload.baseTimerRevision || 0)
          + (pending.payload.replace || syncTouchesTimer(pending.payload.changes || []) ? 1 : 0);
        if (!state.replaceRequested) syncCheckTimerRevision(tail, result.timerRevision, expectedTimerRevision);
        const merged = checkedData(state.replaceRequested ? current : tail.length ? applyChanges(rawRemote, tail) : rawRemote);
        if (!validateData(merged)) throw new Error('后续修改与云端安排冲突。');
        const changed = !syncEqual(state.data, merged);
        state.baseData = rawRemote; state.data = merged;
        state.dirty = state.replaceRequested || createChanges(rawRemote, merged).length > 0;
        state.lastSyncedAt = now(); state.status = state.dirty ? '待同步修改' : '已同步';
        emit(changed); succeeded = true;
      } catch (error) {
        state.baseData = syncCopy(pending.snapshot); state.data = current; state.dirty = true;
        setConflict(result, tail, error.paths, error.message);
      }
      await persist();
    } catch (error) {
      state.status = state.syncStorageError ? '本机保存失败 · 请导出备份' : state.needsLogin ? '请重新登录' : '离线 · 修改待同步';
      emit(false);
    } finally {
      state.busy = false; emit(false);
      if (succeeded && state.dirty && !state.conflict) queue();
    }
  }
  async function refresh(force = false) {
    if (stopped || signingOut || !state.ready || state.busy || (!force && !isVisible())) return;
    if (state.needsLogin || state.conflict || state.syncRejected) { emit(false); return; }
    if (state.dirty || state.pending) { await save(); return; }
    // The settings dialog is itself an editing surface. Its explicit sync
    // button may fetch safely; emit() still defers repaint until the dialog closes.
    if (isEditing() && !force) return;
    state.busy = true;
    const base = syncCopy(state.baseData), initialReplacementGeneration = replacementGeneration,
      initialTimerRevision = state.timerRevision || 0;
    try {
      const response = await request('/api/sync?revision=' + state.revision, { cache: 'no-store', redirect: 'manual' });
      const remote = await readResponse(response);
      // An import made while GET was pending must remain a strict, whole-state replacement.
      if (initialReplacementGeneration !== replacementGeneration || state.replaceRequested) return;
      if (remote.unchanged) { state.status = state.dirty ? '待同步修改' : '已同步'; state.lastSyncedAt = now(); return; }
      if (!remote.data) throw new Error('云端数据为空，已保留本机内容。');
      checkedData(remote.data);
      const incoming = syncCopy(remote.data);
      const changes = createChanges(base, state.data);
      try {
        syncCheckTimerRevision(changes, remote.timerRevision, initialTimerRevision);
        const merged = checkedData(changes.length ? applyChanges(incoming, changes) : incoming);
        if (!validateData(merged)) throw new Error('两端安排合并后发生时间冲突。');
        const changed = !syncEqual(state.data, merged);
        state.data = merged; state.baseData = syncCopy(incoming);
        state.revision = remote.revision; state.timerRevision = remote.timerRevision || 0;
        state.dirty = createChanges(incoming, merged).length > 0; state.undo = [];
        state.lastSyncedAt = now(); state.status = state.dirty ? '待同步修改' : '已同步'; emit(changed);
      } catch (error) { setConflict(remote, changes, error.paths, error.message); }
      await persist();
    } catch { state.status = state.syncStorageError ? '本机保存失败 · 请导出备份' : state.needsLogin ? '请重新登录' : '离线 · 已保存本机'; }
    finally { state.busy = false; emit(false); if (state.dirty && !state.conflict) queue(); }
  }
  async function resolve(choice) {
    if (stopped || signingOut || state.busy) return false;
    state.busy = true;
    try {
      if (!['local', 'remote'].includes(choice)) throw new Error('请选择要保留的版本。');
      const response = await request('/api/sync', { cache: 'no-store', redirect: 'manual' });
      if (!response.ok) { await readResponse(response); return false; }
      const remote = await response.json(); checkedData(remote.data);
      const incoming = syncCopy(remote.data);
      const changes = state.baseData ? createChanges(state.baseData, state.data) : [];
      if (choice === 'local' && (!state.baseData || state.replaceRequested)) throw new Error('整份备份替换发生冲突，请先导出本机备份，再载入云端核对。');
      const next = checkedData(choice === 'local' && changes.length ? applyChanges(incoming, rebaseChanges(incoming, changes)) : incoming);
      if (!validateData(next)) throw new Error('这些修改不能自动合并，请导出本机备份后核对时间冲突。');
      const original = syncCopy(state.data), initialReplacementGeneration = replacementGeneration;
      const resolved = { ...record(), data: syncCopy(next), baseData: syncCopy(incoming), revision: remote.revision,
        timerRevision: remote.timerRevision || 0, pending: null, syncConflict: null,
        replaceRequested: false, syncRejected: false, dirty: createChanges(incoming, next).length > 0,
        conflictDraft: { data: original, savedAt: now() } };
      // Durably save both the selected result and the original draft before
      // replacing the visible state. Storage failure leaves the conflict intact.
      await persist(resolved);
      if (!syncEqual(state.data, original) || replacementGeneration !== initialReplacementGeneration) {
        await persist();
        toast('处理期间本机内容发生了变化，已保留修改，请重新选择。');
        return false;
      }
      Object.assign(state, resolved); state.conflict = false; state.undo = [];
      state.status = state.dirty ? '待同步修改' : '已同步'; emit(true); return true;
    } catch (error) {
      if (state.needsLogin) state.status = '请重新登录';
      toast(error.message === 'AUTH' ? '请重新登录后处理冲突。' : error.message); return false;
    }
    finally { state.busy = false; emit(false); if (state.dirty && !state.conflict) queue(); }
  }
  async function performSignOut() {
    if (signingOut || stopped) return false;
    if (state.dirty || state.pending || state.conflict || state.busy) {
      toast('请先完成同步、处理冲突，并等待当前操作结束后再退出。');
      return false;
    }
    signingOut = true; cancel(timeout);
    state.status = '正在退出账号'; emit(false);
    let remoteLoggedOut = false;
    try {
      // remember() may still be writing even when no HTTP request is in flight.
      // Wait for it before deleting records, and block any newly requested writes.
      const results = await Promise.allSettled([...activePersistence]);
      if (results.some(result => result.status === 'rejected')) throw new Error('本机保存尚未成功，请先导出备份后重试。');
      const response = await request('/api/auth/logout', { method: 'POST', redirect: 'manual',
        credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      await readResponse(response);
      if (!response.ok) throw new Error('未能退出账号，请稍后重试。');
      remoteLoggedOut = true; state.needsLogin = true;
      await storage.writeIdentity(null);
      await storage.clear(state.userId);
      stopped = true; signedOut = true; state.status = '已退出账号'; emit(false);
      return true;
    } catch (error) {
      state.status = remoteLoggedOut ? '账号已退出 · 本机副本清理失败'
        : state.syncStorageError ? '本机保存失败 · 请导出备份' : state.needsLogin ? '请重新登录' : '退出未完成 · 请重试';
      toast(remoteLoggedOut ? '账号已退出，但本机离线副本未能完全清理，请重试退出。'
        : error.message === 'AUTH' ? '登录已失效，暂未清理本机副本，请重新登录后重试退出。' : '退出未完成，本机副本已保留。' + (error.message || ''));
      emit(false); return false;
    } finally { signingOut = false; }
  }
  function signOut() {
    if (signedOut) return Promise.resolve(true);
    // Repeated clicks share the same operation; a second caller cannot mistake
    // an in-progress logout for failure and re-enable editing prematurely.
    if (!signOutPromise) signOutPromise = performSignOut().finally(() => { signOutPromise = null; });
    return signOutPromise;
  }
  function stop() { stopped = true; cancel(timeout); }
  return { boot, persist, remember, queue, save, refresh, resolve, replaceNext, signOut, stop };
}
