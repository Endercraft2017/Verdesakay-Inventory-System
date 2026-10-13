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
