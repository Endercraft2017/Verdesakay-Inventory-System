import { it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
it('help tips support keyboard focus, tap toggle, safe text, and Escape without closing the parent modal', () => {
  const dom = new JSDOM('<div id="modal-root"></div>', { runScripts: 'outside-only', url: 'https://localhost/' }); const w = dom.window as any;
  w.eval(fs.readFileSync(path.join(import.meta.dirname, '../public/js/ui.js'), 'utf8') + '\nwindow.UI=UI;');
  w.UI.modal({ title: 'Test', bodyHTML: `<label>Setting ${w.UI.helpIcon('Explanation <script>unsafe</script>')}</label><input id="setting">`, cancelText: 'Close' });
  const button = w.document.querySelector('.help-icon'); button.focus();
  let tip = w.document.querySelector('[role="tooltip"]'); expect(tip.textContent).toBe('Explanation <script>unsafe</script>'); expect(tip.querySelector('script')).toBeNull(); expect(button.getAttribute('aria-describedby')).toBe(tip.id);
  button.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); expect(w.document.querySelector('.help-tip')).toBeNull(); expect(w.document.querySelector('.modal-overlay')).not.toBeNull(); expect(button.getAttribute('aria-expanded')).toBe('false');
  button.click(); expect(w.document.querySelector('.help-tip')).not.toBeNull(); button.click(); expect(w.document.querySelector('.help-tip')).toBeNull();
  button.dispatchEvent(new w.MouseEvent('mouseover', { bubbles: true })); expect(w.document.querySelector('.help-tip')).not.toBeNull(); w.dispatchEvent(new w.Event('resize')); expect(w.document.querySelector('.help-tip')).toBeNull(); dom.window.close();
});
