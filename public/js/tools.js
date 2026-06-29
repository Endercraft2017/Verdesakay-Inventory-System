/* Right-rail personal tools: AI assistant, Notes, Email, Scheduler, Bookmarks.
   Notes / tasks / bookmarks persist per-user via /api/notes|tasks|bookmarks.
   AI and Email are UI-only previews (no backend yet). */
(function () {
  const TOOL_ICONS = { ai: 'sparkles', notes: 'note', email: 'mail', scheduler: 'calendar', bookmarks: 'bookmark' };

  function init() {
    document.querySelectorAll('.rail-btn[data-tool]').forEach((b) => {
      b.insertAdjacentHTML('afterbegin', UI.icon(TOOL_ICONS[b.dataset.tool] || 'dot'));
      b.addEventListener('click', () => openTool(b.dataset.tool));
    });
    wireBookmarkContextMenu();
  }

  function openTool(tool) {
    if (tool === 'ai') openAI();
    else if (tool === 'notes') openNotes();
    else if (tool === 'email') openEmail();
    else if (tool === 'scheduler') openScheduler();
    else if (tool === 'bookmarks') openBookmarks();
  }

  /* ---------------- AI assistant (preview) ---------------- */
  function openAI() {
    UI.drawer({
      key: 'ai', icon: 'sparkles', title: 'AI Assistant',
      bodyHTML: `<div class="ai-chat" id="ai-chat">
          <div class="ai-msg bot">Hi! I'm your assistant. ⚠️ AI isn't connected yet — this is a preview.</div>
        </div>`,
      footHTML: `<form class="ai-input" id="ai-form">
          <input id="ai-text" placeholder="Ask me anything…" autocomplete="off" />
          <button class="btn" type="submit" aria-label="Send">${UI.icon('send', 16)}</button>
        </form>`,
      onOpen: (el) => {
        const chat = el.querySelector('#ai-chat');
        const input = el.querySelector('#ai-text');
        el.querySelector('#ai-form').addEventListener('submit', (e) => {
          e.preventDefault();
          const t = input.value.trim();
          if (!t) return;
          chat.insertAdjacentHTML('beforeend', `<div class="ai-msg user">${UI.esc(t)}</div>`);
          input.value = '';
          chat.scrollTop = chat.scrollHeight;
          setTimeout(() => {
            chat.insertAdjacentHTML('beforeend', `<div class="ai-msg bot">⚠️ AI isn't connected yet — this is a preview.</div>`);
            chat.scrollTop = chat.scrollHeight;
          }, 250);
        });
        input.focus();
      },
    });
  }

  /* ---------------- Email (preview) ---------------- */
  function openEmail() {
    UI.drawer({
      key: 'email', icon: 'mail', title: 'Email',
      bodyHTML: `
        <div class="tool-note">Email sending isn't connected yet — this is a preview.</div>
        <label>To</label><input placeholder="name@example.com" disabled />
        <label>Subject</label><input placeholder="Subject" disabled />
        <label>Message</label><textarea placeholder="Write your email…" disabled style="min-height:160px"></textarea>`,
      footHTML: `<button class="btn" disabled>${UI.icon('send', 16)} Send</button>`,
    });
  }

  /* ---------------- Notes ---------------- */
  function openNotes() {
    const d = UI.drawer({
      key: 'notes', icon: 'note', title: 'Notes',
      bodyHTML: `<div id="notes-list"><div class="empty">Loading…</div></div>`,
      footHTML: `<button class="btn" id="note-new">${UI.icon('plus', 16)} New note</button>`,
    });
    if (!d) return;
    const listEl = d.el.querySelector('#notes-list');
    async function refresh() {
      let notes;
      try { notes = await API.get('/notes'); }
      catch (e) { listEl.innerHTML = `<div class="empty">${UI.esc(e.message)}</div>`; return; }
      if (!notes.length) {
        listEl.innerHTML = UI.emptyState({ icon: 'note', title: 'No notes yet', hint: 'Jot something down with “New note”.' });
        return;
      }
      listEl.innerHTML = notes.map((n) => `
        <div class="tool-row" data-id="${n.id}">
          <div class="tool-row-main" data-edit="${n.id}">
            <div class="tool-row-title">${UI.esc(n.title || 'Untitled')}</div>
            <div class="tool-row-sub">${UI.esc((n.body || '').slice(0, 90))}</div>
          </div>
          <button class="icon-btn danger" data-del="${n.id}" title="Delete">${UI.icon('trash', 16)}</button>
        </div>`).join('');
      listEl.querySelectorAll('[data-edit]').forEach((b) =>
        b.onclick = () => noteModal(notes.find((x) => x.id == b.dataset.edit), refresh));
      listEl.querySelectorAll('[data-del]').forEach((b) =>
        b.onclick = async () => { if (await UI.confirmDialog('Delete this note?', 'Delete')) { await API.del('/notes/' + b.dataset.del); refresh(); } });
    }
    d.el.querySelector('#note-new').onclick = () => noteModal(null, refresh);
    refresh();
  }

  function noteModal(note, after) {
    UI.modal({
      title: note ? 'Edit note' : 'New note',
      bodyHTML: `<label>Title</label><input data-f="title" value="${UI.esc(note ? note.title || '' : '')}" placeholder="Title (optional)" />
        <label>Note *</label><textarea data-f="body" style="min-height:160px" placeholder="Write your note…">${UI.esc(note ? note.body || '' : '')}</textarea>`,
      confirmText: 'Save',
      onConfirm: async (ov, showErr) => {
        const title = ov.querySelector('[data-f="title"]').value;
        const body = ov.querySelector('[data-f="body"]').value.trim();
        if (!body) { showErr('Note cannot be empty'); return false; }
        if (note) await API.put('/notes/' + note.id, { title, body });
        else await API.post('/notes', { title, body });
        UI.toast('Note saved');
        after();
      },
    });
  }

  /* ---------------- Scheduler (personal tasks) ---------------- */
  function openScheduler() {
    const d = UI.drawer({
      key: 'scheduler', icon: 'calendar', title: 'Scheduler',
      bodyHTML: `
        <form class="task-add" id="task-add">
          <input id="task-title" placeholder="New task…" autocomplete="off" />
          <input id="task-date" type="date" aria-label="Due date" />
          <button class="btn" type="submit" aria-label="Add task">${UI.icon('plus', 16)}</button>
        </form>
        <div id="task-list"><div class="empty">Loading…</div></div>`,
    });
    if (!d) return;
    const listEl = d.el.querySelector('#task-list');
    async function refresh() {
      let tasks;
      try { tasks = await API.get('/tasks'); }
      catch (e) { listEl.innerHTML = `<div class="empty">${UI.esc(e.message)}</div>`; return; }
      if (!tasks.length) {
        listEl.innerHTML = UI.emptyState({ icon: 'calendar', title: 'No tasks', hint: 'Add a task above to plan your day.' });
        return;
      }
      const today = new Date(); today.setHours(0, 0, 0, 0);
      listEl.innerHTML = tasks.map((t) => {
        const overdue = !t.done && t.due_date && new Date(t.due_date) < today;
        return `<div class="tool-row task ${t.done ? 'done' : ''}" data-id="${t.id}">
          <label class="check-opt"><input type="checkbox" data-toggle="${t.id}" ${t.done ? 'checked' : ''} /></label>
          <div class="tool-row-main">
            <div class="tool-row-title">${UI.esc(t.title)}</div>
            ${t.due_date ? `<div class="tool-row-sub ${overdue ? 'overdue' : ''}">${UI.esc(t.due_date)}${overdue ? ' · overdue' : ''}</div>` : ''}
          </div>
          <button class="icon-btn danger" data-del="${t.id}" title="Delete">${UI.icon('trash', 16)}</button>
        </div>`;
      }).join('');
      listEl.querySelectorAll('[data-toggle]').forEach((c) =>
        c.onchange = async () => { await API.put('/tasks/' + c.dataset.toggle, { done: c.checked }); refresh(); });
      listEl.querySelectorAll('[data-del]').forEach((b) =>
        b.onclick = async () => { await API.del('/tasks/' + b.dataset.del); refresh(); });
    }
    d.el.querySelector('#task-add').addEventListener('submit', async (e) => {
      e.preventDefault();
      const title = d.el.querySelector('#task-title').value.trim();
      const due = d.el.querySelector('#task-date').value;
      if (!title) return;
      await API.post('/tasks', { title, due_date: due || null });
      d.el.querySelector('#task-title').value = '';
      d.el.querySelector('#task-date').value = '';
      refresh();
    });
    refresh();
  }

  /* ---------------- Bookmarks ---------------- */
  function openBookmarks() {
    const d = UI.drawer({
      key: 'bookmarks', icon: 'bookmark', title: 'Bookmarks',
      bodyHTML: `<div id="bm-list"><div class="empty">Loading…</div></div>`,
      footHTML: `<button class="btn" id="bm-add">${UI.icon('star', 16)} Bookmark current page</button>`,
    });
    if (!d) return;
    const listEl = d.el.querySelector('#bm-list');
    async function refresh() {
      let bms;
      try { bms = await API.get('/bookmarks'); }
      catch (e) { listEl.innerHTML = `<div class="empty">${UI.esc(e.message)}</div>`; return; }
      if (!bms.length) {
        listEl.innerHTML = UI.emptyState({ icon: 'bookmark', title: 'No bookmarks', hint: 'Bookmark a page here, or right-click a menu item.' });
        return;
      }
      listEl.innerHTML = bms.map((b) => `
        <div class="tool-row" data-id="${b.id}">
          <div class="tool-row-main" data-go="${b.id}">
            <div class="tool-row-title">${UI.icon('bookmark', 13)} ${UI.esc(b.label)}</div>
          </div>
          <button class="icon-btn danger" data-del="${b.id}" title="Delete">${UI.icon('trash', 16)}</button>
        </div>`).join('');
      listEl.querySelectorAll('[data-go]').forEach((el) =>
        el.onclick = () => { const b = bms.find((x) => x.id == el.dataset.go); App.navigate(b.route, b.params || undefined); d.close(); });
      listEl.querySelectorAll('[data-del]').forEach((b) =>
        b.onclick = async () => { await API.del('/bookmarks/' + b.dataset.del); refresh(); });
    }
    d.el.querySelector('#bm-add').onclick = async () => {
      const loc = App.currentLocation();
      await addBookmark(loc.label, loc.route, loc.filter);
      refresh();
    };
    refresh();
  }

  async function addBookmark(label, route, params) {
    try {
      await API.post('/bookmarks', { label, route, params: params || null });
      UI.toast('Bookmark added');
    } catch (e) { UI.toast(e.message, 'error'); }
  }

  /* ---------------- Right-click a nav item → add bookmark ---------------- */
  function wireBookmarkContextMenu() {
    document.addEventListener('contextmenu', (e) => {
      const el = e.target.closest('.tree-leaf, .primary-item');
      if (!el) return;
      e.preventDefault();

      let route = null, params = null, label = el.textContent.trim();
      if (el.classList.contains('tree-leaf')) {
        route = el.dataset.route;
        params = el.dataset.filter ? JSON.parse(el.dataset.filter) : null;
      } else if (typeof NAV !== 'undefined') {
        const p = NAV.find((x) => x.id === el.dataset.primary);
        const first = p && p.subtabs[0] && p.subtabs[0].tree[0];
        if (first) { route = first.route; params = first.filter || null; label = p.label; }
      }

      const items = [];
      if (route) items.push({ label: `Bookmark “${label}”`, icon: 'star', onClick: () => addBookmark(label, route, params) });
      items.push({ label: 'Bookmark current page', icon: 'bookmark', onClick: () => { const loc = App.currentLocation(); addBookmark(loc.label, loc.route, loc.filter); } });
      UI.contextMenu(e.clientX, e.clientY, items);
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
