/* Native product/BOM definition editor. Existing stock, QC and cost settings are preserved. */
(function(){
  var R=RoleUI;
  function normalized(rows){return rows.map(function(r){return {component_item_id:Number(r.component_item_id),quantity:Number(r.quantity),notes:String(r.notes||'').trim()||null};});}
  function same(a,b){return JSON.stringify(normalized(a))===JSON.stringify(normalized(b));}
  function definitionLines(rows){if(!rows.length)return R.note('info','No components are defined for this product.');return '<dl class="m-bom-definition">'+rows.map(function(r){return '<div><dt>'+mEsc(r.name)+'</dt><dd>'+mEsc(r.quantity+' '+(r.unit||'pcs'))+'</dd>'+(r.notes?'<p>'+mEsc(r.notes)+'</p>':'')+'</div>';}).join('')+'</dl>';}
  function canWrite(){return MApp.can('production.configure');}
  function card(product){return R.jobCard({id:product.id,number:product.name,name:product.sku||'No SKU',meta:product.component_count+' components per '+(product.unit||'unit')});}
  async function open(view,params){
    MApp.setTitle('Products & BOM');var body=R.page(view,{role:'manager',title:'Products & BOM',subtitle:'Define the components needed for one finished unit'}),scope=mReadScope.create(body),s,product,chain=Promise.resolve(),saving=false,confirmation;
    body.innerHTML='<p class="m-hint" role="status">Loading products &amp; BOM…</p>'+R.skeleton(1);
    function alive(){return scope.current()&&(!s||mWorkflow.owns(s));}
    function fail(error){if(alive()){body.innerHTML='';body.appendChild(R.error(error,function(){MApp.render();}));}}
    function persist(){chain=chain.catch(function(){}).then(function(){return mWorkflow.save(s);});return chain;}
    function draftError(error){if(alive()){var el=body.querySelector('[data-bom-error]');if(el)el.textContent='Draft could not be saved: '+error.message;}}
    function dirty(){return s&&(!product.is_finished_product||!same(s.batch.baseline,s.batch.components));}
    function message(text,selector){var error=body.querySelector('[data-bom-error]');error.textContent=text;if(selector)body.querySelector(selector)?.focus();}
    function leave(proceed){
      if(confirmation){confirmation.focus();return;}
      var dialog=mEl('<div class="m-bom-confirm" aria-label="Discard BOM draft?"><section><h2>Discard BOM draft?</h2><p>Your component changes have not been saved to the product.</p><div class="rk-actions"><button type="button" class="rk-btn secondary" data-keep>Keep editing</button><button type="button" class="rk-btn danger" data-discard>Discard draft</button></div><p role="alert" data-error></p></section></div>');
      document.body.appendChild(dialog);var discarding=false;var control=MessageOverlay.mount(dialog,{initialFocus:'[data-keep]',canClose:function(){return !discarding;},onClose:function(){confirmation=null;}});confirmation=control;dialog.querySelector('[data-keep]').onclick=function(){control.close();};dialog.querySelector('[data-discard]').onclick=async function(){this.disabled=true;discarding=true;try{await chain;await mProductionDrafts.remove(s);discarding=false;control.close();proceed();}catch(e){discarding=false;this.disabled=false;dialog.querySelector('[data-error]').textContent=e.message;}};
    }
    function arm(){mPersonalDraft.arm(dirty,function(){return saving;},{preserveOnRender:true,confirmLeave:leave,busyText:function(){return 'Wait for the BOM save to finish.';}});}
    async function review(){
      if(!alive()||!canWrite()||saving)return;
      var seen=new Set();for(var i=0;i<s.batch.components.length;i++){var line=s.batch.components[i];if(!Number.isSafeInteger(Number(line.quantity))||Number(line.quantity)<=0){message('Every component needs a whole quantity above zero.','[data-bom-qty="'+i+'"]');return;}if(Number(line.component_item_id)===Number(product.id)||seen.has(Number(line.component_item_id))){message('Choose distinct components and keep the product out of its own BOM.');return;}seen.add(Number(line.component_item_id));}
      saving=true;try{await persist();var current=await scope.run(function(opts){return API.get('/finished-products/'+product.id,opts);});if(!alive())return;if(!same(current.bom,s.batch.baseline)){message('The BOM changed while this draft was open. Reload the current BOM before saving.');body.querySelector('[data-bom-reload]').hidden=false;return;}
        body.innerHTML='<section class="rk-card m-bom-review"><h2 tabindex="-1">Review BOM</h2><p><b>'+mEsc(product.name)+'</b> · quantities per 1 '+mEsc(product.unit||'unit')+'</p>'+definitionLines(s.batch.components)+R.note('info','Saving changes this product definition. It does not move stock or rewrite existing job-order component plans.')+(!s.batch.components.length?R.note('warn','No components: builds using this definition will not reserve or consume BOM parts.')+R.check('bom-empty-confirm','I understand this product will have no required BOM components.'):'')+'<p class="m-error" data-bom-error role="alert"></p>'+R.actions([{id:'bom-save',label:'Save BOM',kind:'primary'},{id:'bom-edit',label:'Back to editing',kind:'secondary'}])+'</section>';
        body.querySelector('#bom-edit').onclick=function(){renderEditor('[data-bom-qty], [data-bom-picker] input');};body.querySelector('#bom-save').onclick=save;body.querySelector('h2').focus();
      }catch(e){if(alive())message(e.message);}finally{saving=false;}
    }
    async function save(){
      if(!alive()||!canWrite()||saving)return;if(!s.batch.components.length&&!body.querySelector('#bom-empty-confirm')?.checked){message('Confirm the empty BOM before saving.','#bom-empty-confirm');return;}
      saving=true;body.querySelector('#bom-save').disabled=true;
      try{await persist();if(!alive())return;mPersonalDraft.clear();await mWorkflow.start(s,{method:'put',path:'/finished-products/'+product.id,payload:{components:normalized(s.batch.components),expected_components:normalized(s.batch.baseline)},bomSetup:true,title:'Save BOM for '+product.name,successLabel:'BOM saved',role:'manager',reviewRoute:'product-setup',reviewParams:{id:product.id},reviewPath:'/finished-products/'+product.id,discardDraftOnReject:true});if(alive())mWorkflow.paint(view,s);}
      catch(e){if(alive()){message(e.message);body.querySelector('#bom-save').disabled=false;arm();}}finally{saving=false;}
    }
    function renderEditor(focusSelector){
      if(!alive())return;
      body.innerHTML='<div class="rk-card rk-field"><small>Product</small><b>'+mEsc(product.name)+'</b><span>'+mEsc(product.sku||'No SKU')+' · per 1 '+mEsc(product.unit||'unit')+'</span></div>'+R.note('info','Component quantities apply to one finished unit. Saving a BOM does not add or remove stock.')+'<section class="m-bom-components"><h2>Components</h2><div data-bom-lines>'+s.batch.components.map(function(r,i){return '<section class="rk-card m-bom-line"><div><strong>'+mEsc(r.name)+'</strong><small>'+mEsc(r.sku||'')+'</small></div><label class="m-field"><span class="m-label">Quantity ('+mEsc(r.unit||'pcs')+')</span><input class="m-input" type="number" min="1" step="1" inputmode="numeric" data-bom-qty="'+i+'" value="'+mEsc(r.quantity)+'"></label><label class="m-field"><span class="m-label">Notes · optional</span><input class="m-input" maxlength="300" data-bom-notes="'+i+'" value="'+mEsc(r.notes||'')+'"></label><button type="button" class="rk-btn secondary" data-bom-remove="'+i+'" aria-label="Remove '+mEsc(r.name)+'">Remove component</button></section>';}).join('')+'</div><div class="rk-card m-bom-add"><h3>Add a component</h3><div data-bom-picker></div></div></section><p class="m-error" data-bom-error role="alert"></p><button type="button" class="rk-btn secondary" data-bom-reload hidden>Discard draft and reload current BOM</button>'+R.actions([{id:'bom-review',label:'Review BOM',kind:'primary'},{id:'bom-cancel',label:'Back to products',kind:'secondary'}]);
      body.querySelectorAll('[data-bom-qty]').forEach(function(input){input.oninput=function(){if(!alive()||!canWrite())return;s.batch.components[Number(input.dataset.bomQty)].quantity=input.value;persist().catch(draftError);};});
      body.querySelectorAll('[data-bom-notes]').forEach(function(input){input.oninput=function(){if(!alive()||!canWrite())return;s.batch.components[Number(input.dataset.bomNotes)].notes=input.value;persist().catch(draftError);};});
      body.querySelectorAll('[data-bom-remove]').forEach(function(b){b.onclick=function(){if(!alive()||!canWrite())return;s.batch.components.splice(Number(b.dataset.bomRemove),1);persist().catch(draftError);renderEditor('[data-bom-qty], [data-bom-picker] input');};});
      if(MApp.can('inventory.view')){var picker=mItemPicker({label:'Find a component',onPick:function(item){if(!alive()||!canWrite())return;if(Number(item.id)===Number(product.id)||s.batch.components.some(function(r){return Number(r.component_item_id)===Number(item.id);})){message('This component is already listed, or is the product itself.');return;}s.batch.components.push({component_item_id:Number(item.id),name:item.name,sku:item.sku,unit:item.unit,quantity:1,notes:null});persist().catch(draftError);renderEditor('[data-bom-qty="'+(s.batch.components.length-1)+'"]');}});body.querySelector('[data-bom-picker]').appendChild(picker.el);}else body.querySelector('[data-bom-picker]').textContent='Adding a component requires inventory catalog access.';
      body.querySelector('#bom-review').onclick=review;body.querySelector('#bom-cancel').onclick=function(){MApp.go('product-setup');};body.querySelector('[data-bom-reload]').onclick=function(){leave(function(){mPersonalDraft.clear();MApp.render();});};arm();if(focusSelector)body.querySelector(focusSelector)?.focus();
    }
    try{
      if(!params.id){
        if(params.new){if(!canWrite())throw Error('BOM editing requires production configuration access.');if(!MApp.can('inventory.view'))throw Error('Choosing a new product item requires inventory catalog access.');body.innerHTML=R.note('info','Choose an existing inventory item to define as a finished product. This does not create stock.')+'<div data-product-picker></div>';var picker=mItemPicker({label:'Choose the product item',onPick:function(item){if(alive())MApp.go('product-setup',{id:item.id,edit:1});}});body.querySelector('[data-product-picker]').appendChild(picker.el);return;}
        var rows=await scope.run(function(opts){return API.get('/finished-products',opts);});if(!alive())return;
        body.innerHTML='<label class="m-field"><span class="m-label">Search products</span><input class="m-input" type="search" data-bom-search></label>'+(canWrite()&&MApp.can('inventory.view')?R.actions([{id:'bom-new',label:'Set up a finished product',kind:'primary'}]):'')+'<div class="rk-list" data-bom-products></div>';
        function paint(){var q=body.querySelector('[data-bom-search]').value.trim().toLowerCase();body.querySelector('[data-bom-products]').innerHTML=rows.filter(function(p){return (p.name+' '+(p.sku||'')).toLowerCase().includes(q);}).map(card).join('')||R.note('info',rows.length?'No products match this search.':'No finished products have been set up yet.');body.querySelectorAll('[data-bom-products] [data-id]').forEach(function(b){b.onclick=function(){MApp.go('product-setup',{id:b.dataset.id});};});}body.querySelector('[data-bom-search]').oninput=paint;body.querySelector('#bom-new')?.addEventListener('click',function(){MApp.go('product-setup',{new:1});});paint();return;
      }
      product=await scope.run(function(opts){return API.get('/finished-products/'+Number(params.id),opts);});if(!alive())return;if(!product||!Array.isArray(product.bom))throw Error('The BOM could not be read. Retry this check.');
      if(!canWrite()){
        body.innerHTML=R.jobHead({number:product.name,name:product.sku||'Product',meta:'Components per 1 '+(product.unit||'unit')})+definitionLines(product.bom.map(function(r){return {name:r.component_name,quantity:r.quantity,unit:r.component_unit,notes:r.notes};}))+R.note('info','You can view this BOM. Editing requires production configuration access.');return;
      }
      s=await mWorkflow.draft('bom-'+product.id);if(!alive())return;if(s.operation.state!=='draft'){mWorkflow.paint(view,s);return;}
      if(!s.batch.initial){s.batch={initial:true,productId:product.id,baseline:normalized(product.bom),components:product.bom.map(function(r){return {component_item_id:r.component_item_id,name:r.component_name,sku:r.component_sku,unit:r.component_unit,quantity:r.quantity,notes:r.notes};})};await persist();}
      renderEditor();
    }catch(e){fail(e);}
  }
  window.mBomData={normalized:normalized,same:same};MApp.route('product-setup',open);
})();
