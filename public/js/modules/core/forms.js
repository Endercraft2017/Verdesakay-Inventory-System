/* Forms & Files: upload, list, download, delete with department visibility. */
App.register('forms', async (view) => {
  view.innerHTML = `
    <div class="topbar">
      <h2>Forms &amp; Files</h2>
      <div class="grow"></div>
      <div class="search-box search">${UI.icon('search', 16)}<input id="forms-search" placeholder="Search title, category…" /></div>
      <select id="forms-cat" aria-label="File category" style="width:160px"><option value="">— Category —</option></select>
      <button class="btn" id="forms-upload">${UI.icon('upload')} Upload</button>
    </div>
    <div class="panel"><div id="forms-table"></div></div>`;

  const tableEl = view.querySelector('#forms-table');
  let all = [];
  const filters = { q: '', category: '' };

  async function load() {
    tableEl.innerHTML = '<div class="empty">Loading…</div>';
    all = await API.get('/forms');
    refreshCategoryOptions();
    applyFilters();
  }

  function refreshCategoryOptions() {
    const cats = [...new Set(all.map((f) => f.category).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b));
    const sel = view.querySelector('#forms-cat');
    sel.innerHTML = '<option value="">— Category —</option>' +
      cats.map((c) => `<option value="${UI.esc(c)}" ${c === filters.category ? 'selected' : ''}>${UI.esc(c)}</option>`).join('');
  }

  function applyFilters() {
    const q = filters.q.toLowerCase();
    render(all.filter((f) => {
      const matchesQ = !q ||
        (f.title + ' ' + (f.category || '') + ' ' + (f.original_name || '')).toLowerCase().includes(q);
      const matchesCat = !filters.category || f.category === filters.category;
      return matchesQ && matchesCat;
    }));
  }

  function render(list) {
    if (!list.length) {
      const filtered = all.length > 0;
      tableEl.innerHTML = UI.emptyState({
        icon: 'folder',
        title: filtered ? 'No matching files' : 'No files yet',
        hint: filtered ? 'Try a different search or category.' : 'Upload a form or document to share it with your team.',
        action: filtered ? '' : `<button class="btn" id="forms-empty-upload">${UI.icon('upload')} Upload</button>`,
      });
      const eu = tableEl.querySelector('#forms-empty-upload');
      if (eu) eu.onclick = uploadModal;
      return;
    }
    const me = App.getMe();
    tableEl.innerHTML = `
      <table>
        <thead><tr><th>Title</th><th>Category</th><th>Visibility</th><th>Size</th><th>Uploaded</th><th></th></tr></thead>
        <tbody>${list.map((f) => `
          <tr class="clickable" data-open="${f.id}">
            <td>
              <div style="display:flex;gap:10px;align-items:flex-start">
                <span style="color:var(--text-faint);margin-top:1px">${UI.icon(UI.fileIconName(f.original_name), 18)}</span>
                <div>
                  <strong>${UI.esc(f.title)}</strong>
                  <div class="muted">${UI.esc(f.original_name)}</div>
                  ${f.description ? `<div class="muted" style="font-size:12px">${UI.esc(f.description)}</div>` : ''}
                </div>
              </div>
            </td>
            <td>${UI.esc(f.category || '—')}</td>
            <td>${f.department_name
                ? `<span class="badge-pill muted">${UI.esc(f.department_name)}</span>`
                : '<span class="badge-pill ok">All staff</span>'}</td>
            <td>${UI.fmtBytes(f.size_bytes)}</td>
            <td>${UI.fmtDate(f.created_at)}<div class="muted" style="font-size:12px">${UI.esc(f.uploaded_by_name || '')}</div></td>
            <td class="actions">
              ${isPrintable(f) ? `<button class="icon-btn" title="Print" data-print="${f.id}">${UI.icon('printer')}</button>` : ''}
              <button class="icon-btn" title="Download" data-dl="${f.id}">${UI.icon('download')}</button>
              ${(App.hasPermission('forms.delete') || f.uploaded_by_name === me.full_name)
                ? `<button class="icon-btn danger" title="Delete" data-del="${f.id}">${UI.icon('trash')}</button>` : ''}
            </td>
          </tr>`).join('')}
        </tbody>
      </table>`;

    tableEl.querySelectorAll('[data-dl]').forEach((b) => b.onclick = () => download(b.dataset.dl));
    tableEl.querySelectorAll('[data-print]').forEach((b) => b.onclick = () => printFile(list.find((x) => x.id == b.dataset.print)));
    tableEl.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => del(b.dataset.del, list));
    tableEl.querySelectorAll('tr[data-open]').forEach((tr) => tr.onclick = (e) => {
      if (e.target.closest('.actions')) return;
      download(tr.dataset.open);
    });
  }

  const PRINTABLE_EXT = ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'];
  function isPrintable(f) {
    const ext = (f.original_name || '').split('.').pop().toLowerCase();
    return PRINTABLE_EXT.includes(ext) || /pdf|image\//.test(f.mime_type || '');
  }

  // Fetch the file (auth) then open a print view: PDFs in the browser's native PDF viewer,
  // images wrapped in a print-styled page — both via the same preview-modal + iframe pattern
  // (not window.open(), which can be popup-blocked outright regardless of gesture timing; an
  // iframe inside a modal that's already part of the page never opens a new window/tab).
  async function printFile(f) {
    try {
      const res = await fetch(API.base() + '/api/forms/' + f.id + '/download', {
        headers: { Authorization: 'Bearer ' + API.getToken() },
      });
      if (!res.ok) throw new Error('Could not open file');
      const url = URL.createObjectURL(await res.blob());
      const ext = (f.original_name || '').split('.').pop().toLowerCase();
      const isPdf = ext === 'pdf' || /pdf/.test(f.mime_type || '');
      UI.modal({
        title: f.title + ' — Preview',
        size: 'lg',
        bodyHTML: `<iframe id="file-preview-frame" style="width:100%;height:65vh;border:1px solid var(--border-strong);border-radius:8px;background:#fff"></iframe>`,
        cancelText: 'Close',
        confirmText: 'Print…',
        onOpen: (ov) => {
          const ifr = ov.querySelector('#file-preview-frame');
          if (isPdf) ifr.src = url; // browser's native PDF viewer renders + prints it in-place
          else ifr.srcdoc = UI.printableHtml(`<img src="${url}" alt="${UI.esc(f.title)}" style="max-width:100%">`, f.title);
        },
        onConfirm: (ov) => {
          const ifr = ov.querySelector('#file-preview-frame');
          ifr.contentWindow.focus();
          ifr.contentWindow.print();
          return false; // keep the preview open — printing shouldn't close it
        },
      });
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) {
      UI.toast(e.message, 'error');
    }
  }

  async function download(id) {
    // Authenticated download: fetch as blob with token, then save.
    try {
      const res = await fetch(API.base() + '/api/forms/' + id + '/download', {
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
      protectChanges: true,
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
    filters.q = e.target.value.trim();
    applyFilters();
  });
  view.querySelector('#forms-cat').addEventListener('change', (e) => {
    filters.category = e.target.value;
    applyFilters();
  });
  view.querySelector('#forms-upload').addEventListener('click', uploadModal);

  await load();
});
