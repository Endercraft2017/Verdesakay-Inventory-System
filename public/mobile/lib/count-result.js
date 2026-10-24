/* Immutable count attempts, including legacy saved keys. No optimistic stock success. */
(function(){
  var U=mCountUI;
  window.mCountResult=function(view,s){
    var a=s.operation,k=U.kind(a),d=a.countAction||a.result||s.batch.context||{},mount=document.createElement('div');view.replaceChildren(mount);
    var scope=mReadScope.create(mount),busy=false,polling=false,first=true;
    function current(){return scope.current()&&mWorkflow.owns(s);}
    function final(){return a.state==='confirmed'&&!a.local;}
    function permission(){return MApp.can(k==='submit'?'inventory.count':'inventory.review_counts');}
    var titles={submit:'Observation submitted',approve:'Observation approved',reject:'Observation rejected',apply:'Stock correction confirmed',verify:'Reconciliation verified','close-source':'Linked issue closed'};
    var verbs={submit:'Record physical observation',approve:'Approve observation',reject:'Reject observation',apply:'Apply guarded stock correction',verify:'Verify corrected stock','close-source':'Close linked issue'};
    function paint(){if(!current())return;
      var body=U.page(mount,'Count submission'),heading=final()?titles[k]||'Decision confirmed':a.local?'Saved on site PC':a.state==='rejected'?'Action refused':a.state==='conflict'?'Needs reconciliation':'Confirmation unresolved';
      var note=final()?(k==='apply'?'The server confirmed the guarded stock correction.':k==='verify'?'Separately corrected stock was verified. No additional stock moved.':k==='close-source'?'The linked issue was closed. No stock moved.':'No stock changed from this decision. Review current records before the next decision.'):a.local?'The site PC saved the original request. Final authority confirmation is pending.':a.state==='rejected'?'The server refused the request. Review current records before correcting the draft.':a.state==='conflict'?'Reconcile the original site command. Do not submit a replacement.':'The request may have reached the server. Retry the same original request; do not submit a new observation.';
      var found=d.found??a.result?.counted_quantity??(k==='submit'&&U.qty(a.payload?.counted_untracked)?a.payload.counted_untracked+(a.payload.counted_serial_codes||[]).length+(a.payload.counted_batches||[]).reduce(function(n,b){return n+b.quantity;},0):null);
      body.innerHTML='<section class="card statebox" aria-live="polite"><span class="pill">'+mEsc(final()?k==='submit'?'Awaiting independent review':'Server confirmed':a.local?'Authority confirmation pending':'Unresolved')+'</span><h2 tabindex="-1">'+mEsc(heading)+'</h2><p>'+mEsc(note)+'</p></section>'+U.identity(d)+(a.error?'<p class="error" role="alert">'+mEsc(a.error)+'</p>':'')+'<dl class="card"><div><dt>Action</dt><dd>'+mEsc(verbs[k]||a.title)+'</dd></div><div><dt>Found</dt><dd>'+mEsc(found==null?'Not stored':found+' '+(d.unit||'pcs'))+'</dd></div><div><dt>Note</dt><dd>'+mEsc(a.payload?.note||'Uses saved approval note')+'</dd></div></dl><details><summary>Original saved evidence</summary><div><p>Request: <code>'+mEsc(a.key)+'</code></p>'+(k==='submit'?'<p>'+mEsc((a.payload.counted_serial_codes||[]).length)+' serial labels · '+mEsc((a.payload.counted_batches||[]).length)+' batch counts</p>':'')+'</div></details>'+
        (!a.local&&['new','unknown','sending'].includes(a.state)?'<button type="button" class="primary" id="wf-retry">Retry original request</button>':'')+
        (final()||a.state==='rejected'?'<button type="button" class="primary" id="wf-review">Review current record</button>':'')+
        (a.local?'<button type="button" id="count-check-confirmation">Check confirmation</button>':'')+'<button type="button" id="wf-back">Back to Work</button><p data-result-feedback class="error" role="status"></p>';
      var retry=body.querySelector('#wf-retry');if(retry){retry.disabled=!permission();retry.onclick=async function(){if(busy||!current()||!permission())return;busy=true;retry.disabled=true;retry.textContent='Retrying original…';try{await mWorkflow.send(s);}catch(e){if(current())a.error=e.message;}finally{busy=false;if(current())paint();}};}
      var review=body.querySelector('#wf-review');if(review)review.onclick=async function(){if(busy||!current())return;busy=true;review.disabled=true;try{
        var path=a.reviewPath||U.base+(a.result?.id?'/'+a.result.id:'?status=all');await U.get(scope,path,path.includes('?')?function(r){return Array.isArray(r)&&r.every(U.validCount);}:U.validCount);if(!current())return;
        var params=a.result?.id?{id:a.result.id}:a.reviewParams||{};
        if(a.state==='rejected'&&k==='submit')params={item:a.payload.item_id,location:a.payload.location_id,mode:a.payload.build_mode,task:a.payload.task_id||'',source_kind:a.payload.source_kind,source_id:a.payload.source_id||''};
        var history=s.batch.history,keepContext=k!=='submit'&&s.batch.context;
        s.operation={kind:'workflow',route:'stock-counts',state:'draft'};
        if(!keepContext)s.batch=history?{history:history}:{};
        await mWorkflow.save(s);if(current()){if(MApp.nav('stock-counts',params)===location.hash)MApp.render();else MApp.go('stock-counts',params);}
      }catch(e){if(current()){body.querySelector('[data-result-feedback]').textContent=e.message;review.disabled=false;}}finally{busy=false;}};
      body.querySelector('#wf-back').onclick=function(){if(current())MApp.go('work');};body.querySelector('#count-check-confirmation')?.addEventListener('click',check);
      if(first){first=false;var main=mount.closest('#m-view');if(main)main.scrollTop=0;window.scrollTo(0,0);body.querySelector('h2').focus({preventScroll:true});}
    }
    async function check(){if(!current()||polling||!a.local)return;polling=true;try{
      var state=await U.get(scope,'/sync/command/'+encodeURIComponent(a.local),function(r){return r&&typeof r.state==='string';});if(!current())return;
      if(state.state==='confirmed'){a.local=null;if(U.validResult(a,a.result)){a.state='confirmed';a.error=null;}else{a.state='unknown';a.error='The original response was incomplete. Retry the original saved request.';}await mWorkflow.save(s);if(current())paint();}
      else if(['failed','rejected','conflict'].includes(state.state)){a.local=null;a.state='conflict';a.error=state.error||'Reconcile the original site command.';await mWorkflow.save(s);if(current())paint();}
    }catch(e){if(current()&&!e.cancelled)mount.querySelector('[data-result-feedback]').textContent=e.message;}finally{polling=false;if(current()&&a.local)scope.later(check,10000);}}
    if(a.state==='confirmed'&&!a.local&&!U.validResult(a,a.result)){a.state='unknown';a.error='The original response was incomplete. Retry the original saved request.';mWorkflow.save(s).catch(function(e){if(current())mount.querySelector('[data-result-feedback]').textContent=e.message;});}
    paint();if(a.local)check();
  };
})();
