/* Offline write queue. When a POST fails because the device is offline, the
   operation is stashed in IndexedDB and replayed (with a stable Idempotency-Key,
   so the server de-dupes) when the connection returns or the app is reopened.

   mSubmit(path, body, {label}) -> Promise<{ok:true,response} | {queued:true}>
   mQueue.count() / .all() / .retry(key) / .discard(key) / .flush() / .onChange(cb)
*/
(function () {
  var DB_NAME = 'vds_mobile';
  var STORE = 'ops';
  var dbP = null;

  function db() {
    if (dbP) return dbP;
    dbP = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'key' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbP;
  }

  function tx(mode, fn) {
    return db().then(function (d) {
      return new Promise(function (resolve, reject) {
        var t = d.transaction(STORE, mode);
        var store = t.objectStore(STORE);
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

  var mQueue = {
    enqueue: function (op) {
      op.created = op.created || Date.now();
      op.attempts = 0;
      return tx('readwrite', function (s) { s.put(op); }).then(function () { emit(); return op.key; });
    },
    all: function () {
      return tx('readonly', function (s) { return s.getAll(); }).then(function (rows) {
        return (rows || []).sort(function (a, b) { return a.created - b.created; });
      });
    },
    count: function () { return tx('readonly', function (s) { return s.count(); }); },
    _remove: function (key) { return tx('readwrite', function (s) { s.delete(key); }).then(emit); },
    _put: function (op) { return tx('readwrite', function (s) { s.put(op); }).then(emit); },

    discard: function (key) { return mQueue._remove(key); },

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
    return API.post(op.path, op.body, { idempotencyKey: op.key })
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
      .then(function (response) { return { ok: true, response: response }; })
      .catch(function (err) {
        if (err && err.offline) {
          return mQueue.enqueue({ key: key, method: 'POST', path: path, body: body, label: opts.label || path })
            .then(function () { return { queued: true }; });
        }
        throw err;
      });
  }

  // Auto-flush: on reconnect, on a slow timer while online, and once now.
  window.addEventListener('online', function () { mQueue.flush(); });
  setInterval(function () { if (navigator.onLine) mQueue.flush(); }, 25000);
  if (navigator.onLine) setTimeout(function () { mQueue.flush(); }, 1500);

  window.mQueue = mQueue;
  window.mSubmit = mSubmit;
})();
