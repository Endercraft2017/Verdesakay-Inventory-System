/* Right-rail personal tools: AI assistant, Notes, Email, Scheduler, Bookmarks.
   Notes / tasks / bookmarks persist per-user via /api/notes|tasks|bookmarks.
   AI talks to the real POST /api/ai/chat agentic backend (src/routes/ai.routes.ts +
   src/ai-tools.ts) — see docs/AI-AGENT.md. Email sends for real via BYO-SMTP
   (src/mailer.ts, /api/mail/*) — Settings configures the mailbox, Sent log shows
   src/mailer.ts's mail_log (users.manage for both). */
(function () {
  const TOOL_ICONS = { ai: 'sparkles', notes: 'note', email: 'mail', scheduler: 'calendar', bookmarks: 'bookmark', help: 'help' };

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
    else if (tool === 'help' && window.Help) window.Help.open();
  }

  /* ---------------- AI assistant ---------------- */
  // Conversation history for the agentic loop — the server is stateless, so the client
  // resends the full thread each turn. Cleared whenever the drawer is (re)opened.
  let aiHistory = [];

  function mdLite(s) {
    // Light markdown over already-escaped text: **bold**, `code`, line breaks.
    return UI.esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+?)`/g, '<code>$1</code>')
      .replace(/\n/g, '<br>');
  }

  function toolLabel(name) {
    return String(name || '').replace(/_/g, ' ');
  }

  /** Collect any report files the assistant generated this turn. */
  function reportFiles(steps) {
    const out = [];
    (steps || []).forEach((s) => {
      const files = s && s.result && s.result.data && s.result.data.files;
      if (Array.isArray(files)) files.forEach((f) => f && f.url && out.push(f));
    });
    return out;
  }
  function reportLinksHTML(steps) {
    const files = reportFiles(steps);
    if (!files.length) return '';
    return `<div class="ai-reports">${files.map((f) =>
      `<button type="button" class="btn secondary small ai-report-dl" data-url="${UI.esc(f.url)}" data-name="${UI.esc(f.name)}">${UI.icon('download', 14)} ${UI.esc((f.format || 'file').toUpperCase())}</button>`
    ).join('')}</div>`;
  }
  function wireReportLinks(msgEl) {
    if (!msgEl) return;
    msgEl.querySelectorAll('.ai-report-dl').forEach((b) => b.onclick = async () => {
      try {
        const url = await API.blobUrl(b.dataset.url);
        const a = document.createElement('a');
        a.href = url; a.download = b.dataset.name.replace(/^ai-report-/, '').replace(/-\d{10,}-[a-f0-9]+(\.\w+)$/, '$1');
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
      } catch (e) { UI.toast(e.message, 'error'); }
    });
  }

  function openAI() {
    aiHistory = [];
    UI.drawer({
      key: 'ai', icon: 'sparkles', title: 'AI Assistant',
      bodyHTML: `<div class="ai-chat" id="ai-chat">
          <div class="ai-msg bot">Hi! I'm your assistant — ask me about inventory, orders, messages, or your notes and tasks.</div>
        </div>`,
      footHTML: `${App.hasPermission('users.manage') ? `<button class="btn secondary" id="ai-config" style="margin-bottom:8px">${UI.icon('settings', 15)} AI settings</button>` : ''}
        <form class="ai-input" id="ai-form">
          <input id="ai-text" placeholder="Ask me anything…" autocomplete="off" />
          <button class="btn" type="submit" aria-label="Send">${UI.icon('send', 16)}</button>
        </form>`,
      onOpen: (el) => {
        const chat = el.querySelector('#ai-chat');
        const input = el.querySelector('#ai-text');
        const form = el.querySelector('#ai-form');
        const submitBtn = form.querySelector('button[type="submit"]');
        const cfgBtn = el.querySelector('#ai-config');
        if (cfgBtn) cfgBtn.onclick = () => aiSettingsModal();

        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const t = input.value.trim();
          if (!t) return;
          chat.insertAdjacentHTML('beforeend', `<div class="ai-msg user">${UI.esc(t)}</div>`);
          input.value = '';
          input.disabled = true;
          submitBtn.disabled = true;
          aiHistory.push({ role: 'user', content: t });
          chat.scrollTop = chat.scrollHeight;

          const typingId = 'ai-typing-' + Date.now();
          chat.insertAdjacentHTML('beforeend',
            `<div class="ai-msg bot ai-typing" id="${typingId}"><span></span><span></span><span></span></div>`);
          chat.scrollTop = chat.scrollHeight;

          try {
            const res = await API.post('/ai/chat', { messages: aiHistory });
            const typingEl = document.getElementById(typingId);
            if (typingEl) typingEl.remove();

            const chips = (res.steps || []).map((s) =>
              `<span class="ai-chip">${UI.esc(toolLabel(s.tool))}</span>`).join('');
            const chipsHTML = chips ? `<div class="ai-chips">${chips}</div>` : '';
            chat.insertAdjacentHTML('beforeend',
              `<div class="ai-msg bot">${chipsHTML}<div>${mdLite(res.reply || '')}</div>${reportLinksHTML(res.steps)}</div>`);
            wireReportLinks(chat.lastElementChild);
            aiHistory.push({ role: 'assistant', content: res.reply || '' });
          } catch (err) {
            const typingEl = document.getElementById(typingId);
            if (typingEl) typingEl.remove();
            chat.insertAdjacentHTML('beforeend', `<div class="ai-msg bot ai-error">${UI.esc(err.message)}</div>`);
            aiHistory.pop(); // don't carry a failed turn's user message forward
          } finally {
            input.disabled = false;
            submitBtn.disabled = false;
            chat.scrollTop = chat.scrollHeight;
            input.focus();
          }
        });
        input.focus();
      },
    });
  }

  async function aiSettingsModal() {
    let c;
    try { c = await API.get('/ai/config'); } catch (e) { UI.toast(e.message, 'error'); return; }
    const srcNote = c.key_source === 'tenant' ? 'a key is set for this workspace'
      : c.key_source === 'platform' ? 'using the platform key (no workspace key set)'
      : 'no key set — the assistant is disabled';
    UI.modal({
      title: 'AI Assistant settings',
      size: 'lg',
      bodyHTML: `<div class="form-grid">
        <div class="form-field span2"><div class="field-label"><label>API key
          <span class="muted">— ${srcNote}; leave blank to keep${c.key_source === 'tenant' ? '' : ' the platform key'}</span></label></div>
          <input data-f="api_key" type="password" autocomplete="new-password"
            placeholder="${c.key_source === 'tenant' ? '••••••••' : 'AIza… / sk-… / csk-…'}" /></div>
        <div class="form-field span2"><div class="field-label"><label>Preset</label></div>
          <select data-f="preset">
            <option value="">— choose a provider to fill the fields below —</option>
            <option value="gemini">Google Gemini — Flash-Lite ("mini")</option>
            <option value="gemini-flash">Google Gemini — 2.5 Flash</option>
            <option value="openai">OpenAI — GPT-4o mini</option>
            <option value="groq">Groq — Llama 3.1 8B</option>
            <option value="cerebras">Cerebras — Llama 4 Scout</option>
            <option value="openrouter">OpenRouter</option>
          </select></div>
        <div class="form-field"><div class="field-label"><label>Model</label></div>
          <input data-f="model" value="${UI.esc(c.model || '')}" placeholder="gemini-2.5-flash-lite" /></div>
        <div class="form-field"><div class="field-label"><label>Endpoint</label></div>
          <input data-f="base_url" value="${UI.esc(c.base_url || '')}" placeholder="https://generativelanguage.googleapis.com/v1beta/openai/chat/completions" /></div>
      </div>
      <p class="muted" style="font-size:12px;margin:10px 0 0">Any OpenAI-compatible chat-completions API works.
        The default is <strong>Gemini Flash-Lite</strong> — high context, low cost. Clearing the key falls back
        to the platform key if one is configured.</p>`,
      confirmText: 'Save',
      onOpen: (ov) => {
        const PRESETS = {
          gemini: ['gemini-2.5-flash-lite', 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'],
          'gemini-flash': ['gemini-2.5-flash', 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'],
          openai: ['gpt-4o-mini', 'https://api.openai.com/v1/chat/completions'],
          groq: ['llama-3.1-8b-instant', 'https://api.groq.com/openai/v1/chat/completions'],
          cerebras: ['llama-4-scout-17b-16e-instruct', 'https://api.cerebras.ai/v1/chat/completions'],
          openrouter: ['google/gemini-2.5-flash-lite', 'https://openrouter.ai/api/v1/chat/completions'],
        };
        ov.querySelector('[data-f="preset"]').addEventListener('change', (e) => {
          const p = PRESETS[e.target.value];
          if (!p) return;
          ov.querySelector('[data-f="model"]').value = p[0];
          ov.querySelector('[data-f="base_url"]').value = p[1];
        });
      },
      onConfirm: async (ov) => {
        const g = (k) => ov.querySelector(`[data-f="${k}"]`).value.trim();
        const body = { model: g('model'), base_url: g('base_url') };
        const key = g('api_key');
        if (key) body.api_key = key;
        await API.put('/ai/config', body);
        UI.toast('AI settings saved');
      },
    });
  }

  /* ---------------- Email (preview) ---------------- */
  function openEmail() {
    const canSend = App.hasPermission('mail.send');
    const canConfig = App.hasPermission('users.manage');
    UI.drawer({
      key: 'email', icon: 'mail', title: 'Email',
      bodyHTML: canSend
        ? `<label>To</label><input id="em-to" type="email" placeholder="name@example.com" />
           <label>Subject</label><input id="em-subj" placeholder="Subject" />
           <label>Message</label><textarea id="em-body" placeholder="Write your email…" style="min-height:180px"></textarea>
           <div id="em-status" class="muted" style="font-size:12px;margin-top:6px"></div>`
        : `<div class="tool-note">You don't have permission to send email.${canConfig ? ' You can still configure the mailbox below.' : ''}</div>`,
      footHTML: `${canConfig ? `<button class="btn secondary" id="em-config">${UI.icon('settings', 15)} Settings</button>
        <button class="btn secondary" id="em-log">${UI.icon('history', 15)} Sent log</button>` : ''}
        ${canSend ? `<button class="btn" id="em-send">${UI.icon('send', 16)} Send</button>` : ''}`,
      onOpen: (el) => {
        const cfg = el.querySelector('#em-config');
        if (cfg) cfg.onclick = () => mailSettingsModal();
        const logBtn = el.querySelector('#em-log');
        if (logBtn) logBtn.onclick = () => mailLogModal();
        const send = el.querySelector('#em-send');
        if (send) send.onclick = async () => {
          const g = (id) => el.querySelector(id);
          const to = g('#em-to').value.trim(), subject = g('#em-subj').value.trim(), body = g('#em-body').value.trim();
          const st = g('#em-status');
          if (!to || !subject || !body) { st.textContent = 'Fill in all three fields.'; return; }
          send.disabled = true; st.textContent = 'Sending…';
          try {
            await API.post('/mail/send', { to, subject, body });
            st.textContent = 'Sent ✓';
            g('#em-to').value = ''; g('#em-subj').value = ''; g('#em-body').value = '';
          } catch (e) { st.textContent = e.message; }
          finally { send.disabled = false; }
        };
      },
    });
  }

  async function mailSettingsModal() {
    let s;
    try { s = await API.get('/mail/settings'); } catch (e) { UI.toast(e.message, 'error'); return; }
    const chk = (b) => (b ? 'checked' : '');
    UI.modal({
      title: 'Email settings',
      size: 'lg',
      bodyHTML: `<div class="form-grid">
        <div class="form-field span2"><div class="field-label"><label>Send email via</label></div>
          <select data-f="transport">
            <option value="off" ${s.transport === 'off' ? 'selected' : ''}>Off — email disabled</option>
            <option value="smtp" ${s.transport === 'smtp' ? 'selected' : ''}>SMTP — your company mailbox</option>
          </select></div>
        <div class="form-field"><div class="field-label"><label>From name</label></div>
          <input data-f="from_name" value="${UI.esc(s.from_name || '')}" placeholder="Verdesakay Office" /></div>
        <div class="form-field"><div class="field-label"><label>From email <span class="req">*</span></label></div>
          <input data-f="from_email" type="email" value="${UI.esc(s.from_email || '')}" placeholder="office@yourcompany.com" /></div>
        <div class="form-field span2"><div class="field-label"><label>Reply-to (optional)</label></div>
          <input data-f="reply_to" type="email" value="${UI.esc(s.reply_to || '')}" /></div>
        <div class="form-field"><div class="field-label"><label>SMTP host <span class="req">*</span></label></div>
          <input data-f="smtp_host" value="${UI.esc(s.smtp_host || '')}" placeholder="smtp.gmail.com" /></div>
        <div class="form-field"><div class="field-label"><label>Port</label></div>
          <input data-f="smtp_port" type="number" value="${s.smtp_port || 587}" /></div>
        <div class="form-field inline"><label class="check-opt">
          <input type="checkbox" data-f="smtp_secure" ${chk(s.smtp_secure)} /> Use SSL (port 465)</label></div>
        <div class="form-field"><div class="field-label"><label>SMTP username</label></div>
          <input data-f="smtp_user" value="${UI.esc(s.smtp_user || '')}" placeholder="usually the From email" /></div>
        <div class="form-field span2"><div class="field-label"><label>SMTP password / app-password
          ${s.has_password ? '<span class="muted">— saved; leave blank to keep</span>' : ''}</label></div>
          <input data-f="smtp_pass" type="password" placeholder="${s.has_password ? '••••••••' : ''}" autocomplete="new-password" /></div>
        <div class="form-field span2"><div class="field-label"><label>Send a test email to</label></div>
          <div style="display:flex;gap:8px">
            <input data-f="test_to" type="email" placeholder="you@example.com" style="flex:1" />
            <button type="button" class="btn secondary" id="ms-test">Save &amp; test</button></div>
          <div id="ms-teststatus" class="muted" style="font-size:12px;margin-top:4px"></div></div>
      </div>
      <p class="muted" style="font-size:12px;margin:10px 0 0">Gmail and Microsoft 365 need a 2-factor <strong>app password</strong>, not your normal login password.</p>`,
      confirmText: 'Save',
      onOpen: (ov) => {
        ov.querySelector('#ms-test').onclick = async () => {
          const to = ov.querySelector('[data-f="test_to"]').value.trim();
          const st = ov.querySelector('#ms-teststatus');
          if (!to) { st.textContent = 'Enter a recipient for the test.'; return; }
          st.textContent = 'Saving and sending…';
          try { await saveMail(ov); await API.post('/mail/test', { to }); st.textContent = 'Test email sent ✓'; }
          catch (e) { st.textContent = e.message; }
        };
      },
      onConfirm: async (ov) => { await saveMail(ov); UI.toast('Email settings saved'); },
    });

    async function saveMail(ov) {
      const g = (k) => ov.querySelector(`[data-f="${k}"]`);
      const body = {
        transport: g('transport').value,
        from_name: g('from_name').value.trim(),
        from_email: g('from_email').value.trim(),
        reply_to: g('reply_to').value.trim(),
        smtp_host: g('smtp_host').value.trim(),
        smtp_port: Number(g('smtp_port').value) || 587,
        smtp_secure: g('smtp_secure').checked,
        smtp_user: g('smtp_user').value.trim(),
      };
      const pw = g('smtp_pass').value;
      if (pw) body.smtp_pass = pw;
      await API.put('/mail/settings', body);
    }
  }

  async function mailLogModal() {
    const PAGE = 50;
    let offset = 0;
    let rows = [];
    UI.modal({
      title: 'Sent mail log',
      size: 'lg',
      cancelText: 'Close',
      confirmText: null,
      bodyHTML: `<div id="ml-body"><div class="empty">Loading…</div></div>`,
      onOpen: (ov) => load(ov),
    });
    async function load(ov) {
      const body = ov.querySelector('#ml-body');
      let page;
      try { page = await API.get(`/mail/log?limit=${PAGE}&offset=${offset}`); }
      catch (e) { body.innerHTML = `<div class="empty">${UI.esc(e.message)}</div>`; return; }
      rows = rows.concat(page);
      if (!rows.length) { body.innerHTML = UI.emptyState({ icon: 'mail', title: 'No email sent yet', hint: 'Sends show up here once Email settings has a working mailbox.' }); return; }
      body.innerHTML = `
        <table><thead><tr><th>Sent</th><th>To</th><th>Subject</th><th>Status</th><th>By</th></tr></thead>
          <tbody>${rows.map((r) => `<tr>
            <td class="muted mono" style="white-space:nowrap">${UI.esc((r.created_at || '').replace('T', ' ').slice(0, 16))}</td>
            <td>${UI.esc(r.to_addr)}</td>
            <td>${UI.esc(r.subject || '—')}</td>
            <td><span class="badge-pill ${r.status === 'sent' ? 'status-completed' : 'status-cancelled'}" ${r.error ? `title="${UI.esc(r.error)}"` : ''}>${r.status}</span></td>
            <td class="muted">${UI.esc(r.sent_by_name || 'system')}</td>
          </tr>`).join('')}</tbody></table>
        ${page.length === PAGE ? `<button type="button" class="btn secondary small" id="ml-more" style="margin-top:10px">Load more</button>` : ''}`;
      const more = body.querySelector('#ml-more');
      if (more) more.onclick = () => { offset += PAGE; load(ov); };
    }
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
