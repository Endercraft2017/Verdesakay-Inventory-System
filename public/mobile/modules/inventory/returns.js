/* Slip-bound customer returns. Receipt is custody only; inspection owns stock-in. */
(function(){
  var R=RoleUI,can=function(p){return MApp.can(p);};
  function go(p){MApp.go('returns',p||{});}
  function page(view,title){return R.page(view,{role:'releasing',node:'78:438',title:title,subtitle:'Original sale and release history stay intact'});}
  function field(label,html){return '<label class="rk-card rk-field"><small>'+label+'</small>'+html+'</label>';}
  function note(){return field('Condition / reason','<textarea class="rk-input" data-note maxlength="500"></textarea>');}
  async function decide(view,s,path,payload,title,params,photos){
    await mWorkflow.start(s,{path:path,payload:payload,title:title,reviewRoute:'returns',reviewParams:params,reviewPath:params.id?'/sales-returns/'+params.id:'/sales-returns/slips/'+params.slip+'/context',photoKind:'sales_return_proof',photoRef:params.slip,resultParam:path==='/sales-returns'?'id':null});mWorkflow.paint(view,s);
  }
  async function receive(view,slip,s){
    var hash=location.hash,c=await API.get('/sales-returns/slips/'+slip+'/context'),b=s.batch;if(hash!==location.hash||!mWorkflow.owns(s))return;
    if(b.slip&&b.slip!==slip){go({slip:b.slip});return;}b.slip=slip;
    var body=page(view,'Receive customer return');
    body.innerHTML=R.field('Original release slip',c.slip.number)+R.note('info','Receipt does not add sellable stock or issue a refund. Photograph the goods; inspect them separately.')+
      field('Shipped line','<select class="rk-input" data-line>'+c.lines.filter(function(l){return l.quantity-l.returned_qty>0;}).map(function(l){return '<option value="'+l.id+'">'+mEsc(l.name)+' · '+(l.quantity-l.returned_qty)+' returnable</option>';}).join('')+'</select>')+
      '<div data-source></div>'+field('Return quantity','<input class="rk-input" type="number" min="0.001" step="any" data-quantity value="'+(b.quantity||1)+'">')+note()+'<div data-photos></div>'+R.actions([{id:'ret-save',label:'Record return receipt',kind:'primary'},{id:'ret-back',label:'Back to returns',kind:'secondary'}]);
    var line=body.querySelector('[data-line]');if(b.line)line.value=b.line;
    body.querySelector('[data-note]').value=b.note||'';
    function source(){var l=c.lines.find(function(l){return l.id===Number(line.value);}),units=c.units.filter(function(u){return l&&u.order_item_id===l.order_item_id;}),lots=c.batches.filter(function(a){return l&&a.order_item_id===l.order_item_id;});
      body.querySelector('[data-source]').innerHTML=units.length?field('Exact sold serial','<select class="rk-input" data-unit>'+units.map(function(u){return '<option value="'+u.id+'">'+mEsc(u.identifier||'Unit #'+u.id)+'</option>';}).join('')+'</select>'):lots.length?field('Exact shipped batch','<select class="rk-input" data-batch>'+lots.map(function(a){return '<option value="'+a.batch_id+'">'+mEsc(a.batch_number)+' · '+a.shipped_quantity+' shipped</option>';}).join('')+'</select>'):'';
      var serial=body.querySelector('[data-unit]'),batch=body.querySelector('[data-batch]');
      if(serial){if(units.some(function(u){return u.id===b.unit;}))serial.value=String(b.unit);serial.onchange=function(){save().catch(function(e){mToast(e.message,'err');});};}
      if(batch){if(lots.some(function(a){return a.batch_id===b.batch;}))batch.value=String(b.batch);batch.onchange=function(){save().catch(function(e){mToast(e.message,'err');});};}
      var q=body.querySelector('[data-quantity]');q.disabled=!!units.length;if(units.length)q.value=1;
    }source();
    var photos=mPhoto.picker({initial:s.rows.map(function(r){return r.file;}),onChange:function(files){s.rows=files.map(function(file,i){return {file:file,identifier:'return-'+i+'.jpg'};});mWorkflow.save(s).catch(function(e){mToast(e.message,'err');});}});body.querySelector('[data-photos]').appendChild(photos);
    function save(){b.line=Number(line.value);b.quantity=Number(body.querySelector('[data-quantity]').value);b.note=body.querySelector('[data-note]').value;b.unit=body.querySelector('[data-unit]')?Number(body.querySelector('[data-unit]').value):null;b.batch=body.querySelector('[data-batch]')?Number(body.querySelector('[data-batch]').value):null;return mWorkflow.save(s);}
    line.onchange=function(){source();save().catch(function(e){mToast(e.message,'err');});};body.querySelectorAll('input,textarea').forEach(function(e){e.onchange=save;});
    body.querySelector('#ret-back').onclick=function(){go();};
    body.querySelector('#ret-save').onclick=async function(){var btn=this;try{await save();var l=c.lines.find(function(l){return l.id===b.line;});if(!l||!Number.isFinite(b.quantity)||b.quantity<=0||b.quantity>l.quantity-l.returned_qty)throw new Error('Enter a quantity within the remaining shipped amount.');if(b.note.trim().length<5)throw new Error('Describe the return reason (at least five characters).');if(!s.rows.length)throw new Error('Photograph the returned goods first.');btn.disabled=true;await decide(view,s,'/sales-returns',{slip_id:slip,slip_item_id:b.line,quantity:b.quantity,unit_id:b.unit,batch_id:b.batch,reason:b.note.trim()},'Receive returned goods; no stock added',{slip:slip});}catch(e){mToast(e.message,'err');btn.disabled=false;}};
  }
  async function detail(view,id,s){
    var hash=location.hash,r=await API.get('/sales-returns/'+id),events=await API.get('/sales-returns/'+id+'/events');if(hash!==location.hash||!mWorkflow.owns(s))return;var body=page(view,r.number);
    body.innerHTML=R.field('Goods',r.quantity+' × '+r.item_name)+R.field('Original slip',r.slip_number)+R.field('Status',r.status+(r.disposition_state?' · '+r.disposition_state:''))+R.field('Reason',r.reason||'—')+R.field('Condition',r.condition_note||'Awaiting inspection')+R.note('info','Physical return handling does not issue a customer credit. Finance handles refunds separately.')+'<div data-evidence></div>'+
      (events.length?R.section('Disposition history')+events.map(function(e){return R.field(e.action,e.note);}).join(''):'')+'<div data-decision></div>'+R.actions([{id:'ret-list',label:'Back to returns',kind:'secondary'}]);
    if((can('inventory.view')||can('inventory.adjust')||can('orders.release')||can('orders.view'))&&mPhoto.thumbs)body.querySelector('[data-evidence]').appendChild(mPhoto.thumbs('sales_return',id,{editable:false}));
    var choices=[],action=null;
    if(can('inventory.adjust')&&r.status==='received'){action='inspect';choices=['restock','reject'];}
    else if(can('inventory.adjust')&&r.status==='rejected'&&!r.disposition_state){action='disposition';choices=r.unit_id?['repair','salvage','dispose']:['salvage','dispose'];}
    else if(can('inventory.adjust')&&r.disposition_state==='awaiting_inspection'){action='reinspect';choices=['restock','reject'];}
    else if((can('inventory.adjust')||can('production.inspect_qc')||can('production.inspect_qa'))&&r.disposition_state==='repair'){action='repair-complete';}
    if(action){if(choices.length)await mLocations.load();if(hash!==location.hash||!mWorkflow.owns(s)||!body.isConnected)return;var box=body.querySelector('[data-decision]');box.innerHTML=R.section(action.replace(/-/g,' '))+(choices.length?field('Decision','<select class="rk-input" data-decision>'+choices.map(function(c){return '<option>'+c+'</option>';}).join('')+'</select>'):'')+note()+'<div data-location></div>'+R.actions([{id:'ret-decide',label:'Review and confirm decision',kind:'primary'}]);var receivingLocation=choices.length?mLocations.select({label:'Restock / salvage location'}):null;if(receivingLocation)box.querySelector('[data-location]').appendChild(receivingLocation.el);
      box.querySelector('#ret-decide').onclick=async function(){var btn=this;try{var n=box.querySelector('[data-note]').value.trim();if(n.length<5)throw new Error('Record the inspection or disposition reason.');var d=box.querySelector('[data-decision]'),payload=d?{decision:d.value,location_id:receivingLocation.value()}:{};payload[action==='inspect'||action==='reinspect'?'condition_note':'note']=n;btn.disabled=true;await decide(view,s,'/sales-returns/'+id+'/'+action,payload,r.number+' · '+action+(d?' · '+d.value:''),{id:id});}catch(e){mToast(e.message,'err');btn.disabled=false;}};
    }
    if(r.disposition_state==='repair'&&r.unit_id&&(can('inventory.adjust')||can('production.inspect_qc')||can('production.inspect_qa'))){
      var parts=document.createElement('button');parts.className='rk-btn secondary';parts.textContent='Request repair parts';body.appendChild(parts);parts.onclick=function(){var box=page(view,'Return repair parts'),picked=null;box.innerHTML=R.field('Return',r.number)+'<div data-picker></div>'+field('Quantity','<input class="rk-input" type="number" min="1" step="1" value="1" data-part-qty>')+note()+R.actions([{id:'return-part-save',label:'Send parts request',kind:'primary'}]);var picker=mItemPicker({label:'Replacement component',onPick:function(item){picked=item;}});box.querySelector('[data-picker]').appendChild(picker.el);box.querySelector('#return-part-save').onclick=async function(){var btn=this;try{var qty=Number(box.querySelector('[data-part-qty]').value);if(!picked||!Number.isInteger(qty)||qty<1)throw new Error('Select a component and a whole quantity.');btn.disabled=true;await decide(view,s,'/production/units/'+r.unit_id+'/repairs',{kind:'add',component_item_id:picked.id,quantity:qty,notes:box.querySelector('[data-note]').value.trim()||null},'Repair parts for '+r.number,{id:r.id});}catch(e){mToast(e.message,'err');btn.disabled=false;}};};
    }
    body.querySelector('#ret-list').onclick=function(){go();};
  }
  MApp.route('returns',async function(view,p){
    p=p||{};if(!['inventory.view','inventory.adjust','orders.release','orders.view','production.inspect_qc','production.inspect_qa'].some(can)){view.textContent='Return access is not permitted.';return;}
    var hash=location.hash;view.innerHTML=R.skeleton(2);
    try{var s=await mWorkflow.draft('returns');if(hash!==location.hash||!mWorkflow.owns(s))return;if(s.operation.state!=='draft'){mWorkflow.paint(view,s);return;}
      if(s.batch.slip&&Number(p.slip)!==s.batch.slip&&!p.id){p.slip=s.batch.slip;}
      if(p.id&&s.batch.slip){var prompt=page(view,'Saved return draft');prompt.innerHTML=R.note('warn','Resume or explicitly discard the unsent receipt before another return decision.')+R.actions([{id:'ret-resume',label:'Resume return receipt',kind:'primary'},{id:'ret-discard',label:'Discard unsent draft',kind:'secondary'}]);prompt.querySelector('#ret-resume').onclick=function(){go({slip:s.batch.slip});};prompt.querySelector('#ret-discard').onclick=async function(){await mProductionDrafts.remove(s);go({id:p.id});};return;}
      if(p.id)return await detail(view,Number(p.id),s);
      if(p.slip){if(!can('inventory.adjust')&&!can('orders.release'))throw new Error('Return receipt permission is required.');return await receive(view,Number(p.slip),s);}
      var full=['inventory.view','inventory.adjust','orders.release','orders.view'].some(can),rows=await API.get(full?'/sales-returns':'/sales-returns/repair-queue'),slips=full?await API.get('/release-slips'):[];if(hash!==location.hash)return;
      var body=page(view,'Customer returns');body.innerHTML=R.section('Return records')+(rows.length?rows.map(function(r){return R.jobCard({id:r.id,number:r.number,name:r.item_name,pill:{text:r.status},meta:(r.slip_number||'Serialized repair')+' · '+r.quantity+' received'});}).join(''):R.note('info','No return records.'))+R.section('Receive against an issued slip')+(can('inventory.adjust')||can('orders.release')?slips.map(function(sl){return '<button class="rk-card rk-unitcard" data-slip="'+sl.id+'"><b>'+mEsc(sl.number)+'</b><small>'+mEsc(sl.order_number||'')+'</small></button>';}).join(''):'');
      body.querySelectorAll('[data-id]').forEach(function(b){b.onclick=function(){go({id:b.dataset.id});};});body.querySelectorAll('[data-slip]').forEach(function(b){b.onclick=function(){go({slip:b.dataset.slip});};});
    }catch(e){if(hash===location.hash){view.innerHTML='';view.appendChild(R.error(e,function(){MApp.render();}));}}
  });
})();
