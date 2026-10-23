/* Shared case UI, used from Customers and the customer-work queue. */
const CustomerCases = (() => {
  const esc = UI.esc;
  const localTime = value => value ? new Date(value).toLocaleString() : '—';
  const localInput = value => {
    if (!value) return '';
    const d = new Date(value);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0,16);
  };
  function rows(cases) {
    return cases.length ? `<table><thead><tr><th>Case / customer</th><th>Status / owner</th><th>Next action / due</th><th></th></tr></thead>
      <tbody>${cases.map(c => `<tr>
        <td><strong>#${c.id} ${esc(c.kind)} · ${esc(c.summary)}</strong><div>${esc(c.customer_name || '')}</div></td>
        <td>${esc(c.status)}<div>${esc(c.owner_name || '')}${c.owner_inactive ? ' (inactive — reassign)' : ''}</div></td>
        <td>${esc(c.next_action || '—')}<div${c.due_at && new Date(c.due_at) < new Date() ? ' class="danger"' : ''}>${esc(localTime(c.due_at))}</div></td>
        <td><button class="btn secondary small" data-case="${c.id}">Open case</button></td>
      </tr>`).join('')}</tbody></table>` : '<p class="muted">No cases in this view.</p>';
  }
  function bind(root, changed) {
    root.querySelectorAll('[data-case]').forEach(b => b.onclick = () => open(Number(b.dataset.case), changed).catch(e => UI.toast(e.message,'error')));
  }
  async function open(id, changed) {
    const c = await API.get('/customer-cases/' + id);
    return editor(c.customer_id, c.kind, c, changed);
  }
  async function editor(customerId, kind, c, changed) {
    const [customer, owners] = await Promise.all([API.get('/customers/' + customerId), API.get('/customer-cases/owners')]);
    const me = App.getMe();
    const writable = App.hasPermission('cases.edit') && (!c || c.owner_id === me.id || App.hasPermission('cases.assign'));
    const requestKey = UI.operationKey();
    const v = (k, fallback = '') => c && c[k] != null ? c[k] : fallback;
    // A current owner may hand over their own case; supervisors can assign any case.
    if(c && !owners.some(u=>u.id===c.owner_id)) owners.push({id:c.owner_id,full_name:(c.owner_name || 'Previous owner')+' (inactive or no case access)'});
    const ownerOptions = owners.filter(u => c || App.hasPermission('cases.assign') || u.id===me.id).map(u => `<option value="${u.id}" ${u.id === v('owner_id',me.id) ? 'selected' : ''}>${esc(u.full_name)}</option>`).join('');
    const saleOptions = (customer.orders || []).map(o => `<option value="${o.id}" ${o.id === v('sale_order_id') ? 'selected' : ''}>${esc(o.number)} · ${esc(o.status)}</option>`);
    if (c && c.sale_order_id && !(customer.orders || []).some(o => o.id === c.sale_order_id)) saleOptions.push(`<option value="${c.sale_order_id}" selected>Linked sale #${c.sale_order_id}</option>`);
    UI.modal({
      title: `${c ? 'Case #' + c.id : 'New ' + kind} · ${customer.name}`, size:'xl',
      cancelText:'Close', confirmText:writable ? 'Save case' : null,
      bodyHTML:`<p class="muted">Messenger stays outside the app. Save a short summary and the next action here. Times use your browser’s time zone.</p>
        <fieldset ${writable ? '' : 'disabled'} style="border:0;padding:0">
        <label>Summary *</label><textarea data-c="summary">${esc(v('summary'))}</textarea>
        <div class="field-row"><div><label>Status</label><select data-c="status">${['open','in_progress','waiting','resolved','cancelled'].map(s => `<option ${s === v('status','open') ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
        <div><label>Owner *</label><select data-c="owner_id">${ownerOptions}</select></div></div>
        <label>Next action (required while open)</label><input data-c="next_action" value="${esc(v('next_action'))}" />
        <label>Due time (required while open)</label><input type="datetime-local" data-c="due_at" value="${localInput(v('due_at'))}" />
        <label>Related sale</label><select ${c && c.kind==='inquiry' && c.sale_order_id ? 'disabled' : ''} data-c="sale_order_id"><option value="">No related sale</option>${saleOptions.join('')}</select>
        <label>Find a sale by order number</label><div class="field-row"><input data-sale-query placeholder="SO-00001" /><button type="button" class="btn secondary" data-sale-find>Find sale</button></div><p data-sale-results aria-live="polite"></p>
        <label>Resolution / cancellation reason</label><textarea data-c="resolution">${esc(v('resolution'))}</textarea>
        <label>Interaction or handover note</label><textarea data-c="note" placeholder="What happened in Messenger, and what the next CSR needs to know"></textarea>
        </fieldset>
        ${c && c.sale_order_id ? '<button class="btn secondary" data-open-sale>Open linked sale</button>' : ''}
        ${c && c.kind === 'inquiry' && !c.sale_order_id && writable && App.hasPermission('orders.create') && !['resolved','cancelled'].includes(c.status) ? '<button class="btn secondary" data-create-sale>Create sale from inquiry</button>' : ''}
        ${c ? '<h4>Case history</h4><div data-events></div><button class="btn secondary small" data-more-events>More history</button><h4>Supporting images</h4><div data-files></div>' + (writable ? '<label>Add screenshot or receipt image (up to 8 MB)<input type="file" data-case-file accept="image/jpeg,image/png,image/gif,image/webp" /></label><p data-file-error role="alert"></p>' : '') : '<p>Save the case before attaching supporting images or creating a sale.</p>'}`,
      onConfirm: async (ov, showErr) => {
        const g = k => ov.querySelector(`[data-c="${k}"]`).value;
        const due = g('due_at');
        const body = {summary:g('summary').trim(),status:g('status'),owner_id:Number(g('owner_id')),next_action:g('next_action').trim() || null,
          due_at:due ? new Date(due).toISOString() : null,sale_order_id:Number(g('sale_order_id')) || null,resolution:g('resolution').trim() || null,note:g('note').trim()};
        try {
          if (c) await API.put('/customer-cases/' + c.id,{...body,version:c.version});
          else await API.post('/customer-cases',{...body,customer_id:customerId,kind,request_key:requestKey});
        } catch(e) { showErr(e.message); return false; }
        UI.toast('Case saved'); if (changed) await changed();
      },
      onOpen: ov => {
        ov.querySelector('[data-sale-find]').onclick=async()=>{
          const query=ov.querySelector('[data-sale-query]').value.trim();
          try {
            const sales=await API.get(`/customers/${customerId}/sales?q=${encodeURIComponent(query)}`);
            const select=ov.querySelector('[data-c="sale_order_id"]');
            sales.forEach(o=>{if(!Array.from(select.options).some(x=>x.value===String(o.id)))select.add(new Option(o.number+' · '+o.status,o.id));});
            ov.querySelector('[data-sale-results]').textContent=sales.length ? `${sales.length} matching sale(s) available in Related sale.` : 'No matching sales for this customer.';
          }catch(e){ov.querySelector('[data-sale-results]').textContent=e.message;}
        };
        const create = ov.querySelector('[data-create-sale]');
        if (create) create.onclick = () => {
          document.querySelectorAll('.modal-overlay').forEach(m=>m.remove()); App.navigate('orders',{type:'sale',customer_id:customerId,case_id:c.id,case_version:c.version});
        };
        const linked = ov.querySelector('[data-open-sale]');
        if (linked) linked.onclick = () => { document.querySelectorAll('.modal-overlay').forEach(m=>m.remove()); App.navigate('orders',{type:'sale',id:c.sale_order_id}); };
        if (!c) return;
        let eventOffset=0;
        const more=ov.querySelector('[data-more-events]');
        const loadEvents = async () => {
          const events=await API.get(`/customer-cases/${c.id}/events?offset=${eventOffset}`);
          ov.querySelector('[data-events]').insertAdjacentHTML('beforeend',events.slice(0,50).map(e => {
            const s=JSON.parse(e.snapshot);
            return `<div class="panel" style="padding:8px;margin:6px 0"><strong>${esc(e.event_type)}</strong> · ${esc(e.actor_name)} · ${esc(localTime(e.created_at))}
              <div style="white-space:pre-wrap">${esc(e.note || '')}</div><div class="muted">${esc(s.summary)} · ${esc(s.status)} · owner #${s.owner_id} · ${esc(s.next_action || s.resolution || '')} · ${esc(localTime(s.due_at))}</div></div>`;
          }).join(''));
          eventOffset+=50; more.hidden=events.length<=50;
        };
        more.onclick=()=>loadEvents().catch(e=>UI.toast(e.message,'error'));
        loadEvents().catch(e=>{ ov.querySelector('[data-events]').textContent=e.message; });
        const loadFiles=async()=>{
          const files=await API.get(`/attachments?kind=customer_case&ref_id=${c.id}`);
          ov.querySelector('[data-files]').innerHTML=files.map(f=>`<button class="btn secondary small" data-image="${f.id}">${esc(f.caption || 'Image #' + f.id)}</button>`).join('') || '<p class="muted">No supporting images.</p>';
          ov.querySelectorAll('[data-image]').forEach(b=>b.onclick=async()=>{
            try {
              const url=await API.blobUrl('/attachments/'+b.dataset.image+'/image');
              const preview=UI.modal({title:'Supporting image',bodyHTML:`<img src="${url}" alt="Case attachment" style="max-width:100%" />`,cancelText:'Close'});
              // Blob is no longer needed once the image has loaded.
              preview.overlay.querySelector('img').onload=()=>URL.revokeObjectURL(url);
            } catch(e) { UI.toast(e.message,'error'); }
          });
        };
        loadFiles().catch(e=>{ ov.querySelector('[data-files]').textContent=e.message; });
        const upload=ov.querySelector('[data-case-file]');
        if(upload) upload.onchange=async()=>{
          if(!upload.files[0]) return;
          const fd=new FormData();fd.append('kind','customer_case');fd.append('ref_id',c.id);fd.append('image',upload.files[0]);
          upload.disabled=true;
          try {await API.upload('/attachments',fd);await loadFiles();ov.querySelector('[data-file-error]').textContent='';}
          catch(e){ov.querySelector('[data-file-error]').textContent=e.message;}
          finally {upload.disabled=false;upload.value='';}
        };
      },
    });
  }
  return {rows,bind,open,create:(customerId,kind,changed)=>editor(customerId,kind,null,changed)};
})();

