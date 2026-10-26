/* Review-only replay of the two actual SO screens. No production transport. */
(function(){
  var config=__SCRATCH_CONFIG__;if(!config.releaseReview)return;
  var fixture=__preparationFixture,scenario=fixture.scenario,c=scenario.contexts[0],prior=window.fetch,baseInspect=fixture.inspect,requests=[],writes=[],receipts=new Map(),lost=false,taskComparison=false;
  if(config.state==='largekit'&&config.request==='ckd'){
    var parent=structuredClone(c.lines.find(function(l){return l.fulfillment_mode==='ckd';}));parent.quantity=1;parent.name='Fictional industrial controller · 2,000-part stress fixture';c.lines=[parent];c.availability=[];scenario.lookups={};
    for(var i=0;i<2000;i++){var id=10000+i,item=20000+i,code='STRESS-PART-'+String(i+1).padStart(4,'0');c.lines.push({id:id,item_id:item,name:'Fictional stress component '+(i+1),sku:code,unit:'pcs',quantity:1,released_qty:0,held_qty:0,units:0,cancelled_qty:0,dispatched_qty:0,fulfillment_mode:'ckd_component',parent_order_item_id:parent.id,serialized:0});c.availability.push({order_item_id:id,item_id:item,fulfillment_mode:'ckd_component',on_hand:2,committed_elsewhere:0,free_to_allocate:2});scenario.lookups[code]={state:'bulk_available',stock:{id:item,name:'Fictional stress component '+(i+1),code:code,available:2,build_mode:'assembled'}};}
  }
  if(config.request==='ckd'){
    c.kit_manifest_proposal=true;c.prepared_kits=c.lines.filter(function(l){return l.fulfillment_mode==='ckd';}).map(function(p,index){return {id:index+1,code:'DEMO:KIT:'+p.id+':001',orderId:c.order.id,parentId:p.id,locationId:config.state==='kitwrongwarehouse'?2:c.order.location_id,kits:1,state:config.state==='kitpartial'?'preparing':'verified',sealed:config.state!=='kitpartial',version:1,currentVersion:config.state==='kitstale'?2:1,checkedBy:'Fictional kit checker',checkedAt:new Date().toISOString(),contents:c.lines.filter(function(l){return l.parent_order_item_id===p.id;}).map(function(l){return {order_item_id:l.id,item_id:l.item_id,quantity:l.quantity/p.quantity};})};});
  }
  if(['expired','revoked'].includes(config.state))c.authorization.state=config.state;
  if(config.state==='expired')c.authorization.valid_until=new Date(Date.now()-3600000).toISOString();
  if(config.long){c.order.customer_name+=' · Regional facilities and maintenance operations';c.lines.forEach(function(l){l.name+=' · reinforced replacement for the warehouse controller maintenance service';});}
  if(config.state==='complete')c.lines.filter(function(l){return l.item_id&&l.fulfillment_mode!=='ckd';}).forEach(function(l){l.held_qty=Math.max(0,l.quantity-l.cancelled_qty-l.dispatched_qty);l.released_qty=l.held_qty+(l.dispatched_bulk_qty||0);});
  function json(body,status){return new Response(JSON.stringify(body),{status:status||200,headers:{'Content-Type':'application/json'}});}
  function poolFree(item,build){var a=c.availability.find(function(a){return a.item_id===item&&(a.fulfillment_mode==='semi_built')===(build==='semi_built');});if(!a)return 0;return Math.max(0,a.on_hand-a.committed_elsewhere-c.lines.filter(function(l){return l.item_id===item&&l.fulfillment_mode!=='ckd'&&(l.fulfillment_mode==='semi_built')===(build==='semi_built');}).reduce(function(n,l){return n+l.held_qty;},0));}
  var unitRecords=new Map(),batchRecords=new Map();Object.values(scenario.lookups||{}).forEach(function(r){if(r.unit)unitRecords.set(r.unit.id,structuredClone(r.unit));if(r.batch)batchRecords.set(r.batch.id,structuredClone(r.batch));});
  window.fetch=async function(input,init){init=init||{};var u=new URL(typeof input==='string'?input:input.url,'https://scratch.invalid'),p=u.pathname.replace(/^\/api/,''),method=init.method||'GET',body=init.body?JSON.parse(init.body):null,key=new Headers(init.headers).get('Idempotency-Key');requests.push({method:method,path:p,query:u.search,key:key,body:body});
    if(p==='/release-slips/orders/'+c.order.id+'/verify-token'&&method==='GET')return json({ok:u.searchParams.get('token')==='DEMO-CODE',error:'Fictional preview code: DEMO-CODE. This is simulated verification only.'});
    if(p==='/release-slips/orders/'+c.order.id+'/unit'&&method==='GET'){
      var code=u.searchParams.get('code'),lookup=structuredClone(scenario.lookups?.[code]||{state:'not_found',code:code});
      if(lookup.unit){var u=unitRecords.get(lookup.unit.id);lookup.unit=structuredClone(u);lookup.state=u.status==='reserved'?(u.order_id===c.order.id?'allocated':'other_order'):u.status==='in_stock'?'available':'unavailable';}
      if(lookup.batch){var b=batchRecords.get(lookup.batch.id);lookup.batch=structuredClone(b);lookup.batch.available=Math.max(0,Math.min(b.balances.find(function(x){return x.location_id===c.order.location_id;})?.available||0,poolFree(b.product_item_id,b.build_mode)));lookup.state=lookup.batch.available>0?'batch_available':'batch_unavailable';}

      if(lookup.stock){lookup.stock.available=Math.min(lookup.stock.available,poolFree(lookup.stock.id,lookup.stock.build_mode||'assembled'));if(lookup.stock.available<=0)lookup.state='unavailable';}
      return json(lookup);
    }
    if((config.variant==='after'||taskComparison)&&method==='POST'&&(p==='/orders/'+c.order.id+'/accept-release'||p==='/orders/'+c.order.id+'/release'||/^\/__review\/prepared-kits\/\d+\/allocate$/.test(p))){
      if(!fixture.profile.permissions.includes('orders.release'))return json({error:'Preparation permission required.'},403);
      if(receipts.has(key)){var old=receipts.get(key);return json(old.body,old.status);}
      await new Promise(function(r){setTimeout(r,config.response==='slow'?900:60);});
      if(config.response==='mixed'){var refused={body:{error:'Fixture: availability changed. Review the current order before correcting the original allocation.'},status:409};receipts.set(key,refused);return json(refused.body,refused.status);}
      if(p.endsWith('accept-release'))c.order.warehouse_accepted_at=new Date().toISOString();
      else if(p.startsWith('/__review/')){
        var k=(c.prepared_kits||[]).find(function(k){return k.id===body.kit_id;}),parent=c.lines.find(function(l){return l.id===k?.parentId;});
        if(!c.order.warehouse_accepted_at||c.authorization.state!=='valid'||!k||k.state!=='verified'||!k.sealed||k.locationId!==c.order.location_id||k.orderId!==body.order_id||k.parentId!==body.parent_order_item_id||k.version!==body.manifest_version||k.version!==k.currentVersion||JSON.stringify(k.contents)!==JSON.stringify(body.contents))return json({error:'Prepared kit identity, status or manifest changed. Recheck it.'},409);
        var sums=new Map();for(const x of k.contents){var l=c.lines.find(function(l){return l.id===x.order_item_id&&l.item_id===x.item_id&&l.parent_order_item_id===k.parentId;});if(!l||l.serialized||x.quantity>l.quantity-l.cancelled_qty-l.dispatched_qty-l.held_qty||Math.abs(x.quantity-l.quantity/parent.quantity*k.kits)>1e-9)return json({error:'Prepared kit cannot cover the saved requirement or tracking.'},409);sums.set(l.item_id,(sums.get(l.item_id)||0)+x.quantity);if(sums.get(l.item_id)>poolFree(l.item_id,l.fulfillment_mode))return json({error:'Shared stock is insufficient for a complete kit.'},409);}
        k.contents.forEach(function(x){var l=c.lines.find(function(l){return l.id===x.order_item_id;});l.held_qty+=x.quantity;l.released_qty+=x.quantity;});k.state='allocated';
      }
      else if(Array.isArray(body.codes)){
        if(!c.order.warehouse_accepted_at||c.authorization.state!=='valid')return json({error:'Warehouse acceptance and release authority are required.'},409);
        if(body.codes.length!==1)return json({error:'Scan one unique unit at a time.'},409);var match=/^VDS:UNIT:(\d+)$/.exec(body.codes[0]),u=match&&unitRecords.get(Number(match[1])),line=c.lines.find(function(l){return l.id===body.order_item_id&&l.item_id===u?.product_item_id;});
        if(!u||!line)return json({error:'Choose an eligible exact sale line for this unit.'},409);
        if(config.state==='unitrace'){u.status='reserved';u.order_id=scenario.meta.otherOrderId;u.order_number=scenario.meta.otherOrderNumber;}
        if(u.status!=='in_stock')return json({error:'Unit '+u.identifier+' is already allocated to '+u.order_number+'. Nothing was added.'},409);
        if(line.held_qty>=line.quantity-line.cancelled_qty-line.dispatched_qty||poolFree(u.product_item_id,u.build_mode)<1)return json({error:'No further unit is needed or available for this line.'},409);
        u.status='reserved';u.order_id=c.order.id;u.order_number=c.order.number;u.order_item_id=line.id;line.held_qty+=1;line.units+=1;c.units.push({...structuredClone(u),pending_direct:false});
      }
      else{
        if(!c.order.warehouse_accepted_at||c.authorization.state!=='valid')return json({error:'Warehouse acceptance and release authority are required.'},409);
        if(!Array.isArray(body.bulk)||!body.bulk.length)return json({error:'Only the captured non-serialized allocation is simulated.'},409);
        var totals=new Map();for(const a of body.bulk){var l=c.lines.find(function(l){return l.id===a.order_item_id&&l.item_id===a.item_id;});if(!l||l.serialized||a.batch_id&&!batchRecords.has(a.batch_id))return json({error:'Use the native identity-based workflow for this stock.'},409);if(!Number.isFinite(a.quantity)||a.quantity<=0||a.quantity>l.quantity-l.cancelled_qty-l.dispatched_qty-l.held_qty)return json({error:'Allocation exceeds the exact sale-line requirement.'},409);if(a.batch_id){var b=batchRecords.get(a.batch_id),balance=b.balances.find(function(b){return b.location_id===c.order.location_id;});if(b.product_item_id!==a.item_id||!balance||a.quantity>balance.available)return json({error:'The batch has insufficient free quantity.'},409);}
        var pool=[l.item_id,l.fulfillment_mode==='semi_built'?'semi_built':'assembled'].join(':');totals.set(pool,(totals.get(pool)||0)+a.quantity);if(totals.get(pool)>poolFree(l.item_id,l.fulfillment_mode))return json({error:'Shared stock is insufficient.'},409);}
        body.bulk.forEach(function(a){var l=c.lines.find(function(l){return l.id===a.order_item_id;});l.held_qty+=a.quantity;l.released_qty+=a.quantity;if(a.batch_id){var b=batchRecords.get(a.batch_id),balance=b.balances.find(function(x){return x.location_id===c.order.location_id;});balance.reserved+=a.quantity;balance.available-=a.quantity;c.batch_allocations.push({batch_id:b.id,batch_number:b.number,order_item_id:l.id,quantity:a.quantity,state:'reserved'});}});
      }
      writes.push({path:p,body:body,key:key});var result={body:{ok:true},status:200};receipts.set(key,result);
      if(config.response==='unknown'&&!lost){lost=true;return json({error:'Fixture response lost after the reservation was saved. Retry the original request.'},503);}
      return json(result.body,result.status);
    }
    return prior(input,init);
  };
  window.__releaseFixture={enableTaskComparison:function(){taskComparison=true;},consumeBatchElsewhere:function(qty){for(var b of batchRecords.values()){var balance=b.balances.find(function(x){return x.location_id===c.order.location_id;});balance.reserved+=qty;balance.available=Math.max(0,balance.available-qty);c.availability.filter(function(a){return a.item_id===b.product_item_id;}).forEach(function(a){a.committed_elsewhere+=qty;});}},codes:Object.keys(scenario.lookups||{}).slice(0,12).concat((c.prepared_kits||[]).map(function(k){return k.code;})),context:c,inspect:function(){return{...baseInspect(),requests:structuredClone(requests),simulatedWrites:structuredClone(writes),receipts:structuredClone(Array.from(receipts.entries())),units:structuredClone(Array.from(unitRecords.values())),batches:structuredClone(Array.from(batchRecords.values()))};}};
  window.__scratch.inspect=__releaseFixture.inspect;
  location.hash='#/so?id='+c.order.id+(['checklist','internal'].includes(config.request)?'&step=package':config.releaseScreen==='scan'?'&step=scan':'');
})();
