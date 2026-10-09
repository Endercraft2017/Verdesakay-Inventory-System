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
    const [attention, pending, site] = await Promise.all([
      API.get('/sync/activity?view=attention'),
      API.get('/sync/activity?view=pending'),
      API.get('/sync/site').catch(() => ({ installed: false })),
    ]);
    const admin = App.hasPermission('users.manage');
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
        ${window.desktopApp ? `<label class="check-row"><input type="checkbox" id="sync-autostart">
          Open when Windows starts${s.is_host ? ' <span class="muted small">(keep on: other PCs and phones at this site use this PC)</span>' : ''}</label>` : ''}
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
      </div>
      ${sitePanel(site)}`;

    // Desktop app only: start with Windows (electron/autostart.cjs).
    const auto = view.querySelector('#sync-autostart');
    if (auto) {
      auto.checked = await window.desktopApp.getAutostart();
      auto.onchange = async () => {
        const on = await window.desktopApp.setAutostart(auto.checked);
        auto.checked = on;
        UI.toast(on ? 'Verdesakay will open when Windows starts.' : 'Verdesakay will no longer open when Windows starts.');
      };
    }

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
    const resync = view.querySelector('#site-resync');
    if (resync) resync.onclick = async () => {
      if (!(await UI.confirmDialog('Re-sync this PC? What it has not sent yet goes first; then it takes a fresh copy of the '
        + 'data from ' + (site.is_host ? 'the cloud' : 'the site host') + ' and re-applies its unsent work on top.', 'Re-sync'))) return;
      await API.post('/sync/site/resync');
      UI.toast('This PC re-syncs at its next sync.');
      App.navigate('sync');
    };
    const takeOver = view.querySelector('#site-take-over');
    if (takeOver) takeOver.onclick = () => UI.modal({
      title: 'Take over as site host',
      bodyHTML: `<p>Use this only when the site host PC is <strong>switched off, broken or gone</strong> and won't be back soon.</p>
        <p class="muted small">This PC becomes the host: the site's other PCs and phones work through it, and it decides the
          site's records while the internet is down. Nothing recorded through the old host is lost: this PC has a copy of
          what it held and sends it to the cloud. If the old host is still running somewhere, the site would have two hosts
          deciding at once until they reach the cloud, which keeps one and flags clashes. When the old host comes back it
          becomes an ordinary PC of the site.</p>
        <p class="muted small">Phones keep the old host's address: open the new host's address on them (or its phone-setup page).</p>
        <label class="check-row"><input type="checkbox" id="take-over-sure"> The site host is switched off or unreachable</label>`,
      confirmText: 'Take over',
      onConfirm: async (overlay, showErr) => {
        if (!overlay.querySelector('#take-over-sure').checked) { showErr('Confirm that the site host is off first.'); return false; }
        await API.post('/sync/site/take-over', { confirm: true });
        UI.toast('This PC is now the site host. It restarts in a moment.');
      },
    });
  }

  /** The site this PC belongs to (phase 5, docs/OFFLINE-FIRST.md §30): its role, the site's PCs,
   *  and — for an admin — re-sync, and taking over when the site host is lost. */
  function sitePanel(site) {
    if (!site || !site.installed || site.site_no == null) return '';
    const role = site.is_host ? 'This PC is the site host' : 'This PC works through the site host';
    const peers = (site.peers || []).filter((p) => !p.revoked_at);
    return `<div class="panel">
      <h3>Site</h3>
      <p>${UI.esc(role)} <span class="muted small">(site #${site.site_no}, term ${site.term})</span></p>
      ${!site.is_host && site.host_misses >= 3 ? `<p class="muted small">The site host hasn't answered for a while. This PC
        is asking the site's other PCs whether one of them hosts the site now.</p>` : ''}
      ${site.resync_pending ? '<p class="muted small">This PC re-syncs from a fresh copy at its next sync.</p>' : ''}
      ${peers.length ? `<table><thead><tr><th>PC</th><th>On the LAN at</th></tr></thead><tbody>${peers.map((p) => `<tr>
        <td><strong>${UI.esc(p.name)}</strong> <span class="muted small">#${p.node_no}</span></td>
        <td class="muted small">${UI.esc(p.lan_url || '—')}</td></tr>`).join('')}</tbody></table>` : ''}
      ${admin ? `<div class="btn-row">
        <button class="btn secondary" id="site-resync">Re-sync this PC</button>
        ${site.can_take_over ? '<button class="btn secondary danger" id="site-take-over">Take over as site host…</button>' : ''}
      </div>` : ''}
    </div>`;
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
    const [pcs, sites, clashes, installer] = await Promise.all([
      API.get('/sync/nodes'),
      API.get('/sync/sites'),
      API.get('/sync/clashes'),
      API.get('/desktop/installer/info').catch(() => ({ available: false })),
    ]);
    const origin = location.origin + (window.VDS_BASE_PATH || '');
    const hostName = (no) => (sites.hosts.find((h) => h.node_no === no) || { name: '#' + no }).name;
    const role = (p) => p.is_host ? 'Site host' : p.host_node_no ? 'PC of ' + hostName(p.host_node_no) : 'PC';
    const hostOptions = (selected) => ['<option value="">— cloud only —</option>']
      .concat(sites.hosts.map((h) => `<option value="${h.node_no}" ${h.node_no === selected ? 'selected' : ''}>${UI.esc(h.name)}</option>`))
      .join('');
    view.innerHTML = `
      ${head('Installed PCs')}
      <div class="panel"><p class="muted">${UI.esc(intro)}</p>
        ${pcs.length ? `<table><thead><tr><th>#</th><th>PC</th><th>Role</th><th>Enrolled</th><th>Last seen</th><th>Health</th><th>Status</th>
          <th title="At a site with 3 or more voting PCs, the PCs elect a new site host by themselves when theirs is lost.">Votes</th><th></th></tr></thead>
          <tbody>${pcs.map((p) => `<tr>
            <td>${p.node_no}</td><td><strong>${UI.esc(p.name)}</strong></td><td>${UI.esc(role(p))}</td>
            <td>${UI.fmtDate(p.enrolled_at)}</td>
            <td>${p.last_seen_at ? UI.fmtDate(p.last_seen_at) : 'never'}</td>
            <td class="small">${p.app_version ? 'v' + UI.esc(p.app_version) : '—'}
              ${p.revoked_at || !p.last_seen_at ? '' : p.behind > 0
                ? `<div class="muted">${p.behind} update${p.behind === 1 ? '' : 's'} behind</div>`
                : '<div class="muted">up to date</div>'}</td>
            <td>${p.revoked_at ? '<span class="badge-pill low">revoked</span>' : '<span class="badge-pill ok">active</span>'}</td>
            <td>${p.revoked_at ? '' : `<input type="checkbox" data-voting="${p.node_no}" ${p.voting === 0 ? '' : 'checked'}
              aria-label="${UI.esc(p.name)} votes in host elections">`}</td>
            <td class="actions">${p.revoked_at ? '' : `<button class="btn secondary small danger" data-revoke="${p.node_no}">Revoke</button>`}</td>
          </tr>`).join('')}</tbody></table>`
          : UI.emptyState({ icon: 'building', title: 'No installed PCs yet' })}
      </div>
      ${sites.hosts.length ? `<div class="panel">
        <h3>Sites</h3>
        <p class="muted small">While the internet is down, a site's host decides its own records — edits, deletes and
          approvals on its locations. The <strong>main site</strong> also decides company-wide records (items,
          suppliers, settings). Anything belonging to no site waits for the internet.</p>
        <label>Main site</label>
        <select id="site-main">${hostOptions(sites.main_host)}</select>
        <table><thead><tr><th>Location</th><th>Type</th><th>Belongs to site</th></tr></thead>
          <tbody>${sites.locations.map((l) => `<tr>
            <td><strong>${UI.esc(l.name)}</strong></td><td style="text-transform:capitalize">${UI.esc(l.type)}</td>
            <td><select data-loc="${l.id}">${hostOptions(l.host_node_no)}</select></td>
          </tr>`).join('')}</tbody></table>
        <button class="btn" id="site-save">Save sites</button>
      </div>` : ''}
      ${clashes.length ? `<div class="panel">
        <h3>Site decision clashes</h3>
        <p class="muted small">A site decided one of its own records while offline, and by the time it synced the
          cloud's own check would have refused it. The site's decision was kept; check whether anything needs fixing.</p>
        <table><thead><tr><th>What</th><th>Site</th><th>By / when</th><th></th></tr></thead>
          <tbody>${clashes.map((c) => `<tr>
            <td>${UI.esc(c.summary)}<div class="muted small">${UI.esc(c.route)}</div></td>
            <td>${c.host_node_no ? UI.esc(hostName(c.host_node_no)) : '—'}</td>
            <td>${UI.esc(c.actor_name || '—')}<div class="muted small">${UI.fmtDate(c.created_at)}</div></td>
            <td class="actions"><button class="btn secondary small" data-clash="${c.id}">Resolve</button></td>
          </tr>`).join('')}</tbody></table>
      </div>` : ''}
      <div class="panel">
        <h3>Download the desktop app</h3>
        ${installer.available
          ? `<p class="muted small">${UI.esc(installer.file)} · ${UI.fmtBytes(installer.size)} · built ${UI.fmtDate(installer.built_at)}.
              Copy it to the PC and run it — it installs for that Windows user, no admin rights needed.</p>
             <button class="btn" id="dl-installer">Download the app</button>`
          : `<p class="muted small"><span class="badge-pill">Work in progress</span> The installer will be available here once the
              desktop app is finished.</p>
             <button class="btn" disabled>Download the app (coming soon)</button>`}
      </div>
      <div class="panel">
        <h3>Set up a PC to work offline</h3>
        <p class="muted small">On the PC (with this app's files), as an admin of this workspace:</p>
        <pre class="code-block">SYNC_ENROL_PASSWORD=your-password npm run sync:enrol -- --cloud ${UI.esc(origin)} --user your-username --name "PC name" --as-host</pre>
        <p class="muted small">Use <code>--as-host</code> for the PC that stays on all day (one per site — also a site with a
          single PC). For every other PC at that site, use <code>--host https://&lt;host PC's address&gt;:3000</code> instead.</p>
        <p class="muted small">Then start it with <code>DEPLOY_MODE=node</code>. A setup screen replaces this step once the
          desktop installer exists.</p>
      </div>`;
    const dl = view.querySelector('#dl-installer');
    if (dl) dl.onclick = () => API.download('/desktop/installer', installer.file);
    const save = view.querySelector('#site-save');
    if (save) save.onclick = async () => {
      const val = (sel) => (sel.value ? Number(sel.value) : null);
      await API.put('/sync/sites', {
        main_host: val(view.querySelector('#site-main')),
        locations: [...view.querySelectorAll('[data-loc]')].map((sel) => ({ location_id: Number(sel.dataset.loc), host_node_no: val(sel) })),
      });
      UI.toast('Sites saved');
    };
    view.querySelectorAll('[data-clash]').forEach((b) => b.onclick = () => UI.modal({
      title: 'Resolve clash',
      bodyHTML: '<label>What was checked / done</label><textarea id="clash-note" rows="3"></textarea>',
      confirmText: 'Resolve',
      onConfirm: async (overlay) => {
        await API.post('/sync/clashes/' + b.dataset.clash + '/resolve', { note: overlay.querySelector('#clash-note').value });
        UI.toast('Clash resolved');
        App.navigate('sync');
      },
    }));
    view.querySelectorAll('[data-voting]').forEach((box) => box.onchange = async () => {
      await API.put('/sync/nodes/' + box.dataset.voting + '/voting', { voting: box.checked });
      UI.toast(box.checked ? 'This PC votes in its site host elections.' : 'This PC no longer votes (e.g. a laptop that comes and goes).');
    });
    view.querySelectorAll('[data-revoke]').forEach((b) => b.onclick = async () => {
      if (!(await UI.confirmDialog('Revoke this PC? It stops syncing at once; anything it has not sent yet stays on it.', 'Revoke'))) return;
      await API.post('/sync/nodes/' + b.dataset.revoke + '/revoke');
      UI.toast('PC revoked');
      App.navigate('sync');
    });
  }
});
