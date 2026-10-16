/** public/js/api.js 401 handling: a rejected sign-in must show the server's message
    ("Invalid username or password"), not "Session expired", while a 401 on any other
    endpoint still clears the token and sends the user back to the login screen. */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

type ApiClient = { post: (p: string, b?: unknown) => Promise<unknown>; get: (p: string) => Promise<unknown> };

function loadApi(): ApiClient {
  const src = fs.readFileSync(path.join(import.meta.dirname, '../public/js/api.js'), 'utf8');
  // eslint-disable-next-line no-new-func
  return new Function(`${src}\nreturn API;`)() as ApiClient;
}

function reply401(error: string) {
  return vi.fn(async () => new Response(JSON.stringify({ error }), {
    status: 401, headers: { 'Content-Type': 'application/json' },
  }));
}

describe('api.js 401 handling', () => {
  const showLogin = vi.fn();
  beforeEach(() => {
    localStorage.clear();
    showLogin.mockReset();
    (window as unknown as { App: unknown }).App = { showLogin };
  });

  it('a wrong password on sign-in shows the server message and keeps the login screen as-is', async () => {
    localStorage.setItem('vds_token', 'stale');
    vi.stubGlobal('fetch', reply401('Invalid username or password'));
    const API = loadApi();
    await expect(API.post('/auth/login', { username: 'admin', password: 'x' }))
      .rejects.toThrow('Invalid username or password');
    expect(showLogin).not.toHaveBeenCalled();
  });

  it('a 401 on any other endpoint is still an expired session', async () => {
    localStorage.setItem('vds_token', 'stale');
    vi.stubGlobal('fetch', reply401('Not authenticated'));
    const API = loadApi();
    await expect(API.get('/auth/me')).rejects.toThrow('Session expired. Please sign in again.');
    expect(showLogin).toHaveBeenCalledOnce();
    expect(localStorage.getItem('vds_token')).toBeNull();
  });
});

/** API.peek: the last response of a GET made with { remember: true }, so a screen can draw it
    while the fresh copy loads (hr-employees.js). Memory only; any change or sign-out empties it. */
describe('api.js remembered GETs', () => {
  type Peekable = ApiClient & {
    get: (p: string, o?: { remember?: boolean }) => Promise<unknown>;
    peek: (p: string) => unknown; clearToken: () => void;
  };
  let n = 0;
  beforeEach(() => {
    localStorage.clear();
    n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ n: ++n }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })));
  });

  it('keeps only opted-in GETs, and forgets them after any change or on sign-out', async () => {
    const API = loadApi() as Peekable;
    await API.get('/hr/employees?');
    expect(API.peek('/hr/employees?')).toBeNull();

    await API.get('/hr/employees?', { remember: true });
    expect(API.peek('/hr/employees?')).toEqual({ n: 2 });
    expect(Object.keys(localStorage)).toEqual(['vds_device_id']); // the response is never stored

    await API.post('/hr/employees', { name: 'x' });
    expect(API.peek('/hr/employees?')).toBeNull();

    await API.get('/hr/employees?', { remember: true });
    API.clearToken();
    expect(API.peek('/hr/employees?')).toBeNull();
  });
});
