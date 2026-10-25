/* Low stock keeps the server's inclusive reorder threshold and item units. */
MApp.route('low-stock',function(view) {
  MApp.setTitle('Low stock');
  var root=mEl('<section class="m-stock-page"><div class="m-stock-tools">'+mStockUI.filterControl('Filter low-stock items')+mStockUI.refresh('low stock')+'</div><div data-stock-results></div></section>');
  view.replaceChildren(root);
  var scope=mReadScope.create(root), state=mStockUI.state('low-stock'), input=root.querySelector('input'), out=root.querySelector('[data-stock-results]'), refresh=root.querySelector('[data-stock-refresh]'), items=null, busy=false;
  input.value=state.q;
  function render() {
    var rows=mStockUI.filtered(items,state.q);
    out.replaceChildren(mStockUI.meta(state.q?rows.length+' of '+items.length+' items':items.length+' item'+(items.length===1?'':'s'),'At or below reorder point'));
    if (!rows.length) out.appendChild(mStockUI.message(state.q?'No matching items in this list. Clear the filter to see all items.':'No items are at or below their reorder point.'));
    else { out.appendChild(mStockUI.meta('Item','On hand')); out.appendChild(mStockUI.list(rows,{low:true,pick:function(item) { if (!scope.current()) return; mStockUI.remember(state,root,item); mStockUI.openItem(item); }})); }
    mStockUI.restore(state,root,scope);
  }
  async function load() {
    if (!scope.current() || busy) return; busy=true; items=null; refresh.disabled=true; out.setAttribute('aria-busy','true'); out.replaceChildren(mStockUI.message('Loading current stock…'));
    try { var rows=await scope.run(function(opts) { return API.get('/inventory?low=1',opts); }); if (!scope.current()) return;
      if (!mStockUI.validItems(rows) || rows.some(function(i) { return !mStockUI.numeric(i.min_quantity); })) throw new Error('The low-stock list could not be read. Retry loading it.'); items=rows; render();
    } catch(error) { if (scope.current() && !error.cancelled) mStockUI.failure(out,error,load); }
    finally { busy=false; if (scope.current()) { refresh.disabled=false; out.removeAttribute('aria-busy'); } }
  }
  input.oninput=function() { state.q=input.value; if (items) render(); }; refresh.onclick=load;window.mScreenUX?.bindRefresh(root,async function(){await load();return {ok:!!items};},function(){return scope.current()&&!busy;}); load();
});
