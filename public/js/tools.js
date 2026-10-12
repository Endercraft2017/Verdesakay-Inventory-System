/* Right-rail personal tools: AI assistant, Notes, Email, Scheduler, Bookmarks.
   Notes / tasks / bookmarks persist per-user via /api/notes|tasks|bookmarks.
   AI talks to the real POST /api/ai/chat agentic backend (src/routes/ai.routes.ts +
   src/ai-tools.ts) — see docs/AI-AGENT.md. Email sends for real via BYO-SMTP
   (src/mailer.ts, /api/mail/*) — Settings configures the mailbox, Sent log shows
   src/mailer.ts's mail_log (users.manage for both). */
(function () {
  const TOOL_ICONS = { notes: 'note', email: 'mail', scheduler: 'calendar', bookmarks: 'bookmark', help: 'help', bug: 'bug' };

  function init() {
    document.querySelectorAll('.rail-btn[data-tool]').forEach((b) => {
      b.insertAdjacentHTML('afterbegin', UI.icon(TOOL_ICONS[b.dataset.tool] || 'dot'));
      b.addEventListener('click', () => openTool(b.dataset.tool));
    });
    document.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.tool-row-main[role="button"]')) { e.preventDefault(); e.target.click(); } });
    wireBookmarkContextMenu();
    const fab = document.getElementById('ai-fab');
    if (fab) {
      fab.insertAdjacentHTML('afterbegin', UI.icon('sparkles', 22));
      fab.addEventListener('click', toggleAI);
    }
  }

  function openTool(tool) {
    if (tool === 'notes') openNotes();
    else if (tool === 'email') openEmail();
    else if (tool === 'scheduler') openScheduler();
    else if (tool === 'bookmarks') openBookmarks();
    else if (tool === 'bug') openBugReport();
    else if (tool === 'help' && window.Help) window.Help.open();
  }

  /* ---------------- AI assistant ---------------- */
  // The conversation is saved server-side (ai_messages, per user) and survives reloads —
  // it's only cleared when the user hits "Clear conversation". `aiHistory` is just the
  // context sent to the LLM each turn: the /chat route is otherwise stateless per call, so
  // the client resends recent history and the route persists the new turn as a side effect
  // (see GET/DELETE /api/ai/messages in src/routes/ai.routes.ts). Capped below the route's
  // 40-message ceiling so a long-lived conversation never fails validation.
  let aiHistory = [];
  const AI_HISTORY_LIMIT = 38;

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
  /** A pressable "View X" jump for a step that created (or otherwise points at) a real
      record — job/sale/purchase order, inventory item, account, note, task. Returns null
      for steps that don't map to anywhere navigable (most tools: reads, sends, etc). */
  function actionForStep(step) {
    if (!step || !step.result || step.result.success === false) return null;
    const d = step.result.data || {};
    if (step.tool === 'create_inventory_item' && d.id) {
      return { label: 'View item', run: () => App.navigate('inventory', { id: d.id }) };
    }
    if (step.tool === 'create_order' && d.id && d.type) {
      const noun = d.type === 'job' ? 'job order' : d.type === 'purchase' ? 'purchase request' : 'sale order';
      return { label: `View ${noun}`, run: () => App.navigate('orders', { type: d.type, id: d.id }) };
    }
    if (step.tool === 'create_user' && d.id) {
      return { label: 'View account', run: () => App.navigate('admin', { id: d.id }) };
    }
    if (step.tool === 'create_note') {
      return { label: 'Open Notes', run: () => openNotes() };
    }
    if (step.tool === 'create_task') {
      return { label: 'Open Tasks', run: () => openScheduler() };
    }
    if (step.tool === 'propose_form_record' && d.proposed && (d.form_def_id || d.slug)) {
      return {
        label: `Review & issue ${d.form_name || 'form'}`,
        run: () => App.openFormRecordDraft && App.openFormRecordDraft(d),
      };
    }
    return null;
  }
  function recordLinksHTML(steps) {
    const actions = (steps || []).map((s, i) => ({ i, a: actionForStep(s) })).filter((x) => x.a);
    if (!actions.length) return '';
    return `<div class="ai-reports">${actions.map(({ i, a }) =>
      `<button type="button" class="btn secondary small ai-record-view" data-step="${i}">${UI.icon('eye', 14)} ${UI.esc(a.label)}</button>`
    ).join('')}</div>`;
  }
  function wireRecordLinks(msgEl, steps) {
    if (!msgEl) return;
    msgEl.querySelectorAll('.ai-record-view').forEach((b) => b.onclick = () => {
      const step = (steps || [])[Number(b.dataset.step)];
      const a = actionForStep(step);
      if (a) a.run();
    });
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

  // The AI assistant is its own floating corner widget (bubble + small fixed-size panel),
  // not one of the generic right-rail .drawer tools — a chat interface reads better as a
  // compact, always-in-the-corner thing than a full-height sidebar. Toggled by #ai-fab.
  let aiOpen = false;
  let aiEscHandler = null;

  function toggleAI() {
    if (window.App && App.getMe() && !App.hasModule('ai')) return; // module off for this workspace
    if (aiOpen) closeAI(); else openAI();
  }

  function closeAI() {
    aiOpen = false;
    const fab = document.getElementById('ai-fab');
    if (fab) fab.classList.remove('open');
    const root = document.getElementById('ai-widget-root');
    const w = root && root.querySelector('.ai-widget');
    if (document.activeElement && w && w.contains(document.activeElement)) document.activeElement.blur();
    if (aiEscHandler) { document.removeEventListener('keydown', aiEscHandler); aiEscHandler = null; }
    if (!w) return;
    w.classList.remove('open');
    setTimeout(() => { if (!aiOpen) root.innerHTML = ''; }, 180);
  }

  const AI_GREETING = "Hi! I'm your assistant — ask me about inventory, orders, messages, or your notes and tasks.";

  /** Append a finished assistant turn (chips + reply + record/report links), wiring its
      buttons. Shared by the live reply path and by replaying saved history on open. */
  function renderBotTurn(chat, reply, steps) {
    const chips = (steps || []).map((s) =>
      `<span class="ai-chip">${UI.esc(toolLabel(s.tool))}</span>`).join('');
    const chipsHTML = chips ? `<div class="ai-chips">${chips}</div>` : '';
    chat.insertAdjacentHTML('beforeend',
      `<div class="ai-msg bot">${chipsHTML}<div>${mdLite(reply || '')}</div>${recordLinksHTML(steps)}${reportLinksHTML(steps)}</div>`);
    wireRecordLinks(chat.lastElementChild, steps);
    wireReportLinks(chat.lastElementChild);
  }

  async function loadAiHistory(chat) {
    let saved = [];
    try { saved = await API.get('/ai/messages'); } catch { saved = []; }
    chat.innerHTML = '';
    if (!saved.length) {
      chat.insertAdjacentHTML('beforeend', `<div class="ai-msg bot">${AI_GREETING}</div>`);
      aiHistory = [];
      return;
    }
    saved.forEach((m) => {
      if (m.role === 'user') chat.insertAdjacentHTML('beforeend', `<div class="ai-msg user">${UI.esc(m.content)}</div>`);
      else renderBotTurn(chat, m.content, m.steps);
    });
    aiHistory = saved.slice(-AI_HISTORY_LIMIT).map((m) => ({ role: m.role, content: m.content }));
    chat.scrollTop = chat.scrollHeight;
  }

  async function clearAiConversation(chat) {
    if (!(await UI.confirmDialog('Clear this conversation? This cannot be undone.', 'Clear'))) return;
    try { await API.del('/ai/messages'); } catch (e) { UI.toast(e.message, 'error'); return; }
    aiHistory = [];
    chat.innerHTML = `<div class="ai-msg bot">${AI_GREETING}</div>`;
  }

  function openAI() {
    aiOpen = true;
    const fab = document.getElementById('ai-fab');
    if (fab) fab.classList.add('open');
    const root = document.getElementById('ai-widget-root');
    root.innerHTML = `
      <div class="ai-widget" id="ai-widget">
        <div class="ai-widget-head">
          ${UI.icon('sparkles', 17)}<h3>AI Assistant</h3>
          <button type="button" class="icon-btn" id="ai-clear" title="Clear conversation" aria-label="Clear conversation">${UI.icon('trash', 16)}</button>
          ${App.hasPermission('users.manage') ? `<button type="button" class="icon-btn" id="ai-config" title="AI settings" aria-label="AI settings">${UI.icon('settings', 16)}</button>` : ''}
          <button type="button" class="icon-btn" id="ai-widget-close" aria-label="Close">${UI.icon('close', 16)}</button>
        </div>
        <div class="ai-widget-body"><div class="ai-chat" id="ai-chat">
          <div class="ai-msg bot">Loading your conversation…</div>
        </div></div>
        <div class="ai-widget-foot">
          <form class="ai-input" id="ai-form">
            <textarea id="ai-text" placeholder="Ask me anything…" rows="1"></textarea>
            <button class="btn" type="submit" aria-label="Send">${UI.icon('send', 16)}</button>
          </form>
        </div>
      </div>`;
    const el = root.querySelector('#ai-widget');
    requestAnimationFrame(() => el.classList.add('open'));
    aiEscHandler = (e) => { if (e.key === 'Escape') closeAI(); };
    document.addEventListener('keydown', aiEscHandler);

    const chat = el.querySelector('#ai-chat');
    const input = el.querySelector('#ai-text');
    const form = el.querySelector('#ai-form');
    const submitBtn = form.querySelector('button[type="submit"]');
    el.querySelector('#ai-widget-close').onclick = () => closeAI();
    el.querySelector('#ai-clear').onclick = () => clearAiConversation(chat);
    const cfgBtn = el.querySelector('#ai-config');
    if (cfgBtn) cfgBtn.onclick = () => aiSettingsModal();
    loadAiHistory(chat);

    // Grows with content instead of scrolling sideways (it's a textarea, not a single-line
    // input) — CSS caps it around 4 lines tall (max-height + overflow-y:auto on .ai-input
    // textarea), so typing past that scrolls vertically inside the box instead of growing
    // the whole widget further.
    const autoGrow = () => { input.style.height = 'auto'; input.style.height = input.scrollHeight + 'px'; };
    input.addEventListener('input', autoGrow);
    // Enter sends (matching the old single-line input's implicit-submit-on-Enter behavior);
    // Shift+Enter inserts a newline instead, same convention as chat apps generally use.
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const t = input.value.trim();
      if (!t) return;
      chat.insertAdjacentHTML('beforeend', `<div class="ai-msg user">${UI.esc(t)}</div>`);
      input.value = '';
      autoGrow(); // collapse back to one line after sending
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

        renderBotTurn(chat, res.reply, res.steps);
        aiHistory.push({ role: 'assistant', content: res.reply || '' });
        // Keep the client's LLM-context window under the route's cap (see AI_HISTORY_LIMIT);
        // the full conversation stays saved server-side regardless.
        if (aiHistory.length > AI_HISTORY_LIMIT) aiHistory = aiHistory.slice(-AI_HISTORY_LIMIT);
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
  }

  function usageBarHTML(c) {
    const used = c.tokens_used || 0;
    const cap = c.token_cap || 0;
    const pct = cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0;
    const stage = pct >= 100 ? 'over' : pct >= 80 ? 'near' : 'ok';
    const text = cap > 0
      ? `${used.toLocaleString()} / ${cap.toLocaleString()} tokens used (${pct}%)${pct >= 100 ? ' — cap reached, the assistant is paused' : ''}`
      : `${used.toLocaleString()} tokens used — no cap set`;
    return `
      <div class="usage-bar"><div class="usage-fill ${stage}" style="width:${cap > 0 ? pct : 0}%"></div></div>
      <div class="muted" style="font-size:12px;margin-top:5px" id="ai-usage-text">${UI.esc(text)}</div>`;
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
        to the platform key if one is configured.</p>
      <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--border)">
        <div class="field-label"><label>Token usage cap</label></div>
        <div id="ai-usage-wrap">${usageBarHTML(c)}</div>
        <div class="field-row" style="margin-top:10px">
          <div><label>Cap (0 = unlimited)</label>
            <input data-f="token_cap" type="number" min="0" step="1000" value="${c.token_cap || 0}" /></div>
          <div style="align-self:flex-end">
            <button type="button" class="btn secondary small" id="ai-reset-usage">Reset usage</button></div>
        </div>
        <p class="muted" style="font-size:12px;margin:8px 0 0">Counts every token spent across all LLM calls
          (including tool-use steps within a single question), summed since it was last reset. Once usage
          reaches the cap, the assistant refuses new requests until an admin raises the cap or resets usage here.</p>
      </div>`,
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
        ov.querySelector('#ai-reset-usage').onclick = async () => {
          if (!(await UI.confirmDialog('Reset the token usage counter to 0? The cap itself is unchanged.', 'Reset usage'))) return;
          try {
            const updated = await API.post('/ai/reset-usage');
            c = updated;
            ov.querySelector('#ai-usage-wrap').innerHTML = usageBarHTML(c);
            UI.toast('Usage reset');
          } catch (e) { UI.toast(e.message, 'error'); }
        };
      },
      onConfirm: async (ov) => {
        const g = (k) => ov.querySelector(`[data-f="${k}"]`).value.trim();
        const body = { model: g('model'), base_url: g('base_url'), token_cap: Number(g('token_cap')) || 0 };
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

  /* ---------------- Notes + linked scheduler tasks ---------------- */
  const noteDate = value => value ? new Date(String(value).replace(' ', 'T')).toLocaleString([], { dateStyle: 'medium', ...(String(value).length > 10 ? { timeStyle: 'short' } : {}) }) : '';
  const localDateTime = value => { if (!value) return ''; const d = new Date(value); if (String(value).includes('Z') || /[+-]\d\d:\d\d$/.test(value)) return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); return String(value).replace(' ', 'T').slice(0, 16); };
  function openNotes(noteId) {
    const d = UI.drawer({ key: 'notes', icon: 'note', title: 'Notes', bodyHTML: '<label class="sr-only" for="notes-search">Search notes</label><input id="notes-search" type="search" placeholder="Search notes and checklist items…"><div id="notes-list" aria-live="polite"><div class="empty">Loading…</div></div>', footHTML: `<button class="btn" id="note-new">${UI.icon('plus', 16)} New note / checklist</button>` });
    if (!d) return;
    const list = d.el.querySelector('#notes-list'); let notes = []; const pendingNotes = new Set();
    function render() {
      const query = d.el.querySelector('#notes-search').value.trim().toLowerCase();
      const shown = notes.filter(n => [n.title, n.body, ...(n.checklist || []).map(i => i.text)].join(' ').toLowerCase().includes(query));
      if (!shown.length) { list.innerHTML = UI.emptyState({ icon: 'note', title: query ? 'No matching notes' : 'Your ideas and to-dos, together', hint: query ? 'Try a different search.' : 'Add a note, build a checklist, and schedule it when you need a reminder.' }); return; }
      list.innerHTML = shown.map(n => {
        const items = n.checklist || [], task = n.scheduled_task;
        return `<article class="note-card"><div class="note-card-head"><button class="note-open" data-edit="${n.id}">${UI.esc(n.title || 'Untitled note')}</button><button class="icon-btn danger" data-del="${n.id}" aria-label="Delete ${UI.esc(n.title || 'note')}">${UI.icon('trash', 16)}</button></div>${n.body ? `<p class="note-excerpt">${UI.esc(n.body)}</p>` : ''}${items.length ? `<div class="note-progress">${items.filter(i => i.done).length} of ${items.length} completed</div><div class="note-checklist">${items.slice(0, 5).map((item, index) => `<label class="note-check ${item.done ? 'done' : ''}"><input type="checkbox" data-note="${n.id}" data-item="${index}" ${item.done ? 'checked' : ''}><span>${UI.esc(item.text)}</span></label>`).join('')}</div>${items.length > 5 ? `<button class="btn secondary small" data-edit="${n.id}">View ${items.length - 5} more items</button>` : ''}` : ''}<div class="note-card-foot"><button class="btn secondary small" data-schedule="${n.id}">${UI.icon('calendar', 14)} ${task ? UI.esc((task.done ? 'Completed · ' : 'Due · ') + noteDate(task.due_date)) : 'Schedule note'}</button>${task ? `<button class="btn secondary small" data-agenda="${task.id}">View in Scheduler</button>` : ''}</div></article>`;
      }).join('');
      list.querySelectorAll('[data-edit], [data-schedule]').forEach(b => b.onclick = () => noteModal(notes.find(n => n.id === Number(b.dataset.edit || b.dataset.schedule)), refresh, !!b.dataset.schedule));
      list.querySelectorAll('[data-agenda]').forEach(b => b.onclick = () => openScheduler());
      list.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { if (await UI.confirmDialog('Delete this note? Its scheduled task will remain in Scheduler.', 'Delete')) { try { await API.del('/notes/' + b.dataset.del); await refresh(); } catch (e) { UI.toast(e.message, 'error'); } } });
      list.querySelectorAll('[data-item]').forEach(input => input.onchange = async () => {
        const note = notes.find(n => n.id === Number(input.dataset.note)), items = note.checklist.map(i => ({ ...i }));
        items[Number(input.dataset.item)].done = input.checked; pendingNotes.add(note.id);
        input.closest('.note-card').querySelectorAll('input, button').forEach(el => el.disabled = true);
        try { await API.put('/notes/' + note.id, { title: note.title, body: note.body, checklist: items }); pendingNotes.delete(note.id); await refresh(); }
        catch (e) { pendingNotes.delete(note.id); render(); UI.toast(e.message, 'error'); }
      });
      pendingNotes.forEach(id => { const input = list.querySelector(`[data-note="${id}"]`); input?.closest('.note-card').querySelectorAll('input, button').forEach(el => el.disabled = true); });
    }
    async function refresh() { try { notes = await API.get('/notes'); if (!d.el.inert) render(); } catch (e) { list.innerHTML = `<p class="tool-note">${UI.esc(e.message)}</p><button class="btn secondary" id="notes-retry">Try again</button>`; list.querySelector('#notes-retry').onclick = refresh; } }
    d.el.querySelector('#notes-search').oninput = render;
    d.el.querySelector('#note-new').onclick = () => noteModal(null, refresh);
    refresh().then(() => { if (noteId) { const note = notes.find(n => n.id === Number(noteId)); if (note) noteModal(note, refresh); } });
  }
  function noteModal(note, after, scheduleFirst) {
    let savedId = note && note.id, items = (note && note.checklist || []).map(i => ({ ...i }));
    const task = note && note.scheduled_task;
    UI.modal({ title: note ? 'Edit note' : 'New note', size: 'lg',
      bodyHTML: `<div class="note-editor"><label for="note-title">Title</label><input id="note-title" maxlength="200" value="${UI.esc(note && note.title || '')}" placeholder="What would you like to remember?"><label for="note-body">Note</label><textarea id="note-body" rows="4" maxlength="20000" placeholder="Details, ideas, or context…">${UI.esc(note && note.body || '')}</textarea><div class="note-section-heading"><h4>Checklist</h4><span class="muted">Optional · up to 200 items</span></div><div id="note-items"></div><div class="note-item-add"><input id="note-item-text" data-no-submit maxlength="500" aria-label="New checklist item" placeholder="Add something to do…"><button type="button" class="btn secondary" id="note-item-add">Add item</button></div><section class="note-schedule"><label class="check-opt"><input type="checkbox" id="note-scheduled" ${task || scheduleFirst ? 'checked' : ''}> Schedule this note ${UI.helpIcon('Creates one linked Scheduler task. Checklist completion updates the task, and rescheduling updates the existing task rather than creating another.')}</label><div id="note-schedule-fields" ${task || scheduleFirst ? '' : 'hidden'}><label for="note-due">Due date and time *</label><input type="datetime-local" id="note-due" value="${UI.esc(localDateTime(task && task.due_date))}"><label for="note-remind">Remind me <span class="muted">(optional)</span> ${UI.helpIcon('Reminders appear in your notifications. Enable push notifications on your device to receive them outside the app.')}</label><input type="datetime-local" id="note-remind" value="${UI.esc(localDateTime(task && task.remind_at))}"></div></section></div>`,
      confirmText: 'Save note',
      onOpen: ov => {
        const host = ov.querySelector('#note-items');
        function renderItems() {
          host.innerHTML = items.map((item, index) => `<div class="note-item-editor"><input type="checkbox" data-check="${index}" aria-label="Complete item ${index + 1}" ${item.done ? 'checked' : ''}><input data-text="${index}" maxlength="500" aria-label="Checklist item ${index + 1}" value="${UI.esc(item.text)}"><button type="button" class="icon-btn danger" data-remove="${index}" aria-label="Remove item ${index + 1}">${UI.icon('trash', 16)}</button></div>`).join('');
          host.querySelectorAll('[data-check]').forEach(el => el.onchange = () => items[Number(el.dataset.check)].done = el.checked);
          host.querySelectorAll('[data-text]').forEach(el => el.oninput = () => items[Number(el.dataset.text)].text = el.value);
          host.querySelectorAll('[data-remove]').forEach(el => el.onclick = () => { items.splice(Number(el.dataset.remove), 1); ov.__markDirty?.(); renderItems(); });
        }
        const add = () => { const input = ov.querySelector('#note-item-text'); if (!input.value.trim()) { input.focus(); return; } if (items.length >= 200) { UI.toast('A checklist can have up to 200 items.', 'error'); return; } items.push({ id: crypto.randomUUID(), text: input.value.trim(), done: false }); input.value = ''; ov.__markDirty?.(); renderItems(); input.focus(); };
        ov.querySelector('#note-item-add').onclick = add;
        ov.querySelector('#note-item-text').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); add(); } };
        ov.querySelector('#note-scheduled').onchange = e => ov.querySelector('#note-schedule-fields').hidden = !e.target.checked;
        renderItems(); if (scheduleFirst) ov.querySelector('#note-due').focus();
      },
      onConfirm: async (ov, showErr) => {
        const title = ov.querySelector('#note-title').value.trim(), body = ov.querySelector('#note-body').value.trim(), scheduled = ov.querySelector('#note-scheduled').checked;
        // Include the item currently being typed, even if Add item was not pressed.
        if (ov.querySelector('#note-item-text').value.trim()) ov.querySelector('#note-item-add').click();
        if ((!body && !items.length) || items.some(i => !i.text.trim())) { showErr('Add note text or a checklist, and give every item a label.'); return false; }
        const due = ov.querySelector('#note-due').value, reminder = ov.querySelector('#note-remind').value;
        if (scheduled && !due) { showErr('Choose when this note is due.'); ov.querySelector('#note-due').focus(); return false; }
        try {
          const data = { title, body, checklist: items.map(i => ({ ...i, text: i.text.trim() })) };
          if (savedId) await API.put('/notes/' + savedId, data); else savedId = (await API.post('/notes', data)).id;
          if (scheduled) await API.post('/notes/' + savedId + '/schedule', { due_date: due, remind_at: reminder ? new Date(reminder).toISOString() : null });
          else if (task) await API.del('/tasks/' + task.id);
          UI.toast(scheduled ? 'Note saved and scheduled' : 'Note saved'); await after();
        } catch (e) { showErr((savedId ? 'Note saved. ' : '') + e.message); return false; }
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
            ${t.due_date ? `<div class="tool-row-sub ${overdue ? 'overdue' : ''}">${UI.esc(noteDate(t.due_date))}${overdue ? ' · overdue' : ''}</div>` : ''}
            ${t.remind_at ? `<div class="tool-row-sub">${UI.icon('bell', 12)} ${UI.esc(noteDate(t.remind_at))}</div>` : ''}
            <button class="btn secondary small" data-task-edit="${t.id}">Schedule / edit</button>
            ${t.note_id ? `<button class="btn secondary small" data-task-note="${t.note_id}">Open linked note</button>` : ''}
          </div>
          <button class="icon-btn danger" data-del="${t.id}" title="Delete">${UI.icon('trash', 16)}</button>
        </div>`;
      }).join('');
      listEl.querySelectorAll('[data-task-edit]').forEach(b => b.onclick = () => taskModal(tasks.find(t => t.id === Number(b.dataset.taskEdit)), refresh));
      listEl.querySelectorAll('[data-task-note]').forEach(b => b.onclick = () => openNotes(Number(b.dataset.taskNote)));
      listEl.querySelectorAll('[data-toggle]').forEach((c) =>
        c.onchange = async () => { await API.put('/tasks/' + c.dataset.toggle, { done: c.checked }); refresh(); });
      listEl.querySelectorAll('[data-del]').forEach((b) =>
        b.onclick = async () => { await API.del('/tasks/' + b.dataset.del); refresh(); });
    }
    d.el.querySelector('#task-title').setAttribute('aria-label', 'Task title');
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

  function taskModal(task, after) {
    UI.modal({ title: 'Schedule task', bodyHTML: `<label for="task-edit-title">Task</label><input id="task-edit-title" maxlength="300" value="${UI.esc(task.title)}" ${task.note_id ? 'readonly' : ''}><label for="task-edit-due">Due date and time</label><input type="datetime-local" id="task-edit-due" value="${UI.esc(localDateTime(task.due_date))}"><label for="task-edit-remind">Remind me</label><input type="datetime-local" id="task-edit-remind" value="${UI.esc(localDateTime(task.remind_at))}">${task.note_id ? '<p class="muted">Edit the linked note to change its title or checklist.</p>' : ''}`, confirmText: 'Save schedule', onConfirm: async ov => {
      await API.put('/tasks/' + task.id, { title: ov.querySelector('#task-edit-title').value.trim(), due_date: ov.querySelector('#task-edit-due').value.replace('T', ' ') || null, remind_at: ov.querySelector('#task-edit-remind').value ? new Date(ov.querySelector('#task-edit-remind').value).toISOString() : null });
      await after(); UI.toast('Schedule saved');
    } });
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
          <div class="tool-row-main" role="button" tabindex="0" data-go="${b.id}">
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

  /* ---------------- Report a Bug ---------------- */
  // Any signed-in user can file a report (title, steps to reproduce, up to 5
  // screenshots — pasted or attached). users.manage additionally gets a "View
  // reports" button in the footer to review/resolve what's been filed
  // (src/routes/bug-reports.routes.ts).
  const MAX_SHOTS = 5;

  function openBugReport() {
    const canReview = App.hasPermission('users.manage');
    let shots = [];

    const d = UI.drawer({
      key: 'bug', icon: 'bug', title: 'Report a Bug',
      bodyHTML: `
        <label>Title *</label><input id="bug-title" maxlength="200" placeholder="Short summary of the problem" />
        <label>Steps to reproduce *</label>
        <textarea id="bug-steps" style="min-height:90px" placeholder="1. Go to…&#10;2. Click…&#10;3. See error"></textarea>
        <label>What happened? <span class="muted" style="font-weight:400">(optional)</span></label>
        <textarea id="bug-desc" style="min-height:60px" placeholder="Expected vs. actual behavior, error messages, etc."></textarea>
        <label>Screenshots <span class="muted" style="font-weight:400">— up to ${MAX_SHOTS}</span></label>
        <input type="file" id="bug-shots-input" accept="image/*" multiple />
        <div class="muted" style="font-size:11.5px;margin-top:3px">You can also paste a screenshot (Ctrl+V) while this panel is open.</div>
        <div class="shot-grid" id="bug-shot-grid"></div>
        <div id="bug-status" class="muted" style="font-size:12px;margin-top:8px"></div>`,
      footHTML: `${canReview ? `<button class="btn secondary" id="bug-view-reports">${UI.icon('history', 15)} View reports</button>` : ''}
        <button class="btn" id="bug-submit">${UI.icon('send', 16)} Submit report</button>`,
      onOpen: (el) => {
        const grid = el.querySelector('#bug-shot-grid');
        const input = el.querySelector('#bug-shots-input');
        const statusEl = el.querySelector('#bug-status');

        function renderShots() {
          grid.innerHTML = shots.map((_, i) =>
            `<div class="shot-thumb" data-i="${i}"><img alt="Screenshot ${i + 1}" />
              <button type="button" class="shot-remove" data-rm="${i}" aria-label="Remove">${UI.icon('close', 12)}</button></div>`
          ).join('');
          grid.querySelectorAll('.shot-thumb img').forEach((img, i) => { img.src = URL.createObjectURL(shots[i]); });
          grid.querySelectorAll('[data-rm]').forEach((b) =>
            b.onclick = () => { shots.splice(Number(b.dataset.rm), 1); renderShots(); });
        }

        async function addFiles(fileList) {
          let list = Array.from(fileList || []).filter((f) => /^image\//.test(f.type));
          if (!list.length) return;
          const room = MAX_SHOTS - shots.length;
          if (room <= 0) { UI.toast(`You can attach up to ${MAX_SHOTS} screenshots`, 'error'); return; }
          if (list.length > room) list = list.slice(0, room);
          if (window.ImageCompress) list = await Promise.all(list.map((f) => window.ImageCompress.maybeCompress(f)));
          shots = shots.concat(list);
          renderShots();
        }

        input.addEventListener('change', () => { addFiles(input.files); input.value = ''; });
        el.addEventListener('paste', (e) => {
          const items = (e.clipboardData && e.clipboardData.items) || [];
          const files = Array.from(items)
            .filter((it) => it.kind === 'file' && /^image\//.test(it.type))
            .map((it) => it.getAsFile())
            .filter(Boolean);
          if (files.length) addFiles(files);
        });

        const viewBtn = el.querySelector('#bug-view-reports');
        if (viewBtn) viewBtn.onclick = () => bugReportsModal();

        el.querySelector('#bug-submit').onclick = async () => {
          const title = el.querySelector('#bug-title').value.trim();
          const steps = el.querySelector('#bug-steps').value.trim();
          const description = el.querySelector('#bug-desc').value.trim();
          if (!title) { statusEl.textContent = 'Title is required.'; return; }
          if (!steps) { statusEl.textContent = 'Steps to reproduce are required.'; return; }
          const btn = el.querySelector('#bug-submit');
          btn.disabled = true;
          statusEl.textContent = 'Submitting…';
          try {
            const fd = new FormData();
            fd.append('title', title);
            fd.append('steps_to_reproduce', steps);
            if (description) fd.append('description', description);
            fd.append('page_context', App.currentLocation().label);
            shots.forEach((f) => fd.append('screenshots', f));
            await API.upload('/bug-reports', fd);
            UI.toast('Bug report submitted — thank you!');
            d.close();
          } catch (e) {
            statusEl.textContent = e.message;
          } finally {
            btn.disabled = false;
          }
        };
      },
    });
  }

  /** Admin: browse/filter filed reports (users.manage). */
  async function bugReportsModal() {
    let status = ''; // '' | 'open' | 'resolved'
    UI.modal({
      title: 'Bug Reports',
      size: 'lg',
      cancelText: 'Close',
      confirmText: null,
      bodyHTML: `
        <div class="msg-tabs" style="margin-bottom:10px">
          <button class="btn secondary small" data-f="">All</button>
          <button class="btn secondary small" data-f="open">Open</button>
          <button class="btn secondary small" data-f="resolved">Resolved</button>
        </div>
        <div id="bug-list-body"><div class="empty">Loading…</div></div>`,
      onOpen: (ov) => {
        ov.querySelectorAll('[data-f]').forEach((b) =>
          b.onclick = () => { status = b.dataset.f; setTabs(ov); load(ov); });
        setTabs(ov);
        load(ov);
      },
    });
    function setTabs(ov) {
      ov.querySelectorAll('[data-f]').forEach((b) => b.classList.toggle('secondary', b.dataset.f !== status));
    }
    async function load(ov) {
      const body = ov.querySelector('#bug-list-body');
      body.innerHTML = '<div class="empty">Loading…</div>';
      let rows;
      try { rows = await API.get('/bug-reports' + (status ? `?status=${status}` : '')); }
      catch (e) { body.innerHTML = `<div class="empty">${UI.esc(e.message)}</div>`; return; }
      if (!rows.length) {
        body.innerHTML = UI.emptyState({ icon: 'bug', title: 'No bug reports', hint: 'Reports filed from the sidebar will show up here.' });
        return;
      }
      body.innerHTML = `<table><thead><tr><th>Title</th><th>Reported by</th><th>When</th><th>Screens</th><th>Status</th></tr></thead>
        <tbody>${rows.map((r) => `<tr data-id="${r.id}" style="cursor:pointer">
          <td>${UI.esc(r.title)}</td>
          <td class="muted">${UI.esc(r.reporter_name || '—')}</td>
          <td class="muted mono" style="white-space:nowrap">${UI.fmtDateShort(r.created_at)}</td>
          <td class="muted">${r.screenshot_count || 0}</td>
          <td><span class="badge-pill ${r.status === 'resolved' ? 'status-completed' : 'status-open'}">${r.status}</span></td>
        </tr>`).join('')}</tbody></table>`;
      body.querySelectorAll('[data-id]').forEach((tr) =>
        tr.onclick = () => bugReportDetail(Number(tr.dataset.id), () => load(ov)));
    }
  }

  /** Admin: full report + screenshot gallery + resolve/reopen toggle. */
  async function bugReportDetail(id, onChanged) {
    let r;
    try { r = await API.get(`/bug-reports/${id}`); } catch (e) { UI.toast(e.message, 'error'); return; }
    const shotsHTML = (r.screenshots || []).map((s) =>
      `<div class="shot-thumb" data-view="${UI.esc(s.url)}" title="${UI.esc(s.original_name)}"><img alt="${UI.esc(s.original_name)}" /></div>`
    ).join('');
    UI.modal({
      title: r.title,
      size: 'lg',
      cancelText: 'Close',
      confirmText: r.status === 'resolved' ? 'Reopen' : 'Mark resolved',
      bodyHTML: `
        <div class="muted" style="font-size:12px;margin-bottom:10px">
          Reported by <strong>${UI.esc(r.reporter_name || 'Unknown')}</strong> · ${UI.fmtDate(r.created_at)}
          ${r.page_context ? ` · from ${UI.esc(r.page_context)}` : ''}
        </div>
        <div class="msg-full"><label>Steps to reproduce</label><div class="body">${UI.esc(r.steps_to_reproduce)}</div></div>
        ${r.description ? `<div class="msg-full" style="margin-top:10px"><label>What happened</label><div class="body">${UI.esc(r.description)}</div></div>` : ''}
        ${shotsHTML ? `<label style="display:block;margin-top:12px">Screenshots</label><div class="shot-grid">${shotsHTML}</div>` : ''}`,
      onOpen: (ov) => {
        ov.querySelectorAll('[data-view]').forEach((box) => {
          API.blobUrl(box.dataset.view)
            .then((u) => { box.querySelector('img').src = u; box.onclick = () => window.open(u, '_blank'); })
            .catch(() => {});
        });
      },
      onConfirm: async () => {
        const next = r.status === 'resolved' ? 'open' : 'resolved';
        await API.put(`/bug-reports/${id}`, { status: next });
        UI.toast(next === 'resolved' ? 'Marked resolved' : 'Reopened');
        if (onChanged) onChanged();
      },
    });
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

  window.PersonalTools = { openNotes, openScheduler };
  document.addEventListener('DOMContentLoaded', init);
})();
