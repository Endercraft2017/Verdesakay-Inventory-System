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
const EXPECTED_ROUTES = ['home', 'stock-move', 'damage', 'transfer', 'new-item', 'assign-qr', 'scan'];

describe('mobile bootstrap', () => {
  const html = fs.readFileSync(path.join(PUBLIC, 'mobile', 'index.html'), 'utf8');
  const srcs = [...html.matchAll(/<script src="(\/[^"]+)"><\/script>/g)].map((m) => m[1] as string);

  it('declares app.js before any view module', () => {
    const appIdx = srcs.indexOf('/mobile/app.js');
    const firstView = srcs.findIndex((s) => s.startsWith('/mobile/views/'));
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
});
