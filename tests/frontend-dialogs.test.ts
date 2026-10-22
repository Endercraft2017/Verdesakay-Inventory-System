import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
function setup() {
  const dom = new JSDOM('<button id="opener">Open</button><div id="modal-root"></div>', { runScripts: 'outside-only' });
  dom.window.eval(fs.readFileSync(path.join(import.meta.dirname, '../public/js/ui.js'), 'utf8') + '\nwindow.testUI = UI;');
  return dom;
}
describe('shared dialog lifecycle', () => {
  it('preserves a dirty draft when discard is declined and restores focus when accepted', () => {
    const dom = setup(); const w = dom.window; const ui = (w as any).testUI;
    w.document.querySelector<HTMLButtonElement>('#opener')!.focus();
    const modal = ui.modal({ title: 'Edit form', protectChanges: true, bodyHTML: '<label>Name</label><input value="Original">', confirmText: 'Save', onConfirm: () => true });
    expect(modal.overlay.querySelector('.modal').getAttribute('role')).toBe('dialog');
    expect(modal.overlay.querySelector('label').htmlFor).toBe(modal.overlay.querySelector('input').id);
    modal.overlay.querySelector('input').value = 'Changed';
    modal.overlay.querySelector('input').dispatchEvent(new w.Event('input', { bubbles: true }));
    w.confirm = () => false;
    w.document.querySelector('.modal-overlay')!.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(modal.overlay.isConnected).toBe(true);
    expect(modal.overlay.querySelector('input').value).toBe('Changed');
    w.confirm = () => true;
    w.document.querySelector('.modal-overlay')!.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(modal.overlay.isConnected).toBe(false);
    expect(w.document.activeElement?.id).toBe('opener');
    dom.window.close();
  });
  it('resolves cancelled confirmations when Escape or backdrop dismisses them', async () => {
    const dom = setup(); const w = dom.window; const ui = (w as any).testUI;
    const escape = ui.confirmDialog('Delete?');
    w.document.querySelector('.modal-overlay')!.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(await escape).toBe(false);
    const backdrop = ui.confirmDialog('Delete?');
    w.document.querySelector('.modal-overlay')!.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true }));
    expect(await backdrop).toBe(false);
    dom.window.close();
  });
  it('warns on browser exit only while an editor is dirty', () => {
    const dom = setup(); const w = dom.window; const ui = (w as any).testUI;
    const modal = ui.modal({ title: 'Edit', protectChanges: true, bodyHTML: '<input value="Original">' });
    const clean = new w.Event('beforeunload', { cancelable: true }); w.dispatchEvent(clean); expect(clean.defaultPrevented).toBe(false);
    modal.overlay.querySelector('input').value = 'Changed';
    modal.overlay.querySelector('input').dispatchEvent(new w.Event('input', { bubbles: true }));
    const dirty = new w.Event('beforeunload', { cancelable: true }); w.dispatchEvent(dirty); expect(dirty.defaultPrevented).toBe(true);
    w.confirm = () => true; modal.close();
    const closed = new w.Event('beforeunload', { cancelable: true }); w.dispatchEvent(closed); expect(closed.defaultPrevented).toBe(false);
    dom.window.close();
  });
});
