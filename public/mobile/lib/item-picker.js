/* Shared item lookup. Cached recents never assert a current balance or item type. */
(function () {
  var nextId = 0;
  function itemPicker(opts) {
    opts = opts || {};
    var id = 'm-item-query-'+(++nextId), kind = opts.kind || 'all', query = opts.value || '', request = 0, timer, busy = false, scanner, limit = opts.limit || 50;
    var box = mEl('<div class="m-picker m-stock-picker"><label class="m-label" for="'+id+'">'+mEsc(opts.label||'Item')+'</label><div class="m-picker-row"><input id="'+id+'" type="search" class="m-input" placeholder="Search name or SKU" autocomplete="off"><button type="button" class="m-scan-btn" aria-label="Scan barcode or QR" title="Scan"><svg aria-hidden="true" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4M4 12h16"/></svg></button></div><div data-picker-results></div><div data-picker-feedback></div></div>');
    var scope = mReadScope.create(box,function() { clearTimeout(timer); scanner?.close(); }), input = box.querySelector('input'), out = box.querySelector('[data-picker-results]'), feedback = box.querySelector('[data-picker-feedback]');
    input.value = query;
    var select;
    if (opts.showKindFilter) {
      var filter = mEl('<label class="m-stock-kind"><span>Item type</span><select class="m-input"><option value="all">All items</option><option value="parts">Parts / supplies</option><option value="finished">Finished products</option></select></label>');
      box.insertBefore(filter,out); select = filter.querySelector('select'); select.value = kind;
      select.onchange = function() { kind = select.value; changed(); search(); };
    }
    function current(own) { return scope.current() && (own == null || own === request); }
    function changed() { clearTimeout(timer); request++; limit = 50; query = input.value.trim(); opts.onChange?.({q:input.value,kind:kind,limit:limit}); }
    function disable(value) { box.querySelectorAll('button,input,select').forEach(function(b) { b.disabled = value; }); }
    function pick(item) {
      if (!current() || busy) return; busy = true; disable(true);
      try {
        if (window.mRecent) mRecent.push(item);
        Promise.resolve(opts.onPick(item)).then(function() { if (current()) { busy=false; disable(false); } }).catch(function(error) { if (current()) { busy=false; disable(false); mStockUI.failure(feedback,error,function() { pick(item); }); } });
      } catch(error) { busy=false; disable(false); mStockUI.failure(feedback,error,function() { pick(item); }); }
    }
    function rows(items, recent) {
      var matched = items.filter(function(i) { return kind === 'all' || (i.is_finished_product != null && (kind==='finished' ? !!i.is_finished_product : !i.is_finished_product)); });
      out.replaceChildren(mStockUI.meta(recent?'Recent':matched.length+' match'+(matched.length===1?'':'es'),recent?'Loads current stock':'On hand · all locations'));
      if (!matched.length) { out.appendChild(mStockUI.message(recent?'Search for an item by name or SKU.':'No matching items. Try another name or SKU, or change Item type.')); }
      else {
        var list=mStockUI.list(matched.slice(0,limit),{recent:recent,kind:!recent,pick:pick});
        list.classList.add('m-picker-list'); list.querySelectorAll('.m-stock-row').forEach(function(row) { row.classList.add('m-picker-item'); }); out.appendChild(list);
      }
      if (matched.length>limit) { var more=mEl('<button type="button" class="m-chip m-stock-more">Show more items ('+limit+' of '+matched.length+')</button>'); more.onclick=function() { if (!current()) return; limit+=50; opts.onChange?.({q:input.value,kind:kind,limit:limit}); rows(items,recent); }; out.appendChild(more); }
      opts.onRendered?.(box,scope);
    }
    function recent() { rows(window.mRecent ? mRecent.read() : [],true); }
    async function search() {
      if (!current() || busy) return;
      var own=++request, q=input.value.trim(); feedback.textContent='';
      if (!q && !opts.showKindFilter && kind==='all') { recent(); return; }
      out.replaceChildren(mStockUI.message('Searching…')); out.setAttribute('aria-busy','true');
      try {
        var items=await scope.run(function(options) { return API.get('/inventory?q='+encodeURIComponent(q)+'&kind='+encodeURIComponent(kind),Object.assign({},options,{isCurrent:function() { return options.isCurrent() && own===request; }})); });
        if (!current(own)) return;
        if (!mStockUI.validItems(items)) throw new Error('The search results could not be read. Retry your search.');
        rows(items,false);
      } catch(error) { if (current(own) && !error.cancelled) mStockUI.failure(out,error,search); }
      finally { if (current(own)) out.removeAttribute('aria-busy'); }
    }
    input.oninput=function() { if (busy) return; changed(); out.replaceChildren(mStockUI.message('Searching…')); timer=setTimeout(search,250); };
    async function lookup(code) {
      if (!current() || busy) return; busy=true; changed(); var own=request; disable(true); feedback.replaceChildren(mStockUI.message('Checking code '+code+'…')); out.textContent='';
      try {
        var item=await scope.run(function(options) { return API.get('/inventory/lookup?code='+encodeURIComponent(code),options); });
        if (!current(own)) return;
        if (!(Number(item?.id)>0)) throw new Error('No inventory item matched this code.');
        busy=false; pick(item);
      } catch(error) {
        if (!current(own) || error.cancelled) return;
        busy=false; disable(false); mStockUI.failure(feedback,new Error(code+' · '+(error.message||'Lookup could not be confirmed.')),function() { lookup(code); });
      }
    }
    box.querySelector('.m-scan-btn').onclick=function() {
      if (!current() || busy) return;
      scanner=mScanner.open({title:'Scan item',key:'item-picker-'+id,isCurrent:function() { return current() && !busy; },onResult:function(code) { if (String(code||'').trim()) lookup(String(code).trim()); }});
    };
    if (query || kind!=='all') timer=setTimeout(search,0); else recent();
    return {el:box,focus:function() { input.focus(); },release:scope.release};
  }
  window.mItemPicker=itemPicker;
})();
