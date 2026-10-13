/* Service worker for the /m warehouse app.
   - Precaches the app shell so /m opens with no connection.
   - /api/* is always network-only (never serve stale inventory data).
   - Background Sync ('vds-flush') replays the offline write queue when the
     device reconnects, even if no tab is open (Android; iOS flushes on open).

   Bump CACHE_VERSION whenever the shell file list or any cached asset changes. */
var TENANT_BASE = typeof TENANT_BASE === 'string' ? TENANT_BASE : '';
var CACHE_PREFIX = 'vds-m:' + (TENANT_BASE || '/') + ':';
var CACHE_VERSION = CACHE_PREFIX + 'v81';

// Keep in sync with the <script>/<link> list in public/mobile/index.html.
var SHELL = [
  '/js/tenant-context.js',
  '/m',
  '/mobile/index.html',
  '/mobile/manifest.webmanifest',
  '/mobile/icons/icon-192.png',
  '/mobile/icons/icon-512.png',
  '/mobile/mobile.css',
  '/mobile/mobile-v2.css',
  '/css/photo-viewer.css',
  '/mobile/guides.css',
  '/mobile/role-kit.css',
  '/mobile/icons/v2/role-warehouse.svg',
  '/mobile/icons/v2/check-ok.svg',
  '/mobile/icons/v2/release-box.svg',
  '/mobile/icons/v2/open-chevron.svg',
  '/mobile/icons/v2/alert.svg',
  '/mobile/icons/v2/short.svg',
  '/mobile/icons/v2/role-production-lead.svg',
  '/mobile/icons/v2/role-production-manager.svg',
  '/mobile/icons/v2/act-resume.svg',
  '/mobile/icons/v2/act-pause.svg',
  '/mobile/icons/v2/act-close.svg',
  '/mobile/icons/v2/act-history.svg',
  '/mobile/icons/v2/scan.svg',
  '/mobile/icons/v2/camera.svg',
  '/mobile/icons/v2/check-done.svg',
  '/js/api.js',
  '/js/doc-pagination.js',
  '/js/leave-dates.js',
  '/js/lib/image-compress.js',
  '/js/lib/photo-viewer.js',
  '/js/lib/pdf-pages.js', // pdf.js itself (/js/vendor/pdfjs) loads on first PDF pick, not precached
  '/mobile/vendor/qrcode.js',
  '/mobile/vendor/zxing.js',
  '/mobile/app.js',
  '/mobile/lib/dom.js',
  '/mobile/lib/personal.js',
  '/js/personal-ux.js',
  '/mobile/lib/guides.js',
  '/js/guide-data.js',
  '/js/guide-tour.js',
  '/mobile/lib/quick-orbit.js',
  '/mobile/lib/role-ui.js',
  '/mobile/lib/locations.js',
  '/mobile/lib/users.js',
  '/mobile/lib/stats.js',
  '/mobile/lib/recent.js',
  '/mobile/lib/photo.js',
  '/mobile/lib/signature.js',
  '/mobile/lib/queue.js',
  '/mobile/lib/push.js',
  '/mobile/lib/scanner.js',
  '/mobile/lib/selfie.js',
  '/mobile/lib/item-picker.js',
  '/mobile/modules/core/home.js',
  '/mobile/modules/hr/work.js',
  '/mobile/modules/manufacturing/production.js',
  '/mobile/modules/inventory/stock-move.js',
  '/mobile/modules/inventory/damage.js',
  '/mobile/modules/inventory/transfer.js',
  '/mobile/modules/inventory/new-item.js',
  '/mobile/modules/manufacturing/assign-qr.js',
  '/mobile/modules/inventory/scan.js',
  '/mobile/modules/inventory/item-detail.js',
  '/mobile/modules/inventory/low-stock.js',
  '/mobile/modules/inventory/location-view.js',
  '/mobile/modules/hr/my-log.js',
  '/mobile/modules/inventory/cycle-count.js',
  '/mobile/modules/inventory/orders-fulfil.js',
  '/mobile/modules/inventory/batch-move.js',
  '/mobile/modules/manufacturing/job-orders.js',
  '/mobile/modules/manufacturing/kit-release.js',
  '/mobile/modules/manufacturing/qc.js',
  '/mobile/modules/manufacturing/repairs.js',
  '/mobile/modules/manufacturing/record.js',
  '/mobile/modules/manufacturing/receiving.js',
  '/mobile/modules/inventory/allocate.js',
  '/mobile/modules/inventory/so.js',
  '/mobile/modules/inventory/deliveries.js',
  '/mobile/modules/core/report-problem.js',
  '/mobile/modules/core/settings.js',
  '/mobile/modules/inventory/queue-view.js',
  '/mobile/modules/hr/clock.js',
  '/mobile/modules/core/inbox.js',
  '/mobile/modules/core/notifications.js',
  '/mobile/modules/core/confidential-reports.js',
  '/mobile/modules/hr/directory.js',
  '/mobile/modules/hr/payslips.js',
  '/mobile/modules/hr/schedule.js',
  '/mobile/modules/hr/requests.js',
  '/mobile/modules/core/tasks.js',
  '/mobile/modules/core/notes.js',
  '/mobile/modules/core/guides.js',
  '/mobile/modules/core/announcements.js',
  '/mobile/modules/hr/time-fix.js',
  '/mobile/modules/hr/approvals.js',
];

