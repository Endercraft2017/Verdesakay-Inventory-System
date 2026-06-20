/* Forms & Files: upload, list, download, delete with department visibility. */
App.register('forms', async (view) => {
  view.innerHTML = `
    <div class="topbar">
      <h2>Forms &amp; Files</h2>
      <div class="grow"></div>
      <input class="search" id="forms-search" placeholder="Search title, category…" />
      <button class="btn" id="forms-upload">⬆ Upload</button>
    </div>
    <div class="panel"><div id="forms-table"></div></div>`;

  const tableEl = view.querySelector('#forms-table');
  let all = [];

  async function load() {
    tableEl.innerHTML = '<div class="empty">Loading…</div>';
    all = await API.get('/forms');
    render(all);
  }

  function render(list) {
    if (!list.length) {
      tableEl.innerHTML = '<div class="empty">No files uploaded yet.</div>';
      return;
    }
    const me = App.getMe();
    tableEl.innerHTML = `
      <table>
        <thead><tr><th>Title</th><th>Category</th><th>Visibility</th><th>Size</th><th>Uploaded</th><th></th></tr></thead>
        <tbody>${list.map((f) => `
          <tr>
            <td><strong>${UI.esc(f.title)}</strong>
              <div class="muted">${UI.esc(f.original_name)}</div>
              ${f.description ? `<div class="muted" style="font-size:12px">${UI.esc(f.description)}</div>` : ''}
            </td>
            <td>${UI.esc(f.category || '—')}</td>
            <td>${f.department_name
                ? `<span class="badge-pill muted">${UI.esc(f.department_name)}</span>`
                : '<span class="badge-pill ok">All staff</span>'}</td>
            <td>${UI.fmtBytes(f.size_bytes)}</td>
            <td>${UI.fmtDate(f.created_at)}<div class="muted" style="font-size:12px">${UI.esc(f.uploaded_by_name || '')}</div></td>
            <td class="actions">
              <button class="icon-btn" title="Download" data-dl="${f.id}">⬇</button>
              ${(App.isAdmin() || f.uploaded_by_name === me.full_name)
                ? `<button class="icon-btn danger" title="Delete" data-del="${f.id}">🗑️</button>` : ''}
            </td>
          </tr>`).join('')}
        </tbody>
      </table>`;

    tableEl.querySelectorAll('[data-dl]').forEach((b) => b.onclick = () => download(b.dataset.dl));
    tableEl.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => del(b.dataset.del, list));
  }

  async function download(id) {
    // Authenticated download: fetch as blob with token, then save.
    try {
      const res = await fetch('/api/forms/' + id + '/download', {
        headers: { Authorization: 'Bearer ' + API.getToken() },
      });
      if (!res.ok) throw new Error('Download failed');
      const blob = await res.blob();
      const cd = res.headers.get('content-disposition') || '';
      const match = /filename="?([^"]+)"?/.exec(cd);
      const name = match ? match[1] : 'download';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      UI.toast(e.message, 'error');
    }
  }

  function uploadModal() {
    const deptOpts = '<option value="">All staff (shared)</option>' +
      App.getDepartments().map((d) => `<option value="${d.id}">${UI.esc(d.name)} only</option>`).join('');
    UI.modal({
      title: 'Upload a form or file',
      bodyHTML: `
        <div><label>File * (max 25 MB)</label><input type="file" data-f="file" /></div>
        <div><label>Title</label><input data-f="title" placeholder="Defaults to file name" /></div>
        <div class="field-row">
          <div><label>Category</label><input data-f="category" placeholder="e.g. HR Forms" /></div>
          <div><label>Visible to</label><select data-f="department_id">${deptOpts}</select></div>
        </div>
        <div><label>Description</label><textarea data-f="description"></textarea></div>`,
      confirmText: 'Upload',
      onConfirm: async (overlay, showErr) => {
        const fileEl = overlay.querySelector('[data-f="file"]');
        if (!fileEl.files.length) { showErr('Please choose a file'); return false; }
        const fd = new FormData();
        fd.append('file', fileEl.files[0]);
        fd.append('title', overlay.querySelector('[data-f="title"]').value);
        fd.append('category', overlay.querySelector('[data-f="category"]').value);
        fd.append('description', overlay.querySelector('[data-f="description"]').value);
        fd.append('department_id', overlay.querySelector('[data-f="department_id"]').value);
        await API.upload('/forms', fd);
        UI.toast('File uploaded');
        load();
      },
    });
  }

  async function del(id, list) {
    const f = list.find((x) => x.id == id);
    const ok = await UI.confirmDialog(`Delete "${f.title}"? This cannot be undone.`, 'Delete');
    if (!ok) return;
    await API.del('/forms/' + id);
    UI.toast('File deleted');
    load();
  }

  view.querySelector('#forms-search').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    render(all.filter((f) =>
      (f.title + ' ' + (f.category || '') + ' ' + (f.original_name || '')).toLowerCase().includes(q)));
  });
  view.querySelector('#forms-upload').addEventListener('click', uploadModal);

  await load();
});
