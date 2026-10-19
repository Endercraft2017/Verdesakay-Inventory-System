/* Physical observations, independent review and exact serial exceptions. No generic adjustment. */
(function () {
  var R = RoleUI, base = '/inventory/stock-counts';
  function go(p) { if(MApp.nav('stock-counts',p||{})===location.hash)MApp.render();else MApp.go('stock-counts', p || {}); }
  function page(view, title) { return R.page(view, {role:'inventory', title:title, subtitle:'Count the exact shelf and build state'}); }
  function sourceLabel(kind){return kind==='discrepancy'?'Stock discrepancy':'Direct-sale audit';}
  function field(label, input) { return '<label class="rk-card rk-field"><small>' + mEsc(label) + '</small>' + input + '</label>'; }
  function integer(value) { return value !== '' && Number.isSafeInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 1000000; }
  function codes(b) { return (b.codes || []).slice(); }
  function live(view, hash, s) { return view.isConnected && location.hash === hash && mWorkflow.owns(s); }
  function draftSave(s) { return mWorkflow.save(s).catch(function(e){ mToast(e.message, 'err'); throw e; }); }
  async function decision(view, s, path, payload, title, id) {
    var hash=location.hash;
    try{await mWorkflow.start(s, {path:path, payload:payload, role:'inventory', discardDraftOnReject:true, title:title, successLabel:path===base?'Observation submitted — awaiting review':/\/close-source$/.test(path)?'Linked issue closed — no stock moved':'Decision confirmed', reviewRoute:'stock-counts', reviewParams:id?{id:id}:{}, reviewPath:id?base+'/'+id:base+'?status=all', resultParam:path===base?'id':null});}catch(e){if(e.message==='Reconnect to retry the original action.'&&live(view,hash,s))mWorkflow.paint(view,s);throw e;}
    if(live(view,hash,s)) mWorkflow.paint(view,s);
  }
  async function form(view, p, s) {
    var hash=location.hash, b=s.batch;
    if(!b.context) {
      if(!p.task&&(!p.source_kind||p.source_kind==='manual')){
        var assignments=await API.get(base+'/tasks?status=open');if(!live(view,hash,s))return;
        var assigned=assignments.find(function(t){return t.item_id===Number(p.item)&&t.location_id===Number(p.location)&&t.build_mode===(p.mode||'assembled');});
        if(assigned){MApp.go('stock-count-tasks',{id:assigned.id});return;}
      }
      var c=await API.get(base+'/context?item_id='+encodeURIComponent(p.item)+'&location_id='+encodeURIComponent(p.location)+'&build_mode='+encodeURIComponent(p.mode||'assembled'));
      if(!live(view,hash,s))return;
      b.context=c;b.codes=[];b.batches={};b.untracked='';b.note='';b.task=p.task?Number(p.task):null;
      b.source_kind=p.source_kind||'manual';b.source_id=p.source_id?Number(p.source_id):null;await draftSave(s);
    }
    if(!live(view,hash,s))return;
    var c=b.context, body=page(view,'Physical stock count');
    body.innerHTML=R.field('Item',c.item_name)+R.field('Location',c.location_name)+R.field('Build state',c.build_mode==='semi_built'?'Semi-built':'Fully built')+R.field('Book quantity',String(c.book_quantity))+
      R.note('info','Record what is physically here. Submission does not change stock. Serials are unchecked until scanned. Unexpected labels belong in the serial list, never untracked quantity.')+
      (b.task?R.field('Assignment','#'+b.task)+(b.assignment?R.field('Due date',b.assignment.due_date+' (UTC)')+R.field('Instructions',b.assignment.note||'No extra instructions'):''):'')+field('Physically found untracked quantity','<input class="rk-input" data-untracked type="number" min="0" step="1" inputmode="numeric">')+
      R.section('Serialized units')+'<div data-serials></div>'+R.actions([{id:'count-scan',label:'Scan serial label',kind:'primary'}])+
      field('Unexpected serials physically found — one label per line','<textarea class="rk-input" data-extra maxlength="60000"></textarea>')+
      R.section('Named batches')+(c.batches.length?c.batches.map(function(batch){return field(batch.number+' · book '+batch.quantity+' · reserved '+batch.reserved,'<input class="rk-input" data-batch="'+batch.batch_id+'" type="number" min="0" step="1" inputmode="numeric" required>');}).join(''):R.note('info','No named batches on this shelf.'))+
      field('Count note — at least 10 characters','<textarea class="rk-input" data-note maxlength="1000"></textarea>')+
      R.actions([{id:'count-submit',label:'Submit observation for review',kind:'primary'},{id:'count-recount',label:'Refresh and recount',kind:'secondary'},{id:'count-back',label:'Count history',kind:'secondary'}]);
    body.querySelector('[data-untracked]').value=b.untracked;body.querySelector('[data-note]').value=b.note;
    function isBook(code){return c.serials.some(function(u){return u.code.toLowerCase()===code.toLowerCase();});}
    body.querySelector('[data-extra]').value=codes(b).filter(function(code){return !isBook(code);}).join('\n');
    body.querySelectorAll('[data-batch]').forEach(function(el){el.value=b.batches[el.dataset.batch] == null?'':b.batches[el.dataset.batch];});
    function draw(){body.querySelector('[data-serials]').innerHTML=c.serials.map(function(u){var found=codes(b).some(function(code){return code.toLowerCase()===u.code.toLowerCase();});return R.field(u.code,(found?'Scanned':'Not scanned')+' · '+u.status);}).join('')||R.note('info','No book serials. Scan any unexpectedly found unit.');
      body.querySelector('[data-serials]').innerHTML+=codes(b).map(function(code,i){return '<button class="rk-btn secondary" data-remove-serial="'+i+'">Remove scan '+mEsc(code)+'</button>';}).join('');body.querySelectorAll('[data-remove-serial]').forEach(function(btn){btn.onclick=async function(){b.codes.splice(Number(btn.dataset.removeSerial),1);await draftSave(s);draw();body.querySelector('[data-extra]').value=codes(b).filter(function(v){return !isBook(v);}).join('\n');};});
    }
    function collect(){b.untracked=body.querySelector('[data-untracked]').value;b.note=body.querySelector('[data-note]').value;body.querySelectorAll('[data-batch]').forEach(function(el){b.batches[el.dataset.batch]=el.value;});}
    body.querySelectorAll('[data-untracked],[data-note],[data-batch]').forEach(function(el){el.oninput=function(){collect();draftSave(s).catch(function(){});};});
    body.querySelector('[data-extra]').oninput=function(){var extra=this.value.split(/\r?\n/).map(function(v){return v.trim();}).filter(Boolean);b.codes=codes(b).filter(isBook).concat(extra.filter(function(code){return !isBook(code);}));draftSave(s).catch(function(){});};
    body.querySelector('#count-scan').onclick=function(){mScanner.open({title:'Scan exact serial label',continuous:true,onResult:async function(raw){
      if(!live(view,hash,s))return;
      var code=String(raw).trim();
      try{
        // Production QR stickers resolve to their canonical serial; plain unknown labels remain evidence.
        if(/^VDS:(UNIT|BATCH):/i.test(code)){
          var found=await API.get('/inventory/lookup?code='+encodeURIComponent(code));
          if(!found.unit)throw new Error('Scan an individual unit label, not a batch or item label.');
          var known=c.serials.find(function(u){return u.id===found.unit.id;});
          if(known)code=known.code;else{var record=await API.get('/production/record?unit='+found.unit.id);code=record.unit.identifier||'#'+found.unit.id;}
        }
        if(!live(view,hash,s))return;
        var book=c.serials.find(function(u){return u.code.toLowerCase()===code.toLowerCase();});if(book)code=book.code;
        if(codes(b).some(function(v){return v.toLowerCase()===code.toLowerCase();}))throw new Error('This serial was already counted.');
        b.codes=codes(b).concat([code]);await draftSave(s);if(!live(view,hash,s))return;draw();body.querySelector('[data-extra]').value=codes(b).filter(function(v){return !isBook(v);}).join('\n');mToast('Serial counted');
      }catch(e){mToast(e.message,'err');}
    }});};
    draw();
    body.querySelector('#count-back').onclick=function(){go();};
    body.querySelector('#count-recount').onclick=async function(){if(!confirm('Discard this draft observation and load a fresh snapshot?'))return;await mProductionDrafts.remove(s);go({item:c.item_id,location:c.location_id,mode:c.build_mode,task:b.task||'',source_kind:b.source_kind,source_id:b.source_id||''});};
    body.querySelector('#count-submit').onclick=async function(){var btn=this;try{collect();if(body.querySelector('[data-extra]').value.split(/\r?\n/).some(function(code){return isBook(code.trim());}))throw new Error('Use the serial scanner to count a book unit.');if(!integer(b.untracked))throw new Error('Enter a whole untracked quantity, including zero.');if(b.note.trim().length<10)throw new Error('Describe the observation in at least 10 characters.');var seen=new Set();codes(b).forEach(function(code){if(code.length>120)throw new Error('A serial label is too long.');if(seen.has(code.toLowerCase()))throw new Error('A serial was counted more than once.');seen.add(code.toLowerCase());});if(seen.size>500)throw new Error('At most 500 serials per observation.');
      var batches=c.batches.map(function(batch){var q=b.batches[batch.batch_id];if(!integer(q))throw new Error('Enter a whole count for every shown batch, including zero.');return {batch_id:batch.batch_id,quantity:Number(q)};});
      btn.disabled=true;await draftSave(s);await decision(view,s,base,{item_id:c.item_id,location_id:c.location_id,build_mode:c.build_mode,expected_quantity:c.book_quantity,expected_serial_ids:c.serials.map(function(u){return u.id;}),expected_batches:c.batches.map(function(v){return {batch_id:v.batch_id,quantity:v.quantity};}),counted_untracked:Number(b.untracked),counted_serial_codes:codes(b),counted_batches:batches,note:b.note.trim(),source_kind:b.source_kind,source_id:b.source_id,task_id:b.task},'Submit physical observation; no stock changed');
    }catch(e){mToast(e.message,'err');btn.disabled=false;}};
  }
  async function detail(view,id,s){
    var hash=location.hash,r=await API.get(base+'/'+id);if(!live(view,hash,s))return;var body=page(view,'Stock count #'+r.id),can=MApp.can('inventory.adjust');
    function unit(u){return R.field(u.code,u.status+' · location '+(u.location_id||'unknown'))+(MApp.canOpen('record')?'<button class="rk-btn secondary" data-record="'+u.id+'">Open exact unit record</button>':'');}
    body.innerHTML=R.field('Item',r.item_name)+R.field('Location',r.location_name)+R.field('Build state',r.build_mode)+R.field('Status',r.status)+R.field('Book / found / variance',r.book_quantity+' / '+r.counted_quantity+' / '+r.variance)+R.field('Counter','#'+r.counted_by)+R.field('Physically found untracked',String(r.counted_untracked))+R.field('Count note',r.note)+R.field('Reviewer note',r.review_note||'Awaiting independent review')+
      (r.source_kind!=='manual'?R.field('Linked issue',sourceLabel(r.source_kind)+' #'+r.source_id+' · '+r.source_status)+(r.source_closed_at?R.field('Source closure',r.source_closed_at+' · reviewer #'+r.source_closed_by)+R.field('Closure note',r.source_close_note):R.note('info','Reconciliation does not close the original issue. A supervisor must review and close it separately.')):'')+
      R.section('Counted serial labels')+((r.counted_serial_codes||[]).map(function(code){return R.field(code,'Physically observed');}).join('')||R.note('info','No serials counted'))+R.section('Counted batches')+((r.counted_batches||[]).map(function(batch){var book=(r.book_batches||[]).find(function(b){return b.batch_id===batch.batch_id;});return R.field('Batch #'+batch.batch_id,'Book '+(book?book.quantity:'unknown')+' · found '+batch.quantity);}).join('')||R.note('info','No batches counted'))+R.section('Missing book serials')+((r.missing_serials||[]).map(unit).join('')||R.note('info','None'))+R.section('Unexpected serials physically found')+((r.unexpected_serials||[]).map(function(u){return u.matches.length===1?unit(u.matches[0]):R.field(u.code,u.matches.length?'Ambiguous label — investigate':'Unknown label — investigate');}).join('')||R.note('info','None'))+
      R.note('warn','A count never creates, relocates or writes off a serial. A supervisor must resolve exact units through the existing unit workflow, then verify this count.')+
      '<div data-review></div><div data-source-close></div>'+R.actions([{id:'count-history',label:'Count history',kind:'secondary'}]);
    body.querySelectorAll('[data-record]').forEach(function(btn){btn.onclick=function(){MApp.go('record',{unit:btn.dataset.record});};});body.querySelector('#count-history').onclick=function(){go();};
    if(r.source_kind!=='manual'&&r.source_id&&!r.source_closed_at){
      var sourceBox=body.querySelector('[data-source-close]');
      var reconciled=r.status==='applied'&&r.current_quantity===r.counted_quantity&&!r.tracked_difference;
      if(can&&reconciled&&r.source_status==='open'){
        sourceBox.innerHTML=R.section('Close linked issue')+R.note('info','This closes only the linked '+(r.source_kind==='discrepancy'?'discrepancy':'direct-sale audit')+'. It does not move stock. Review the current evidence before confirming.')+
          field('Closure reviewer note — at least 10 characters','<textarea class="rk-input" data-close-note maxlength="1000"></textarea>')+R.actions([{id:'count-close-source',label:'Close linked issue',kind:'primary'}]);
        var input=sourceBox.querySelector('[data-close-note]');input.value=s.batch.closureCount===r.id?s.batch.closureNote||'':'';
        input.oninput=function(){s.batch.closureCount=r.id;s.batch.closureNote=input.value;draftSave(s).catch(function(){});};
        sourceBox.querySelector('#count-close-source').onclick=async function(){var btn=this;try{var note=input.value.trim();if(note.length<10)throw new Error('Explain the issue closure in at least 10 characters.');if(!confirm('Close '+sourceLabel(r.source_kind)+' #'+r.source_id+' using reconciled count #'+r.id+'? No stock will move.'))return;btn.disabled=true;await draftSave(s);await decision(view,s,base+'/'+r.id+'/close-source',{note:note},'Close linked issue from count #'+r.id,r.id);}catch(e){mToast(e.message,'err');btn.disabled=false;}};
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
        var rows=await API.get(r.source_kind==='discrepancy'?'/inventory/discrepancies?status=all':'/inventory/direct-sale-audit?status=all');if(!live(view,hash,s))return;
        var source=rows.find(function(row){return r.source_kind==='discrepancy'?row.id===r.source_id:row.order_id===r.source_id&&row.item_id===r.item_id;});
        if(!source){evidence.innerHTML=R.note('warn','Current source evidence is unavailable in this queue. Ask a supervisor to review the original record.');return;}
        evidence.innerHTML=R.section('Current linked evidence')+(r.source_kind==='discrepancy'?R.field('Original issue',source.reason)+R.field('Current status',source.status)+R.field('Current shelf quantity',String(source.location_quantity_now))+R.field('Resolution note',source.resolution_note||'Open review'):R.field('Sale order',source.order_number)+R.field('Current status',source.status)+R.field('Shipped / ledger removed / possible excess',source.shipped_quantity+' / '+source.removed_quantity+' / '+source.possible_extra_quantity)+R.field('Ledger evidence',r.source_evidence_hash===source.evidence_hash?'Matches the counted evidence':'Changed — start a fresh linked count')+(source.movements||[]).map(function(m){return R.field(m.reason,m.change+' · '+m.location_name+' · '+m.created_at);}).join(''));
      }catch(e){mToast(e.message,'err');btn.disabled=false;}};
      if(r.source_status==='changed'||r.status==='rejected'||r.status==='applied'&&(r.current_quantity!==r.counted_quantity||r.tracked_difference)){
        var fresh=document.createElement('button');fresh.className='rk-btn secondary';fresh.id='count-fresh-linked';fresh.textContent='Start fresh linked count';body.appendChild(fresh);fresh.onclick=async function(){try{
          if(s.batch.context){if(!confirm('Discard the existing draft before starting a fresh linked count?'))return;await mProductionDrafts.remove(s);}
          go({item:r.item_id,location:r.location_id,mode:r.build_mode,source_kind:r.source_kind,source_id:r.source_id});
        }catch(e){mToast(e.message,'err');}};
      }
    }
    if(can&&['submitted','approved'].includes(r.status)){
      var actions=r.status==='submitted'?(Number(r.counted_by)!==Number(MApp.getMe().id)?['approve','reject']:['reject']):['apply','verify'];
      var box=body.querySelector('[data-review]');box.innerHTML=R.section('Supervisor decision')+(r.status==='approved'?R.note('info','Apply uses the saved approval note. Enter a new note for verification.'):'' )+field('Review / verification note — at least 10 characters','<textarea class="rk-input" data-review-note maxlength="1000"></textarea>')+R.actions(actions.map(function(a){return {id:'count-'+a,label:({approve:'Approve observation',reject:'Reject observation',apply:'Apply guarded stock correction',verify:'Verify separately corrected stock'})[a],kind:'secondary'};}));
      actions.forEach(function(a){box.querySelector('#count-'+a).onclick=async function(){var btn=this;try{var n=box.querySelector('[data-review-note]').value.trim();if(a!=='apply'&&n.length<10)throw new Error('Record a reviewer note of at least 10 characters.');if(!confirm('Confirm '+a+' for count #'+id+'?'))return;btn.disabled=true;await decision(view,s,base+'/'+id+'/'+a,a==='apply'?{}:{note:n},a+' count #'+id,id);}catch(e){mToast(e.message,'err');btn.disabled=false;}};});
    }
  }
  async function list(view,s){
    var hash=location.hash,rows=await API.get(base+'?status=all');if(!live(view,hash,s))return;var body=page(view,'Physical stock counts');
    body.innerHTML=R.actions([{id:'count-planned',label:'My planned checks',kind:'secondary'},{id:'count-new',label:s.batch.context?'Resume draft count':'New physical count',kind:'primary'}])+R.note('info','Count observations await independent review. Submission or approval does not mean stock was corrected.')+rows.map(function(r){return R.jobCard({id:r.id,number:'Count #'+r.id,name:r.item_name,pill:{text:r.status},meta:r.location_name+' · '+r.build_mode+' · found '+r.counted_quantity+(r.source_kind!=='manual'?' · '+sourceLabel(r.source_kind)+' #'+r.source_id+' '+r.source_status:'')});}).join('');
    body.querySelectorAll('[data-id]').forEach(function(el){el.onclick=function(){go({id:el.dataset.id});};});body.querySelector('#count-new').onclick=function(){go({step:'new'});};body.querySelector('#count-planned').onclick=function(){MApp.go('stock-count-tasks');};
  }
  async function choose(view,s){
    if(s.batch.context)return form(view,{},s);var hash=location.hash;await mLocations.load();if(!live(view,hash,s))return;
    var body=page(view,'Choose stock position');body.innerHTML='<div data-item></div><div data-location></div>'+field('Build state','<select class="rk-input" data-mode><option value="assembled">Fully built</option><option value="semi_built">Semi-built</option></select>')+R.actions([{id:'count-start',label:'Load fresh count snapshot',kind:'primary'}]);
    var item=null,picker=mItemPicker({onPick:function(it){item=it;}}),loc=mLocations.select({label:'Exact shelf location'});body.querySelector('[data-item]').appendChild(picker.el);body.querySelector('[data-location]').appendChild(loc.el);
    body.querySelector('#count-start').onclick=function(){if(!item||!loc.value()){mToast('Choose an item and exact location.','err');return;}go({item:item.id,location:loc.value(),mode:body.querySelector('[data-mode]').value});};
  }
  MApp.route('stock-counts',async function(view,p){p=p||{};var hash=location.hash;try{var s=await mWorkflow.draft('stock-counts');if(!live(view,hash,s))return;if(s.operation.state!=='draft'){mWorkflow.paint(view,s);return;}if(p.task){var tasks=await API.get(base+'/tasks?status=open&mine=1');if(!live(view,hash,s))return;var task=tasks.find(function(t){return t.id===Number(p.task);});if(!task)throw new Error('This check is closed or assigned to another employee. Refresh My planned checks.');if(['submitted','approved'].includes(task.latest_count_status)){go({id:task.latest_count_id});return;}if(s.batch.context&&s.batch.task!==task.id){if(!confirm('Discard the existing count draft and start this assigned check?')){go({step:'new'});return;}await mProductionDrafts.remove(s);s=await mWorkflow.draft('stock-counts');}s.batch.assignment={note:task.note,due_date:task.due_date};p={task:task.id,item:task.item_id,location:task.location_id,mode:task.build_mode,source_kind:'manual'};}if(p.id)await detail(view,Number(p.id),s);else if(p.item&&p.location)await form(view,p,s);else if(p.step==='new')await choose(view,s);else await list(view,s);}catch(e){if(hash===location.hash){view.innerHTML='';view.appendChild(R.error(e,function(){MApp.render();}));}}});
})();