function precache() {
  return caches.open(CACHE_VERSION).then(function (c) {
    // Cache each asset independently — one bad/renamed file shouldn't fail the batch.
    return Promise.all(SHELL.map(function (u) {
      return c.add(new Request(TENANT_BASE + u, { cache: 'reload' })).catch(function () { /* skip */ });
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
        return Promise.all(keys.filter(function (k) {
          return k !== CACHE_VERSION && (k.indexOf(CACHE_PREFIX) === 0 || (!TENANT_BASE && /^vds-m-v\d+$/.test(k)));
        })
          .map(function (k) { return caches.delete(k); }));
      })
      .catch(function () { /* CacheStorage unavailable — still take control */ })
      .then(function () { return self.clients.claim(); })
  );
});

function safeMatch(req) {
  return caches.open(CACHE_VERSION).then(function (c) { return c.match(req); }).catch(function () { return undefined; });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  var url = new URL(req.url);

  if (req.method !== 'GET') return; // writes go straight to the network / the app's queue

  // API: always live, never cached.
  if (url.origin === self.location.origin && /(?:^|\/)api(?:\/|$)/.test(url.pathname)) {
    return; // default network handling
  }

  // Navigations to the app: network, falling back to the cached shell offline.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).catch(function () {
        return safeMatch(TENANT_BASE + '/mobile/index.html').then(function (r) { return r || safeMatch(TENANT_BASE + '/m'); });
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
  e.waitUntil(self.registration.showNotification(data.title || 'Otom Warehouse', {
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
  var target = new URL(TENANT_BASE + '/m' + hash, self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (new URL(c.url).pathname === TENANT_BASE + '/m' || new URL(c.url).pathname.indexOf(TENANT_BASE + '/m/') === 0) {
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
    var r = indexedDB.open('vds_mobile' + TENANT_BASE, 2);
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
  var tokenUser = tokenRow ? tokenRow.user_id : null;
  var stillPending = false;
  if (!token) return; // signed out — nothing replays until someone signs in (queue.js)

  var headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
  if (tokenRow.device_id) headers['X-Device-Id'] = tokenRow.device_id;

  for (var i = 0; i < ops.length; i++) {
    var op = ops[i];
    if (op.error) continue; // needs the user's attention — leave it
    // Only ever replay an op as the account that queued it (legacy unstamped ops excepted).
    if (op.user_id != null && op.user_id !== tokenUser) continue;
    try {
      var res = await fetch(TENANT_BASE + '/api' + op.path, {
        method: op.method || 'POST',
        headers: Object.assign({ 'Idempotency-Key': op.key }, headers),
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
