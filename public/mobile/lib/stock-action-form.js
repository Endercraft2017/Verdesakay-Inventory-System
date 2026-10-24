/* The four existing stock forms. Every read belongs to one visible root/sign-in;
   every submitted decision freezes its original payload before a network write. */
(function () {
  var serial=0, U;
  function route(kind){return kind==='in'||kind==='out'?'stock-move':kind;}
  function permitted(kind){return MApp.can(kind==='transfer'?'inventory.transfer':'inventory.adjust');}
  function navigate(name,params){if(MApp.nav(name,params)===location.hash)MApp.render();else MApp.go(name,params);}
  async function open(view,kind,picked){
    U=mStockActionUI; MApp.setTitle(U.titles[kind]);
    var root=mEl('<section class="m-stock-action"><div data-action-body></div></section>');view.replaceChildren(root);
    var scope=mReadScope.create(root),body=root.firstElementChild, s,item,stock,units=[],locations=[],form,busy=false,loading=false,uid='stock-action-'+(++serial);
    function alive(){return scope.current()&&(!s||mWorkflow.owns(s));}
    function input(name){return form.querySelector('[data-field="'+name+'"]');}
    function batch(){return s.batch;}
    function candidates(){return kind==='transfer'&&U.finished(item)?units.filter(function(u){return Number(u.location_id)===Number(input('from').value)&&(u.build_mode||'assembled')===build();}):[];}
    function build(){return U.finished(item)?input('build').value:'assembled';}
    function location(id){return locations.find(function(l){return Number(l.id)===Number(id);});}
    function path(id){var l=location(id);return l?mLocations.path(l):'Location unavailable';}
    function at(id,mode){var row=stock.find(function(r){return Number(r.location_id)===Number(id);});return row?Number(row[mode==='semi_built'?'semi_built_quantity':'assembled_quantity']):0;}
    function movable(id,mode){var row=stock.find(function(r){return Number(r.location_id)===Number(id);});return row?Number(row[mode==='semi_built'?'semi_built_movable':'assembled_movable']):0;}
    function collect(){
      if(!form)return;var b=batch(),tracked=candidates().length>0;
      b.item={id:item.id,name:item.name,sku:item.sku,unit:item.unit,quantity:item.quantity,is_finished_product:item.is_finished_product};b.mode=kind;b.build_mode=build();b.from=Number(input('from').value);b.location_id=b.from;
      b.to=kind==='transfer'?Number(input('to').value):null;b.reason=input('reason').value.trim();
      b.unit_ids=Array.from(form.querySelectorAll('[data-unit]:checked')).map(function(e){return Number(e.dataset.unit);});
      b.quantity=tracked?b.unit_ids.length:Number(input('quantity').value);
      var sourceInputs=Array.from(form.querySelectorAll('[data-source]'));if(sourceInputs.length)b.allocations=Object.fromEntries(sourceInputs.map(function(e){return [e.dataset.source,e.value];}));
    }
    function rows(){var b=batch();return locations.map(function(l){return {location_id:Number(l.id),name:path(l.id),quantity:Number(b.allocations?.[l.id]??0),available:movable(l.id,b.build_mode)};});}
    function problem(){
      var b=batch(),q=b.quantity;if(!Number.isSafeInteger(q)||q<=0)return candidates().length?'Select at least one exact serial.':'Enter a positive whole quantity.';
      if(!location(b.from))return 'Choose a stock location.';
      if(kind==='transfer'&&(!location(b.to)||b.from===b.to))return 'Choose different source and destination locations.';
      if(kind==='out'&&b.multi){
        var all=rows();if(all.filter(function(r){return r.quantity>0;}).length>100)return 'Use at most 100 source locations in one action.';var bad=all.find(function(r){return !Number.isSafeInteger(r.quantity)||r.quantity<0;});if(bad)return 'Enter zero or a positive whole quantity for each warehouse.';
        var over=all.find(function(r){return r.quantity>r.available;});if(over)return 'Only '+U.quantity(over.available,item.unit)+' are movable at '+over.name+'. Reduce that source quantity.';
        if(all.reduce(function(n,r){return n+r.quantity;},0)!==q)return 'Allocate exactly '+U.quantity(q,item.unit)+' across the warehouses.';
      }else if(kind!=='in'){
        if(at(b.from,b.build_mode)-q<0)return 'Stock cannot go below zero. Only '+U.quantity(at(b.from,b.build_mode),item.unit)+' are on hand at '+path(b.from)+'.';
        if(!candidates().length&&q>movable(b.from,b.build_mode))return 'Only '+U.quantity(movable(b.from,b.build_mode),item.unit)+' are movable here. Reserved or serialized stock needs its existing workflow.';
      }
      if(kind==='in'&&at(b.from,b.build_mode)+q<0)return 'This quantity would still leave negative stock. Review the current balance.';
      return '';
    }
    function saveDraft(){if(!alive())return Promise.resolve();return mWorkflow.save(s).then(function(){if(alive())form.querySelector('[data-draft-error]').textContent='';}).catch(function(error){if(alive())form.querySelector('[data-draft-error]').textContent='Draft not saved: '+error.message;throw error;});}
    function renderSerials(){var b=batch();form.querySelector('[data-serials]').innerHTML=U.serials(candidates(),b.unit_ids||[]);input('quantity').disabled=candidates().length>0;if(candidates().length)input('quantity').value=(b.unit_ids||[]).length;}
    function update(){
      if(!alive()||!form)return;collect();if(candidates().length)input('quantity').value=batch().quantity;var b=batch(),q=b.quantity,mode=b.build_mode,available=movable(b.from,mode),onHand=at(b.from,mode),valid=Number.isSafeInteger(q)&&q>0,multi=kind==='out'&&b.multi,error=problem(),effect=form.querySelector('[data-effect]');
      input('from').closest('label').hidden=!!multi;var selectedPath=form.querySelector('[data-from-path]');selectedPath.hidden=!!multi||path(b.from).length<=28;selectedPath.textContent=path(b.from);
      if(kind==='transfer'){var destinationPath=form.querySelector('[data-to-path]');destinationPath.textContent=path(b.to);destinationPath.hidden=path(b.to).length<=28;}
      if(kind==='in'||multi)input('quantity').removeAttribute('max');else input('quantity').max=candidates().length?Math.max(0,onHand):Math.max(0,available);
      input('quantity').setAttribute('aria-invalid',String(!!error));input('quantity').setAttribute('aria-describedby',uid+'-effect '+uid+'-error');effect.id=uid+'-effect';
      if(multi){effect.innerHTML='<div><span>Requested total</span><b>'+mEsc(U.quantity(q,item.unit))+'</b></div><div><span>Allocated across sources</span><b>'+mEsc(U.quantity(rows().reduce(function(n,r){return n+r.quantity;},0),item.unit))+'</b></div><p>Each source records its own deduction.</p>';}
      else effect.innerHTML='<div><span>'+(!U.finished(item)?'On hand':mode==='semi_built'?'Semi-built on hand':'Standard / fully built on hand')+'</span><b>'+mEsc(U.quantity(onHand,item.unit))+'</b></div><div><span>Estimated source after</span><b>'+mEsc(valid?U.quantity(onHand+(kind==='in'?q:-q),item.unit):'—')+'</b></div>'+(kind!=='in'&&!candidates().length&&available!==onHand?'<p>Movable without reserved or serialized units: '+mEsc(U.quantity(available,item.unit))+'</p>':'')+'<p>'+(kind==='transfer'?'Total stock stays the same.':kind==='damage'?'Moves quantity into the Damage record.':valid?(kind==='in'?'Add ':'Remove ')+mEsc(U.quantity(q,item.unit))+' at this location.':'Enter a positive whole quantity.')+'</p>';
      if(kind==='out'){
        var toggle=form.querySelector('[data-toggle-sources]'),panel=form.querySelector('[data-sources]');panel.id=uid+'-sources';toggle.setAttribute('aria-controls',panel.id);toggle.setAttribute('aria-expanded',String(!!multi));panel.hidden=!multi;
        var elsewhere=locations.filter(function(l){return Number(l.id)!==b.from;}).reduce(function(n,l){return n+movable(l.id,mode);},0);
        toggle.textContent=multi?'Use one warehouse':'Use other warehouses · '+U.quantity(elsewhere,item.unit)+' elsewhere';
        rows().forEach(function(r){var el=form.querySelector('[data-source="'+r.location_id+'"]');if(!el)return;el.max=r.available;el.setAttribute('aria-invalid',String(!Number.isSafeInteger(r.quantity)||r.quantity<0||r.quantity>r.available));form.querySelector('[data-source-balance="'+r.location_id+'"]').textContent=U.quantity(r.available,item.unit)+' movable · '+U.quantity(at(r.location_id,mode)-r.quantity,item.unit)+' on hand after';});
      }
      var hint=form.querySelector('[data-error]');hint.id=uid+'-error';hint.hidden=!error;hint.textContent=error;
      form.querySelector('[type=submit]').disabled=busy||!permitted(kind)||!!error;
    }
    function render(){
      var b=batch();body.innerHTML=U.layout(item,kind,b,locations);form=body.querySelector('form');
      if(kind==='out'&&b.multi)form.querySelector('[data-sources]').innerHTML=U.sources(locations,b);
      renderSerials();update();
      form.addEventListener('input',function(){if(busy||!alive())return;update();saveDraft().catch(function(){});});
      form.addEventListener('change',function(e){if(busy||!alive())return;
        if(kind==='transfer'&&(e.target===input('from')||e.target===input('build'))){batch().unit_ids=[];renderSerials();}
        update();saveDraft().catch(function(){});
      });
      if(kind==='out')form.querySelector('[data-toggle-sources]').onclick=function(){if(busy||!alive())return;batch().multi=!batch().multi;if(batch().multi&&!form.querySelector('[data-source]'))form.querySelector('[data-sources]').innerHTML=U.sources(locations,batch());update();saveDraft().catch(function(){});};
      form.querySelector('[data-refresh-stock]').onclick=function(){if(busy||!alive())return;collect();load();};
      form.querySelector('[data-change-item]').onclick=async function(){if(busy||!alive())return;busy=true;try{await mProductionDrafts.remove(s);if(alive())navigate(route(kind),kind==='in'||kind==='out'?{mode:kind}:{});}catch(error){if(alive()){busy=false;form.querySelector('[data-error]').hidden=false;form.querySelector('[data-error]').textContent=error.message;}}};
      form.onsubmit=submit;
    }
    async function load(){
      if(loading||!alive())return;loading=true;body.replaceChildren(mStockUI.message('Loading current stock…'));
      try{
        var result=await Promise.all([scope.run(function(opts){return API.get('/inventory/'+Number(picked.id),opts);}),scope.run(function(opts){return mLocations.load(true,opts);}),scope.run(function(opts){return API.get('/inventory/'+Number(picked.id)+'/stock',opts);}),kind==='transfer'?scope.run(function(opts){return API.get('/finished-products/'+Number(picked.id)+'/units?status=in_stock',opts);}):Promise.resolve([])]);
        if(!alive())return;
        if(!U.validItem(result[0],picked.id)||!U.validStock(result[2])||!Array.isArray(result[3])||result[3].some(function(u){return !u||!(Number(u.id)>0)||!['assembled','semi_built'].includes(u.build_mode||'assembled');}))throw new Error('Current item, stock or serial information could not be read. Retry loading it.');
        item=result[0];locations=result[1];stock=result[2];units=result[3];if(!locations.length)throw new Error('No stock locations are configured. Add a location before recording stock.');
        if(locations.some(function(l){return !stock.some(function(r){return Number(r.location_id)===Number(l.id);});}))throw new Error('Some location balances are missing. Retry loading current stock.');
        var b=batch(),isSame=Number(b.item?.id)===Number(item.id);if(!isSame)s.batch={};b=batch();
        b.item={id:item.id,name:item.name,sku:item.sku,unit:item.unit,quantity:item.quantity,is_finished_product:item.is_finished_product};b.mode=kind;b.build_mode=U.finished(item)&&b.build_mode==='semi_built'?'semi_built':'assembled';
        b.from=b.from||b.location_id||(locations.find(function(l){return l.is_default;})||locations[0]).id;
        if(!location(b.from))b.from=locations[0].id;
        b.to=b.to||locations.find(function(l){return Number(l.id)!==Number(b.from);})?.id||b.from;
        if(!location(b.to))b.to=locations[0].id;
        b.quantity=b.quantity??1;b.reason=b.reason||'';b.allocations=b.allocations||{};b.multi=kind==='out'&&!!b.multi;
        render();await saveDraft();
      }catch(error){if(alive()&&!error.cancelled)mStockUI.failure(body,error,load);}finally{loading=false;}
    }
    async function submit(e){
      e.preventDefault();if(busy||!alive()||!permitted(kind))return;update();var error=problem();if(error)return;
      if(kind!=='transfer'&&!batch().reason){form.querySelector('[data-error]').hidden=false;form.querySelector('[data-error]').textContent=kind==='damage'?'Describe what happened.':'Record the adjustment reason.';input('reason').focus();return;}
      busy=true;form.querySelectorAll('button,input,select').forEach(function(el){el.disabled=true;});
      try{
        await saveDraft();if(!alive()||!permitted(kind))return;
        var b=batch(),tracked=candidates().length>0,multi=kind==='out'&&b.multi,split=multi?rows().filter(function(r){return r.quantity>0;}):null;
        var path=kind==='damage'?'/inventory/'+item.id+'/damage':kind==='transfer'?(tracked?'/finished-products/'+item.id+'/units/allocate':'/inventory/'+item.id+'/transfer'):'/inventory/'+item.id+(multi?'/stock-out':'/adjust');
        var payload=kind==='damage'?{quantity:b.quantity,location_id:b.from,reason:b.reason,build_mode:b.build_mode}:kind==='transfer'?(tracked?{action:'move',unit_ids:b.unit_ids,to_location_id:b.to,build_mode:b.build_mode,reason:b.reason||null}:{from_location_id:b.from,to_location_id:b.to,amount:b.quantity,build_mode:b.build_mode,reason:b.reason||null}):multi?{quantity:b.quantity,build_mode:b.build_mode,reason:b.reason,sources:split.map(function(r){return {location_id:r.location_id,quantity:r.quantity};})}:{change:kind==='out'?-b.quantity:b.quantity,location_id:b.from,build_mode:b.build_mode,reason:b.reason};
        var summary={kind:kind,item:{id:item.id,name:item.name,sku:item.sku,unit:item.unit,is_finished_product:item.is_finished_product},quantity:b.quantity,build_mode:b.build_mode,from:pathName(b.from),to:kind==='transfer'?pathName(b.to):kind==='damage'?'Damage record':null,reason:b.reason,sources:split,serials:tracked?candidates().filter(function(u){return b.unit_ids.includes(Number(u.id));}).map(function(u){return u.identifier||'Unit #'+u.id;}):[]};
        await mWorkflow.start(s,{path:path,payload:payload,title:U.titles[kind]+' · '+item.name,queueOnOffline:kind==='damage',stockAction:summary,reviewRoute:route(kind),reviewPath:'/inventory/'+item.id});
      }catch(ex){if(alive()&&s.operation.state==='draft'){busy=false;render();form.querySelector('[data-draft-error]').textContent=ex.message;return;}if(s?.operation)s.operation.error=ex.message;}
      if(alive()&&s.operation.state!=='draft'){scope.release();mWorkflow.paint(view,s);}
    }
    function pathName(id){return mLocations.path(location(id));}
    try{s=await mWorkflow.draft(route(kind));if(!alive())return;if(s.operation.state!=='draft'){scope.release();mWorkflow.paint(view,s);return;}await load();}catch(error){if(alive())mStockUI.failure(body,error,function(){open(view,kind,picked);});}
  }
  async function pick(view,kind){
    var root=mEl('<section class="m-stock-action"></section>');view.replaceChildren(root);var scope=mReadScope.create(root);MApp.setTitle(mStockActionUI.titles[kind]);
    try{var s=await mWorkflow.draft(route(kind));if(!scope.current()||!mWorkflow.owns(s))return;if(s.operation.state!=='draft'){scope.release();mWorkflow.paint(view,s);return;}if(s.batch.item){scope.release();return open(view,s.batch.mode||kind,s.batch.item);}
      root.textContent='';var picker=mItemPicker({label:kind==='damage'?'Which item is damaged?':'Which item?',onPick:function(item){if(scope.current())return open(view,kind,item);}});root.appendChild(picker.el);picker.focus();
    }catch(error){if(scope.current())mStockUI.failure(root,error,function(){pick(view,kind);});}
  }
  window.mStockForms={open:open,pick:pick,permitted:permitted,navigate:navigate};
})();
