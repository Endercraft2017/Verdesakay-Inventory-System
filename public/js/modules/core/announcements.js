/* Home → Announcements: company-wide notices. Everyone reads; the `announce`
   permission unlocks posting, pinning, editing and deleting. */
App.register('announcements', async (view) => {
  const canPost = App.hasPermission('announce');
  let rows = [];

  view.innerHTML = `
    <div class="topbar">
      <h2>Announcements</h2>
      <div class="grow"></div>
      ${canPost ? `<button class="btn" id="an-new">${UI.icon('plus')} New announcement</button>` : ''}
    </div>
    <div class="panel"><div id="an-list"><div class="empty">Loading…</div></div></div>`;

  const listEl = view.querySelector('#an-list');

  async function load() {
    listEl.innerHTML = '<div class="empty">Loading…</div>';
    rows = await API.get(canPost ? '/announcements/all' : '/announcements');
    render();
  }

  function render() {
    if (!rows.length) {
      listEl.innerHTML = UI.emptyState({
        icon: 'messages', title: 'No announcements',
        hint: canPost ? 'Post one so everyone sees it on web and mobile.' : 'Nothing posted yet.',
      });
      return;
    }
    listEl.innerHTML = `
      <table>
        <thead><tr><th></th><th>Title</th><th>Posted by</th><th>Date</th><th>Expires</th>${canPost ? '<th></th>' : ''}</tr></thead>
        <tbody>${rows.map((r) => `
          <tr>
            <td>${r.pinned ? '📌' : ''}</td>
            <td><strong>${UI.esc(r.title)}</strong><div class="muted" style="white-space:pre-wrap;max-width:520px">${UI.esc(r.body)}</div></td>
            <td>${UI.esc(r.created_by_name || '—')}</td>
            <td>${UI.esc((r.created_at || '').slice(0, 16).replace('T', ' '))}</td>
            <td>${r.expires_at ? UI.esc(r.expires_at.slice(0, 10)) : '—'}</td>
            ${canPost ? `<td class="actions">
              <button class="icon-btn" title="Edit" data-ed="${r.id}">${UI.icon('edit')}</button>
              <button class="icon-btn danger" title="Delete" data-dl="${r.id}">${UI.icon('trash')}</button>
            </td>` : ''}
          </tr>`).join('')}
        </tbody>
      </table>`;
    if (canPost) {
      listEl.querySelectorAll('[data-ed]').forEach((b) =>
        b.onclick = () => edit(rows.find((r) => String(r.id) === b.dataset.ed)));
      listEl.querySelectorAll('[data-dl]').forEach((b) =>
        b.onclick = () => remove(b.dataset.dl));
    }
  }

  function edit(existing) {
    const e = existing || {};
    UI.modal({
      title: existing ? 'Edit announcement' : 'New announcement',
      bodyHTML: `
        <label>Title</label>
        <input data-f="title" maxlength="160" value="${UI.esc(e.title || '')}" />
        <label style="margin-top:12px">Message</label>
        <textarea data-f="body" rows="5" maxlength="5000">${UI.esc(e.body || '')}</textarea>
        <label style="margin-top:12px">Hide after (optional)</label>
        <input data-f="expires" type="date" value="${e.expires_at ? e.expires_at.slice(0, 10) : ''}" />
        <label class="check" style="margin-top:12px"><input type="checkbox" data-f="pinned" ${e.pinned ? 'checked' : ''}/> Pin to top</label>
        ${existing ? '' : '<label class="check"><input type="checkbox" data-f="notify" /> Also send a push notification to everyone</label>'}`,
      confirmText: existing ? 'Save' : 'Post',
      onConfirm: async (overlay, showErr) => {
        const title = overlay.querySelector('[data-f="title"]').value.trim();
        const body = overlay.querySelector('[data-f="body"]').value.trim();
        if (!title || !body) { showErr('Title and message are required'); return false; }
        const exp = overlay.querySelector('[data-f="expires"]').value;
        const payload = {
          title, body,
          pinned: overlay.querySelector('[data-f="pinned"]').checked,
          expires_at: exp ? exp + ' 23:59' : null,
        };
        if (!existing) payload.notify = overlay.querySelector('[data-f="notify"]').checked;
        if (existing) await API.put('/announcements/' + existing.id, payload);
        else await API.post('/announcements', payload);
        UI.toast(existing ? 'Announcement saved' : 'Announcement posted');
        load();
      },
    });
  }

  async function remove(id) {
    if (!(await UI.confirmDialog('Delete this announcement?', 'Delete'))) return;
    await API.del('/announcements/' + id);
    UI.toast('Deleted');
    load();
  }

  if (canPost) view.querySelector('#an-new').onclick = () => edit(null);
  await load();
});
