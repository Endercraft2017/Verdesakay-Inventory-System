/* Saved stock-action result: original fields and keys survive uncertain writes,
   phone queue delivery and site-PC acknowledgement. Never infer success from an
   operation disappearing from the phone queue. */
(function () {
  var serial=0;
  window.mStockActionResult=function(view,s){
    var a=s.operation,d=a.stockAction,U=mStockActionUI,root=mEl('<section class="m-stock-result"></section>');view.replaceChildren(root);MApp.setTitle('Saved action');
    var busy=false,polling=false,firstPaint=true,unsubscribe,photos=new AbortController(),scope=mReadScope.create(root,function(){unsubscribe?.();photos.abort();}),uid='stock-result-'+(++serial);
    function current(){return scope.current()&&mWorkflow.owns(s);}
    function final(){return a.state==='confirmed'&&!a.local&&!a.phoneQueued;}
    function label(){return final()?'Action confirmed':a.state==='rejected'?'Action refused':a.state==='conflict'?'Needs reconciliation':a.phoneQueued?'Saved on phone':a.local?'Saved on site PC':'Confirmation unresolved';}
    function note(){return final()?'The server confirmed this action. Review current stock before recording another movement.':a.state==='rejected'?'The server refused this action. Review current stock and correct the original draft.':a.state==='conflict'?'The saved action needs reconciliation. Do not submit a replacement.':a.phoneQueued?'Waiting to send or confirm the original queued request. Do not enter it again.':a.local?'The site PC saved this action. Server confirmation is pending. Do not enter it again.':'The result was not confirmed. Retry the original saved request. Do not repeat the physical movement.';}
    function row(key,value){return '<div><dt>'+mEsc(key)+'</dt><dd>'+value+'</dd></div>';}
    function paint(){
      if(!current())return;
      root.innerHTML='<div class="m-stock-result-mark" aria-hidden="true">'+(final()?'✓':a.state==='rejected'?'!':'…')+'</div><h1 tabindex="-1" id="'+uid+'-title">'+label()+'</h1><p>'+note()+'</p>'+(a.error?'<p class="m-stock-action-error" role="alert">'+mEsc(a.error)+'</p>':'')+'<dl class="m-stock-action-summary">'+row('Action',mEsc(U.titles[d.kind])+' · '+mEsc(U.quantity(d.quantity,d.item.unit)))+row('Item',mEsc(d.item.name)+'<br>'+mEsc(d.item.sku?'#'+d.item.sku:'No SKU'))+row(d.kind==='in'?'Location':'From',d.sources?.length?d.sources.map(function(r){return mEsc(r.name)+' · '+mEsc(U.quantity(r.quantity,d.item.unit));}).join('<br>'):mEsc(d.from))+(d.to?row('To',mEsc(d.to)):'')+(U.finished(d.item)?row('Build state',d.build_mode==='semi_built'?'Semi-built':'Fully built / standard'):'')+row('Reason',mEsc(d.reason||'Not provided'))+(d.serials?.length?row('Serials',d.serials.map(mEsc).join('<br>')):'')+'</dl>'+
        (!a.local&&!a.phoneQueued&&['new','unknown','sending'].includes(a.state)?'<button class="m-btn" data-retry>Retry original action</button>':'')+
        (final()||a.state==='rejected'?'<button class="m-btn" data-review>Review current record</button>':'')+
        (a.phoneQueued?'<button class="m-btn m-btn-secondary" data-queue>Open Pending sync</button>':'')+
        '<details><summary>Saved request details</summary><p>'+mEsc(a.key)+' · Reused on retry</p></details><button class="m-btn m-btn-secondary" data-back>Back to Work</button><div data-extra></div><div data-feedback role="status"></div>';
      var retry=root.querySelector('[data-retry]');if(retry){retry.disabled=!mStockForms.permitted(d.kind);retry.onclick=async function(){if(busy||!current()||!mStockForms.permitted(d.kind))return;busy=true;retry.disabled=true;retry.textContent='Retrying original…';try{await mWorkflow.send(s);}catch(error){if(current())a.error=error.message;}finally{busy=false;if(current())paint();}};}
      var review=root.querySelector('[data-review]');if(review)review.onclick=async function(){
        if(busy||!current())return;busy=true;review.disabled=true;
        try{
          var item=await scope.run(function(opts){return API.get(a.reviewPath,opts);});if(!current())return;
          if(!U.validItem(item,d.item.id))throw new Error('Current stock could not be verified. Retry reviewing it.');
          if(a.queueOnOffline)await mQueue.discard(a.key);if(!current())return;
          if(a.state==='rejected'){
            s.operation={kind:'workflow',route:a.route,state:'draft'};await mWorkflow.save(s);
          }else await mProductionDrafts.remove(s);
          if(!current())return;await mQueue.forgetReceipt?.(a.key);if(current())mStockForms.navigate(a.reviewRoute||a.route,d.kind==='in'||d.kind==='out'?{mode:d.kind}:{});
        }catch(error){if(current()){root.querySelector('[data-feedback]').textContent=error.message;review.disabled=false;}}
        finally{busy=false;}
      };
      var queue=root.querySelector('[data-queue]');if(queue)queue.onclick=function(){if(current())MApp.go('queue');};
      root.querySelector('[data-back]').onclick=function(){if(current())MApp.go('work');};
      if(final()&&d.kind==='damage'&&a.result?.twin_id){
        var extra=root.querySelector('[data-extra]');extra.appendChild(mEl('<h2>Photos of damage</h2>'));
        extra.appendChild(mPhoto.thumbs('damage',a.result.twin_id,{editable:mStockForms.permitted('damage'),caption:d.reason,scope:scope,signal:photos.signal}));
      }
      if(firstPaint){firstPaint=false;var main=root.closest('#m-view');if(main)main.scrollTop=0;window.scrollTo(0,0);}
      if(root.querySelector('[data-retry]')?.textContent!=='Retrying original…')root.querySelector('h1').focus({preventScroll:true});
    }
    async function check(){
      if(!current()||polling)return;polling=true;
      try{
        if(a.phoneQueued){
          var receipt=await mQueue.receipt(a.phoneQueued);if(!current())return;
          if(receipt){
            if(receipt.state==='discarded'||receipt.state==='conflict'){a.state='conflict';a.error=receipt.error||'The phone copy was discarded. Reconcile the original action before recording a replacement.';a.phoneQueued=null;}
            else if(!['confirmed','local','rejected'].includes(receipt.state)||receipt.state!=='rejected'&&!U.validResult(d,receipt.response)){a.phoneQueued=null;a.local=null;a.state='unknown';a.error='The queued response was incomplete. Retry the original saved request.';}
            else{a.result=receipt.response;a.local=receipt.local||null;a.phoneQueued=null;a.state=receipt.state==='rejected'?'rejected':'confirmed';a.error=receipt.state==='rejected'?(receipt.response?.message||'The server refused the queued action.'):null;}
            await mWorkflow.save(s);if(current())paint();
          }else{
            var op=(await mQueue.all()).find(function(r){return r.key===a.phoneQueued;});if(!current())return;
            if(op?.error&&!op.uncertain&&a.state!=='rejected'){a.state='rejected';a.error=op.error;await mWorkflow.save(s);if(current())paint();}
            else if(!op){root.querySelector('[data-feedback]').textContent='The queued result could not be verified. Check Pending sync; do not enter a replacement.';}
          }
        }
        if(a.local){
          var state=await scope.run(function(opts){return API.get('/sync/command/'+encodeURIComponent(a.local),opts);});if(!current())return;
          if(!state||typeof state.state!=='string')throw new Error('Server confirmation could not be read.');
          if(state.state==='confirmed'){a.local=null;a.state='confirmed';await mWorkflow.save(s);if(current())paint();}
          else if(['failed','rejected','conflict'].includes(state.state)){a.local=null;a.state='conflict';a.error=state.error||'Reconcile the original site command.';await mWorkflow.save(s);if(current())paint();}
        }
      }catch(error){if(current()&&!error.cancelled)root.querySelector('[data-feedback]').textContent=error.message;}
      finally{polling=false;if(current()&&(a.phoneQueued||a.local))scope.later(check,a.local?10000:3000);}
    }
    paint();if(a.phoneQueued&&window.mQueue)unsubscribe=mQueue.onChange(check);if(a.phoneQueued||a.local)check();
  };
})();
