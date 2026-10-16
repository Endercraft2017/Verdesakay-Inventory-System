/* Inventory → Physical Counts. A count is evidence; approval and correction are separate. */
App.register('stock-counts', async (view, filter = {}) => {
  const canReview = App.hasPermission('inventory.adjust');
  const canCount = App.hasPermission('inventory.view');
  let status = 'open';
  let rows = [];
  view.innerHTML = `<div class="topbar"><h2>Physical Counts</h2><div class="grow"></div>
    <div class="subnav-inline"><button class="tab active" data-status="open">Open</button>
    <button class="tab" data-status="all">All</button></div>
    ${canCount ? `<button class="btn" id="pc-new">${UI.icon('plus')} New count</button>` : ''}</div>
    <p class="muted small">Count one item, exact location and build state at a time. A second person reviews the result.
    Untracked and exact-batch differences can be applied after approval. Serialized differences need their unit workflow.</p>
    <div class="panel" style="overflow-x:auto"><div id="pc-list"></div></div>`;
  const list = view.querySelector('#pc-list');
  view.querySelectorAll('[data-status]').forEach(b => b.onclick = () => {
    status = b.dataset.status;
    view.querySelectorAll('[data-status]').forEach(x => x.classList.toggle('active', x === b));
    load();
  });
  if (canCount) view.querySelector('#pc-new').onclick = () => newCount(filter || {});

  async function load() {
    list.innerHTML = '<div class="empty">Loading…</div>';
    try { rows = await API.get('/inventory/stock-counts?status=' + status); }
    catch (e) { list.innerHTML = `<div class="empty">${UI.esc(e.message)}</div>`; return; }
    if (!rows.length) {
      list.innerHTML = UI.emptyState({icon:'check',title: status === 'open' ? 'No open counts' : 'No counts yet',
        hint:'Start a count for one item at a specific shelf or warehouse location.'});
      return;
    }
    list.innerHTML = `<table><thead><tr><th>Count</th><th>Item / location</th><th>Build</th><th class="right">Book</th>
      <th class="right">Counted</th><th class="right">Variance</th><th>Status</th><th></th></tr></thead><tbody>
      ${rows.map(c => `<tr><td>#${c.id}<div class="muted small">${UI.fmtDate(c.counted_at)}</div></td>
        <td><strong>${UI.esc(c.item_name)}</strong><div class="muted small">${UI.esc(c.location_name)}</div></td>
        <td>${c.build_mode === 'semi_built' ? 'Semi-built' : 'Fully built / standard'}</td>
        <td class="right">${c.book_quantity}</td><td class="right">${c.counted_quantity}</td>
        <td class="right">${c.variance > 0 ? '+' : ''}${c.variance}</td>
        <td><span class="badge-pill ${c.status === 'applied' ? 'ok' : c.status === 'rejected' ? 'low' : ''}">${UI.esc(c.status)}</span></td>
        <td><button class="btn secondary small" data-open="${c.id}">Review</button></td></tr>`).join('')}</tbody></table>`;
    list.querySelectorAll('[data-open]').forEach(b => b.onclick = () => openCount(Number(b.dataset.open)));
  }

  async function newCount(seed) {
    const locations = await API.get('/locations');
    const preset = seed.item_id ? await API.get('/inventory/' + seed.item_id) : null;
    const {overlay:modal} = UI.modal({title:'New physical count',size:'lg',confirmText:'Close',
      bodyHTML:`<p class="muted small">Choose the item and the exact shelf/location. Load the live stock before recording what you physically found.</p>
        <div class="form-grid"><div class="form-field span2"><label for="pc-search">Find item by name or SKU</label>
          <input id="pc-search" value="${UI.esc(preset?.name || '')}" placeholder="Type at least 2 characters"></div>
        <div class="form-field span2"><label for="pc-item">Item</label><select id="pc-item">
          ${preset ? `<option value="${preset.id}">${UI.esc(preset.name)}${preset.sku ? ' · '+UI.esc(preset.sku) : ''}</option>` : '<option value="">Search for an item</option>'}</select></div>
        <div class="form-field"><label for="pc-location">Exact location</label><select id="pc-location">
          <option value="">Choose a location</option>${locations.map(l => `<option value="${l.id}" ${Number(seed.location_id) === l.id ? 'selected' : ''}>${UI.esc(l.path || l.name)}</option>`).join('')}</select></div>
        <div class="form-field"><label for="pc-mode">Build state</label><select id="pc-mode">
          <option value="assembled">Fully built / standard</option><option value="semi_built">Semi-built</option></select></div></div>
        <button type="button" class="btn secondary" id="pc-load">Load stock to count</button>
        <div id="pc-capture"></div>`,
      onConfirm:()=>true});
    if(seed.build_mode) modal.querySelector('#pc-mode').value=seed.build_mode;
    const search=modal.querySelector('#pc-search'), picker=modal.querySelector('#pc-item');
    let searchVersion=0;
    search.oninput=async () => {
      const v=++searchVersion, q=search.value.trim();
      if(q.length<2){picker.innerHTML='<option value="">Type at least 2 characters</option>';return;}
      try{
        const items=await API.get('/inventory?q='+encodeURIComponent(q));
        if(v!==searchVersion || !modal.isConnected)return;
        picker.innerHTML='<option value="">Choose an item</option>'+items.slice(0,60).map(i =>
          `<option value="${i.id}">${UI.esc(i.name)}${i.sku ? ' · '+UI.esc(i.sku) : ''}</option>`).join('');
      }catch(e){if(v===searchVersion) picker.innerHTML=`<option value="">${UI.esc(e.message)}</option>`;}
    };
    modal.querySelector('#pc-load').onclick=async () => {
      const item_id=Number(picker.value), location_id=Number(modal.querySelector('#pc-location').value);
      const build_mode=modal.querySelector('#pc-mode').value, capture=modal.querySelector('#pc-capture');
      if(!item_id||!location_id){capture.innerHTML='<p class="danger">Choose an item and exact location first.</p>';return;}
      capture.innerHTML='<p class="muted">Loading live stock…</p>';
      try{
        const context=await API.get(`/inventory/stock-counts/context?item_id=${item_id}&location_id=${location_id}&build_mode=${build_mode}`);
        if(!modal.isConnected)return;
        capture.innerHTML=`<hr><h4>${UI.esc(context.item_name)} · ${UI.esc(context.location_name)}</h4>
          <p>Book total: <strong>${context.book_quantity}</strong> · untracked: ${context.untracked_quantity} ·
          serials: ${context.serials.length} · batches: ${context.batches.length}</p>
          <div class="form-field"><label for="pc-untracked">Physically counted untracked quantity</label>
            <input id="pc-untracked" type="number" min="0" step="1" placeholder="Enter count"></div>
          ${context.serials.length ? `<p><strong>Scan/check each serial physically present</strong>. Leave a missing unit unchecked.</p>
            <div style="max-height:220px;overflow:auto">${context.serials.map(s =>
              `<label class="check-opt" style="display:block"><input type="checkbox" data-pc-serial="${UI.esc(s.code)}"> ${UI.esc(s.code)} <span class="muted small">${UI.esc(s.status)}</span></label>`).join('')}</div>
            <p class="muted small">For an unexpected serial absent from this list, record its code in the note; do not count it as untracked stock.</p>` : ''}
          ${context.batches.length ? `<p><strong>Count each exact production batch</strong></p>
            <div style="overflow-x:auto"><table><thead><tr><th>Batch</th><th class="right">Book</th><th class="right">Reserved</th><th>Counted</th></tr></thead><tbody>
            ${context.batches.map(b => `<tr><td>${UI.esc(b.number)}</td><td class="right">${b.quantity}</td><td class="right">${b.reserved}</td>
              <td><input type="number" min="0" step="1" data-pc-batch="${b.batch_id}" placeholder="Count"></td></tr>`).join('')}</tbody></table></div>` : ''}
          <div class="form-field"><label for="pc-note">Count notes and exceptions</label>
            <textarea id="pc-note" rows="3" maxlength="1000" placeholder="Who counted, where, and any missing or unexpected labels"></textarea></div>
          <button class="btn" id="pc-submit">Submit for independent review</button><div id="pc-error" role="alert"></div>`;
        let attempt=null;
        capture.querySelector('#pc-submit').onclick=async () => {
          const error=capture.querySelector('#pc-error'); error.textContent='';
          const untracked=capture.querySelector('#pc-untracked').value;
          const batchInputs=[...capture.querySelectorAll('[data-pc-batch]')];
          if(!/^(0|[1-9]\d*)$/.test(untracked)||batchInputs.some(e=>!/^(0|[1-9]\d*)$/.test(e.value))){
            error.textContent='Enter a whole physical count for untracked stock and every batch.';return;}
          const note=capture.querySelector('#pc-note').value.trim();
          if(note.length<10){error.textContent='Describe the count and any exceptions (at least 10 characters).';return;}
          const payload={item_id,location_id,build_mode,expected_quantity:context.book_quantity,
            expected_serial_ids:context.serials.map(s=>s.id),
            expected_batches:context.batches.map(b=>({batch_id:b.batch_id,quantity:b.quantity})),
            counted_untracked:Number(untracked),
            counted_serial_codes:[...capture.querySelectorAll('[data-pc-serial]:checked')].map(e=>e.dataset.pcSerial),
            counted_batches:batchInputs.map(e=>({batch_id:Number(e.dataset.pcBatch),quantity:Number(e.value)})),
            note,source_kind:seed.source_kind||'manual',source_id:seed.source_id||null};
          if(!attempt) attempt={payload,key:'stock-count-'+(window.crypto?.randomUUID?.()||Date.now()+'-'+Math.random())};
          const button=capture.querySelector('#pc-submit');button.disabled=true;
          const controls=[...capture.querySelectorAll('input,textarea,select')];controls.forEach(control=>control.disabled=true);
          try{const saved=await API.post('/inventory/stock-counts',attempt.payload,{idempotencyKey:attempt.key});
            modal.__close();UI.toast('Count #'+saved.id+' submitted for review');load();}
          catch(e){
            error.textContent=e.offline?'Confirmation unknown. Retry the exact saved count; do not start a second count.':e.message;
            if(e.offline) button.textContent='Retry same count';
            else {attempt=null;controls.forEach(control=>control.disabled=false);}
            button.disabled=false;
          }
        };
      }catch(e){capture.innerHTML=`<p class="danger">${UI.esc(e.message)}</p>`;}
    };
  }

  async function openCount(id) {
    const c=await API.get('/inventory/stock-counts/'+id);
    const serials=c.counted_serial_codes.length ? c.counted_serial_codes.map(UI.esc).join(', ') : 'None';
    const batches=c.counted_batches.length ? c.counted_batches.map(b=>{
      const current=c.current_batches.find(x=>x.batch_id===b.batch_id);
      return `${UI.esc(current?.number || '#'+b.batch_id)}: ${b.quantity}`;
    }).join(', ') : 'None';
    const {overlay:modal}=UI.modal({title:`Physical count #${c.id}`,size:'lg',confirmText:'Close',bodyHTML:
      `<p><strong>${UI.esc(c.item_name)}</strong> · ${UI.esc(c.location_name)} · ${c.build_mode === 'semi_built' ? 'Semi-built' : 'Fully built / standard'}</p>
       <p>Book ${c.book_quantity} → counted <strong>${c.counted_quantity}</strong> · variance <strong>${c.variance>0?'+':''}${c.variance}</strong> · now ${c.current_quantity}</p>
       <p><strong>Untracked:</strong> ${c.counted_untracked}<br><strong>Serials found:</strong> ${serials}<br><strong>Batches:</strong> ${batches}</p>
       <p><strong>Counter note:</strong> ${UI.esc(c.note)}</p>
       ${c.source_kind !== 'manual' ? `<p class="muted small">Linked ${UI.esc(c.source_kind.replace('_',' '))} #${c.source_id}</p>` : ''}
       ${c.review_note ? `<p><strong>Review:</strong> ${UI.esc(c.review_note)}</p>` : ''}
       ${c.status === 'approved' && c.current_serials.map(s=>s.code).sort().join('|') !== c.counted_serial_codes.slice().sort().join('|') ? '<p class="danger">Serialized units differ. Resolve exact unit records first; this screen will not make a generic quantity adjustment.</p>' : ''}
       <div class="form-field"><label for="pc-action-note">Reviewer findings / correction reference</label>
         <textarea id="pc-action-note" rows="2" maxlength="1000" placeholder="What was checked or which movement corrected it"></textarea></div>
       <div style="display:flex;flex-wrap:wrap;gap:8px">
         ${c.status==='submitted'&&canReview ? '<button class="btn" data-pc-action="approve">Approve</button><button class="btn secondary" data-pc-action="reject">Reject</button>' : ''}
         ${c.status==='approved'&&canReview ? '<button class="btn" data-pc-action="apply">Apply safe correction</button><button class="btn secondary" data-pc-action="verify">Verify separately corrected</button>' : ''}
       </div><div id="pc-action-error" role="alert"></div>`});
    modal.querySelectorAll('[data-pc-action]').forEach(b=>b.onclick=async()=>{
      const action=b.dataset.pcAction, note=modal.querySelector('#pc-action-note').value.trim();
      const error=modal.querySelector('#pc-action-error');error.textContent='';
      if(action!=='apply'&&note.length<10){error.textContent='Enter findings or a correction reference (at least 10 characters).';return;}
      b.disabled=true;
      try{
        await API.post(`/inventory/stock-counts/${c.id}/${action}`,action==='apply'?{}:{note});
        modal.__close();UI.toast(action==='approve'?'Count approved':action==='reject'?'Count rejected':'Count reconciled');load();
      }catch(e){error.textContent=e.message;b.disabled=false;}
    });
  }

  await load();
  if(filter?.item_id && canCount) newCount(filter);
});
