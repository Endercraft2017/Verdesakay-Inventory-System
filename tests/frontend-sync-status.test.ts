/**
 * Desktop sync status (public/js/lib/sync-status.js + the api.js hook, docs/OFFLINE-FIRST.md
 * §2.4): a result saved only on the PC is never presented as final, and the top-bar pill words
 * each state correctly. Runs the real scripts in jsdom with a stubbed fetch.
 */
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, it, expect } from 'vitest';

const PUBLIC = path.join(import.meta.dirname, '..', 'public');
const read = (p: string) => fs.readFileSync(path.join(PUBLIC, p), 'utf8');

function boot(responses: Array<{ body: unknown; headers?: Record<string, string> }>) {
  const dom = new JSDOM(
    '<div class="topnav"><div class="topnav-user"></div></div><div id="toasts"></div>',
    { runScripts: 'outside-only', url: 'http://localhost/' },
  );
  const win = dom.window as unknown as Window & Record<string, unknown> & { eval(c: string): unknown };
  const calls: string[] = [];
  win.fetch = (async (url: string) => {
    calls.push(String(url));
    const r = responses.shift() ?? { body: { mode: 'node', online: true, pending_total: 0 } };
    return new Response(JSON.stringify(r.body), { headers: { 'content-type': 'application/json', ...(r.headers ?? {}) } });
  }) as unknown as typeof fetch;
  win.eval('var App = { navigate: function (r) { window.__nav = r; } };');
  win.eval(read('js/api.js') + '\n;' + read('js/ui.js') + '\n;' + read('js/lib/sync-status.js') +
    '\n;window.API = API; window.SyncStatus = SyncStatus;');
  return { win, calls, doc: dom.window.document };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

describe('a result saved only on this PC', () => {
  it('raises the app-wide event and a toast saying it is not final yet', async () => {
    const { win, doc } = boot([
      { body: { ok: true, quantity: 4 }, headers: { 'X-Sync-State': 'local', 'X-Sync-Command': '01ABC' } },
      { body: { mode: 'node', online: false, pending_total: 1, attention: 0 } }, // the pill refresh
    ]);
    const seen: unknown[] = [];
    win.addEventListener('vds:sync-local', (e) => seen.push((e as CustomEvent).detail));
    const data = await (win.API as { post: (p: string, b: unknown) => Promise<unknown> }).post('/inventory/5/adjust', { change: -1 });
    expect(data).toEqual({ ok: true, quantity: 4 }); // the caller still gets its data
    expect(seen).toEqual([{ commandId: '01ABC', method: 'POST', path: '/inventory/5/adjust' }]);
    const toast = doc.querySelector('#toasts .toast.local');
    expect(toast?.textContent).toMatch(/not final until it syncs/);
    await tick();
    expect(doc.getElementById('sync-pill')?.textContent).toBe('Offline · 1 saved on this PC');
  });

  it('an ordinary response raises nothing', async () => {
    const { win, doc } = boot([{ body: { ok: true } }]);
    let fired = false;
    win.addEventListener('vds:sync-local', () => { fired = true; });
    await (win.API as { post: (p: string, b: unknown) => Promise<unknown> }).post('/inventory/5/adjust', { change: -1 });
    expect(fired).toBe(false);
    expect(doc.querySelector('#toasts .toast')).toBeNull();
  });
});

describe('the status pill', () => {
  const describeIt = (s: unknown) => {
    const { win } = boot([]);
    return (win.SyncStatus as { describe: (s: unknown) => unknown }).describe(s);
  };

  it('words every state', () => {
    expect(describeIt({ mode: 'cloud' })).toBeNull();
    expect(describeIt({ mode: 'off' })).toBeNull();
    expect(describeIt({ mode: 'node', online: true, pending_total: 0 })).toEqual({ text: 'Synced', tone: 'synced' });
    expect(describeIt({ mode: 'node', online: true, pending_total: 3 })).toEqual({ text: 'Syncing · 3 waiting', tone: 'syncing' });
    expect(describeIt({ mode: 'node', online: null, pending_total: 0 })).toEqual({ text: 'Connecting…', tone: 'syncing' });
    expect(describeIt({ mode: 'node', online: false, pending_total: 0 })).toEqual({ text: 'Offline · working on this PC', tone: 'offline' });
    expect(describeIt({ mode: 'node', online: false, pending_total: 2, attention: 1, discrepancies_open: 1 }))
      .toEqual({ text: 'Offline · 2 saved on this PC · 2 need attention', tone: 'attention' });
    expect(describeIt({ mode: 'node', online: true, pending_total: 0, attention: 1 }))
      .toEqual({ text: 'Synced · 1 needs attention', tone: 'attention' });
  });

  it('stays hidden on the cloud, and stops polling there', async () => {
    const { win, doc, calls } = boot([{ body: { mode: 'cloud' } }]);
    (win.SyncStatus as { start: () => void }).start();
    await tick();
    expect(doc.getElementById('sync-pill')?.classList.contains('hidden')).toBe(true);
    expect(calls).toEqual(['/api/sync/status']);
  });

  it('names recorded actions for the Sync page', () => {
    const { win } = boot([]);
    const label = (win.SyncStatus as { label: (c: unknown) => string }).label;
    expect(label({ method: 'POST', path: '/api/inventory/9/adjust', body: { change: -3, reason: 'Truck 2' } })).toBe('Stock out 3 — Truck 2');
    expect(label({ method: 'POST', path: '/api/inventory/9/adjust', body: { change: 5 } })).toBe('Stock in 5');
    expect(label({ method: 'POST', path: '/api/inventory/9/transfer', body: { amount: 2 } })).toBe('Transfer 2');
    expect(label({ method: 'POST', path: '/api/inventory', body: { name: 'Bolt' } })).toBe('New item "Bolt"');
    expect(label({ method: 'PUT', path: '/api/whatever/1', body: {} })).toBe('PUT /whatever/1');
  });
});
