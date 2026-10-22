(() => {
  'use strict';
  if (window.__codexSessionFolders) return;
  window.__codexSessionFolders = true;
  const KEY = 'codex-session-folders-v1';
  const PANEL = 'csf-panel';
  let state = { folders: [], assignments: {}, sessions: {}, collapsed: {} };
  let sidebar, panel, timer;
  let saveQueue = Promise.resolve();
  const el = (tag, text, cls) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (cls) node.className = cls;
    return node;
  };
  const button = (text, label, action) => {
    const node = el('button', text); node.type = 'button';
    node.setAttribute('aria-label', label); node.title = label;
    node.addEventListener('click', action); return node;
  };
  function sessionPath(href) {
    try {
      const url = new URL(href, location.origin);
      if (url.origin !== 'https://chatgpt.com') return null;
      return /^\/(?:local|c)\/[a-zA-Z0-9-]+\/?$/.test(url.pathname) ? url.pathname.replace(/\/$/, '') : null;
    } catch { return null; }
  }
  function validate(raw) {
    const next = { folders: [], assignments: {}, sessions: {}, collapsed: {} };
    if (!raw || typeof raw !== 'object') return next;
    next.collapsed[''] = raw.collapsed?.[''] === true;
    const ids = new Set();
    for (const f of Array.isArray(raw.folders) ? raw.folders.slice(0, 100) : []) {
      if (!f || !/^f-[a-zA-Z0-9-]+$/.test(f.id) || typeof f.name !== 'string' || !f.name.trim() || ids.has(f.id)) continue;
      ids.add(f.id); next.folders.push({ id: f.id, name: f.name.trim().slice(0, 80) });
      next.collapsed[f.id] = raw.collapsed?.[f.id] === true;
    }
    for (const [path, f] of Object.entries(raw.assignments || {})) {
      if (sessionPath(path) === path && ids.has(f)) next.assignments[path] = f;
    }
    for (const [path, session] of Object.entries(raw.sessions || {}).slice(0, 5000)) {
      if (sessionPath(path) === path && session && typeof session.title === 'string')
        next.sessions[path] = { title: session.title.trim().slice(0, 200) || 'Untitled session' };
    }
    return next;
  }
  const status = (message) => {
    const node = panel?.querySelector('.csf-status');
    if (node) node.textContent = message;
  };
  function save() {
    const snapshot = JSON.parse(JSON.stringify(state));
    saveQueue = saveQueue.catch(() => {}).then(() => chrome.storage.local.set({ [KEY]: snapshot }));
    saveQueue.catch(() => status('Could not save. Export a backup before closing.'));
  }
  function findSidebar() {
    // Only use a container with genuine session links; never scan conversation text.
    const candidates = document.querySelectorAll('nav, aside, [data-testid*="sidebar"], [id*="sidebar"]');
    return [...candidates].find(node => !node.closest('#' + PANEL) &&
      [...node.querySelectorAll('a[href]')].some(a => !a.closest('#' + PANEL) && sessionPath(a.getAttribute('href')))) || null;
  }
  function collect() {
    let changed = false;
    for (const a of sidebar.querySelectorAll('a[href]')) {
      if (a.closest('#' + PANEL)) continue;
      const path = sessionPath(a.getAttribute('href'));
      if (!path) continue;
      const title = (a.innerText || a.textContent || a.getAttribute('title') || '').trim().replace(/\s+/g, ' ').slice(0, 200);
      if (title && state.sessions[path]?.title !== title) { state.sessions[path] = { title }; changed = true; }
    }
    if (changed) save();
  }
  function dialog(title, initial, accept) {
    const d = el('dialog', undefined, 'csf-dialog');
    const form = el('form'); form.method = 'dialog';
    const label = el('label', title); const input = el('input');
    input.value = initial; input.maxLength = 80; input.required = true;
    label.append(input); form.append(label);
    form.append(button('Cancel', 'Cancel', () => d.close()));
    const ok = el('button', 'Save'); ok.type = 'submit'; form.append(ok);
    form.addEventListener('submit', event => {
      event.preventDefault(); const name = input.value.trim();
      if (!name) return;
      if (state.folders.some(f => f.name.toLowerCase() === name.toLowerCase() && f.name !== initial)) {
        input.setCustomValidity('A folder with this name already exists.'); input.reportValidity(); return;
      }
      accept(name); d.close();
    });
    input.addEventListener('input', () => input.setCustomValidity(''));
    d.append(form); document.body.append(d); d.addEventListener('close', () => d.remove());
    d.showModal(); input.focus(); input.select();
  }
  function change() { save(); render(); }
  function render() {
    if (!panel) return;
    const section = el('section'); section.setAttribute('aria-label', 'Codex session folders');
    const header = el('div', undefined, 'csf-header'); header.append(el('strong', 'Session folders'));
    header.append(button('+', 'Create folder', () => {
      if (state.folders.length >= 100) return status('Maximum 100 folders.');
      dialog('Folder name', '', name => { state.folders.push({ id: 'f-' + crypto.randomUUID(), name }); change(); });
    })); section.append(header);
    const search = el('input'); search.type = 'search'; search.placeholder = 'Find saved sessions';
    search.setAttribute('aria-label', 'Find saved sessions'); section.append(search);
    const list = el('div', undefined, 'csf-list'); section.append(list);
    function draw() {
      list.replaceChildren(); const query = search.value.trim().toLowerCase();
      const groups = [...state.folders, { id: '', name: 'Unfiled' }];
      for (const folder of groups) {
        const paths = Object.keys(state.sessions).filter(path => (state.assignments[path] || '') === folder.id &&
          (!query || state.sessions[path].title.toLowerCase().includes(query) || folder.name.toLowerCase().includes(query)));
        if (query && !paths.length) continue;
        const group = el('div', undefined, 'csf-group');
        const heading = el('div', undefined, 'csf-heading');
        const closed = !query && state.collapsed[folder.id] === true;
        const toggle = button(`${closed ? '▸' : '▾'} ${folder.name} (${paths.length})`, `Toggle ${folder.name}`, () => {
          state.collapsed[folder.id] = !state.collapsed[folder.id]; save(); draw();
        }); toggle.setAttribute('aria-expanded', String(!closed)); heading.append(toggle);
        if (folder.id) {
          heading.append(button('✎', `Rename ${folder.name}`, () => dialog('Rename folder', folder.name, name => { folder.name = name; change(); })));
          heading.append(button('×', `Delete ${folder.name}`, () => {
            // Removing a folder only unfiles links. Native chats are untouched.
            state.folders = state.folders.filter(f => f.id !== folder.id);
            for (const [path, id] of Object.entries(state.assignments)) if (id === folder.id) delete state.assignments[path];
            delete state.collapsed[folder.id]; change();
          }));
        }
        group.append(heading);
        if (!closed) for (const path of paths) {
          const row = el('div', undefined, 'csf-session'); row.dataset.path = path;
          const a = el('a', state.sessions[path].title); a.href = path; a.title = state.sessions[path].title;
          row.append(a);
          const select = el('select'); select.setAttribute('aria-label', `Folder for ${state.sessions[path].title}`);
          for (const f of [{ id: '', name: 'Unfiled' }, ...state.folders]) {
            const option = el('option', f.name); option.value = f.id; select.append(option);
          }
          select.value = folder.id;
          select.addEventListener('change', () => {
            if (select.value) state.assignments[path] = select.value; else delete state.assignments[path]; change();
          }); row.append(select); group.append(row);
        }
        list.append(group);
      }
      if (!state.folders.length && !query) list.prepend(el('p', 'Create a folder, then use the menu beside a session to file it.', 'csf-note'));
      if (query && !list.children.length) list.append(el('p', 'No matching saved sessions.', 'csf-note'));
    }
    search.addEventListener('input', draw); draw();
    const footer = el('div', undefined, 'csf-footer');
    footer.append(button('Export', 'Export folder backup', () => {
      const blob = new Blob([JSON.stringify({ version: 1, ...state }, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob); const a = el('a'); a.href = url; a.download = 'codex-session-folders.json'; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }));
    const file = el('input'); file.type = 'file'; file.accept = '.json,application/json'; file.hidden = true;
    footer.append(button('Import', 'Import folder backup', () => file.click()));
    file.addEventListener('change', async () => {
      try {
        const upload = file.files[0]; if (!upload) return;
        if (upload.size > 2_000_000) throw Error('Backup is too large.');
        const raw = JSON.parse(await upload.text());
        if (raw.version !== 1 || !Array.isArray(raw.folders) || !raw.sessions || typeof raw.sessions !== 'object') throw Error('Invalid backup.');
        if (!confirm('Replace this browser’s folder organization with the backup? Codex chats are unchanged.')) return;
        state = validate(raw); change();
      } catch { status('Import failed. Choose a valid version 1 folder backup.'); }
      file.value = '';
    }); footer.append(file); section.append(footer);
    section.append(el('p', 'Saved in this browser profile. Original Recents stay unchanged. Scroll Recents to discover older links.', 'csf-note'));
    const notice = el('p', '', 'csf-status'); notice.setAttribute('role', 'status'); section.append(notice);
    panel.replaceChildren(section);
  }
  function refresh() {
    const found = findSidebar(); if (!found) return;
    sidebar = found;
    if (!panel || !panel.isConnected || !sidebar.contains(panel)) {
      panel?.remove(); panel = el('div'); panel.id = PANEL; sidebar.prepend(panel); collect(); render(); return;
    }
    // Avoid rerendering while someone is searching, selecting, or editing.
    const before = JSON.stringify(state.sessions); collect();
    if (before !== JSON.stringify(state.sessions) && !panel.contains(document.activeElement)) render();
  }
  const observer = new MutationObserver(records => {
    if (records.every(r => (r.target instanceof Element ? r.target : r.target.parentElement)?.closest('#' + PANEL))) return;
    clearTimeout(timer); timer = setTimeout(refresh, 150);
  });
  (async () => {
    try { state = validate((await chrome.storage.local.get(KEY))[KEY]); }
    catch { /* A working in-memory view remains possible. */ }
    refresh(); observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['href'] });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[KEY]) return;
      const next = validate(changes[KEY].newValue);
      if (JSON.stringify(next) === JSON.stringify(state)) return;
      state = next; render();
    });
  })();
})();
