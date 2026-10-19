/** Desktop navigation renders a view once. navigate() writes the hash itself, and the
    `hashchange` that write fires (asynchronously) used to render the same view a second time,
    repeating every API call the view makes. Back/forward to another route must still render. */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const PUBLIC = path.join(import.meta.dirname, '..', 'public');
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

async function loadDesktopApp() {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const srcs = [...html.matchAll(/<script src="(\/js\/[^"]+)"><\/script>/g)].map((m) => m[1] as string);
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
  const win = dom.window as unknown as Record<string, unknown> & { eval(c: string): unknown };
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  win.fetch = async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  win.eval(srcs.map((s) => fs.readFileSync(path.join(PUBLIC, s.replace(/^\//, '')), 'utf8')).join('\n;\n')
    + '\n;window.__App = App;');
  await tick(); // DOMContentLoaded → App.boot() (no token: the sign-in screen)
  const App = win.__App as {
    canAccessRoute(name: string): boolean;
    register(name: string, fn: () => void): void;
    setMe(patch: Record<string, unknown>): void;
    navigate(name: string, filter?: Record<string, string>): void;
  };
  App.setMe({ id: 1, full_name: 'Test User', role: 'admin', permissions: [] });
  return { App, win: dom.window };
}

describe('desktop navigation', () => {
  it('renders a navigated view once, and back/forward still re-renders', async () => {
    const { App, win } = await loadDesktopApp();
    const renders: string[] = [];
    App.register('account', () => { renders.push('account'); });
    App.register('messages', () => { renders.push('messages'); });

    App.navigate('account');
    await tick();
    expect(renders).toEqual(['account']);

    App.navigate('messages');
    await tick();
    expect(renders).toEqual(['account', 'messages']);

    win.location.hash = 'account'; // what Back to the previous page does
    await tick();
    expect(renders).toEqual(['account', 'messages', 'account']);
    win.close();
  });
});


describe('desktop clerk desk isolation', () => {
  it.each([
    ['production.repairs', 'repairs', 'production-receiving'],
    ['production.receive', 'production-receiving', 'repairs'],
  ])('%s opens only its own desk without broad production access', async (permission, allowed, denied) => {
    const { App, win } = await loadDesktopApp();
    App.setMe({ role: 'clerk', permissions: [permission] });
    expect(App.canAccessRoute(allowed)).toBe(true);
    for (const route of [denied, 'job-orders', 'production-overview', 'finished-products', 'production-qc', 'production-batches']) {
      expect(App.canAccessRoute(route), route).toBe(false);
    }
    App.setMe({ permissions: [] });
    expect(App.canAccessRoute(allowed)).toBe(false);
    win.close();
  });
});
