/* Locations: fetch once, cache, and build <select>s that default to the default location. */
(function () {
  var cache = null, owner = null, version = 0;
  function currentOwner() { return window.mReadScope ? mReadScope.identity() : JSON.stringify([window.API?.base?.(),window.API?.getToken?.(),window.MApp?.getMe?.()?.id]); }
  function syncOwner() { var now = currentOwner(); if (now !== owner) { owner = now; cache = null; version++; } return now; }

  function load(force, opts) {
    var own = syncOwner();
    if (force) { cache=null; version++; }
    if (cache) return Promise.resolve(cache);
    var attempt = version;
    return API.get('/locations',Object.assign({},opts,{isCurrent:function() { return own===currentOwner() && attempt===version && (!opts?.isCurrent || opts.isCurrent()); }})).then(function (rows) {
      if (own !== syncOwner() || attempt !== version || opts?.signal?.aborted || (opts?.isCurrent && !opts.isCurrent())) throw Object.assign(new Error('Location read cancelled.'),{cancelled:true});
      if (!Array.isArray(rows) || rows.some(function(l) { return !l || !(Number(l.id)>0) || typeof l.name!=='string'; })) throw new Error('The location list could not be read. Retry loading it.');
      cache = rows; return cache;
    });
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
    syncOwner();
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

  window.mLocations = { path:path, load: load, select: select, list: function () { syncOwner(); return cache || []; } };
})();
