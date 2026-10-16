/* Lightweight API client with token handling.

   Every request carries X-Device-Id: a random ID this browser/app generates once and keeps
   (vds_device_id). It is not a fingerprint — it names the device so the server can show where
   an account is signed in (src/shared/device.ts). It survives sign-out on purpose. Anonymous
   reports never get it.

   A borrowed-phone sign-in keeps its token in sessionStorage instead of localStorage, so it
   ends when the app/tab is closed; setToken(t, { shared: true }). */
const API = (() => {
  const TOKEN_KEY = 'vds_token';
  const issuedSessions = new Map();
  let sessionEpoch = 0;
  const cookies = () => !!window.VDS_COOKIE_AUTH && !window.VDS_NATIVE;

  /* The last response of a GET made with { remember: true }, so a screen can draw what it showed
     last time while the fresh copy loads (API.peek). Memory only — never written to storage, so
     nothing personal stays on a shared PC — and emptied on sign-in/out and after any change
     (POST/PUT/PATCH/DELETE), which may have made it out of date. */
  const remembered = new Map();
  const REMEMBER_MAX = 30;
  function peek(path) { return remembered.has(path) ? remembered.get(path) : null; }

  const SESSION_KEY = 'vds_browser_session';
  const DEVICE_KEY = 'vds_device_id';

  async function ready() {
    if (!window.VDS_NATIVE) return;
    if (!window.VdsNativeCredentials) throw new Error('Secure sign-in storage is unavailable. Reinstall the updated app.');
    await window.VdsNativeCredentials.ready;
  }

  function getToken() {
    if (window.VDS_NATIVE) return window.VdsNativeCredentials ? window.VdsNativeCredentials.getToken() : null;
    if (cookies()) return null;
    try { return sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY); } catch (e) { return null; }
  }
  function setToken(t, opts) {
    if (window.AuthStepUp) window.AuthStepUp.cancel();
    if (window.VDS_NATIVE) {
      remembered.clear();
      if (!window.VdsNativeCredentials) return Promise.reject(new Error('Secure sign-in storage is unavailable. Reinstall the updated app.'));
      var issuedAt = issuedSessions.get(t);
      issuedSessions.delete(t);
      if (!issuedAt || issuedAt !== serverScope()) {
        if (issuedAt) revokeIssued(issuedAt, t);
        return Promise.reject(new Error('The company server changed. Start sign-in again.'));
      }
      ++sessionEpoch;
      return window.VdsNativeCredentials.set(t, opts).catch(async function (error) {
        // If persistence fails after sign-in, best-effort revoke that newly issued session.
        await revokeIssued(issuedAt, t);
        throw error;
      });
    }
    clearToken();
    if (cookies()) {
      try { ((opts && opts.shared) ? sessionStorage : localStorage).setItem(SESSION_KEY, '1'); } catch (e) {}
      return;
    }
    try { ((opts && opts.shared) ? sessionStorage : localStorage).setItem(TOKEN_KEY, t); } catch (e) { /* storage blocked */ }
  }
  function hasSession() {
    if (!cookies()) return !!getToken();
    try { return !!(sessionStorage.getItem(SESSION_KEY) || localStorage.getItem(SESSION_KEY)); } catch (e) { return true; }
  }
  function clearToken() {
    if (window.AuthStepUp) window.AuthStepUp.cancel();
    ++sessionEpoch; issuedSessions.clear();
    remembered.clear();
    try { localStorage.removeItem(SESSION_KEY); sessionStorage.removeItem(SESSION_KEY); } catch (e) {}
    try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ }
    try { sessionStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ }
    if (window.VDS_NATIVE && window.VdsNativeCredentials) return window.VdsNativeCredentials.clear();
  }
  /** True when the current token is a borrowed-phone (sessionStorage) one. */
  function isSharedSession() {
    if (window.VDS_NATIVE) return !!(window.VdsNativeCredentials && window.VdsNativeCredentials.isShared());
    try { return !!sessionStorage.getItem(cookies() ? SESSION_KEY : TOKEN_KEY); } catch (e) { return false; }
  }

  let memDeviceId = null;
  function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }
  /** This browser's device ID, created on first use. */
  function deviceId() {
    try {
      let id = localStorage.getItem(DEVICE_KEY);
      if (!id) { id = newId(); localStorage.setItem(DEVICE_KEY, id); }
      return id;
    } catch (e) {
      return memDeviceId || (memDeviceId = newId()); // storage blocked: stable for this page only
    }
  }

  /** Where the API lives: this page's own server, or — in the installed phone app, whose pages are
      bundled inside it (docs/OFFLINE-FIRST.md §29) — the server the phone was pointed at. */
  function base() {
    if (!window.VDS_NATIVE) return window.VDS_BASE_PATH || '';
    try { return (localStorage.getItem('vds_api_base') || '').replace(/\/+$/, ''); } catch (e) { return ''; }
  }

  async function revokeIssued(origin, token) {
    try { await fetch(origin + '/api/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(5000) }); } catch (ignored) {}
  }

  function checkedBase() {
    const value = base();
    if (window.VDS_NATIVE) {
      var url; try { url = new URL(value); } catch (ignored) {}
      if (!url || url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Connect to your company using its secure HTTPS address.');
    }
    return value;
  }

  function serverScope() {
    var url = new URL(base() || '/', location.origin);
    return url.origin + url.pathname.replace(/\/+$/, '');
  }

  // fetch has no upload progress events; keep the same response handling for XHR uploads.
  function uploadResponse(url, method, headers, payload, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(method, url);
      Object.entries(headers).forEach(([key, value]) => xhr.setRequestHeader(key, value));
      xhr.upload.onprogress = (event) => onProgress({ loaded: event.loaded, total: event.lengthComputable ? event.total : null });
      xhr.onerror = () => reject(new Error('Network unavailable'));
      xhr.onabort = () => reject(new Error('Upload cancelled'));
      xhr.onload = () => resolve({
        status: xhr.status, ok: xhr.status >= 200 && xhr.status < 300,
        headers: { get: (key) => xhr.getResponseHeader(key) },
        json: async () => JSON.parse(xhr.responseText),
      });
      xhr.send(payload);
    });
  }

  async function request(method, path, body, isForm, opts) {
    if (window.VDS_NATIVE) await ready();
    const requestBase = checkedBase(), requestScope = serverScope(), requestEpoch = sessionEpoch;
    if (opts && opts.expectedServer != null && opts.expectedServer !== serverScope()) throw new Error('This queued action belongs to a different company server.');
    if (method !== 'GET') remembered.clear();
    const headers = cookies() ? { 'X-Session-Mode': 'cookie', 'X-Requested-With': 'VDS' } : {};
    const token = getToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (!/^\/anonymous-reports/.test(path)) headers['X-Device-Id'] = deviceId();
    // Which app this is (src/shared/device.ts): both are held to the evidence-photo rules.
    headers['X-Client'] = window.VDS_NATIVE || /^\/m(\/|$)/.test(location.pathname.slice((window.VDS_BASE_PATH || '').length)) ? 'mobile' : 'desktop';
    // Opt-in idempotency: a caller (e.g. the mobile offline queue) passes a stable
    // key so a retried request is de-duplicated server-side instead of re-applied.
    if (opts && opts.expectedUserId != null) headers['X-Queue-Actor'] = String(opts.expectedUserId);
    if (opts && opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
    // Set on an office PC an HR manager approved as a time-in kiosk (hr-kiosk.js); the kiosk
    // endpoints refuse other browsers when the kiosk lock is on (src/modules/hr/kiosk-devices.ts).
    let kioskToken = null;
    try { kioskToken = localStorage.getItem('vds_kiosk_token'); } catch (e) { /* storage blocked */ }
    if (kioskToken) headers['X-Kiosk-Token'] = kioskToken;

    let payload;
    if (isForm) {
      payload = body; // FormData
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    let res;
    try {
      const url = requestBase + (path.startsWith('/api/') ? path : '/api' + path);
      res = isForm && opts && opts.onProgress
        ? await uploadResponse(url, method, headers, payload, opts.onProgress)
        : await fetch(url, { method, headers, body: payload, credentials: cookies() ? 'same-origin' : 'omit' });
    } catch (e) {
      // fetch only throws on a genuine network failure (offline, DNS, connection reset).
      const err = new Error('Network unavailable');
      err.offline = true;
      throw err;
    }

    // A 401 from the sign-in endpoints means wrong credentials, not an expired session —
    // fall through so the server's own message ("Invalid username or password") is shown.
    if (res.status === 401 && !/^\/auth\/(login|forgot-password|reset-password)\b/.test(path)) {
      clearToken();
      if (window.App) window.App.showLogin();
      throw new Error('Session expired. Please sign in again.');
    }

    let data = null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) data = await res.json();

    // On an installed PC an action is first saved only on that PC (docs/OFFLINE-FIRST.md §2.4):
    // say so app-wide — lib/sync-status.js tells the person it isn't final until it syncs.
    if (res.ok && res.headers.get('X-Sync-State') === 'local') {
      window.dispatchEvent(new CustomEvent('vds:sync-local', {
        detail: { commandId: res.headers.get('X-Sync-Command'), method, path },
      }));
      // Tag the result itself (not serialized) so the screen that made it can show it as
      // "saved on this PC, not final" and follow it: API.syncLocal(result) → command id.
      if (data && typeof data === 'object') {
        try { Object.defineProperty(data, '__syncCommand', { value: res.headers.get('X-Sync-Command') || 'local', enumerable: false }); } catch (e) { /* frozen */ }
      }
    }

    if (res.status === 403 && data && data.step_up_required && path !== '/auth/step-up' && !(opts && opts.stepUpRetried)) {
      if (!window.AuthStepUp) throw new Error('Reload the updated app to verify this action.');
      const stillCurrent = () => sessionEpoch === requestEpoch && serverScope() === requestScope;
      await window.AuthStepUp.verify({ mfaRequired: !!data.mfa_required, server: requestScope, stillCurrent });
      if (!stillCurrent()) throw new Error('Sign-in or company changed. Start again.');
      return request(method, path, body, isForm, Object.assign({}, opts, { stepUpRetried: true, expectedServer: requestScope }));
    }

    if (!res.ok) {
      const err = new Error((data && data.error) || ('Request failed (' + res.status + ')'));
      err.status = res.status;
      err.data = data;   // full parsed body — callers can inspect extra fields (e.g. a 409's details)
      throw err;
    }
    if (window.VDS_NATIVE && /^\/auth\/login(?:\/mfa)?$/.test(path) && data && typeof data.token === 'string') {
      if (requestEpoch !== sessionEpoch || requestScope !== serverScope()) {
        await revokeIssued(requestScope, data.token);
        throw new Error('Sign-in or company server changed. Start again.');
      }
      issuedSessions.clear(); issuedSessions.set(data.token, requestScope);
    }
    if (method === 'GET' && opts && opts.remember) {
      remembered.delete(path); // re-insert at the end: the Map's order is oldest first
      remembered.set(path, data);
      if (remembered.size > REMEMBER_MAX) remembered.delete(remembered.keys().next().value);
    }
    return data;
  }

  /** Fetch a binary endpoint with auth and return an object URL (caller revokes it). */
  async function blobUrl(path, mimeOverride) {
    if (window.VDS_NATIVE) await ready();
    const requestBase = checkedBase();
    const token = getToken();
    const headers = { 'X-Device-Id': deviceId() };
    if (token) headers.Authorization = 'Bearer ' + token;
    const res = await fetch(requestBase + (path.startsWith('/api/') ? path : '/api' + path), { headers });
    if (res.status === 401) {
      clearToken();
      if (window.App) window.App.showLogin();
      throw new Error('Session expired. Please sign in again.');
    }
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error((data && data.error) || ('Request failed (' + res.status + ')'));
    }
    const blob = await res.blob();
    return URL.createObjectURL(mimeOverride ? new Blob([blob], { type: mimeOverride }) : blob);
  }

  /** Fetch an auth'd endpoint that returns a file (CSV / DAT / etc.) and save it. */
  async function download(path, filename) {
    const url = await blobUrl(path);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'download';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  return {
    ready, serverScope, getToken, setToken, clearToken, hasSession, cookieAuth: cookies, isSharedSession, deviceId, base,
    /** opts.remember: keep the response for API.peek(p) (see `remembered`). */
    get: (p, opts) => request('GET', p, undefined, false, opts),
    peek,
    post: (p, b, opts) => request('POST', p, b, false, opts),
    put: (p, b, opts) => request('PUT', p, b, false, opts),
    patch: (p, b, opts) => request('PATCH', p, b, false, opts),
    del: (p) => request('DELETE', p),
    upload: (p, formData, opts) => request('POST', p, formData, true, opts),
    /** The installed-PC command id when `result` was only saved on that PC (not final yet), else null. */
    syncLocal: (result) => (result && result.__syncCommand) || null,
    blobUrl, download,
  };
})();
// Shared mobile helpers and chat test for window.API before using the client.
window.API = API;
