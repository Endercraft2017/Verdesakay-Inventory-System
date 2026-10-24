/* Durable operational decisions. Original JSON, files and keys survive restart;
   no automatic retry, no optimistic stock/stage success. One decision per route. */
(function(){
  var busy={};
  function slot(route){return 'workflow-'+route+':0:action';}
  function owns(s){return s.key===mProductionDrafts.key(slot(s.operation.route));}
  function guard(s){if(!owns(s))throw new Error('Recover with the original account and server.');}
  async function load(route){return mProductionDrafts.load('workflow-'+route+':0:action');}
  async function draft(route){return await load(route)||{key:mProductionDrafts.key(slot(route)),rows:[],batch:{},operation:{kind:'workflow',route:route,state:'draft'}};}
  async function save(s){guard(s);await mProductionDrafts.save(s);}
  function classify(e){return !e.status||e.status>=500||[401,403,429].indexOf(e.status)!==-1?'unknown':e.status===409&&/different request|save key/i.test(e.message)?'conflict':'rejected';}
  function stockRequest(s, invoke) {
    var owner=mReadScope.identity(), controller=new AbortController(), timer;
    var opts={idempotencyKey:s.operation.key,signal:controller.signal,isCurrent:function() { return !controller.signal.aborted&&owner===mReadScope.identity()&&owns(s); }};
    return new Promise(function(resolve,reject) {
      controller.signal.addEventListener('abort',function() { reject(Object.assign(new Error('The result was not confirmed. Retry the original saved request.'),{uncertain:true})); },{once:true});
      timer=setTimeout(function() { controller.abort(); },15000);
      Promise.resolve().then(function() { if(!opts.isCurrent())throw new Error('The sign-in changed. Recover the original action.');return invoke(opts); }).then(function(value) { if(!opts.isCurrent())throw Object.assign(new Error('The sign-in changed. Recover the original action.'),{cancelled:true});resolve(value); }).catch(reject);
    }).finally(function() { clearTimeout(timer); });
  }
  async function send(s){
    guard(s);var a=s.operation;
    if(busy[s.key]||a.local||['confirmed','rejected','conflict'].indexOf(a.state)!==-1)return;
    if(navigator.onLine===false&&!a.queueOnOffline)throw new Error('Reconnect to retry the original action.');
    if(Date.now()-a.created>=7*86400000){a.state='conflict';a.error='Attempt expired. Supervisor reconciliation is required.';await save(s);return;}
    busy[s.key]=true;
    try{
      a.state='sending';await save(s);
      for(var i=0;i<s.rows.length;i++){
        var row=s.rows[i];if(row.saved||a.multipart)continue;guard(s);
        var photo=await mPhoto.attachBlob(a.photoKind,a.photoRef,row.file,row.identifier,'Workflow evidence',{idempotencyKey:a.key+':photo:'+i});
        row.unitId=photo.id;row.local=API.syncLocal(photo);row.saved=true;await save(s);
        if(row.local){a.local=row.local;a.waitingPhoto=i;await save(s);return;}
      }
      if(!a.multipart&&s.rows.length&&!a.payload.evidence_ids){a.payload.evidence_ids=s.rows.map(function(r){return r.unitId;});await save(s);}
      guard(s);var result;
      if(a.multipart){var fd=new FormData();Object.keys(a.payload).forEach(function(k){if(a.payload[k]!=null)fd.append(k,String(a.payload[k]));});fd.append(a.fileField||'image',s.rows[0].file,s.rows[0].identifier);result=await API.upload(a.path,fd,{idempotencyKey:a.key});}
      else if(a.stockAction){
        var response=await stockRequest(s,function(opts){return a.queueOnOffline?mSubmit(a.path,a.payload,Object.assign({},opts,{keepReceipt:true,label:a.title})):API[a.method||'post'](a.path,a.payload,opts);});
        guard(s);if(a.queueOnOffline&&response.queued){a.phoneQueued=a.key;a.state='queued';await save(s);return;}
        result=a.queueOnOffline?response.response:response;
        if(result?.applied===false)throw Object.assign(new Error(result.message||'The server did not apply this action.'),{status:409});
        if(!mStockActionUI.validResult(a.stockAction,result))throw new Error('The response was incomplete. Retry the original saved request.');
      }
      else result=await API[a.method||'post'](a.path,a.payload,{idempotencyKey:a.key});
      guard(s);a.result=result;a.local=API.syncLocal(result);a.state='confirmed';a.error=null;await save(s);
    }catch(e){if(!owns(s))throw e;a.state=classify(e);a.error=e.message;await save(s);}finally{delete busy[s.key];}
  }
  async function start(s,options){
    guard(s);if(s.operation.state!=='draft')throw new Error('Recover the original decision first.');
    var route=s.operation.route;s.operation=Object.assign({kind:'workflow',route:route,state:'new',key:'workflow-'+crypto.randomUUID(),created:Date.now()},options,{payload:JSON.parse(JSON.stringify(options.payload))});
    await save(s);await send(s);return s;
  }
  function paint(view,s,afterPaint){
    guard(s);if(s.operation.stockAction&&window.mStockActionResult){mStockActionResult(view,s);return;}var a=s.operation,hash=location.hash;
    function visible(){return view.isConnected&&body&&body.isConnected&&hash===location.hash&&owns(s);}
    var final=a.state==='confirmed'&&!a.local;
    view.innerHTML='';var body=RoleUI.page(view,{role:a.role||'releasing',node:a.node||'78:438',title:final?'Action confirmed':'Review saved action',subtitle:a.title||'Operational decision'});
    body.innerHTML=RoleUI.result(final?(a.successLabel||'Server confirmed'):a.local?'Saved on site PC — confirmation pending':a.state==='rejected'?'Action refused':'Confirmation unresolved',a.title||'',final?'':'queued',final?'✓':'⏳')+
      (a.error?RoleUI.note('warn',mEsc(a.error)):'')+RoleUI.note(final?'info':'warn',final?'The original action was confirmed. Review current records before the next decision.':'The original request, evidence and key are retained. Do not repeat the physical action.')+
      RoleUI.actions((!a.local&&['new','unknown','sending'].indexOf(a.state)!==-1?[{id:'wf-retry',label:'Retry original action',kind:'primary'}]:[]).concat(final||a.state==='rejected'?[{id:'wf-review',label:'Review current record',kind:'primary'}]:[]).concat([{id:'wf-back',label:'Back to Work',kind:'secondary'}]))+'<div data-sync></div>';
    if(afterPaint)Promise.resolve(afterPaint(body,s,visible)).catch(function(e){if(visible())mToast(e.message,'err');});
    var retry=body.querySelector('#wf-retry');if(retry)retry.onclick=async function(){retry.disabled=true;try{await send(s);if(visible())paint(view,s,afterPaint);}catch(e){mToast(e.message,'err');retry.disabled=false;}};
    var review=body.querySelector('#wf-review');if(review)review.onclick=async function(){review.disabled=true;try{if(a.reviewPath)await API.get(a.reviewPath);guard(s);if(a.state==='rejected'){if(a.discardDraftOnReject)s.batch={};s.operation={kind:'workflow',route:a.route,state:'draft'};s.rows.forEach(function(r){if(!r.saved)r.local=null;});await save(s);}else await mProductionDrafts.remove(s);if(visible()){var route=a.reviewRoute||a.route,params=Object.assign({},a.reviewParams||{},a.resultParam&&a.result?{[a.resultParam]:a.result.id}:{});if(MApp.nav(route,params)===location.hash)MApp.render();else MApp.go(route,params);}}catch(e){mToast(e.message,'err');review.disabled=false;}};
    body.querySelector('#wf-back').onclick=function(){MApp.go('work');};
    if(a.local)body.querySelector('[data-sync]').appendChild(RoleUI.syncWatch(a.local,function(r){if(!visible())return;if(r.state==='confirmed'){a.local=null;if(a.waitingPhoto!=null){s.rows[a.waitingPhoto].local=null;delete a.waitingPhoto;a.state='new';}else a.state='confirmed';}else if(['failed','rejected','conflict'].indexOf(r.state)!==-1){a.state='conflict';a.error=r.error||'Reconcile the original site command.';}else return;save(s).then(function(){if(visible())paint(view,s,afterPaint);}).catch(function(e){mToast(e.message,'err');});}));
  }
  window.mWorkflow={owns:function(s){try{return owns(s);}catch(e){return false;}},load:load,draft:draft,save:save,start:start,send:send,paint:paint};
})();
