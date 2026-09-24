/* Production → Batches / Lots: production batches / lots. A non-serialized job
   order records one batch per progress entry; serialized job orders can label a batch
   on the progress form. Each batch has its own number, QC/QA sign-off and dossier.
   filter.id deep-links straight into one batch. */
App.register('production-batches', async (view, filter) => {
  const canWrite = App.hasPermission('inventory.adjust');
  const canConfigQc = App.hasPermission('qc.configure');
  const STATUS = ['', 'open', 'released', 'closed'];
  const state = { status: '' };
  let rows = [];

  view.innerHTML = `
    <div class="topbar">
      <h2>Production Batches</h2>
      <div class="grow"></div>
      <select id="pb-status" style="width:150px">
        ${STATUS.map((s) => `<option value="${s}">${s ? s[0].toUpperCase() + s.slice(1) : 'All statuses'}</option>`).join('')}
      </select>
    </div>
    <div class="panel"><div id="pb-table"></div></div>`;

  const tableEl = view.querySelector('#pb-table');
  const badge = (s) => `<span class="badge-pill status-${s === 'closed' ? 'completed' : s === 'released' ? 'confirmed' : 'open'}">${s}</span>`;

  async function load() {
    tableEl.innerHTML = '<div class="empty">Loading…</div>';
    const p = new URLSearchParams();
    if (state.status) p.set('status', state.status);
    rows = await API.get('/production/batches?' + p.toString());
    render();
  }

  function render() {
    if (!rows.length) {
      tableEl.innerHTML = UI.emptyState({
        icon: 'adjust',
        title: state.status ? `No ${state.status} batches` : 'No batches yet',
        hint: 'Batches are created as job orders record production progress.',
      });
      return;
    }
    tableEl.innerHTML = `
      <table>
        <thead><tr>
          <th>Batch</th><th>Product</th><th>Job order</th><th class="right">Qty</th>
          <th class="right">Units</th><th>Status</th><th>Step</th><th>Created</th>
        </tr></thead>
        <tbody>${rows.map((b) => {
          const remaining = b.qty - (b.received_qty || 0);
          const step = ProductionSteps.batchStep(b, remaining, b.job_order_qc_stages);
          return `
          <tr class="clickable" data-open="${b.id}">
            <td><strong>${UI.esc(b.number)}</strong>${b.identifier ? `<div class="muted mono" style="font-size:11px">${UI.esc(b.identifier)}</div>` : ''}</td>
            <td>${UI.esc(b.product_name || '—')}</td>
            <td>${UI.esc(b.job_order_number || '—')}</td>
            <td class="right">${b.qty}</td>
            <td class="right">${b.unit_count || 0}</td>
            <td>${badge(b.status)}</td>
            <td><span class="badge-pill ${step.cls}">${step.label}</span></td>
            <td class="muted">${UI.esc((b.created_at || '').slice(0, 10))}</td>
          </tr>`;
        }).join('')}
        </tbody>
      </table>`;
    tableEl.querySelectorAll('tr[data-open]').forEach((tr) => tr.onclick = () => detailModal(tr.dataset.open));
  }

  async function detailModal(id) {
    let data = await API.get('/production/batches/' + id);
    let checklists = [];
    try { checklists = await API.get('/qc/checklists'); } catch { checklists = []; }

    const m = UI.modal({ title: `Batch ${data.number}`, size: 'lg', cancelText: 'Close', bodyHTML: '<div id="pb-body"></div>' });
    const host = () => m.overlay ? m.overlay.querySelector('#pb-body') : document.querySelector('#pb-body');

    function draw() {
      const el = host();
      if (!el) return;
      const units = data.units || [];
      const qc = data.qc || [];
      const remaining = data.qty - (data.received_qty || 0);
      const step = ProductionSteps.batchStep(data, remaining, data.job_order_qc_stages);
      el.innerHTML = `
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:6px">
          ${badge(data.status)}
          <span class="badge-pill ${step.cls}">${step.label}</span>
          <strong>${UI.esc(data.product_name || '—')}</strong>
          ${data.job_order_number ? `<span class="muted">from ${UI.esc(data.job_order_number)}</span>` : ''}
        </div>
        <div class="kv" style="margin:10px 0">
          <div><span class="muted">Batch no.</span><div class="mono">${UI.esc(data.number)}</div></div>
          <div><span class="muted">Identifier / lot</span><div class="mono">${UI.esc(data.identifier || '—')}</div></div>
          <div><span class="muted">Quantity</span><div>${data.qty}</div></div>
          <div><span class="muted">Serialized units</span><div>${units.length}</div></div>
          <div><span class="muted">Created by</span><div>${UI.esc(data.created_by_name || '—')} <span class="muted">${UI.esc((data.created_at || '').slice(0, 16).replace('T', ' '))}</span></div></div>
        </div>
        ${data.notes ? `<p class="muted" style="white-space:pre-wrap">${UI.esc(data.notes)}</p>` : ''}

        <div style="display:flex;gap:8px;margin:8px 0;flex-wrap:wrap">
          <button type="button" class="btn secondary small" id="pb-record">Full record →</button>
          ${canWrite ? `<button type="button" class="btn secondary small" id="pb-print">Print QR labels</button>` : ''}
        </div>

        ${canWrite ? `
          <div class="field-row" style="align-items:flex-end;gap:8px;margin:8px 0">
            <div><label class="muted" style="font-size:12px">Lot / identifier</label><input id="pb-ident" value="${UI.esc(data.identifier || '')}" /></div>
            <div><label class="muted" style="font-size:12px">Status</label>
              <select id="pb-st">${['open', 'released', 'closed'].map((s) => `<option value="${s}" ${s === data.status ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
            <button type="button" class="btn secondary small" id="pb-save">Save</button>
          </div>` : ''}

        <h4 style="margin:14px 0 4px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted)">QC/QA sign-off</h4>
        ${qc.length ? `<table>
          <thead><tr><th>When</th><th>Result</th><th>Inspector</th><th>Remarks / issues</th></tr></thead>
          <tbody>${qc.map((q) => {
            const issues = (Array.isArray(q.checklist) ? q.checklist : []).filter((c) => c.ok === false).map((c) => c.label).join(', ');
            return `<tr>
              <td class="muted" style="white-space:nowrap">${UI.esc((q.created_at || '').slice(0, 16).replace('T', ' '))}</td>
              <td>${q.result === 'pass' ? '<span class="badge-pill ok">pass</span>' : `<span class="badge-pill low">fail</span>${q.disposition ? ` <span class="muted" style="font-size:11px">${UI.esc(q.disposition)}</span>` : ''}`}</td>
              <td>${UI.esc(q.inspector_name || '—')}</td>
              <td>${UI.esc(q.remarks || '')}${issues ? `<div class="muted" style="font-size:11px">✗ ${UI.esc(issues)}</div>` : ''}</td>
            </tr>`;
          }).join('')}</tbody></table>` : '<p class="muted">No batch inspection recorded yet.</p>'}
        ${canWrite ? `<button type="button" class="btn secondary small" id="pb-inspect" style="margin-top:8px">Record batch inspection</button>` : ''}

        ${units.length ? `
          <h4 style="margin:16px 0 4px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted)">Units in this batch</h4>
          <table><thead><tr><th>Unit</th><th>Status</th><th>Identifier</th></tr></thead>
          <tbody>${units.map((u) => `<tr><td>#${u.id}</td><td>${u.status}</td><td class="mono">${UI.esc(u.identifier || '—')}</td></tr>`).join('')}</tbody></table>` : ''}`;

      el.querySelector('#pb-record').onclick = () => App.navigate('production-record', { batch: id });

      const pp = el.querySelector('#pb-print');
      if (pp) pp.onclick = () => printBatchLabels(data);

      const sb = el.querySelector('#pb-save');
      if (sb) sb.onclick = async () => {
        try {
          data = await API.put('/production/batches/' + id, {
            identifier: el.querySelector('#pb-ident').value.trim() || null,
            status: el.querySelector('#pb-st').value,
          });
          UI.toast('Saved'); draw(); load();
        } catch (e) { UI.toast(e.message, 'error'); }
      };
      const ib = el.querySelector('#pb-inspect');
      if (ib) ib.onclick = () => inspectModal();
    }

    function inspectModal() {
      // A non-serialized batch gets one sign-off pass, not a QC-then-QA sequence — combine
      // the default QA and QC checklists (server resolves the product's own the same way).
      const defs = [1, 2].map((stage) => checklists.find((c) => c.is_default && Number(c.stage) === stage)).filter(Boolean);
      const items = defs.flatMap((d) => d.items || []);
      UI.modal({
        title: `Batch inspection — ${data.number}`,
        bodyHTML: `
          <div class="field-row">
            <label class="check"><input type="radio" name="pbr" value="pass" checked /> Pass</label>
            <label class="check"><input type="radio" name="pbr" value="fail" /> Fail</label>
          </div>
          <div data-f="dispwrap" style="display:none"><label>On fail</label>
            <select data-f="disp"><option value="scrap">Scrap</option><option value="dispose">Dispose</option><option value="recycle">Recycle</option><option value="repair">Repair</option></select></div>
          ${items.length ? `<div style="margin:8px 0">
            <label style="font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted)">Checklist${defs.length ? ` — ${defs.map((d) => UI.esc(d.name)).join(' + ')}` : ''}</label>
            <div style="display:flex;flex-direction:column;gap:6px;margin-top:4px">
              ${items.map((it, i) => `<label class="check"><input type="checkbox" class="pb-chk" data-label="${UI.esc(it.label)}" /> ${UI.esc(it.label)}${it.required ? ' <span style="color:var(--danger,#dc2626)">*</span>' : ''}</label>`).join('')}
            </div></div>` : ''}
          <div><label>Remarks</label><input data-f="rem" placeholder="Notes / reason if failing…" /></div>`,
        confirmText: 'Record',
        onOpen: (ov) => {
          ov.querySelectorAll('input[name="pbr"]').forEach((r) => r.onchange = () => {
            ov.querySelector('[data-f="dispwrap"]').style.display = ov.querySelector('input[name="pbr"]:checked').value === 'fail' ? '' : 'none';
          });
        },
        onConfirm: async (ov, showErr) => {
          const result = ov.querySelector('input[name="pbr"]:checked').value;
          const checklist = [...ov.querySelectorAll('.pb-chk')].map((b) => ({ label: b.dataset.label, ok: b.checked }));
          const body = { result, remarks: ov.querySelector('[data-f="rem"]').value.trim() || null };
          if (result === 'fail') body.disposition = ov.querySelector('[data-f="disp"]').value;
          if (checklist.length) body.checklist = checklist;
          try {
            data = await API.post('/production/batches/' + id + '/inspect', body);
            UI.toast('Recorded'); draw(); load();
          } catch (e) { showErr(e.message); return false; }
        },
      });
    }

    draw();
  }

  async function printBatchLabels(batch) {
    if (!window.qrcode) {
      await new Promise((r) => { const s = document.createElement('script'); s.src = '/mobile/vendor/qrcode.js'; s.onload = r; s.onerror = r; document.head.appendChild(s); });
    }
    if (!window.qrcode || !window.renderTemplate) { UI.toast('Label renderer failed to load', 'error'); return; }
    const tpls = await API.get('/production/label-templates').catch(() => ({}));
    const body = tpls.batch || '';
    UI.modal({
      title: 'Print batch labels — ' + batch.number,
      bodyHTML: `<div class="field-row"><div><label>How many labels</label><input data-f="n" type="number" min="1" value="1" /></div></div>`,
      confirmText: 'Open print sheet',
      onConfirm: (ov, showErr) => {
        const n = Math.max(1, parseInt(ov.querySelector('[data-f="n"]').value, 10) || 1);
        const qr = window.qrcode(0, 'M'); qr.addData(batch.number); qr.make();
        const ctx = {
          product: { name: batch.product_name || '—', variant: '' },
          batch: { number: batch.number, identifier: batch.identifier || '', qty: batch.qty },
          qr_src: qr.createDataURL(6, 0), date: new Date().toISOString().slice(0, 10),
        };
        const cell = `<div class="lbl">${window.renderTemplate(body, ctx)}</div>`;
        const w = window.open('', '_blank');
        if (!w) { showErr('Allow pop-ups to open the print sheet'); return false; }
        w.document.write(`<!doctype html><html><head><title>${UI.esc(batch.number)} labels</title><style>
          *{box-sizing:border-box}body{margin:0;font-family:system-ui,Arial,sans-serif}
          .sheet{display:flex;flex-wrap:wrap;gap:4mm;padding:6mm}
          .lbl{width:52mm;height:30mm;border:1px solid #ddd;border-radius:2mm;display:flex;gap:2mm;padding:2mm;align-items:center;page-break-inside:avoid;overflow:hidden}
          .lbl-qr{width:26mm;height:26mm;flex:none}.lbl-txt{overflow:hidden;font-size:9pt;line-height:1.2}
          .lbl-name{font-weight:700}.lbl-variant{font-size:8.5pt}.lbl-code{font-family:ui-monospace,monospace;font-size:8pt;word-break:break-all}.lbl-sub{color:#888;font-size:7.5pt}
        </style></head><body><div class="sheet">${Array(n).fill(cell).join('')}</div><script>window.onload=function(){window.print()}<\/script></body></html>`);
        w.document.close();
        UI.toast(`${n} label${n === 1 ? '' : 's'} ready`);
      },
    });
  }

  view.querySelector('#pb-status').addEventListener('change', (e) => { state.status = e.target.value; load(); });
  await load();
  if (filter && filter.id) detailModal(filter.id);
  if (canConfigQc) { /* checklist library managed from Finished Products */ }
});
