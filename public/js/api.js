/* Lightweight API client with token handling. */
const API = (() => {
  const TOKEN_KEY = 'vds_token';

  function getToken() { return localStorage.getItem(TOKEN_KEY); }
  function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
  function clearToken() { localStorage.removeItem(TOKEN_KEY); }

  async function request(method, path, body, isForm, opts) {
    const headers = {};
    const token = getToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;
    // Opt-in idempotency: a caller (e.g. the mobile offline queue) passes a stable
    // key so a retried request is de-duplicated server-side instead of re-applied.
    if (opts && opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;

    let payload;
    if (isForm) {
      payload = body; // FormData
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    let res;
    try {
      res = await fetch('/api' + path, { method, headers, body: payload });
    } catch (e) {
      // fetch only throws on a genuine network failure (offline, DNS, connection reset).
      const err = new Error('Network unavailable');
      err.offline = true;
      throw err;
    }

    if (res.status === 401) {
      clearToken();
      if (window.App) window.App.showLogin();
      throw new Error('Session expired. Please sign in again.');
    }

    let data = null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) data = await res.json();

    if (!res.ok) {
      const err = new Error((data && data.error) || ('Request failed (' + res.status + ')'));
      err.status = res.status;
      err.data = data;   // full parsed body — callers can inspect extra fields (e.g. a 409's details)
      throw err;
    }
    return data;
  }

  /** Fetch a binary endpoint with auth and return an object URL (caller revokes it). */
  async function blobUrl(path) {
    const token = getToken();
    const res = await fetch('/api' + path, {
      headers: token ? { Authorization: 'Bearer ' + token } : {},
    });
    if (res.status === 401) {
      clearToken();
      if (window.App) window.App.showLogin();
      throw new Error('Session expired. Please sign in again.');
    }
    if (!res.ok) throw new Error('Request failed (' + res.status + ')');
    return URL.createObjectURL(await res.blob());
  }

  /** Fetch an auth'd endpoint that returns a file (CSV / DAT / etc.) and save it. */
  async function download(path, filename) {
    const url = await blobUrl(path);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'download';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return {
    getToken, setToken, clearToken,
    get: (p) => request('GET', p),
    post: (p, b, opts) => request('POST', p, b, false, opts),
    put: (p, b, opts) => request('PUT', p, b, false, opts),
    patch: (p, b, opts) => request('PATCH', p, b, false, opts),
    del: (p) => request('DELETE', p),
    upload: (p, formData) => request('POST', p, formData, true),
    blobUrl, download,
  };
})();
