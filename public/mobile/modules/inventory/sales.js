/* Sales owns commercial follow-up. Physical stock actions remain in #/so. */
(function(){
  var R=RoleUI, renderSerial=0;
  function csr(){return MApp.can('orders.view')&&(MApp.can('orders.create')||MApp.can('orders.edit')||MApp.can('orders.approve'));}
  function go(p){MApp.go('sales',p||{});}
  function page(view,title,sub){return R.page(view,{role:'Sales',title:title,subtitle:sub});}
  function field(label,key,value,type){return '<label class="rk-card rk-field"><small>'+mEsc(label)+'</small><input class="rk-input" data-'+key+' type="'+(type||'text')+'" value="'+mEsc(value==null?'':value)+'"></label>';}
  function stage(r,q){if((r.release_slip_number&&!r.backordered)||['completed','fulfilled'].includes(r.status))return 3;if((q.releasing||[]).some(function(x){return x.id===r.id;})||r.status==='released')return 2;if((q.to_accept||[]).some(function(x){return x.id===r.id;})||r.status==='approved')return 1;return 0;}
  var stages=['Sales review','Awaiting warehouse','Picking / release','Shipped / complete'];
  // The rail reflects facts returned by the existing order/queue reads. It does
  // not infer shortages from an open order or change workflow eligibility.
  function orderCue(r,q){
    if(r.status==='cancelled')return {tone:'neutral',label:'Cancelled'};
    if(r.backordered)return {tone:'attention',label:'Needs attention: outstanding goods'};
    if(stage(r,q)===3)return {tone:'neutral',label:'Shipped / complete'};
    if(r.status==='open')return {tone:'open',label:'Open'};
    return {tone:'pending',label:'Pending · '+String(r.status||'status not provided').replace(/_/g,' ')};
  }
  function orderCard(r,q){
    var cue=orderCue(r,q),name=r.customer_name||'No customer';
    return '<button type="button" class="rk-card sales-order" data-id="'+mEsc(r.id)+'" aria-label="'+mEsc(r.number+' · '+name+' · '+cue.label)+'">'+
      '<span class="sales-order-number">'+mEsc(r.number)+'</span><span class="sales-order-customer" title="'+mEsc(name)+'">'+mEsc(name)+'</span>'+
      '<span class="sales-order-rail m-status-rail '+cue.tone+'" title="'+mEsc(cue.label)+'" aria-hidden="true"><img class="rk-go" src="/mobile/icons/v2/open-chevron.svg" alt=""></span></button>';
  }
  async function list(view,tracking){
    var body=page(view,tracking?'Order tracking':'Sales pipeline',tracking?'Read-only stock and fulfilment progress':'Customer service · actual order and trip records'),screen=body.closest('.rk-page');screen.classList.add('sales-pipeline');var head=screen.querySelector('.rk-head');head.replaceChildren(head.querySelector('h1'));head.classList.add('sales-sr-only');body.innerHTML=R.skeleton(3);
    var result=await Promise.all([API.get('/orders?type=sale'),API.get('/release-slips/queue')]);if(!body.isConnected)return;var rows=result[0],q=result[1];
    body.innerHTML='<label class="rk-card rk-field sales-search"><small>Customer or Order Number</small><input type="search" class="rk-input" data-search></label><label class="rk-card rk-field sales-stage-filter"><small>Stage</small><select data-stage><option value="">All active stages</option>'+stages.map(function(s,i){return '<option value="'+i+'">'+s+'</option>';}).join('')+'<option value="cancelled">Cancelled</option></select></label>'+R.actions((!tracking&&MApp.can('orders.create')?[{id:'sale-new',label:'New sale order',kind:'primary'}]:[]).concat(!tracking?[{id:'sale-customers',label:'Customers',kind:'secondary'}]:[]))+'<div data-sales-list></div>';
    function paint(){var text=body.querySelector('[data-search]').value.toLowerCase(),filter=body.querySelector('[data-stage]').value,host=body.querySelector('[data-sales-list]');host.innerHTML='';
      var filtered=rows.filter(function(r){return (r.number+' '+r.customer_name).toLowerCase().includes(text)&&(filter==='cancelled'?r.status==='cancelled':r.status!=='cancelled'&&(filter===''||stage(r,q)===Number(filter)));});
      (filter==='cancelled'?['Cancelled']:stages).forEach(function(title,i){var group=filtered.filter(function(r){return filter==='cancelled'||stage(r,q)===i;});if(!group.length)return;host.insertAdjacentHTML('beforeend','<section class="sales-stage">'+R.section(title+' · '+group.length)+'<div class="rk-list">'+group.map(function(r){return orderCard(r,q);}).join('')+'</div></section>');});
      if(!filtered.length)host.innerHTML=R.note('info','No orders match this view.');host.querySelectorAll('[data-id]').forEach(function(b){b.onclick=function(){MApp.go(tracking?'order-tracking':'sales',{id:b.dataset.id});};});
    }
    body.querySelector('[data-search]').oninput=paint;body.querySelector('[data-stage]').onchange=paint;paint();
    if(body.querySelector('#sale-new'))body.querySelector('#sale-new').onclick=function(){go({step:'new'});};if(body.querySelector('#sale-customers'))body.querySelector('#sale-customers').onclick=function(){MApp.go('customers');};
  }
  async function detail(view,id,tracking){
    var body=page(view,'Sale order','Loading current order…');body.innerHTML=R.skeleton(2);
    var result=await Promise.all([API.get('/orders/'+id),API.get('/orders/'+id+'/availability'),API.get('/release-slips/queue')]);if(!body.isConnected)return;
    var r=result[0],av=result[1],customerJob=r.type==='job';if(r.type!=='sale'&&!customerJob)throw Error('This is not a customer order.');var s=stage(r,result[2]);
    var saved=!tracking&&!customerJob&&MApp.can('orders.approve')?await mWorkflow.load('sale-approval-'+id):null;if(!body.isConnected)return;
    body.innerHTML=R.jobHead({number:r.number,name:customerJob?'Customer job order · view only':'Sales order',meta:r.customer_name||'No customer'})+
      R.field('Status / next owner',r.status+' · '+(customerJob?'Production planning':s===0?'Sales / CSR':s===1||s===2?'Warehouse releasing':'Delivery / customer'))+
      (!customerJob?R.field('Stage',stages[s])+mSaleUI.deliveryFacts(r):R.note('info','Customer JO records are read-only in Sales, including for administrators. Production planning belongs to the Production desk.'))+
      R.field('Customer contact',r.customer_contact||'—')+R.field('Notes',r.notes||'—')+
      R.section('Order lines')+R.lines((r.items||[]).map(function(x){return {name:x.name,qty:x.quantity+' '+(x.unit||''),detail:x.fulfillment_mode==='semi_built'?'Semi-built':x.fulfillment_mode==='ckd'?'CKD':'Assembled / part',ok:true};}))+
      (!customerJob?R.section('Stock readiness')+R.lines((av.lines||[]).map(function(x){return {name:x.name||'Line '+x.order_item_id,qty:'Short '+(x.shortfall||0),detail:'Available '+(x.available==null?'Check picking desk':x.available),ok:!x.shortfall};}))+mSaleUI.productionJobs(av)+
        R.section('Issued trips')+((r.trips||[]).length?r.trips.map(function(t){return R.field(t.number,t.released_at);}).join(''):R.note('info','No warehouse-out slip issued. Allocation holds stock; only a trip slip records stock-out.')):'')+
      R.actions((!tracking&&!customerJob&&MApp.can('orders.edit')&&['draft','open'].includes(r.status)?[{id:'sale-edit',label:'Edit customer / target / notes',kind:'secondary'}]:[])
        .concat(!tracking&&!customerJob&&MApp.can('orders.approve')&&(saved&&saved.operation.state!=='draft'||['draft','open'].includes(r.status))?[{id:'sale-approve',label:saved&&saved.operation.state!=='draft'?'Review saved approval':'Review approval',kind:'primary'}]:[])
        .concat(!tracking&&!customerJob&&MApp.can('orders.release')&&s<3&&r.status!=='cancelled'?[{id:'sale-release',label:'Open releasing workflow',kind:'primary'}]:[])
        .concat(!tracking&&!customerJob&&MApp.can('orders.authorize')&&s<3&&['approved','released'].includes(r.status)?[{id:'sale-authorize',label:'Authorize release / partial trips',kind:'secondary'}]:[])
        .concat([{id:'sale-back',label:'Back to '+(tracking?'tracking':'pipeline'),kind:'secondary'}]));
    if(!tracking&&!customerJob&&MApp.can('orders.authorize')){var authorizations=await API.get('/release-slips/orders/'+id+'/authorizations');if(!body.isConnected)return;var current=(authorizations.history||[]).find(function(a){return !a.revoked_at&&!a.used_slip_id;});if(current)body.insertAdjacentHTML('beforeend',R.section('Current release authorization')+R.field('Recipient / mode',current.recipient_name+' · '+current.mode)+R.field('Release token',current.token||'—')+R.field('Partial trips',current.partial_allowed?'Authorized':'Full order only'));}
    if(body.querySelector('#sale-authorize'))body.querySelector('#sale-authorize').onclick=function(){go({id:id,step:'authorize'});};
    if(body.querySelector('#sale-edit'))body.querySelector('#sale-edit').onclick=function(){go({id:id,step:'edit'});};
    if(body.querySelector('#sale-approve'))body.querySelector('#sale-approve').onclick=function(){go({id:id,step:'approve'});};
    if(body.querySelector('#sale-release'))body.querySelector('#sale-release').onclick=function(){MApp.go('so',{id:id});};
    body.querySelector('#sale-back').onclick=function(){MApp.go(tracking?'order-tracking':'sales');};
  }
  async function approve(view,id){
    if(!MApp.can('orders.approve'))throw Error('Sale approval permission is required.');
    var body=page(view,'Review sale approval','Current stock and production handoff');body.innerHTML=R.skeleton(2);
    var saved=await mWorkflow.draft('sale-approval-'+id);if(!body.isConnected)return;
    if(saved.operation.state!=='draft')return mSaleUI.paintApproval(view,saved,id);
    var result=await Promise.all([API.get('/orders/'+id),API.get('/orders/'+id+'/availability')]);if(!body.isConnected)return;
    var order=result[0],av=result[1];if(order.type!=='sale')throw Error('Customer JO records are read-only in Sales.');
    if(!['open','draft'].includes(order.status)){body.innerHTML=R.note('info','This sale is already '+mEsc(order.status)+'. Review its current record instead of repeating approval.')+mSaleUI.productionJobs(av)+R.actions([{id:'sale-approval-open',label:'Open sale order',kind:'primary'}]);body.querySelector('button').onclick=function(){go({id:id});};return;}
    if(order.revision!==av.revision){body.innerHTML=R.note('warn','The order changed while loading. Refresh before reviewing approval.')+R.actions([{id:'sale-approval-refresh',label:'Check latest stock',kind:'primary'}]);body.querySelector('button').onclick=function(){approve(view,id);};return;}
    var shortages=(av.lines||[]).filter(function(l){return l.shortfall>0;}),backorder=shortages.some(function(l){return !l.is_finished_product||l.fulfillment_mode==='ckd_component';});
    body.innerHTML=R.jobHead({number:order.number,name:order.customer_name||'Walk-in',meta:'Ship from '+(av.location_name||'No source location')})+mSaleUI.deliveryFacts(order)+
      R.lines((av.lines||[]).map(function(l){return {name:l.name,qty:'Short '+l.shortfall,detail:'Available '+l.available+(l.is_finished_product&&l.shortfall>0?' · Production plans uncovered demand':'')+(l.is_finished_product&&!l.has_bom&&l.shortfall>0?' · BOM/setup needs review':''),ok:l.shortfall<=0};}))+mSaleUI.productionJobs(av)+
      R.note('info','Approval drafts Production jobs for uncovered finished-product demand. Production still approves, kits, builds, inspects and receives them. Approval does not add RTS stock or authorize a partial vehicle trip.')+
      (backorder?R.check('sale-backorder','Approve the missing parts / CKD goods explicitly as a backorder.'): '')+
      R.check('sale-reviewed','I reviewed the order, source stock and production handoff.')+
      R.actions([{id:'sale-approve-confirm',label:'Approve order',kind:'primary'},{id:'sale-approval-refresh',label:'Check latest stock',kind:'secondary'},{id:'sale-approve-back',label:'Back to order',kind:'secondary'}]);
    var button=body.querySelector('#sale-approve-confirm');button.disabled=true;
    function ready(){button.disabled=!body.querySelector('#sale-reviewed').checked||(backorder&&!body.querySelector('#sale-backorder').checked);}
    body.querySelectorAll('input[type=checkbox]').forEach(function(el){el.onchange=ready;});
    body.querySelector('#sale-approval-refresh').onclick=function(){approve(view,id);};body.querySelector('#sale-approve-back').onclick=function(){go({id:id});};
    button.onclick=async function(){if(button.disabled)return;if(navigator.onLine===false)return mToast('Reconnect before approving. The sale stays open.','err');button.disabled=true;
      try{await mWorkflow.start(saved,{path:'/orders/'+id+'/status',method:'post',payload:{status:'approved',expected_revision:av.revision,force:!!(backorder&&body.querySelector('#sale-backorder').checked)},title:'Approve '+order.number,role:'Sales',reviewRoute:'sales',reviewParams:{id:id}});if(body.isConnected)mSaleUI.paintApproval(view,saved,id);}
      catch(e){if(body.isConnected){if(saved.operation.state!=='draft')mSaleUI.paintApproval(view,saved,id);else{mToast(e.message,'err');ready();}}}
    };
  }
  async function orderForm(view,id){
    if(!MApp.can(id?'orders.edit':'orders.create'))throw Error('Sale order permission is required.');
    var body=page(view,id?'Edit sale order':'New sale order','Save an open order for Sales review');body.classList.add('sale-order-form');
    var saved=await mWorkflow.draft(id?'sale-edit-'+id:'sale-create');if(!body.isConnected)return;if(saved.operation.state!=='draft')return mWorkflow.paint(view,saved);
    var r=id?await API.get('/orders/'+id):null;if(!body.isConnected)return;if(r&&(!['draft','open'].includes(r.status)||r.type!=='sale'))throw Error('Only open sales can be edited here. Customer JO records are view-only.');
    var b=saved.batch;if(!b.initial)Object.assign(b,{initial:true,customer_name:r?.customer_name||'',customer_contact:r?.customer_contact||'',customer_id:r?.customer_id||null,revision:r?.revision||null,expected_date:r?.expected_date||'',notes:r?.notes||'',lines:[]});
    if(id&&b.revision!==r.revision){body.innerHTML=R.note('warn','This sale changed since your saved edit began. Load the current sale before editing so another employee’s changes are preserved.')+R.actions([{id:'sale-edit-reload',label:'Load current sale',kind:'primary'},{id:'sale-edit-stale-back',label:'Back to order',kind:'secondary'}]);body.querySelector('#sale-edit-reload').onclick=async function(){this.disabled=true;try{saved.batch={};await mWorkflow.save(saved);if(body.isConnected)orderForm(view,id);}catch(e){this.disabled=false;mToast(e.message,'err');}};body.querySelector('#sale-edit-stale-back').onclick=function(){go({id:id});};return;}
    body.innerHTML='<div data-customer-picker></div>'+field('Target delivery date (optional)','target-date',b.expected_date,'date')+R.note('info','This is a target, not an actual delivery or courier pickup date.')+field('Notes','notes',b.notes)+(id?'':'<div data-picker></div><div data-lines></div>')+R.check('sale-form-confirm','I checked the customer and order')+R.actions([{id:'sale-save',label:id?'Save changes':'Create sale order',kind:'primary'},{id:'sale-cancel',label:'Back',kind:'secondary'}]);
    var pending=Promise.resolve();function persist(){pending=pending.catch(function(){}).then(function(){return mWorkflow.save(saved);});return pending;}
    var customer=mSaleUI.customerPicker({value:b,onChange:function(value){Object.assign(b,value);persist().catch(function(e){mToast(e.message,'err');});}});body.querySelector('[data-customer-picker]').appendChild(customer.el);
    async function save(){b.expected_date=body.querySelector('[data-target-date]').value;b.notes=body.querySelector('[data-notes]').value;await persist();}
    body.querySelector('[data-target-date]').oninput=body.querySelector('[data-notes]').oninput=function(){save().catch(function(e){mToast(e.message,'err');});};
    function lines(){var host=body.querySelector('[data-lines]');host.innerHTML=b.lines.map(function(x,i){return '<section class="rk-card" data-line="'+i+'"><b>'+mEsc(x.name)+'</b>'+field('Quantity','qty',x.quantity,'number')+field('Unit price','price',x.unit_price,'number')+'<label class="rk-field"><small>Build state</small><select data-mode><option value="assembled">Assembled</option><option value="semi_built">Semi-built</option><option value="ckd">CKD package</option></select></label><button type="button" class="rk-btn secondary" data-remove>Remove</button></section>';}).join('');host.querySelectorAll('[data-line]').forEach(function(row){var i=Number(row.dataset.line),x=b.lines[i];row.querySelector('[data-mode]').value=x.fulfillment_mode;row.querySelectorAll('input,select').forEach(function(el){el.onchange=function(){x.quantity=Number(row.querySelector('[data-qty]').value);x.unit_price=Number(row.querySelector('[data-price]').value);x.fulfillment_mode=row.querySelector('[data-mode]').value;save();};});row.querySelector('[data-remove]').onclick=function(){b.lines.splice(i,1);lines();save();};});}
    if(!id){var picker=mItemPicker({label:'Add an item (parts or finished products)',onPick:function(it){b.lines.push({item_id:it.id,name:it.name,sku:it.sku,unit:it.unit,quantity:1,unit_price:0,fulfillment_mode:'assembled'});lines();save();}});picker.el.querySelector('input').setAttribute('aria-label','Find item or finished product');body.querySelector('[data-picker]').appendChild(picker.el);lines();}
    body.querySelector('#sale-cancel').onclick=function(){go(id?{id:id}:{});};
    body.querySelector('#sale-save').onclick=async function(){try{Object.assign(b,customer.value());await save();if(!body.querySelector('#sale-form-confirm').checked)throw Error('Review and confirm the order first.');if(!id&&(!b.lines.length||b.lines.some(function(x){return !Number.isFinite(x.quantity)||x.quantity<=0||!Number.isFinite(x.unit_price)||x.unit_price<0;})))throw Error('Add valid quantities and prices.');if(navigator.onLine===false)throw Error('Reconnect before saving the sale.');this.disabled=true;
      var payload={customer_name:b.customer_name,customer_contact:b.customer_contact,customer_id:b.customer_id,expected_date:b.expected_date||null,notes:b.notes,tax_percent:r?.tax_percent||0};if(id)payload.expected_revision=b.revision;else Object.assign(payload,{type:'sale',status:'open',items:b.lines});
      await mWorkflow.start(saved,{path:id?'/orders/'+id:'/orders',method:id?'put':'post',payload:payload,title:id?'Edit '+r.number:'Create sale order',role:'Sales',reviewRoute:'sales',reviewParams:id?{id:id}:{},resultParam:id?null:'id'});if(body.isConnected)mWorkflow.paint(view,saved);
    }catch(e){if(body.isConnected){if(saved.operation.state!=='draft')mWorkflow.paint(view,saved);else{this.disabled=false;mToast(e.message,'err');}}}};
  }
  async function authorizationForm(view,id){
    if(!MApp.can('orders.authorize'))throw Error('Sales release-authorization permission is required.');
    var body=page(view,'Authorize release','Sales decision');var saved=await mWorkflow.draft('sale-authorization-'+id);if(!body.isConnected)return;if(saved.operation.state!=='draft')return mWorkflow.paint(view,saved);
    var order=await API.get('/orders/'+id),b=saved.batch;if(!body.isConnected)return;if(order.type!=='sale')throw Error('Customer JO records are read-only in Sales.');
    body.innerHTML=R.note('warn','This replaces any unused authorization. A partial-trip report alone does not authorize a partial release. The warehouse must still scan and issue each trip slip.')+
      '<label class="rk-card rk-field"><small>Handoff mode</small><select data-mode><option value="pickup">Customer pickup</option><option value="delivery">Delivery</option></select></label>'+field('Approved recipient','recipient',b.recipient)+field('ID reference (last four only)','reference',b.reference)+field('Valid hours (1–336)','hours',b.hours||24,'number')+field('Handoff area','area',b.area)+field('Sales notes','notes',b.notes)+R.check('sale-partial','Authorize separate partial trips for this order')+R.check('sale-auth-confirm','I reviewed the recipient and release arrangement')+R.actions([{id:'sale-auth-save',label:'Issue release authorization',kind:'primary'},{id:'sale-auth-back',label:'Back to order',kind:'secondary'}]);
    body.querySelector('[data-mode]').value=b.mode||'pickup';body.querySelector('#sale-partial').checked=!!b.partial;
    async function save(){['recipient','reference','hours','area','notes','mode'].forEach(function(k){b[k]=body.querySelector('[data-'+k+']').value;});b.partial=body.querySelector('#sale-partial').checked;await mWorkflow.save(saved);}
    body.querySelectorAll('input,select').forEach(function(el){el.onchange=function(){save().catch(function(e){mToast(e.message,'err');});};});body.querySelector('#sale-auth-back').onclick=function(){go({id:id});};
    body.querySelector('#sale-auth-save').onclick=async function(){try{await save();if(!body.querySelector('#sale-auth-confirm').checked||!b.recipient.trim()||!Number.isFinite(Number(b.hours))||Number(b.hours)<1||Number(b.hours)>336)throw Error('Confirm the recipient and a validity of 1–336 hours.');this.disabled=true;await mWorkflow.start(saved,{path:'/release-slips/orders/'+id+'/authorizations',payload:{mode:b.mode,recipient_name:b.recipient.trim(),id_reference:(b.reference||'').replace(/[^a-z0-9]/gi,'').slice(-4),valid_hours:Number(b.hours),handoff_area:b.area||null,notes:b.notes||null,partial_allowed:!!b.partial},title:'Authorize handoff for '+order.number,role:'Sales',reviewRoute:'sales',reviewParams:{id:id}});if(body.isConnected)mWorkflow.paint(view,saved);}catch(e){this.disabled=false;mToast(e.message,'err');}};
  }
  async function customers(view,params){
    var body=page(view,'Customers','Customer registry and recent orders');
    if(params.step==='new'||params.step==='edit'){
      if(!MApp.can(params.id?'orders.edit':'orders.create'))throw Error('Customer write permission is required.');var saved=await mWorkflow.draft('customer-'+(params.id||'new'));if(!body.isConnected)return;if(saved.operation.state!=='draft')return mWorkflow.paint(view,saved);var r=params.id?await API.get('/customers/'+params.id):{};if(!body.isConnected)return;var b=saved.batch;if(!b.initial)Object.assign(b,r,{initial:true});body.innerHTML=['name','contact_person','phone','email','address','notes'].map(function(k){return field(k.replace(/_/g,' '),k,b[k]);}).join('')+R.actions([{id:'customer-save',label:'Save customer',kind:'primary'}]);body.querySelectorAll('input').forEach(function(el){el.oninput=function(){Object.keys(el.dataset).forEach(function(k){b[k]=el.value;});mWorkflow.save(saved).catch(function(e){mToast(e.message,'err');});};});body.querySelector('#customer-save').onclick=async function(){try{if(!String(b.name||'').trim())throw Error('Customer name is required.');this.disabled=true;var payload={};['name','contact_person','phone','email','address','notes'].forEach(function(k){payload[k]=b[k]||null;});await mWorkflow.start(saved,{path:'/customers'+(params.id?'/'+params.id:''),method:params.id?'put':'post',payload:payload,title:'Save customer',role:'Sales',reviewRoute:'customers'});if(body.isConnected)mWorkflow.paint(view,saved);}catch(e){this.disabled=false;mToast(e.message,'err');}};return;
    }
    if(params.id){var c=await API.get('/customers/'+params.id);if(!body.isConnected)return;body.innerHTML=R.jobHead({number:c.name,name:c.contact_person||'',meta:[c.phone,c.email].filter(Boolean).join(' · ')})+R.field('Address',c.address||'—')+R.section('Recent sales')+(c.orders||[]).map(function(o){return R.jobCard({id:o.id,number:o.number,name:o.status});}).join('')+R.actions(MApp.can('orders.edit')?[{id:'customer-edit',label:'Edit customer',kind:'secondary'}]:[]);body.querySelectorAll('[data-id]').forEach(function(b){b.onclick=function(){MApp.go(csr()?'sales':'order-tracking',{id:b.dataset.id});};});if(body.querySelector('#customer-edit'))body.querySelector('#customer-edit').onclick=function(){MApp.go('customers',{id:params.id,step:'edit'});};return;}
    var rows=await API.get('/customers');if(!body.isConnected)return;body.innerHTML=field('Search customers','customer-search','')+R.actions(MApp.can('orders.create')?[{id:'customer-new',label:'New customer',kind:'primary'}]:[])+'<div data-customers></div>';function paint(){body.querySelector('[data-customers]').innerHTML=rows.filter(function(c){return (c.name+' '+c.phone+' '+c.email).toLowerCase().includes(body.querySelector('[data-customer-search]').value.toLowerCase());}).map(function(c){return R.jobCard({id:c.id,number:c.name,name:c.phone||c.email||'No contact',meta:c.order_count+' sale order(s)'});}).join('');body.querySelectorAll('[data-id]').forEach(function(b){b.onclick=function(){MApp.go('customers',{id:b.dataset.id});};});}body.querySelector('[data-customer-search]').oninput=paint;paint();if(body.querySelector('#customer-new'))body.querySelector('#customer-new').onclick=function(){MApp.go('customers',{step:'new'});};
  }
  function route(name,fn){MApp.route(name,async function(view,params){var serial=++renderSerial,hash=location.hash;try{if(!MApp.can('orders.view')||(name==='sales'&&!csr()))throw Error('This screen is outside your assigned sales access.');await fn(view,params||{});}catch(e){if(serial!==renderSerial||hash!==location.hash)return;view.innerHTML='';view.appendChild(R.error(e,function(){MApp.render();}));}});}
  route('sales',function(v,p){return p.step==='approve'?approve(v,p.id):p.step==='authorize'?authorizationForm(v,p.id):p.step==='new'||p.step==='edit'?orderForm(v,p.id):p.id?detail(v,p.id,false):list(v,false);});
  route('order-tracking',function(v,p){return p.id?detail(v,p.id,true):list(v,true);});
  route('customers',customers);
})();
