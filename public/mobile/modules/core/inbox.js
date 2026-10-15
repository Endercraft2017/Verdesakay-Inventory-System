/* Messages (mobile): conversation list + threaded bubbles, reactions, reply, edit,
   sender-only soft delete ("Message was removed"), link/file previews, real-time via
   ChatWS. Touch idioms replace desktop's hover: swipe a bubble to reply, long-press for
   the action sheet (React / Reply / Edit / Remove). */
(function () {
  var QUICK_EMOJI = ['👍', '❤️', '😆', '😮', '😢', '🙏'];
  var URL_RE = /(https?:\/\/[^\s<]+)/i;

  // Stable handler refs so re-entering this view swaps ChatWS listeners instead of
  // stacking a new set each time (mirrors public/js/modules/core/messages.js).
  var wsHandlers = null;

  var state = null; // per-open-thread state, see openThread()

  function overlayRoot() { return document.getElementById('m-overlay-root') || document.body; }

  /* ---------- conversation list ---------- */

  function convoList(view) {
    MApp.setTitle('Inbox');
    view.setAttribute('data-figma-node', '46:808');
    view.innerHTML =
      '<section class="m-v2-page m-inbox-v2"><header class="m-v2-heading"><h1>Inbox</h1>' +
      '<p>Messages and direct employee conversations</p></header>' +
      '<label class="m-inbox-search"><span aria-hidden="true">⌕</span><input type="search" id="m-inbox-search" placeholder="Search conversations" aria-label="Search conversations"></label>' +
      '<div class="m-inbox-filters" role="tablist"><button type="button" data-filter="all" aria-selected="true">All</button>' +
      '<button type="button" data-filter="unread" aria-selected="false">Unread</button></div>' +
      '<div id="m-inbox-list"><div class="m-hint">Loading…</div></div>' +
      '<div class="m-inbox-actions"><button class="m-v2-primary" id="m-inbox-new" type="button">＋ New message</button></div></section>';
    var host = view.querySelector('#m-inbox-list');
    var search = view.querySelector('#m-inbox-search');
    var activeFilter = 'all';
    var conversations = [];
    view.querySelector('#m-inbox-new').onclick = function () { newMessage(view); };

    function renderList() {
      var query = String(search.value || '').trim().toLowerCase();
      var visible = conversations.filter(function (c) {
        if (activeFilter === 'unread' && !c.unread_count) return false;
        return !query || String(c.other_name || '').toLowerCase().indexOf(query) >= 0 ||
          String(c.last_message || '').toLowerCase().indexOf(query) >= 0;
      });
      if (!visible.length) {
        host.innerHTML = '<div class="m-empty">' + (conversations.length ? 'No conversations match this view.' : 'No conversations yet.') + '</div>';
        return;
      }
      host.innerHTML = '';
      visible.forEach(function (c) {
        var button = mEl('<button class="m-inbox-row' + (c.unread_count ? ' unread' : '') + '" type="button">' +
          '<span class="m-inbox-avatar" aria-hidden="true">' + mEsc(String(c.other_name || '?').slice(0, 1).toUpperCase()) + '</span>' +
          '<span class="m-inbox-copy"><b>' + mEsc(c.other_name) + '</b><small>' + (c.last_message_mine ? 'You: ' : '') +
          mEsc((c.last_message || '').slice(0, 74)) + '</small></span>' +
          '<span class="m-inbox-meta"><time>' + mEsc(mFmtTime(c.last_message_at)) + '</time>' +
          (c.unread_count ? '<em>' + (c.unread_count > 99 ? '99+' : c.unread_count) + '</em>' : '') + '</span>' +
          '<i aria-hidden="true">›</i></button>');
        button.onclick = function () { MApp.go('inbox', { thread: c.other_id, name: c.other_name }); };
        host.appendChild(button);
      });
    }

    search.addEventListener('input', renderList);
    Array.prototype.forEach.call(view.querySelectorAll('[data-filter]'), function (button) {
      button.onclick = function () {
        activeFilter = this.getAttribute('data-filter');
        Array.prototype.forEach.call(view.querySelectorAll('[data-filter]'), function (item) {
          item.setAttribute('aria-selected', item === button ? 'true' : 'false');
        });
        renderList();
      };
    });

    API.get('/messages/conversations').then(function (rows) {
      conversations = rows || [];
      renderList();
    }).catch(function (ex) {
      host.innerHTML = '<div class="m-error">' + mEsc(ex.message) + '</div><button class="m-v2-secondary" id="m-inbox-retry" type="button">Try again</button>';
      host.querySelector('#m-inbox-retry').onclick = function () { convoList(view); };
    });
  }

  function newMessage(view) {
    MApp.setTitle('New message');
    view.setAttribute('data-figma-node', '46:808');
    view.innerHTML = '<section class="m-v2-page m-inbox-v2"><header class="m-v2-heading m-chat-heading">' +
      '<button class="m-chat-back" type="button" aria-label="Back">‹</button><div><h1>New message</h1><p>Choose an employee to start a conversation</p></div></header>' +
      '<div id="m-new-message"><div class="m-hint">Loading directory…</div></div></section>';
    view.querySelector('.m-chat-back').onclick = function () { convoList(view); };
    var host = view.querySelector('#m-new-message');
    API.get('/users').then(function (users) {
      var me = MApp.getMe();
      var available = (users || []).filter(function (u) { return u.id !== me.id; });
      host.innerHTML = '<label class="m-new-recipient"><span>Recipient</span><select data-to><option value="">Choose an employee</option>' +
        available.map(function (u) { return '<option value="' + u.id + '" data-name="' + mEsc(u.full_name) + '">' +
          mEsc(u.full_name) + (u.department_name ? ' — ' + mEsc(u.department_name) : '') + '</option>'; }).join('') +
        '</select></label><button class="m-v2-primary" data-start type="button">Start conversation</button>';
      host.querySelector('[data-start]').onclick = function () {
        var select = host.querySelector('[data-to]');
        if (!select.value) { mToast('Choose a recipient', 'err'); select.focus(); return; }
        var option = select.options[select.selectedIndex];
        MApp.go('inbox', { thread: select.value, name: option.getAttribute('data-name') || option.text });
      };
    }).catch(function (ex) {
      host.innerHTML = '<div class="m-error">' + mEsc(ex.message || 'Failed to load employees') + '</div>';
    });
  }

  /* ---------- thread ---------- */

  function openThread(view, otherId, knownName) {
    state = {
      view: view, otherId: otherId, otherName: knownName || '',
      messages: [], replyTo: null, editingId: null, linkPreviewCache: {},
    };
    MApp.setTitle('Messages');
    view.setAttribute('data-figma-node', '46:837');
    view.innerHTML =
      '<section class="m-v2-page m-chat-v2"><header class="m-v2-heading m-chat-heading">' +
      '<button class="m-chat-back" data-back type="button" aria-label="Back to conversations">‹</button>' +
      '<span class="m-chat-person-avatar" aria-hidden="true">' + mEsc((state.otherName || '?').slice(0, 1).toUpperCase()) + '</span><div><h1>' +
      mEsc(state.otherName || 'Conversation') + '</h1><p>Private conversation</p></div></header>' +
      '<div id="m-chat-typing" class="m-chat-typing hidden">typing…</div>' +
      '<div id="m-chat-load-older" class="m-chat-load-older hidden"><button class="m-v2-secondary" type="button">Load earlier</button></div>' +
      '<div id="m-chat-messages" class="m-chat-messages"><div class="m-hint">Loading…</div></div>' +
      '<div id="m-chat-reply-strip" class="m-chat-reply-strip hidden"></div>' +
      '<div id="m-chat-files" class="m-chat-files hidden" aria-live="polite"></div>' +
      '<div class="m-chat-compose">' +
      '<button class="m-chat-attach-button" id="m-chat-attach" type="button" aria-label="Attach files">＋</button>' +
      '<input type="file" id="m-chat-file" multiple aria-label="Choose files to attach" />' +
      '<textarea id="m-chat-input" rows="1" placeholder="Write a message…" aria-label="Message"></textarea>' +
      '<button class="m-chat-send-button" id="m-chat-send" type="button" aria-label="Send message">➤</button>' +
      '</div></section>';
    view.querySelector('[data-back]').onclick = function () { MApp.go('inbox'); };
    wireComposer();
    fitThreadToViewport();
    view.querySelector('#m-chat-load-older button').onclick = loadOlder;

    API.get('/messages/with/' + otherId + '?limit=50').then(function (rows) {
      rows.reverse();
      state.messages = rows;
      renderMessages();
      scrollToBottom();
      view.querySelector('#m-chat-load-older').classList.toggle('hidden', rows.length < 50);
      API.post('/messages/with/' + otherId + '/read').catch(function () {});
    }).catch(function (ex) {
      view.querySelector('#m-chat-messages').innerHTML = '<div class="m-error">' + mEsc(ex.message) + '</div>';
    });
  }

  function loadOlder() {
    if (!state || !state.messages.length) return;
    var before = state.messages[0].id;
    API.get('/messages/with/' + state.otherId + '?limit=50&before=' + before).then(function (older) {
      older.reverse();
      var container = state.view.querySelector('#m-chat-messages');
      var prevHeight = container.scrollHeight;
      state.messages = older.concat(state.messages);
      renderMessages();
      container.scrollTop = container.scrollHeight - prevHeight;
      state.view.querySelector('#m-chat-load-older').classList.toggle('hidden', older.length < 50);
    }).catch(function () {});
  }

  function scrollToBottom() {
    var c = state.view.querySelector('#m-chat-messages');
    if (c) c.scrollTop = c.scrollHeight;
  }

  function fitThreadToViewport() {
    document.body.classList.add('m-chat-thread-active');
    var viewport = window.visualViewport;
    var input = state.view.querySelector('#m-chat-input');
    function update() {
      var height = viewport ? viewport.height : window.innerHeight;
      var top = viewport ? viewport.offsetTop : 0;
      document.documentElement.style.setProperty('--chat-viewport-height', Math.round(height) + 'px');
      document.documentElement.style.setProperty('--chat-viewport-top', Math.round(top) + 'px');
      document.body.classList.toggle('m-chat-keyboard-open', !!viewport && viewport.height < window.innerHeight - 100);
      if (document.activeElement === input) requestAnimationFrame(scrollToBottom);
    }
    function focus() {
      update();
      scrollToBottom();
      setTimeout(scrollToBottom, 120);
      setTimeout(scrollToBottom, 320);
    }
    input.addEventListener('focus', focus);
    if (viewport) {
      viewport.addEventListener('resize', update);
      viewport.addEventListener('scroll', update);
    }
    window.addEventListener('resize', update);
    update();
    window.mChatViewport = { release: function () {
      input.removeEventListener('focus', focus);
      if (viewport) {
        viewport.removeEventListener('resize', update);
        viewport.removeEventListener('scroll', update);
      }
      window.removeEventListener('resize', update);
      document.body.classList.remove('m-chat-thread-active', 'm-chat-keyboard-open');
      document.documentElement.style.removeProperty('--chat-viewport-height');
      document.documentElement.style.removeProperty('--chat-viewport-top');
      window.mChatViewport = null;
    } };
  }

  function isNearBottom() {
    var c = state.view.querySelector('#m-chat-messages');
    if (!c) return true;
    return c.scrollHeight - c.scrollTop - c.clientHeight < 120;
  }

  /* ---------- rendering ---------- */

  function reactionsHTML(reactions) {
    if (!reactions || !reactions.length) return '';
    return '<div class="m-chat-reactions">' + reactions.map(function (r) {
      return '<span class="m-chat-reaction' + (r.mine ? ' mine' : '') + '" data-emoji="' + r.emoji + '">' + r.emoji + ' ' + r.count + '</span>';
    }).join('') + '</div>';
  }

  function attachmentHTML(a) {
    var isImage = (a.mime_type || '').indexOf('image/') === 0;
    if (isImage) {
      return '<div class="m-chat-attach-img-wrap" data-att-url="' + mEsc(a.url) + '" data-att-name="' + mEsc(a.name) + '"><img class="m-chat-attach-img" alt="" /><span class="m-chat-photo-error" hidden>Photo unavailable. Ask the sender to resend it.</span></div>';
    }
    return '<button type="button" class="m-msg-attach" data-att-url="' + mEsc(a.url) + '" data-att-name="' + mEsc(a.name) + '" aria-label="Preview ' + mEsc(a.name) + '">' +
      '<span>' + mEsc(a.name) + '</span><span class="m-muted">' + mFmtBytes(a.size_bytes) + '</span></button>';
  }

  function bubbleHTML(m) {
    if (m.deleted_at) {
      return '<div class="m-chat-row ' + (m.mine ? 'mine' : 'theirs') + '" data-id="' + m.id + '">' +
        '<div class="m-chat-bubble removed">Message was removed</div>' +
        '<div class="m-chat-time">' + mFmtTime(m.created_at) + '</div></div>';
    }
    var replyHtml = m.reply_to
      ? '<div class="m-chat-reply-quote" data-scroll-to="' + m.reply_to.id + '"><b>' + mEsc(m.reply_to.author) + '</b><br>' + mEsc(m.reply_to.preview) + '</div>'
      : '';
    var attHtml = (m.attachments || []).map(attachmentHTML).join('');
    var edited = m.edited_at ? '<span class="m-chat-edited">Edited</span>' : '';
    return '<div class="m-chat-row ' + (m.mine ? 'mine' : 'theirs') + '" data-id="' + m.id + '">' +
      '<div class="m-chat-bubble">' + replyHtml +
      (m.body ? '<div class="m-chat-text">' + mEsc(m.body) + '</div>' : '') +
      attHtml + '<div class="m-chat-link-preview-host"></div>' + edited + '</div>' +
      reactionsHTML(m.reactions) +
      '<div class="m-chat-time">' + mFmtTime(m.created_at) + '</div></div>';
  }

  function mFmtTime(s) {
    if (!s) return '';
    var d = new Date(String(s).replace(' ', 'T') + 'Z');
    if (isNaN(d)) return s;
    var today = new Date();
    if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  function renderMessages() {
    var container = state.view.querySelector('#m-chat-messages');
    if (!container) return;
    if (!state.messages.length) {
      container.innerHTML = '<div class="m-stack-empty">No messages yet. Say hello 👋</div>';
      return;
    }
    container.innerHTML = state.messages.map(bubbleHTML).join('');
    state.messages.forEach(hydrateBubbleExtras);
    wireBubbleInteractions(container);
  }

  function hydrateBubbleExtras(m) {
    var row = state.view.querySelector('.m-chat-row[data-id="' + m.id + '"]');
    if (!row) return;
    row.querySelectorAll('.m-chat-attach-img-wrap img').forEach(function (img) {
      var wrap = img.closest('.m-chat-attach-img-wrap');
      var unavailable = function () {
        img.hidden = true;
        wrap.querySelector('.m-chat-photo-error').hidden = false;
        wrap.dataset.unavailable = '1';
      };
      img.onerror = unavailable;
      API.blobUrl(wrap.dataset.attUrl).then(function (u) { img.src = u; }).catch(unavailable);
    });
    if (m.deleted_at || !m.body) return;
    var match = m.body.match(URL_RE);
    if (!match) return;
    var url = match[1];
    var host = row.querySelector('.m-chat-link-preview-host');
    if (!host) return;
    if (Object.prototype.hasOwnProperty.call(state.linkPreviewCache, url)) {
      renderLinkPreview(host, url, state.linkPreviewCache[url]);
      return;
    }
    API.get('/messages/link-preview?url=' + encodeURIComponent(url)).then(function (data) {
      state.linkPreviewCache[url] = data;
      renderLinkPreview(host, url, data);
    }).catch(function () { state.linkPreviewCache[url] = null; });
  }

  function renderLinkPreview(host, url, data) {
    if (!data || (!data.title && !data.description && !data.image_url)) return;
    var domain = '';
    try { domain = new URL(url).hostname; } catch (e) { /* ignore */ }
    host.innerHTML = '<a class="m-chat-link-preview" href="' + mEsc(url) + '" target="_blank" rel="noopener noreferrer">' +
      (data.image_url ? '<img class="m-chat-link-preview-img" src="' + mEsc(data.image_url) + '" alt="" />' : '') +
      '<div class="m-chat-link-preview-body">' +
      (data.title ? '<div class="m-chat-link-preview-title">' + mEsc(data.title) + '</div>' : '') +
      '<div class="m-chat-link-preview-domain">' + mEsc(data.site_name || domain) + '</div></div></a>';
  }

  /* ---------- interactions: tap, swipe-to-reply, long-press action sheet ---------- */

  /** Idempotent: safe to call repeatedly on the same container (full re-render or an
   *  incremental patch after react/edit/unsend) without stacking duplicate listeners —
   *  each element is marked data-wired once it has them. */
  function wireBubbleInteractions(container) {
    container.querySelectorAll('[data-scroll-to]:not([data-wired])').forEach(function (el) {
      el.dataset.wired = '1';
      el.addEventListener('click', function () {
        var target = state.view.querySelector('.m-chat-row[data-id="' + el.dataset.scrollTo + '"]');
        if (target) { target.scrollIntoView({ behavior: 'smooth', block: 'center' }); target.classList.add('flash'); setTimeout(function () { target.classList.remove('flash'); }, 1200); }
      });
    });
    container.querySelectorAll('[data-att-url]:not([data-wired])').forEach(function (el) {
      el.dataset.wired = '1';
      el.addEventListener('click', function (event) {
        event.stopPropagation();
        if (el.dataset.unavailable) return;
        if (el.classList.contains('m-chat-attach-img-wrap')) PhotoViewer.open(el.dataset.attUrl, el.dataset.attName);
        else AttachmentViewer.open(el.dataset.attUrl, el.dataset.attName);
      });
    });
    container.querySelectorAll('.m-chat-reaction:not([data-wired])').forEach(function (el) {
      el.dataset.wired = '1';
      el.addEventListener('click', function () {
        react(Number(el.closest('.m-chat-row').dataset.id), el.dataset.emoji);
      });
    });
    container.querySelectorAll('.m-chat-row:not([data-wired])').forEach(function (row) {
      row.dataset.wired = '1';
      wireSwipeAndLongPress(row);
    });
  }

  function wireSwipeAndLongPress(row) {
    var id = Number(row.dataset.id);
    var startX = 0, startY = 0, dx = 0, dragging = false, longPressTimer = null, longPressFired = false;

    row.addEventListener('touchstart', function (e) {
      var t = e.touches[0];
      startX = t.clientX; startY = t.clientY; dx = 0; dragging = false; longPressFired = false;
      longPressTimer = setTimeout(function () {
        longPressFired = true;
        if (navigator.vibrate) navigator.vibrate(15);
        openActionSheet(id);
      }, 500);
    }, { passive: true });

    row.addEventListener('touchmove', function (e) {
      var t = e.touches[0];
      dx = t.clientX - startX;
      var dy = t.clientY - startY;
      if (Math.abs(dx) > 8 || Math.abs(dy) > 8) clearTimeout(longPressTimer);
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 8) {
        dragging = true;
        var clamped = Math.max(-70, Math.min(70, dx));
        row.style.transform = 'translateX(' + clamped + 'px)';
      }
    }, { passive: true });

    row.addEventListener('touchend', function () {
      clearTimeout(longPressTimer);
      row.style.transform = '';
      if (dragging && !longPressFired && Math.abs(dx) > 55) {
        if (navigator.vibrate) navigator.vibrate(10);
        startReply(id);
      }
      dragging = false;
    });
    row.addEventListener('touchcancel', function () { clearTimeout(longPressTimer); row.style.transform = ''; dragging = false; });
  }

  function openActionSheet(messageId) {
    var m = state.messages.filter(function (x) { return x.id === messageId; })[0];
    if (!m || m.deleted_at) return;
    var root = overlayRoot();
    var backdrop = mEl('<div class="m-chat-sheet-backdrop"></div>');
    var sheet = mEl('<div class="m-chat-sheet"></div>');
    var rows = [
      { label: 'React', act: 'react' },
      { label: 'Reply', act: 'reply' },
    ];
    if (m.mine) rows.push({ label: 'Edit', act: 'edit' });
    if (m.mine) rows.push({ label: 'Remove', act: 'unsend', danger: true });
    rows.forEach(function (r) {
      var b = mEl('<button class="m-chat-sheet-row' + (r.danger ? ' danger' : '') + '">' + r.label + '</button>');
      b.onclick = function () {
        close();
        if (r.act === 'react') openEmojiSheet(messageId);
        else if (r.act === 'reply') startReply(messageId);
        else if (r.act === 'edit') startEdit(messageId);
        else if (r.act === 'unsend') unsend(messageId);
      };
      sheet.appendChild(b);
    });
    var cancel = mEl('<button class="m-chat-sheet-row cancel">Cancel</button>');
    cancel.onclick = close;
    sheet.appendChild(cancel);
    function close() { backdrop.remove(); sheet.remove(); }
    backdrop.onclick = close;
    root.appendChild(backdrop);
    root.appendChild(sheet);
  }

  function openEmojiSheet(messageId) {
    var root = overlayRoot();
    var backdrop = mEl('<div class="m-chat-sheet-backdrop"></div>');
    var bar = mEl('<div class="m-chat-emoji-sheet"></div>');
    QUICK_EMOJI.forEach(function (e) {
      var b = mEl('<button type="button">' + e + '</button>');
      b.onclick = function () { react(messageId, e); close(); };
      bar.appendChild(b);
    });
    function close() { backdrop.remove(); bar.remove(); }
    backdrop.onclick = close;
    root.appendChild(backdrop);
    root.appendChild(bar);
  }

  function react(messageId, emoji) {
    API.post('/messages/' + messageId + '/react', { emoji: emoji }).then(function (res) {
      applyReactions(messageId, res.reactions);
    }).catch(function (e) { mToast(e.message || 'Failed', 'err'); });
  }

  function applyReactions(messageId, rawReactions) {
    var me = MApp.getMe();
    var grouped = {};
    var order = [];
    (rawReactions || []).forEach(function (r) {
      if (!grouped[r.emoji]) { grouped[r.emoji] = { emoji: r.emoji, count: 0, mine: false }; order.push(r.emoji); }
      grouped[r.emoji].count += 1;
      if (r.user_id === me.id) grouped[r.emoji].mine = true;
    });
    var list = order.map(function (e) { return grouped[e]; });
    var m = state.messages.filter(function (x) { return x.id === messageId; })[0];
    if (m) m.reactions = list;
    var row = state.view.querySelector('.m-chat-row[data-id="' + messageId + '"]');
    if (!row) return;
    var existing = row.querySelector('.m-chat-reactions');
    var html = reactionsHTML(list);
    if (existing) existing.outerHTML = html;
    else if (html) row.querySelector('.m-chat-bubble').insertAdjacentHTML('afterend', html);
    if (row) wireBubbleInteractions(row.parentElement || state.view.querySelector('#m-chat-messages'));
  }

  function startReply(messageId) {
    var me = MApp.getMe();
    var m = state.messages.filter(function (x) { return x.id === messageId; })[0];
    if (!m || m.deleted_at) return;
    state.editingId = null;
    state.replyTo = { id: m.id, author: m.mine ? me.full_name : state.otherName, preview: m.body.length > 100 ? m.body.slice(0, 97) + '…' : m.body };
    renderReplyStrip();
    var input = state.view.querySelector('#m-chat-input');
    if (input) input.focus();
  }

  function startEdit(messageId) {
    var m = state.messages.filter(function (x) { return x.id === messageId; })[0];
    if (!m || m.deleted_at || !m.mine) return;
    state.replyTo = null;
    state.editingId = messageId;
    renderReplyStrip();
    var input = state.view.querySelector('#m-chat-input');
    input.value = m.body;
    input.focus();
  }

  function renderReplyStrip() {
    var strip = state.view.querySelector('#m-chat-reply-strip');
    var sendBtn = state.view.querySelector('#m-chat-send');
    if (state.replyTo) {
      strip.classList.remove('hidden');
      strip.innerHTML = '<div><b>Replying to ' + mEsc(state.replyTo.author) + '</b><br>' + mEsc(state.replyTo.preview) + '</div><button data-cancel>✕</button>';
      strip.querySelector('[data-cancel]').onclick = function () { state.replyTo = null; renderReplyStrip(); };
      sendBtn.textContent = 'Send';
    } else if (state.editingId) {
      strip.classList.remove('hidden');
      strip.innerHTML = '<div><b>Editing message</b></div><button data-cancel>✕</button>';
      strip.querySelector('[data-cancel]').onclick = function () { state.editingId = null; state.view.querySelector('#m-chat-input').value = ''; renderReplyStrip(); };
      sendBtn.textContent = 'Save';
    } else {
      strip.classList.add('hidden');
      strip.innerHTML = '';
      sendBtn.textContent = 'Send';
    }
  }

  function unsend(messageId) {
    if (!window.confirm('Remove this message for everyone? This cannot be undone.')) return;
    API.del('/messages/' + messageId).then(function () {
      applyRemoved(messageId);
    }).catch(function (e) { mToast(e.message || 'Failed', 'err'); });
  }

  function applyRemoved(messageId) {
    var m = state.messages.filter(function (x) { return x.id === messageId; })[0];
    if (m) { m.deleted_at = new Date().toISOString(); m.body = ''; m.attachments = []; m.reactions = []; }
    var row = state.view.querySelector('.m-chat-row[data-id="' + messageId + '"]');
    if (row && m) { var next = mEl(bubbleHTML(m)); row.replaceWith(next); }
  }

  function applyEdited(id, body, editedAt) {
    var m = state.messages.filter(function (x) { return x.id === id; })[0];
    if (m) { m.body = body; m.edited_at = editedAt; }
    var row = state.view.querySelector('.m-chat-row[data-id="' + id + '"]');
    if (row && m) { var next = mEl(bubbleHTML(m)); row.replaceWith(next); wireBubbleInteractions(state.view.querySelector('#m-chat-messages')); hydrateBubbleExtras(m); }
  }

  /* ---------- composer ---------- */

  function wireComposer() {
    var input = state.view.querySelector('#m-chat-input');
    var sendBtn = state.view.querySelector('#m-chat-send');
    var attachBtn = state.view.querySelector('#m-chat-attach');
    var fileInput = state.view.querySelector('#m-chat-file');
    var filePreview = state.view.querySelector('#m-chat-files');
    var selectedFiles = [];
    var uploadStatus = MessageUpload.create(filePreview);
    // Keep an unsent text draft through navigation or a dropped connection. Shared-phone
    // sessions keep it only in this tab; account and recipient are both part of the key.
    var me = MApp.getMe() || {};
    var draftKey = 'vds-chat-draft:' + me.id + ':' + state.otherId;
    var draftStore = API.isSharedSession() ? sessionStorage : localStorage;
    try { input.value = draftStore.getItem(draftKey) || ''; } catch (e) {}
    if (input.value) input.style.height = Math.min(112, Math.max(44, input.scrollHeight)) + 'px';
    function saveDraft() {
      try { if (input.value.trim()) draftStore.setItem(draftKey, input.value); else draftStore.removeItem(draftKey); } catch (e) {}
    }

    function renderFiles() {
      filePreview.classList.toggle('hidden', !selectedFiles.length);
      filePreview.innerHTML = selectedFiles.map(function (file, index) {
        return '<span class="m-chat-file-chip">' + mEsc(file.name) + '<button type="button" data-remove="' + index + '" aria-label="Remove ' + mEsc(file.name) + '">×</button></span>';
      }).join('');
      filePreview.querySelectorAll('[data-remove]').forEach(function (button) {
        button.onclick = function () { selectedFiles.splice(Number(button.dataset.remove), 1); renderFiles(); };
      });
    }

    attachBtn.onclick = function () { fileInput.click(); };
    fileInput.onchange = function () {
      if (selectedFiles.length + (fileInput.files || []).length > 10) mToast('Up to 10 files per message', 'err');
      selectedFiles = selectedFiles.concat(Array.prototype.slice.call(fileInput.files || [])).slice(0, 10);
      fileInput.value = '';
      renderFiles();
      if (selectedFiles.length) mToast('Files ready. Tap send when you are ready.');
    };
    sendBtn.onclick = sendOrSave;

    var lastTypingSentAt = 0;
    function growInput() {
      input.style.height = 'auto';
      input.style.height = Math.min(112, Math.max(44, input.scrollHeight)) + 'px';
    }
    input.addEventListener('input', function () {
      if (!state.editingId) saveDraft();
      growInput();
      if (isNearBottom()) requestAnimationFrame(scrollToBottom);
      var now = Date.now();
      if (window.ChatWS && state.otherId && now - lastTypingSentAt > 2500) {
        lastTypingSentAt = now;
        ChatWS.send({ type: 'typing', to: state.otherId });
      }
    });

    function sendOrSave() {
      if (sendBtn.disabled) return;
      var recipientId = state.otherId;
      var body = input.value.trim();
      var files = selectedFiles.slice();
      if (state.editingId) {
        if (!body) { mToast('Message cannot be empty', 'err'); return; }
        var id = state.editingId;
        API.patch('/messages/' + id, { body: body }).then(function (res) {
          applyEdited(id, body, res.edited_at);
          state.editingId = null;
          input.value = '';
          growInput();
          renderReplyStrip();
        }).catch(function (e) { mToast(e.message || 'Failed', 'err'); });
        return;
      }
      if (!body && !files.length) return;
      sendBtn.disabled = true;
      attachBtn.disabled = true;
      sendBtn.setAttribute('aria-label', 'Sending message');
      input.disabled = true;
      filePreview.querySelectorAll('button').forEach(function (button) { button.disabled = true; });
      if (files.length) uploadStatus.start();
      var replyToId = state.replyTo ? state.replyTo.id : null;
      var send;
      if (files.length) {
        send = Promise.all(files.map(function (file) {
          return window.ImageCompress ? ImageCompress.maybeCompress(file, { thresholdBytes: 0, maxDim: 1600, quality: 0.8 }) : file;
        })).then(function (ready) {
        var fd = new FormData();
        fd.append('recipient_id', recipientId);
        fd.append('body', body);
        if (replyToId) fd.append('reply_to_id', replyToId);
        ready.forEach(function (file) { fd.append('files', file, file.name); });
        return API.upload('/messages', fd, { onProgress: uploadStatus.progress });
        });
      } else {
        var payload = { recipient_id: state.otherId, body: body };
        if (replyToId) payload.reply_to_id = replyToId;
        send = API.post('/messages', payload);
      }
      send.then(function () {
        input.value = '';
        saveDraft();
        growInput();
        selectedFiles = [];
        renderFiles();
        state.replyTo = null;
        renderReplyStrip();
        if (!(window.ChatWS && ChatWS.connected)) reloadThread();
      }).catch(function (e) {
        mToast(e.offline ? 'Offline — message not sent. Your text stays as a draft; reconnect and tap Send.' : (e.message || 'Failed'), 'err');
      }).finally(function () {
        uploadStatus.stop();
        input.disabled = false;
        filePreview.querySelectorAll('button').forEach(function (button) { button.disabled = false; });
        sendBtn.disabled = false;
        attachBtn.disabled = false;
        sendBtn.setAttribute('aria-label', 'Send message');
      });
    }
  }

  function reloadThread() {
    if (!state) return;
    var wasNearBottom = isNearBottom();
    API.get('/messages/with/' + state.otherId + '?limit=' + Math.max(state.messages.length, 50)).then(function (rows) {
      rows.reverse();
      state.messages = rows;
      renderMessages();
      if (wasNearBottom) scrollToBottom();
    }).catch(function () {});
  }

  /* ---------- real-time ---------- */

  function belongsToActiveThread(data) {
    return state && data && (data.sender_id === state.otherId || data.recipient_id === state.otherId);
  }
  function inActiveThread(id) {
    return state && state.messages.some(function (m) { return m.id === id; });
  }

  function onWsMessageNew(data) {
    if (!belongsToActiveThread(data)) return;
    var wasNearBottom = isNearBottom();
    data.mine = data.sender_id === MApp.getMe().id;
    state.messages.push(data);
    var container = state.view.querySelector('#m-chat-messages');
    if (container) {
      if (state.messages.length === 1) { renderMessages(); }
      else { container.insertAdjacentHTML('beforeend', bubbleHTML(data)); hydrateBubbleExtras(data); wireBubbleInteractions(container); }
      if (wasNearBottom) scrollToBottom();
    }
    if (data.sender_id === state.otherId) API.post('/messages/with/' + state.otherId + '/read').catch(function () {});
  }
  function onWsMessageEdited(data) { if (data && inActiveThread(data.id)) applyEdited(data.id, data.body, data.edited_at); }
  function onWsMessageDeleted(data) { if (data && inActiveThread(data.id)) applyRemoved(data.id); }
  function onWsReactionChanged(data) { if (data && inActiveThread(data.message_id)) applyReactions(data.message_id, data.reactions); }

  var typingTimer = null;
  function onWsTyping(data) {
    if (!state || !data || data.from !== state.otherId) return;
    var el = state.view.querySelector('#m-chat-typing');
    if (!el) return;
    el.classList.remove('hidden');
    clearTimeout(typingTimer);
    typingTimer = setTimeout(function () { el.classList.add('hidden'); }, 3000);
  }

  function wireWs() {
    if (!window.ChatWS) return;
    if (wsHandlers) {
      Object.keys(wsHandlers).forEach(function (t) { ChatWS.off(t, wsHandlers[t]); });
    }
    wsHandlers = {
      'message:new': onWsMessageNew,
      'message:edited': onWsMessageEdited,
      'message:deleted': onWsMessageDeleted,
      'reaction:changed': onWsReactionChanged,
      typing: onWsTyping,
    };
    Object.keys(wsHandlers).forEach(function (t) { ChatWS.on(t, wsHandlers[t]); });
  }

  /* ---------- route ---------- */

  MApp.route('inbox', function (view, params) {
    wireWs();
    if (params && (params.thread || params.user)) {
      var otherId = Number(params.thread || params.user);
      var known = params.name || null;
      openThread(view, otherId, known);
    } else {
      state = null;
      convoList(view);
    }
  });

  window.mCompose = function (toId, toName) {
    MApp.go('inbox', { thread: toId, name: toName || '' });
  };
})();
