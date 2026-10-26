/* Proposal-only action review, using the existing presentation and label verifier. */
(function(){
  if(!__SCRATCH_CONFIG__.integrationReview)return;
  var fixture=__preparationFixture,config=__SCRATCH_CONFIG__,scenario=fixture.scenario;
  function dialog(html){var el=mEl('<dialog class="m-profile-dialog" aria-labelledby="prep-dialog-title">'+html+'</dialog>');document.body.appendChild(el);el.showModal();return el;}
  // Replace camera acquisition only; the native verification matching/gate is unchanged.
  mScanner.open=function(options){var codes=(window.__preparationExpected||[]),reader=dialog('<h2 id="prep-dialog-title">Preview label reader</h2><p class="m-hint">Fictional scanner input. No physical camera or sticker is tested.</p><div data-labels></div><p role="status" data-reader-status></p><button class="m-btn m-btn-secondary" data-wrong>Present wrong label</button><button class="m-btn m-btn-secondary" data-close>Cancel</button>');
    var handle={close:function(){reader.close();reader.remove();}};
    codes.forEach(function(code){var b=mEl('<button type="button" class="m-btn m-btn-secondary"></button>');b.textContent='Present '+code;b.onclick=function(){options.onResult(code);};reader.querySelector('[data-labels]').appendChild(b);});
    reader.querySelector('[data-wrong]').onclick=function(){options.onResult('WRONG-FIXTURE-LABEL');reader.querySelector('[data-reader-status]').textContent='Wrong label. Scan the selected stock label.';};reader.querySelector('[data-close]').onclick=handle.close;return handle;
  };
  async function review(groups){var changed=groups.flatMap(function(g){return g.lines.filter(function(l){return l.prepared!==l.saved;}).map(function(l){return Object.assign({},l,{record_id:g.id,kind:g.kind,title:g.title});});});if(!changed.length)return false;
    var previous=document.activeElement;
    return new Promise(function(resolve){
      var jo=config.request==='jo',codes=Array.from(new Set(changed.map(function(l){return l.sku;}))),payloads=jo?[{path:'/job-orders/prepare',body:{job_orders:groups.map(function(g){return{id:g.id,lines:g.lines.map(function(l){return{component_item_id:l.component_item_id,qty_picked:l.prepared};})};})}}]:[{path:'/orders/'+groups[0].id+'/release',body:{bulk:changed.map(function(l){return{item_id:l.component_item_id,order_item_id:l.line_id,quantity:l.prepared-l.saved};})}}];
      var el=dialog('<h2 id="prep-dialog-title">'+(jo?'Review picked totals':'Review allocations')+'</h2><p class="m-hint">Isolated preview · saved in memory only. On-hand stock will stay unchanged.</p>'+changed.map(function(l){return'<div class="rk-card rk-field"><b>'+mEsc(l.name)+'</b><p class="m-hint">'+mEsc(l.title)+' · '+(jo?'Component #'+l.component_item_id:'Sale line #'+l.line_id)+'</p><p>Saved '+l.saved+' → '+l.prepared+' / '+l.need+(jo?' total picked':' · allocate '+(l.prepared-l.saved)+' more')+'</p></div>';}).join('')+(jo?'<p>Partial picks may be saved. Final release remains a separate, complete-kit confirmation.</p>':'<div data-label-verification></div><p>Warehouse-out still requires its existing authority, load, package, proof and recipient checks.</p>')+'<p role="status" data-review-status></p><div class="m-actions"><button type="button" class="rk-btn primary m-ux-action" data-save>'+(jo?'Save picked totals':'Save allocations')+'</button><button type="button" class="m-btn m-btn-secondary" data-cancel>Back to counts</button></div>');
      var save=el.querySelector('[data-save]'),gate,busy=false;
      if(!jo){window.__preparationExpected=codes;gate=mScanner.verification(el.querySelector('[data-label-verification]'),codes,function(ok){save.disabled=!ok;});}
      function finish(value){el.close();el.remove();if(previous?.isConnected)previous.focus();resolve(value);}
      el.querySelector('[data-cancel]').onclick=function(){if(!busy)finish(false);};el.oncancel=function(e){e.preventDefault();if(!busy)finish(false);};
      save.onclick=async function(){if(busy||gate&&!gate.complete())return;busy=true;save.disabled=true;el.querySelector('[data-cancel]').disabled=true;el.querySelector('[data-review-status]').textContent='Saving preview counts…';try{await fixture.save({groups:groups,requests:payloads});finish(true);}catch(error){busy=false;el.querySelector('[data-review-status]').textContent=error.message;save.disabled=false;el.querySelector('[data-cancel]').disabled=false;}};
      el.querySelector('[data-cancel]').focus();
    });
  }
  var route=config.request==='jo'?'kit-release':'so',ids=config.request==='jo'?scenario.jobs.map(function(j){return j.job.id;}):[scenario.contexts[0].order.id];
  if(config.variant==='after')MApp.route(route,function(view){mPreparationReview.open(view,{kind:config.request==='jo'?'jo':'so',ids:ids,integration:true,onCommit:review});});
})();
