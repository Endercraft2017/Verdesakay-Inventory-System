/* Durable, account-owned phone writes. Page and service worker share atomic leases
   (queue-store.js); uncertain retries retain their original request key and body. */
(function () {
  var store, owner = null, sessionWrite = Promise.resolve(), jobs = new Map(), listeners = [], channel;
  function storage() { return store || (store = MobileQueueStore.create(window.VDS_BASE_PATH || '')); }
  function uuid() { return crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2); }
  function emit() { listeners.slice().forEach(function (cb) { try { cb(); } catch (ignore) {} }); }
  function changed() { emit(); channel?.postMessage('changed'); }
  try { if (window.BroadcastChannel) { channel = new BroadcastChannel('vds-queue' + (window.VDS_BASE_PATH || '')); channel.onmessage = emit; } } catch (ignore) {}
  function current(who) { return !!who && owner === who && (!API.getToken || API.getToken() === who.apiToken) && (!API.base || API.base() === who.api_base); }
  function cancellation() { return Object.assign(new Error('The sign-in changed. Reopen Pending sync.'), {cancelled:true}); }
  function changeOwner(next) {
    if (owner && next && owner.v === next.v && owner.user_id === next.user_id && owner.api_base === next.api_base) return owner;
    owner = next; jobs.forEach(function (job) { job.abort?.(); }); changed(); return next;
  }
  function ownedJob(key, who, run) {
    var existing = jobs.get(key);
    if (existing && existing.owner === who) return existing.promise;
    var job = {owner:who};
    job.promise = Promise.resolve().then(function () { if (!current(who)) throw cancellation(); return run(job); }).finally(function () { if (jobs.get(key) === job) jobs.delete(key); });
    jobs.set(key,job); return job.promise;
  }
  function bounded(job, who, invoke) {
    var controller = new AbortController(), timer, timedOut = false;
    job.abort = function () { controller.abort(); };
    var opts = {signal:controller.signal,isCurrent:function () { return current(who) && !controller.signal.aborted; }};
    return new Promise(function (resolve,reject) {
      controller.signal.addEventListener('abort',function () { reject(timedOut ? Object.assign(new Error('The server result was not confirmed. Retry the same saved request.'),{uncertain:true}) : cancellation()); },{once:true});
      timer = setTimeout(function () { timedOut = true; controller.abort(); },15000);
      Promise.resolve().then(function () { if (!opts.isCurrent()) throw cancellation(); return invoke(opts); }).then(resolve,reject);
    }).finally(function () { clearTimeout(timer); delete job.abort; });
  }
  function backgroundSync() {
    if (!('serviceWorker' in navigator) || !('SyncManager' in window)) return;
    navigator.serviceWorker.ready.then(function (reg) { return reg.sync?.register('vds-flush'); }).catch(function () {});
  }
  function send(key, force, who) {
    return ownedJob(key,who,function (job) {
      var lease = uuid(), claimed;
      return sessionWrite.then(function () {
        if (!current(who)) throw cancellation();
        return storage().claim(key,who,lease,force);
      }).then(function (op) {
        if (!op) return false;
        claimed = op; changed();
        return bounded(job,who,function (opts) { opts.idempotencyKey = op.key; return API.post(op.path,op.body,opts); }).then(function (result) {
          var local = API.syncLocal?.(result);
          return storage().settle(key,lease,local ? {local_command:local,local_state:'local',uncertain:false,error:null}
            : result?.applied === false ? {error:result.message || 'The server did not apply this action. Review the existing record.',uncertain:false} : null,{state:result?.applied===false?'rejected':local?'local':'confirmed',response:result,local:local||null}).then(function () { changed(); return false; });
        }).catch(function (error) {
          var uncertain = !!(error.offline || error.uncertain || error.cancelled || !error.status || error.status >= 500 || error.status === 429);
          return storage().settle(key,lease,{error:uncertain ? null : error.message || 'The server rejected this action.',uncertain:uncertain,attempts:(op.attempts || 0)+1,last_error:error.message || 'Result not confirmed'}).then(function () { changed(); return uncertain; });
        });
      }).catch(function (error) {
        // A storage failure must reach the screen; it must not manufacture success.
        if (claimed) changed(); throw error;
      });
    });
  }
  var mQueue = {
    setToken:function (token,user) {
      var who = changeOwner({v:token,user_id:user?.id ?? null,api_base:API.base?.() || '',apiToken:API.getToken?.(),device_id:API.deviceId?.()});
      sessionWrite = sessionWrite.catch(function () {}).then(function () {
        if (!current(who)) return;
        return storage().request('meta','readwrite',function (s) { s.put({k:'token',v:who.v,user_id:who.user_id,api_base:who.api_base,device_id:who.device_id}); });
      });
      return sessionWrite.then(function () { if (current(who) && navigator.onLine) autoFlush(); }).catch(function () { emit(); });
    },
    clearToken:function () {
      changeOwner(null);
      sessionWrite = sessionWrite.catch(function () {}).then(function () {
        if (!owner) return storage().request('meta','readwrite',function (s) { s.delete('token'); });
      });
      return sessionWrite.catch(function () { emit(); });
    },
    enqueue:function (op) {
      var who = owner;
      if (!current(who) || who.user_id == null) return Promise.reject(cancellation());
      op = Object.assign({},op,{created:op.created || Date.now(),attempts:0,user_id:who.user_id,server_base:who.api_base});
      return storage().request('ops','readwrite',function (s) { if (!current(who)) throw cancellation(); s.put(op); }).then(function () { changed(); backgroundSync(); return op.key; });
    },
    _every:function () { return storage().all(); },
    _remove:function (key) { return storage().request('ops','readwrite',function (s) { s.delete(key); }).then(changed); },
    _put:function (op) { return storage().request('ops','readwrite',function (s) { s.put(op); }).then(changed); },
    receipt:function (key) { var who=owner; return storage().request('meta','readonly',function(s) { return s.get('receipt:'+key); }).then(function(row) { if (!current(who)) throw cancellation(); return row&&storage().owns(row,who)?row:null; }); },
    forgetReceipt:function (key) { var who=owner; return mQueue.receipt(key).then(function(row) { if (row&&current(who)) return storage().request('meta','readwrite',function(s) { return s.delete('receipt:'+key); }); }); },
    snapshot:function () {
      var who = owner;
      return storage().all().then(function (rows) {
        if (!current(who)) throw cancellation();
        return {ops:rows.filter(function (row) { return storage().owns(row,who); }),foreign:rows.filter(function (row) { return !storage().owns(row,who); }).length};
      });
    },
    all:function () { return mQueue.snapshot().then(function (r) { return r.ops; }); },
    count:function () { return mQueue.all().then(function (rows) { return rows.length; }); },
    // A site-PC acknowledgement is tracked, but is no longer an unsent phone write.
    unsentCount:function () { return mQueue.all().then(function (rows) { return rows.filter(function (row) { return !row.local_command; }).length; }); },
    foreignCount:function () { return mQueue.snapshot().then(function (r) { return r.foreign; }); },
    busy:function (op) { return storage().busy(op); },
    discard:function (key) {
      var who = owner;
      return ownedJob('discard:'+key,who,function () { return storage().discard(key,who,function () { return current(who); }).then(changed); });
    },
    retry:function (key) { return send(key,true,owner); },
    checkLocal:function (key) {
      var who = owner;
      return ownedJob('check:'+key,who,async function (job) {
        var op = (await mQueue.all()).find(function (row) { return row.key === key; });
        if (!op?.local_command) return;
        var result = await bounded(job,who,function (opts) { return API.get('/sync/command/'+encodeURIComponent(op.local_command),opts); });
        if (!result || typeof result.state !== 'string') throw new Error('The cloud confirmation could not be read. Try again.');
        await storage().edit(key,function (row) {
          if (!current(who) || !row || !storage().owns(row,who) || row.local_command !== op.local_command) return {};
          if (result.state === 'confirmed') return {remove:true};
          row.local_state = result.state; row.local_error = result.error || null; return {row:row};
        }); changed();
      });
    },
    flush:function (options) {
      var who = owner;
      if (!current(who)) return Promise.resolve();
      return ownedJob('flush',who,async function () {
        var rows = await mQueue.all();
        for (var row of rows) {
          if (!current(who)) return;
          if (row.local_command) { await mQueue.checkLocal(row.key).catch(function () {}); continue; }
          if (options?.automatic && row.error) continue;
          if (await send(row.key,!options?.automatic,who)) break;
        }
      });
    },
    onChange:function (cb) { listeners.push(cb); return function () { listeners = listeners.filter(function (fn) { return fn !== cb; }); }; }
  };
  function mSubmit(path,body,opts) {
    opts = opts || {};
    var key = opts.idempotencyKey || 'idem-'+uuid(), who = owner;
    var request = {idempotencyKey:key};
    if (opts.signal) request.signal = opts.signal;
    if (opts.isCurrent) request.isCurrent = opts.isCurrent;
    return API.post(path,body,request).then(function (response) { return {ok:true,response:response,local:API.syncLocal(response)}; }).catch(function (error) {
      if (error.offline && current(who) && (!opts.isCurrent || opts.isCurrent())) {
        return mQueue.enqueue({key:key,method:'POST',path:path,body:body,label:opts.label || path,keep_receipt:!!opts.keepReceipt}).then(function () { return {queued:true}; });
      }
      throw error;
    });
  }
  function autoFlush() { if (owner) mQueue.flush({automatic:true}).catch(function () {}); }
  window.addEventListener('online',autoFlush);
  setInterval(function () { if (navigator.onLine) autoFlush(); },25000);
  if (navigator.onLine) setTimeout(autoFlush,1500);
  if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message',function (e) { if (e.data === 'queue-changed') emit(); });
  window.mQueue = mQueue; window.mSubmit = mSubmit;
  window.addEventListener('vds:sync-local',function () { if (window.mToast) mToast('Saved on the site PC — not final until it syncs with the cloud.'); });
})();
