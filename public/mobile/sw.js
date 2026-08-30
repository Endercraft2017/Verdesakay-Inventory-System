/* Service worker for the /m warehouse app.
   - Precaches the app shell so /m opens with no connection.
   - /api/* is always network-only (never serve stale inventory data).
   - Background Sync ('vds-flush') replays the offline write queue when the
     device reconnects, even if no tab is open (Android; iOS flushes on open).

   Bump CACHE_VERSION whenever the shell file list or any cached asset changes. */
var CACHE_VERSION = 'vds-m-v14';

// Keep in sync with the <script>/<link> list in public/mobile/index.html.
var SHELL = [
  '/m',
  '/mobile/index.html',
  '/mobile/manifest.webmanifest',
  '/mobile/icons/icon-192.png',
  '/mobile/icons/icon-512.png',
  '/mobile/mobile.css',
  '/js/api.js',
  '/mobile/vendor/qrcode.js',
  '/mobile/vendor/zxing.js',
  '/mobile/app.js',
  '/mobile/lib/dom.js',
  '/mobile/lib/locations.js',
  '/mobile/lib/users.js',
  '/mobile/lib/stats.js',
  '/mobile/lib/recent.js',
  '/mobile/lib/photo.js',
  '/mobile/lib/signature.js',
  '/mobile/lib/queue.js',
  '/mobile/lib/push.js',
  '/mobile/lib/scanner.js',
  '/mobile/lib/item-picker.js',
  '/mobile/views/home.js',
  '/mobile/views/work.js',
  '/mobile/views/stock-move.js',
  '/mobile/views/damage.js',
  '/mobile/views/transfer.js',
  '/mobile/views/new-item.js',
  '/mobile/views/assign-qr.js',
  '/mobile/views/scan.js',
  '/mobile/views/item-detail.js',
  '/mobile/views/low-stock.js',
  '/mobile/views/location-view.js',
  '/mobile/views/my-log.js',
  '/mobile/views/cycle-count.js',
  '/mobile/views/orders-fulfil.js',
  '/mobile/views/batch-move.js',
  '/mobile/views/job-orders.js',
  '/mobile/views/qc.js',
  '/mobile/views/allocate.js',
  '/mobile/views/deliveries.js',
  '/mobile/views/report-problem.js',
  '/mobile/views/settings.js',
  '/mobile/views/queue-view.js',
  '/mobile/views/clock.js',
  '/mobile/views/inbox.js',
  '/mobile/views/directory.js',
  '/mobile/views/payslips.js',
  '/mobile/views/schedule.js',
  '/mobile/views/requests.js',
  '/mobile/views/tasks.js',
  '/mobile/views/announcements.js',
  '/mobile/views/time-fix.js',
  '/mobile/views/approvals.js',
];

function precache() {
  return caches.open(CACHE_VERSION).then(function (c) {
    // Cache each asset independently — one bad/renamed file shouldn't fail the batch.
    return Promise.all(SHELL.map(function (u) {
      return c.add(new Request(u, { cache: 'reload' })).catch(function () { /* skip */ });
    }));
  });
}

self.addEventListener('install', function (e) {
  // Never let a caching hiccup make the worker `redundant` — install regardless, so
  // the fetch handler (network + navigation fallback) is at least in play.
  e.waitUntil(precache().catch(function () {}).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.filter(function (k) { return k !== CACHE_VERSION; })
          .map(function (k) { return caches.delete(k); }));
      })
      .catch(function () { /* CacheStorage unavailable — still take control */ })
      .then(function () { return self.clients.claim(); })
  );
});

function safeMatch(req) {
  return caches.match(req).catch(function () { return undefined; });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  var url = new URL(req.url);

  if (req.method !== 'GET') return; // writes go straight to the network / the app's queue

  // API: always live, never cached.
  if (url.origin === self.location.origin && url.pathname.indexOf('/api/') === 0) {
    return; // default network handling
  }

  // Navigations to the app: network, falling back to the cached shell offline.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).catch(function () {
        return safeMatch('/mobile/index.html').then(function (r) { return r || safeMatch('/m'); });
      })
    );
    return;
  }

  // Static assets: cache-first, then network (and cache what we fetch).
  if (url.origin === self.location.origin) {
    e.respondWith(
      safeMatch(req).then(function (hit) {
        if (hit) return hit;
        return fetch(req).then(function (res) {
          if (res && res.ok && res.type === 'basic') {
            var copy = res.clone();
            caches.open(CACHE_VERSION).then(function (c) { c.put(req, copy); }).catch(function () {});
          }
          return res;
        });
      })
    );
  }
});

