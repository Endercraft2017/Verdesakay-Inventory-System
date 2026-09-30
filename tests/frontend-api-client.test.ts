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
