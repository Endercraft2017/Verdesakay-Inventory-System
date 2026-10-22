/* Dependency-free WebSocket client for live chat push (new messages/edits/unsends/
   reactions/typing — see src/shared/ws.ts). Everything else in this app is REST +
   polling; this is the one live channel, and it's purely additive: every consumer must
   keep working with ChatWS never connecting at all (self-hosted behind a proxy that
   strips Upgrade, a flaky network, ...). Auto-reconnects with backoff; callers should
   still poll (or just re-fetch on view load) as a fallback while ChatWS.connected is false.

   ChatWS.connect()            — open the socket for the current API token (no-op if already open/opening)
   ChatWS.disconnect()         — close it and stop reconnecting (call on logout)
   ChatWS.on(type, fn) / off() — subscribe/unsubscribe to a message `type` (e.g. 'message:new')
   ChatWS.send(obj)             — best-effort JSON send (silently dropped if not connected)
   ChatWS.connected             — bool getter */
(function () {
  var MAX_BACKOFF_MS = 15000;
  var MIN_BACKOFF_MS = 1000;

  var socket = null;
  var wantConnected = false; // true once connect() is called, false after disconnect()
  var backoff = MIN_BACKOFF_MS;
  var reconnectTimer = null;
  var listeners = {}; // type -> [fn, ...]

  function emit(type, data) {
    (listeners[type] || []).slice().forEach(function (fn) {
      try { fn(data); } catch (e) { /* one bad handler shouldn't break the others */ }
    });
  }

  function on(type, fn) {
    if (!listeners[type]) listeners[type] = [];
    listeners[type].push(fn);
  }

  function off(type, fn) {
    if (!listeners[type]) return;
    listeners[type] = listeners[type].filter(function (f) { return f !== fn; });
  }

  function scheduleReconnect() {
    if (!wantConnected || reconnectTimer) return;
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      if (wantConnected) open();
    }, backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }

  function open() {
    var token = window.API && API.getToken();
    if (!token) return; // not logged in yet
    // The installed phone app talks to the server it was pointed at, not its own bundled pages.
    var apiBase = window.API && API.base ? API.base() : '';
    var origin = /^https?:/.test(apiBase) ? apiBase.replace(/^http/, 'ws') : (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + apiBase;
    try {
      socket = new WebSocket(origin + '/ws?token=' + encodeURIComponent(token));
    } catch (e) {
      scheduleReconnect();
      return;
    }
    socket.onopen = function () {
      backoff = MIN_BACKOFF_MS;
      emit('_connected', null);
    };
    socket.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg && msg.type) emit(msg.type, msg.data);
    };
    socket.onclose = function () {
      socket = null;
      emit('_disconnected', null);
      scheduleReconnect();
    };
    socket.onerror = function () { /* onclose follows; reconnect handled there */ };
  }

  function connect() {
    if (wantConnected) return;
    wantConnected = true;
    backoff = MIN_BACKOFF_MS;
    open();
  }

  function disconnect() {
    wantConnected = false;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (socket) { socket.onclose = null; socket.close(); socket = null; }
  }

  function send(obj) {
    if (socket && socket.readyState === WebSocket.OPEN) {
      try { socket.send(JSON.stringify(obj)); } catch (e) { /* best-effort */ }
    }
  }

  window.ChatWS = {
    connect: connect,
    disconnect: disconnect,
    on: on,
    off: off,
    send: send,
    get connected() { return !!socket && socket.readyState === WebSocket.OPEN; },
  };
})();
