/* Existing item creation and label views: shared markup and response contracts. */
(function(){
  var serial=0;
  function page(view,title){var root=mEl('<section class="m-item-setup"></section>');view.replaceChildren(root);MApp.setTitle(title);return root;}
  function button(action,label,secondary){return '<button type="button" class="m-btn'+(secondary?' m-btn-secondary':'')+'" data-setup-action="'+action+'">'+mEsc(label)+'</button>';}
  function notice(text,warn){return '<div class="setup-notice'+(warn?' warn':'')+'">'+mEsc(text)+'</div>';}
  function field(key,label,value,attrs){var id='item-setup-'+(++serial);return '<label class="m-field"><span class="m-label">'+mEsc(label)+'</span><input id="'+id+'" class="m-input" data-k="'+key+'" value="'+mEsc(value??'')+'" '+(attrs||'type="text"')+'><span class="setup-error" data-error-for="'+key+'" id="'+id+'-error" hidden></span></label>';}
  function identity(d){return '<div class="setup-item"><strong>'+mEsc(d.name)+'</strong><small>'+mEsc(d.sku||'No SKU')+' · '+mEsc(d.unit||'pcs')+'</small></div>';}
  function summary(d){return identity(d)+'<dl class="setup-summary"><div><dt>Starting stock</dt><dd>'+mEsc(d.quantity+' '+(d.unit||'pcs'))+'</dd></div><div><dt>Location</dt><dd>'+mEsc(d.locationName||'Default location')+'</dd></div></dl>';}
  function code(item){var barcode=item.attributes?.barcode;return typeof barcode==='string'&&barcode.trim()?{value:barcode,source:'Existing barcode'}:typeof item.sku==='string'&&item.sku.trim()?{value:item.sku,source:'Existing SKU'}:null;}
  function validItem(item,id){return item&&Number.isSafeInteger(item.id)&&item.id>0&&(!id||Number(id)===item.id)&&typeof item.name==='string'&&item.name.trim()&&(!item.attributes||typeof item.attributes==='object'&&!Array.isArray(item.attributes));}
  function validResult(a,r){if(!r||!Number.isSafeInteger(r.id)||r.id<=0)return false;return a.itemSetup.kind==='create'?Number.isSafeInteger(r.preferred_location_id)&&r.preferred_location_id>0:r.id===a.itemSetup.item.id&&r.barcode===a.payload.barcode;}
  function canCreate(){return MApp.can('inventory.create')&&MApp.canOpen('new-item');}
  function canQR(){return MApp.can('inventory.view')&&MApp.canOpen('assign-qr');}
  function canEditQR(){return canQR()&&MApp.can('inventory.edit');}
  function failure(root,error,retry){root.replaceChildren(mEl(notice(error.message||'The check could not be completed.',true)));root.setAttribute('role','alert');if(retry){var b=mEl(button('retry','Retry',true));root.appendChild(b);b.onclick=retry;}}
  function navigate(route,params){if(MApp.nav(route,params)===location.hash)MApp.render();else MApp.go(route,params);}
  window.mItemSetup={page:page,button:button,notice:notice,field:field,identity:identity,summary:summary,code:code,validItem:validItem,validResult:validResult,canCreate:canCreate,canQR:canQR,canEditQR:canEditQR,failure:failure,navigate:navigate};
})();
