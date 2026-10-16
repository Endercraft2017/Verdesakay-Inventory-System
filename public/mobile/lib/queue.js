/* Offline write queue. When a POST fails because the device is offline, the
   operation is stashed in IndexedDB and replayed (with a stable Idempotency-Key,
   so the server de-dupes) when the connection returns or the app is reopened.

   mSubmit(path, body, {label}) -> Promise<{ok:true,response} | {queued:true}>
   mQueue.count() / .all() / .retry(key) / .discard(key) / .flush() / .onChange(cb)
   mQueue.setToken(token, user) / .clearToken() / .foreignCount()

   Every queued op is stamped with the account that made it (user_id), and is only ever
   replayed under that same account — here and in the service worker (sw.js replayQueue).
   On a shared phone, one person's unsent action must never be sent as the next person.
   count()/all() cover the signed-in user's ops (only scoped operations); foreignCount()
   is how many belong to someone else on this phone — they wait for that person.
*/
(function () {
  var DB_NAME = 'vds_mobile' + (window.VDS_BASE_PATH || '');
  var STORE = 'ops';
  var META = 'meta'; // { k, v, user_id } — the bearer token + its account, for the service worker
  var dbP = null;
  var currentUser = null; // { id, name } of the signed-in account, set by setToken

  /** Whether an op may be sent by the signed-in account. Legacy unbound operations are retained for review and never automatically replayed. */
  function scope() { return API.serverScope(); }
  function mine(op) { return !!currentUser && op.user_id === currentUser.id && op.server === scope(); }

  function db() {
    if (dbP) return dbP;
    dbP = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 2);
      req.onupgradeneeded = function () {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'key' });
        if (!req.result.objectStoreNames.contains(META)) req.result.createObjectStore(META, { keyPath: 'k' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbP;
  }

  function tx(mode, fn, storeName) {
    return db().then(function (d) {
      return new Promise(function (resolve, reject) {
        var t = d.transaction(storeName || STORE, mode);
        var store = t.objectStore(storeName || STORE);
        var out = fn(store);
        t.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : out); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error); };
      });
    });
  }

  var listeners = [];
  function emit() { listeners.forEach(function (cb) { try { cb(); } catch (e) {} }); }

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  /** Ask the browser to replay us in the background once it has connectivity. */
  function requestBackgroundSync() {
    if (!('serviceWorker' in navigator) || !('SyncManager' in window)) return;
    navigator.serviceWorker.ready.then(function (reg) {
      if (reg.sync) reg.sync.register('vds-flush').catch(function () {});
    }).catch(function () {});
  }

  var mQueue = {
    /** Mirror the bearer token (and whose it is) into IndexedDB for browser replay; native vault credentials stay in memory. */
    setToken: function (t, user) {
      currentUser = user && user.id != null ? { id: user.id, name: user.full_name || user.name || '' } : null;
      emit(); // counts depend on who is signed in
      if (navigator.onLine) setTimeout(function () { mQueue.flush().catch(function () {}); }, 0);
      return tx('readwrite', function (s) {
        if (window.VDS_NATIVE) { s.delete('token'); return; }
        s.put({
          k: 'token', server: scope(), v: t, cookie_auth: !!(window.API && API.cookieAuth && API.cookieAuth()), user_id: currentUser ? currentUser.id : null,
          device_id: window.API && API.deviceId ? API.deviceId() : null, // sw.js has no localStorage
        });
      }, META).catch(function () {});
    },
    /** Forget the token on sign-out — nothing replays in the background until the next sign-in. */
    clearToken: function () {
      currentUser = null;
      return tx('readwrite', function (s) { s.delete('token'); }, META).catch(function () {});
    },
    enqueue: function (op) {
      op.server = scope();
      op.created = op.created || Date.now();
      op.attempts = 0;
      if (currentUser) { op.user_id = currentUser.id; op.user_name = currentUser.name; }
      return tx('readwrite', function (s) { s.put(op); }).then(function () {
        emit();
        requestBackgroundSync();
        return op.key;
      });
    },
    _every: function () {
      return tx('readonly', function (s) { return s.getAll(); }).then(function (rows) {
        return (rows || []).sort(function (a, b) { return a.created - b.created; });
      });
    },
    /** The signed-in account's queued ops, oldest first. */
    all: function () { return mQueue._every().then(function (rows) { return rows.filter(mine); }); },
    count: function () { return mQueue.all().then(function (rows) { return rows.length; }); },
    /** Queued ops on this phone that belong to another account. */
    foreignCount: function () {
      return mQueue._every().then(function (rows) { return rows.filter(function (o) { return !mine(o); }).length; });
    },
    _remove: function (key) { return tx('readwrite', function (s) { s.delete(key); }).then(emit); },
    _put: function (op) { return tx('readwrite', function (s) { s.put(op); }).then(emit); },

    discard: function (key) {
      return mQueue.all().then(function (rows) {
        if (rows.some(function (o) { return o.key === key; })) return mQueue._remove(key);
      });
    },

    retry: function (key) {
      return mQueue.all().then(function (rows) {
        var op = rows.filter(function (o) { return o.key === key; })[0];
        if (!op) return;
        op.error = null;
        return mQueue._put(op).then(function () { return sendOne(op); });
      });
    },

    /** Try to send every queued op. Stops early if the device is still offline. */
    flush: function () {
      if (mQueue._flushing) return mQueue._flushing;
      mQueue._flushing = mQueue.all().then(function (rows) {
        return rows.reduce(function (p, op) {
          return p.then(function (stop) {
            if (stop) return true;
            return sendOne(op);
          });
        }, Promise.resolve(false));
      }).finally(function () { mQueue._flushing = null; });
      return mQueue._flushing;
    },

    onChange: function (cb) { listeners.push(cb); return function () { listeners = listeners.filter(function (x) { return x !== cb; }); }; },
  };

  /** @returns true if we should stop the flush (still offline). */
  function sendOne(op) {
    if (!mine(op)) return Promise.resolve(false); // someone else's — wait for them
    return API.post(op.path, op.body, { idempotencyKey: op.key, expectedUserId: op.user_id, expectedServer: op.server })
      .then(function () { return mQueue._remove(op.key).then(function () { return false; }); })
      .catch(function (err) {
        if (err && err.offline) return true; // still no connection — stop, keep the queue
        op.attempts = (op.attempts || 0) + 1;
        op.error = err && err.message ? err.message : 'Failed';
        return mQueue._put(op).then(function () { return false; }); // move on to the next op
      });
  }

  /** Submit a write, falling back to the offline queue on a network failure. */
  function mSubmit(path, body, opts) {
    opts = opts || {};
    var key = 'idem-' + uuid();
    return API.post(path, body, { idempotencyKey: key })
      .then(function (response) { return { ok: true, response: response, local: API.syncLocal(response) }; })
      .catch(function (err) {
        if (err && err.offline) {
          return mQueue.enqueue({ key: key, method: 'POST', path: path, body: body, label: opts.label || path })
            .then(function () { return { queued: true }; });
        }
        throw err;
      });
  }

  // Auto-flush: on reconnect, on a slow timer while online, and once now.
  // Background flushes: never let a storage failure (no IndexedDB, blocked site data) surface
  // as an unhandled rejection — the queue screen reports problems when it's opened.
  function autoFlush() { mQueue.flush().catch(function () {}); }
  window.addEventListener('online', autoFlush);
  setInterval(function () { if (navigator.onLine) autoFlush(); }, 25000);
  if (navigator.onLine) setTimeout(autoFlush, 1500);

  // The service worker tells us when it drained the queue in the background.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', function (ev) {
      if (ev.data === 'queue-changed') emit();
    });
  }

  window.mQueue = mQueue;
  window.mSubmit = mSubmit;

  // Served by an installed site PC: an action it saved but the cloud hasn't confirmed is not final
  // (docs/OFFLINE-FIRST.md §2.4). Role result screens follow it (RoleUI.syncWatch); everywhere
  // else this toast says so.
  window.addEventListener('vds:sync-local', function () {
    if (window.mToast) mToast('Saved on the site PC — not final until it syncs with the cloud.');
  });
})();
