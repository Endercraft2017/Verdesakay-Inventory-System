import { it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

it.each([false, true])('hands the homepage session to the selected tenant (shared=%s)', async (shared) => {
  const dom = new JSDOM(fs.readFileSync('website/index.html', 'utf8'), { runScripts: 'outside-only', url: 'https://otom.example.test/', virtualConsole: new VirtualConsole() });
  const win = dom.window;
  win.localStorage.setItem('tenant:/other:vds_token', 'other-company-session');
  win.localStorage.setItem('tenant:/hexter:vds_token', 'old-session');
  win.sessionStorage.setItem('tenant:/hexter:vds_token', 'old-shared-session');
  const fetch = vi.fn(async (path: string) => ({ ok: true, status: 200, json: async () => path === '/site/config'
    ? { modules: [], module_deps: {}, signups_open: false, payment_methods: {}, contact: {} }
    : { browser_session: true, workspace_path: '/hexter', session: { shared } } }));
  Object.assign(win, { fetch });
  win.eval(fs.readFileSync('website/app.js', 'utf8'));
  (win.document.querySelector('#login-company') as HTMLInputElement).value = 'h0000r';
  (win.document.querySelector('#login-username') as HTMLInputElement).value = 'owner';
  (win.document.querySelector('#login-password') as HTMLInputElement).value = 'Current-pass-2468';
  (win.document.querySelector('#login-shared') as HTMLInputElement).checked = shared;
  win.document.querySelector('#login-form')!.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect((shared ? win.sessionStorage : win.localStorage).getItem('tenant:/hexter:vds_browser_session')).toBe('1');
  expect((shared ? win.localStorage : win.sessionStorage).getItem('tenant:/hexter:vds_token')).toBeNull();
  expect(win.localStorage.getItem('vds_token')).toBeNull();
  expect(win.sessionStorage.getItem('vds_token')).toBeNull();
  expect(win.localStorage.getItem('tenant:/other:vds_token')).toBe('other-company-session');
  expect(fetch).toHaveBeenCalledWith('/site/login', expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ 'X-Session-Mode': 'cookie', 'X-Requested-With': 'VDS' }) }));
  dom.window.close();
});
