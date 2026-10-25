/* Counts record observations; exact serials and batches remain separate evidence. */
(function(){
  var U=mCountUI,R=RoleUI;
  window.mCountForm=async function(view,p,s,scope){
    if(!MApp.can('inventory.count'))throw new Error('Recording requires inventory.count permission.');
    var b=s.batch,scanner=null,scanBusy=false,locked=false,writeChain=Promise.resolve();
    function save(){var job=writeChain.then(function(){return mWorkflow.save(s);});writeChain=job.catch(function(){});return job;}
    if(!b.context){
      if(!p.task&&(!p.source_kind||p.source_kind==='manual')){
        var tasks=await U.get(scope,U.base+'/tasks?status=open',Array.isArray);
        var assigned=tasks.find(function(t){return t.item_id===Number(p.item)&&t.location_id===Number(p.location)&&t.build_mode===(p.mode||'assembled');});
        if(assigned){MApp.go('stock-count-tasks',{id:assigned.id});return;}
      }
      var fresh=await U.get(scope,U.base+'/context?item_id='+encodeURIComponent(p.item)+'&location_id='+encodeURIComponent(p.location)+'&build_mode='+encodeURIComponent(p.mode||'assembled'),U.validContext);
      b.context=fresh;b.codes=[];b.batches={};b.untracked='';b.note='';b.extra='';b.task=p.task?Number(p.task):null;b.source_kind=p.source_kind||'manual';b.source_id=p.source_id?Number(p.source_id):null;await save();
    }
    var c=b.context;if(!U.validContext(c))throw new Error('The saved snapshot could not be read. Review the saved draft before counting again.');
    if(!U.knownType(c.is_finished_product)){
      var item=await U.get(scope,'/inventory/'+c.item_id,function(i){return i&&U.knownType(i.is_finished_product);});
      c.is_finished_product=item.is_finished_product;c.unit=item.unit;c.sku=c.sku||item.sku;await save();
    }
    if(!scope.current())return;
    var body=U.page(view,'Record physical count'),unit=c.unit||'pcs';
    function current(){return scope.current()&&body.isConnected&&mWorkflow.owns(s);}
    function isBook(code){return c.serials.some(function(u){return u.code.toLowerCase()===String(code).toLowerCase();});}
    if(b.extra==null)b.extra=(b.codes||[]).filter(function(code){return !isBook(code);}).join('\n');
    var tracked=c.serials.length||c.batches.length||U.finished(c);
    body.innerHTML=U.identity(c)+R.note('info','Record what is physically here. Submission sends an observation for independent review; it does not change stock.')+
      U.totals(c.book_quantity,U.formState(b).found,unit)+(b.task?R.note('info','Assignment #'+mEsc(b.task)+(b.assignment?' · due '+mEsc(b.assignment.due_date)+' (UTC)<br><span>'+mEsc(b.assignment.note||'No extra instructions')+'</span>':'')):'')+
      '<form novalidate>'+U.field('Untracked quantity ('+unit+') physically found','<input data-untracked type="number" min="0" max="1000000" step="1" inputmode="numeric" aria-describedby="count-qty-help count-qty-error">')+
      '<p class="footnote" id="count-qty-help">Untracked stock only. Enter zero if none; keep serials and batches in their own sections.</p><p class="error" id="count-qty-error" aria-live="polite"></p>'+
      (tracked?'<section class="card serial-card"><div class="cardhead"><h2>Serialized units</h2><span class="pill" data-progress></span></div><div data-serials></div><button type="button" id="count-scan">Scan serial label</button></section><details><summary>Unexpected serial labels</summary><div>'+U.field('Physically found unexpected labels · one per line','<textarea data-extra maxlength="60000" aria-describedby="count-extra-error"></textarea>')+'<p class="footnote">Labels remain evidence. Counting does not create or relocate a unit.</p><p id="count-extra-error" class="error" aria-live="polite"></p></div></details>':'')+
      (c.batches.length?'<section class="card"><h2>Named batches</h2>'+c.batches.map(function(batch){return U.field(batch.number+' · book '+batch.quantity+' · reserved '+batch.reserved,'<input data-batch="'+batch.batch_id+'" type="number" min="0" max="1000000" step="1" inputmode="numeric">');}).join('')+'<p class="error" data-batch-error aria-live="polite"></p></section>':'')+
      U.field('Count note · at least 10 characters','<textarea data-note maxlength="1000" aria-describedby="count-note-error"></textarea>')+'<p id="count-note-error" class="error" aria-live="polite"></p><p data-form-error class="error" role="status"></p>'+
      '<button type="submit" class="primary" id="count-submit">Submit observation for review</button><div class="actions"><button type="button" id="count-recount">Start a new count</button><button type="button" id="count-back">Count history</button></div><div data-refresh-confirm></div></form>';
    body.querySelector('[data-untracked]').value=b.untracked;body.querySelector('[data-note]').value=b.note;
    if(tracked)body.querySelector('[data-extra]').value=b.extra;
    body.querySelectorAll('[data-batch]').forEach(function(el){el.value=b.batches[el.dataset.batch]??'';});
    function report(error){if(current()&&!error.cancelled)body.querySelector('[data-form-error]').textContent=error.message;}
    function update(){
      var state=U.formState(b),badQty=b.untracked!==''&&!U.integer(b.untracked);
      body.querySelector('[data-found]').textContent=state.found==null?'—':state.found;body.querySelector('[data-variance]').textContent=state.found==null?'—':U.signed(state.found-c.book_quantity);
      body.querySelector('#count-qty-error').textContent=badQty?'Enter a whole quantity from 0 to 1,000,000.':'';body.querySelector('[data-untracked]').setAttribute('aria-invalid',String(badQty));
      if(tracked){body.querySelector('#count-extra-error').textContent=state.error;body.querySelector('[data-extra]').setAttribute('aria-invalid',String(!!state.error));}
      if(c.batches.length)body.querySelector('[data-batch-error]').textContent=c.batches.some(function(batch){var v=b.batches[batch.batch_id];return v!==''&&v!=null&&!U.integer(v);})?'Enter whole batch quantities from 0 to 1,000,000.':'';
      body.querySelector('#count-note-error').textContent=b.note&&b.note.trim().length<10?'Describe the observation in at least 10 characters.':'';
      body.querySelector('#count-submit').disabled=locked||!state.valid||(!U.finished(c)&&c.build_mode!=='assembled');
      body.querySelector('[data-form-error]').textContent=!U.finished(c)&&c.build_mode!=='assembled'?'This older draft uses a nonstandard build state for a part. Return to stock position and start a standard count.':state.valid?'':!U.integer(b.untracked)?'Enter the untracked quantity, including zero.':c.batches.some(function(batch){return !U.integer(b.batches[batch.batch_id]);})?'Enter a count for every named batch, including zero.':state.error||'A count note of at least 10 characters is required.';
    }
    function draw(){if(!tracked)return;var codes=b.codes||[],rows=c.serials.map(function(u){return {code:u.code,label:u.status,found:codes.some(function(code){return code.toLowerCase()===u.code.toLowerCase();})};});
      codes.filter(function(code){return !isBook(code);}).forEach(function(code){rows.push({code:code,label:'Unexpected label',found:true});});
      body.querySelector('[data-serials]').innerHTML=rows.map(function(u){return '<div class="line"><div><b>'+mEsc(u.code)+'</b><small>'+(u.found?'Counted':'Not scanned')+' · '+mEsc(u.label)+'</small></div>'+(u.found?'<button type="button" data-remove-serial="'+mEsc(u.code)+'" aria-label="Remove scan '+mEsc(u.code)+'">Remove</button>':'')+'</div>';}).join('')||'<p class="footnote">No book serials. Scan any unexpectedly found unit.</p>';
      body.querySelector('[data-progress]').textContent=c.serials.filter(function(u){return codes.some(function(code){return code.toLowerCase()===u.code.toLowerCase();});}).length+' / '+c.serials.length+' scanned';
      body.querySelectorAll('[data-remove-serial]').forEach(function(btn){btn.onclick=function(){if(locked)return;b.codes=b.codes.filter(function(code){return code!==btn.dataset.removeSerial;});b.extra=b.codes.filter(function(code){return !isBook(code);}).join('\n');body.querySelector('[data-extra]').value=b.extra;save().catch(report);draw();update();body.querySelector('#count-scan').focus();};});
    }
    function collect(){b.untracked=body.querySelector('[data-untracked]').value;b.note=body.querySelector('[data-note]').value;body.querySelectorAll('[data-batch]').forEach(function(el){b.batches[el.dataset.batch]=el.value;});}
    body.querySelectorAll('[data-untracked],[data-note],[data-batch]').forEach(function(el){el.oninput=function(){if(locked)return;collect();update();save().catch(report);};});
    if(tracked){body.querySelector('[data-extra]').oninput=function(){if(locked)return;b.extra=this.value;var extra=this.value.split(/\r?\n/).map(function(code){return code.trim();}).filter(Boolean);b.codes=(b.codes||[]).filter(isBook).concat(extra.filter(function(code){return !isBook(code);}));save().catch(report);draw();update();};
      body.querySelector('#count-scan').onclick=function(){if(scanner||locked)return;scanner=mScanner.open({title:'Scan exact serial label',continuous:true,onClose:function(){scanner=null;},onResult:async function(raw){
        if(!current()||scanBusy||locked)return;scanBusy=true;var code=String(raw).trim();
        try{if(/^VDS:(UNIT|BATCH):/i.test(code)){var found=await U.get(scope,'/inventory/lookup?code='+encodeURIComponent(code));if(!found?.unit)throw new Error('Scan an individual unit label, not a batch or item label.');var known=c.serials.find(function(u){return u.id===found.unit.id;});if(known)code=known.code;else{var record=await U.get(scope,'/production/record?unit='+found.unit.id);if(!record?.unit)throw new Error('The exact unit record could not be read.');code=record.unit.identifier||'#'+found.unit.id;}}
          if(!current())return;if(!code||code.length>120)throw new Error('Use a serial label of 1–120 characters.');if((b.codes||[]).length>=500)throw new Error('At most 500 serials per observation.');var book=c.serials.find(function(u){return u.code.toLowerCase()===code.toLowerCase();});if(book)code=book.code;
          if((b.codes||[]).some(function(v){return v.toLowerCase()===code.toLowerCase();}))throw new Error('This serial was already counted.');b.codes=(b.codes||[]).concat([code]);b.extra=b.codes.filter(function(v){return !isBook(v);}).join('\n');await save();if(current()){body.querySelector('[data-extra]').value=b.extra;draw();update();mToast('Serial counted');}
        }catch(e){report(e);}finally{scanBusy=false;}
      }});};}
    view._countCleanup=function(){scanner?.close();scanner=null;};
    body.querySelector('#count-back').onclick=function(){MApp.go('stock-counts');};
    body.querySelector('#count-recount').onclick=function(){if(locked)return;var box=body.querySelector('[data-refresh-confirm]');box.innerHTML='<div class="card inline-confirm warn"><p>Discard this draft observation and load a fresh snapshot?</p><div class="actions"><button type="button" data-confirm-refresh>Discard and reload</button><button type="button" data-cancel-refresh>Keep draft</button></div></div>';box.querySelector('[data-cancel-refresh]').onclick=function(){box.innerHTML='';body.querySelector('#count-recount').focus();};box.querySelector('[data-confirm-refresh]').onclick=async function(){if(locked)return;locked=true;this.disabled=true;try{await writeChain;await mProductionDrafts.remove(s);if(current())U.navigate({item:c.item_id,location:c.location_id,mode:U.finished(c)?c.build_mode:'assembled',task:b.task||'',source_kind:b.source_kind,source_id:b.source_id||''});}catch(e){locked=false;report(e);update();}};};
    body.querySelector('form').onsubmit=async function(event){event.preventDefault();if(locked||!current()||!MApp.can('inventory.count'))return;collect();if(!U.formState(b).valid||(!U.finished(c)&&c.build_mode!=='assembled')){update();return;}locked=true;body.querySelectorAll('input,textarea,button').forEach(function(el){el.disabled=true;});scanner?.close();
      var payload={item_id:c.item_id,location_id:c.location_id,build_mode:c.build_mode,expected_quantity:c.book_quantity,expected_serial_ids:c.serials.map(function(u){return u.id;}),expected_batches:c.batches.map(function(v){return {batch_id:v.batch_id,quantity:v.quantity};}),counted_untracked:Number(b.untracked),counted_serial_codes:(b.codes||[]).slice(),counted_batches:c.batches.map(function(v){return {batch_id:v.batch_id,quantity:Number(b.batches[v.batch_id])};}),note:b.note.trim(),source_kind:b.source_kind,source_id:b.source_id,task_id:b.task};
      try{await save();await U.decision(view,s,scope,U.base,payload,'Submit physical observation; no stock changed',c);}catch(e){if(current()){if(s.operation.state!=='draft')mCountResult(view,s);else{locked=false;body.querySelectorAll('input,textarea,button').forEach(function(el){el.disabled=false;});report(e);update();}}}
    };
    draw();update();
  };
})();
