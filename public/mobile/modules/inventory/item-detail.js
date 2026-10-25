/* Find an item, then inspect authoritative stock without changing its accounting. */
(function() {
  function icon(name) {
    var paths={in:'<path d="M12 3v12M7 10l5 5 5-5M4 20h16"/>',out:'<path d="M12 21V9M7 14l5-5 5 5M4 4h16"/>',transfer:'<path d="M7 7h11l-3-3M17 17H6l3 3"/>',damage:'<path d="M12 3l9 16H3zM12 10v4M12 17h.01"/>',qa:'<path d="M9 12l2 2 4-5"/><circle cx="12" cy="12" r="9"/>'};
    return '<svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'+paths[name]+'</svg>';
  }
  function detail(view,id) {
    MApp.setTitle('Item detail');
    var root=mEl('<section class="m-stock-page m-stock-detail"><div data-stock-results></div><div data-item-feedback></div></section>'); view.replaceChildren(root);
    var out=root.querySelector('[data-stock-results]'), feedback=root.querySelector('[data-item-feedback]'), imageUrl=null, upload=null, read=0, busy=false, action=false, item, unit=mStockUI.takeUnit(id);
    function revoke() { if (imageUrl) { URL.revokeObjectURL(imageUrl); imageUrl=null; } }
    var scope=mReadScope.create(root,function() { revoke(); upload?.abort(); });
    function allowed(key) { return key==='transfer'?MApp.can('inventory.transfer'):key==='qa'?(MApp.can('production.inspect_qc')||MApp.can('production.inspect_qa')):key==='photo'?MApp.can('inventory.edit'):key==='report'||MApp.can('inventory.adjust'); }
    async function load() {
      if (!scope.current() || busy || action) return; busy=true; var own=++read; revoke(); feedback.textContent=''; out.setAttribute('aria-busy','true'); out.replaceChildren(mStockUI.message('Loading current stock…'));
      try {
        var result=await scope.run(function(opts) { return API.get('/inventory/'+encodeURIComponent(id),opts); });
        if (!scope.current() || own!==read) return;
        if (!mStockUI.validItem(result) || Number(result.id)!==Number(id) || !mStockUI.numeric(result.min_quantity) || !Array.isArray(result.stock) || !Array.isArray(result.history) || result.stock.some(function(b) { return !b || !(Number(b.location_id)>0) || !mStockUI.numeric(b.quantity); }) || result.history.some(function(h) { return !h || !mStockUI.numeric(h.change); })) throw new Error('The item details could not be read. Retry this item.');
        item=result; if (window.mRecent) mRecent.push(item); render(own);
      } catch(error) { if (scope.current() && !error.cancelled) mStockUI.failure(out,error,load); }
      finally { busy=false; if (scope.current()) out.removeAttribute('aria-busy'); }
    }
    window.mScreenUX?.bindRefresh(root,async function(){await load();return {ok:!out.querySelector('[role=alert]')};},function(){return scope.current()&&!busy&&!action&&!upload;});
    function render(own) {
      var uom=typeof item.unit==='string'?item.unit:'', q=function(value) { return mStockUI.quantity(value,uom); };
      out.innerHTML='<div class="m-stock-identity"><div class="m-sr-photo" data-item-photo>No photo</div><div><h1 class="m-sr-name">'+mEsc(item.name)+'</h1><p class="m-sr-sku">SKU <b>'+mEsc(item.sku||'—')+'</b>'+(item.category?' · '+mEsc(item.category):'')+'</p></div>'+mStockUI.refresh('item detail')+'</div>';
      if (unit?.identifier) {
        var pill=mEl('<div class="m-sr-unit">Serialized Unit · '+mEsc(unit.identifier)+'<button type="button" class="m-chip" aria-label="Copy unit identifier">Copy</button></div>');
        pill.querySelector('button').onclick=function() { if (scope.current()) Promise.resolve().then(function() { return navigator.clipboard.writeText(unit.identifier); }).then(function() { if (scope.current()) mToast('Copied'); }).catch(function() { if (scope.current()) mToast(unit.identifier); }); };
        out.appendChild(pill); out.appendChild(mStockUI.meta(unit.status||'',unit.job_order_number?'from '+unit.job_order_number:''));
      }
      out.appendChild(mEl('<section class="m-stock-summary" aria-label="Stock overview"><div class="m-stock-meta"><span>Across all locations</span><span>Updated '+mEsc(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Manila',hour:'numeric',minute:'2-digit',hour12:true}).format(new Date()))+'</span></div><dl class="m-stock-primary"><div><dt>On hand</dt><dd>'+mEsc(mStockUI.quantity(item.quantity))+' <small>'+mEsc(uom)+'</small></dd></div><div><dt>Reorder at</dt><dd>'+mEsc(mStockUI.quantity(item.min_quantity))+' <small>'+mEsc(uom)+'</small></dd></div></dl>'+(mStockUI.numeric(item.available_quantity)?'<dl class="m-stock-secondary"><div><dt>Available for sales</dt><dd>'+mEsc(q(item.available_quantity))+'</dd></div><div><dt>Committed to sales orders</dt><dd>'+mEsc(q(item.reserved_for_sales))+'</dd></div></dl>':'')+'</section>'));
      out.appendChild(mEl('<h2 class="m-stock-section">Locations</h2>'));
      if (!item.stock.length) out.appendChild(mStockUI.message('No non-zero location balances.'));
      else {
        var locations=mEl('<ul class="m-kv"></ul>'); item.stock.forEach(function(b) { locations.appendChild(mEl('<li><span>'+mEsc(b.location_name||'Location unavailable')+'</span><b>'+mEsc(q(b.quantity))+'</b></li>')); }); out.appendChild(locations);
        if (item.stock.some(function(b) { return mStockUI.numeric(b.assembled_quantity)||mStockUI.numeric(b.semi_built_quantity); })) {
          var composition=mEl('<details class="m-stock-composition"><summary>Stock composition and availability</summary></details>');
          item.stock.forEach(function(b) { composition.appendChild(mEl('<p><b>'+mEsc(b.location_name||'Location unavailable')+'</b><br>On hand: '+mEsc(mStockUI.quantity(b.assembled_quantity))+' assembled + '+mEsc(mStockUI.quantity(b.semi_built_quantity))+' semi-built'+(mStockUI.numeric(b.assembled_available)?'<br>Available: '+mEsc(mStockUI.quantity(b.assembled_available))+' assembled + '+mEsc(mStockUI.quantity(b.semi_built_available))+' semi-built':'')+(mStockUI.numeric(b.reserved_for_sales)?'<br>Committed to sales orders: '+mEsc(q(b.reserved_for_sales)):'')+'</p>')); }); out.appendChild(composition);
        }
      }
      out.appendChild(mEl('<div class="m-stock-section-line"><h2 class="m-stock-section">Recent movements</h2><span>Asia/Manila (UTC+8)</span></div>'));
      if (!item.history.length) out.appendChild(mStockUI.message('No recent stock movements.'));
      else { var moves=mEl('<ul class="m-stock-movements"></ul>'); item.history.slice(0,3).forEach(function(h) { moves.appendChild(mEl('<li><div class="m-stock-movement"><b class="m-stock-movement-name">'+mEsc(h.reason||'No reason recorded')+'</b><b class="m-stock-delta">'+(Number(h.change)>0?'+':'')+mEsc(q(h.change))+'</b><time class="m-stock-reason" datetime="'+mEsc(mStockUI.date(h.created_at)?.toISOString()||'')+'">'+mEsc(mStockUI.stamp(h.created_at))+'</time></div></li>')); }); out.appendChild(moves); if (item.history.length>3) out.appendChild(mStockUI.meta('Newest 3 of '+item.history.length+' loaded movements','Up to 50 loaded')); }
      var chips=mEl('<div class="m-detail-acts"></div>');
      [['qr','Add QR'],['photo','Add photo'],['report','Report problem']].forEach(function(a) { if (!allowed(a[0])) return; var b=mEl('<button type="button" class="m-chip" data-item-action="'+a[0]+'">'+a[1]+'</button>'); b.onclick=function() { if (a[0]==='photo') photo(); else navigate(a[0],a[0]==='qr'?'assign-qr':'report-problem',a[0]==='qr'?{id:item.id}:{about:item.name+(item.sku?' (#'+item.sku+')':'')}); }; chips.appendChild(b); }); out.appendChild(chips);
      var arc=mEl('<div class="m-arc"></div>');
      [['in','In'],['out','Out'],['transfer','Transfer'],['damage','Damage'],['qa','QA']].forEach(function(a) { if (!allowed(a[0])) return; var b=mEl('<button type="button" data-item-action="'+a[0]+'"'+(a[0]==='qa'&&!item.is_finished_product?' disabled':'')+(a[0]==='damage'?' class="warn"':'')+'><span class="ic">'+icon(a[0])+'</span>'+a[1]+'</button>'); b.onclick=function() { if (a[0]==='qa') navigate('qa','qc'); else handoff(a[0]); }; arc.appendChild(b); });
      if (arc.childElementCount) { var dock=mEl('<div class="m-arc-dock"></div>'); dock.appendChild(arc); out.appendChild(mEl('<div class="m-arc-spacer"></div>')); out.appendChild(dock); }
      root.querySelector('[data-stock-refresh]').onclick=load;
      if (item.image_path) {
        var box=root.querySelector('[data-item-photo]'); box.textContent='Loading photo…';
        scope.run(function(opts) { return API.blobUrl('/inventory/'+item.id+'/image',undefined,Object.assign({},opts,{isCurrent:function() { return opts.isCurrent() && own===read && box.isConnected; }})).then(function(url) { if (!scope.current()||own!==read||!box.isConnected) { URL.revokeObjectURL(url); throw Object.assign(new Error('Photo cancelled.'),{cancelled:true}); } return url; }); }).then(function(url) { if (!scope.current()||own!==read||!box.isConnected) { URL.revokeObjectURL(url); return; } imageUrl=url; var img=document.createElement('img'); img.alt=''; img.src=url; box.replaceChildren(img); }).catch(function(error) { if (scope.current()&&own===read&&box.isConnected&&!error.cancelled) box.textContent='Photo unavailable'; });
      }
    }
    function navigate(key,route,params) { if (action||!scope.current()||!allowed(key)) return; action=true; MApp.go(route,params); }
    function handoff(key) {
      if (action||!scope.current()||!allowed(key)) return; action=true;
      var destination=mEl('<section><p class="m-stock-feedback" role="status">Opening '+mEsc(key==='transfer'?'transfer':key==='damage'?'damage report':'stock adjustment')+'…</p></section>');
      scope.release(); root.className=''; root.replaceChildren(destination);
      var hash=location.hash, owner=mStockUI.identity();
      Promise.resolve().then(function() { if (!destination.isConnected||hash!==location.hash||owner!==mStockUI.identity()) return;
        if (key==='transfer') return mTransferForm(destination,item); if (key==='damage') return mDamageForm(destination,item); return mStockMoveForm(destination,{item:item,mode:key});
      }).catch(function(error) { if (destination.isConnected&&hash===location.hash&&owner===mStockUI.identity()) mStockUI.failure(destination,error,function() { MApp.render(); }); });
    }
    async function photo() {
      if (action||!scope.current()||!allowed('photo')) return; action=true; upload=new AbortController(); var timedOut=false;
      var timer;
      root.querySelectorAll('button').forEach(function(b) { b.disabled=true; }); feedback.replaceChildren(mStockUI.message('Choose a photo. Your stock has not changed.'));
      try { await mPhoto.capture(item.id,{signal:upload.signal,isCurrent:function() { return scope.current()&&!upload.signal.aborted; },onUpload:function() { timer=setTimeout(function() { timedOut=true; upload.abort(); },60000); }}); if (scope.current()) { action=false; load(); } }
      catch(error) { if (scope.current()) { if (timedOut) feedback.replaceChildren(mStockUI.message('The upload result is not confirmed. Refresh this item before trying another upload.',true)); else if (error.message!=='cancelled'&&!error.cancelled) feedback.replaceChildren(mStockUI.message(error.message||'Photo could not be saved.',true)); else feedback.textContent=''; } }
      finally { clearTimeout(timer); action=false; if (scope.current()) root.querySelectorAll('button').forEach(function(b) { b.disabled=b.dataset.itemAction==='qa'&&!item.is_finished_product; }); }
    }
    load();
  }
  MApp.route('item',function(view,params) {
    if (params?.id) { detail(view,params.id); return; }
    MApp.setTitle('Check stock'); var root=mEl('<section class="m-stock-page"></section>'); view.replaceChildren(root);
    var state=mStockUI.state('find-item');
    var picker=mItemPicker({label:'Scan or search an item',showKindFilter:true,kind:state.kind||'all',value:state.q,limit:state.limit,onChange:function(next) { Object.assign(state,next); },onRendered:function(box,scope) { mStockUI.restore(state,box,scope); },onPick:function(item) { mStockUI.remember(state,root,item); mStockUI.openItem(item); }});
    root.appendChild(picker.el); if (!state.restore) picker.focus();
  });
})();
