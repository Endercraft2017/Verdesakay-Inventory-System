/* Recently-touched items, kept in localStorage for fast re-selection. */
(function () {
  var KEY = 'vds_m_recent';
  var MAX = 8;

  function read() {
    try { var rows = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(rows) ? rows.filter(function(i) { return i && Number(i.id)>0 && typeof i.name==='string'; }).map(function(i) { return Object.assign({},i,{unit:typeof i.unit==='string'?i.unit:null}); }) : []; } catch (e) { return []; }
  }
  function push(item) {
    if (!item || !item.id) return;
    var list = read().filter(function (r) { return r.id !== item.id; });
    var row = { id: item.id, name: item.name, sku: item.sku || null, unit: typeof item.unit === 'string' ? item.unit : null };
    if (item.is_finished_product != null) row.is_finished_product = !!item.is_finished_product;
    list.unshift(row);
    try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX))); } catch (e) { /* ignore */ }
  }

  window.mRecent = { read: read, push: push };
})();
