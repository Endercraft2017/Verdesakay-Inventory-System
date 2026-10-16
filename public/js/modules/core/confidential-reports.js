/* Anonymous Reports — desktop case handling for the identity-free reporting channel
   (src/core/confidential-reports.ts; reports.confidential). No reporter identity exists for
   these cases; replies reach the reporter only when they check with their number + access code,
   and they see them as "Case handler". Same API as the mobile #/confidential-reports queue. */
App.register('confidential-reports', async (view) => {
  const STATUSES = ['new', 'triaged', 'investigating', 'resolved', 'closed'];
  const BADGE = { new: 'low', triaged: 'status-open', investigating: 'status-confirmed', resolved: 'ok', closed: 'muted' };
  const state = { status: 'open' };

  if (!App.hasPermission('reports.confidential')) {
    view.innerHTML = UI.emptyState({ icon: 'alert', title: 'No access', hint: 'Handling anonymous reports needs the “Handle anonymous reports” permission.' });
    return;
  }

  view.innerHTML = `
    <div class="topbar">
      <div>
        <h2>Anonymous Reports</h2>
        <div class="sub">Filed through the anonymous channel — no reporter identity is stored</div>
      </div>
      <div class="grow"></div>
      <select id="cr-status" aria-label="Status">
        <option value="open">Open (not resolved/closed)</option>
        ${STATUSES.map((s) => `<option value="${s}">${s[0].toUpperCase() + s.slice(1)}</option>`).join('')}
      </select>
      <button type="button" class="btn secondary" id="cr-refresh">${UI.icon('history', 15)} Refresh</button>
    </div>
    <div class="panel"><div id="cr-body"><div class="empty">Loading…</div></div></div>`;
  const body = view.querySelector('#cr-body');
  const badge = (s) => `<span class="badge-pill ${BADGE[s] || ''}">${UI.esc(s)}</span>`;

  async function load() {
    body.innerHTML = '<div class="empty">Loading…</div>';
    let rows;
    try { rows = await API.get('/confidential-reports' + (state.status !== 'open' ? `?status=${state.status}` : '')); }
    catch (e) { body.innerHTML = UI.emptyState({ icon: 'alert', title: 'Could not load reports', hint: e.message }); return; }
    if (state.status === 'open') rows = rows.filter((r) => r.status !== 'resolved' && r.status !== 'closed');
    if (!rows.length) { body.innerHTML = UI.emptyState({ icon: 'inbox', title: 'No reports here' }); return; }
    body.innerHTML = `<table>
      <thead><tr><th>Report</th><th>Category</th><th>Title</th><th>Status</th><th>Filed</th><th>Updated</th><th class="right">Messages</th><th class="right">Photos</th><th></th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td>${UI.esc(r.number)}</td><td>${UI.esc(r.category)}</td><td>${UI.esc(r.subject || '—')}</td>
        <td>${badge(r.status)}</td><td>${UI.esc(r.created_on)}</td><td>${UI.esc(r.updated_on)}</td>
        <td class="right">${r.message_count}${r.reporter_replies ? ` <span class="muted">(${r.reporter_replies} from reporter)</span>` : ''}</td>
        <td class="right">${r.photo_count || '—'}</td>
        <td class="right"><button type="button" class="btn secondary small" data-open="${r.id}">Open</button></td>
      </tr>`).join('')}</tbody>
    </table>`;
    body.querySelectorAll('[data-open]').forEach((b) => { b.onclick = () => openCase(Number(b.dataset.open)); });
  }

  async function openCase(id) {
    let r;
    try { r = await API.get(`/confidential-reports/${id}`); }
    catch (e) { UI.toast(e.message, 'error'); return; }
    const statusLabel = (value) => value[0].toUpperCase() + value.slice(1);
    const statusHelp = {
      new: 'Received and waiting for review.', triaged: 'Reviewed and ready for follow-up.',
      investigating: 'The concern is being looked into.', resolved: 'The concern has been addressed. The reporter can still reply.',
      closed: 'The case is closed. The reporter can read replies but cannot send new messages.',
    };
    const photoStrip = (list) => list && list.length
      ? `<div class="cr-photos" aria-label="Attached photos">${list.map((a, index) => `<button type="button" class="cr-photo" data-url="${UI.esc(a.url)}" aria-label="Open attached photo ${index + 1}"><span>Loading photo…</span><img alt="Attached report photo ${index + 1}" hidden /></button>`).join('')}</div>` : '';
    const thread = r.messages.length
      ? r.messages.map((entry) => `<article class="cr-message ${entry.author === 'reporter' ? 'from-reporter' : 'from-handler'}">
          <div class="cr-message-meta"><strong>${entry.author === 'reporter' ? 'Anonymous reporter' : UI.esc(entry.handler_name || 'Case handler')}</strong><span>${UI.esc(entry.created_on)}</span></div>
          <div class="cr-text">${UI.esc(entry.body)}</div>${photoStrip(entry.attachments)}</article>`).join('')
      : '<p class="cr-empty">No replies yet. Send a message below to start the conversation.</p>';
    const ownedUrls = [];
    const m = UI.modal({
      title: r.subject || r.category,
      size: 'lg', cancelText: 'Close',
      bodyHTML: `<div class="cr-case">
        <div class="cr-case-summary"><span class="cr-reference">${UI.esc(r.number)}</span><span id="cr-current-status">${badge(r.status)}</span><span class="cr-privacy">Anonymous · reporter identity is not stored</span></div>
        <section class="cr-section" aria-labelledby="cr-report-heading">
          <h4 id="cr-report-heading">Report details</h4>
          <dl class="cr-details"><div><dt>Category</dt><dd>${UI.esc(r.category)}</dd></div><div><dt>Incident date</dt><dd>${UI.esc(r.incident_date || 'Not provided')}</dd></div><div><dt>Location</dt><dd>${UI.esc(r.location || 'Not provided')}</dd></div><div><dt>Filed</dt><dd>${UI.esc(r.created_on)}</dd></div></dl>
          <div class="cr-description cr-text">${UI.esc(r.description)}</div>${photoStrip(r.attachments)}
        </section>
        <section class="cr-section cr-status-section" aria-labelledby="cr-status-heading">
          <div><h4 id="cr-status-heading">Case status</h4><p id="cr-status-help" class="muted">${UI.esc(statusHelp[r.status] || '')}</p></div>
          <div class="cr-status-controls"><label class="sr-only" for="cr-case-status">Case status</label><select id="cr-case-status" aria-describedby="cr-status-help">${STATUSES.map((value) => `<option value="${value}"${value === r.status ? ' selected' : ''}>${statusLabel(value)}</option>`).join('')}</select><button type="button" class="btn secondary small" id="cr-save-status" disabled>Save status</button></div>
          <p class="cr-feedback" id="cr-status-feedback" role="status" aria-live="polite"></p>
        </section>
        <section class="cr-section" aria-labelledby="cr-conversation-heading"><h4 id="cr-conversation-heading">Conversation <span class="muted">(${r.messages.length})</span></h4><p class="cr-section-hint muted">The reporter sees replies when they check their report using their access code.</p><div class="cr-conversation">${thread}</div></section>
        <section class="cr-reply-section" aria-labelledby="cr-reply-heading"><h4 id="cr-reply-heading">Reply to reporter</h4><p class="muted cr-section-hint">Your reply appears as “Case handler” to protect your identity.</p>
          <label class="sr-only" for="cr-reply">Reply to reporter</label><textarea id="cr-reply" maxlength="3000" placeholder="Write a helpful reply or ask for more details…" aria-describedby="cr-reply-count cr-reply-note"></textarea>
          <p id="cr-reply-note" class="cr-section-hint muted"${r.status === 'closed' ? '' : ' hidden'}>This case is closed. Reopen it if you need a response from the reporter.</p>
          <div class="cr-reply-actions"><span id="cr-reply-count" class="muted">0 / 3,000</span><button type="button" class="btn" id="cr-send" disabled>Send reply</button></div><p id="cr-reply-feedback" class="cr-feedback" role="alert"></p>
        </section>
      </div>`,
      onClose: () => ownedUrls.forEach((url) => URL.revokeObjectURL(url)),
      onOpen: (ov) => {
        ov.querySelector('.modal').classList.add('cr-case-modal');
        const reply = ov.querySelector('#cr-reply');
        const send = ov.querySelector('#cr-send');
        const select = ov.querySelector('#cr-case-status');
        const saveStatus = ov.querySelector('#cr-save-status');
        let busy = false;
        const updateControls = () => { send.disabled = busy || !reply.value.trim(); saveStatus.disabled = busy || select.value === r.status; select.disabled = busy; reply.disabled = busy; };
        reply.addEventListener('input', () => { ov.__markDirty(); ov.querySelector('#cr-reply-count').textContent = `${reply.value.length.toLocaleString()} / 3,000`; updateControls(); });
        select.addEventListener('change', () => { ov.querySelector('#cr-status-help').textContent = statusHelp[select.value]; ov.querySelector('#cr-status-feedback').textContent = ''; updateControls(); });
        ov.querySelectorAll('.cr-photo').forEach((button) => {
          API.blobUrl(button.dataset.url).then((url) => {
            if (!ov.isConnected) { URL.revokeObjectURL(url); return; }
            ownedUrls.push(url);
            const image = button.querySelector('img');
            image.onload = () => { image.hidden = false; button.querySelector('span').hidden = true; };
            image.onerror = () => { button.querySelector('span').textContent = 'Photo unavailable'; button.disabled = true; };
            image.src = url;
            button.onclick = () => PhotoViewer.open(url, 'Report photo');
          }).catch(() => { if (ov.isConnected) { button.querySelector('span').textContent = 'Photo unavailable'; button.disabled = true; } });
        });
        saveStatus.onclick = async () => {
          const nextStatus = select.value;
          busy = true; ov.__setSaving(true); updateControls(); saveStatus.textContent = 'Saving…';
          try {
            await API.post(`/confidential-reports/${id}/status`, { status: nextStatus });
            r.status = nextStatus;
            ov.querySelector('#cr-current-status').innerHTML = badge(r.status);
            ov.querySelector('#cr-status-feedback').textContent = 'Status saved';
            ov.querySelector('#cr-reply-note').hidden = r.status !== 'closed';
            load();
          } catch (error) { ov.querySelector('#cr-status-feedback').textContent = error.message || 'Could not save status. Try again.'; }
          finally { busy = false; ov.__setSaving(false); saveStatus.textContent = 'Save status'; updateControls(); }
        };
        send.onclick = async () => {
          const text = reply.value.trim();
          if (!text || busy) return;
          busy = true; ov.__setSaving(true); updateControls(); send.textContent = 'Sending…';
          ov.querySelector('#cr-reply-feedback').textContent = '';
          try {
            await API.post(`/confidential-reports/${id}/reply`, { body: text });
            UI.toast('Reply sent', 'success');
            m.close(); load(); openCase(id);
          } catch (error) { ov.querySelector('#cr-reply-feedback').textContent = error.message || 'Could not send reply. Your draft is still here.'; }
          finally { busy = false; ov.__setSaving(false); send.textContent = 'Send reply'; updateControls(); }
        };
      },
    });
  }

  view.querySelector('#cr-status').onchange = (e) => { state.status = e.target.value; load(); };
  view.querySelector('#cr-refresh').onclick = load;
  load();
});
