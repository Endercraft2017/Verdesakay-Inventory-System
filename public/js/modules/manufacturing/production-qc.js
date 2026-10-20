/* Production → QC / QA: everything QC/QA-related lives here.
   - Inspection queue: every unit waiting on a pass, or back from repair, across every
     open job order (filter.tab omitted or 'queue'). Row click opens a lightweight,
     QC/QA-only inspect modal in place (inspectModal below) — deliberately not the full
     Job Orders detail modal (job-orders.js trackModal), which carries components,
     production progress, batches and other job-management chrome this screen doesn't need.
   - Findings & reports: the full pass/fail history across every job order, filterable
     and exportable (filter.tab = 'findings'), backed by GET /qc/records.
   - Manage Checklists (qc.configure): the shared named-checklist library
     (public/js/lib/qc-checklists.js) — also reachable from Finished Products, where a
     checklist gets attached to a product.
   inspectModal is hoisted to module scope (not nested in App.register) and exposed as
   window.ProductionQC.inspect so job-orders.js's trackModal can open the exact same
   inspect UI over the job order detail instead of keeping its own duplicate. */

// Simple, QC/QA-only inspect dialog for one job order's queue — opened in place (no
// navigating away to the full Job Orders detail, which carries components, production
// progress, batches and other job-management chrome this screen doesn't need).
// Master-detail layout: the unit list on the left stays a plain list (no inline
// checklist/pass/fail), the checklist form always lives in the side panel on the right —
// clicking a row loads that one unit there; checking one or more boxes switches the same
// panel to a bulk pass/fail scoped to the checked units.
async function inspectModal(jobOrderId, onDone) {
  const canConfigQc = App.hasPermission('qc.configure');
  const hasQc = App.hasPermission('production.inspect_qc');
  const hasQa = App.hasPermission('production.inspect_qa');
  const canInspect = hasQc || hasQa;

  let jo;
  try { jo = await API.get('/job-orders/' + jobOrderId); }
  catch (e) { UI.toast(e.message || 'Unable to load the job order', 'error'); return; }
  let units = [];
  let qcLog = [];
  let repairs = [];
  let loadError = null;
  let activeUnitId = null;
  const checkedIds = new Set();
  // The checklist library + this product's own QC/QA links (raw ids, not the resolved
  // fallback-to-default object jo.qc_checklist_qc/qa carries) — only needed to run the
  // assign-checklist pickers below, so only loaded for qc.configure users.
  let allChecklists = [];
  let product = null;

  const m = UI.modal({ title: `Inspect — ${jo.number}`, size: 'xl', cancelText: 'Close', bodyHTML: '<div id="qi-body"></div>' });
  const host = () => m.overlay ? m.overlay.querySelector('#qi-body') : null;

  async function refresh() {
    loadError = null;
    try {
      [units, qcLog] = await Promise.all([
        API.get('/job-orders/' + jobOrderId + '/units'),
        API.get('/job-orders/' + jobOrderId + '/qc'),
      ]);
    } catch (e) { loadError = e; return; }
    try { repairs = await API.get('/production/repairs?job_order=' + jobOrderId); } catch { repairs = []; }
    if (canConfigQc) {
      try { allChecklists = await API.get('/qc/checklists'); } catch { allChecklists = []; }
      try { product = jo.product_item_id ? await API.get('/finished-products/' + jo.product_item_id) : null; } catch { product = null; }
    }
  }

  const reworkOpen = (uid) => repairs.some((r) => r.unit_id === uid && r.status === 'requested');
  const DISPOSITIONS = ['scrap', 'dispose', 'recycle', 'repair'];

  // Mirrors job-orders.routes.ts's /:id/units/inspect stage-aware check: a qc_inspector
  // account may only pass/fail the first (QC) pass, a qa_inspector only the final (QA)
  // one; a single-stage job order's one combined pass accepts either. Used to disable the
  // Pass/Fail buttons up front instead of letting the account hit a 403 after filling the
  // form — same "guide the user" reasoning as the rest of this screen.
  function passAllowed(firstP, finalP) {
    const combinedPass = (jo.qc_stages || 1) <= 1;
    return combinedPass ? (hasQc || hasQa) : ((!firstP || hasQc) && (!finalP || hasQa));
  }
  function passLabelFor(firstP, finalP) {
    if ((jo.qc_stages || 1) <= 1) return 'QC or QA';
    return firstP ? 'QC' : 'QA';
  }

  function checklistFor(unitSubset) {
    const totalStages = Math.max(1, jo.qc_stages || 1);
    const firstP = unitSubset.some((u) => (u.stage || 0) + 1 === 1);
    const finalP = unitSubset.some((u) => (u.stage || 0) + 1 >= totalStages);
    const items = [
      ...(firstP && jo.qc_checklist_qc ? jo.qc_checklist_qc.items.map((it) => ({ ...it, _from: 'QC' })) : []),
      ...(finalP && jo.qc_checklist_qa ? jo.qc_checklist_qa.items.map((it) => ({ ...it, _from: 'QA' })) : []),
    ];
    const names = [firstP && jo.qc_checklist_qc ? jo.qc_checklist_qc.name : null,
      finalP && jo.qc_checklist_qa ? jo.qc_checklist_qa.name : null].filter(Boolean);
    return { items, names, firstP, finalP };
  }

  // One stage's "assign checklist" button — qc.configure only. Shows the product's
  // current link (or "Default"); opens a right-docked, searchable drawer (UI.drawer) to
  // pick a different one from the library loaded in refresh() — a drawer + search rather
  // than a plain <select> so this scales once there are many checklists to choose from.
  // Picking one PATCHes it straight through (bom.routes.ts /:id/checklist) and redraws so
  // the freshly assigned checklist's items show up immediately.
  function checklistButtonHTML(stage) {
    if (!canConfigQc) return '';
    const label = stage === 1 ? 'QC' : 'QA';
    if (jo.released_at) return `<span class="muted" style="font-size:11px" title="This job order uses the checklist captured when its kit was released">${label} checklist frozen at release</span>`;
    const currentId = product ? (stage === 1 ? product.qc_checklist_qc_id : product.qc_checklist_qa_id) : null;
    const current = currentId ? allChecklists.find((c) => String(c.id) === String(currentId)) : null;
    return `<button type="button" class="btn secondary small qi-assign-btn" data-stage="${stage}" title="Assign this product's ${label} checklist">
      ${label}: ${UI.esc(current ? current.name : 'Default')} ${UI.icon('edit', 12)}
    </button>`;
  }

  function wireChecklistButtons(container) {
    container.querySelectorAll('.qi-assign-btn').forEach((btn) =>
      btn.onclick = () => openChecklistDrawer(Number(btn.dataset.stage)));
  }

  function openChecklistDrawer(stage) {
    const label = stage === 1 ? 'QC' : 'QA';
    const currentId = product ? (stage === 1 ? product.qc_checklist_qc_id : product.qc_checklist_qa_id) : null;
    const rows = [{ id: null, name: 'Use default', is_default: false },
      ...allChecklists.filter((c) => Number(c.stage) === stage)];

    const d = UI.drawer({
      title: `Assign ${label} checklist`,
      icon: 'check',
      bodyHTML: `
        <div class="search-box" style="margin-bottom:10px">${UI.icon('search', 16)}<input id="qcd-search" placeholder="Search checklists…" /></div>
        <div id="qcd-list"></div>`,
      footHTML: `<button type="button" class="btn secondary" id="qcd-new">${UI.icon('plus')} New ${label} checklist</button>`,
    });
    if (!d) return;
    const listEl = d.el.querySelector('#qcd-list');
    const searchEl = d.el.querySelector('#qcd-search');
    const newBtn = d.el.querySelector('#qcd-new');
    if (newBtn) newBtn.onclick = () => QCChecklists.new(stage, (newId) => assign(newId));

    async function assign(id) {
      try {
        await API.patch('/finished-products/' + jo.product_item_id + '/checklist', { stage, checklist_id: id });
        // refresh() reloads units/checklist-library/product but not jo itself — and the
        // checklist items the form actually renders come from jo.qc_checklist_qc/qa
        // (resolved server-side per job order), so that needs its own re-fetch here too.
        jo = await API.get('/job-orders/' + jobOrderId);
        await refresh();
        UI.toast('Checklist assigned');
        d.close();
        draw();
      } catch (e) { UI.toast(e.message, 'error'); }
    }

    function render() {
      const q = searchEl.value.trim().toLowerCase();
      const filtered = q ? rows.filter((r) => r.name.toLowerCase().includes(q)) : rows;
      listEl.innerHTML = filtered.length
        ? filtered.map((r) => `
          <div class="combo-option qcd-row" data-id="${r.id ?? ''}" style="display:flex;justify-content:space-between;align-items:center">
            <span>${UI.esc(r.name)}${r.is_default ? ' <span class="badge-pill ok">default</span>' : ''}</span>
            ${String(r.id ?? '') === String(currentId ?? '') ? UI.icon('check', 14) : ''}
          </div>`).join('')
        : `<div class="combo-empty">No checklists match</div>`;
      listEl.querySelectorAll('.qcd-row').forEach((row) => row.onclick = () => assign(row.dataset.id || null));
    }
    searchEl.addEventListener('input', render);
    render();
    searchEl.focus();
  }

  function inspectFormHTML(qcCl, qcClNames, allowed, passLabel, finalPass) {
    const labels = qcCl.map((it) => it.label.trim().toLowerCase());
    if (new Set(labels).size !== labels.length) {
      return UI.emptyState({ icon: 'alert', title: 'Checklist configuration needs attention',
        hint: 'QC and QA contain the same check label. Ask a checklist manager to give each check a distinct label before inspecting this job.' });
    }
    return `
      ${qcCl.length ? `
        <div style="margin-top:10px;border:1px solid var(--border);border-radius:8px;background:var(--surface-2);padding:10px">
          <label style="font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted)">QC/QA checklist${qcClNames.length ? ` — ${qcClNames.map(UI.esc).join(' + ')}` : ''}</label>
          <div style="display:flex;flex-direction:column;gap:6px;margin-top:6px">
            ${qcCl.map((it, i) => `
              <div class="qi-check-row" data-i="${i}" style="border-bottom:1px solid var(--border);padding:6px 0">
                <label>${UI.esc(it.label)}${it.required ? ' <span style="color:var(--danger,#dc2626)">*</span>' : ''}
                  ${qcClNames.length > 1 ? `<span class="muted" style="font-size:11px">(${it._from})</span>` : ''}</label>
                ${it.hint ? `<div class="muted" style="font-size:11px">${UI.esc(it.hint)}</div>` : ''}
                <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px">
                  <select class="qi-check-status" aria-label="${UI.esc(it.label)} result" ${allowed ? '' : 'disabled'}><option value="">Choose result</option><option value="pass">Pass</option><option value="issue">Issue</option><option value="na">N/A</option></select>
                  ${it.measure ? `<input class="qi-check-value" aria-label="${UI.esc(it.label)} reading (${UI.esc(it.measure)})" placeholder="Reading (${UI.esc(it.measure)})" maxlength="60" ${allowed ? '' : 'disabled'} />` : ''}
                  <input class="qi-check-note" aria-label="${UI.esc(it.label)} note" placeholder="Note (optional)" maxlength="500" ${allowed ? '' : 'disabled'} />
                </div>
              </div>`).join('')}
          </div>
        </div>` : ''}
      <div style="margin-top:8px">
        <div style="margin-bottom:8px"><label>Identifier (optional, applies to passed units)</label><input id="qi-ident" ${allowed ? '' : 'disabled'} placeholder="e.g. chassis / serial no." /></div>
        <div style="margin-bottom:8px"><label>Remarks</label><input id="qi-remarks" ${allowed ? '' : 'disabled'} placeholder="Notes / reason if failing" /></div>
        <div><label>On fail</label>
          <select id="qi-disp" ${allowed ? '' : 'disabled'}>${[...DISPOSITIONS, ...(finalPass ? ['hold'] : [])].map((d) => `<option value="${d}">${d === 'hold' ? 'Hold for QA review' : d[0].toUpperCase() + d.slice(1)}</option>`).join('')}</select></div>
        <div style="margin-top:8px"><label>Evidence photo(s) — required to fail</label>
          <input type="file" id="qi-photos" accept="image/*" multiple ${allowed ? '' : 'disabled'} /></div>
      </div>
      ${allowed ? `
        <div style="display:flex;gap:8px;margin-top:10px">
          <button type="button" class="btn" id="qi-pass">Pass</button>
          <button type="button" class="btn secondary danger" id="qi-fail">Fail</button>
        </div>
        <p class="muted" style="font-size:11px;margin:6px 0 0">Fail → <b>repair</b> sends the unit to rework; it can only be re-inspected once its parts requests are settled.</p>`
        : `<p class="muted" style="font-size:12px;margin-top:10px">This pass needs ${UI.esc(passLabel)} inspection permission — not part of your account.</p>`}`;
  }

  function wireInspectForm(el, unitIds, qcCl) {
    const inspect = (result) => {
      const identifier = (el.querySelector('#qi-ident').value || '').trim() || undefined;
      const remarks = (el.querySelector('#qi-remarks').value || '').trim() || undefined;
      const disposition = result === 'fail' ? (el.querySelector('#qi-disp') || {}).value : undefined;
      if (result === 'fail' && !remarks) { UI.toast('Add a remark when failing units', 'error'); return; }
      const photos = [...((el.querySelector('#qi-photos') || {}).files || [])];
      if (result === 'fail' && !photos.length) { UI.toast('Add at least one evidence photo to fail units', 'error'); return; }

      let checklist;
      const rows = [...el.querySelectorAll('.qi-check-row')];
      if (rows.length) {
        checklist = rows.map((row, i) => {
          const status = row.querySelector('.qi-check-status').value;
          if (!status) return null;
          return { label: qcCl[i].label, ok: status === 'pass', status: status || undefined,
            value: row.querySelector('.qi-check-value')?.value.trim() || undefined,
            note: row.querySelector('.qi-check-note').value.trim() || undefined };
        }).filter(Boolean);
        if (result === 'pass') {
          const missing = qcCl.filter((item) => item.required && !checklist.some((answer) => answer.label === item.label && answer.status === 'pass')).map((item) => item.label);
          if (missing.length) { UI.toast('Pass the required checks first: ' + missing.join(', '), 'error'); return; }
          const readings = qcCl.filter((item) => item.measure && checklist.some((answer) => answer.label === item.label && answer.status === 'pass' && !answer.value)).map((item) => item.label);
          if (readings.length) { UI.toast('Record readings for: ' + readings.join(', '), 'error'); return; }
        }
      }
      // Evidence first (the server refuses a failing result without a photo of each unit): every
      // chosen photo is attached to every failed unit, so each result has its own.
      const uploads = result === 'fail' ? unitIds.flatMap((uid) => photos.map((f) => () => {
        const fd = new FormData();
        fd.append('kind', 'qc_unit'); fd.append('ref_id', String(uid)); fd.append('caption', 'QC/QA evidence'); fd.append('image', f);
        return API.upload('/attachments', fd).then((a) => a.id);
      })) : [];
      uploads.reduce((p, up) => p.then((ids) => up().then((id) => ids.concat(id))), Promise.resolve([]))
        .then((evidence_ids) => API.post('/job-orders/' + jobOrderId + '/units/inspect',
          { unit_ids: unitIds, result, identifier, remarks, checklist, disposition, evidence_ids: result === 'fail' ? evidence_ids : undefined }))
        .then(async (r) => {
          jo = r.job_order; await refresh();
          activeUnitId = null; checkedIds.clear();
          UI.toast(result === 'pass' ? 'Unit(s) passed' : disposition === 'hold' ? 'Sent to QA hold review' : disposition === 'repair' ? 'Sent to repair' : 'Unit(s) failed');
          draw();
          if (onDone) onDone();
        })
        .catch((e) => UI.toast(e.message, 'error'));
    };
    const pb = el.querySelector('#qi-pass'); if (pb) pb.onclick = () => inspect('pass');
    const fb = el.querySelector('#qi-fail'); if (fb) fb.onclick = () => inspect('fail');
  }

  function placeholderHTML() {
    return UI.emptyState({ icon: 'check', title: 'Nothing selected', hint: 'Click a unit, or check one or more boxes, to inspect it here.' });
  }

  function sideHTML(queue) {
    if (checkedIds.size) {
      const selected = queue.filter((u) => checkedIds.has(u.id));
      if (!selected.length) return placeholderHTML();
      if (new Set(selected.map((u) => u.stage + 1)).size > 1) {
        return UI.emptyState({ icon: 'alert', title: 'Select one inspection stage', hint: 'Inspect QC and QA units separately so each receives the correct checklist.' });
      }
      const { items, names, firstP, finalP } = checklistFor(selected);
      const pickers = `${firstP ? checklistButtonHTML(1) : ''}${finalP ? checklistButtonHTML(2) : ''}`;
      return `
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:8px">
          <div><strong>${selected.length} unit${selected.length > 1 ? 's' : ''} selected</strong>
            <div class="muted" style="font-size:12px">${selected.map((u) => '#' + u.id).join(', ')}</div></div>
          ${pickers ? `<div style="display:flex;flex-direction:row;flex-wrap:wrap;justify-content:flex-end;gap:4px">${pickers}</div>` : ''}
        </div>
        ${inspectFormHTML(items, names, passAllowed(firstP, finalP), passLabelFor(firstP, finalP), finalP)}`;
    }
    if (activeUnitId != null) {
      const unit = queue.find((u) => u.id === activeUnitId);
      if (!unit) return placeholderHTML();
      const blocked = unit.status === 'rework' && reworkOpen(unit.id);
      const step = ProductionSteps.unitStep(unit, jo.qc_stages);
      if (blocked) {
        return `
          <div style="margin-bottom:8px"><strong>Unit #${unit.id}</strong> <span class="badge-pill ${step.cls}">${step.label}</span></div>
          ${UI.emptyState({ icon: 'alert', title: 'Parts request still open', hint: 'This unit can only be re-inspected once its repair/parts request is settled.' })}`;
      }
      const { items, names, firstP, finalP } = checklistFor([unit]);
      const pickers = `${firstP ? checklistButtonHTML(1) : ''}${finalP ? checklistButtonHTML(2) : ''}`;
      return `
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:8px">
          <div><strong>Unit #${unit.id}</strong> <span class="badge-pill ${step.cls}">${step.label}</span>
            <span class="muted" style="font-size:11px">(pass ${(unit.stage || 0) + 1} / ${jo.qc_stages})</span>
            ${unit.identifier ? `<div class="muted mono" style="font-size:12px;margin-top:4px">${UI.esc(unit.identifier)}</div>` : ''}</div>
          ${pickers ? `<div style="display:flex;flex-direction:row;flex-wrap:wrap;justify-content:flex-end;gap:4px">${pickers}</div>` : ''}
        </div>
        ${inspectFormHTML(items, names, passAllowed(firstP, finalP), passLabelFor(firstP, finalP), finalP)}`;
    }
    return placeholderHTML();
  }

  function draw() {
    const el = host();
    if (!el) return;
    if (loadError) {
      el.innerHTML = `<div class="empty"><strong>Unable to load inspection details</strong><p>${UI.esc(loadError.message || 'Please try again.')}</p><button type="button" class="btn" id="qi-retry">Retry</button></div>`;
      el.querySelector('#qi-retry').onclick = async () => { await refresh(); draw(); };
      return;
    }
    const pending = units.filter((u) => u.status === 'pending');
    const rework = units.filter((u) => u.status === 'rework');
    const queue = pending.concat(rework);
    for (const id of [...checkedIds]) if (!queue.some((u) => u.id === id)) checkedIds.delete(id);
    if (activeUnitId != null && !queue.some((u) => u.id === activeUnitId)) activeUnitId = null;

    el.innerHTML = `
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
        <strong>${UI.esc(jo.product_name)}</strong>
        <span class="muted">${jo.qc_stages}-step inspection</span>
        ${jo.team_name ? `<span class="muted">· ${UI.esc(jo.team_name)}</span>` : ''}
      </div>
      ${queue.length ? `
        <div style="display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap">
          <div style="flex:1 1 55%;min-width:0">
            <table>
              <thead><tr>
                <th style="width:28px"><input type="checkbox" id="qi-chk-all" /></th>
                <th>Unit</th><th>Step</th><th>Identifier</th>
              </tr></thead>
              <tbody>${queue.map((u) => {
                const blocked = u.status === 'rework' && reworkOpen(u.id);
                const step = ProductionSteps.unitStep(u, jo.qc_stages);
                return `<tr class="clickable${u.id === activeUnitId ? ' active' : ''}" data-unit="${u.id}">
                  <td><input type="checkbox" class="qi-chk" value="${u.id}" ${checkedIds.has(u.id) ? 'checked' : ''} ${blocked ? 'disabled title="Parts request still open"' : ''} /></td>
                  <td>#${u.id}${u.status === 'rework' ? ' <span class="badge-pill confirmed">repair</span>' : ''}</td>
                  <td><span class="badge-pill ${step.cls}">${step.label}</span> <span class="muted" style="font-size:11px">(${u.stage} / ${jo.qc_stages})</span></td>
                  <td class="mono">${UI.esc(u.identifier || '—')}</td>
                </tr>`;
              }).join('')}</tbody>
            </table>
          </div>
          ${canInspect ? `<div id="qi-side" style="flex:1 1 45%;min-width:260px;border-left:1px solid var(--border);padding-left:16px">${sideHTML(queue)}</div>` : ''}
        </div>`
        : UI.emptyState({ icon: 'check', title: 'Nothing waiting for inspection', hint: 'All units on this job order have been inspected.' })}

      ${qcLog.length ? `
        <h4 style="margin:16px 0 4px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted)">Recent inspections</h4>
        <table>
          <thead><tr><th>When</th><th>Unit</th><th>Result</th><th>Inspector</th><th>Remarks / issues</th></tr></thead>
          <tbody>${qcLog.slice(0, 10).map((q) => {
            const issues = (Array.isArray(q.checklist) ? q.checklist : []).filter((c) => c.ok === false).map((c) => c.label).join(', ');
            return `<tr>
              <td class="muted" style="white-space:nowrap">${UI.esc((q.created_at || '').slice(0, 16).replace('T', ' '))}</td>
              <td>#${q.unit_id || '—'}${q.stage ? ` <span class="muted">s${q.stage}</span>` : ''}</td>
              <td>${q.result === 'pass' ? '<span class="badge-pill ok">pass</span>' : `<span class="badge-pill low">fail</span>${q.disposition ? ` <span class="muted" style="font-size:11px">${UI.esc(q.disposition)}</span>` : ''}`}</td>
              <td>${UI.esc(q.inspector_name || '—')}</td>
              <td>${UI.esc(q.remarks || '')}${issues ? `<div class="muted" style="font-size:11px">✗ ${UI.esc(issues)}</div>` : ''}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>` : ''}`;

    if (!queue.length || !canInspect) return;

    const redrawSide = () => {
      const side = el.querySelector('#qi-side');
      if (!side) return;
      side.innerHTML = sideHTML(queue);
      wireChecklistButtons(side);
      const unitIds = checkedIds.size ? [...checkedIds] : (activeUnitId != null ? [activeUnitId] : []);
      const qcCl = checkedIds.size ? checklistFor(queue.filter((u) => checkedIds.has(u.id))).items
        : (activeUnitId != null ? checklistFor(queue.filter((u) => u.id === activeUnitId)).items : []);
      if (unitIds.length) wireInspectForm(side, unitIds, qcCl);
    };

    const chkAll = el.querySelector('#qi-chk-all');
    if (chkAll) chkAll.onclick = () => {
      el.querySelectorAll('.qi-chk:not(:disabled)').forEach((c) => {
        c.checked = chkAll.checked;
        if (chkAll.checked) checkedIds.add(Number(c.value)); else checkedIds.delete(Number(c.value));
      });
      redrawSide();
    };
    el.querySelectorAll('.qi-chk').forEach((c) => c.onclick = (e) => {
      e.stopPropagation();
      if (e.target.checked) checkedIds.add(Number(e.target.value)); else checkedIds.delete(Number(e.target.value));
      redrawSide();
    });
    el.querySelectorAll('tr[data-unit]').forEach((tr) => tr.onclick = () => {
      activeUnitId = Number(tr.dataset.unit);
      checkedIds.clear();
      draw();
    });
    redrawSide();
  }

  await refresh();
  draw();
}

window.ProductionQC = { inspect: inspectModal };

App.register('production-qc', async (view, filter) => {
  const canConfigQc = App.hasPermission('qc.configure');
  const tab = filter && ['findings', 'holds'].includes(filter.tab) ? filter.tab : 'queue';
  const checklistBtnHTML = canConfigQc
    ? `<button class="btn secondary" id="qc-checklists">${UI.icon('edit')} Manage Checklists</button>`
    : '';

  function wireChecklistBtn() {
    const b = view.querySelector('#qc-checklists');
    if (b) b.onclick = () => QCChecklists.open();
  }

  function statCard(cls, ic, label, value) {
    return `<div class="stat-card ${cls || ''}"><div class="stat-ic">${UI.icon(ic, 20)}</div>
      <div><div class="value">${value}</div><div class="label">${UI.esc(label)}</div></div></div>`;
  }

  if (tab === 'findings') { await renderFindings(); }
  else if (tab === 'holds') { await renderHolds(); }
  else { await renderQueue(); }

  async function renderHolds() {
    view.innerHTML = `<div class="topbar"><h2>QC / QA <span class="muted" style="font-weight:400;font-size:14px">On hold</span></h2><div class="grow"></div>${checklistBtnHTML}</div>
      <div class="panel"><div id="qh-table" class="empty">Loading…</div></div>`;
    wireChecklistBtn();
    const table = view.querySelector('#qh-table');
    let holds;
    try { holds = await API.get('/qc/holds'); }
    catch (e) {
      table.innerHTML = `<strong>Unable to load QA holds</strong><p>${UI.esc(e.message || 'Please try again.')}</p><button class="btn" id="qh-retry">Retry</button>`;
      table.querySelector('#qh-retry').onclick = renderHolds;
      return;
    }
    if (!holds.length) {
      table.innerHTML = UI.emptyState({ icon: 'check', title: 'No units on hold', hint: 'QA holds needing a decision will appear here.' });
      return;
    }
    table.classList.remove('empty');
    table.innerHTML = `<table><thead><tr><th>Held since</th><th>Job order / unit</th><th>Product</th><th>Reason and issues</th><th>Evidence</th><th></th></tr></thead><tbody>
      ${holds.map((h) => `<tr><td class="muted">${UI.fmtDate(h.held_at)}</td><td><strong>${UI.esc(h.job_order_number)}</strong><div>${UI.esc(h.identifier || '#' + h.id)}</div></td>
        <td>${UI.esc(h.product_name)}</td><td>${UI.esc(h.remarks || '—')}${h.issues?.length ? `<div class="muted">${h.issues.map((i) => UI.esc(i.label)).join(', ')}</div>` : ''}</td>
        <td>${h.evidence || 0} photo(s)</td><td><button class="btn secondary" data-open-job="${h.job_order_id}">Open job</button> <button class="btn secondary" data-decide="${h.id}">Decide</button></td></tr>`).join('')}</tbody></table>`;
    table.querySelectorAll('[data-open-job]').forEach((button) => button.onclick = () => App.navigate('job-orders', { id: Number(button.dataset.openJob) }));
    table.querySelectorAll('[data-decide]').forEach((button) => button.onclick = async () => {
      const h = holds.find((row) => String(row.id) === button.dataset.decide);
      let job;
      try { job = await API.get('/job-orders/' + h.job_order_id); }
      catch (e) { UI.toast(e.message || 'Unable to load the job checklist', 'error'); return; }
      const checks = [
        ...((job.qc_stages || 1) <= 1 ? job.qc_checklist_qc?.items || [] : []),
        ...(job.qc_checklist_qa?.items || []),
      ];
      const previous = new Map((h.checklist || []).map((item) => [item.label.toLocaleLowerCase(), item]));
      UI.modal({ title: 'Decide held unit — ' + (h.identifier || '#' + h.id),
        bodyHTML: `<p class="muted">${UI.esc(h.remarks || 'Held for review')}</p><p class="muted">${h.evidence || 0} evidence photo(s). Open the job order for full history.</p>
          <div><label>Decision</label><select data-f="outcome"><option value="pass">Pass — send to Products In</option><option value="rectify">Rectify — return for recheck</option><option value="fail">Fail — reject</option></select></div>
          ${checks.length ? `<div data-hold-checks><p class="muted">Confirm the applicable checklist before passing this unit.</p>${checks.map((item, i) => {
            const answer = previous.get(item.label.toLocaleLowerCase()) || {};
            return `<div data-hold-check="${i}" style="margin:8px 0"><label>${UI.esc(item.label)}${item.required ? ' *' : ''}</label>
              <select data-check-status aria-label="${UI.esc(item.label)} result"><option value="">Choose result</option><option value="pass" ${answer.status === 'pass' ? 'selected' : ''}>Pass</option><option value="issue" ${answer.status === 'issue' ? 'selected' : ''}>Issue</option><option value="na" ${answer.status === 'na' ? 'selected' : ''}>N/A</option></select>
              ${item.measure ? `<input data-check-value aria-label="${UI.esc(item.label)} reading (${UI.esc(item.measure)})" placeholder="Reading (${UI.esc(item.measure)})" value="${UI.esc(answer.value || '')}" maxlength="60" />` : ''}
              <input data-check-note aria-label="${UI.esc(item.label)} note" placeholder="Note (optional)" value="${UI.esc(answer.note || '')}" maxlength="500" /></div>`;
          }).join('')}</div>` : ''}
          <div data-fail hidden><label>Disposition</label><select data-f="disposition"><option value="scrap">Scrap</option><option value="dispose">Dispose</option><option value="recycle">Recycle</option></select></div>
          <div><label>Reason <span class="req">*</span></label><textarea data-f="remarks" rows="3" maxlength="2000"></textarea></div>`,
        confirmText: 'Record decision',
        onOpen: (overlay) => { const outcome = overlay.querySelector('[data-f="outcome"]'); outcome.onchange = () => { overlay.querySelector('[data-fail]').hidden = outcome.value !== 'fail'; if (overlay.querySelector('[data-hold-checks]')) overlay.querySelector('[data-hold-checks]').hidden = outcome.value !== 'pass'; }; },
        onConfirm: async (overlay, showErr) => {
          const value = (name) => overlay.querySelector(`[data-f="${name}"]`).value.trim();
          if (value('remarks').length < 3) { showErr('Give the reason for this decision'); return false; }
          let checklist;
          if (value('outcome') === 'pass') {
            checklist = [...overlay.querySelectorAll('[data-hold-check]')].map((row, i) => {
              const status = row.querySelector('[data-check-status]').value;
              return status ? { label: checks[i].label, ok: status === 'pass', status,
                value: row.querySelector('[data-check-value]')?.value.trim() || undefined,
                note: row.querySelector('[data-check-note]').value.trim() || undefined } : null;
            }).filter(Boolean);
            const missing = checks.filter((item) => item.required && !checklist.some((answer) => answer.label === item.label && answer.status === 'pass'));
            if (missing.length) { showErr('Pass the required checks first: ' + missing.map((item) => item.label).join(', ')); return false; }
            const noReading = checks.filter((item) => item.measure && checklist.some((answer) => answer.label === item.label && answer.status === 'pass' && !answer.value));
            if (noReading.length) { showErr('Record readings for: ' + noReading.map((item) => item.label).join(', ')); return false; }
          }
          await API.post(`/job-orders/${h.job_order_id}/units/${h.id}/hold-decision`, { outcome: value('outcome'), remarks: value('remarks'), disposition: value('outcome') === 'fail' ? value('disposition') : undefined, checklist });
          UI.toast('Hold decision recorded'); await renderHolds();
        },
      });
    });
  }

  async function renderQueue() {
    view.innerHTML = `
      <div class="topbar">
        <h2>QC / QA <span class="muted" style="font-weight:400;font-size:14px">Inspection queue</span></h2>
        <div class="grow"></div>
        ${checklistBtnHTML}
      </div>
      <div class="panel"><div id="qc-table"><div class="empty">Loading…</div></div></div>`;
    wireChecklistBtn();

    const tableEl = view.querySelector('#qc-table');
    let rows;
    try { rows = await API.get('/job-orders'); }
    catch (e) {
      tableEl.innerHTML = `<div class="empty"><strong>Unable to load inspection queue</strong><p>${UI.esc(e.message || 'Please try again.')}</p><button class="btn" id="qc-retry">Retry</button></div>`;
      tableEl.querySelector('#qc-retry').onclick = renderQueue;
      return;
    }
    const need = (rows || []).filter((j) => j.qc_stages > 0 && (j.units_actionable || 0) > 0 && j.status !== 'cancelled');

    if (!need.length) {
      tableEl.innerHTML = UI.emptyState({
        icon: 'check',
        title: 'Nothing waiting for inspection',
        hint: 'Units queue here once production progress is recorded on a job order with QC/QA stages.',
      });
      return;
    }

    tableEl.innerHTML = `
      <table>
        <thead><tr>
          <th>Job order</th><th>Product</th><th>Team</th><th>Stages</th>
          <th class="right">Ready for you</th><th class="right">Back from repair</th>
        </tr></thead>
        <tbody>${need.map((j) => `
          <tr class="clickable" data-open="${j.id}">
            <td><strong>${UI.esc(j.number)}</strong></td>
            <td>${UI.esc(j.product_name)}</td>
            <td class="muted">${UI.esc(j.team_name || '—')}</td>
            <td class="muted">${j.qc_stages}-step</td>
            <td class="right">${j.units_actionable || 0}</td>
            <td class="right${j.units_rework ? ' danger' : ''}">${j.units_rework || 0}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;
    tableEl.querySelectorAll('tr[data-open]').forEach((tr) => tr.onclick = () => inspectModal(tr.dataset.open, renderQueue));
  }

  async function renderFindings() {
    const state = { result: '', q: '', from: '', to: '', offset: 0, limit: 50 };
    let last = { rows: [], total: 0, summary: { pass: 0, fail: 0, hold: 0 } };

    view.innerHTML = `
      <div class="topbar">
        <h2>QC / QA <span class="muted" style="font-weight:400;font-size:14px">Findings &amp; reports</span></h2>
        <div class="grow"></div>
        <div class="search-box search">${UI.icon('search', 16)}<input id="qf-q" placeholder="Search job order, product…" /></div>
        <select id="qf-result" style="width:120px">
          <option value="">All results</option>
          <option value="pass">Pass</option>
          <option value="fail">Fail</option>
          <option value="hold">Hold</option>
        </select>
        <label class="inline-date">From <input type="date" id="qf-from" /></label>
        <label class="inline-date">To <input type="date" id="qf-to" /></label>
        <button class="btn secondary" id="qf-export">${UI.icon('download')} Export</button>
        ${checklistBtnHTML}
      </div>
      <div class="cards" id="qf-cards"></div>
      <div class="panel"><div id="qf-table"></div></div>
      <div class="pager" id="qf-pager"></div>`;
    wireChecklistBtn();

    const cardsEl = view.querySelector('#qf-cards');
    const tableEl = view.querySelector('#qf-table');
    const pagerEl = view.querySelector('#qf-pager');

    async function load() {
      const p = new URLSearchParams();
      if (state.result) p.set('result', state.result);
      if (state.q) p.set('q', state.q);
      if (state.from) p.set('from', state.from);
      if (state.to) p.set('to', state.to + ' 23:59:59');
      p.set('limit', state.limit);
      p.set('offset', state.offset);
      tableEl.innerHTML = '<div class="empty">Loading…</div>';
      last = await API.get('/qc/records?' + p.toString());
      render();
    }

    function render() {
      const { rows, total, summary } = last;
      const inspected = (summary.pass || 0) + (summary.fail || 0) + (summary.hold || 0);
      const passRate = inspected ? Math.round((summary.pass / inspected) * 100) : null;
      cardsEl.innerHTML = `
        ${statCard('good', 'check', 'Passed', summary.pass || 0)}
        ${statCard('alert', 'alert', 'Failed', summary.fail || 0)}
        ${statCard('alert', 'alert', 'Held', summary.hold || 0)}
        ${statCard('', 'sheet', 'Pass / recorded outcome', passRate == null ? '—' : passRate + '%')}`;

      if (!rows.length) {
        tableEl.innerHTML = UI.emptyState({
          icon: 'check', title: 'No findings yet',
          hint: 'Every inspection pass or fail, across every job order, shows up here.',
        });
        pagerEl.innerHTML = '';
        return;
      }
      tableEl.innerHTML = `
        <table>
          <thead><tr>
            <th>When</th><th>Job order</th><th>Product</th><th>Unit / batch</th><th>Stage</th>
            <th>Result</th><th>Disposition</th><th>Inspector</th><th>Remarks</th>
          </tr></thead>
          <tbody>${rows.map((r) => `
            <tr class="clickable" data-open="${r.id}">
              <td class="muted" style="white-space:nowrap">${UI.fmtDate(r.created_at)}</td>
              <td><strong>${UI.esc(r.job_order_number)}</strong></td>
              <td>${UI.esc(r.product_name)}</td>
              <td class="muted">${UI.esc(r.unit_identifier || r.batch_number || '—')}</td>
              <td class="muted">${r.stage}</td>
              <td>${r.result === 'pass' ? '<span class="badge-pill ok">pass</span>' : `<span class="badge-pill low">${UI.esc(r.result)}</span>`}</td>
              <td class="muted">${UI.esc(r.disposition || '—')}</td>
              <td class="muted">${UI.esc(r.inspector_name || '—')}</td>
              <td class="muted">${UI.esc(r.remarks || '—')}</td>
            </tr>`).join('')}
          </tbody>
        </table>`;
      tableEl.querySelectorAll('tr[data-open]').forEach((tr) =>
        tr.onclick = () => findingModal(rows.find((r) => String(r.id) === tr.dataset.open)));
      renderPager(total);
    }

    function renderPager(total) {
      const start = total ? state.offset + 1 : 0;
      const end = Math.min(state.offset + state.limit, total);
      const canPrev = state.offset > 0;
      const canNext = state.offset + state.limit < total;
      pagerEl.innerHTML = `
        <span class="muted">${start}–${end} of ${total}</span>
        <button class="btn secondary small" id="qf-prev" ${canPrev ? '' : 'disabled'}>Prev</button>
        <button class="btn secondary small" id="qf-next" ${canNext ? '' : 'disabled'}>Next</button>`;
      const prev = pagerEl.querySelector('#qf-prev');
      const next = pagerEl.querySelector('#qf-next');
      if (prev) prev.onclick = () => { state.offset = Math.max(0, state.offset - state.limit); load(); };
      if (next) next.onclick = () => { state.offset += state.limit; load(); };
    }

    function findingModal(r) {
      if (!r) return;
      const checklist = Array.isArray(r.checklist) ? r.checklist : [];
      UI.modal({
        title: `${r.job_order_number} — ${r.result === 'pass' ? 'Pass' : 'Fail'}`,
        size: 'lg',
        cancelText: 'Close',
        bodyHTML: `
          <div class="kv" style="margin-bottom:12px">
            <div><span class="muted">Product</span><div>${UI.esc(r.product_name)}</div></div>
            <div><span class="muted">Unit / batch</span><div>${UI.esc(r.unit_identifier || r.batch_number || '—')}</div></div>
            <div><span class="muted">Stage</span><div>${r.stage}</div></div>
            <div><span class="muted">Inspector</span><div>${UI.esc(r.inspector_name || '—')}</div></div>
            <div><span class="muted">When</span><div>${UI.fmtDate(r.created_at)}</div></div>
            ${r.disposition ? `<div><span class="muted">Disposition</span><div>${UI.esc(r.disposition)}</div></div>` : ''}
          </div>
          ${r.remarks ? `<p><span class="muted">Remarks</span><br>${UI.esc(r.remarks)}</p>` : ''}
          ${checklist.length ? `
            <h4 style="margin:14px 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted)">Checklist</h4>
            <ul class="kv">${checklist.map((c) => `
              <li><span>${c.ok ? '✓' : '✗'} ${UI.esc(c.label)}</span>${c.note ? `<div class="muted" style="font-size:11px">${UI.esc(c.note)}</div>` : ''}</li>`).join('')}
            </ul>` : '<p class="muted">No checklist recorded for this pass.</p>'}`,
      });
    }

    function exportCsv() {
      if (!last.rows.length) { UI.toast('Nothing to export', 'error'); return; }
      UI.downloadCsv(
        'qc-findings.csv',
        ['When', 'Job order', 'Product', 'Unit/Batch', 'Stage', 'Result', 'Disposition', 'Inspector', 'Remarks'],
        last.rows.map((r) => [
          r.created_at, r.job_order_number, r.product_name, r.unit_identifier || r.batch_number || '',
          r.stage, r.result, r.disposition || '', r.inspector_name || '', r.remarks || '',
        ])
      );
    }

    let t;
    view.querySelector('#qf-q').addEventListener('input', (e) => {
      clearTimeout(t); state.q = e.target.value.trim(); state.offset = 0; t = setTimeout(load, 250);
    });
    view.querySelector('#qf-result').addEventListener('change', (e) => { state.result = e.target.value; state.offset = 0; load(); });
    view.querySelector('#qf-from').addEventListener('change', (e) => { state.from = e.target.value; state.offset = 0; load(); });
    view.querySelector('#qf-to').addEventListener('change', (e) => { state.to = e.target.value; state.offset = 0; load(); });
    view.querySelector('#qf-export').addEventListener('click', exportCsv);

    await load();
  }
});
