/* Staff directory: fetch once, cache. `supervisors()` returns admin / admin_staff
   accounts first (used by the report-a-problem recipient picker). */
(function () {
  var cache = null;
  var SUPER_ROLES = ['admin', 'admin_staff'];

  function load(force) {
    if (force === true) cache = null;
    if (cache) return Promise.resolve(cache);
    return API.get('/users').then(function (rows) {
      cache = (rows || []).filter(function (u) { return u.id !== (MApp.getMe() || {}).id; });
      return cache;
    });
  }

  function ranked() {
    var list = (cache || []).slice();
    list.sort(function (a, b) {
      var as = SUPER_ROLES.indexOf(a.role) === -1 ? 1 : 0;
      var bs = SUPER_ROLES.indexOf(b.role) === -1 ? 1 : 0;
      if (as !== bs) return as - bs;
      return (a.full_name || '').localeCompare(b.full_name || '');
    });
    return list;
  }

  window.mUsers = {
    load: load,
    ranked: ranked,
    isSupervisor: function (u) { return u && SUPER_ROLES.indexOf(u.role) !== -1; },
  };
})();
