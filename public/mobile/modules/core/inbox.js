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

  var closeActiveSheet = null;
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
    var conversations = [], loading = false, loadError = null;
    view.querySelector('#m-inbox-new').onclick = function () { newMessage(view); };

    function renderList() {
      if (!host.isConnected) return;
      if (loading) { host.innerHTML = '<div class="m-hint" role="status">Loading conversations…</div>'; return; }
      if (loadError) {
        host.innerHTML = '<div class="m-error" role="alert">' + mEsc(loadError.message || 'Could not load conversations') + '</div><button class="m-v2-secondary" id="m-inbox-retry" type="button">Try again</button>';
        host.querySelector('button').onclick = load; return;
      }
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

    function load() {
      if (loading || !host.isConnected) return;
      loading = true; loadError = null; renderList();
      API.get('/messages/conversations').then(function (rows) { conversations = rows || []; })
        .catch(function (error) { loadError = error; })
        .finally(function () { loading = false; renderList(); });
    }
    load();
  }

  function newMessage(view) {
    MApp.setTitle('New message');
    view.setAttribute('data-figma-node', '46:808');
    view.innerHTML = '<section class="m-v2-page m-inbox-v2"><header class="m-v2-heading m-chat-heading">' +
      '<button class="m-chat-back" type="button" aria-label="Back">‹</button><div><h1>New message</h1><p>Choose an employee to start a conversation</p></div></header>' +
      '<label class="m-field"><span class="m-label">Filter employees</span><input class="m-input" type="search" data-recipient-search placeholder="Name or department" /></label>' +
      '<div id="m-new-message"></div></section>';
    view.querySelector('.m-chat-back').onclick = function () { convoList(view); };
    var host = view.querySelector('#m-new-message'), search = view.querySelector('[data-recipient-search]');
    var available = [], loading = false, error = null, selected = '';
    function paint() {
      if (!host.isConnected) return;
      if (loading) { host.innerHTML = '<div class="m-hint" role="status">Loading directory…</div>'; return; }
      if (error) {
        host.innerHTML = '<div class="m-error" role="alert">' + mEsc(error.message || 'Could not load employees') + '</div><button class="m-v2-secondary" type="button">Try again</button>';
        host.querySelector('button').onclick = load; return;
      }
      var term = search.value.trim().toLowerCase();
      var visible = available.filter(function (u) { return (String(u.full_name || '') + ' ' + String(u.department_name || '')).toLowerCase().indexOf(term) !== -1; });
      host.innerHTML = '<label class="m-new-recipient"><span>Recipient</span><select data-to><option value="">Choose an employee</option>' +
        visible.map(function (u) { return '<option value="' + mEsc(u.id) + '">' + mEsc(u.full_name) + (u.department_name ? ' — ' + mEsc(u.department_name) : '') + '</option>'; }).join('') +
        '</select></label>' + (!visible.length ? '<p class="m-hint" role="status">' + (available.length ? 'No employees match. Try another search.' : 'No other employees are available to message.') + '</p>' : '') +
        '<button class="m-v2-primary" data-start type="button"' + (!visible.length ? ' disabled' : '') + '>Start conversation</button>';
      var select = host.querySelector('[data-to]'); select.value = selected;
      select.onchange = function () { selected = select.value; };
      host.querySelector('[data-start]').onclick = function () {
        if (this.disabled) return;
        var person = visible.filter(function (u) { return String(u.id) === select.value; })[0];
        if (!person) { mToast('Choose a recipient', 'err'); select.focus(); return; }
        this.disabled = true;
        MApp.go('inbox', { thread: person.id, name: person.full_name });
      };
    }
    function load() {
      if (loading || !host.isConnected) return;
      loading = true; error = null; paint();
      API.get('/users').then(function (users) {
        var me = MApp.getMe() || {};
        available = (users || []).filter(function (u) { return String(u.id) !== String(me.id); });
      }).catch(function (ex) { error = ex; }).finally(function () { loading = false; paint(); });
    }
    search.oninput = paint; load();
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
      '<p class="m-hint" data-history-feedback role="status"></p>' +
      '<p class="m-hint" data-chat-feedback role="status"></p><div data-chat-leave></div>' +
      '<div id="m-chat-reply-strip" class="m-chat-reply-strip hidden"></div>' +
      '<div id="m-chat-files" class="m-chat-files hidden" aria-live="polite"></div>' +
      '<div class="m-chat-compose">' +
      '<button class="m-chat-attach-button" id="m-chat-attach" type="button" aria-label="Attach files">＋</button>' +
      '<input type="file" id="m-chat-file" multiple aria-label="Choose files to attach" />' +
      '<textarea id="m-chat-input" rows="1" placeholder="Write a message…" aria-label="Message"></textarea>' +
      '<button class="m-chat-send-button" id="m-chat-send" type="button" aria-label="Send message">➤</button>' +
      '</div></section>';
    state.container = view.querySelector('.m-chat-v2');
    view.querySelector('[data-back]').onclick = function () { MApp.back(); };
    wireComposer();
    fitThreadToViewport();
    view.querySelector('#m-chat-load-older button').onclick = loadOlder;

    loadThread(state, true);
  }

  function activeThread(thread) { return !!thread && state === thread && thread.container && thread.container.isConnected; }
  function threadFeedback(thread, message, history) {
    if (!activeThread(thread)) return;
    thread.view.querySelector(history ? '[data-history-feedback]' : '[data-chat-feedback]').textContent = message;
  }
  function mergeMessages(rows, existing) {
    var ids = Object.create(null);
    var merged = rows.slice();
    rows.forEach(function (m) { ids[m.id] = true; });
    existing.forEach(function (m) { if (!ids[m.id]) { merged.push(m); ids[m.id] = true; } });
    return merged.sort(function (a, b) { return a.id - b.id; });
  }
  function loadThread(thread, initial) {
    if (!activeThread(thread)) return;
    if (thread.loading) { if (!initial) thread.refreshAfterLoad = true; return; }
    thread.loading = true;
    var container = thread.view.querySelector('#m-chat-messages');
    var nearBottom = initial || isNearBottom();
    if (initial) container.innerHTML = '<div class="m-hint" role="status">Loading messages…</div>';
    API.get('/messages/with/' + thread.otherId + '?limit=' + Math.max(thread.messages.length, 50)).then(function (rows) {
      if (!activeThread(thread)) return;
      thread.messages = mergeMessages(rows.slice().reverse(), thread.messages);
      renderMessages();
      if (nearBottom) scrollToBottom();
      thread.view.querySelector('#m-chat-load-older').classList.toggle('hidden', rows.length < 50);
      API.post('/messages/with/' + thread.otherId + '/read').catch(function () {});
    }).catch(function (error) {
      if (!activeThread(thread)) return;
      if (initial) {
        container.innerHTML = '<div class="m-error" role="alert">' + mEsc(error.message || 'Could not load messages') + '</div><button class="m-v2-secondary" type="button">Try again</button>';
        container.querySelector('button').onclick = function () { loadThread(thread, true); };
      } else threadFeedback(thread, 'Could not refresh messages. Reopen the conversation to try again.', true);
    }).finally(function () {
      thread.loading = false;
      if (thread.refreshAfterLoad && activeThread(thread)) { thread.refreshAfterLoad = false; loadThread(thread, false); }
    });
  }

  function loadOlder() {
    var thread = state;
    if (!activeThread(thread) || thread.olderPending || !thread.messages.length) return;
    var before = thread.messages[0].id;
    var button = thread.view.querySelector('#m-chat-load-older button');
    thread.olderPending = true; button.disabled = true; button.textContent = 'Loading…';
    threadFeedback(thread, '', true);
    API.get('/messages/with/' + thread.otherId + '?limit=50&before=' + before).then(function (older) {
      if (!activeThread(thread)) return;
      var container = thread.view.querySelector('#m-chat-messages');
      var prevHeight = container.scrollHeight;
      thread.messages = mergeMessages(older.slice().reverse(), thread.messages);
      renderMessages();
      container.scrollTop += container.scrollHeight - prevHeight;
      thread.view.querySelector('#m-chat-load-older').classList.toggle('hidden', older.length < 50);
    }).catch(function () { threadFeedback(thread, 'Could not load earlier messages. Tap Load earlier to retry.', true); })
      .finally(function () { thread.olderPending = false; button.disabled = false; button.textContent = 'Load earlier'; });
  }

  function scrollToBottom() {
    if (!activeThread(state)) return;
    var c = state.view.querySelector('#m-chat-messages');
    if (c) c.scrollTop = c.scrollHeight;
  }

  function fitThreadToViewport() {
    var thread = state, focusTimers = [];
    document.body.classList.add('m-chat-thread-active');
    var viewport = window.visualViewport;
    var input = state.view.querySelector('#m-chat-input');
    function update() {
      if (!activeThread(thread)) return;
      var height = viewport ? viewport.height : window.innerHeight;
      var top = viewport ? viewport.offsetTop : 0;
      document.documentElement.style.setProperty('--chat-viewport-height', Math.round(height) + 'px');
      document.documentElement.style.setProperty('--chat-viewport-top', Math.round(top) + 'px');
      document.body.classList.toggle('m-chat-keyboard-open', !!viewport && viewport.height < window.innerHeight - 100);
      if (document.activeElement === input) requestAnimationFrame(scroll);
    }
    function scroll() { if (activeThread(thread)) scrollToBottom(); }
    function focus() {
      update(); scroll();
      focusTimers.forEach(clearTimeout);
      focusTimers = [setTimeout(scroll, 120), setTimeout(scroll, 320)];
    }
    input.addEventListener('focus', focus);
    if (viewport) {
      viewport.addEventListener('resize', update);
      viewport.addEventListener('scroll', update);
    }
    window.addEventListener('resize', update);
    update();
    window.mChatViewport = { release: function () {
      focusTimers.forEach(clearTimeout);
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
    if (!activeThread(state)) return false;
    var c = state.view.querySelector('#m-chat-messages');
    if (!c) return true;
    return c.scrollHeight - c.scrollTop - c.clientHeight < 120;
  }

  /* ---------- rendering ---------- */

  function reactionsHTML(reactions) {
    if (!reactions || !reactions.length) return '';
    return '<div class="m-chat-reactions">' + reactions.map(function (r) {
      return '<button type="button" class="m-chat-reaction' + (r.mine ? ' mine' : '') + '" aria-pressed="' + !!r.mine + '" aria-label="' + mEsc((EMOJI_NAMES[r.emoji] || r.emoji) + ', ' + r.count + (r.mine ? ', your reaction' : '')) + '" data-emoji="' + mEsc(r.emoji) + '">' + mEsc(r.emoji) + ' ' + r.count + '</button>';
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
    var thread = state;
    var row = thread.view.querySelector('.m-chat-row[data-id="' + m.id + '"]');
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
      if (!activeThread(thread) || !host.isConnected) return;
      thread.linkPreviewCache[url] = data;
      renderLinkPreview(host, url, data);
    }).catch(function () { thread.linkPreviewCache[url] = null; });
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
        var button = el, thread = state; if (button.disabled) return; button.disabled = true;
        react(Number(el.closest('.m-chat-row').dataset.id), el.dataset.emoji).catch(function () { threadFeedback(thread, 'Could not confirm the reaction. Check its badge before trying again.'); }).finally(function () { button.disabled = false; });
      });
    });
    container.querySelectorAll('.m-chat-row:not([data-wired])').forEach(function (row) {
      row.dataset.wired = '1';
      wireSwipeAndLongPress(row);
    });
  }

  function wireSwipeAndLongPress(row) {
    var id = Number(row.dataset.id);
    row.tabIndex = 0;
    row.setAttribute('aria-label', 'Message actions: ' + String(row.querySelector('.m-chat-text') ? row.querySelector('.m-chat-text').textContent : 'Attachment').slice(0, 100));
    row.addEventListener('contextmenu', function (event) { event.preventDefault(); openActionSheet(id); });
    row.addEventListener('keydown', function (event) { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); openActionSheet(id); } });
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

  var pendingReactions = Object.create(null), pendingRemovals = Object.create(null);
  var EMOJI_NAMES = { '👍': 'Like', '❤️': 'Love', '😆': 'Laugh', '😮': 'Wow', '😢': 'Sad', '🙏': 'Thanks' };
  function operationKey(messageId) { return (MApp.getMe() || {}).id + ':' + messageId; }
  function messageContext(message) {
    return '<div class="m-chat-sheet-context"><b>Message actions</b><p>' + mEsc(message.mine ? 'Your message' : state.otherName) + ' · ' + mEsc(mFmtTime(message.created_at)) + '</p><small>' + mEsc(String(message.body || 'Attachment').slice(0, 120)) + '</small></div>';
  }
  function makeReactionBar(thread, message, root, close) {
    var popover = mEl('<div class="m-chat-reaction-popover"><div class="m-chat-reaction-bar" role="group" aria-label="React to message"></div><p data-reaction-status role="status" hidden></p></div>');
    var bar = popover.querySelector('.m-chat-reaction-bar'), feedback = popover.querySelector('[data-reaction-status]');
    var key = operationKey(message.id);
    var scroller = thread.view.querySelector('#m-chat-messages'), oldPadding = scroller.style.paddingBottom, oldScroll = scroller.scrollTop, shifted = false;
    function position() {
      var row = thread.view.querySelector('.m-chat-row[data-id="' + message.id + '"] .m-chat-bubble');
      if (!row || !popover.isConnected) return;
      var rect = row.getBoundingClientRect(), size = popover.getBoundingClientRect();
      var vp = window.visualViewport, top = vp ? vp.offsetTop : 0, height = vp ? vp.height : window.innerHeight;
      var sheetTop = root.querySelector('.m-chat-sheet').getBoundingClientRect().top;
      var bottom = Math.min(top + height - 12, sheetTop - 12);
      if (rect.bottom > bottom) {
        if (!shifted) { shifted = true; scroller.style.paddingBottom = (parseFloat(getComputedStyle(scroller).paddingBottom) + root.querySelector('.m-chat-sheet').offsetHeight + size.height + 32) + 'px'; }
        scroller.scrollTop += rect.bottom - bottom; rect = row.getBoundingClientRect();
      }
      popover.style.left = Math.max(12, Math.min(window.innerWidth - size.width - 12, message.mine ? rect.right - size.width : rect.left)) + 'px';
      popover.style.top = Math.max(top + 12, Math.min(bottom - size.height, rect.top - size.height - 10)) + 'px';
    }
    function paint() {
      var busy = !!pendingReactions[key];
      var latest = thread.messages.filter(function (m) { return m.id === message.id; })[0] || message;
      bar.querySelectorAll('button').forEach(function (button) {
        var selected = (latest.reactions || []).some(function (r) { return r.mine && r.emoji === button.dataset.emoji; });
        button.setAttribute('aria-pressed', String(selected)); button.disabled = busy;
        button.setAttribute('aria-label', (selected ? 'Remove ' : 'React with ') + EMOJI_NAMES[button.dataset.emoji]);
      });
      if (busy) { feedback.hidden = false; feedback.textContent = 'Saving reaction…'; }
      position();
    }
    QUICK_EMOJI.forEach(function (emoji) {
      var button = mEl('<button type="button" data-emoji="' + mEsc(emoji) + '">' + emoji + '</button>');
      button.onclick = function () {
        if (!activeThread(thread) || thread.sending || pendingReactions[key]) return;
        var job = react(message.id, emoji);
        paint();
        job.then(function () { close(); }).catch(function () {
          if (!root.isConnected) return;
          feedback.hidden = false; feedback.textContent = 'Could not confirm the reaction. Check the current badge before trying again.'; paint();
        });
      };
      bar.appendChild(button);
    });
    root.appendChild(popover); paint();
    if (pendingReactions[key]) pendingReactions[key].then(function () { if (root.isConnected) { feedback.hidden = true; paint(); } }, function () { if (root.isConnected) { feedback.hidden = false; feedback.textContent = 'Reaction could not be confirmed. Try again after checking the badge.'; paint(); } });
    window.addEventListener('resize', position); thread.view.addEventListener('scroll', position, true);
    if (window.visualViewport) { visualViewport.addEventListener('resize', position); visualViewport.addEventListener('scroll', position); }
    return function () {
      window.removeEventListener('resize', position); thread.view.removeEventListener('scroll', position, true);
      if (shifted) { scroller.style.paddingBottom = oldPadding; scroller.scrollTop = oldScroll; }
      if (window.visualViewport) { visualViewport.removeEventListener('resize', position); visualViewport.removeEventListener('scroll', position); }
    };
  }
  function openActionSheet(messageId, reactionsOnly) {
    if (!activeThread(state) || state.sending) return;
    if (closeActiveSheet) closeActiveSheet();
    var thread = state, message = thread.messages.filter(function (m) { return m.id === messageId; })[0];
    if (!message || message.deleted_at) return;
    var invokingRow = thread.view.querySelector('.m-chat-row[data-id="' + messageId + '"]');
    if (invokingRow) invokingRow.focus({ preventScroll: true });
    var root = mEl('<div class="m-chat-sheet-backdrop" aria-label="' + (reactionsOnly ? 'React to message' : 'Message actions') + '"></div>');
    var sheet = mEl('<div class="m-chat-sheet">' + messageContext(message) + '</div>');
    var control, releaseBar = function () {};
    function close() { return control && control.close(); }
    if (!reactionsOnly) {
      var actions = [{ label: 'Reply', act: function () { startReply(messageId); } }];
      if (message.mine) { actions.push({ label: 'Edit', act: function () { startEdit(messageId); } }); actions.push({ label: 'Remove', danger: true, act: function () { unsend(messageId); } }); }
      actions.forEach(function (action) {
        var button = mEl('<button type="button" class="m-chat-sheet-row' + (action.danger ? ' danger' : '') + '">' + action.label + '</button>');
        button.onclick = function () { close(); if (activeThread(thread) && !thread.sending) action.act(); };
        sheet.appendChild(button);
      });
    }
    var cancel = mEl('<button type="button" class="m-chat-sheet-row cancel">Cancel</button>'); cancel.onclick = close; sheet.appendChild(cancel);
    root.appendChild(sheet); overlayRoot().appendChild(root);
    releaseBar = makeReactionBar(thread, message, root, close);
    control = MessageOverlay.mount(root, { initialFocus: '.m-chat-reaction-bar button', onClose: function () { releaseBar(); if (closeActiveSheet === control.close) closeActiveSheet = null; } });
    closeActiveSheet = control.close;
    var selected = root.querySelector('.m-chat-reaction-bar button[aria-pressed="true"]'); if (selected && !selected.disabled) selected.focus();
  }
  function openEmojiSheet(messageId) { openActionSheet(messageId, true); }
  function react(messageId, emoji) {
    var thread = state, key = operationKey(messageId);
    if (pendingReactions[key]) return pendingReactions[key];
    var job = API.post('/messages/' + messageId + '/react', { emoji: emoji }).then(function (result) {
      if (activeThread(thread)) applyReactions(messageId, result.reactions);
    }).finally(function () { delete pendingReactions[key]; });
    pendingReactions[key] = job;
    return job;
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
    if (!activeThread(state) || state.sending) return;
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
    if (!activeThread(state) || state.sending) return;
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
      strip.querySelector('[data-cancel]').onclick = function () { if (state.sending) return; state.replyTo = null; renderReplyStrip(); };
      sendBtn.textContent = 'Send';
    } else if (state.editingId) {
      strip.classList.remove('hidden');
      strip.innerHTML = '<div><b>Editing message</b></div><button data-cancel>✕</button>';
      strip.querySelector('[data-cancel]').onclick = function () { if (state.sending) return; state.editingId = null; state.view.querySelector('#m-chat-input').value = ''; renderReplyStrip(); };
      sendBtn.textContent = 'Save';
    } else {
      strip.classList.add('hidden');
      strip.innerHTML = '';
      sendBtn.textContent = 'Send';
    }
  }

  function unsend(messageId) {
    if (!activeThread(state)) return;
    if (pendingRemovals[operationKey(messageId)]) { threadFeedback(state, 'This message is already being removed…'); return; }
    if (closeActiveSheet) closeActiveSheet();
    var thread = state, message = thread.messages.filter(function (m) { return m.id === messageId; })[0];
    if (!message || !message.mine || message.deleted_at) return;
    var root = mEl('<div class="m-chat-sheet-backdrop m-chat-remove-backdrop" aria-label="Remove message for everyone?"><div class="m-chat-remove-dialog"><h2>Remove message for everyone?</h2><p>This cannot be undone. Attached files and reactions will also be removed.</p><blockquote>' + mEsc(String(message.body || 'Attachment').slice(0, 180)) + '</blockquote><p data-remove-error role="alert" tabindex="-1"></p><div class="m-actions"><button class="m-btn m-btn-secondary" type="button" data-cancel>Cancel</button><button class="m-btn m-btn-danger" type="button" data-confirm>Remove for everyone</button></div></div></div>');
    var busy = false, key = operationKey(messageId);
    overlayRoot().appendChild(root);
    var control = MessageOverlay.mount(root, { initialFocus: '[data-cancel]', canClose: function () { return !busy; }, onClose: function () { if (closeActiveSheet === destroy) closeActiveSheet = null; if (activeThread(thread) && !thread.view.querySelector('.m-chat-row[data-id="' + messageId + '"]')) thread.view.querySelector('#m-chat-input').focus(); } });
    function destroy() { busy = false; control.close(); }
    closeActiveSheet = destroy;
    var cancel = root.querySelector('[data-cancel]'), confirm = root.querySelector('[data-confirm]'), error = root.querySelector('[data-remove-error]');
    cancel.onclick = control.close;
    confirm.onclick = async function () {
      if (busy || pendingRemovals[key]) return;
      busy = true; cancel.disabled = true; confirm.disabled = true; confirm.textContent = 'Removing…'; error.textContent = '';
      root.setAttribute('aria-busy', 'true');
      try {
        var job = API.del('/messages/' + messageId); pendingRemovals[key] = job;
        await job;
        if (activeThread(thread)) applyRemoved(messageId);
        busy = false; control.close();
      } catch (failure) { if (root.isConnected) { error.textContent = failure.message || 'Could not remove this message. Try again.'; error.focus(); } }
      finally { delete pendingRemovals[key]; busy = false; cancel.disabled = false; confirm.disabled = false; confirm.textContent = 'Remove for everyone'; root.removeAttribute('aria-busy'); }
    };
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
    var thread = state;
    var input = thread.view.querySelector('#m-chat-input');
    var sendBtn = thread.view.querySelector('#m-chat-send');
    var attachBtn = thread.view.querySelector('#m-chat-attach');
    var fileInput = thread.view.querySelector('#m-chat-file');
    var filePreview = thread.view.querySelector('#m-chat-files');
    var selectedFiles = [];
    var uploadStatus = MessageUpload.create(filePreview);
    // Drafts stay scoped to both account and recipient; borrowed-phone drafts stay in this tab.
    var me = MApp.getMe() || {};
    var draftKey = 'vds-chat-draft:' + me.id + ':' + thread.otherId;
    var draftStore = API.isSharedSession() ? sessionStorage : localStorage;
    try { input.value = draftStore.getItem(draftKey) || ''; } catch (e) {}
    function saveDraft() {
      try { if (input.value.trim()) draftStore.setItem(draftKey, input.value); else draftStore.removeItem(draftKey); } catch (e) {}
    }
    function growInput() {
      input.style.height = 'auto';
      input.style.height = Math.min(112, Math.max(44, input.scrollHeight)) + 'px';
    }
    if (input.value) growInput();
    function renderFiles() {
      filePreview.classList.toggle('hidden', !selectedFiles.length);
      filePreview.innerHTML = selectedFiles.map(function (file, index) {
        return '<span class="m-chat-file-chip">' + mEsc(file.name) + '<button type="button" data-remove="' + index + '" aria-label="Remove ' + mEsc(file.name) + '"' + (thread.sending ? ' disabled' : '') + '>×</button></span>';
      }).join('');
      filePreview.querySelectorAll('[data-remove]').forEach(function (button) {
        button.onclick = function () { if (thread.sending) return; selectedFiles.splice(Number(button.dataset.remove), 1); renderFiles(); threadFeedback(thread, selectedFiles.length ? selectedFiles.length + ' files selected. They are not uploaded yet.' : 'Selected files removed.'); };
      });
    }
    // Protect file selections for every hash navigation (dock, Back, deep links), not just Back.
    var originalHash = location.hash;
    var bypass = false;
    var navigation = {
      allow: function () {
        if (bypass || !activeThread(thread) || (!thread.sending && !selectedFiles.length)) return true;
        var destination = location.hash;
        history.replaceState(null, '', originalHash);
        var box = thread.view.querySelector('[data-chat-leave]');
        box.innerHTML = '<div class="m-hint" role="alert"><b>' + (thread.sending ? 'A message is still being sent.' : 'Selected files will be discarded.') + '</b><p>' +
          (thread.sending ? 'Wait for it to finish before leaving this conversation.' : 'Text drafts are saved separately. Selected files stay only while this conversation is open.') + '</p>' +
          '<div class="m-actions"><button class="m-v2-secondary" type="button" data-stay>Stay</button>' + (!thread.sending ? '<button class="m-v2-secondary" type="button" data-discard>Leave and discard files</button>' : '') + '</div></div>';
        box.querySelector('[data-stay]').onclick = function () { box.innerHTML = ''; input.focus(); };
        var discard = box.querySelector('[data-discard]');
        if (discard) discard.onclick = function () {
          if (thread.sending) return;
          bypass = true;
          history.replaceState(null, '', destination);
          window.dispatchEvent(new HashChangeEvent('hashchange'));
        };
        box.querySelector('[data-stay]').focus();
        return false;
      },
      release: function () { if (closeActiveSheet) closeActiveSheet(); window.removeEventListener('beforeunload', beforeUnload); if (window.mChatNavigation === navigation) window.mChatNavigation = null; }
    };
    function beforeUnload(event) {
      if (activeThread(thread) && (thread.sending || selectedFiles.length)) { event.preventDefault(); event.returnValue = ''; }
    }
    window.mChatNavigation = navigation;
    window.addEventListener('beforeunload', beforeUnload);

    attachBtn.onclick = function () { if (!thread.sending) fileInput.click(); };
    fileInput.onchange = function () {
      if (thread.sending) { fileInput.value = ''; return; }
      var incoming = Array.prototype.slice.call(fileInput.files || []);
      if (selectedFiles.length + incoming.length > 10) {
        fileInput.value = '';
        threadFeedback(thread, 'Up to 10 files per message. Extra files were not added; remove a selected file before adding more.'); return;
      }
      selectedFiles = selectedFiles.concat(incoming);
      fileInput.value = ''; renderFiles();
      threadFeedback(thread, selectedFiles.length ? selectedFiles.length + ' files selected. They are not uploaded yet.' : '');
    };
    sendBtn.onclick = sendOrSave;
    var lastTypingSentAt = 0;
    input.addEventListener('input', function () {
      if (!thread.editingId) saveDraft();
      growInput();
      if (isNearBottom()) requestAnimationFrame(function () { if (activeThread(thread)) scrollToBottom(); });
      var now = Date.now();
      if (window.ChatWS && now - lastTypingSentAt > 2500) { lastTypingSentAt = now; ChatWS.send({ type: 'typing', to: thread.otherId }); }
    });
    function setBusy(busy, editing) {
      thread.sending = busy;
      sendBtn.disabled = busy; attachBtn.disabled = busy; input.disabled = busy; fileInput.disabled = busy;
      filePreview.querySelectorAll('button').forEach(function (button) { button.disabled = busy; });
      thread.view.querySelectorAll('#m-chat-reply-strip button').forEach(function (button) { button.disabled = busy; });
      sendBtn.setAttribute('aria-label', busy ? (editing ? 'Saving edited message' : 'Sending message') : (thread.editingId ? 'Save edited message' : 'Send message'));
      thread.container.setAttribute('aria-busy', String(busy));
    }
    function sendOrSave() {
      if (!activeThread(thread) || thread.sending || sendBtn.disabled) return;
      var body = input.value.trim(), files = selectedFiles.slice(), editingId = thread.editingId;
      if (editingId && !body) { threadFeedback(thread, 'Message cannot be empty.'); input.focus(); return; }
      if (!body && !files.length) return;
      setBusy(true, !!editingId);
      threadFeedback(thread, editingId ? 'Saving message…' : 'Sending message…');
      var send;
      if (editingId) {
        send = API.patch('/messages/' + editingId, { body: body });
      } else if (files.length) {
        uploadStatus.start();
        send = Promise.all(files.map(function (file) {
          return window.ImageCompress ? ImageCompress.maybeCompress(file, { thresholdBytes: 0, maxDim: 1600, quality: 0.8 }) : file;
        })).then(function (ready) {
          var fd = new FormData();
          fd.append('recipient_id', thread.otherId); fd.append('body', body);
          if (thread.replyTo) fd.append('reply_to_id', thread.replyTo.id);
          ready.forEach(function (file) { fd.append('files', file, file.name); });
          return API.upload('/messages', fd, { onProgress: uploadStatus.progress });
        });
      } else {
        var payload = { recipient_id: thread.otherId, body: body };
        if (thread.replyTo) payload.reply_to_id = thread.replyTo.id;
        send = API.post('/messages', payload);
      }
      Promise.resolve(send).then(function (result) {
        if (!activeThread(thread)) return;
        if (editingId) {
          applyEdited(editingId, body, result.edited_at);
          thread.editingId = null;
          // Editing does not destroy a separate, unsent text draft.
          try { input.value = draftStore.getItem(draftKey) || ''; } catch (ignore) { input.value = ''; }
        } else {
          input.value = ''; saveDraft(); selectedFiles = []; renderFiles(); thread.replyTo = null;
          if (!(window.ChatWS && ChatWS.connected)) reloadThread();
        }
        growInput(); renderReplyStrip();
        threadFeedback(thread, editingId ? 'Message updated.' : 'Message sent.');
      }).catch(function (error) {
        threadFeedback(thread, editingId ? (error.message || 'Could not save the edit. Your changes are still here; try again.') :
          (error.offline ? 'Offline — could not confirm sending.' : (error.message || 'Could not confirm sending.')) + ' Your text and selected files remain here. Check the conversation before retrying to avoid a duplicate.');
      }).finally(function () { uploadStatus.stop(); setBusy(false, !!editingId); });
    }
  }

  function reloadThread() { loadThread(state, false); }

  /* ---------- real-time ---------- */

  function belongsToActiveThread(data) {
    return activeThread(state) && data && (data.sender_id === state.otherId || data.recipient_id === state.otherId);
  }
  function inActiveThread(id) {
    return activeThread(state) && state.messages.some(function (m) { return m.id === id; });
  }

  function onWsMessageNew(data) {
    if (!belongsToActiveThread(data) || inActiveThread(data.id)) return;
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
    if (!activeThread(state) || !data || data.from !== state.otherId) return;
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
