(() => {
  'use strict';
  if (window.__codexSessionFolders) return;
  window.__codexSessionFolders = true;
  const KEY = 'codex-session-folders-v1';
  const PANEL = 'csf-panel';
  const defaultLayout = () => ({ mode: 'docked', hidden: false, x: 90, y: 90, width: 360, height: 460 });
  let state = { folders: [], assignments: {}, sessions: {}, collapsed: {}, uiOpen: false, layout: defaultLayout() };
  let sidebar, panel, launcher, timer;
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
    const next = { folders: [], assignments: {}, sessions: {}, collapsed: {}, uiOpen: false, layout: defaultLayout() };
    if (!raw || typeof raw !== 'object') return next;
    next.uiOpen = raw.uiOpen === true;
    if (raw.layout && typeof raw.layout === 'object') {
      next.layout.mode = raw.layout.mode === 'floating' ? 'floating' : 'docked';
      next.layout.hidden = raw.layout.hidden === true;
      for (const key of ['x', 'y', 'width', 'height']) {
        if (Number.isFinite(raw.layout[key])) next.layout[key] = Math.max(-10000, Math.min(10000, raw.layout[key]));
      }
    }
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
    // Reject the global navigation rail and broad page wrappers. Choose the
    // smallest visible history container, not the first sidebar-like ancestor.
    const candidates = [...document.querySelectorAll('nav, aside, [data-testid*="sidebar"], [id*="sidebar"]')];
    const valid = candidates.filter(node => {
      if (node.closest('#' + PANEL) || node.querySelector('main, [role="main"]')) return false;
      const box = node.getBoundingClientRect();
      if (box.width < 220 || box.width > 440 || box.height < 80 || box.left < 0 || box.right > innerWidth) return false;
      if (getComputedStyle(node).visibility === 'hidden' || getComputedStyle(node).display === 'none') return false;
      return [...node.querySelectorAll('a[href]')].some(a => !a.closest('#' + PANEL) && sessionPath(a.getAttribute('href')));
    });
    return valid.find(node => !valid.some(other => other !== node && node.contains(other))) || null;
  }
  function ensureLauncher() {
    if (!launcher || !launcher.isConnected) {
      launcher = button('▦ Folders', 'Show session folders', () => {
        state.layout.hidden = false;
        if (!findSidebar()) state.layout.mode = 'floating';
        state.uiOpen = true; change();
      });
      launcher.id = 'csf-launcher'; document.body.append(launcher);
    }
    const needed = state.layout.hidden || (state.layout.mode === 'docked' && !sidebar);
    launcher.hidden = !needed;
  }
  function mount() {
    panel?.remove(); panel = el('div'); panel.id = PANEL;
    if (state.layout.mode === 'floating') { document.body.append(panel); return; }
    const heading = [...sidebar.querySelectorAll('h1,h2,h3,h4,[role="heading"],[data-app-action-sidebar-section-heading]')]
      .find(node => !node.closest('#' + PANEL) && /^(Recents|Recent chats|Your chats)$/i.test(node.textContent.trim()));
    if (heading) heading.before(panel); else sidebar.prepend(panel);
  }
  const clamp = (n, low, high) => Math.max(low, Math.min(n, Math.max(low, high)));
  function fitLayout() {
    const l = state.layout, margin = 12;
    l.width = clamp(l.width, Math.min(280, innerWidth - margin * 2), innerWidth - margin * 2);
    l.height = clamp(l.height, Math.min(260, innerHeight - margin * 2), innerHeight - margin * 2);
    l.x = clamp(l.x, margin, innerWidth - l.width - margin);
    l.y = clamp(l.y, margin, innerHeight - (state.uiOpen ? l.height : 50) - margin);
  }
  function applyLayout() {
    if (!panel) return;
    fitLayout(); const l = state.layout;
    panel.dataset.mode = l.mode; panel.dataset.open = String(state.uiOpen);
    panel.style.setProperty('--csf-x', `${l.x}px`); panel.style.setProperty('--csf-y', `${l.y}px`);
    panel.style.setProperty('--csf-width', `${l.width}px`); panel.style.setProperty('--csf-height', `${l.height}px`);
  }
  function geometryControl(node, resize) {
    node.addEventListener('pointerdown', event => {
      if (state.layout.mode !== 'floating' || event.button !== 0) return;
      event.preventDefault(); fitLayout();
      const start = { ...state.layout, px: event.clientX, py: event.clientY };
      node.setPointerCapture(event.pointerId);
      const move = e => {
        const dx = e.clientX - start.px, dy = e.clientY - start.py;
        if (resize) { state.layout.width = start.width + dx; state.layout.height = start.height + dy; }
        else { state.layout.x = start.x + dx; state.layout.y = start.y + dy; }
        applyLayout();
      };
      const end = () => {
        node.removeEventListener('pointermove', move); node.removeEventListener('pointerup', end);
        node.removeEventListener('pointercancel', end); node.removeEventListener('lostpointercapture', end); save();
      };
      node.addEventListener('pointermove', move); node.addEventListener('pointerup', end);
      node.addEventListener('pointercancel', end); node.addEventListener('lostpointercapture', end);
    });
    node.addEventListener('keydown', event => {
      if (state.layout.mode !== 'floating' || !['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) return;
      event.preventDefault(); const delta = event.shiftKey ? 32 : 12;
      const axis = event.key === 'ArrowLeft' || event.key === 'ArrowRight' ? (resize ? 'width' : 'x') : (resize ? 'height' : 'y');
      state.layout[axis] += ['ArrowLeft','ArrowUp'].includes(event.key) ? -delta : delta; applyLayout(); save();
    });
  }
  function collect() {
    if (!sidebar) return;
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
  function change() { save(); refresh(true); }
  function render() {
    if (!panel) return;
    const section = el('section'); section.setAttribute('aria-label', 'Codex session folders');
    const header = el('div', undefined, 'csf-header');
    if (state.layout.mode === 'floating') {
      const grip = button('⠿', 'Move panel', () => {}); grip.className = 'csf-drag';
      grip.title = 'Drag to move · arrow keys also work'; geometryControl(grip, false); header.append(grip);
    }
    const togglePanel = button(`${state.uiOpen ? '▾' : '▸'} Session folders`, 'Toggle session folders', () => { state.uiOpen = !state.uiOpen; change(); });
    togglePanel.setAttribute('aria-expanded', String(state.uiOpen)); togglePanel.className = 'csf-title'; header.append(togglePanel);
    header.append(button('+', 'Create folder', () => {
      if (state.folders.length >= 100) return status('Maximum 100 folders.');
      state.uiOpen = true;
      dialog('Folder name', '', name => { state.folders.push({ id: 'f-' + crypto.randomUUID(), name }); change(); });
    }));
    header.append(button(state.layout.mode === 'floating' ? '↙' : '↗', state.layout.mode === 'floating' ? 'Dock panel' : 'Float panel', () => {
      if (state.layout.mode === 'floating' && !findSidebar()) { status('Open the chat sidebar before docking.'); return; }
      state.layout.mode = state.layout.mode === 'floating' ? 'docked' : 'floating';
      state.uiOpen = true; change();
    }));
    header.append(button('×', 'Hide panel', () => { state.layout.hidden = true; change(); launcher?.focus(); }));
    section.append(header);
    const body = el('div', undefined, 'csf-body'); body.hidden = !state.uiOpen; section.append(body);
    const search = el('input'); search.type = 'search'; search.placeholder = 'Find saved sessions';
    search.setAttribute('aria-label', 'Find saved sessions'); body.append(search);
    const list = el('div', undefined, 'csf-list'); body.append(list);
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
        const wasOpen = state.uiOpen, layout = state.layout; state = validate(raw); state.uiOpen = wasOpen; state.layout = layout; change();
      } catch { status('Import failed. Choose a valid version 1 folder backup.'); }
      file.value = '';
    }); footer.append(file); body.append(footer);
    body.append(el('p', 'Saved in this browser profile. Original Recents stay unchanged. Scroll Recents to discover older links.', 'csf-note'));
    const notice = el('p', '', 'csf-status'); notice.setAttribute('role', 'status'); body.append(notice);
    if (state.layout.mode === 'floating' && state.uiOpen) {
      const handle = button('◢', 'Resize panel', () => {}); handle.className = 'csf-resize';
      handle.title = 'Drag to resize · arrow keys also work'; geometryControl(handle, true); section.append(handle);
    }
    section.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); state.layout.hidden = true; change(); launcher?.focus(); }
    });
    panel.replaceChildren(section); applyLayout();
  }
  function refresh(force = false) {
    sidebar = findSidebar();
    // Only activate on a Codex session or a page with recognizable session history.
    if (!sidebar && !sessionPath(location.href) && !panel) return;
    ensureLauncher();
    if (state.layout.hidden || (state.layout.mode === 'docked' && !sidebar)) {
      panel?.remove(); panel = null; return;
    }
    const floating = state.layout.mode === 'floating';
    if (!panel || !panel.isConnected || panel.dataset.mode !== state.layout.mode || (!floating && !sidebar.contains(panel))) {
      mount(); collect(); render(); return;
    }
    const before = JSON.stringify(state.sessions); collect(); applyLayout();
    if (force || (before !== JSON.stringify(state.sessions) && !panel.contains(document.activeElement))) render();
  }
  const observer = new MutationObserver(records => {
    if (records.every(r => (r.target instanceof Element ? r.target : r.target.parentElement)?.closest('#' + PANEL + ', #csf-launcher'))) return;
    clearTimeout(timer); timer = setTimeout(refresh, 150);
  });
  window.addEventListener('resize', () => { clearTimeout(timer); timer = setTimeout(refresh, 150); });
  (async () => {
    try { state = validate((await chrome.storage.local.get(KEY))[KEY]); }
    catch { /* A working in-memory view remains possible. */ }
    refresh(); observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['href', 'class', 'style', 'hidden', 'aria-hidden'] });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[KEY]) return;
      const next = validate(changes[KEY].newValue);
      if (JSON.stringify(next) === JSON.stringify(state)) return;
      state = next; refresh(true);
    });
  })();
})();
