/* Existing batch route; shared picker, source reads, queue and saved per-row requests. */
(function () {
  var sequence=0;
  MApp.route('batch',function(view,params){
    var mode=params.mode==='out'?'out':'in',uid='batch-'+(++sequence),s,locations=[],busy=false,firstResult=true,resize,unwatch,carousel;
    MApp.setTitle('Batch Stock '+(mode==='out'?'Out':'In'));
    var root=mEl('<section class="m-batch-page" data-batch-root><div data-batch-body><p class="m-hint">Loading current batch…</p></div></section>');view.replaceChildren(root);
    var body=root.firstElementChild,scope=mReadScope.create(root,function(){unwatch?.();carousel?.destroy();resize?.disconnect();window.mQuickOrbit?.setAvoidance?.(null);});
    function alive(){return scope.current()&&(!s||mWorkflow.owns(s));}
    function feedback(error){if(alive()){var out=body.querySelector('[data-batch-feedback]');if(out)out.textContent=error.message||error;}}
    function row(id){return s.batch.rows.find(function(r){return r.item.id===Number(id);});}
    function location(){return locations.find(function(l){return Number(l.id)===Number(s.batch.location_id);});}
    function balance(r){var st=r.stock?.find(function(l){return Number(l.location_id)===Number(s.batch.location_id);}),semi=r.build_mode==='semi_built';return r.readError||!st?null:{onHand:Number(st[semi?'semi_built_quantity':'assembled_quantity']),movable:Number(st[semi?'semi_built_movable':'assembled_movable'])};}
    function issue(r){var q=Number(r.quantity),b=balance(r);if(!String(r.quantity).trim()||!Number.isSafeInteger(q)||q<=0)return 'Enter a positive whole quantity, or remove this item.';if(!b)return 'Stock has not been checked. Refresh before recording.';if(b.onHand+(mode==='out'?-q:q)<0)return 'Stock cannot go below zero. Only '+mStockUI.quantity(b.onHand,r.item.unit)+' are on hand.';if(mode==='out'&&q>b.movable)return 'Only '+mStockUI.quantity(b.movable,r.item.unit)+' are movable. Reserved or serialized stock needs its existing workflow.';return '';}
    function fit(){if(!alive())return;var dock=body.querySelector('[data-batch-dock]');root.style.setProperty('--batch-dock-height',(dock?.offsetHeight||0)+'px');window.mQuickOrbit?.setAvoidance?.(body.querySelector('[data-batch-dock]'));}
    async function save(){if(!alive())return;try{await mWorkflow.save(s);if(alive())feedback('');}catch(error){feedback('Draft not saved: '+error.message);throw error;}}
    function update(){
      if(!alive()||!body.querySelector('form'))return;
      var errors=[],totals={};
      s.batch.rows.forEach(function(r){var el=body.querySelector('[data-batch-row="'+r.item.id+'"]'),b=balance(r),q=Number(r.quantity),valid=String(r.quantity).trim()&&Number.isSafeInteger(q)&&q>0,error=issue(r);if(error)errors.push(r);
        if(valid)totals[r.item.unit||'units']=(totals[r.item.unit||'units']||0)+q;
        el.classList.toggle('has-error',!!error);el.classList.toggle('is-unchecked',!b);
        el.querySelector('[data-batch-before]').textContent=b?mStockUI.quantity(b.onHand,''):'Unknown';
        var after=b&&valid?b.onHand+(mode==='out'?-q:q):null;el.querySelector('[data-batch-after]').textContent=after===null?'—':mStockUI.quantity(after,r.item.unit);el.querySelector('[data-batch-after]').classList.toggle('negative',after!==null&&after<0);
        el.querySelector('[data-batch-balance-label]').textContent=b&&b.onHand!==b.movable?'On hand → After':'Available → After';
        var movable=el.querySelector('[data-batch-movable]');movable.hidden=!b||b.onHand===b.movable;movable.textContent=b?mStockUI.quantity(b.movable,r.item.unit)+' movable':'';
        var input=el.querySelector('[data-batch-qty]');input.disabled=busy;input.setAttribute('aria-invalid',String(!!error));
        el.querySelector('[data-batch-row-error]').hidden=!error;el.querySelector('[data-batch-row-error]').innerHTML=error?mBatchUI.icon('alert')+'<span>'+mEsc(error)+'</span>':'';
        el.querySelector('[data-batch-step="-1"]').disabled=busy||!valid||q<=1;var plus=el.querySelector('[data-batch-step="1"]'),limited=mode==='out'&&b&&q+1>b.movable;plus.disabled=busy||!valid||!Number.isSafeInteger(q+1);plus.setAttribute('aria-disabled',String(!!limited));plus.title=limited?'No more available stock at this location.':'';
        el.querySelector('[data-batch-remove]').disabled=busy;var build=el.querySelector('[data-batch-build]');if(build)build.disabled=busy;
      });
      body.querySelector('[data-batch-count]').textContent=s.batch.rows.length+' item'+(s.batch.rows.length===1?'':'s');body.querySelector('[data-batch-totals]').textContent=Object.keys(totals).map(function(u){return mStockUI.quantity(totals[u],u);}).join(' · ');
      var summary=body.querySelector('[data-batch-error-summary]');summary.hidden=!errors.length;summary.classList.toggle('warning',errors.some(function(r){return !balance(r);}));summary.innerHTML=errors.length?mBatchUI.icon('alert')+'<button type="button" data-batch-jump>'+(errors.some(function(r){return !balance(r);})?'Check stock':'Review '+errors.length+' item'+(errors.length===1?'':'s'))+mBatchUI.icon('chevron')+'</button>':'';
      var jump=summary.querySelector('button');if(jump)jump.onclick=function(){carousel?.reveal(errors[0].item.id);if(errors.some(function(r){return !balance(r);}))carousel?.openContext();var el=body.querySelector(errors.some(function(r){return !balance(r);})?'[data-batch-refresh]':'[data-batch-qty="'+errors[0].item.id+'"]');el.focus();el.scrollIntoView({block:'center'});};
      body.querySelector('[data-batch-record]').disabled=busy||!MApp.can('inventory.adjust')||!s.batch.rows.length||!!errors.length;
      body.querySelector('[data-batch-location-note]').textContent=(location()?mLocations.path(location()):'Location unavailable')+' · '+(errors.length?'Review highlighted items':s.batch.rows.length+' separate movements');
      root.classList.toggle('has-items',!!s.batch.rows.length);carousel?.sync();fit();
    }
    async function readRow(r){
      try{var response=await Promise.all([scope.run(function(opts){return API.get('/inventory/'+r.item.id,opts);}),scope.run(function(opts){return API.get('/inventory/'+r.item.id+'/stock',opts);})]);if(!alive())return;
        if(!mStockActionUI.validItem(response[0],r.item.id)||!mStockActionUI.validStock(response[1])||locations.some(function(l){return !response[1].some(function(st){return Number(st.location_id)===Number(l.id);});}))throw new Error('Current stock could not be verified.');
        r.item=response[0];r.stock=response[1];r.readError=null;if(!mStockActionUI.finished(r.item))r.build_mode='assembled';
      }catch(error){if(!error.cancelled){r.stock=null;r.readError=error.message;}else throw error;}
    }
    async function refresh(){if(busy||!alive())return;busy=true;update();try{await Promise.all(s.batch.rows.map(readRow));if(!alive())return;await save();}catch(error){feedback(error);}finally{busy=false;update();}}

    function editor(){
      if(!alive())return;carousel?.destroy();carousel=null;root.classList.remove('is-result');body.innerHTML=mBatchUI.editor(s,uid);root.dataset.batchStage=s.batch.review?'correction':'entry';
      var loc=mLocations.select({label:mode==='in'?'Receive at':'Take from',locations:locations});body.querySelector('[data-batch-location]').appendChild(loc.el);loc.select.value=String(s.batch.location_id);loc.select.disabled=!!s.batch.review;
      loc.select.onchange=function(){if(busy)return;s.batch.location_id=loc.value();update();save().catch(function(){});};
      var picker=mItemPicker({label:'Add items',onChange:function(q){root.classList.toggle('has-query',!!q.q.trim());},onPick:async function(item){
        if(busy||!alive())return;if(s.batch.review)throw new Error('Review only the rows that were not recorded.');
        if(item.unit&&typeof item.unit==='object')throw new Error('This code identifies an exact serialized unit. Use its existing unit workflow.');
        var existing=row(item.id);if(existing){if(!Number.isSafeInteger(Number(existing.quantity))||Number(existing.quantity)<1)throw new Error('Correct this item quantity before adding another.');existing.quantity=String(Number(existing.quantity)+1);}else{existing={item:item,quantity:'1',build_mode:'assembled'};await readRow(existing);if(!alive())return;s.batch.rows.push(existing);}
        s.batch.active_item_id=existing.item.id;await save();if(alive()){editor();if(root.classList.contains('is-photos'))body.querySelector('[data-batch-row]:not([hidden]) [data-batch-photo]')?.focus({preventScroll:true});else body.querySelector('.m-picker input')?.focus();}
      }});body.querySelector('[data-batch-picker]').appendChild(picker.el);if(s.batch.review)body.querySelector('[data-batch-picker]').hidden=true;
      body.querySelector('[data-batch-note]').oninput=function(e){if(!busy){s.batch.note=e.target.value;save().catch(function(){});}};
      body.querySelectorAll('[data-batch-qty]').forEach(function(input){input.oninput=function(){if(!busy){row(input.dataset.batchQty).quantity=input.value;update();save().catch(function(){});}};});
      body.querySelectorAll('[data-batch-step]').forEach(function(button){button.onclick=function(event){if(busy)return;var r=row(button.dataset.id),delta=Number(button.dataset.batchStep),b=balance(r);if(delta>0&&mode==='out'&&b&&Number(r.quantity)+1>b.movable){carousel?.rejectLimit(r.item.id,'No more stock is available at '+mLocations.path(location())+'. Quantity unchanged.',event.detail>0);return;}r.quantity=String(Math.max(1,Number(r.quantity)+delta));body.querySelector('[data-batch-qty="'+r.item.id+'"]').value=r.quantity;update();save().catch(function(){});};});
      body.querySelectorAll('[data-batch-build]').forEach(function(select){select.onchange=function(){if(!busy){row(select.dataset.batchBuild).build_mode=select.value;update();save().catch(function(){});}};});
      body.querySelectorAll('[data-batch-remove]').forEach(function(button){button.onclick=function(){if(busy)return;s.batch.rows=s.batch.rows.filter(function(r){return r.item.id!==Number(button.dataset.batchRemove);});editor();save().catch(function(){});};});
      body.querySelector('[data-batch-refresh]').onclick=refresh;
      body.querySelector('[data-batch-cancel-review]')?.addEventListener('click',function(){s.batch.review=false;save().then(results).catch(feedback);});
      body.querySelector('form').onsubmit=submit;carousel=mBatchCarousel.mount({root:root,body:body,rows:s.batch.rows,active:s.batch.active_item_id,mode:mode,balance:balance,canAdd:!s.batch.review,current:alive,busy:function(){return busy;},location:function(){return location()?mLocations.path(location()):'Location unavailable';},onActive:function(id){s.batch.active_item_id=id;save().catch(function(){});},fit:fit});resize?.disconnect();if(window.ResizeObserver){resize=new ResizeObserver(fit);resize.observe(body.querySelector('[data-batch-dock]'));}update();
    }
    async function submit(e){
      e.preventDefault();if(busy||!alive()||!MApp.can('inventory.adjust'))return;update();if(body.querySelector('[data-batch-record]').disabled)return;busy=true;body.querySelectorAll('input,select,button').forEach(function(el){el.disabled=true;});
      try{await Promise.all(s.batch.rows.map(readRow));if(!alive())return;if(s.batch.rows.some(issue)){busy=false;editor();var invalid=s.batch.rows.find(issue);if(invalid)carousel?.reveal(invalid.item.id);body.querySelector('[aria-invalid="true"]')?.focus();return;}
        await mBatchAttempt.prepare(s,s.batch.rows,{mode:mode,location_id:s.batch.location_id,location:mLocations.path(location()),note:s.batch.note});if(!alive())return;results();await mBatchAttempt.send(s,results);
      }catch(error){feedback(error);}finally{busy=false;if(alive()){if(s.operation.state==='batch'&&!s.batch.review)results();else update();}}
    }
    function results(){
      if(!alive())return;carousel?.destroy();carousel=null;window.mQuickOrbit?.setAvoidance?.(null);resize?.disconnect();root.classList.add('is-result');root.dataset.batchStage='results';var open=Array.from(body.querySelectorAll('details[open]')).map(function(d){return d.dataset.batchDisclosure;}),focus=document.activeElement?.dataset;
      body.innerHTML=mBatchUI.result(s,busy||mBatchAttempt.busy(s));open.forEach(function(id){var el=body.querySelector('[data-batch-disclosure="'+id+'"]');if(el)el.open=true;});
      if(firstResult){firstResult=false;body.querySelector('[data-batch-result-title]').focus({preventScroll:true});window.scrollTo(0,0);}
      else if(focus&&'batchCheck' in focus)body.querySelector('[data-batch-check]')?.focus({preventScroll:true});
      body.querySelector('[data-batch-check]')?.addEventListener('click',async function(){if(busy)return;busy=true;results();try{await mBatchAttempt.reconcile(s,true);}catch(error){feedback(error);}finally{busy=false;results();}});
      body.querySelector('[data-batch-review]')?.addEventListener('click',async function(){if(busy)return;s.batch.review=true;s.batch.rows=mBatchAttempt.entries(s).filter(function(r){return r.state==='refused';}).map(function(r){return{item:{id:r.id,name:r.name,sku:r.sku,unit:r.unit,is_finished_product:r.finished},quantity:String(r.quantity),build_mode:r.build_mode};});s.batch.location_id=s.operation.location_id;s.batch.note=s.operation.note;editor();await refresh();if(alive())body.querySelector('[data-batch-qty]')?.focus();});
      body.querySelector('[data-batch-new]').onclick=async function(){if(busy||mBatchAttempt.entries(s).some(mBatchAttempt.pending))return;busy=true;try{await mProductionDrafts.remove(s);if(alive())MApp.render();}catch(error){feedback(error);busy=false;}};
      body.querySelector('[data-batch-work]').onclick=function(){MApp.go('work');};
    }
    (async function(){try{s=await mBatchAttempt.load(mode);if(!alive())return;locations=await scope.run(function(opts){return mLocations.load(true,opts);});if(!alive())return;if(!locations.length)throw new Error('No stock locations are configured.');
      s.batch.mode=mode;s.batch.location_id=s.batch.location_id||(locations.find(function(l){return l.is_default;})||locations[0]).id;s.batch.rows=s.batch.rows||[];
      if(s.operation.state==='batch'&&!s.batch.review){results();await mBatchAttempt.reconcile(s,false);results();}else{editor();await refresh();}
      unwatch=mQueue.onChange(function(){if(alive()&&s.operation.state==='batch'&&!s.batch.review&&!busy)scope.later(async function(){try{await mBatchAttempt.reconcile(s,false);results();}catch(error){feedback(error);}},100);});
    }catch(error){if(alive())mStockUI.failure(body,error,function(){MApp.render();});}})();
  });
})();
