/* Signed-in stock movements, paged with full Manila dates and return context. */
MApp.route('my-log',function(view) {
  MApp.setTitle('My activity');
  var root=mEl('<section class="m-stock-page"><div data-stock-results></div></section>'); view.replaceChildren(root);
  var scope=mReadScope.create(root), state=mStockUI.state('my-log'), out=root.querySelector('[data-stock-results]'), busy=false, me=MApp.getMe(), pageSize=50;
  state.offset=Math.max(0,Number(state.offset)||0);
  function pager(total,count,top) {
    return mEl('<div class="m-stock-pagination"><p role="status"><b>'+(count?(state.offset+1)+'–'+(state.offset+count):'0')+'</b><span>of '+total+' movements</span></p><div><button type="button" class="m-chip" data-newer '+(!state.offset?'disabled':'')+'>Newer</button><button type="button" class="m-chip" data-older '+(state.offset+count>=total?'disabled':'')+'>Older</button>'+(top?mStockUI.refresh('my activity'):'')+'</div></div>');
  }
  function render(res) {
    out.replaceChildren(pager(res.total,res.rows.length,true),mEl('<p class="m-stock-scope">Recorded by you · Asia/Manila (UTC+8)</p>'));
    if (!res.rows.length) {
      out.appendChild(mStockUI.message(res.total?'No movements on this page. Use Newer or refresh to check the list.':'No stock movements recorded by this account.'));
    } else {
      var ul=mEl('<ul class="m-stock-movements"></ul>'), day='';
      res.rows.forEach(function(h,index) {
        var next=mStockUI.datePart(h.created_at,false);
        if (next!==day) { ul.appendChild(mEl('<li class="m-stock-day">'+mEsc(next)+'</li>')); day=next; }
        var li=document.createElement('li'), row=mEl('<'+(h.item_id?'button type="button"':'div')+' class="m-stock-movement"'+(h.item_id?' data-stock-item="'+Number(h.item_id)+'"':'')+'><b class="m-stock-movement-name">'+mEsc(h.item_name||'Item unavailable')+'</b><b class="m-stock-delta">'+(Number(h.change)>0?'+':'')+mEsc(mStockUI.quantity(h.change))+'</b><span class="m-stock-reason">'+mEsc(h.reason||'No reason recorded')+'</span><span class="m-stock-movement-meta"><span>'+mEsc(h.location_name||'Location unavailable')+'</span><time datetime="'+mEsc(mStockUI.date(h.created_at)?.toISOString()||'')+'" aria-label="'+mEsc(mStockUI.stamp(h.created_at))+'" title="'+mEsc(mStockUI.stamp(h.created_at))+'">'+mEsc(mStockUI.datePart(h.created_at,true))+'</time></span></'+(h.item_id?'button':'div')+'>');
        if (h.item_id) { var focusKey=Number.isSafeInteger(Number(h.id))&&Number(h.id)>0?'movement-'+Number(h.id):'movement-row-'+(state.offset+index); row.dataset.stockFocus=focusKey; row.onclick=function() { if (!scope.current()) return; mStockUI.remember(state,root,{id:h.item_id},focusKey); mStockUI.openItem({id:h.item_id}); }; }
        li.appendChild(row); ul.appendChild(li);
      });
      out.appendChild(ul);
    }
    if (res.rows.length) out.appendChild(pager(res.total,res.rows.length,false));
    root.querySelectorAll('[data-newer]').forEach(function(b) { b.onclick=function() { if (!scope.current() || busy) return; state.offset=Math.max(0,state.offset-pageSize); state.restore=false; load(true); }; });
    root.querySelectorAll('[data-older]').forEach(function(b) { b.onclick=function() { if (!scope.current() || busy) return; state.offset+=pageSize; state.restore=false; load(true); }; });
    root.querySelector('[data-stock-refresh]').onclick=function() { load(false); };
    mStockUI.restore(state,root,scope);
  }
  async function load(focus) {
    if (!scope.current() || busy) return; busy=true; out.setAttribute('aria-busy','true'); out.replaceChildren(mStockUI.message('Loading your activity…'));
    try {
      var res=await scope.run(function(opts) { return API.get('/inventory/movements?user_id='+encodeURIComponent(me.id)+'&limit='+pageSize+'&offset='+state.offset,opts); });
      if (!scope.current()) return;
      if (!res || !Array.isArray(res.rows) || !Number.isInteger(res.total) || res.total<0 || res.rows.some(function(h) { return !h || !mStockUI.numeric(h.change) || (h.item_id!=null && !(Number(h.item_id)>0)); })) throw new Error('The activity response could not be read. Retry loading it.');
      render(res);
      if (focus) { var range=root.querySelector('[role=status]'); range.tabIndex=-1; range.focus(); }
    } catch(error) { if (scope.current() && !error.cancelled) mStockUI.failure(out,error,function() { load(focus); }); }
    finally { busy=false; if (scope.current()) out.removeAttribute('aria-busy'); }
  }
  load(false);
});
