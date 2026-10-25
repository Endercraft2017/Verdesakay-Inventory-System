/* Candidate preparation presentation. The parent order workflow owns any commit;
   absent onCommit this is an explicit, read-only-to-stock design review. */
(function(){
  function number(value,label){if(value==null||typeof value==='boolean'||typeof value==='object'||typeof value==='string'&&!value.trim())throw new Error(label+' is unavailable.');var n=Number(value);if(!Number.isFinite(n)||n<0)throw new Error(label+' is unavailable.');return n;}
  function joGroup(job,availability){
    if(!job?.id||!Array.isArray(availability?.lines))throw new Error('The job requirement could not be read.');
    return{id:'jo:'+job.id,kind:'jo',record_id:job.id,title:job.number+' · '+job.product_name,location_id:number(availability.source_location_id,'Source location'),location:job.source_location_path||availability.source_location_name||job.source_location_name||'Source warehouse',lines:availability.lines.map(function(l){return{key:'jo:'+job.id+':'+l.component_item_id,item_id:l.component_item_id,need:number(l.need,'Required quantity'),saved:number(l.picked,'Picked quantity'),available:number(l.available,'Request availability'),onHand:number(l.have,'On-hand quantity'),build_mode:'assembled'};})};
  }
  function soGroups(context){
    if(!context?.order?.id||!Array.isArray(context.lines)||!Array.isArray(context.availability))throw new Error('The sales order requirement could not be read.');
    var order=context.order,groups=new Map();
    context.lines.filter(function(l){return l.item_id&&l.fulfillment_mode!=='ckd';}).forEach(function(l){
      var parent=l.parent_order_item_id?context.lines.find(function(p){return p.id===l.parent_order_item_id&&p.fulfillment_mode==='ckd';}):l;
      if(!parent)throw new Error('The component kit parent is unavailable.');
      var id='so:'+order.id+':'+parent.id;if(!groups.has(id))groups.set(id,{id:id,kind:'so',record_id:order.id,title:order.number+' · '+parent.name+(parent.fulfillment_mode==='ckd'?' · CKD kit':' · finished units'),location_id:number(order.location_id,'Ship-from location'),location:order.location_name||'Ship-from warehouse',lines:[]});
      var a=context.availability.find(function(a){return a.order_item_id===l.id;});if(!a)throw new Error('The exact sales-line availability is unavailable.');
      var need=Math.max(0,number(l.quantity,'Ordered quantity')-number(l.cancelled_qty,'Cancelled quantity')-number(l.dispatched_qty,'Dispatched quantity')),saved=number(l.held_qty,'Held allocation');
      groups.get(id).lines.push({key:'so:'+order.id+':'+l.id,line_id:l.id,item_id:l.item_id,need:need,saved:saved,available:number(a.free_to_allocate,'Free allocation')+saved,onHand:number(a.on_hand,'On-hand quantity'),build_mode:l.fulfillment_mode==='semi_built'?'semi_built':'assembled'});
    });return Array.from(groups.values());
  }
  async function open(view,options){
    var root=mEl('<section class="m-batch-page m-preparation-review"><p class="m-hint">Loading authoritative request lines…</p></section>');view.replaceChildren(root);var carousel,rows=[],groups=[],selected=0,busy=false,drafts=new Map(),scope=mReadScope.create(root,function(){carousel?.destroy();window.mQuickOrbit?.setAvoidance?.(null);});
    function alive(){return scope.current();}
    try{
      if(options.kind==='jo'){
        if(!MApp.can('production.kit_release'))throw new Error('Kit preparation permission is required.');
        groups=await Promise.all(options.ids.map(async function(id){var r=await Promise.all([scope.run(function(o){return API.get('/job-orders/'+id,o);}),scope.run(function(o){return API.get('/job-orders/'+id+'/availability',o);})]);return joGroup(r[0],r[1]);}));
      }else{
        if(!MApp.can('orders.release'))throw new Error('Sales release permission is required.');
        groups=soGroups(await scope.run(function(o){return API.get('/release-slips/orders/'+options.ids[0]+'/context',o);}));
      }
      if(!alive())return;if(!groups.length)throw new Error('No physical requirement lines are available.');
      await Promise.all(groups.map(async function(g){await Promise.all(g.lines.map(async function(l){l.item=await scope.run(function(o){return API.get('/inventory/'+l.item_id,o);});if(!mStockActionUI.validItem(l.item,l.item_id))throw new Error('The item identity could not be verified.');drafts.set(l.key,String(l.saved));}));}));if(!alive())return;
      function pool(g,l){return[g.location_id,l.item_id,l.build_mode].join(':');}
      function available(g,l){var delta=0;groups.forEach(function(other){other.lines.forEach(function(part){if(part.key!==l.key&&pool(other,part)===pool(g,l))delta+=Math.max(0,Number(drafts.get(part.key))-part.saved);});});return Math.max(0,l.available-delta);}
      function render(){
        carousel?.destroy();var g=groups[selected];rows=g.lines.map(function(l){return{item:l.item,quantity:drafts.get(l.key),build_mode:l.build_mode,line:l};});MApp.setTitle(g.kind==='jo'?'Prepare JO parts':'Prepare SO items');
        root.innerHTML='<div data-batch-body></div>';var body=root.firstElementChild;
        body.innerHTML=mBatchUI.editor({batch:{mode:'out',rows:rows,note:''}},'prepare-'+selected);
        if(!rows.length)body.querySelector('.m-batch-list').textContent='No physical stock lines are listed in this request.';var picker=body.querySelector('[data-batch-picker]');picker.hidden=true;body.querySelector('[data-batch-location]').textContent=g.location;
        var group=mEl('<label class="m-preparation-group">Product / request<select class="m-select" aria-label="Product or request">'+groups.map(function(x,i){return'<option value="'+i+'"'+(i===selected?' selected':'')+'>'+mEsc(x.title)+'</option>';}).join('')+'</select></label>');body.prepend(group);group.querySelector('select').onchange=function(){selected=Number(this.value);render();};
        body.querySelector('[data-batch-disclosure="note"]').remove();
        var footer=body.querySelector('[data-batch-dock]');footer.innerHTML='<div class="m-preparation-progress"><span>Prepared lines</span><strong class="m-preparation-status" role="status"></strong></div>'+(options.onCommit?'<div class="m-batch-record-line"><button type="button" class="m-btn" disabled>Save prepared counts</button></div>':'')+'<small>Preview only · no reservation or stock change.</small>';
        rows.forEach(function(r){var card=body.querySelector('[data-batch-row="'+r.item.id+'"]'),input=card.querySelector('[data-batch-qty]');input.min=String(g.kind==='so'?r.line.saved:0);input.setAttribute('aria-label','Prepared '+r.item.name);var wrap=mEl('<div class="m-preparation-value"></div>');input.before(wrap);wrap.appendChild(input);var target=mEl('<span class="m-preparation-target" aria-hidden="true">/ '+r.line.need+'</span>');wrap.appendChild(target);input.setAttribute('aria-describedby',input.id+'-error '+input.id+'-need');var need=mEl('<small class="m-batch-sr" id="'+input.id+'-need">Needed '+r.line.need+' '+mEsc(r.item.unit||'units')+'. Includes '+r.line.saved+' already saved.</small>');card.appendChild(need);
          card.querySelector('[data-batch-remove]').hidden=true;var build=card.querySelector('[data-batch-build]');if(build){build.value=r.build_mode;build.disabled=true;}
          input.oninput=function(){r.quantity=input.value;drafts.set(r.line.key,input.value);update();};card.querySelectorAll('[data-batch-step]').forEach(function(b){b.onclick=function(event){var n=Number(input.value),delta=Number(b.dataset.batchStep),stock=available(g,r.line),cap=Math.min(r.line.need,stock);if(delta>0&&n+1>cap){carousel.rejectLimit(r.item.id,stock<=r.line.need?'No more stock is available to this request. Quantity unchanged.':'The required total is already prepared. Quantity unchanged.',event.detail>0,stock<=r.line.need);return;}input.value=String(n+delta);input.oninput();};});
        });
        carousel=mBatchCarousel.mount({root:root,body:body,rows:rows,mode:'out',active:g.active,hideContext:true,minQuantity:0,validQuantity:function(q){return g.kind==='so'?Number.isFinite(q):Number.isSafeInteger(q);},current:alive,busy:function(){return busy;},canAdd:false,location:function(){return g.location;},balance:function(r){return{onHand:r.line.onHand,movable:available(g,r.line)};},onActive:function(id){g.active=id;},fit:function(){window.mQuickOrbit?.setAvoidance?.(body.querySelector('[data-batch-dock]'));}});
        body.querySelector('.m-batch-viewbar').appendChild(group);body.querySelector('[data-batch-context-toggle]').hidden=true;body.querySelector('[data-batch-refresh]').hidden=true;
        rows.forEach(function(r){var caption=body.querySelector('[data-batch-row="'+r.item.id+'"] .m-batch-photo-qtylabel');caption.textContent='Prepared / needed · '+(r.item.unit||'units');});
        body.querySelector('form').onsubmit=function(e){e.preventDefault();};
        if(options.onCommit)footer.querySelector('button').onclick=function(){if(options.onCommit&&!this.disabled)options.onCommit(groups.map(function(g){return{id:g.record_id,kind:g.kind,lines:g.lines.map(function(l){return{key:l.key,line_id:l.line_id,component_item_id:l.item_id,prepared:Number(drafts.get(l.key))};})};}));};
        function update(){var complete=0,errors=0;rows.forEach(function(r){var n=Number(r.quantity),valid=r.quantity.trim()!==''&&Number.isFinite(n)&&n>=(g.kind==='so'?r.line.saved:0)&&n<=r.line.need&&n<=available(g,r.line)&&(g.kind==='so'||Number.isSafeInteger(n)),card=body.querySelector('[data-batch-row="'+r.item.id+'"]'),input=card.querySelector('[data-batch-qty]'),error=card.querySelector('[data-batch-row-error]');if(n===r.line.need&&valid)complete++;if(!valid)errors++;input.setAttribute('aria-invalid',String(!valid));error.hidden=valid;error.textContent=valid?'':'Prepared quantity must be within the requirement and stock available to this request.';card.classList.toggle('has-error',!valid);card.querySelector('[data-batch-before]').textContent=mStockUI.quantity(available(g,r.line),'');card.querySelector('[data-batch-after]').textContent=Number.isFinite(n)?mStockUI.quantity(available(g,r.line)-n,r.item.unit):'—';card.querySelector('[data-batch-step="-1"]').disabled=!Number.isFinite(n)||n<=(g.kind==='so'?r.line.saved:0);var plus=card.querySelector('[data-batch-step="1"]');plus.disabled=!Number.isFinite(n);plus.setAttribute('aria-disabled',String(n+1>Math.min(r.line.need,available(g,r.line))));
            var shared=groups.reduce(function(total,other){return total+other.lines.filter(function(l){return pool(other,l)===pool(g,r.line);}).reduce(function(n,l){return n+l.need;},0);},0),meta=card.querySelector('.m-batch-meta small');meta.textContent=r.item.sku+(shared>r.line.need?' · Shared demand '+shared+' '+(r.item.unit||'units'):'');
          });var progress=footer.querySelector('.m-preparation-status');progress.textContent=errors?'Review counts':complete+' / '+rows.length;progress.setAttribute('aria-label',errors?'Review invalid prepared counts':complete+' of '+rows.length+' lines prepared for this product');if(options.onCommit)footer.querySelector('button').disabled=!!errors;root.style.setProperty('--batch-dock-height',footer.offsetHeight+'px');carousel.sync();window.mQuickOrbit?.setAvoidance?.(body.querySelector('[data-batch-dock]'));}
        update();
      }
      render();
    }catch(error){if(alive())mStockUI.failure(root,error,function(){open(view,options);});}
  }
  window.mPreparationReview={open:open,joGroup:joGroup,soGroups:soGroups};
})();
