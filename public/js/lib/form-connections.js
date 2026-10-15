/* Shared connected-field controls. Selected values remain record snapshots until changed. */
window.FormConnections = (() => {
  const names={product:'Product',customer:'Customer',employee:'Employee',sales_order:'Sales order',supplier:'Supplier',location:'Location',account:'Accounting account',tax_code:'Tax code',company:'Company',user:'Signed-in user'};
  function key(){return globalThis.crypto.randomUUID?.()||[...globalThis.crypto.getRandomValues(new Uint8Array(16))].map(byte=>byte.toString(16).padStart(2,'0')).join('');}
  function label(row){const name=row.name||row.number||String(row.id),detail=row.sku||row.employee_no||row.code||row.contact_person;return name+(detail?' · '+detail:row.id&&!row.number?' · #'+row.id:'');}
  function render(field,value) {
    const id='fr-field-'+field.key;
    if(field.type==='system')return `<div data-validation-field><label for="${id}">${UI.esc(field.label)}</label><input id="${id}" data-field="${UI.esc(field.key)}" readonly value="${UI.esc(String(value??''))}"><small class="muted">From ${names[field.source]||'system'} · ${UI.esc(field.property||'')}</small><span data-system-status="${field.key}" role="status"></span><button type="button" class="btn secondary small" data-system-retry="${field.key}" hidden>Retry loading</button></div>`;
    const selected=value&&typeof value==='object'?value:null;
    return `<div data-validation-field class="fc-lookup" data-lookup="${field.key}"><label for="${id}">${UI.esc(field.label)}${field.required?' *':''}</label><input type="search" data-lookup-search="${field.key}" aria-label="Search ${UI.esc(field.label)}" placeholder="Search ${UI.esc(names[field.source]||'records')}…" autocomplete="off"><select id="${id}" data-field="${field.key}" ${field.required?'aria-required="true"':''}><option value="">Choose ${UI.esc(names[field.source]||'record')}</option>${selected?`<option value="${selected.id}" selected>${UI.esc(label(selected))} (saved)</option>`:''}</select><span data-lookup-status role="status"></span><button type="button" class="btn secondary small" data-lookup-retry hidden>Retry loading</button></div>`;
  }
  function mount(overlay,fields,data) {
    const jobs=[];
    const bound=(key,row)=>fields.filter(field=>field.binding?.field===key).forEach(field=>{
      const input=overlay.querySelector(`[data-field="${field.key}"]`);if(!input)return;
      input.value=row?.[field.binding.property]??'';input.dispatchEvent(new Event('input',{bubbles:true}));
    });
    for(const field of fields) {
      const input=overlay.querySelector(`[data-field="${field.key}"]`);if(!input)continue;
      if(field.binding&&!field.binding.editable){input.readOnly=true;input.setAttribute('aria-description','Filled from the connected record');}
      if(field.type==='system' && data[field.key]===undefined) {
        const status=overlay.querySelector(`[data-system-status="${field.key}"]`);
        const retry=overlay.querySelector(`[data-system-retry="${field.key}"]`),index=jobs.length;jobs.push(null);
        const load=()=>{status.textContent='Loading…';retry.hidden=true;jobs[index]=API.get('/data-forms/sources/'+field.source).then(rows=>{if(overlay.isConnected){input.value=rows[0]?.[field.property]??'';status.textContent='';}}).catch(error=>{if(overlay.isConnected){status.textContent='Could not load: '+error.message;retry.hidden=false;}throw error;});Promise.allSettled([jobs[index]]);};retry.onclick=load;load();
      }
      if(field.type!=='reference')continue;
      const root=input.closest('[data-lookup]'),search=root.querySelector('[data-lookup-search]'),status=root.querySelector('[data-lookup-status]'),retry=root.querySelector('[data-lookup-retry]');
      const saved=data[field.key];input.__referenceValue=saved;let rows=saved&&typeof saved==='object'?[saved]:[],sequence=0,timer;
      async function load(){const request=++sequence;status.textContent='Loading…';retry.hidden=true;
        try{
          const found=await API.get('/data-forms/sources/'+field.source+'?q='+encodeURIComponent(search.value));
          if(!overlay.isConnected||request!==sequence)return;
          const selected=rows.find(row=>String(row.id)===input.value),value=input.value;
          rows=found;if(selected)rows=[selected,...rows.filter(row=>row.id!==selected.id)];
          input.innerHTML='<option value="">Choose '+UI.esc(names[field.source]||'record')+'</option>'+rows.map(row=>`<option value="${row.id}">${UI.esc(label(row))}</option>`).join('');input.value=value;
          status.textContent=found.length?`${found.length} results${found.length===50?' — search to narrow the list':''}`:'No matching records';
        }catch(error){if(overlay.isConnected&&request===sequence){status.textContent='Could not load: '+error.message;retry.hidden=false;}}
      }
      search.oninput=()=>{clearTimeout(timer);timer=setTimeout(load,200);};retry.onclick=load;
      input.onchange=()=>{input.__referenceValue=rows.find(row=>String(row.id)===input.value)||null;bound(field.key,input.__referenceValue);};if(saved?.id)status.textContent='Saved selection — search to choose another record';else load();
    }
    // Observe rejection immediately; retrying Save retries failed system fetches through reopening.
    overlay.__connectionJobs=jobs;
  }
  async function ready(overlay) {
    const results=await Promise.allSettled(overlay.__connectionJobs||[]);
    if(results?.some(result=>result.status==='rejected'))throw new Error('Some system values could not load. Use Retry loading beside the field; your draft is still here.');
  }
  function fieldPath(field){return ['company','global','record','number','today','user','order','fields'].includes(field.key)?'fields.'+field.key:field.key;}
  function variables(form,catalog=[]) {
    return (form.fields||[]).flatMap(field=>{
      const category='Form: '+form.name,path=fieldPath(field);
      if(field.type==='reference')return (catalog.find(source=>source.key===field.source)?.fields||['id',field.source==='sales_order'?'number':'name']).map(property=>({category,label:field.label+' → '+property,token:'{{'+path+'.'+property+'}}'}));
      if(field.type==='line_items')return [{category,label:field.label+' → Repeating table',token:'{{'+path+'}}',snippet:printField(field)},...['name','sku','quantity','unit','unit_price','discount_percent','discount_amount','line_total'].map(property=>({category:'Product rows: '+field.label,label:property.replace(/_/g,' '),token:'{{'+property+'}}'}))];
      return [{category,label:field.label,token:'{{'+path+'}}'}];
    });
  }
  function printField(field){const path=fieldPath(field);return field.type==='line_items'?`<h3>${UI.esc(field.label)}</h3><table><thead><tr><th>Product</th><th>Quantity</th><th>Unit</th><th>Unit price</th><th>Discount %</th><th>Line total</th></tr></thead><tbody>{{#${path}}}<tr><td>{{name}}</td><td>{{quantity}}</td><td>{{unit}}</td><td>{{unit_price}}</td><td>{{discount_percent}}</td><td>{{line_total}}</td></tr>{{/${path}}}</tbody></table>`:`<div class="ff-row"><span class="ff-label">${UI.esc(field.label)}</span><span class="ff-value">{{${path}${field.type==='reference'?(field.source==='sales_order'?'.number':'.name'):''}}}</span></div>`;}
  return {render,mount,ready,names,variables,printField,key};
})();
