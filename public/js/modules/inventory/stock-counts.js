/* Inventory → Physical Counts. A count is evidence; approval and correction are separate. */
App.register('stock-counts', async (view, filter = {}) => {
  const canReview = App.hasPermission('inventory.adjust');
  const canCount = App.hasPermission('inventory.view');
  let status = 'open';
  let taskStatus = 'open';
  let taskMine = false;
  let section = 'counts';
  let loadVersion = 0;
  let rows = [];
  view.innerHTML = `<div class="topbar"><h2>Physical Counts</h2><div class="grow"></div>
    <div class="subnav-inline"><button class="tab active" data-section="counts">Counts</button>
    <button class="tab" data-section="tasks">Planned checks</button><button class="tab" data-section="coverage">Coverage</button></div></div>
    <div class="topbar" id="pc-count-toolbar"><div class="subnav-inline"><button class="tab active" data-status="open">Open</button>
    <button class="tab" data-status="all">All</button></div><div class="grow"></div>
    ${canCount ? `<button class="btn" id="pc-new">${UI.icon('plus')} New count</button>` : ''}</div>
    <div class="topbar" id="pc-task-toolbar" style="display:none"><div class="subnav-inline">
      <button class="tab active" data-task-status="open">Open</button><button class="tab" data-task-status="all">All</button></div>
      <label class="small"><input type="checkbox" id="pc-mine"> My assignments</label><div class="grow"></div>
      ${canReview ? `<button class="btn" id="pc-plan">${UI.icon('plus')} Plan count</button>` : ''}</div>
    <p class="muted small" id="pc-intro">Count one item, exact location and build state at a time. A second person reviews the result.
    Untracked and exact-batch differences can be applied after approval. Serialized differences need their unit workflow.</p>
    <div class="panel" style="overflow-x:auto"><div id="pc-list"></div></div>`;
  const list = view.querySelector('#pc-list');
  async function showSection(next){
    section=next;
    view.querySelectorAll('[data-section]').forEach(x=>x.classList.toggle('active',x.dataset.section===section));
    view.querySelector('#pc-count-toolbar').style.display=section==='counts'?'':'none';
    view.querySelector('#pc-task-toolbar').style.display=section==='tasks'?'':'none';
    view.querySelector('#pc-intro').textContent=section==='counts'
      ? 'Count one item, exact location and build state at a time. A second person reviews the result. Untracked and exact-batch differences can be applied after approval. Serialized differences need their unit workflow.'
      : section==='tasks' ? 'Assigned checks stay open until an approved count is reconciled. Rejected counts can be repeated. Overdue dates remain visible.'
        : 'Known stock positions, including planned empty shelves, show their last reconciled count and whether another item check is planned.';
    if(section==='counts')await load();else if(section==='tasks')await loadTasks();else await loadCoverage();
  }
  view.querySelectorAll('[data-section]').forEach(b=>b.onclick=()=>showSection(b.dataset.section));
  view.querySelectorAll('[data-status]').forEach(b => b.onclick = () => {
    status = b.dataset.status;
    view.querySelectorAll('[data-status]').forEach(x => x.classList.toggle('active', x === b));
    load();
  });
  if (canCount) view.querySelector('#pc-new').onclick = () => newCount(filter || {});
  view.querySelectorAll('[data-task-status]').forEach(b=>b.onclick=()=>{
    taskStatus=b.dataset.taskStatus;
    view.querySelectorAll('[data-task-status]').forEach(x=>x.classList.toggle('active',x===b));
    loadTasks();
  });
  view.querySelector('#pc-mine').onchange=e=>{taskMine=e.target.checked;loadTasks();};
  if(canReview)view.querySelector('#pc-plan').onclick=()=>planTask();

  async function load() {
    const version=++loadVersion;
    list.innerHTML = '<div class="empty">Loading…</div>';
    try { rows = await API.get('/inventory/stock-counts?status=' + status); }
    catch (e) { if(version===loadVersion)list.innerHTML = `<div class="empty">${UI.esc(e.message)}</div>`; return; }
    if(version!==loadVersion||section!=='counts')return;
    if (!rows.length) {
      list.innerHTML = UI.emptyState({icon:'check',title: status === 'open' ? 'No open counts' : 'No counts yet',
        hint:'Start a count for one item at a specific shelf or warehouse location.'});
      return;
    }
    list.innerHTML = `<table><thead><tr><th>Count</th><th>Item / location</th><th>Build</th><th class="right">Book</th>
      <th class="right">Counted</th><th class="right">Variance</th><th>Status</th><th>Linked issue</th><th></th></tr></thead><tbody>
      ${rows.map(c => `<tr><td>#${c.id}<div class="muted small">${UI.fmtDate(c.counted_at)}</div></td>
        <td><strong>${UI.esc(c.item_name)}</strong><div class="muted small">${UI.esc(c.location_name)}</div></td>
        <td>${c.build_mode === 'semi_built' ? 'Semi-built' : 'Fully built / standard'}</td>
        <td class="right">${c.book_quantity}</td><td class="right">${c.counted_quantity}</td>
        <td class="right">${c.variance > 0 ? '+' : ''}${c.variance}</td>
        <td><span class="badge-pill ${c.status === 'applied' ? 'ok' : c.status === 'rejected' ? 'low' : ''}">${UI.esc(c.status)}</span></td>
        <td>${c.source_kind === 'manual' ? '—' : `${UI.esc(c.source_kind.replace('_',' '))} #${c.source_id} · ${c.source_closed_at ? 'closed' : UI.esc(c.source_status)}`}</td>
        <td><button class="btn secondary small" data-open="${c.id}">${c.status === 'applied' && c.source_status === 'open' ? 'Close issue' : 'Review'}</button></td></tr>`).join('')}</tbody></table>`;
    list.querySelectorAll('[data-open]').forEach(b => b.onclick = () => openCount(Number(b.dataset.open)));
  }

  async function loadTasks() {
    const version=++loadVersion;
    list.innerHTML='<div class="empty">Loading planned checks…</div>';
    let tasks;
    try{tasks=await API.get(`/inventory/stock-counts/tasks?status=${taskStatus}&mine=${taskMine?'1':'0'}`);}
    catch(e){if(version===loadVersion)list.innerHTML=`<div class="empty">${UI.esc(e.message)}</div>`;return;}
    if(version!==loadVersion||section!=='tasks')return;
    if(!tasks.length){list.innerHTML=UI.emptyState({icon:'check',title:'No planned checks here',
      hint:taskMine?'Switch off My assignments to see the full queue.':'Plan the first exact item and location check.'});return;}
    const overdue=tasks.filter(t=>t.overdue).length;
    list.innerHTML=`<p class="muted small">${tasks.length} ${taskStatus==='open'?'open':'listed'} · ${overdue} overdue</p>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,290px),1fr));gap:12px">
      ${tasks.map(t=>`<div class="panel" style="margin:0;padding:16px">
        <div style="display:flex;justify-content:space-between;gap:8px"><strong>${UI.esc(t.item_name)}</strong>
          <span class="badge-pill ${t.status==='completed'?'ok':t.overdue?'low':''}">${t.status==='open'?(t.overdue?'Overdue':'Due '+UI.esc(t.due_date)):UI.esc(t.status)}</span></div>
        <p class="muted small">${UI.esc(t.location_name)} · ${t.build_mode==='semi_built'?'Semi-built':'Fully built / standard'}</p>
        <p class="small">Assigned to <strong>${UI.esc(t.assigned_to_name)}</strong><br>Due ${UI.esc(t.due_date)}
          ${t.repeat_days?` · repeats every ${t.repeat_days} days`:''}</p>
        ${t.note?`<p class="small">${UI.esc(t.note)}</p>`:''}
        <p class="muted small">${t.latest_count_id?`Latest count #${t.latest_count_id}: ${UI.esc(t.latest_count_status)}`:'Awaiting physical count'}
          ${t.completed_at?` · completed ${UI.esc(t.completed_at)}`:''}</p>
        <div style="display:flex;flex-wrap:wrap;gap:8px">
          ${t.status==='open'&&t.assigned_to===App.getMe()?.id&&!['submitted','approved'].includes(t.latest_count_status)
            ? `<button class="btn small" data-task-count="${t.id}">${t.latest_count_status==='rejected'?'Recount':'Count now'}</button>`:''}
          ${t.latest_count_id?`<button class="btn secondary small" data-task-review="${t.latest_count_id}">View count</button>`:''}
          ${t.status==='open'&&canReview&&!['submitted','approved'].includes(t.latest_count_status)
            ? `<button class="btn secondary small" data-task-edit="${t.id}">Edit</button><button class="btn secondary small" data-task-cancel="${t.id}">Cancel</button>`:''}
        </div></div>`).join('')}</div>`;
    list.querySelectorAll('[data-task-count]').forEach(b=>b.onclick=()=>{
      const t=tasks.find(row=>row.id===Number(b.dataset.taskCount));
      newCount({item_id:t.item_id,location_id:t.location_id,build_mode:t.build_mode,task_id:t.id});
    });
    list.querySelectorAll('[data-task-review]').forEach(b=>b.onclick=()=>openCount(Number(b.dataset.taskReview)));
    list.querySelectorAll('[data-task-edit]').forEach(b=>b.onclick=()=>planTask(tasks.find(t=>t.id===Number(b.dataset.taskEdit))));
    list.querySelectorAll('[data-task-cancel]').forEach(b=>b.onclick=()=>cancelTask(tasks.find(t=>t.id===Number(b.dataset.taskCancel))));
  }

  async function loadCoverage(){
    const version=++loadVersion;
    list.innerHTML='<div class="empty">Loading stock-position coverage…</div>';
    let positions;
    try{positions=await API.get('/inventory/stock-counts/tasks/coverage');}
    catch(e){if(version===loadVersion)list.innerHTML=`<div class="empty">${UI.esc(e.message)}</div>`;return;}
    if(version!==loadVersion||section!=='coverage')return;
    const never=positions.filter(p=>!p.last_count_at).length,unplanned=positions.filter(p=>!p.open_task_id).length;
    list.innerHTML=`<p class="muted small">${positions.length} known stock positions · ${never} never reconciled by a physical count · ${unplanned} without an open assignment.
      Completed historical counts remain visible even when the next check is due.</p>
      ${!positions.length?UI.emptyState({icon:'check',title:'No known stock positions',hint:'Positions appear when stock is received or a check is planned.'}):
      `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,290px),1fr));gap:12px">
      ${positions.map(p=>`<div class="panel" style="margin:0;padding:16px"><strong>${UI.esc(p.item_name)}</strong>
        <p class="muted small">${UI.esc(p.location_name)} · ${p.build_mode==='semi_built'?'Semi-built':'Fully built / standard'} · book ${p.quantity}</p>
        <p class="small">Last reconciled: ${p.last_count_at?UI.esc(p.last_count_at):'<strong>Never</strong>'}<br>
        ${p.open_task_id?`Check #${p.open_task_id} due ${UI.esc(p.due_date)}${p.overdue?' · overdue':''}`:'No open check planned'}</p>
        ${canReview&&!p.open_task_id?`<button class="btn secondary small" data-cover-plan="${p.item_id}:${p.location_id}:${p.build_mode}">Plan check</button>`:''}
      </div>`).join('')}</div>`}`;
    list.querySelectorAll('[data-cover-plan]').forEach(b=>b.onclick=()=>{
      const [item_id,location_id,build_mode]=b.dataset.coverPlan.split(':');
      planTask({item_id:Number(item_id),location_id:Number(location_id),build_mode});
    });
  }

  async function planTask(seed={}){
    const editing=!!seed.id;
    let locations,assignees,preset;
    try{[locations,assignees,preset]=await Promise.all([API.get('/locations'),API.get('/inventory/stock-counts/tasks/assignees'),
      seed.item_id?API.get('/inventory/'+seed.item_id):Promise.resolve(null)]);}
    catch(e){UI.toast(e.message);return;}
    const {overlay:modal}=UI.modal({title:editing?`Edit planned check #${seed.id}`:'Plan a cycle count',size:'lg',confirmText:'Close',
      bodyHTML:`<p class="muted small">Assign one item, exact location and build state. The due date creates a visible queue; stock is captured later by the assigned worker.</p>
        <div class="form-grid"><div class="form-field span2"><label for="pc-plan-search">Find item by name or SKU</label>
          <input id="pc-plan-search" ${editing?'disabled':''} value="${UI.esc(preset?.name||'')}" placeholder="Type at least 2 characters"></div>
          <div class="form-field span2"><label for="pc-plan-item">Item</label><select id="pc-plan-item" ${editing?'disabled':''}>
            ${preset?`<option value="${preset.id}">${UI.esc(preset.name)}</option>`:'<option value="">Search for an item</option>'}</select></div>
          <div class="form-field"><label for="pc-plan-location">Exact location</label><select id="pc-plan-location" ${editing?'disabled':''}>
            <option value="">Choose a location</option>${locations.map(l=>`<option value="${l.id}" ${Number(seed.location_id)===l.id?'selected':''}>${UI.esc(l.path||l.name)}</option>`).join('')}</select></div>
          <div class="form-field"><label for="pc-plan-mode">Build state</label><select id="pc-plan-mode" ${editing?'disabled':''}>
            <option value="assembled">Fully built / standard</option><option value="semi_built">Semi-built</option></select></div>
          <div class="form-field"><label for="pc-plan-assignee">Assigned worker</label><select id="pc-plan-assignee">
            <option value="">Choose a worker</option>${assignees.map(u=>`<option value="${u.id}" ${Number(seed.assigned_to)===u.id?'selected':''}>${UI.esc(u.full_name)}</option>`).join('')}</select></div>
          <div class="form-field"><label for="pc-plan-due">Due date</label><input id="pc-plan-due" type="date" value="${UI.esc(seed.due_date||new Date().toISOString().slice(0,10))}"></div>
          <div class="form-field"><label for="pc-plan-repeat">Repeat every (days, optional)</label>
            <input id="pc-plan-repeat" type="number" min="1" max="365" step="1" value="${seed.repeat_days||''}" placeholder="One-time check"></div>
          <div class="form-field span2"><label for="pc-plan-note">Instructions (optional)</label>
            <textarea id="pc-plan-note" rows="2" maxlength="1000" placeholder="What to check on this shelf">${UI.esc(seed.note||'')}</textarea></div></div>
          <button class="btn" id="pc-plan-save">${editing?'Save changes':'Create assignment'}</button><div id="pc-plan-error" role="alert"></div>`,onConfirm:()=>true});
    modal.querySelector('#pc-plan-mode').value=seed.build_mode||'assembled';
    const search=modal.querySelector('#pc-plan-search'),picker=modal.querySelector('#pc-plan-item');
    let version=0;
    if(!editing)search.oninput=async()=>{
      const v=++version,q=search.value.trim();
      if(q.length<2){picker.innerHTML='<option value="">Type at least 2 characters</option>';return;}
      try{const items=await API.get('/inventory?q='+encodeURIComponent(q));
        if(v!==version||!modal.isConnected)return;
        picker.innerHTML='<option value="">Choose an item</option>'+items.slice(0,60).map(i=>
          `<option value="${i.id}">${UI.esc(i.name)}${i.sku?' · '+UI.esc(i.sku):''}</option>`).join('');
      }catch(e){if(v===version)picker.innerHTML=`<option value="">${UI.esc(e.message)}</option>`;}
    };
    modal.querySelector('#pc-plan-save').onclick=async()=>{
      const error=modal.querySelector('#pc-plan-error');error.textContent='';
      const repeat=modal.querySelector('#pc-plan-repeat').value.trim();
      if(repeat&&!/^(?:[1-9]|[1-9]\d|[1-2]\d\d|3[0-5]\d|36[0-5])$/.test(repeat)){
        error.textContent='Repeat interval must be 1–365 whole days.';return;}
      const payload={assigned_to:Number(modal.querySelector('#pc-plan-assignee').value),
        due_date:modal.querySelector('#pc-plan-due').value,repeat_days:repeat?Number(repeat):null,
        note:modal.querySelector('#pc-plan-note').value.trim()};
      if(!editing)Object.assign(payload,{item_id:Number(picker.value),location_id:Number(modal.querySelector('#pc-plan-location').value),
        build_mode:modal.querySelector('#pc-plan-mode').value});
      if(!payload.assigned_to||!payload.due_date||(!editing&&(!payload.item_id||!payload.location_id))){
        error.textContent='Choose an item, exact location, worker and due date.';return;}
      const button=modal.querySelector('#pc-plan-save');button.disabled=true;
      try{if(editing)await API.put(`/inventory/stock-counts/tasks/${seed.id}`,payload);
        else await API.post('/inventory/stock-counts/tasks',payload);
        modal.__close();UI.toast(editing?'Assignment updated':'Cycle count planned');
        await showSection('tasks');
      }catch(e){error.textContent=e.message;button.disabled=false;}
    };
  }

  function cancelTask(task){
    const {overlay:modal}=UI.modal({title:`Cancel planned check #${task.id}`,confirmText:'Close',bodyHTML:
      `<p>Cancel the assignment for <strong>${UI.esc(task.item_name)}</strong> at ${UI.esc(task.location_name)}?</p>
       <div class="form-field"><label for="pc-cancel-note">Reason</label><textarea id="pc-cancel-note" rows="2" maxlength="1000"></textarea></div>
       <button class="btn" id="pc-cancel-confirm">Cancel assignment</button><div id="pc-cancel-error" role="alert"></div>`,onConfirm:()=>true});
    modal.querySelector('#pc-cancel-confirm').onclick=async()=>{
      const note=modal.querySelector('#pc-cancel-note').value.trim(),error=modal.querySelector('#pc-cancel-error');
      if(note.length<10){error.textContent='Enter a reason of at least 10 characters.';return;}
      const b=modal.querySelector('#pc-cancel-confirm');b.disabled=true;
      try{await API.post(`/inventory/stock-counts/tasks/${task.id}/cancel`,{note});
        modal.__close();UI.toast('Assignment cancelled');loadTasks();}
      catch(e){error.textContent=e.message;b.disabled=false;}
    };
  }

  async function newCount(seed) {
    const locations = await API.get('/locations');
    const preset = seed.item_id ? await API.get('/inventory/' + seed.item_id) : null;
    const {overlay:modal} = UI.modal({title:'New physical count',size:'lg',confirmText:'Close',
      bodyHTML:`<p class="muted small">${seed.task_id?`Planned check #${seed.task_id}: count the assigned item and exact location.`:'Choose the item and the exact shelf/location.'} Load the live stock before recording what you physically found.</p>
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
    if(seed.task_id){
      ['#pc-search','#pc-item','#pc-location','#pc-mode'].forEach(selector=>modal.querySelector(selector).disabled=true);
    }
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
          ${context.untracked_quantity < 0 ? '<p class="danger">Book stock is below tracked stock. Count the physical stock; approval will be required before any correction.</p>' : ''}
          <div class="form-field"><label for="pc-untracked">Physically counted untracked quantity</label>
            <input id="pc-untracked" type="number" min="0" step="1" placeholder="Enter count"></div>
          ${context.serials.length ? `<p><strong>Scan/check each serial physically present</strong>. Leave a missing unit unchecked.</p>
            <div style="max-height:220px;overflow:auto">${context.serials.map(s =>
              `<label class="check-opt" style="display:block"><input type="checkbox" data-pc-serial="${UI.esc(s.code)}"> ${UI.esc(s.code)} <span class="muted small">${UI.esc(s.status)}</span></label>`).join('')}</div>
            ` : ''}
          <div class="form-field"><label for="pc-extra-serials">Unexpected serials physically found (one per line)</label>
            <textarea id="pc-extra-serials" rows="2" placeholder="Only labels absent from the list above"></textarea>
            <p class="muted small">Record the exact label. Do not include these units in the untracked quantity; a supervisor must investigate their unit records.</p></div>
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
          const checked=[...capture.querySelectorAll('[data-pc-serial]:checked')].map(e=>e.dataset.pcSerial);
          const extra=capture.querySelector('#pc-extra-serials').value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
          const allSerials=[...checked,...extra];
          if(allSerials.length>500||allSerials.some(s=>s.length>120)||
            new Set(allSerials.map(s=>s.toLocaleLowerCase())).size!==allSerials.length ||
            extra.some(s=>context.serials.some(book=>book.code.toLocaleLowerCase()===s.toLocaleLowerCase()))){
            error.textContent='Enter each unexpected serial once, one per line (up to 120 characters). Check listed serials above instead of entering them again.';return;
          }
          const payload={item_id,location_id,build_mode,expected_quantity:context.book_quantity,
            expected_serial_ids:context.serials.map(s=>s.id),
            expected_batches:context.batches.map(b=>({batch_id:b.batch_id,quantity:b.quantity})),
            counted_untracked:Number(untracked),
            counted_serial_codes:allSerials,
            counted_batches:batchInputs.map(e=>({batch_id:Number(e.dataset.pcBatch),quantity:Number(e.value)})),
            note,source_kind:seed.source_kind||'manual',source_id:seed.source_id||null,task_id:seed.task_id||null};
          if(!attempt) attempt={payload,key:'stock-count-'+(window.crypto?.randomUUID?.()||Date.now()+'-'+Math.random())};
          const button=capture.querySelector('#pc-submit');button.disabled=true;
          const controls=[...capture.querySelectorAll('input,textarea,select')];controls.forEach(control=>control.disabled=true);
          try{const saved=await API.post('/inventory/stock-counts',attempt.payload,{idempotencyKey:attempt.key});
            modal.__close();UI.toast('Count #'+saved.id+' submitted for review');
            if(section==='tasks')loadTasks();else load();}
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
    const unitLink=(u,label)=>u.job_order_id
      ? `<button type="button" class="btn secondary small" data-pc-job="${u.job_order_id}">${UI.esc(label)}</button>`
      : UI.esc(label);
    const missing=(c.missing_serials||[]).map(u=>`<li>${unitLink(u,u.code)} <span class="muted small">${UI.esc(u.status)} · unit #${u.id}</span></li>`).join('');
    const unexpected=(c.unexpected_serials||[]).map(entry=>`<li><strong>${UI.esc(entry.code)}</strong> · ${entry.matches.length===1
      ? `${unitLink(entry.matches[0],'Open unit record')} <span class="muted small">${UI.esc(entry.matches[0].status)} · unit #${entry.matches[0].id}</span>`
      : entry.matches.length>1 ? 'Multiple matching records; investigate label' : 'No matching unit record; investigate label'}
      </li>`).join('');
    const batches=c.counted_batches.length ? c.counted_batches.map(b=>{
      const current=c.current_batches.find(x=>x.batch_id===b.batch_id);
      return `${UI.esc(current?.number || '#'+b.batch_id)}: ${b.quantity}`;
    }).join(', ') : 'None';
    const {overlay:modal}=UI.modal({title:`Physical count #${c.id}`,size:'lg',confirmText:'Close',bodyHTML:
      `<p><strong>${UI.esc(c.item_name)}</strong> · ${UI.esc(c.location_name)} · ${c.build_mode === 'semi_built' ? 'Semi-built' : 'Fully built / standard'}</p>
       <p>Book ${c.book_quantity} → counted <strong>${c.counted_quantity}</strong> · variance <strong>${c.variance>0?'+':''}${c.variance}</strong> · now ${c.current_quantity}</p>
       <p><strong>Untracked:</strong> ${c.counted_untracked}<br><strong>Serials found:</strong> ${serials}<br><strong>Batches:</strong> ${batches}</p>
       ${missing||unexpected ? `<div class="panel" style="margin:12px 0;padding:12px">
         <strong>Serial exceptions</strong>
         ${missing?`<p class="small">Missing from this location's book list:</p><ul>${missing}</ul>`:''}
         ${unexpected?`<p class="small">Found but absent from this location's book list:</p><ul>${unexpected}</ul>`:''}
         <p class="muted small">Review the exact unit and its location or sales state. Resolve through its owning workflow, then return here to verify. This count does not move serialized stock.</p>
       </div>`:''}
       <p><strong>Counter note:</strong> ${UI.esc(c.note)}</p>
       ${c.source_kind !== 'manual' ? `<p><strong>Linked issue:</strong> ${UI.esc(c.source_kind.replace('_',' '))} #${c.source_id} · ${c.source_closed_at ? 'closed from this count' : UI.esc(c.source_status)}</p>
         ${c.source_status === 'changed' ? '<p class="danger">Sale audit evidence changed after this count. Refresh the audit and start a new count before closing it.</p>' : ''}
         ${c.source_status === 'resolved' || c.source_status === 'reviewed' ? '<p class="muted small">This issue has already been closed.</p>' : ''}` : ''}
       ${c.source_close_note ? `<p><strong>Issue closure:</strong> ${UI.esc(c.source_close_note)}</p>` : ''}
       ${c.review_note ? `<p><strong>Review:</strong> ${UI.esc(c.review_note)}</p>` : ''}
       ${c.status === 'approved' && c.current_serials.map(s=>s.code).sort().join('|') !== c.counted_serial_codes.slice().sort().join('|') ? '<p class="danger">Serialized units differ. Resolve exact unit records first; this screen will not make a generic quantity adjustment.</p>' : ''}
       <div class="form-field"><label for="pc-action-note">Reviewer findings / correction reference</label>
         <textarea id="pc-action-note" rows="2" maxlength="1000" placeholder="What was checked or which movement corrected it"></textarea></div>
       <div style="display:flex;flex-wrap:wrap;gap:8px">
         ${c.status==='submitted'&&canReview ? '<button class="btn" data-pc-action="approve">Approve</button><button class="btn secondary" data-pc-action="reject">Reject</button>' : ''}
         ${c.status==='approved'&&canReview ? '<button class="btn" data-pc-action="apply">Apply safe correction</button><button class="btn secondary" data-pc-action="verify">Verify separately corrected</button>' : ''}
         ${c.status==='applied'&&c.source_status==='open'&&!c.source_closed_at&&canReview ? '<button class="btn" data-pc-action="close-source">Close linked issue</button>' : ''}
       </div><div id="pc-action-error" role="alert"></div>`});
    modal.querySelectorAll('[data-pc-job]').forEach(b=>b.onclick=()=>{
      modal.__close();App.navigate('job-orders',{id:Number(b.dataset.pcJob)});
    });
    modal.querySelectorAll('[data-pc-action]').forEach(b=>b.onclick=async()=>{
      const action=b.dataset.pcAction, note=modal.querySelector('#pc-action-note').value.trim();
      const error=modal.querySelector('#pc-action-error');error.textContent='';
      if(action!=='apply'&&note.length<10){error.textContent='Enter findings or a correction reference (at least 10 characters).';return;}
      b.disabled=true;
      try{
        await API.post(`/inventory/stock-counts/${c.id}/${action}`,action==='apply'?{}:{note});
        modal.__close();UI.toast(action==='approve'?'Count approved':action==='reject'?'Count rejected':action==='close-source'?'Linked issue closed':'Count reconciled');
        if((action==='apply'||action==='verify')&&c.source_kind!=='manual'&&section==='counts'){
          status='all';view.querySelectorAll('[data-status]').forEach(x=>x.classList.toggle('active',x.dataset.status==='all'));
          await load();await openCount(c.id);
        }else if(section==='tasks')await loadTasks();else await load();
      }catch(e){error.textContent=e.message;b.disabled=false;}
    });
  }

  await load();
  if(filter?.item_id && canCount) newCount(filter);
});
