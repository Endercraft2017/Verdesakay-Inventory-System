/* Admin → Activity: the app-wide action history (audit.view permission). */
App.register('activity', async (view) => {
  if (!App.hasPermission('audit.view')) {
    view.innerHTML = '<div class="empty">You do not have access to this area.</div>';
    return;
  }

  const state = { user_id: '', entity: '', action: '', from: '', to: '', q: '', offset: 0, limit: 100 };
  let last = { rows: [], total: 0 };

  view.innerHTML = `
    <div class="topbar">
      <h2>Activity Log</h2>
      <div class="grow"></div>
      <div class="search-box search">${UI.icon('search', 16)}<input id="al-q" placeholder="Search summary, path, user…" /></div>
      <select id="al-user" style="width:150px"><option value="">All users</option></select>
      <select id="al-entity" style="width:140px"><option value="">All modules</option></select>
      <select id="al-action" style="width:150px"><option value="">All actions</option></select>
      <label class="inline-date">From <input type="date" id="al-from" /></label>
      <label class="inline-date">To <input type="date" id="al-to" /></label>
      <button class="btn secondary" id="al-prune">Prune…</button>
    </div>
    <div class="panel"><div id="al-table"></div></div>
    <div class="pager" id="al-pager"></div>`;

  const tableEl = view.querySelector('#al-table');
  const pagerEl = view.querySelector('#al-pager');

  try {
    const opts = await API.get('/activity/options');
    const uSel = view.querySelector('#al-user');
    uSel.innerHTML = '<option value="">All users</option>' +
      opts.users.map((u) => `<option value="${u.id}">${UI.esc(u.full_name)}</option>`).join('');
    view.querySelector('#al-entity').innerHTML = '<option value="">All modules</option>' +
      opts.entities.map((e) => `<option value="${UI.esc(e)}">${UI.esc(e)}</option>`).join('');
    view.querySelector('#al-action').innerHTML = '<option value="">All actions</option>' +
      opts.actions.map((a) => `<option value="${UI.esc(a)}">${UI.esc(a)}</option>`).join('');
  } catch { /* filters stay minimal */ }

  async function load() {
    const p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    if (state.user_id) p.set('user_id', state.user_id);
    if (state.entity) p.set('entity', state.entity);
    if (state.action) p.set('action', state.action);
    if (state.from) p.set('from', state.from);
    if (state.to) p.set('to', state.to + ' 23:59:59');
    p.set('limit', state.limit);
    p.set('offset', state.offset);
    tableEl.innerHTML = '<div class="empty">Loading…</div>';
    last = await API.get('/activity?' + p.toString());
    render();
  }

  function render() {
    const { rows, total } = last;
    if (!rows.length) {
      tableEl.innerHTML = UI.emptyState({ icon: 'history', title: 'No activity', hint: 'Actions across the app will be recorded here.' });
      pagerEl.innerHTML = '';
      return;
    }
    tableEl.innerHTML = `
      <table>
        <thead><tr>
          <th>When</th><th>User</th><th>Action</th><th>Module</th>
          <th>Record</th><th class="right">Result</th><th>IP</th>
        </tr></thead>
        <tbody>${rows.map((r, i) => `
          <tr class="clickable" data-row="${i}">
            <td>${UI.fmtDate(r.created_at)}</td>
            <td>${UI.esc(r.user_name || '—')}</td>
            <td><strong>${UI.esc(r.action || r.method)}</strong><div class="muted">${UI.esc(r.summary || '')}</div></td>
            <td>${UI.esc(r.entity || '—')}</td>
            <td class="mono">${r.entity_id ? '#' + UI.esc(r.entity_id) : '—'}</td>
            <td class="right"><span class="badge-pill ${r.status_code >= 400 ? 'low' : 'ok'}">${r.status_code ?? '—'}</span></td>
            <td class="mono muted">${UI.esc(r.ip || '—')}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;
    tableEl.querySelectorAll('tr[data-row]').forEach((tr) =>
      tr.onclick = () => detailModal(rows[Number(tr.dataset.row)]));
    renderPager(total);
  }

  function renderPager(total) {
    const start = total ? state.offset + 1 : 0;
    const end = Math.min(state.offset + state.limit, total);
    pagerEl.innerHTML = `
      <span class="muted">${start}–${end} of ${total}</span>
      <button class="btn secondary small" id="al-prev" ${state.offset > 0 ? '' : 'disabled'}>Prev</button>
      <button class="btn secondary small" id="al-next" ${state.offset + state.limit < total ? '' : 'disabled'}>Next</button>`;
    const prev = pagerEl.querySelector('#al-prev');
    const next = pagerEl.querySelector('#al-next');
    if (prev) prev.onclick = () => { state.offset = Math.max(0, state.offset - state.limit); load(); };
    if (next) next.onclick = () => { state.offset += state.limit; load(); };
  }

  function detailModal(r) {
    let metaBlock = '';
    if (r.meta) {
      let pretty = r.meta;
      try { pretty = JSON.stringify(JSON.parse(r.meta), null, 2); } catch { /* raw */ }
      metaBlock = `<h4>Payload (redacted)</h4><pre class="mono code-block">${UI.esc(pretty)}</pre>`;
    }
    UI.modal({
      title: 'Activity detail',
      bodyHTML: `
        <div class="kv">
          <div><span class="muted">When</span><div>${UI.fmtDate(r.created_at)}</div></div>
          <div><span class="muted">User</span><div>${UI.esc(r.user_name || '—')}</div></div>
          <div><span class="muted">Action</span><div>${UI.esc(r.action || '—')}</div></div>
          <div><span class="muted">Module</span><div>${UI.esc(r.entity || '—')}</div></div>
          <div><span class="muted">Result</span><div>${r.status_code ?? '—'}</div></div>
          <div><span class="muted">IP</span><div class="mono">${UI.esc(r.ip || '—')}</div></div>
        </div>
        <p class="mono muted" style="margin:12px 0 0;word-break:break-all">${UI.esc(r.method)} ${UI.esc(r.path)}</p>
        ${metaBlock}`,
      cancelText: 'Close',
    });
  }

  function prune() {
    UI.modal({
      title: 'Prune activity log',
      bodyHTML: `
        <p class="muted" style="margin-top:0">The log is kept for about a month automatically — use this only to clear entries sooner.</p>
        <label>Older than (days)</label>
        <input data-f="days" type="number" min="1" value="30" />`,
      confirmText: 'Delete entries',
      onConfirm: async (overlay, showErr) => {
        const days = parseInt(overlay.querySelector('[data-f="days"]').value, 10);
        if (!days || days < 1) { showErr('Enter a positive number of days'); return false; }
        const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
        const r = await API.del('/activity?before=' + cutoff);
        UI.toast(`Deleted ${r.deleted} entr${r.deleted === 1 ? 'y' : 'ies'}`);
        state.offset = 0;
        load();
      },
    });
  }

  let t;
  view.querySelector('#al-q').addEventListener('input', (e) => {
    clearTimeout(t); state.q = e.target.value.trim(); state.offset = 0; t = setTimeout(load, 250);
  });
  view.querySelector('#al-user').addEventListener('change', (e) => { state.user_id = e.target.value; state.offset = 0; load(); });
  view.querySelector('#al-entity').addEventListener('change', (e) => { state.entity = e.target.value; state.offset = 0; load(); });
  view.querySelector('#al-action').addEventListener('change', (e) => { state.action = e.target.value; state.offset = 0; load(); });
  view.querySelector('#al-from').addEventListener('change', (e) => { state.from = e.target.value; state.offset = 0; load(); });
  view.querySelector('#al-to').addEventListener('change', (e) => { state.to = e.target.value; state.offset = 0; load(); });
  view.querySelector('#al-prune').addEventListener('click', prune);

  await load();
});
