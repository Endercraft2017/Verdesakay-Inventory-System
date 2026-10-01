/* Sync (docs/OFFLINE-FIRST.md §2.4, phase 3b).

   On an installed PC: where this PC's work stands — connection, the actions that need attention
   (the cloud rejected them, or they no longer applied), and the actions still waiting to sync.
   On the cloud: for admins, the installed PCs enrolled against this workspace (revoke a lost
   one), and how to set one up. Reached from the top-bar sync pill or Admin → Installed PCs. */
App.register('sync', async (view) => {
  view.innerHTML = '<div class="empty">Loading…</div>';
  const status = await API.get('/sync/status');
  if (status.mode === 'node') return renderNode(status);
  return renderCloud(status);

  function head(title, extra) {
    return `<div class="topbar"><h2>${UI.esc(title)}</h2><div class="grow"></div>${extra || ''}</div>`;
  }

  async function renderNode(s) {
    const d = SyncStatus.describe(s);
    const [attention, pending] = await Promise.all([
      API.get('/sync/activity?view=attention'),
      API.get('/sync/activity?view=pending'),
    ]);
    const showWho = App.hasPermission('users.manage');
    const row = (c, withDismiss) => `
      <tr>
        <td><strong>${UI.esc(SyncStatus.label(c))}</strong>
          ${c.error ? `<div class="muted small">${UI.esc(c.error)}</div>` : ''}</td>
        ${showWho ? `<td>${UI.esc(c.actor_name || '—')}</td>` : ''}
        <td>${c.occurred_at ? UI.fmtDate(c.occurred_at) : '—'}</td>
        <td class="actions">${withDismiss
          ? `<button class="btn secondary small" data-dismiss="${UI.esc(c.id)}">Dismiss</button>` : ''}</td>
      </tr>`;
    const table = (rows, withDismiss) => `
      <table><thead><tr><th>Action</th>${showWho ? '<th>By</th>' : ''}<th>When</th><th></th></tr></thead>
      <tbody>${rows.map((c) => row(c, withDismiss)).join('')}</tbody></table>`;

    view.innerHTML = `
      ${head('Sync', '<button class="btn" id="sync-now">Sync now</button>')}
      <div class="panel sync-summary">
        <span class="sync-pill ${d.tone}">${UI.esc(d.text)}</span>
        <div class="muted small">This PC is installed copy #${s.node_no}.
          ${s.last_sync_at ? 'Last synced ' + UI.esc(UI.fmtDate(s.last_sync_at)) + '.' : 'Not synced yet since it started.'}
          ${s.online === false && s.last_error ? '<br>' + UI.esc(s.last_error) : ''}</div>
        <p class="muted small">What you do on this PC is saved here at once and sent to the cloud when it can be
          reached. It is <strong>not final</strong> until it syncs: the cloud re-checks it and may reject it.</p>
      </div>
      <div class="panel">
        <h3>Needs attention</h3>
        ${attention.length ? table(attention, true) : UI.emptyState({ icon: 'check', title: 'Nothing needs attention' })}
        ${s.discrepancies_open ? `<p><a href="#/stock-discrepancies">${s.discrepancies_open} open stock
          discrepanc${s.discrepancies_open === 1 ? 'y' : 'ies'}</a> — counts to check after offline stock-outs.</p>` : ''}
      </div>
      <div class="panel">
        <h3>Waiting to sync</h3>
        ${pending.length ? table(pending, false) : UI.emptyState({ icon: 'check', title: 'Everything is synced' })}
      </div>`;

    view.querySelector('#sync-now').onclick = async (e) => {
      e.target.disabled = true;
      try {
        const r = await API.post('/sync/now');
        UI.toast(`Synced — sent ${r.sent}, received ${r.received} update batch(es).`);
      } catch (err) {
        UI.toast(err.message, 'error');
      }
      await SyncStatus.refresh();
      App.navigate('sync');
    };
    view.querySelectorAll('[data-dismiss]').forEach((b) => b.onclick = async () => {
      await API.post('/sync/activity/' + encodeURIComponent(b.dataset.dismiss) + '/dismiss');
      await SyncStatus.refresh();
      App.navigate('sync');
    });
  }

  async function renderCloud(s) {
    const admin = App.hasPermission('users.manage');
    const intro = s.mode === 'cloud'
      ? 'This workspace syncs with installed PCs. Their work arrives here when they are online.'
      : 'This workspace has no installed PCs yet. Enrolling the first one switches syncing on.';
    if (!admin) {
      view.innerHTML = `${head('Sync')}<div class="panel"><p>You are working on the cloud: everything you do is saved
        straight away.</p></div>`;
      return;
    }
    const pcs = await API.get('/sync/nodes');
    const origin = location.origin;
    view.innerHTML = `
      ${head('Installed PCs')}
      <div class="panel"><p class="muted">${UI.esc(intro)}</p>
        ${pcs.length ? `<table><thead><tr><th>#</th><th>PC</th><th>Enrolled</th><th>Last seen</th><th>Status</th><th></th></tr></thead>
          <tbody>${pcs.map((p) => `<tr>
            <td>${p.node_no}</td><td><strong>${UI.esc(p.name)}</strong></td>
            <td>${UI.fmtDate(p.enrolled_at)}</td>
            <td>${p.last_seen_at ? UI.fmtDate(p.last_seen_at) : 'never'}</td>
            <td>${p.revoked_at ? '<span class="badge-pill low">revoked</span>' : '<span class="badge-pill ok">active</span>'}</td>
            <td class="actions">${p.revoked_at ? '' : `<button class="btn secondary small danger" data-revoke="${p.node_no}">Revoke</button>`}</td>
          </tr>`).join('')}</tbody></table>`
          : UI.emptyState({ icon: 'building', title: 'No installed PCs yet' })}
      </div>
      <div class="panel">
        <h3>Set up a PC to work offline</h3>
        <p class="muted small">On the PC (with this app's files), as an admin of this workspace:</p>
        <pre class="code-block">SYNC_ENROL_PASSWORD=your-password npm run sync:enrol -- --cloud ${UI.esc(origin)} --user your-username --name "PC name"</pre>
        <p class="muted small">Then start it with <code>DEPLOY_MODE=node</code>. A setup screen replaces this step once the
          desktop installer exists.</p>
      </div>`;
    view.querySelectorAll('[data-revoke]').forEach((b) => b.onclick = async () => {
      if (!(await UI.confirmDialog('Revoke this PC? It stops syncing at once; anything it has not sent yet stays on it.', 'Revoke'))) return;
      await API.post('/sync/nodes/' + b.dataset.revoke + '/revoke');
      UI.toast('PC revoked');
      App.navigate('sync');
    });
  }
});
