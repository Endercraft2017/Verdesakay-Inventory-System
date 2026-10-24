/* Explicit label selection; existing codes are read-only and generated codes use
   a narrow write so concurrent item attributes are never replaced. */
MApp.route('assign-qr',function(view,params){
  var U=mItemSetup,root=U.page(view,'Add QR'),picker,scope=mReadScope.create(root,function(){picker?.release();}),s,item,pendingCode,loading=false,busy=false;
  function current(){return scope.current()&&(!s||mWorkflow.owns(s));}
  async function read(id){var result=await scope.run(function(opts){return API.get('/inventory/'+Number(id),opts);});if(!U.validItem(result,id))throw new Error('The current item could not be read. Retry loading it.');return result;}
  function chosen(){var existing=U.code(item),panel=root.querySelector('[data-selected]');panel.innerHTML='<h3 tabindex="-1">Selected item</h3><section class="setup-card">'+U.identity(item)+'<dl class="setup-summary"><div><dt>Code source</dt><dd>'+mEsc(existing?existing.source:'New barcode')+'</dd></div><div><dt>Stock change</dt><dd>None</dd></div></dl></section>'+U.notice(existing?'Uses the existing code. Showing a QR does not change the item.':U.canEditQR()?'Save a generated barcode to this item, then show its QR. Stock stays unchanged.':'This item has no code. An authorized editor must save its barcode before a QR can be shown.',!existing&&!U.canEditQR())+
      (existing||U.canEditQR()?U.button('show',existing?'Show QR':'Save barcode & show QR'):'')+U.button('change','Choose another item',true);
    root.querySelector('[data-setup-action="show"]')?.addEventListener('click',show);root.querySelector('[data-setup-action="change"]').onclick=choose;panel.querySelector('h3').focus({preventScroll:true});
  }
  async function select(picked){if(loading||busy||!current())return;loading=true;var feedback=root.querySelector('[data-feedback]');try{
    item=await read(picked.id);if(!current())return;pendingCode=null;chosen();
  }catch(error){if(current()&&!error.cancelled){if(!feedback){feedback=mEl('<div data-feedback></div>');root.appendChild(feedback);}U.failure(feedback,error,function(){select(picked);});}}finally{loading=false;}}
  function choose(){if(!current())return;picker?.release();item=null;pendingCode=null;MApp.setTitle('Add QR');root.innerHTML='<h2>Choose an item</h2><p class="setup-muted">Find the exact item before showing or saving its label.</p><div data-picker></div><div data-selected class="setup-selected"></div><div data-feedback role="status"></div>';
    picker=mItemPicker({label:'Item name or SKU',onPick:select});root.querySelector('[data-picker]').appendChild(picker.el);
  }
  async function show(){if(busy||!current())return;if(!U.canQR()){root.querySelector('[data-feedback]').textContent='Your access changed. Refresh before opening this label.';return;}busy=true;root.querySelectorAll('button,input,select').forEach(function(b){b.disabled=true;});
    try{var fresh=await read(item.id);if(!current())return;item=fresh;var existing=U.code(item);if(existing){preview(existing);return;}if(!U.canEditQR()){chosen();return;}
      pendingCode=pendingCode||'VDS-'+item.id+'-'+crypto.randomUUID();s.batch.item=item;
      await mWorkflow.start(s,{path:'/inventory/'+item.id+'/barcode',method:'put',payload:{barcode:pendingCode},title:'Save item barcode',itemSetup:{kind:'barcode',item:{id:item.id,name:item.name,sku:item.sku,unit:item.unit}}});if(current())mWorkflow.paint(view,s);
    }catch(error){if(current()){if(s.operation.state!=='draft')mWorkflow.paint(view,s);else{chosen();U.failure(root.querySelector('[data-feedback]'),error,show);}}}finally{busy=false;if(current())root.querySelectorAll('button,input,select').forEach(function(b){b.disabled=false;});}
  }
  function preview(code){if(!current())return;MApp.setTitle('QR code');var qr=qrcode(0,'M');qr.addData(code.value);qr.make();root.innerHTML='<section class="setup-card setup-qr">'+U.identity(item)+'<img class="setup-qr-image" alt="QR label for '+mEsc(item.name)+'" src="'+qr.createDataURL(7,28)+'"><p class="setup-code" data-code>'+mEsc(code.value)+'</p><p class="setup-muted">'+mEsc(code.source)+' · Ready to screenshot or print</p></section>'+U.notice('The label identifies this item. It does not record a stock movement.')+'<div class="setup-actions">'+U.button('done','Done')+'<div class="setup-secondary-row">'+U.button('copy','Copy code',true)+U.button('another','Add to another',true)+'</div></div><div data-feedback role="status"></div>';
    root.querySelector('[data-setup-action="done"]').onclick=function(){MApp.go('home');};root.querySelector('[data-setup-action="another"]').onclick=choose;root.querySelector('[data-setup-action="copy"]').onclick=async function(){var feedback=root.querySelector('[data-feedback]');try{if(!navigator.clipboard?.writeText)throw new Error();await navigator.clipboard.writeText(code.value);if(current())feedback.textContent='Code copied.';}catch(e){if(current()){feedback.textContent='Copy is unavailable here. Select and copy the code above.';var range=document.createRange();range.selectNodeContents(root.querySelector('[data-code]'));var selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);}}};
  }
  async function init(){root.innerHTML='<p class="setup-muted" role="status">Loading label setup…</p>';try{
    s=await scope.run(function(){return mWorkflow.draft('assign-qr');});if(!current())return;if(s.operation.state!=='draft'){mWorkflow.paint(view,s);return;}
    if(!U.canQR()){root.innerHTML=U.notice('QR labels are not available with your current access.',true);return;}
    var picked=params?.id?{id:params.id}:s.batch.item;choose();if(picked)await select(picked);
  }catch(error){if(current()&&!error.cancelled)U.failure(root,error,init);}}
  init();
});
