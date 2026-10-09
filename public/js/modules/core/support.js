/* Admin bug reports and issues, submitted directly to the OTOM owner. */
App.register('support', async (view) => {
  if (!App.hasPermission('users.manage')) { view.innerHTML = '<div class="empty">Only tenant administrators can contact support.</div>'; return; }
  view.innerHTML = `<div class="topbar"><div><h2>OTOM Support</h2><div class="sub">Report bugs, ask for help, and follow replies from OTOM.</div></div></div>
    <div class="panel" style="padding:20px;margin-bottom:20px"><h3>Submit a report</h3>
    <form id="support-form"><div class="row2"><label>Type<select name="category"><option value="bug">Bug report</option><option value="issue">Issue / help request</option></select></label>
    <label>Priority<select name="priority"><option value="normal">Normal</option><option value="low">Low</option><option value="high">High</option><option value="urgent">Urgent</option></select></label></div>
    <label>Subject<input name="subject" required maxlength="500" placeholder="What went wrong?" /></label>
    <label>Description<textarea name="description" required maxlength="10000" rows="5" placeholder="Steps to reproduce, expected result, and what happened. Please do not include passwords or sensitive employee data."></textarea></label>
    <button class="btn" type="submit">Send to OTOM</button><p id="support-error" role="alert"></p></form></div>
    <div class="topbar"><h3>Your company’s tickets</h3><div class="grow"></div><button class="btn secondary" id="support-refresh">Refresh</button></div><div id="support-tickets"></div>`;
  const form = view.querySelector('#support-form');
  const error = view.querySelector('#support-error');
  const list = view.querySelector('#support-tickets');
  async function load() {
    const tickets = await API.get('/support');
    list.innerHTML = tickets.length ? tickets.map(t => `<section class="panel" style="padding:20px;margin-bottom:16px">
      <h3>#${t.id} · ${UI.esc(t.subject)}</h3><p class="muted">${UI.esc(t.category)} · ${UI.esc(t.priority)} · ${UI.esc(t.status.replace('_', ' '))} · ${UI.esc(t.by)} · ${UI.esc(t.at)}</p>
      <p style="white-space:pre-wrap;overflow-wrap:anywhere">${UI.esc(t.description)}</p>
      ${(t.replies || []).map(r => `<div style="border-left:3px solid var(--line);padding:8px 12px;margin:12px 0"><strong>${r.source === 'owner' ? 'OTOM Support' : UI.esc(r.by)}</strong><span class="muted"> · ${UI.esc(r.at)}</span><p style="white-space:pre-wrap;overflow-wrap:anywhere">${UI.esc(r.body)}</p></div>`).join('')}
      <form data-ticket="${t.id}"><label>Follow up<textarea name="body" required maxlength="10000" rows="2"></textarea></label><button class="btn secondary" type="submit">Send reply</button></form></section>`).join('') : '<div class="empty">No support tickets yet.</div>';
    list.querySelectorAll('form[data-ticket]').forEach(f => f.addEventListener('submit', async e => {
      e.preventDefault(); const button = f.querySelector('button'); button.disabled = true;
      try { await API.post('/support/' + f.dataset.ticket + '/replies', { body: f.elements.body.value }); await load(); }
      catch (ex) { error.textContent = ex.message; button.disabled = false; }
    }));
  }
  form.addEventListener('submit', async e => {
    e.preventDefault(); const button = form.querySelector('button'); button.disabled = true; error.textContent = '';
    try {
      await API.post('/support', Object.fromEntries(new FormData(form)));
      form.reset(); UI.toast('Report sent to OTOM'); await load();
    } catch (ex) { error.textContent = ex.message; }
    finally { button.disabled = false; }
  });
  view.querySelector('#support-refresh').addEventListener('click', () => load().catch(e => { error.textContent = e.message; }));
  await load();
});
