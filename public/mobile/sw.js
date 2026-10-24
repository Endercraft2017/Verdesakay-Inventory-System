/* Service worker for the /m warehouse app.
   - Precaches the app shell so /m opens with no connection.
   - /api/* is always network-only (never serve stale inventory data).
   - Background Sync ('vds-flush') replays the offline write queue when the
     device reconnects, even if no tab is open (Android; iOS flushes on open).

   Bump CACHE_VERSION whenever the shell file list or any cached asset changes. */
var TENANT_BASE = typeof TENANT_BASE === 'string' ? TENANT_BASE : '';
importScripts(TENANT_BASE + '/mobile/lib/queue-store.js');
var queueStore = MobileQueueStore.create(TENANT_BASE);
var CACHE_PREFIX = 'vds-m:' + (TENANT_BASE || '/') + ':';
var CACHE_VERSION = CACHE_PREFIX + 'v155';

// Keep in sync with the <script>/<link> list in public/mobile/index.html.
var SHELL = [
  '/js/tenant-context.js',
  '/js/lib/slow-loading.js',
  '/m',
  '/mobile/index.html',
  '/mobile/manifest.webmanifest',
  '/mobile/icons/icon-192.png',
  '/mobile/icons/icon-512.png',
  '/mobile/mobile.css',
  '/mobile/mobile-v2.css',
  '/mobile/stock.css',
  '/mobile/stock-actions.css',
  '/mobile/counts.css',
  '/css/photo-viewer.css',
  '/css/select-controls.css',
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
  '/js/lib/form-validation.js',
  '/js/leave-dates.js',
  '/js/lib/image-compress.js',
  '/js/lib/photo-viewer.js',
  '/js/lib/pdf-pages.js', // pdf.js itself (/js/vendor/pdfjs) loads on first PDF pick, not precached
  '/mobile/vendor/qrcode.js',
  '/mobile/vendor/zxing.js',
  '/js/auth-controls.js',
  '/mobile/app.js',
  '/mobile/lib/dom.js',
  '/mobile/lib/read-scope.js',
  '/mobile/lib/stock-ui.js',
  '/mobile/lib/personal.js',
  '/js/personal-ux.js',
  '/mobile/lib/guides.js',
  '/js/guide-data.js',
  '/js/guide-search.js',
  '/css/guide-search.css',
  '/js/guide-tour.js',
  '/mobile/lib/quick-orbit.js',
  '/mobile/lib/role-ui.js',
  '/mobile/lib/locations.js',
  '/mobile/lib/users.js',
  '/mobile/lib/stats.js',
  '/mobile/lib/recent.js',
  '/mobile/lib/photo.js',
  '/mobile/lib/signature.js',
  '/mobile/lib/queue-store.js',
  '/mobile/lib/queue.js',
  '/mobile/lib/production-drafts.js',
  '/mobile/lib/workflow-attempt.js',
  '/mobile/lib/stock-action-ui.js',
  '/mobile/lib/stock-action-form.js',
  '/mobile/lib/stock-action-result.js',
  '/mobile/lib/count-ui.js',
  '/mobile/lib/count-form.js',
  '/mobile/lib/count-detail.js',
  '/mobile/lib/count-result.js',
  '/mobile/lib/push.js',
  '/mobile/lib/scanner.js',
  '/mobile/lib/selfie.js',
  '/mobile/lib/item-picker.js',
  '/mobile/lib/sale-ui.js',
  '/mobile/modules/core/home.js',
  '/mobile/modules/hr/work.js',
  '/mobile/modules/purchasing/requests.js',
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
  '/mobile/modules/inventory/stock-counts.js',
  '/mobile/modules/inventory/stock-count-tasks.js',
  '/mobile/modules/inventory/orders-fulfil.js',
  '/mobile/modules/inventory/sales.js',
  '/mobile/modules/inventory/batch-move.js',
  '/mobile/modules/manufacturing/job-orders.js',
  '/mobile/modules/manufacturing/kit-release.js',
  '/mobile/modules/manufacturing/unit-issues.js',
  '/mobile/modules/manufacturing/qc.js',
  '/mobile/modules/manufacturing/repairs.js',
  '/mobile/modules/manufacturing/record.js',
  '/mobile/modules/manufacturing/rts-recovery.js',
  '/mobile/modules/manufacturing/receiving.js',
  '/mobile/modules/inventory/allocate.js',
  '/mobile/modules/inventory/release-actions.js',
  '/mobile/modules/inventory/release-handoff.js',
  '/mobile/modules/inventory/so.js',
  '/mobile/modules/sales/sales.js',
  '/mobile/modules/inventory/delivery-recovery.js',
  '/mobile/modules/inventory/deliveries.js',
  '/mobile/modules/inventory/returns.js',
  '/mobile/modules/manufacturing/semi-finishing.js',

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
  if(/^#\/(?:so|qc|repairs|kit-release|purchase-requests|deliveries)(?:\?|$)/.test(hash))hash='#/work?notice='+encodeURIComponent(hash);
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

// The shared protocol also guards page/worker races and crash recovery.
var queueReplay;
function replayQueue() {
  if (queueReplay) return queueReplay;
  queueReplay = drainQueue().finally(function () { queueReplay = null; });
  return queueReplay;
}
async function queueChanged() {
  var clients = await self.clients.matchAll();
  clients.forEach(function (client) { client.postMessage('queue-changed'); });
}
async function queueFetch(owner, path, init) {
  var controller = new AbortController(), timeout = setTimeout(function () { controller.abort(); },15000);
  try {
    var response = await fetch((owner.api_base || TENANT_BASE) + '/api' + path,Object.assign({},init,{signal:controller.signal}));
    var body = await response.json().catch(function (error) { if (controller.signal.aborted) throw error; return null; });
    return {response:response,body:body};
  }
  finally { clearTimeout(timeout); }
}
async function drainQueue() {
  var owner = await queueStore.token();
  if (!owner?.v || owner.user_id == null) return;
  owner.api_base = owner.api_base || '';
  var rows = await queueStore.all(), pending = false;
  var headers = {'Content-Type':'application/json',Authorization:'Bearer '+owner.v,'X-Client':'mobile'};
  if (owner.device_id) headers['X-Device-Id'] = owner.device_id;
  for (var candidate of rows) {
    if (!queueStore.owns(candidate,owner)) continue;
    var token = await queueStore.token();
    if (!token || token.v !== owner.v || token.user_id !== owner.user_id || (token.api_base || '') !== owner.api_base) break;
    if (candidate.local_command) {
      // A local acknowledgement is never posted again as a fresh operation.
      try {
        var checked = await queueFetch(owner,'/sync/command/'+encodeURIComponent(candidate.local_command),{headers:headers}), check = checked.response;
        if (!check.ok) { pending = true; continue; }
        var status = checked.body;
        if (!status || typeof status.state !== 'string') { pending = true; continue; }
        await queueStore.edit(candidate.key,function (row) {
          if (!row || row.local_command !== candidate.local_command) return {};
          if (status.state === 'confirmed') return {remove:true};
          row.local_state = status.state || row.local_state; row.local_error = status.error || null;
          return {row:row};
        });
        if (!['confirmed','rejected','conflict','failed'].includes(status.state)) pending = true;
      } catch (error) { pending = true; }
      continue;
    }
    var lease = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36)+Math.random().toString(36).slice(2);
    var op = await queueStore.claim(candidate.key,owner,lease,false);
    if (!op) {
      // Do not consume the background-sync tag while another sender might close.
      var remaining = await queueStore.request('ops','readonly',function (store) { return store.get(candidate.key); });
      if (remaining && queueStore.owns(remaining,owner) && !remaining.error && !remaining.local_command) pending = true;
      continue;
    }
    await queueChanged();
    try {
      var sent = await queueFetch(owner,op.path,{
        method:op.method || 'POST',headers:Object.assign({'Idempotency-Key':op.key},headers),body:JSON.stringify(op.body)
      });
      var response = sent.response, body = sent.body;
      if (response.ok) {
        var local = response.headers.get('X-Sync-State') === 'local' && (response.headers.get('X-Sync-Command') || 'local');
        await queueStore.settle(op.key,lease,local ? {local_command:local,local_state:'local',error:null,uncertain:false}
          : body?.applied === false ? {error:body.message || 'The server did not apply this action. Review the existing record.',uncertain:false} : null,{state:body?.applied===false?'rejected':local?'local':'confirmed',response:body,local:local||null});
        if (local) pending = true;
      } else {
        var retryable = response.status >= 500 || [401,403,429].includes(response.status);
        await queueStore.settle(op.key,lease,{error:retryable ? null : body?.error || 'Rejected ('+response.status+')',uncertain:retryable,attempts:(op.attempts || 0)+1});
        if (retryable) { pending = true; break; }
      }
    } catch (error) {
      await queueStore.settle(op.key,lease,{error:null,uncertain:true,attempts:(op.attempts || 0)+1});
      pending = true; break;
    } finally { await queueChanged(); }
  }
  await queueChanged();
  if (pending) throw new Error('retry');
}
