/* Locations: fetch once, cache, and build <select>s that default to the default location. */
(function () {
  var cache = null;

  function load() {
    if (cache) return Promise.resolve(cache);
    return API.get('/locations').then(function (rows) { cache = rows || []; return cache; });
  }

  /** A <label><select> of locations. opts: { label, name, stockByLoc } where
      stockByLoc maps location_id -> qty (shown in each option when provided). */
  function select(opts) {
    opts = opts || {};
    var field = mEl(
      '<label class="m-field"><span class="m-label">' + mEsc(opts.label || 'Location') + '</span>' +
      '<select class="m-select"></select></label>'
    );
    var sel = field.querySelector('select');
    (cache || []).forEach(function (l) {
      var qty = opts.stockByLoc ? (' — ' + (opts.stockByLoc[l.id] || 0) + ' on hand') : '';
      var o = mEl('<option value="' + l.id + '">' + mEsc(l.name) + qty + '</option>');
      if (l.is_default) o.selected = true;
      sel.appendChild(o);
    });
    return { el: field, value: function () { return sel.value ? Number(sel.value) : null; }, select: sel };
  }

  window.mLocations = { load: load, select: select, list: function () { return cache || []; } };
})();
