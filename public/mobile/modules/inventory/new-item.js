/* Basic phone fields, with a durable immutable creation attempt. */
MApp.route('new-item',function(view){
  var U=mItemSetup,root=U.page(view,'New item'),scope=mReadScope.create(root),s,form,locations=[],loading=false,busy=false;
  function current(){return scope.current()&&(!s||mWorkflow.owns(s));}
  function get(k){return form.querySelector('[data-k="'+k+'"]').value.trim();}
  function fields(){return s.batch.fields;}
  function collect(){form.querySelectorAll('input[data-k],select[data-k]').forEach(function(el){fields()[el.dataset.k]=el.value;});}
  function feedback(text){var el=root.querySelector('[data-save-feedback]');if(el)el.textContent=text;}
  function persist(){return mWorkflow.save(s).catch(function(error){if(current())feedback('Draft not saved: '+error.message);throw error;});}
  function canLocations(){return MApp.can('inventory.view')||MApp.can('production.receive');}
  function render(){if(!current())return;var b=fields(),stock=MApp.can('inventory.adjust');
    root.innerHTML='<form class="setup-form" novalidate><section class="setup-card" aria-label="Item details"><div class="setup-fields">'+U.field('name','Name',b.name,'type="text" required maxlength="160" autocomplete="off"')+'<div class="setup-grid">'+U.field('sku','SKU · optional',b.sku,'type="text" maxlength="80" autocapitalize="characters"')+U.field('unit','Unit',b.unit,'type="text" maxlength="40" required')+'</div></div></section>'+
      (stock?'<section class="setup-card"><h2>Starting stock</h2><div class="setup-fields"><div class="setup-grid stock-grid">'+U.field('quantity','Quantity ('+(b.unit||'pcs')+')',b.quantity,'type="number" min="0" step="1" inputmode="numeric" required')+'<div data-location-field></div></div><p class="setup-muted">Adds stock when saved. Use 0 to create without stock.</p></div></section>':U.notice('Your access allows item creation with zero starting stock. Stock can be added later by an authorized colleague.'))+
      '<details data-optional><summary>Category &amp; reorder · optional</summary><div>'+U.field('category','Category',b.category,'type="text" maxlength="80"')+U.field('min_quantity','Reorder level · whole pieces',b.min_quantity,'type="number" min="0" step="1" inputmode="numeric" required')+'<p class="setup-muted">Photo, supplier, price and custom fields remain available on desktop.</p></div></details><div data-save-feedback class="setup-error" role="status"></div><button class="m-btn" type="submit">Create item</button></form>';
    form=root.querySelector('form');form.onsubmit=submit;
    form.querySelectorAll('input').forEach(function(input){input.oninput=function(){collect();if(input.dataset.k==='unit'){var quantity=form.querySelector('[data-k="quantity"]');if(quantity)quantity.closest('label').querySelector('.m-label').textContent='Quantity ('+(input.value.trim()||'pcs')+')';}input.removeAttribute('aria-invalid');form.querySelector('[data-error-for="'+input.dataset.k+'"]').hidden=true;persist().catch(function(){});};});
    var target=root.querySelector('[data-location-field]');if(target){
      if(canLocations()){
        if(loading){target.innerHTML='<p class="setup-muted" role="status">Loading locations…</p>';form.querySelector('[type=submit]').disabled=true;}
        else if(locations.length){var loc=mLocations.select({label:'Starting location',locations:locations});loc.select.dataset.k='location_id';if(locations.some(function(l){return Number(l.id)===Number(b.location_id);}))loc.select.value=b.location_id;else b.location_id=loc.value();target.appendChild(loc.el);loc.select.onchange=function(){collect();persist().catch(function(){});};}
        else{U.failure(target,new Error('Locations could not be loaded. Your item details are kept.'),loadLocations);form.querySelector('[type=submit]').disabled=true;}
      }else target.innerHTML=U.notice('Default location will be used.');
    }
  }
  async function loadLocations(){if(loading||!current())return;collect();loading=true;render();try{var rows=await scope.run(function(opts){return mLocations.load(true,opts);});if(!current())return;if(!rows.length)throw new Error('No starting locations are available.');locations=rows;}catch(error){if(current()&&!error.cancelled)locations=[];}finally{loading=false;if(current())render();}}
  function error(k,text){var input=form.querySelector('[data-k="'+k+'"]'),message=form.querySelector('[data-error-for="'+k+'"]');message.hidden=false;message.textContent=text;input.setAttribute('aria-invalid','true');input.setAttribute('aria-describedby',message.id);if(k==='min_quantity'||k==='category')form.querySelector('[data-optional]').open=true;return input;}
  async function submit(e){e.preventDefault();if(busy||!current())return;if(!U.canCreate()){feedback('Your access changed. Refresh before creating an item.');return;}collect();var b=fields(),bad=[];
    if(!get('name'))bad.push(error('name','Enter the item name.'));if(!get('unit'))bad.push(error('unit','Enter a unit.'));
    (MApp.can('inventory.adjust')?['quantity','min_quantity']:['min_quantity']).forEach(function(k){if(!get(k)||!Number.isSafeInteger(Number(get(k)))||Number(get(k))<0)bad.push(error(k,'Enter zero or a positive whole number.'));});
    if(bad.length){bad[0].focus();return;}
    if(MApp.can('inventory.adjust')&&canLocations()&&(loading||!locations.some(function(l){return Number(l.id)===Number(b.location_id);}))) {feedback('Load and choose a starting location before saving.');return;}
    var payload={name:get('name'),sku:get('sku')||null,unit:get('unit'),category:get('category')||null,min_quantity:Number(get('min_quantity')),quantity:MApp.can('inventory.adjust')?Number(b.quantity):0};
    if(MApp.can('inventory.adjust')&&canLocations())payload.location_id=Number(b.location_id);
    var chosen=locations.find(function(l){return Number(l.id)===Number(payload.location_id);}),detail=Object.assign({},payload,{locationName:chosen?mLocations.path(chosen):'Default location'});
    busy=true;form.querySelector('[type=submit]').disabled=true;form.querySelector('[type=submit]').textContent='Creating…';form.querySelectorAll('input,select').forEach(function(el){el.disabled=true;});
    try{await persist();if(!current())return;await mWorkflow.start(s,{path:'/inventory',payload:payload,title:'Create item',itemSetup:{kind:'create',item:detail}});if(current())mWorkflow.paint(view,s);}
    catch(error){if(current()){if(s.operation.state!=='draft')mWorkflow.paint(view,s);else{render();feedback(error.message);}}}finally{busy=false;}
  }
  async function init(){root.innerHTML='<p class="setup-muted" role="status">Loading item draft…</p>';try{
    s=await scope.run(function(){return mWorkflow.draft('new-item');});if(!current())return;if(s.operation.state!=='draft'){mWorkflow.paint(view,s);return;}
    if(!U.canCreate()){root.innerHTML=U.notice('Item creation is not available with your current access.',true);return;}
    s.batch.fields=Object.assign({name:'',sku:'',category:'',unit:'pcs',quantity:'0',min_quantity:'0'},s.batch.fields||{});loading=MApp.can('inventory.adjust')&&canLocations();render();if(loading){loading=false;await loadLocations();}
  }catch(error){if(current()&&!error.cancelled)U.failure(root,error,init);}}
  init();
});
