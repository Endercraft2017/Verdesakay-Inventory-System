/* Isolated replay of real disposable-API reads. Never imported by production. */
(function(){
  if(!__SCRATCH_CONFIG__.integrationReview)return;
  var config=__SCRATCH_CONFIG__,corpus=structuredClone(__SCRATCH_PREPARATION__),scenario=corpus.scenarios[config.releaseReview&&['serial','unitrace'].includes(config.state)&&config.request==='so'?'serial':config.request],journal=[],writes=[],priorFetch=window.fetch,transport=config.response,profile=config.request==='salesauth'?corpus.salesProfile:corpus.profile;
  if(config.role==='view')profile.permissions=profile.permissions.filter(function(p){return p!=='orders.release'&&p!=='production.kit_release';});
  if(config.state==='unaccepted'){(scenario.contexts||[]).forEach(function(c){c.order.warehouse_accepted_at=null;});(scenario.jobs||[]).forEach(function(j){j.job.warehouse_accepted_at=null;j.availability.warehouse_accepted=false;});}
  if(config.state==='unauthorized')(scenario.contexts||[]).forEach(function(c){c.authorization={state:'none',required:true};});
  if(config.state==='serial')(scenario.contexts||[]).forEach(function(c){c.lines.filter(function(l){return l.fulfillment_mode!=='ckd';})[0].serialized=1;});
  if(config.state==='shortage'){
    (scenario.contexts||[]).forEach(function(c){c.availability.forEach(function(a){if(a.item_id===1||config.request==='so'){a.on_hand=config.request==='so'?2:3;a.free_to_allocate=0;}});});
    (scenario.jobs||[]).forEach(function(j){j.availability.lines.forEach(function(l){if(l.component_item_id===1){l.have=3;l.available=3-l.held_elsewhere;l.short=Math.max(0,l.need-l.available);}});j.availability.shortfalls=j.availability.lines.filter(function(l){return l.short>0;});});
  }
  Object.values(corpus.items).forEach(function(i){i.image_path=config.photo==='missing'?null:'fixture-illustration-'+i.id;if(config.long)i.name+=' · reinforced replacement component for warehouse controller maintenance';});
  localStorage.setItem('vds_m_owner',String(profile.id));localStorage.setItem('vds_batch_layout:'+JSON.stringify(['',profile.id]),config.layout||'photos');
  function json(body,status){return new Response(JSON.stringify(body),{status:status||200,headers:{'Content-Type':'application/json'}});}
  window.fetch=async function(input,init){init=init||{};var url=new URL(typeof input==='string'?input:input.url,'https://scratch.invalid'),p=url.pathname.replace(/^\/api/,''),method=init.method||'GET';journal.push({method:method,path:p});
    if(p==='/auth/me')return json({user:profile});
    if(p==='/locations')return json([{id:1,name:'Main',is_default:1,type:'warehouse',parent_id:null},{id:2,name:'Fictional Assembly Stores',type:'warehouse',parent_id:null}]);
    if(p==='/users/me/work-shortcuts')return json({shortcuts:[]});
    if(/\/image$/.test(p)){var id=Number(p.split('/')[2]);return priorFetch('/api/inventory/'+(id===1?1:id===2?2:3)+'/image',init);}
    if(method!=='GET')return json({error:'Native business writes are read-only in this comparison. Try the proposed review in the right phone.'},501);
    if(transport==='readfail'&&/context$|availability$/.test(p))return json({error:'Fixture stock check unavailable. No quantity is assumed.'},503);
    var c=(scenario.contexts||[]).find(function(c){return p==='/release-slips/orders/'+c.order.id+'/context';});if(c)return json(c);
    var j=(scenario.jobs||[]).find(function(j){return p==='/job-orders/'+j.job.id||p==='/job-orders/'+j.job.id+'/availability';});if(j)return json(p.endsWith('/availability')?j.availability:j.job);
    if(p==='/job-orders')return json((scenario.jobs||[]).map(function(j){return j.job;}));
    var match=p.match(/^\/inventory\/(\d+)(\/stock)?$/);if(match)return corpus.items[match[1]]?json(match[2]?corpus.stock[match[1]]:corpus.items[match[1]]):json({error:'No fixture item'},404);
    if(p==='/inventory')return json(Object.values(corpus.items));
    if(/notifications|messages/.test(p))return json({count:0});
    return json({error:'This action is outside the three preparation views under review.'},501);
  };
  window.__preparationFixture={scenario:scenario,profile:profile,inspect:function(){return structuredClone({request:config.request,profile:profile,journal:journal,writes:writes,physicalStock:corpus.stock,checks:corpus.checks});},save:async function(plan){
    if(config.role==='view')throw Error('Preparation permission required.');
    await new Promise(function(r){setTimeout(r,transport==='slow'?900:60);});
    if(transport==='mixed')throw Error('Fixture: availability changed. Counts remain draft; recheck the original workflow.');
    writes.push(structuredClone(plan));
    if(config.request==='jo'){
      var previous={};(scenario.jobs||[]).forEach(function(j){j.availability.lines.forEach(function(l){previous[j.job.id+':'+l.component_item_id]=l.picked;});});
      (scenario.jobs||[]).forEach(function(j){j.availability.lines.forEach(function(l){var own=plan.groups.find(function(g){return g.id===j.job.id;}).lines.find(function(p){return p.component_item_id===l.component_item_id;});var delta=0;plan.groups.forEach(function(g){if(g.id!==j.job.id)g.lines.forEach(function(p){if(p.component_item_id===l.component_item_id)delta+=p.prepared-previous[g.id+':'+p.component_item_id];});});l.available-=delta;l.held_elsewhere+=delta;l.picked=own.prepared;l.short=Math.max(0,l.need-l.available);});j.availability.shortfalls=j.availability.lines.filter(function(l){return l.short>0;});});
    }else{
      var c=scenario.contexts[0];plan.groups.forEach(function(g){g.lines.forEach(function(p){var l=c.lines.find(function(l){return l.id===p.line_id;});l.held_qty=p.prepared;l.released_qty=p.prepared;});});
    }return true;
  }};
  window.__scratch.inspect=__preparationFixture.inspect;
  var id=config.request==='jo'?scenario.jobs[0].job.id:scenario.contexts[0].order.id;
  location.hash=config.request==='jo'?'#/kit-release?id='+id:'#/so?id='+id+'&step=scan';
})();
