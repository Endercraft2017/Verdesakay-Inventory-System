/* Shared QA/QC checklist library editor — the named, reusable checklists a finished
   product points at (qc_checklist_qa_id / qc_checklist_qc_id), enforced when an inspector
   passes a unit. Each checklist belongs to one stage as a whole (QA = first pass, QC =
   final pass) — set with the switch next to its name, not per check.
   Used from both Production → Finished Products (assigning one to a product) and
   Production → QA / QC (the inspection queue / findings screens) so there's a single
   place the modal's logic lives.

   QCChecklists.open(onChange?) — opens the library modal; onChange() fires after any
   save/delete so the caller can refresh anything it cached (e.g. a product list's
   "QA/QC checklist" column). */
(function () {
  const STAGE_SWITCH = [
    { v: 1, label: 'QA', title: 'QA — first-pass checklist' },
    { v: 2, label: 'QC', title: 'QC — final-pass checklist' },
  ];

  function open(onChange) {
    let checklists = [];
    const m = UI.modal({
      title: 'QA / QC checklists',
      size: 'lg',
      cancelText: 'Close',
      bodyHTML: `<div id="qcl-list"></div>
        <button type="button" class="btn secondary small" id="qcl-new" style="margin-top:10px">${UI.icon('plus')} New checklist</button>`,
    });
    const listEl = m.overlay.querySelector('#qcl-list');

    async function refresh() {
      checklists = await API.get('/qc/checklists');
      listEl.innerHTML = checklists.length ? `
        <table><thead><tr><th>Stage</th><th>Name</th><th class="right">Checks</th><th></th></tr></thead>
        <tbody>${checklists.map((c) => `<tr>
          <td><span class="badge-pill ${c.stage === 2 ? 'confirmed' : 'ok'}">${c.stage === 2 ? 'QC' : 'QA'}</span></td>
          <td><strong>${UI.esc(c.name)}</strong>${c.is_default ? ' <span class="badge-pill ok">default</span>' : ''}</td>
          <td class="right">${c.item_count}</td>
          <td class="actions">
            <button class="icon-btn" data-edit="${c.id}" title="Edit">${UI.icon('edit')}</button>
            <button class="icon-btn danger" data-del="${c.id}" title="Delete">${UI.icon('trash')}</button>
          </td></tr>`).join('')}</tbody></table>` : '<p class="muted">No checklists yet.</p>';
      listEl.querySelectorAll('[data-edit]').forEach((b) =>
        b.onclick = () => editChecklist(checklists.find((c) => String(c.id) === b.dataset.edit), refresh));
      listEl.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
        if (!(await UI.confirmDialog('Delete this checklist? Products using it fall back to the default for its stage.', 'Delete'))) return;
        await API.del('/qc/checklists/' + b.dataset.del);
        UI.toast('Deleted'); refresh(); if (onChange) onChange();
      });
    }
    m.overlay.querySelector('#qcl-new').onclick = () => editChecklist(null, refresh);
    refresh();

    function editChecklist(existing, after) {
      let items = existing ? (existing.items || []).map((it) => ({ label: it.label, required: !!it.required })) : [];
      let stage = existing ? (Number(existing.stage) || 1) : 1;
      const em = UI.modal({
        title: existing ? `Edit — ${existing.name}` : 'New checklist',
        size: 'lg',
        confirmText: 'Save',
        bodyHTML: `
          <div class="field-row">
            <div style="flex:1"><label>Checklist name <span class="req">*</span></label><input data-f="name" value="${UI.esc(existing ? existing.name : '')}" /></div>
            <div class="seg-switch" data-f="checklist-stage" role="group" aria-label="Which stage this checklist is for">
              ${STAGE_SWITCH.map((s) => `<button type="button" data-v="${s.v}" title="${UI.esc(s.title)}" class="${s.v === stage ? 'active' : ''}">${s.label}</button>`).join('')}
            </div>
            <label class="check" style="align-self:flex-end;white-space:nowrap"><input type="checkbox" data-f="default" ${existing && existing.is_default ? 'checked' : ''}/> Default</label>
          </div>
          <p class="muted" style="font-size:11px;margin:2px 0 0">A checklist applies to one stage — QA (first pass) or QC (final pass). A 1-step job order runs both stages' checklists together.</p>
          <h4 style="margin:14px 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted)">Checks</h4>
          <div id="qce-list"></div>
          <button type="button" class="btn secondary small" id="qce-add" style="margin-top:8px">${UI.icon('plus')} Add check</button>`,
        onConfirm: async (ov, showErr) => {
          const name = ov.querySelector('[data-f="name"]').value.trim();
          if (!name) { showErr('Name is required'); return false; }
          const clean = items.map((it) => ({ label: (it.label || '').trim(), required: !!it.required })).filter((it) => it.label);
          const body = { name, stage, is_default: ov.querySelector('[data-f="default"]').checked, items: clean };
          if (existing) await API.put('/qc/checklists/' + existing.id, body);
          else await API.post('/qc/checklists', body);
          UI.toast('Checklist saved');
          after();
          if (onChange) onChange();
        },
      });
      em.overlay.querySelectorAll('[data-f="checklist-stage"] button').forEach((b) => b.onclick = () => {
        stage = Number(b.dataset.v);
        em.overlay.querySelectorAll('[data-f="checklist-stage"] button').forEach((x) => x.classList.toggle('active', x === b));
      });
      const le = em.overlay.querySelector('#qce-list');
      function drawItems() {
        le.innerHTML = items.length ? items.map((it, i) => `
          <div class="field-row" style="align-items:center;gap:8px;margin-bottom:6px" data-i="${i}">
            <input data-f="label" value="${UI.esc(it.label)}" placeholder="e.g. Dimensions within tolerance" style="flex:1" />
            <label class="check" style="white-space:nowrap"><input type="checkbox" data-f="required" ${it.required ? 'checked' : ''}/> Required</label>
            <button type="button" class="icon-btn danger" data-del title="Remove">${UI.icon('trash')}</button>
          </div>`).join('') : '<p class="muted">No checks yet.</p>';
        le.querySelectorAll('[data-i]').forEach((row) => {
          const i = Number(row.dataset.i);
          row.querySelector('[data-f="label"]').oninput = (e) => { items[i].label = e.target.value; };
          row.querySelector('[data-f="required"]').onchange = (e) => { items[i].required = e.target.checked; };
          row.querySelector('[data-del]').onclick = () => { items.splice(i, 1); drawItems(); };
        });
      }
      em.overlay.querySelector('#qce-add').onclick = () => { items.push({ label: '', required: false }); drawItems(); };
      drawItems();
    }
  }

  window.QCChecklists = { open };
})();
