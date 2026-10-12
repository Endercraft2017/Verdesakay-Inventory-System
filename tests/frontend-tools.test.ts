import { it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';

it('rail tools open visible drawers and close by button, Escape, backdrop, and repeated click', async () => {
  const tools = ['notes', 'email', 'scheduler', 'bookmarks', 'bug', 'help'];
  const dom = new JSDOM(`<div id="drawer-root"></div><div id="modal-root"></div>${tools.map(tool => `<button class="rail-btn" data-tool="${tool}"></button>`).join('')}`, { runScripts: 'outside-only', url: 'http://localhost/' });
  const win = dom.window;
  await new Promise(resolve => setTimeout(resolve, 0));
  const errors: string[] = [];
  win.addEventListener('error', event => errors.push(event.message));
  win.requestAnimationFrame = cb => { cb(0); return 1; };
  const stubs = `const API = { get: async () => [], post: async () => ({}) }; const App = { hasPermission: () => true, currentLocation: () => ({route:'dashboard',label:'Dashboard'}), navigate() {} };`;
  win.eval(stubs + ['ui.js', 'help.js', 'tools.js'].map(script => fs.readFileSync(path.join(import.meta.dirname, '../public/js', script), 'utf8')).join('\n;\n'));
  win.document.dispatchEvent(new win.Event('DOMContentLoaded'));
  const click = (tool: string) => { const b = win.document.querySelector(`[data-tool="${tool}"]`) as HTMLElement; b.focus(); b.click(); };
  for (const tool of tools) {
    click(tool);
    expect(errors, tool).toEqual([]);
    const drawer = win.document.querySelector('.drawer.open')!;
    expect(drawer, tool).not.toBeNull();
    expect(drawer.getAttribute('role')).toBe('dialog');
    expect(win.document.activeElement).toBe(drawer.querySelector('[data-close]'));
    win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true }));
    expect(drawer.contains(win.document.activeElement)).toBe(true);
    expect(drawer.querySelector('.drawer-body')?.innerHTML.length, tool).toBeGreaterThan(0);
    (drawer.querySelector('[data-close]') as HTMLElement).click();
    expect(win.document.querySelector('.drawer.open'), tool).toBeNull();
    expect(win.document.activeElement).toBe(win.document.querySelector(`[data-tool="${tool}"]`));
    expect(win.document.querySelector('.drawer-catch'), tool).toBeNull();
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  click('notes'); click('email');
  expect(win.document.querySelectorAll('.drawer.open')).toHaveLength(1);
  win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape' }));
  expect(win.document.querySelector('.drawer.open')).toBeNull();
  click('bookmarks');
  win.document.querySelector('.drawer-catch')!.dispatchEvent(new win.MouseEvent('mousedown'));
  expect(win.document.querySelector('.drawer.open')).toBeNull();
  click('scheduler'); click('scheduler');
  expect(win.document.querySelector('.drawer.open')).toBeNull();
  expect(errors).toEqual([]);
  dom.window.close();
});
