/**
 * Frontend smoke test: load the real public/ scripts in the exact order index.html
 * declares them (in a jsdom window) and assert that every view registers a route.
 *
 * This guards the script load-order contract: app.js (which defines App + the route
 * registry) must load BEFORE the view modules that call App.register() at load time.
 * If that order is broken, evaluating the views throws and this test fails.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const PUBLIC = path.join(import.meta.dirname, '..', 'public');
const EXPECTED_ROUTES = ['dashboard', 'inventory', 'forms', 'messages', 'admin', 'account'];

function scriptOrderFromHtml(html: string): string[] {
  return [...html.matchAll(/<script src="(\/js\/[^"]+)"><\/script>/g)].map((m) => m[1] as string);
}

describe('frontend bootstrap', () => {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const srcs = scriptOrderFromHtml(html);

  it('declares app.js before any view module', () => {
    const appIdx = srcs.indexOf('/js/app.js');
    const firstView = srcs.findIndex((s) => s.startsWith('/js/modules/'));
    expect(appIdx).toBeGreaterThanOrEqual(0);
    expect(firstView).toBeGreaterThanOrEqual(0);
    expect(appIdx).toBeLessThan(firstView);
  });

  it('loads all scripts and registers every view route', () => {
    const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
    const win = dom.window as unknown as Record<string, unknown> & { eval(c: string): unknown };
    // Load-time code shouldn't need these, but stub to be safe.
    win.matchMedia = win.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));

    // Concatenate the scripts in declared order — same single global scope a browser uses.
    let code = srcs.map((s) => fs.readFileSync(path.join(PUBLIC, s.replace(/^\//, '')), 'utf8')).join('\n;\n');
    code += '\n;window.__routeNames = App._routeNames();\n;window.__hasApp = typeof App;\n;window.__appExposed = window.App === App;';
    code += '\n;window.__help = window.Help ? { has: true, ids: Help.topics.map(function(t){return t.id;}),' +
            ' routes: Help.topics.reduce(function(a,t){(t.routes||[]).forEach(function(r){a.push(r);});return a;}, []) } : { has: false };';

    expect(() => win.eval(code)).not.toThrow();

    expect(win.__hasApp).toBe('object');
    expect(win.__appExposed).toBe(true);
    const routes = win.__routeNames as string[];
    for (const r of EXPECTED_ROUTES) expect(routes).toContain(r);

    // In-app Help loaded, and every route a help topic claims is a real registered route.
    const help = win.__help as { has: boolean; ids: string[]; routes: string[] };
    expect(help.has).toBe(true);
    expect(help.ids).toContain('getting-started');
    for (const r of help.routes) expect(routes).toContain(r);
  });
});