/* ---------- Push notifications ---------- */
self.addEventListener('push', function (e) {
  var data = {};
  try { data = e.data ? e.data.json() : {}; } catch (err) { data = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(data.title || 'Verdesakay Warehouse', {
    body: data.body || '',
    tag: data.tag || 'vds',
    renotify: true,
    data: { url: data.url || '#/home' },
    icon: '/mobile/icons/icon-192.png',
    badge: '/mobile/icons/icon-192.png',
  }));
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var hash = (e.notification.data && e.notification.data.url) || '#/home';
  var target = new URL('/m' + hash, self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (c.url.indexOf('/m') !== -1) {
        if ('navigate' in c) { try { c.navigate(target); } catch (err) { /* ignore */ } }
        return c.focus();
      }
    }
    return self.clients.openWindow(target);
  }));
});

/* ---------- Background Sync: replay the offline queue ---------- */
self.addEventListener('sync', function (e) {
  if (e.tag === 'vds-flush') e.waitUntil(replayQueue());
});
self.addEventListener('message', function (e) {
  if (e.data === 'flush') e.waitUntil(replayQueue());
});

function idb() {
  return new Promise(function (resolve, reject) {
    var r = indexedDB.open('vds_mobile', 2);
    r.onsuccess = function () { resolve(r.result); };
    r.onerror = function () { reject(r.error); };
  });
}
function idbAll(db, store) {
  return new Promise(function (resolve, reject) {
    var req = db.transaction(store, 'readonly').objectStore(store).getAll();
    req.onsuccess = function () { resolve(req.result || []); };
    req.onerror = function () { reject(req.error); };
  });
}
function idbGet(db, store, key) {
  return new Promise(function (resolve) {
    try {
      var req = db.transaction(store, 'readonly').objectStore(store).get(key);
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { resolve(undefined); };
    } catch (err) { resolve(undefined); }
  });
}
function idbDel(db, store, key) {
  return new Promise(function (resolve) {
    var t = db.transaction(store, 'readwrite');
    t.objectStore(store).delete(key);
    t.oncomplete = resolve; t.onerror = resolve;
  });
}
function idbPut(db, store, val) {
  return new Promise(function (resolve) {
    var t = db.transaction(store, 'readwrite');
    t.objectStore(store).put(val);
    t.oncomplete = resolve; t.onerror = resolve;
  });
}

async function replayQueue() {
  var db;
  try { db = await idb(); } catch (e) { return; }
  var ops = await idbAll(db, 'ops');
  var tokenRow = await idbGet(db, 'meta', 'token');
  var token = tokenRow && tokenRow.v;
  var stillPending = false;

  for (var i = 0; i < ops.length; i++) {
    var op = ops[i];
    if (op.error) continue; // needs the user's attention — leave it
    try {
      var res = await fetch('/api' + op.path, {
        method: op.method || 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': op.key,
          Authorization: token ? 'Bearer ' + token : '',
        },
        body: JSON.stringify(op.body),
      });
      if (res.ok) {
        await idbDel(db, 'ops', op.key);
      } else if (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 429) {
        var body = await res.json().catch(function () { return {}; });
        op.error = (body && body.error) || ('Rejected (' + res.status + ')');
        await idbPut(db, 'ops', op);
      } else {
        stillPending = true; // 5xx / auth / rate-limit — try again on the next sync
      }
    } catch (err) {
      stillPending = true; // offline again
    }
  }

  var clients = await self.clients.matchAll();
  clients.forEach(function (c) { c.postMessage('queue-changed'); });

  if (stillPending) throw new Error('retry'); // ask the browser to fire the sync again later
}
