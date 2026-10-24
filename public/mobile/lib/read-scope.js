/* Bounded reads owned by a visible mobile view and one sign-in. No writes or cache. */
(function () {
  var scopes = new Set();
  function identity() {
    var me = MApp.getMe?.() || {};
    return JSON.stringify([API.base?.(), API.getToken?.(), API.isSharedSession?.(),
      me.id, me.role, me.department_id, me.employee?.id, me.permissions, me.modules, me.can_approve]);
  }
  function cancelled() { return Object.assign(new Error('Screen read cancelled.'), {cancelled:true}); }
  function create(root, onRelease) {
    var owner = identity(), hash = location.hash, released = false, jobs = new Set(), timers = new Set();
    function release() {
      if (released) return; released = true; scopes.delete(scope); observer.disconnect();
      jobs.forEach(function(job) { job.controller.abort(); }); jobs.clear();
      timers.forEach(clearTimeout); timers.clear();
      if (root.isConnected) root.textContent = '';
      onRelease?.();
    }
    function current() {
      if (!released && root.isConnected && !root.closest('.hidden,[hidden]') && hash === location.hash && owner === identity()) return true;
      release(); return false;
    }
    function run(invoke, timeout) {
      if (!current()) return Promise.reject(cancelled());
      var job = {controller:new AbortController()}, timer;
      jobs.add(job);
      var opts = {signal:job.controller.signal,isCurrent:function() { return !job.controller.signal.aborted && current(); }};
      return new Promise(function(resolve,reject) {
        job.controller.signal.addEventListener('abort',function() { reject(job.timedOut ? new Error('The check timed out. Reconnect and retry.') : cancelled()); },{once:true});
        timer = setTimeout(function() { job.timedOut = true; job.controller.abort(); },timeout || 12000);
        Promise.resolve().then(function() { if (!opts.isCurrent()) throw cancelled(); return invoke(opts); }).then(function(result) {
          if (!opts.isCurrent()) throw cancelled(); resolve(result);
        }).catch(reject);
      }).finally(function() { clearTimeout(timer); jobs.delete(job); });
    }
    function later(fn, ms) {
      var timer = setTimeout(function() { timers.delete(timer); if (current()) fn(); },ms); timers.add(timer); return timer;
    }
    function cancelTimer(timer) { clearTimeout(timer); timers.delete(timer); }
    var observer = new MutationObserver(function() { current(); });
    var scope = {current:current,run:run,release:release,later:later,cancelTimer:cancelTimer};
    observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['class','hidden']});
    scopes.add(scope); return scope;
  }
  ['hashchange','storage','pagehide'].forEach(function(name) { window.addEventListener(name,function() {
    Array.from(scopes).forEach(function(scope) { if (name === 'pagehide') scope.release(); else scope.current(); });
  }); });
  window.addEventListener('pageshow',function(e) { if (e.persisted) MApp.render?.(); });
  window.mReadScope = {create:create,identity:identity};
})();
