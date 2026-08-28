/* Recently-touched items, kept in localStorage for fast re-selection. */
(function () {
  var KEY = 'vds_m_recent';
  var MAX = 8;

  function read() {
    try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { return []; }
  }
  function push(item) {
    if (!item || !item.id) return;
    var list = read().filter(function (r) { return r.id !== item.id; });
    list.unshift({ id: item.id, name: item.name, sku: item.sku || null, unit: item.unit || null });
    try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX))); } catch (e) { /* ignore */ }
  }

  window.mRecent = { read: read, push: push };
})();
