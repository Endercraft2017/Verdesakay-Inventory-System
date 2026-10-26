/* Isolated review transport for the remaining actual Sales/Releasing screens. */
(function(){
 var config=__SCRATCH_CONFIG__;if(!config.releaseReview||!['salesauth','queue','partial','handoff','receipt','exceptions'].includes(config.request))return;
 var corpus=__SCRATCH_PREPARATION__,fixture=__preparationFixture,scenario=fixture.scenario,c=__releaseFixture.context,prior=window.fetch,journal=[],receipts=new Map();
 function json(value,status){return new Response(JSON.stringify(value),{status:status||200,headers:{'Content-Type':'application/json'}});}
 if(config.long){c.authorization.recipient_name+=' · regional warehouse operations and maintenance';scenario.saleOrder.customer_name+=' · regional facilities and maintenance operations';}
 window.fetch=async function(input,init){init=init||{};var u=new URL(typeof input==='string'?input:input.url,'https://scratch.invalid'),p=u.pathname.replace(/^\/api/,''),method=init.method||'GET',key=new Headers(init.headers).get('Idempotency-Key');journal.push({method,path:p,key});
  if(method==='GET'){
   if(p==='/release-slips/receivers')return json(corpus.receivers);
   if(p==='/release-slips/queue')return json(corpus.releaseQueue);
   if(p==='/orders')return json(corpus.saleOrders);
   if(p==='/orders/'+c.order.id)return json(scenario.saleOrder);
   if(p==='/orders/'+c.order.id+'/availability')return json(scenario.saleAvailability);
   if(p==='/release-slips/orders/'+c.order.id+'/authorizations')return json({current:c.authorization,required:true,history:[{...c.authorization,token:c.authorization.handoff_type==='internal'?null:'DEMO-CODE',partial_allowed:c.authorization.partial_allowed}]});
   if(p==='/release-slips/'+scenario.receipt.id)return json(scenario.receipt);
   if(p==='/attachments')return json([]);
   if(p==='/attachments/'+scenario.receipt.signature_attachment_id+'/image')return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="180"><rect width="480" height="180" fill="white"/><text x="24" y="80" font-size="20" fill="#17362b">Fictional evidence placeholder</text><text x="24" y="115" font-size="15" fill="#17362b">Real attachment binding is verified separately.</text></svg>',{headers:{'Content-Type':'image/svg+xml'}});
  }
  if(method==='POST'&&(p.endsWith('/authorizations')||p.endsWith('/reports'))){
   if(config.variant==='before')return json({error:'Previous workflow writes are disabled in the comparison.'},501);
   if(receipts.has(key))return json(receipts.get(key));var body=JSON.parse(init.body),result={ok:true,id:9001,simulated:true};
   if(p.endsWith('/authorizations')){var staff=corpus.receivers.find(function(u){return u.id===body.receiver_user_id;});c.authorization={...c.authorization,...body,id:9001,state:'valid',recipient_name:body.handoff_type==='internal'?staff?.full_name:body.recipient_name,receiver_active:body.handoff_type==='internal'?true:null,token_required:body.handoff_type!=='internal'};result={token:body.handoff_type==='internal'?null:'DEMO-CODE',authorization:c.authorization,simulated:true};}
   else{c.reports.push({id:9001,...body,status:'open'});for(var row of [...corpus.releaseQueue.to_accept,...corpus.releaseQueue.releasing])if(row.id===c.order.id)row.open_reports=(row.open_reports||0)+1;}
   receipts.set(key,result);return json(result,201);
  }
  return prior(input,init);
 };
 var inspect=window.__scratch.inspect;window.__scratch.inspect=function(){return {...inspect(),flowRequests:structuredClone(journal),flowWrites:receipts.size};};
 var step={partial:'trip',receipt:'receipt',handoff:'handoff',exceptions:'report'}[config.request];
 location.hash=config.request==='salesauth'?'#/sales?id='+c.order.id+'&step=authorize':config.request==='queue'?'#/so':'#/so?id='+c.order.id+'&step='+step+(config.request==='exceptions'?'&kind=identity':'');
})();
