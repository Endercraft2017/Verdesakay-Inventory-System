/* Lightweight API client with token handling. */
const API = (() => {
  const TOKEN_KEY = 'vds_token';

  function getToken() { return localStorage.getItem(TOKEN_KEY); }
  function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
  function clearToken() { localStorage.removeItem(TOKEN_KEY); }

  async function request(method, path, body, isForm) {
    const headers = {};
    const token = getToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;

    let payload;
    if (isForm) {
      payload = body; // FormData
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    const res = await fetch('/api' + path, { method, headers, body: payload });

    if (res.status === 401) {
      clearToken();
      if (window.App) window.App.showLogin();
      throw new Error('Session expired. Please sign in again.');
    }

    let data = null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) data = await res.json();

    if (!res.ok) {
      throw new Error((data && data.error) || ('Request failed (' + res.status + ')'));
    }
    return data;
  }

  return {
    getToken, setToken, clearToken,
    get: (p) => request('GET', p),
    post: (p, b) => request('POST', p, b),
    put: (p, b) => request('PUT', p, b),
    del: (p) => request('DELETE', p),
    upload: (p, formData) => request('POST', p, formData, true),
  };
})();
