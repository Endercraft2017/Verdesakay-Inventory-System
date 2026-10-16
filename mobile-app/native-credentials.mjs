/** Native bearer persistence. The secure provider must be an actual OS plugin, never its web fallback. */
export function createNativeCredentials({ secure, available, storage, tabStorage, server, purgeQueue, deviceOnlyAccess }) {
  const KEY = 'otom-session-v1', MARKER = 'otom-native-signed-out';
  const message = 'Secure sign-in storage is unavailable. Unlock your device and reopen the app.';
  let active = null, shared = false, blocked = null, epoch = 0, serial = Promise.resolve();
  function origin() {
    try {
      const value = new URL(server());
      return value.protocol === 'https:' && !value.username && !value.password && value.pathname === '/' && !value.search && !value.hash ? value.origin : '';
    } catch { return ''; }
  }
  function wipePlaintext() {
    storage.removeItem('vds_token'); tabStorage.removeItem('vds_token');
    storage.removeItem('vds_browser_session'); tabStorage.removeItem('vds_browser_session');
  }
  function requireNative() { if (!available()) throw new Error(message); }
  function valid(record) {
    return record && record.version === 1 && typeof record.token === 'string' && record.token.length > 0 && record.token.length <= 4096 && !/[\r\n]/.test(record.token) && record.server === origin() && !!record.server;
  }
  function enqueue(fn) {
    const task = serial.then(fn); serial = task.catch(() => {});
    // Some existing callers clear synchronously. Still surface errors to callers that await it.
    task.catch(() => {}); return task;
  }
  async function persist(record) {
    await secure.set(KEY, record, false, false, deviceOnlyAccess);
    const saved = await secure.get(KEY, false, false);
    if (!valid(saved) || saved.token !== record.token) throw new Error(message);
  }
  function fail() {
    active = null; shared = false; blocked = new Error(message);
    try { storage.setItem(MARKER, '1'); wipePlaintext(); } catch { /* blocked storage is never a fallback */ }
    return blocked;
  }
  const ready = enqueue(async () => {
    const generation = epoch;
    try {
      const stopped = storage.getItem(MARKER) === '1';
      // Old plaintext records have no trustworthy issuing-server binding. Require fresh sign-in.
      const legacy = !!(tabStorage.getItem('vds_token') || storage.getItem('vds_token'));
      wipePlaintext(); await purgeQueue(); requireNative();
      await secure.setSynchronize(false);
      await secure.setDefaultKeychainAccess(deviceOnlyAccess);
      if (stopped || legacy || !origin()) {
        if (stopped || legacy) storage.setItem(MARKER, '1');
        await secure.remove(KEY, false); return;
      }
      const saved = await secure.get(KEY, false, false);
      if (generation !== epoch) return;
      if (valid(saved)) { active = saved; }
      else if (saved != null) { await secure.remove(KEY, false); }
    } catch { throw fail(); }
  });
  return {
    ready,
    getToken() { return !blocked && active && active.server === origin() ? active.token : null; },
    isShared() { return shared; },
    set(token, opts = {}) {
      const generation = ++epoch;
      active = null; shared = false;
      return enqueue(async () => {
        try {
          await ready; requireNative();
          const record = { version: 1, server: origin(), token };
          if (!valid(record)) throw new Error(message);
          storage.setItem(MARKER, '1'); wipePlaintext(); await purgeQueue();
          if (opts.shared) await secure.remove(KEY, false); else await persist(record);
          if (generation !== epoch) throw new Error('Sign-in changed. Start again.');
          active = record; shared = !!opts.shared; blocked = null;
          if (!shared) storage.removeItem(MARKER);
        } catch { throw fail(); }
      });
    },
    clear() {
      ++epoch; active = null; shared = false;
      let markerError = false;
      try { storage.setItem(MARKER, '1'); wipePlaintext(); } catch { markerError = true; blocked = new Error(message); }
      return enqueue(async () => {
        try {
          await purgeQueue(); requireNative(); await secure.remove(KEY, false);
          if (markerError) throw new Error(message);
          blocked = null;
        } catch { throw fail(); }
      });
    }
  };
}

/** Purge old bearer mirrors without deleting queued business records. */
export function purgeNativeQueueToken(indexedDB, name = 'vds_mobile') {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onerror = () => reject(new Error('Cannot clear legacy queue credentials'));
    request.onblocked = () => reject(new Error('Close other app windows and reopen'));
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('meta')) { db.close(); resolve(); return; }
      const tx = db.transaction('meta', 'readwrite');
      tx.objectStore('meta').delete('token');
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = tx.onabort = () => { db.close(); reject(new Error('Cannot clear legacy queue credentials')); };
    };
  });
}
