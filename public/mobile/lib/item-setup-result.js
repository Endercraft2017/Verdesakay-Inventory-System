/* Item receipts retain the exact saved payload/key through failures and reloads. */
(function(){
  window.mItemSetupResult=function(view,s){
    var U=mItemSetup,a=s.operation,d=a.itemSetup.item,create=a.itemSetup.kind==='create',root=U.page(view,create?'Item created':'QR code'),scope=mReadScope.create(root),busy=false,polling=false,pollTimer=null,first=true;
    function current(){return scope.current()&&mWorkflow.owns(s);}
    function final(){return a.state==='confirmed'&&!a.local;}
    function permitted(){return create?U.canCreate()&&(!a.payload.quantity||MApp.can('inventory.adjust')):U.canEditQR();}
    function bind(action,fn){var b=root.querySelector('[data-setup-action="'+action+'"]');if(b)b.onclick=fn;}
    function feedback(error){if(current())root.querySelector('[data-feedback]').textContent=error.message||error;}
    async function restart(clear){if(busy||!current())return;busy=true;try{
      if(clear)await mProductionDrafts.remove(s);else{s.operation={kind:'workflow',route:a.route,state:'draft'};await mWorkflow.save(s);}
      if(current()){if(clear&&!create)U.navigate('assign-qr',{});else MApp.render();}
    }catch(error){feedback(error);}finally{busy=false;}}
    function paint(){if(!current())return;
      var done=final(),refused=a.state==='rejected',conflict=a.state==='conflict',title=done?create?'Item saved':'Barcode saved':a.local?'Saved on this site PC':refused?'Save refused':conflict?'Needs reconciliation':'Save not confirmed';
      var message=done?create?(d.quantity?d.quantity+' '+(d.unit||'pcs')+' recorded as initial stock at this location.':'Starts with zero stock. No stock was added.'):'The label identifies this item. It does not record a stock movement.':a.local?'Final authority confirmation is pending. Keep the original receipt until this site command is confirmed.':refused?'The server refused this save. Your original details are kept for correction.':conflict?'Review the original saved result with an authorized colleague. Do not create a replacement.':'The request may already have been saved. Check the original request before creating another item or barcode.';
      var label='';if(!create&&done&&U.canQR()){var qr=qrcode(0,'M');qr.addData(a.result.barcode);qr.make();label='<section class="setup-card setup-qr">'+U.identity(d)+'<img class="setup-qr-image" alt="QR label for '+mEsc(d.name)+'" src="'+qr.createDataURL(7,28)+'"><p class="setup-code" data-code tabindex="-1">'+mEsc(a.result.barcode)+'</p><p class="setup-muted">Generated barcode · Ready to screenshot or print</p></section>';}
      root.innerHTML=(label||'<section class="setup-card"><span class="setup-check" aria-hidden="true">'+(done?'✓':'…')+'</span><h2 tabindex="-1">'+mEsc(title)+'</h2><div class="setup-result-identity">'+(create?U.summary(d):U.identity(d))+'</div></section>')+U.notice(message,!done)+(a.error?'<p class="setup-error" role="alert">'+mEsc(a.error)+'</p>':'')+'<div data-qr></div><div class="setup-actions">'+
        (!a.local&&['new','unknown','sending'].includes(a.state)?U.button('retry','Check original request'):'')+
        (a.local?U.button('check','Check confirmation',true):'')+
        (create&&done&&U.canQR()?U.button('qr',d.sku?'Show item QR':U.canEditQR()?'Set up item QR':'Choose item QR'):'')+
        (create&&done?'<div class="setup-secondary-row">'+(U.canCreate()?U.button('another','Add another',true):'')+(MApp.can('inventory.view')&&MApp.canOpen('item')?U.button('item','View item',true):'')+'</div>':'')+
        (!create&&done&&U.canQR()?U.button('done','Done')+'<div class="setup-secondary-row">'+U.button('copy','Copy code',true)+U.button('another','Add to another',true)+'</div>':'')+
        (refused&&permitted()?U.button('edit','Review original details',true):'')+(done&&(create&&(U.canCreate()||MApp.can('inventory.view')&&MApp.canOpen('item'))||!create&&U.canQR())?'':U.button('done','Back to Work',true))+'</div><div class="setup-error" data-feedback role="status"></div>';
      var retry=root.querySelector('[data-setup-action="retry"]');if(retry){retry.disabled=!permitted();retry.onclick=async function(){if(busy||!current()||!permitted())return;busy=true;retry.disabled=true;retry.textContent='Checking original…';try{await MApp.refreshAccess?.({required:true});if(!current()||!permitted())return;await mWorkflow.send(s);}catch(error){feedback(error);}finally{busy=false;if(current())paint();}};}
      bind('qr',function(){if(current()&&U.canQR())U.navigate('assign-qr',{id:a.result.id});});bind('item',function(){if(current()&&MApp.can('inventory.view'))MApp.go('item',{id:a.result.id});});bind('another',function(){if(current()&&(create?U.canCreate():U.canQR()))restart(true);});bind('edit',function(){if(current()&&permitted())restart(false);});bind('done',async function(){if(!current()||busy)return;if(!create&&final()){busy=true;try{await mProductionDrafts.remove(s);if(current())MApp.go('home');}catch(error){feedback(error);}finally{busy=false;}}else MApp.go('work');});bind('check',check);
      bind('copy',async function(){try{if(!navigator.clipboard?.writeText)throw new Error();await navigator.clipboard.writeText(a.result.barcode);feedback('Code copied.');}catch(error){if(current()){feedback('Copy is unavailable here. Select and copy the code above.');var range=document.createRange();range.selectNodeContents(root.querySelector('[data-code]'));var selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);}}});
      if(first){first=false;window.scrollTo(0,0);root.querySelector('h2,[data-code]')?.focus({preventScroll:true});}
    }
    async function check(){if(!current()||polling||!a.local)return;if(pollTimer!=null)scope.cancelTimer(pollTimer);pollTimer=null;polling=true;var button=root.querySelector('[data-setup-action="check"]');if(button)button.disabled=true;try{
      var result=await scope.run(function(opts){return API.get('/sync/command/'+encodeURIComponent(a.local),opts);});if(!current())return;if(!result||typeof result.state!=='string')throw new Error('The confirmation could not be read. Try checking again.');
      if(result.state==='confirmed'){a.local=null;if(U.validResult(a,a.result)){a.state='confirmed';a.error=null;}else{a.state='unknown';a.error='The original response was incomplete. Check the original saved request.';}await mWorkflow.save(s);if(current())paint();}
      else if(['failed','rejected','conflict'].includes(result.state)){a.local=null;a.state='conflict';a.error=result.error||'The original site command needs reconciliation.';await mWorkflow.save(s);if(current())paint();}
      else feedback('The original site command is still awaiting confirmation.');
    }catch(error){if(current()&&!error.cancelled)feedback(error);}finally{polling=false;if(current()){root.querySelector('[data-setup-action="check"]')?.removeAttribute('disabled');if(a.local)pollTimer=scope.later(check,10000);}}}
    if(a.state==='confirmed'&&!U.validResult(a,a.result)){a.state='unknown';a.error='The original response was incomplete. Check the original saved request.';mWorkflow.save(s).catch(feedback);}
    paint();if(a.local)check();
  };
})();
