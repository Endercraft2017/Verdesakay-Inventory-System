import { it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
it('gives the shared modal close control a name and restores the invoking focus', async () => {
  const dom = new JSDOM('<div id="view"><button id="open">Open settings</button></div><div id="modal-root"></div>', { runScripts: 'outside-only', url: 'https://localhost/' });
  const w = dom.window as any;
  try {
    w.eval(fs.readFileSync(new URL('../public/js/ui.js', import.meta.url), 'utf8') + ';window.UI=UI;');
    const opener = w.document.querySelector('#open'); opener.focus();
    w.UI.modal({ title: 'Editor settings', bodyHTML: '<p>Preferences</p>' });
    const close = w.document.querySelector('.modal-head [data-close]');
    expect(close.getAttribute('aria-label')).toBe('Close dialog');
    expect(close.type).toBe('button');
    await new Promise(resolve => setTimeout(resolve, 0));
    close.click();
    expect(w.document.querySelector('[role=dialog]')).toBeNull();
    expect(w.document.activeElement).toBe(opener);
  } finally { dom.window.close(); }
});

it('layers a drawer inside its invoking modal and returns focus without losing the draft', async () => {
  const dom = new JSDOM('<div id="view"></div><div id="modal-root"></div><div id="drawer-root"></div>', { runScripts: 'outside-only', url: 'https://localhost/', pretendToBeVisual: true });
  const w = dom.window as any;
  try {
    w.eval(fs.readFileSync(new URL('../public/js/ui.js', import.meta.url), 'utf8') + ';window.UI=UI;');
    const parent = w.UI.modal({ title: 'Edit account', bodyHTML: '<input id="draft" value="Unsaved name"><button id="access">Access</button>' });
    const opener = w.document.querySelector('#access'); opener.focus();
    const drawer = w.UI.drawer({ title: 'Access', bodyHTML: '<input id="permission-search">' });
    expect(drawer.el.parentElement).toBe(parent.overlay);
    await new Promise(resolve => setTimeout(resolve, 30));
    drawer.el.querySelector('input').focus();
    drawer.el.querySelector('input').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(parent.overlay.isConnected).toBe(true);
    expect(w.document.querySelector('#draft').value).toBe('Unsaved name');
    expect(w.document.activeElement).toBe(opener);
    expect(w.document.querySelector('.drawer-catch')).toBeNull();
  } finally { dom.window.close(); }
});

it('lets a newer modal handle Escape before the drawer underneath it', async () => {
  const dom = new JSDOM('<div id="view"></div><div id="modal-root"></div><div id="drawer-root"></div>', { runScripts: 'outside-only', url: 'https://localhost/', pretendToBeVisual: true });
  const w = dom.window as any;
  try {
    w.eval(fs.readFileSync(new URL('../public/js/ui.js', import.meta.url), 'utf8') + ';window.UI=UI;');
    const parent = w.UI.modal({ title: 'Edit account', bodyHTML: '<button>Access</button>' });
    const drawer = w.UI.drawer({ title: 'Access', bodyHTML: '<input>' });
    await new Promise(resolve => setTimeout(resolve, 30));
    const child = w.UI.modal({ title: 'Confirm access', bodyHTML: '<input>' });
    child.overlay.querySelector('input').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(child.overlay.isConnected).toBe(false);
    expect(drawer.el.inert).not.toBe(true);
    expect(parent.overlay.isConnected).toBe(true);
    drawer.el.querySelector('input').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(w.document.querySelector('.drawer-catch')).toBeNull();
    expect(parent.overlay.isConnected).toBe(true);
  } finally { dom.window.close(); }
});
