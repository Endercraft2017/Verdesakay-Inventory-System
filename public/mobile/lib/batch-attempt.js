/* Account-owned batch movements. Persist every row/key before sending; each row
   is an independent existing /adjust request, never an atomic batch promise. */
(function () {
  var locks = new Set();
  function own(s) { return mWorkflow.owns(s); }
  function guard(s) { if (!own(s)) throw new Error('Recover this batch with the original account and server.'); }
  function permitted() { return MApp.can('inventory.adjust'); }
  function entries(s) { return s.operation.entries || []; }
  function pending(r) { return ['new','sending','unknown','queued','local','conflict'].includes(r.state); }
  function valid(r, result) { return mStockActionUI.validResult({kind:r.mode,quantity:r.quantity,build_mode:r.build_mode}, result); }
  function refusal(error) {
    if (error.status === 409 && /different request|save key/i.test(error.message)) return 'conflict';
    return !error.status || error.status >= 500 || [401,403,429].includes(error.status) ? 'unknown' : 'refused';
  }
  async function load(mode) {
    var s = await mWorkflow.draft('batch-' + mode);
    entries(s).forEach(function (r) { if (r.state === 'sending') r.state = 'unknown'; });
    return s;
  }
  async function prepare(s, rows, details) {
    guard(s);
    if (!permitted()) throw new Error('Stock adjustment access is required.');
    var old = s.operation, correction = old.state === 'batch' && s.batch.review;
    if (old.state !== 'draft' && !correction) throw new Error('Review the original saved batch first.');
    if (correction && rows.some(function(r) { return !entries(s).some(function(e) { return e.id===r.item.id && e.state==='refused'; }); })) throw new Error('Only refused rows can be corrected.');
    // A rejected queued copy must be removed before a fresh corrected request.
    if (correction) for (var row of rows) {
      var prior = entries(s).find(function(r) { return r.id===row.item.id; });
      if (prior.phoneQueued) { await mQueue.discard(prior.key); await mQueue.forgetReceipt(prior.key); }
    }
    var next = rows.map(function (r) {
      var prior = correction && entries(s).find(function(e) { return e.id===r.item.id; });
      return {id:r.item.id,name:r.item.name,sku:r.item.sku||'',unit:r.item.unit||'',finished:mStockActionUI.finished(r.item),mode:details.mode,
        quantity:Number(r.quantity),build_mode:mStockActionUI.finished(r.item)?r.build_mode:'assembled',
        key:'batch-'+crypto.randomUUID(),created:Date.now(),state:'new',previousKey:prior?prior.key:null,
        path:'/inventory/'+r.item.id+'/adjust',payload:{change:(details.mode==='out'?-1:1)*Number(r.quantity),location_id:details.location_id,build_mode:mStockActionUI.finished(r.item)?r.build_mode:'assembled',reason:details.note||null}};
    });
    s.operation = {kind:'workflow',route:old.route,state:'batch',mode:details.mode,location_id:details.location_id,location:details.location,note:details.note||'',created:old.created||Date.now(),entries:correction?entries(s).map(function(r) { return next.find(function(n) { return n.id===r.id; })||r; }):next};
    var previousReview=s.batch.review;s.batch.review=false;
    try { await mWorkflow.save(s); } catch (error) { s.operation=old;s.batch.review=previousReview;throw error; }
  }
  async function request(s, row, identity) {
    var controller=new AbortController(),timer;
    function current() { return own(s)&&identity===mReadScope.identity()&&!controller.signal.aborted; }
    try {
      return await new Promise(function(resolve,reject) {
        controller.signal.addEventListener('abort',function() { reject(new Error('The result was not confirmed. Check the original saved request.')); },{once:true});
        timer=setTimeout(function() { controller.abort(); },15000);
        mSubmit(row.path,row.payload,{idempotencyKey:row.key,keepReceipt:true,label:'Batch Stock '+(row.mode==='out'?'Out':'In')+' · '+row.name,isCurrent:current,signal:controller.signal}).then(resolve,reject);
      });
    } finally { clearTimeout(timer); }
  }
  function accept(row, result, local) {
    if (result?.applied===false) { row.state='refused';row.error=result.message||'The server refused this row.';return; }
    if (!valid(row,result)) { row.state='unknown';row.error='The response was incomplete. Check the original request.';return; }
    row.result=result;row.local=local||null;row.state=local?'local':'confirmed';row.error=null;
  }
  async function send(s, onChange) {
    guard(s);if(locks.has(s.key)||!permitted())return;locks.add(s.key);
    var identity=mReadScope.identity();
    try {
      for (var row of entries(s)) {
        if(!own(s)||identity!==mReadScope.identity()||!permitted())break;
        if(!['new','unknown'].includes(row.state))continue;
        if(Date.now()-row.created>=7*86400000){row.state='conflict';row.error='This request is too old to replay safely. Supervisor reconciliation is required.';await mWorkflow.save(s);continue;}
        row.state='sending';await mWorkflow.save(s);onChange?.();
        try {
          var response=await request(s,row,identity);
          if(!own(s)||identity!==mReadScope.identity())return;
          if(response.queued){row.state='queued';row.phoneQueued=true;row.error=null;}
          else accept(row,response.response,response.local);
        }catch(error){if(!own(s)||identity!==mReadScope.identity())return;row.state=refusal(error);row.error=error.message;}
        await mWorkflow.save(s);onChange?.();
      }
    } finally { locks.delete(s.key);onChange?.(); }
  }
  async function reconcile(s, retry) {
    guard(s);if(locks.has(s.key)||!permitted())return;locks.add(s.key);
    try {
      for (var row of entries(s)) {
        if(!own(s)||!permitted())return;
        if(row.state==='queued'){
          if(retry)await mQueue.retry(row.key);
          var receipt=await mQueue.receipt(row.key);guard(s);
          if(receipt){
            if(['discarded','conflict'].includes(receipt.state)){row.state='conflict';row.error='The phone copy was discarded or conflicted. Reconcile the original movement.';}
            else if(receipt.state==='rejected'){row.state='refused';row.error=receipt.response?.message||receipt.error||'The server refused this row.';}
            else if(['confirmed','local'].includes(receipt.state))accept(row,receipt.response,receipt.local);
          }else{
            var queued=(await mQueue.all()).find(function(q){return q.key===row.key;});guard(s);
            if(queued?.error&&!queued.uncertain){row.state='refused';row.error=queued.error;}
            else if(!queued){row.state='unknown';row.error='No confirmation receipt was found. The original request key is retained.';}
          }
        }
        if(row.state==='local'&&row.local){
          var confirmation=await API.get('/sync/command/'+encodeURIComponent(row.local),{isCurrent:function(){return own(s)&&permitted();}});guard(s);
          if(confirmation?.state==='confirmed'){row.state='confirmed';row.local=null;}
          else if(['failed','rejected','conflict'].includes(confirmation?.state)){row.state='conflict';row.error=confirmation.error||'The site command needs reconciliation.';}
        }
      }
      await mWorkflow.save(s);
    } finally { locks.delete(s.key); }
    if(retry)await send(s);
  }
  window.mBatchAttempt={load:load,prepare:prepare,send:send,reconcile:reconcile,entries:entries,pending:pending,busy:function(s){return locks.has(s.key);}};
})();