App.register('customer-work', async view => {
  let offset=0;
  view.innerHTML=`<div class="topbar"><h2>Customer work</h2></div><p>Open inquiries and complaints. Dates use your browser’s time zone.</p>
    <div class="field-row"><select id="case-scope"><option value="mine">My cases</option>${App.hasPermission('cases.assign')?'<option value="team">Team cases</option>':''}</select>
    <select id="case-due"><option value="all">All open work</option><option value="today">Due through today</option><option value="overdue">Overdue</option></select><button class="btn secondary" id="case-refresh">Refresh</button></div>
    <div id="case-queue"></div><button class="btn secondary" id="case-prev">Previous</button> <button class="btn secondary" id="case-next">Next</button>`;
  async function load(){
    const scope=view.querySelector('#case-scope').value, due=view.querySelector('#case-due').value;
    const q=new URLSearchParams({scope,offset:String(offset)});
    if(due!=='all') {const d=new Date();if(due==='today')d.setHours(23,59,59,999);q.set('before',d.toISOString());}
    const rows=await API.get('/customer-cases?'+q);
    view.querySelector('#case-queue').innerHTML=CustomerCases.rows(rows.slice(0,50));CustomerCases.bind(view,load);
    view.querySelector('#case-prev').disabled=offset===0;view.querySelector('#case-next').disabled=rows.length<=50;
  }
  const reload=()=>load().catch(e=>UI.toast(e.message,'error'));
  view.querySelector('#case-scope').onchange=view.querySelector('#case-due').onchange=()=>{offset=0;reload();};
  view.querySelector('#case-refresh').onclick=reload;
  view.querySelector('#case-prev').onclick=()=>{offset=Math.max(0,offset-50);reload();};
  view.querySelector('#case-next').onclick=()=>{offset+=50;reload();};
  await load();
});
