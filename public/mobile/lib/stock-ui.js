/* Shared presentation and private return state for the five stock lookup views. */
(function () {
  var owner, states = {}, unitContext = null;
  function identity() { return mReadScope.identity(); }
  function session() { var now = identity(); if (owner !== now) { owner = now; states = {}; unitContext = null; } }
  function state(name) { session(); return states[name] || (states[name] = {q:'',limit:50}); }
  function numeric(value) { return value != null && typeof value !== 'boolean' && String(value).trim() !== '' && Number.isFinite(Number(value)); }
  function quantity(value, unit) { return (numeric(value) ? Number(value).toLocaleString(undefined,{maximumFractionDigits:20}) : 'Unavailable') + (unit ? ' ' + unit : ''); }
  function validItem(item) { return item && Number(item.id) > 0 && typeof item.name === 'string' && numeric(item.quantity); }
  function validItems(items) { return Array.isArray(items) && items.every(validItem); }
  function refresh(label) { return '<button type="button" class="m-chip m-stock-refresh" data-stock-refresh hidden tabindex="-1" aria-hidden="true" aria-label="Refresh '+mEsc(label)+'" title="Refresh"><svg aria-hidden="true" viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1"/></svg></button>'; }
  function message(text, error) { return mEl('<div class="m-stock-feedback'+(error?' error':'')+'" role="'+(error?'alert':'status')+'">'+mEsc(text)+'</div>'); }
  function failure(out, error, retry) {
    var box = message(error.message || 'This view could not be loaded. Try again.',true);
    var button = mEl('<button type="button" class="m-btn m-btn-secondary">Retry</button>');
    button.onclick = function () { if (button.isConnected) retry(); }; box.appendChild(button); out.replaceChildren(box);
  }
  function filtered(items, query) { var q = String(query || '').trim().toLowerCase(); return items.filter(function(i) { return !q || (i.name+' '+(i.sku||'')).toLowerCase().indexOf(q) !== -1; }); }
  function meta(left, right) { return mEl('<div class="m-stock-meta"><span>'+mEsc(left)+'</span><span>'+mEsc(right)+'</span></div>'); }
  function row(item, options) {
    options = options || {};
    var button = mEl('<button type="button" class="m-stock-row" data-stock-item="'+Number(item.id)+'"><span class="m-stock-main"><b>'+mEsc(item.name)+'</b><span>'+mEsc(item.sku||'')+(options.kind && item.is_finished_product!=null?' · '+(item.is_finished_product?'Finished product':'Part / supply'):'')+'</span></span><span class="m-stock-number">'+(options.recent?'<span class="m-stock-sr-only">Open current item detail</span><span aria-hidden="true">›</span>':'<b>'+mEsc(quantity(item.quantity,typeof item.unit==='string'?item.unit:''))+'</b>'+(options.low?'<small>Reorder at '+mEsc(quantity(item.min_quantity,item.unit))+'</small>':''))+'</span></button>');
    button.onclick = function () { options.pick(item,button); }; return button;
  }
  function list(items, options) {
    var ul = mEl('<ul class="m-stock-list"></ul>');
    items.forEach(function(item) { var li = document.createElement('li'); li.appendChild(row(item,options)); ul.appendChild(li); }); return ul;
  }
  function remember(state, root, item, focusKey) {
    state.scroll = root.closest('#m-view')?.scrollTop || 0; state.windowScroll = window.scrollY || 0;
    state.focus = item.id; state.focusKey = focusKey || null; state.restore = true;
  }
  function openItem(item) {
    session(); unitContext = item.unit && typeof item.unit === 'object' ? {id:Number(item.id),unit:item.unit} : null;
    MApp.go('item',{id:item.id});
  }
  function takeUnit(id) { session(); var unit = unitContext && unitContext.id === Number(id) ? unitContext.unit : null; unitContext = null; return unit; }
  function restore(state, root, scope) {
    if (!state.restore) return; state.restore = false;
    scope.later(function () {
      var target = state.focusKey ? root.querySelector('[data-stock-focus="'+state.focusKey+'"]') : root.querySelector('[data-stock-item="'+Number(state.focus)+'"]');
      if (target) target.focus({preventScroll:true}); else { root.tabIndex=-1; root.focus({preventScroll:true}); }
      var view = root.closest('#m-view'); if (view) view.scrollTop = state.scroll || 0;
      if ((window.scrollY||0) !== (state.windowScroll||0)) window.scrollTo(0,state.windowScroll||0);
    },0);
  }
  function date(value) {
    var raw = String(value || ''), parsed = new Date(raw.replace(' ','T') + (/([zZ]|[+-]\d\d:\d\d)$/.test(raw)?'':'Z'));
    if (!raw || !Number.isFinite(parsed.getTime())) return null; return parsed;
  }
  function datePart(value, time) { var parsed = date(value); return parsed ? new Intl.DateTimeFormat('en-GB',time?{timeZone:'Asia/Manila',hour:'numeric',minute:'2-digit',hour12:true}:{timeZone:'Asia/Manila',day:'numeric',month:'short',year:'numeric'}).format(parsed) : 'Date unavailable'; }
  function stamp(value) { var parsed = date(value); return parsed ? datePart(value,false)+', '+datePart(value,true) : 'Date unavailable'; }
  function filterControl(label) { return '<label class="m-stock-filter"><span class="m-stock-sr-only">'+mEsc(label)+'</span><input type="search" class="m-input" placeholder="Filter name or SKU" data-stock-filter></label>'; }
  window.mStockUI = {identity:identity,state:state,numeric:numeric,quantity:quantity,validItem:validItem,validItems:validItems,refresh:refresh,message:message,failure:failure,filtered:filtered,meta:meta,row:row,list:list,remember:remember,openItem:openItem,takeUnit:takeUnit,restore:restore,date:date,datePart:datePart,stamp:stamp,filterControl:filterControl};
})();
