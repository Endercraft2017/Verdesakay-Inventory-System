/* Existing exact-unit evidence and source-closure handoffs, grouped for review. */
(function(){var U=mCountUI,R=RoleUI,base=U.base,field=U.field;
function go(p){MApp.go('stock-counts',p||{});}
function live(view,hash,s){return view.isConnected&&hash===location.hash&&mWorkflow.owns(s);}
function draftSave(s){return mWorkflow.save(s);}
function sourceLabel(kind){return kind==='discrepancy'?'Stock discrepancy':'Direct-sale audit';}
  async function detail(view,id,s,scope){
    var hash=location.hash,r=await U.get(scope,base+'/'+id,U.validCount);if(!live(view,hash,s))return;var body=U.page(view,'Review count #'+r.id),can=MApp.can('inventory.review_counts');
    function unit(u){return R.field(u.code,u.status+' · location '+(u.location_id||'unknown'))+(MApp.canOpen('record')?'<button class="rk-btn secondary" data-record="'+u.id+'">Open exact unit record</button>':'');}
    body.innerHTML='<div class="cardhead"><span class="pill">'+mEsc(U.phase(r.status))+'</span><span class="muted">Counted by '+(Number(r.counted_by)===Number(MApp.getMe().id)?'you':'employee #'+mEsc(r.counted_by))+'</span></div>'+U.identity(r)+U.totals(r.book_quantity,r.counted_quantity,r.unit)+
      '<div class="flow" aria-label="Count lifecycle"><span>1 Recorded</span><span>2 Approved</span><span>3 Reconciled</span></div><div data-review class="m-count-stack"></div>'+
      '<details><summary>Count evidence · '+(r.counted_serial_codes||[]).length+' serials · '+(r.counted_batches||[]).length+' batches</summary><div>'+R.field('Count note',r.note)+R.field('Physically found untracked',String(r.counted_untracked))+R.section('Counted serial labels')+((r.counted_serial_codes||[]).map(function(code){return R.field(code,'Physically observed');}).join('')||R.note('info','No serials counted'))+R.section('Counted batches')+((r.counted_batches||[]).map(function(batch){var book=(r.book_batches||[]).find(function(b){return b.batch_id===batch.batch_id;});return R.field('Batch #'+batch.batch_id,'Book '+(book?book.quantity:'unknown')+' · found '+batch.quantity);}).join('')||R.note('info','No batches counted'))+R.section('Missing book serials')+((r.missing_serials||[]).map(unit).join('')||R.note('info','None'))+R.section('Unexpected serials physically found')+((r.unexpected_serials||[]).map(function(u){return u.matches.length===1?unit(u.matches[0]):R.field(u.code,u.matches.length?'Ambiguous label — investigate':'Unknown label — investigate');}).join('')||R.note('info','None'))+
      '</div></details><details><summary>Review and reconciliation history</summary><div>'+R.field('Reviewer note',r.review_note||'Awaiting independent review')+R.field('Current shelf quantity',r.current_quantity==null?'Unavailable':r.current_quantity)+R.field('Counted at',r.counted_at||'Not stored')+'</div></details>'+
      '<div data-source-close class="m-count-stack"></div>'+R.actions([{id:'count-history',label:'Count history',kind:'secondary'}]);
    body.querySelectorAll('[data-record]').forEach(function(btn){btn.onclick=function(){MApp.go('record',{unit:btn.dataset.record});};});body.querySelector('#count-history').onclick=function(){go();};
    if(r.source_kind!=='manual'&&r.source_id&&!r.source_closed_at){
      var sourceBox=body.querySelector('[data-source-close]');
      var reconciled=r.status==='applied'&&U.observationMatches(r);
      if(can&&reconciled&&r.source_status==='open'){
        sourceBox.innerHTML=R.section('Close linked issue')+R.note('info','This closes only the linked '+(r.source_kind==='discrepancy'?'discrepancy':'direct-sale audit')+'. It does not move stock. Review the current evidence before confirming.')+
          field('Closure reviewer note — at least 10 characters','<textarea class="rk-input" data-close-note maxlength="1000"></textarea>')+R.actions([{id:'count-close-source',label:'Close linked issue',kind:'primary'}]);
        var input=sourceBox.querySelector('[data-close-note]');input.value=s.batch.closureCount===r.id?s.batch.closureNote||'':'';
        input.oninput=function(){s.batch.closureCount=r.id;s.batch.closureNote=input.value;draftSave(s).catch(function(){});};
        sourceBox.querySelector('#count-close-source').onclick=async function(){var btn=this;try{var note=input.value.trim();if(note.length<10)throw new Error('Explain the issue closure in at least 10 characters.');if(!await U.confirm(sourceBox,'Close '+sourceLabel(r.source_kind)+' #'+r.source_id+' using reconciled count #'+r.id+'? No stock will move.'))return;if(!live(view,hash,s)||!scope.current())return;btn.disabled=true;await draftSave(s);await U.decision(view,s,scope,base+'/'+r.id+'/close-source',{note:note},'Close linked issue from count #'+r.id,r);}catch(e){mToast(e.message,'err');btn.disabled=false;}};
      }else if(r.status==='applied'&&(!reconciled||r.source_status==='changed')){
        sourceBox.innerHTML=R.note('warn','Stock or source evidence changed after this observation. Refresh the shelf and audit evidence, then start a new physical count. Do not close the old issue from this count.');
      }else if(r.source_status==='open'){
        sourceBox.innerHTML=R.note('info',can?'Reconcile the count before closing its linked issue.':'A supervisor closes the linked issue after reconciliation.');
      }else sourceBox.innerHTML=R.note('info','The linked issue is '+(r.source_status||'unavailable')+'. No closure action is available.');
    }
    if(r.source_kind!=='manual'&&r.source_id){
      var evidence=document.createElement('div');body.querySelector('[data-source-close]').appendChild(evidence);
      evidence.innerHTML=R.actions([{id:'count-source-evidence',label:'Review current linked evidence',kind:'secondary'}]);
      evidence.querySelector('#count-source-evidence').onclick=async function(){var btn=this;btn.disabled=true;try{
        var rows=await U.get(scope,r.source_kind==='discrepancy'?'/inventory/discrepancies?status=all':'/inventory/direct-sale-audit?status=all',Array.isArray);if(!live(view,hash,s))return;
        var source=rows.find(function(row){return r.source_kind==='discrepancy'?row.id===r.source_id:row.order_id===r.source_id&&row.item_id===r.item_id;});
        if(!source){evidence.innerHTML=R.note('warn','Current source evidence is unavailable in this queue. Ask a supervisor to review the original record.');return;}
        evidence.innerHTML=R.section('Current linked evidence')+(r.source_kind==='discrepancy'?R.field('Original issue',source.reason)+R.field('Current status',source.status)+R.field('Current shelf quantity',String(source.location_quantity_now))+R.field('Resolution note',source.resolution_note||'Open review'):R.field('Sale order',source.order_number)+R.field('Current status',source.status)+R.field('Shipped / ledger removed / possible excess',source.shipped_quantity+' / '+source.removed_quantity+' / '+source.possible_extra_quantity)+R.field('Ledger evidence',r.source_evidence_hash===source.evidence_hash?'Matches the counted evidence':'Changed — start a fresh linked count')+(source.movements||[]).map(function(m){return R.field(m.reason,m.change+' · '+m.location_name+' · '+m.created_at);}).join(''));
      }catch(e){mToast(e.message,'err');btn.disabled=false;}};
      if(r.source_status==='changed'||r.status==='rejected'||r.status==='applied'&&(r.current_quantity!==r.counted_quantity||r.tracked_difference)){
        var fresh=document.createElement('button');fresh.className='rk-btn secondary';fresh.id='count-fresh-linked';fresh.textContent='Start fresh linked count';body.appendChild(fresh);fresh.onclick=async function(){try{
          if(s.batch.context){if(!await U.confirm(body,'Discard the existing draft before starting a fresh linked count?'))return;if(!scope.current())return;await mProductionDrafts.remove(s);}
          go({item:r.item_id,location:r.location_id,mode:r.build_mode,source_kind:r.source_kind,source_id:r.source_id});
        }catch(e){mToast(e.message,'err');}};
      }
    }
    if(r.source_kind!=='manual'&&r.source_id)body.querySelector('[data-source-close]').insertAdjacentHTML('afterbegin',R.field('Linked issue',sourceLabel(r.source_kind)+' #'+r.source_id+' · '+r.source_status)+(r.source_closed_at?R.field('Source closure',r.source_closed_at+' · reviewer #'+r.source_closed_by)+R.field('Closure note',r.source_close_note):''));
    var review=body.querySelector('[data-review]'),actions=[],snapshot=U.snapshotMatches(r),serials=U.serialsMatch(r),reconciled=U.observationMatches(r);
    if(r.status==='submitted'){
      review.innerHTML=R.note('info','Recording and approval do not change stock. A different authorized person must approve the observation.');
      if(can){if(Number(r.counted_by)!==Number(MApp.getMe().id)&&snapshot)actions.push('approve');actions.push('reject');}
      if(!snapshot)review.innerHTML+=R.note('warn','Stock changed after this snapshot. Refresh and recount before approval.');
      else if(Number(r.counted_by)===Number(MApp.getMe().id))review.innerHTML+=R.note('info','You recorded this observation. Ask a different authorized reviewer to approve it.');
    }else if(r.status==='approved'){
      review.innerHTML=R.note('info','Approval does not change stock. Apply a guarded correction, or verify stock corrected through its existing workflow.');
      var held=(r.counted_batches||[]).some(function(b){var current=(r.current_batches||[]).find(function(c){return c.batch_id===b.batch_id;});return current&&b.quantity<current.reserved;});
      if(can&&snapshot&&serials&&!held)actions.push('apply');if(can&&reconciled)actions.push('verify');
      if(!serials)review.innerHTML+=R.note('warn','Exact serials differ. Resolve the exact unit records, then verify this count. A generic correction cannot move or write off a serial.');
      else if(!snapshot&&!reconciled)review.innerHTML+=R.note('warn','Stock changed after the count. Refresh and recount before a correction.');
      if(held)review.innerHTML+=R.note('warn','A batch correction would go below its reserved quantity. Review the allocation before correction.');
    }else review.innerHTML=R.note('info',r.status==='applied'?'Reconciliation confirmed. This count cannot be applied again.':'Observation rejected. A fresh physical count is required.');
    if(actions.length){
      review.innerHTML+=field('Review note · at least 10 characters','<textarea data-review-note maxlength="1000" aria-describedby="count-review-error"></textarea>')+'<p class="error" id="count-review-error" role="status"></p>'+R.actions(actions.map(function(a){return {id:'count-'+a,label:({approve:'Approve observation',reject:'Reject observation',apply:'Apply guarded stock correction',verify:'Verify separately corrected stock'})[a],kind:a==='reject'?'secondary':'primary'};}));
      var input=review.querySelector('[data-review-note]');input.value=s.batch.reviewCount===r.id?s.batch.reviewNote||'':'';input.oninput=function(){s.batch.reviewCount=r.id;s.batch.reviewNote=this.value;mWorkflow.save(s).catch(function(e){if(scope.current())review.querySelector('#count-review-error').textContent=e.message;});};
      actions.forEach(function(a){review.querySelector('#count-'+a).onclick=async function(){if(review._busy)return;review._busy=true;try{var note=input.value.trim();if(a!=='apply'&&note.length<10)throw new Error('Record a reviewer note of at least 10 characters.');var text=a==='apply'?'Apply a guarded correction from '+r.book_quantity+' to '+r.counted_quantity+'? The server checks current stock, serials and batch provenance.':a==='verify'?'Verify that separately corrected stock matches this observation? No stock will move.':a==='approve'?'Approve this observation? Stock remains unchanged.':'Reject this observation and require a recount? No stock will move.';if(!await U.confirm(review,text))return;if(!scope.current()||!body.isConnected)return;review.querySelectorAll('button,textarea').forEach(function(el){el.disabled=true;});await U.decision(view,s,scope,base+'/'+r.id+'/'+a,a==='apply'?{}:{note:note},a+' count #'+r.id,r);}catch(e){if(scope.current()&&body.isConnected){if(s.operation.state!=='draft')mCountResult(view,s);else{review.querySelector('#count-review-error').textContent=e.message;review.querySelectorAll('button,textarea').forEach(function(el){el.disabled=false;});}}}finally{review._busy=false;}};});
    }
  }
  window.mCountDetail=detail;
})();
