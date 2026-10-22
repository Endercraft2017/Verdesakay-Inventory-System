/* Locations: fetch once, cache, and build <select>s that default to the default location. */
(function () {
  var cache = null;

  function load(force) {
    if (force) cache=null;
    if (cache) return Promise.resolve(cache);
    return API.get('/locations').then(function (rows) { cache = rows || []; return cache; });
  }

  function path(l){
    if(l.path)return l.path;
    var names=[l.name],seen=[l.id],parent=l.parent_id;
    while(parent&&seen.indexOf(parent)===-1){seen.push(parent);var p=(cache||[]).find(function(x){return x.id===parent;});if(!p)break;names.unshift(p.name);parent=p.parent_id;}
    return names.join(' / ');
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
    (opts.locations || cache || []).forEach(function (l) {
      var qty = opts.stockByLoc ? (' — ' + (opts.stockByLoc[l.id] || 0) + ' on hand') : '';
      var o = mEl('<option value="' + l.id + '">' + mEsc(path(l)) + qty + '</option>');
      if (l.is_default) o.selected = true;
      sel.appendChild(o);
    });
    return { el: field, value: function () { return sel.value ? Number(sel.value) : null; }, select: sel };
  }

  window.mLocations = { path:path, load: load, select: select, list: function () { return cache || []; } };
})();
