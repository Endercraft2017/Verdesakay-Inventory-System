/* Production → QA / QC: everything QA/QC-related lives here.
   - Inspection queue: every unit waiting on a pass, or back from repair, across every
     open job order (filter.tab omitted or 'queue'). Row click opens a lightweight,
     QA/QC-only inspect modal in place (inspectModal below) — deliberately not the full
     Job Orders detail modal (job-orders.js trackModal), which carries components,
     production progress, batches and other job-management chrome this screen doesn't need.
   - Findings & reports: the full pass/fail history across every job order, filterable
     and exportable (filter.tab = 'findings'), backed by GET /qc/records.
   - Manage Checklists (qc.configure): the shared named-checklist library
     (public/js/lib/qc-checklists.js) — also reachable from Finished Products, where a
     checklist gets attached to a product. */
App.register('production-qc', async (view, filter) => {
  const canConfigQc = App.hasPermission('qc.configure');
  const canInspect = App.hasPermission('inventory.adjust');
  const tab = filter && filter.tab === 'findings' ? 'findings' : 'queue';
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

  if (tab === 'findings') { await renderFindings(); } else { await renderQueue(); }

  async function renderQueue() {
    view.innerHTML = `
      <div class="topbar">
        <h2>QA / QC <span class="muted" style="font-weight:400;font-size:14px">Inspection queue</span></h2>
        <div class="grow"></div>
        ${checklistBtnHTML}
      </div>
      <div class="panel"><div id="qc-table"><div class="empty">Loading…</div></div></div>`;
    wireChecklistBtn();

    const tableEl = view.querySelector('#qc-table');
    const rows = await API.get('/job-orders').catch(() => []);
    const need = (rows || []).filter((j) => j.qc_stages > 0 && ((j.units_pending || 0) > 0 || (j.units_rework || 0) > 0) && j.status !== 'cancelled');

    if (!need.length) {
      tableEl.innerHTML = UI.emptyState({
        icon: 'check',
        title: 'Nothing waiting for inspection',
        hint: 'Units queue here once production progress is recorded on a job order with QA/QC stages.',
      });
      return;
    }

    tableEl.innerHTML = `
      <table>
        <thead><tr>
          <th>Job order</th><th>Product</th><th>Team</th><th>Stages</th>
          <th class="right">To inspect</th><th class="right">Back from repair</th>
        </tr></thead>
        <tbody>${need.map((j) => `
          <tr class="clickable" data-open="${j.id}">
            <td><strong>${UI.esc(j.number)}</strong></td>
            <td>${UI.esc(j.product_name)}</td>
            <td class="muted">${UI.esc(j.team_name || '—')}</td>
            <td class="muted">${j.qc_stages}-step</td>
            <td class="right">${j.units_pending || 0}</td>
            <td class="right${j.units_rework ? ' danger' : ''}">${j.units_rework || 0}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;
    tableEl.querySelectorAll('tr[data-open]').forEach((tr) => tr.onclick = () => inspectModal(tr.dataset.open, renderQueue));
  }

  // Simple, QA/QC-only inspect dialog for one job order's queue — opened in place
  // (no navigating away to the full Job Orders detail, which carries components,
  // production progress, batches and other job-management chrome this screen doesn't need).
  async function inspectModal(jobOrderId, onDone) {
    let jo = await API.get('/job-orders/' + jobOrderId);
    let units = [];
    let qcLog = [];
    let repairs = [];

    const m = UI.modal({ title: `Inspect — ${jo.number}`, size: 'lg', cancelText: 'Close', bodyHTML: '<div id="qi-body"></div>' });
    const host = () => m.overlay ? m.overlay.querySelector('#qi-body') : null;

    async function refresh() {
      try { units = await API.get('/job-orders/' + jobOrderId + '/units'); } catch { units = []; }
      try { qcLog = await API.get('/job-orders/' + jobOrderId + '/qc'); } catch { qcLog = []; }
      try { repairs = await API.get('/production/repairs?job_order=' + jobOrderId); } catch { repairs = []; }
    }

    function draw() {
      const el = host();
      if (!el) return;
      const pending = units.filter((u) => u.status === 'pending');
      const rework = units.filter((u) => u.status === 'rework');
      const queue = pending.concat(rework);
      const reworkOpen = (uid) => repairs.some((r) => r.unit_id === uid && r.status === 'requested');
      const totalStages = Math.max(1, jo.qc_stages || 1);
      const firstP = queue.some((u) => u.stage + 1 === 1);
      const finalP = queue.some((u) => u.stage + 1 >= totalStages);
      const qcCl = [
        ...(firstP && jo.qc_checklist_qa ? jo.qc_checklist_qa.items.map((it) => ({ ...it, _from: 'QA' })) : []),
        ...(finalP && jo.qc_checklist_qc ? jo.qc_checklist_qc.items.map((it) => ({ ...it, _from: 'QC' })) : []),
      ];
      const qcClNames = [firstP && jo.qc_checklist_qa ? jo.qc_checklist_qa.name : null,
        finalP && jo.qc_checklist_qc ? jo.qc_checklist_qc.name : null].filter(Boolean);
      const DISPOSITIONS = ['scrap', 'dispose', 'recycle', 'repair'];

      el.innerHTML = `
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
          <strong>${UI.esc(jo.product_name)}</strong>
          <span class="muted">${jo.qc_stages}-step inspection</span>
          ${jo.team_name ? `<span class="muted">· ${UI.esc(jo.team_name)}</span>` : ''}
        </div>
        ${queue.length ? `
          <table>
            <thead><tr>
              <th style="width:28px"><input type="checkbox" id="qi-chk-all" /></th>
              <th>Unit</th><th>Stage</th><th>Identifier</th>
            </tr></thead>
            <tbody>${queue.map((u) => {
              const blocked = u.status === 'rework' && reworkOpen(u.id);
              return `<tr>
                <td><input type="checkbox" class="qi-chk" value="${u.id}" ${blocked ? 'disabled title="Parts request still open"' : ''} /></td>
                <td>#${u.id}${u.status === 'rework' ? ' <span class="badge-pill confirmed">repair</span>' : ''}</td>
                <td>${u.stage} / ${jo.qc_stages}</td>
                <td class="mono">${UI.esc(u.identifier || '—')}</td>
              </tr>`;
            }).join('')}</tbody>
          </table>
          ${canInspect ? `
            ${qcCl.length ? `
              <div style="margin-top:10px">
                <label style="font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted)">QA/QC checklist${qcClNames.length ? ` — ${qcClNames.map(UI.esc).join(' + ')}` : ''}</label>
                <div style="display:flex;flex-direction:column;gap:6px;margin-top:4px">
                  ${qcCl.map((it, i) => `
                    <label class="check"><input type="checkbox" class="qi-chk-item" data-i="${i}" data-label="${UI.esc(it.label)}" />
                      ${UI.esc(it.label)}${it.required ? ' <span style="color:var(--danger,#dc2626)">*</span>' : ''}
                      ${qcClNames.length > 1 ? `<span class="muted" style="font-size:11px">(${it._from})</span>` : ''}</label>`).join('')}
                </div>
              </div>` : ''}
            <div class="field-row" style="margin-top:8px">
              <div><label>Identifier (optional, applies to passed units)</label><input id="qi-ident" placeholder="e.g. chassis / serial no." /></div>
              <div><label>Remarks</label><input id="qi-remarks" placeholder="Notes / reason if failing…" /></div>
              <div><label>On fail</label>
                <select id="qi-disp">${DISPOSITIONS.map((d) => `<option value="${d}">${d[0].toUpperCase() + d.slice(1)}</option>`).join('')}</select></div>
            </div>
            <div style="display:flex;gap:8px;margin-top:8px">
              <button type="button" class="btn" id="qi-pass">Pass selected</button>
              <button type="button" class="btn secondary danger" id="qi-fail">Fail selected</button>
            </div>
            <p class="muted" style="font-size:11px;margin:6px 0 0">Fail → <b>repair</b> sends the unit to rework; it can only be re-inspected once its parts requests are settled.</p>` : ''}`
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

      const chkAll = el.querySelector('#qi-chk-all');
      if (chkAll) chkAll.onclick = () => el.querySelectorAll('.qi-chk:not(:disabled)').forEach((c) => { c.checked = chkAll.checked; });

      const inspect = (result) => {
        const unit_ids = [...el.querySelectorAll('.qi-chk:checked')].map((c) => Number(c.value));
        if (!unit_ids.length) { UI.toast('Select one or more units', 'error'); return; }
        const identifier = (el.querySelector('#qi-ident').value || '').trim() || undefined;
        const remarks = (el.querySelector('#qi-remarks').value || '').trim() || undefined;
        const disposition = result === 'fail' ? (el.querySelector('#qi-disp') || {}).value : undefined;
        if (result === 'fail' && !remarks) { UI.toast('Add a remark when failing units', 'error'); return; }

        let checklist;
        const boxes = [...el.querySelectorAll('.qi-chk-item')];
        if (boxes.length) {
          checklist = boxes.map((b) => ({ label: b.dataset.label, ok: b.checked }));
          if (result === 'pass') {
            const missing = boxes.filter((b, i) => qcCl[i] && qcCl[i].required && !b.checked)
              .map((b) => b.dataset.label);
            if (missing.length) { UI.toast('Tick the required checks first: ' + missing.join(', '), 'error'); return; }
          }
        }
        API.post('/job-orders/' + jobOrderId + '/units/inspect', { unit_ids, result, identifier, remarks, checklist, disposition })
          .then(async (r) => {
            jo = r.job_order; await refresh();
            UI.toast(result === 'pass' ? 'Units passed' : disposition === 'repair' ? 'Sent to repair' : 'Units failed');
            draw();
            if (onDone) onDone();
          })
          .catch((e) => UI.toast(e.message, 'error'));
      };
      const pb = el.querySelector('#qi-pass'); if (pb) pb.onclick = () => inspect('pass');
      const fb = el.querySelector('#qi-fail'); if (fb) fb.onclick = () => inspect('fail');
    }

    await refresh();
    draw();
  }

  async function renderFindings() {
    const state = { result: '', q: '', from: '', to: '', offset: 0, limit: 50 };
    let last = { rows: [], total: 0, summary: { pass: 0, fail: 0 } };

    view.innerHTML = `
      <div class="topbar">
        <h2>QA / QC <span class="muted" style="font-weight:400;font-size:14px">Findings &amp; reports</span></h2>
        <div class="grow"></div>
        <div class="search-box search">${UI.icon('search', 16)}<input id="qf-q" placeholder="Search job order, product…" /></div>
        <select id="qf-result" style="width:120px">
          <option value="">All results</option>
          <option value="pass">Pass</option>
          <option value="fail">Fail</option>
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
      const inspected = (summary.pass || 0) + (summary.fail || 0);
      const passRate = inspected ? Math.round((summary.pass / inspected) * 100) : null;
      cardsEl.innerHTML = `
        ${statCard('good', 'check', 'Passed', summary.pass || 0)}
        ${statCard('alert', 'alert', 'Failed', summary.fail || 0)}
        ${statCard('', 'sheet', 'Pass rate', passRate == null ? '—' : passRate + '%')}`;

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
              <td>${r.result === 'pass' ? '<span class="badge-pill ok">pass</span>' : '<span class="badge-pill low">fail</span>'}</td>
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
