/* Messages: 1:1 chat — conversation list + threaded bubbles, reactions, reply, edit,
   sender-only soft delete ("Message was removed"), link/file previews, real-time via
   ChatWS (public/js/lib/chat-ws.js) with the loaded thread patched in place. */

// Stable references so re-entering this view (or navigating away) swaps ChatWS
// listeners cleanly instead of stacking a new set on every visit (ChatWS itself has no
// concept of "this view unmounted" — see public/js/lib/chat-ws.js).
let _chatWsHandlers = null;

App.register('messages', async (view, filter) => {
  const me = App.getMe();
  const QUICK_EMOJI = ['👍', '❤️', '😆', '😮', '😢', '🙏'];
  const URL_RE = /(https?:\/\/[^\s<]+)/i;

  let conversations = [];
  let activeOtherId = null;
  let activeOtherName = '';
  let messages = []; // current thread, oldest-first
  let replyTo = null; // { id, author, preview }
  let editingId = null;
  let typingTimer = null;
  let lastTypingSentAt = 0;
  const linkPreviewCache = new Map(); // url -> data object | null (null = no preview)

  view.innerHTML = `
    <div class="chat-layout">
      <div class="chat-sidebar">
        <div class="chat-sidebar-head">
          <h2>Messages</h2>
          <button class="btn secondary small" id="chat-reports">Reports</button>
          <button class="btn small" id="chat-new">${UI.icon('edit', 15)} New</button>
        </div>
        <div id="chat-convo-list" class="msg-list">${UI.emptyState({ icon: 'inbox', title: 'Loading…' })}</div>
      </div>
      <div class="chat-thread" id="chat-thread">
        ${UI.emptyState({ icon: 'messages', title: 'Select a conversation', hint: 'Pick someone from the list on the left, or start a new message.' })}
      </div>
    </div>`;

  const convoListEl = view.querySelector('#chat-convo-list');
  const threadEl = view.querySelector('#chat-thread');

  view.querySelector('#chat-new').addEventListener('click', newMessageModal);
  view.querySelector('#chat-reports').addEventListener('click', () => App.navigate('identified-reports'));

  async function loadConversations() {
    try {
      conversations = await API.get('/messages/conversations');
    } catch {
      conversations = [];
    }
    renderConvoList();
  }

  function renderConvoList() {
    if (!conversations.length) {
      convoListEl.innerHTML = UI.emptyState({
        icon: 'inbox', title: 'No conversations yet',
        hint: 'Start a new message to get going.',
        action: `<button class="btn small" id="chat-empty-new">${UI.icon('edit', 14)} New message</button>`,
      });
      const b = convoListEl.querySelector('#chat-empty-new');
      if (b) b.onclick = newMessageModal;
      return;
    }
    convoListEl.innerHTML = conversations.map((c) => `
      <div class="msg-row${c.other_id === activeOtherId ? ' active' : ''}${c.unread_count ? ' unread' : ''}" data-id="${c.other_id}">
        <div class="avatar">${UI.esc(UI.initials(c.other_name))}</div>
        <div class="meta">
          <div class="who">${UI.esc(c.other_name)}${c.unread_count ? ` <span class="badge-pill low" style="font-size:10px">${c.unread_count}</span>` : ''}</div>
          <div class="preview">${c.last_message_mine ? 'You: ' : ''}${UI.esc(c.last_message || '')}</div>
        </div>
        <div class="when">${UI.fmtDateShort(c.last_message_at)}</div>
      </div>`).join('');
    convoListEl.querySelectorAll('[data-id]').forEach((row) =>
      row.addEventListener('click', () => openConversation(Number(row.dataset.id), row.querySelector('.who').textContent.trim())));
  }

  async function openConversation(otherId, knownName) {
    activeOtherId = otherId;
    activeOtherName = knownName || (conversations.find((c) => c.other_id === otherId) || {}).other_name || '';
    renderConvoList();
    replyTo = null; editingId = null;
    threadEl.innerHTML = `
      <div class="chat-thread-head">
        <div class="avatar">${UI.esc(UI.initials(activeOtherName))}</div>
        <div class="who">${UI.esc(activeOtherName)}</div>
        <div class="chat-typing hidden" id="chat-typing">typing…</div>
      </div>
      <div class="chat-load-older hidden" id="chat-load-older"><button class="btn secondary small">Load earlier messages</button></div>
      <div class="chat-messages" id="chat-messages"><div class="empty">Loading…</div></div>
      <div class="chat-reply-strip hidden" id="chat-reply-strip"></div>
      <div class="chat-file-preview hidden" id="chat-file-preview" aria-live="polite"></div>
      <div class="chat-compose">
        <button class="icon-btn" id="chat-attach-btn" title="Attach a file">${UI.icon('upload', 18)}</button>
        <input type="file" id="chat-file-input" multiple class="hidden" />
        <textarea id="chat-input" placeholder="Message…" rows="1"></textarea>
        <button class="btn" id="chat-send-btn">${UI.icon('send', 16)}</button>
      </div>`;
    wireComposer();
    wireMessagesDelegation();

    try {
      messages = await API.get(`/messages/with/${otherId}?limit=50`);
    } catch (e) {
      threadEl.querySelector('#chat-messages').innerHTML = `<div class="empty">Failed to load: ${UI.esc(e.message)}</div>`;
      return;
    }
    messages.reverse(); // API returns newest-first; the thread renders oldest-at-top
    renderMessages();
    scrollToBottom();
    threadEl.querySelector('#chat-load-older').classList.toggle('hidden', messages.length < 50);

    API.post(`/messages/with/${otherId}/read`).then(() => { App.refreshUnread(); loadConversations(); }).catch(() => {});
  }

  async function loadOlder() {
    if (!messages.length) return;
    const before = messages[0].id;
    let older;
    try {
      older = await API.get(`/messages/with/${activeOtherId}?limit=50&before=${before}`);
    } catch {
      return;
    }
    older.reverse();
    messages = older.concat(messages);
    const container = threadEl.querySelector('#chat-messages');
    const prevHeight = container.scrollHeight;
    renderMessages();
    container.scrollTop = container.scrollHeight - prevHeight;
    threadEl.querySelector('#chat-load-older').classList.toggle('hidden', older.length < 50);
  }

  /** Fallback for when ChatWS isn't connected: re-fetch the currently open thread's most
   *  recent page so a just-sent message (or one sent from elsewhere) still shows up. */
  async function reloadCurrentThread() {
    if (activeOtherId == null) return;
    const wasNearBottom = isNearBottom();
    try {
      messages = await API.get(`/messages/with/${activeOtherId}?limit=${Math.max(messages.length, 50)}`);
    } catch {
      return;
    }
    messages.reverse();
    renderMessages();
    if (wasNearBottom) scrollToBottom();
  }

  function scrollToBottom() {
    const container = threadEl.querySelector('#chat-messages');
    if (container) container.scrollTop = container.scrollHeight;
  }

  function isNearBottom() {
    const c = threadEl.querySelector('#chat-messages');
    if (!c) return true;
    return c.scrollHeight - c.scrollTop - c.clientHeight < 120;
  }

  /* ---------- rendering ---------- */

  function reactionsHTML(reactions) {
    if (!reactions || !reactions.length) return '';
    return `<div class="chat-reactions">${reactions.map((r) =>
      `<span class="chat-reaction${r.mine ? ' mine' : ''}" data-emoji="${UI.esc(r.emoji)}">${r.emoji} ${r.count}</span>`).join('')}</div>`;
  }

  function attachmentHTML(a) {
    const isImage = (a.mime_type || '').startsWith('image/');
    const isVideo = (a.mime_type || '').startsWith('video/') || /\.(mp4|webm|mov|m4v)$/i.test(a.name || '');
    if (isImage || isVideo) {
      return `<div class="chat-media" data-att-url="${UI.esc(a.url)}" data-att-name="${UI.esc(a.name)}" data-media-kind="${isVideo ? 'video' : 'image'}" data-media-type="${UI.esc(isVideo ? ({ mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' }[ (a.name || '').split('.').pop().toLowerCase() ] || a.mime_type || 'video/mp4') : a.mime_type || '')}">
        <div class="chat-media-stage is-loading" aria-busy="true">
          <div class="chat-media-loading" role="status"><span class="chat-media-glyph">${isVideo ? '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m8 5 11 7-11 7Z"/></svg>' : UI.icon('image', 28)}</span><span>Preparing ${isVideo ? 'video' : 'photo'}…</span></div>
          ${isVideo ? '<video controls playsinline preload="metadata" hidden></video>' : `<img class="chat-attach-img" alt="${UI.esc(a.name)}" hidden />`}
        </div>
        <button class="btn secondary small" data-media-download>Download</button>
      </div>`;
    }
    return `<button type="button" class="msg-attach" data-att-url="${UI.esc(a.url)}" data-att-name="${UI.esc(a.name)}" aria-label="Preview ${UI.esc(a.name)}">
      <span class="msg-attach-icon">${UI.icon(UI.fileIconName(a.name), 16)}</span>
      <span class="msg-attach-name">${UI.esc(a.name)}</span>
      <span class="msg-attach-size muted">${UI.fmtBytes(a.size_bytes)}</span>
    </button>`;
  }

  function bubbleHTML(m) {
    if (m.deleted_at) {
      return `<div class="chat-row ${m.mine ? 'mine' : 'theirs'}" data-id="${m.id}">
        <div class="chat-bubble-wrap"><div class="chat-bubble removed">Message was removed</div></div>
        <div class="chat-time">${UI.fmtDateShort(m.created_at)}</div>
      </div>`;
    }
    const replyHtml = m.reply_to
      ? `<div class="chat-reply-quote" data-scroll-to="${m.reply_to.id}"><b>${UI.esc(m.reply_to.author)}</b><br>${UI.esc(m.reply_to.preview)}</div>`
      : '';
    const attHtml = (m.attachments || []).map(attachmentHTML).join('');
    const edited = m.edited_at ? '<span class="chat-edited">Edited</span>' : '';
    return `<div class="chat-row ${m.mine ? 'mine' : 'theirs'}" data-id="${m.id}">
      <div class="chat-bubble-wrap">
        <div class="chat-bubble">
          ${replyHtml}
          ${m.body ? `<div class="chat-text">${UI.esc(m.body)}</div>` : ''}
          ${attHtml}
          <div class="chat-link-preview-host"></div>
          ${edited}
        </div>
        <div class="chat-hover-actions">
          <button class="icon-btn" data-act="react" title="React">🙂</button>
          <button class="icon-btn" data-act="reply" title="Reply">${UI.icon('reply', 14)}</button>
          ${m.mine ? `<button class="icon-btn" data-act="edit" title="Edit">${UI.icon('edit', 14)}</button>` : ''}
          ${m.mine ? `<button class="icon-btn" data-act="unsend" title="Remove">${UI.icon('trash', 14)}</button>` : ''}
        </div>
      </div>
      ${reactionsHTML(m.reactions)}
      <div class="chat-time">${UI.fmtDateShort(m.created_at)}</div>
    </div>`;
  }

  function renderMessages() {
    const container = threadEl.querySelector('#chat-messages');
    if (!container) return;
    if (!messages.length) {
      container.innerHTML = UI.emptyState({ icon: 'messages', title: 'No messages yet', hint: 'Say hello 👋' });
      return;
    }
    container.innerHTML = messages.map(bubbleHTML).join('');
    messages.forEach(hydrateBubbleExtras);
  }

  /** Post-render work for one bubble: load auth'd image thumbnails, fetch a link
   *  preview card for the first URL in the text. Safe to call again after a patch. */
  function hydrateBubbleExtras(m) {
    const row = threadEl.querySelector(`.chat-row[data-id="${m.id}"]`);
    if (!row) return;
    row.querySelectorAll('.chat-media').forEach((wrap) => {
      if (wrap.dataset.hydrated) return;
      wrap.dataset.hydrated = 'true';
      const stage = wrap.querySelector('.chat-media-stage');
      const media = wrap.querySelector('img, video');
      const status = wrap.querySelector('.chat-media-loading');
      const fail = (message) => {
        media.hidden = true;
        stage.classList.remove('is-loading');
        stage.setAttribute('aria-busy', 'false');
        status.textContent = message;
        status.hidden = false;
      };
      media.addEventListener(media.tagName === 'VIDEO' ? 'loadeddata' : 'load', () => {
        stage.classList.remove('is-loading');
        stage.setAttribute('aria-busy', 'false');
        status.hidden = true;
        media.hidden = false;
      }, { once: true });
      media.addEventListener('error', () => fail('Preview unavailable. You can still download this file.'), { once: true });
      API.blobUrl(wrap.dataset.attUrl, wrap.dataset.mediaKind === 'video' ? wrap.dataset.mediaType : undefined).then((url) => {
        if (!wrap.isConnected) { URL.revokeObjectURL(url); return; }
        media.src = url;
        if (media.tagName === 'VIDEO') media.preload = 'auto';
        // Reclaim the authenticated blob when its bubble or view is removed.
        const observer = new MutationObserver(() => {
          if (wrap.isConnected) return;
          if (media.tagName === 'VIDEO') media.pause();
          media.removeAttribute('src');
          URL.revokeObjectURL(url);
          observer.disconnect();
        });
        observer.observe(view.parentNode || document.body, { childList: true, subtree: true });
      }).catch((err) => fail(err.message || 'Unable to load attachment.'));
    });
    if (m.deleted_at || !m.body) return;
    const match = m.body.match(URL_RE);
    if (!match) return;
    const url = match[1];
    const host = row.querySelector('.chat-link-preview-host');
    if (!host) return;
    if (linkPreviewCache.has(url)) {
      renderLinkPreview(host, url, linkPreviewCache.get(url));
      return;
    }
    API.get('/messages/link-preview?url=' + encodeURIComponent(url))
      .then((data) => { linkPreviewCache.set(url, data); renderLinkPreview(host, url, data); })
      .catch(() => { linkPreviewCache.set(url, null); });
  }

  function renderLinkPreview(host, url, data) {
    if (!data || (!data.title && !data.description && !data.image_url)) return;
    let domain = '';
    try { domain = new URL(url).hostname; } catch { /* ignore */ }
    host.innerHTML = `
      <a class="chat-link-preview" href="${UI.esc(url)}" target="_blank" rel="noopener noreferrer">
        ${data.image_url ? `<img class="chat-link-preview-img" src="${UI.esc(data.image_url)}" alt="" />` : ''}
        <div class="chat-link-preview-body">
          ${data.title ? `<div class="chat-link-preview-title">${UI.esc(data.title)}</div>` : ''}
          ${data.description ? `<div class="chat-link-preview-desc">${UI.esc(data.description)}</div>` : ''}
          <div class="chat-link-preview-domain">${UI.esc(data.site_name || domain)}</div>
        </div>
      </a>`;
  }

  /* ---------- interactions (event delegation on #chat-messages) ---------- */

  function closeEmojiPopover() {
    // The popover is appended to document.body (so it can float outside the scrollable
    // thread), not to `view` — querying `view` here would never find it to remove.
    document.querySelectorAll('.chat-emoji-popover').forEach((p) => p.remove());
  }

  function openEmojiPopover(btn, messageId) {
    closeEmojiPopover();
    const pop = document.createElement('div');
    pop.className = 'chat-emoji-popover';
    pop.innerHTML = QUICK_EMOJI.map((e) => `<button type="button" data-emoji="${e}">${e}</button>`).join('');
    document.body.appendChild(pop);
    const r = btn.getBoundingClientRect();
    pop.style.top = (r.top - pop.offsetHeight - 44) + 'px';
    pop.style.left = Math.max(8, r.left - 8) + 'px';
    pop.querySelectorAll('[data-emoji]').forEach((b) =>
      b.addEventListener('click', () => { react(messageId, b.dataset.emoji); closeEmojiPopover(); }));
    setTimeout(() => document.addEventListener('click', function onDoc(e) {
      if (!pop.contains(e.target)) { closeEmojiPopover(); document.removeEventListener('click', onDoc); }
    }), 0);
  }

  async function react(messageId, emoji) {
    try {
      const res = await API.post(`/messages/${messageId}/react`, { emoji });
      applyReactions(messageId, res.reactions);
    } catch (e) {
      UI.toast(e.message, 'error');
    }
  }

  function applyReactions(messageId, rawReactions) {
    const grouped = new Map();
    (rawReactions || []).forEach((r) => {
      const cur = grouped.get(r.emoji) || { emoji: r.emoji, count: 0, mine: false };
      cur.count += 1;
      if (r.user_id === me.id) cur.mine = true;
      grouped.set(r.emoji, cur);
    });
    const m = messages.find((x) => x.id === messageId);
    if (m) m.reactions = [...grouped.values()];
    const row = threadEl.querySelector(`.chat-row[data-id="${messageId}"]`);
    if (!row) return;
    const existing = row.querySelector('.chat-reactions');
    const html = reactionsHTML(m ? m.reactions : [...grouped.values()]);
    if (existing) existing.outerHTML = html;
    else row.querySelector('.chat-bubble-wrap').insertAdjacentHTML('afterend', html);
  }

  function startReply(messageId) {
    const m = messages.find((x) => x.id === messageId);
    if (!m || m.deleted_at) return;
    editingId = null;
    replyTo = { id: m.id, author: m.mine ? me.full_name : activeOtherName, preview: m.body.length > 100 ? m.body.slice(0, 97) + '…' : m.body };
    renderReplyStrip();
    threadEl.querySelector('#chat-input').focus();
  }

  function startEdit(messageId) {
    const m = messages.find((x) => x.id === messageId);
    if (!m || m.deleted_at || !m.mine) return;
    replyTo = null;
    editingId = messageId;
    renderReplyStrip();
    const input = threadEl.querySelector('#chat-input');
    input.value = m.body;
    input.focus();
    autoGrow(input);
  }

  function renderReplyStrip() {
    const strip = threadEl.querySelector('#chat-reply-strip');
    const sendBtn = threadEl.querySelector('#chat-send-btn');
    if (replyTo) {
      strip.classList.remove('hidden');
      strip.innerHTML = `<div class="chat-reply-strip-text"><b>Replying to ${UI.esc(replyTo.author)}</b><br>${UI.esc(replyTo.preview)}</div>
        <button class="icon-btn" id="chat-reply-cancel">${UI.icon('close', 14)}</button>`;
      strip.querySelector('#chat-reply-cancel').onclick = () => { replyTo = null; renderReplyStrip(); };
      sendBtn.innerHTML = UI.icon('send', 16);
    } else if (editingId) {
      strip.classList.remove('hidden');
      strip.innerHTML = `<div class="chat-reply-strip-text"><b>Editing message</b></div>
        <button class="icon-btn" id="chat-reply-cancel">${UI.icon('close', 14)}</button>`;
      strip.querySelector('#chat-reply-cancel').onclick = () => { editingId = null; threadEl.querySelector('#chat-input').value = ''; renderReplyStrip(); };
      sendBtn.textContent = 'Save';
    } else {
      strip.classList.add('hidden');
      strip.innerHTML = '';
      sendBtn.innerHTML = UI.icon('send', 16);
    }
  }

  async function unsend(messageId) {
    const ok = await UI.confirmDialog('Remove this message for everyone? This cannot be undone.', 'Remove');
    if (!ok) return;
    try {
      await API.del(`/messages/${messageId}`);
      applyRemoved(messageId);
    } catch (e) {
      UI.toast(e.message, 'error');
    }
  }

  function applyRemoved(messageId) {
    const m = messages.find((x) => x.id === messageId);
    if (m) { m.deleted_at = new Date().toISOString(); m.body = ''; m.attachments = []; m.reactions = []; }
    const row = threadEl.querySelector(`.chat-row[data-id="${messageId}"]`);
    if (row && m) row.outerHTML = bubbleHTML(m);
    loadConversations();
  }

  function wireMessagesDelegation() {
    const container = threadEl.querySelector('#chat-messages');
    container.addEventListener('click', (e) => {
      const quote = e.target.closest('[data-scroll-to]');
      if (quote) {
        const target = threadEl.querySelector(`.chat-row[data-id="${quote.dataset.scrollTo}"]`);
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          target.classList.add('flash');
          setTimeout(() => target.classList.remove('flash'), 1200);
        }
        return;
      }
      const att = e.target.closest('[data-att-url]');
      if (att) {
        if (e.target.closest('[data-media-download]')) {
          API.download(att.dataset.attUrl, att.dataset.attName).catch((err) => UI.toast(err.message, 'error'));
        } else if (att.dataset.mediaKind === 'image') {
          PhotoViewer.open(att.dataset.attUrl, att.dataset.attName);
        } else if (!att.dataset.mediaKind) {
          AttachmentViewer.open(att.dataset.attUrl, att.dataset.attName);
        }
        return;
      }
      const chip = e.target.closest('.chat-reaction');
      if (chip) { react(Number(chip.closest('.chat-row').dataset.id), chip.dataset.emoji); return; }
      const actBtn = e.target.closest('[data-act]');
      if (!actBtn) return;
      const id = Number(actBtn.closest('.chat-row').dataset.id);
      if (actBtn.dataset.act === 'react') openEmojiPopover(actBtn, id);
      else if (actBtn.dataset.act === 'reply') startReply(id);
      else if (actBtn.dataset.act === 'edit') startEdit(id);
      else if (actBtn.dataset.act === 'unsend') unsend(id);
    });
    threadEl.querySelector('#chat-load-older button').addEventListener('click', loadOlder);
  }

  /* ---------- composer ---------- */

  function autoGrow(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 140) + 'px';
  }

  function wireComposer() {
    const input = threadEl.querySelector('#chat-input');
    const sendBtn = threadEl.querySelector('#chat-send-btn');
    const attachBtn = threadEl.querySelector('#chat-attach-btn');
    const fileInput = threadEl.querySelector('#chat-file-input');
    const filePreview = threadEl.querySelector('#chat-file-preview');
    let selectedFiles = [];
    function renderFiles() {
      filePreview.classList.toggle('hidden', !selectedFiles.length);
      filePreview.innerHTML = selectedFiles.map((file, index) => `<span class="chat-file-chip">${UI.esc(file.name)}<button type="button" data-remove="${index}" aria-label="Remove ${UI.esc(file.name)}">×</button></span>`).join('');
      filePreview.querySelectorAll('[data-remove]').forEach((button) => {
        button.onclick = () => { selectedFiles.splice(Number(button.dataset.remove), 1); renderFiles(); };
      });
    }

    input.addEventListener('input', () => {
      autoGrow(input);
      const now = Date.now();
      if (window.ChatWS && activeOtherId && now - lastTypingSentAt > 2500) {
        lastTypingSentAt = now;
        ChatWS.send({ type: 'typing', to: activeOtherId });
      }
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendOrSave(); }
    });
    sendBtn.addEventListener('click', sendOrSave);
    attachBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const picked = [...fileInput.files];
      if (selectedFiles.length + picked.length > 10) UI.toast('Up to 10 files per message', 'error');
      selectedFiles = selectedFiles.concat(picked).slice(0, 10);
      fileInput.value = '';
      renderFiles();
    });

    async function sendOrSave() {
      const body = input.value.trim();
      const files = selectedFiles.slice();
      if (editingId) {
        if (!body) { UI.toast('Message cannot be empty', 'error'); return; }
        const id = editingId;
        try {
          const res = await API.patch(`/messages/${id}`, { body });
          applyEdited(id, body, res.edited_at);
          editingId = null;
          input.value = '';
          autoGrow(input);
          renderReplyStrip();
        } catch (e) {
          UI.toast(e.message, 'error');
        }
        return;
      }
      if (!body && !(files && files.length)) return;
      sendBtn.disabled = true;
      attachBtn.disabled = true;
      try {
        if (files && files.length) {
          let outFiles = files;
          if (window.ImageCompress) {
            outFiles = await Promise.all(outFiles.map((f) => window.ImageCompress.maybeCompress(f, { thresholdBytes: 0, maxDim: 1600, quality: 0.8 })));
          }
          const fd = new FormData();
          fd.append('recipient_id', activeOtherId);
          fd.append('body', body);
          if (replyTo) fd.append('reply_to_id', replyTo.id);
          outFiles.forEach((f) => fd.append('files', f));
          await API.upload('/messages', fd);
        } else {
          await API.post('/messages', { recipient_id: activeOtherId, body, reply_to_id: replyTo ? replyTo.id : undefined });
        }
        input.value = '';
        selectedFiles = [];
        renderFiles();
        autoGrow(input);
        replyTo = null;
        renderReplyStrip();
        // The sender's own ChatWS connection also receives message:new (broadcast goes
        // to both parties), which appends the bubble — except when the socket isn't
        // connected, so fall back to a re-fetch in that case rather than leaving the
        // just-sent message invisible until the thread is reopened.
        if (!(window.ChatWS && ChatWS.connected)) await reloadCurrentThread();
      } catch (e) {
        UI.toast(e.message, 'error');
      } finally {
        sendBtn.disabled = false;
        attachBtn.disabled = false;
      }
    }
  }

  function applyEdited(id, body, editedAt) {
    const m = messages.find((x) => x.id === id);
    if (m) { m.body = body; m.edited_at = editedAt; }
    const row = threadEl.querySelector(`.chat-row[data-id="${id}"]`);
    if (row && m) row.outerHTML = bubbleHTML(m);
    if (m) hydrateBubbleExtras(m);
    loadConversations();
  }

  /* ---------- new conversation ---------- */

  async function newMessageModal() {
    const users = await API.get('/users');
    const opts = users.filter((u) => u.id !== me.id)
      .map((u) => `<option value="${u.id}" data-name="${UI.esc(u.full_name)}">${UI.esc(u.full_name)} (@${UI.esc(u.username)})${u.department_name ? ' · ' + UI.esc(u.department_name) : ''}</option>`).join('');
    UI.modal({
      title: 'New message',
      bodyHTML: `<div><label>To *</label><select data-f="recipient">${'<option value="">— Select recipient —</option>' + opts}</select></div>`,
      confirmText: 'Start',
      onConfirm: (overlay, showErr) => {
        const sel = overlay.querySelector('[data-f="recipient"]');
        if (!sel.value) { showErr('Please choose a recipient'); return false; }
        openConversation(Number(sel.value), sel.selectedOptions[0].dataset.name);
      },
    });
  }

  /* ---------- real-time ---------- */

  function belongsToActiveThread(data) {
    return activeOtherId != null && (data.sender_id === activeOtherId || data.recipient_id === activeOtherId);
  }

  function onWsMessageNew(data) {
    if (!data) return;
    loadConversations();
    if (!belongsToActiveThread(data)) return;
    const wasNearBottom = isNearBottom();
    messages.push({ ...data, mine: data.sender_id === me.id });
    const container = threadEl.querySelector('#chat-messages');
    if (container) {
      if (messages.length === 1) { renderMessages(); }
      else { container.insertAdjacentHTML('beforeend', bubbleHTML(messages[messages.length - 1])); hydrateBubbleExtras(messages[messages.length - 1]); }
      if (wasNearBottom) scrollToBottom();
    }
    if (data.sender_id === activeOtherId) {
      API.post(`/messages/with/${activeOtherId}/read`).then(() => App.refreshUnread()).catch(() => {});
    }
  }

  function onWsMessageEdited(data) {
    if (!data || !belongsToActiveThreadById(data.id)) return;
    applyEdited(data.id, data.body, data.edited_at);
  }

  function onWsMessageDeleted(data) {
    if (!data || !belongsToActiveThreadById(data.id)) return;
    applyRemoved(data.id);
  }

  function onWsReactionChanged(data) {
    if (!data || !belongsToActiveThreadById(data.message_id)) return;
    applyReactions(data.message_id, data.reactions);
  }

  function onWsTyping(data) {
    if (!data || data.from !== activeOtherId) return;
    const el = threadEl.querySelector('#chat-typing');
    if (!el) return;
    el.classList.remove('hidden');
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => el.classList.add('hidden'), 3000);
  }

  function belongsToActiveThreadById(id) {
    return messages.some((m) => m.id === id);
  }

  if (window.ChatWS) {
    if (_chatWsHandlers) {
      Object.keys(_chatWsHandlers).forEach((type) => ChatWS.off(type, _chatWsHandlers[type]));
    }
    _chatWsHandlers = {
      'message:new': onWsMessageNew,
      'message:edited': onWsMessageEdited,
      'message:deleted': onWsMessageDeleted,
      'reaction:changed': onWsReactionChanged,
      typing: onWsTyping,
    };
    Object.keys(_chatWsHandlers).forEach((type) => ChatWS.on(type, _chatWsHandlers[type]));
  }

  await loadConversations();
  if (filter && filter.userId) {
    const knownName = (conversations.find((c) => c.other_id === Number(filter.userId)) || {}).other_name;
    openConversation(Number(filter.userId), knownName);
  }
});
