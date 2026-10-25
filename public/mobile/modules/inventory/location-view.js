/* Direct stock at the selected location; descendant balances are not merged. */
MApp.route('location',function(view) {
  MApp.setTitle('Location');
  var root=mEl('<section class="m-stock-page"><div data-location-control></div><div class="m-stock-tools">'+mStockUI.filterControl('Filter this location')+mStockUI.refresh('location contents')+'</div><div data-stock-results></div></section>');
  view.replaceChildren(root);
  var scope=mReadScope.create(root), state=mStockUI.state('location'), out=root.querySelector('[data-stock-results]'), control=root.querySelector('[data-location-control]'), input=root.querySelector('input'), refresh=root.querySelector('[data-stock-refresh]'), select, locations=[], record, serial=0, reading=false;
  input.value=state.q;
  function render() {
    var rows=mStockUI.filtered(record.items,state.q);
    out.replaceChildren(mStockUI.meta(state.q?rows.length+' of '+record.items.length+' items':record.items.length+' item'+(record.items.length===1?'':'s'),'Direct stock only'));
    if (!rows.length) out.appendChild(mStockUI.message(state.q?'No matching items in this list. Clear the filter to see all items.':Number(record.subtree_item_count)>0?'No stock is stored directly at this location. Stock exists in child locations; choose a child above.':'No stock is stored directly at this location.'));
    else { out.appendChild(mStockUI.meta('Item','On hand')); out.appendChild(mStockUI.list(rows,{pick:function(item) { if (!scope.current()) return; mStockUI.remember(state,root,item); mStockUI.openItem(item); }})); }
    mStockUI.restore(state,root,scope);
  }
  function pathText() { var loc=locations.find(function(l) { return Number(l.id)===Number(state.location); }), path=loc?mLocations.path(loc):''; var label=control.querySelector('[data-full-path]'); label.textContent=path; label.hidden=path.length<=40; }
  async function load() {
    if (!scope.current() || !select?.value()) return;
    var own=++serial, id=select.value(); state.location=id; record=null; refresh.disabled=true; out.setAttribute('aria-busy','true'); out.replaceChildren(mStockUI.message('Loading current stock…')); pathText();
    try { var result=await scope.run(function(opts) { return API.get('/locations/'+id,Object.assign({},opts,{isCurrent:function() { return opts.isCurrent() && own===serial; }})); });
      if (!scope.current() || own!==serial) return;
      if (!result || Number(result.id)!==id || !mStockUI.validItems(result.items)) throw new Error('The location contents could not be read. Retry this location.'); record=result; render();
    } catch(error) { if (scope.current() && own===serial && !error.cancelled) mStockUI.failure(out,error,load); }
    finally { if (scope.current() && own===serial) { refresh.disabled=false; out.removeAttribute('aria-busy'); } }
  }
  async function registry(force) {
    if (!scope.current() || reading) return; reading=true; refresh.disabled=true; serial++; record=null; out.replaceChildren(mStockUI.message('Loading locations…'));
    try { locations=await scope.run(function(opts) { return mLocations.load(force,opts); }); if (!scope.current()) return;
      if (!locations.length) { control.textContent=''; select=null; out.replaceChildren(mStockUI.message('No locations are available. Refresh to check again.')); return; }
      select=mLocations.select({label:'Which location?',locations:locations}); control.replaceChildren(select.el,mEl('<p class="m-stock-path" data-full-path hidden></p>'));
      if (locations.some(function(l) { return Number(l.id)===Number(state.location); })) select.select.value=state.location;
      select.select.onchange=load; await load();
    } catch(error) { if (scope.current() && !error.cancelled) mStockUI.failure(out,error,function() { registry(true); }); }
    finally { reading=false; if (scope.current()) {refresh.disabled=false;window.mScreenUX?.sync();} }
  }
  input.oninput=function() { state.q=input.value; if (record) render(); };
  refresh.onclick=function() { if (!refresh.disabled) registry(true); };window.mScreenUX?.bindRefresh(root,async function(){await registry(true);return {ok:!!record||!locations.length};},function(){return scope.current()&&!reading&&!refresh.disabled;}); registry(false);
});
