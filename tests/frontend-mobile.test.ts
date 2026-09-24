/**
 * Mobile app smoke test: load public/mobile/index.html's scripts in the declared
 * order inside jsdom and assert the router boots and every view registers a route.
 * Mirrors frontend.test.ts for the desktop bundle.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const PUBLIC = path.join(import.meta.dirname, '..', 'public');
const EXPECTED_ROUTES = [
  'home', 'work', 'production', 'stock-move', 'damage', 'transfer', 'new-item', 'assign-qr', 'scan',
  'item', 'low-stock', 'location', 'my-log', 'cycle-count', 'receive', 'pick',
  'batch', 'job-orders', 'qc', 'repairs', 'record', 'receiving', 'so', 'report-problem', 'settings', 'queue', 'clock',
  'inbox', 'directory', 'payslips', 'schedule', 'requests', 'tasks',
  'announcements', 'time-fix', 'approvals', 'allocate', 'deliveries',
];

describe('mobile bootstrap', () => {
  const html = fs.readFileSync(path.join(PUBLIC, 'mobile', 'index.html'), 'utf8');
  const srcs = [...html.matchAll(/<script src="(\/[^"]+)"><\/script>/g)].map((m) => m[1] as string);

  it('declares app.js before any view module', () => {
    const appIdx = srcs.indexOf('/mobile/app.js');
    const firstView = srcs.findIndex((s) => s.startsWith('/mobile/modules/'));
    expect(appIdx).toBeGreaterThanOrEqual(0);
    expect(firstView).toBeGreaterThan(appIdx);
  });

  it('boots the router and registers every view', () => {
    const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://localhost/m' });
    const win = dom.window as unknown as Record<string, any>;
    win.matchMedia = win.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    win.fetch = () => Promise.reject(new Error('no network in test'));

    const code = srcs
      .map((s) => fs.readFileSync(path.join(PUBLIC, s.replace(/^\//, '')), 'utf8'))
      .join('\n;\n');
    win.eval(code);
    win.document.dispatchEvent(new win.Event('DOMContentLoaded'));

    expect(typeof win.MApp).toBe('object');
    expect(win.MApp.routes().sort()).toEqual([...EXPECTED_ROUTES].sort());
    // Login wiring ran without throwing.
    expect(win.document.getElementById('m-login-form')).toBeTruthy();
  });

  /** Boots the real app with a pre-seeded session (no network — /auth/me rejects with
      .offline, so boot() falls back to the cached `me` it just read from localStorage,
      same path a real phone takes reopening the app offline) so route rendering can be
      exercised under a specific account's actual permissions, not just route registration. */
  async function bootAs(me: Record<string, unknown>) {
    const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://localhost/m' });
    const win = dom.window as unknown as Record<string, any>;
    win.matchMedia = win.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    win.fetch = () => Promise.reject(new Error('no network in test'));
    win.localStorage.setItem('vds_token', 'test-token');
    win.localStorage.setItem('vds_m_me', JSON.stringify(me));

    const code = srcs
      .map((s) => fs.readFileSync(path.join(PUBLIC, s.replace(/^\//, '')), 'utf8'))
      .join('\n;\n');
    win.eval(code);
    win.document.dispatchEvent(new win.Event('DOMContentLoaded'));
    // enterApp() runs at the end of a `/auth/me` rejection chain (a couple of microtask
    // hops through api.js's async request() + boot()'s .catch) — flush a real macrotask
    // so it's landed before we drive the router.
    await new Promise((r) => setTimeout(r, 0));
    return win;
  }

  it('a qc_inspector-only account gets the Production tab with just its own row', async () => {
    const win = await bootAs({
      id: 1, username: 'qc1', full_name: 'QC One', role: 'qc_inspector', employee: true, modules: null,
      permissions: ['inventory.view', 'inventory.mobile', 'production.inspect_qc', 'messages.view', 'messages.send'],
    });
    expect(win.MApp.hasProductionAccess()).toBe(true);
    win.location.hash = '#/production';
    win.MApp.render();
    const text = win.document.getElementById('m-view').textContent;
    expect(text).toContain('QC / QA');
    expect(text).not.toContain('Job Orders');
    expect(text).not.toContain('Repairs');
    expect(text).not.toContain('Products In');
  });

  it('a releasing_clerk-only account has no Production tab access but sees Release SOs on Work', async () => {
    const win = await bootAs({
      id: 2, username: 'rel1', full_name: 'Release One', role: 'releasing_clerk', employee: true, modules: null,
      permissions: ['inventory.view', 'inventory.mobile', 'orders.view', 'orders.release', 'messages.view', 'messages.send'],
    });
    expect(win.MApp.hasProductionAccess()).toBe(false);
    win.location.hash = '#/work';
    win.MApp.render();
    const text = win.document.getElementById('m-view').textContent;
    expect(text).toContain('Release SOs');
    expect(text).not.toContain('Accept Parts Request');
    expect(text).not.toContain('Products In');
  });
});
