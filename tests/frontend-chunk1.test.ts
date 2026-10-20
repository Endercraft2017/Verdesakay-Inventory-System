import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
const publicDir = path.join(import.meta.dirname, '../public');
const read = (p: string) => fs.readFileSync(path.join(publicDir, p), 'utf8');
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function modalWindow() {
  const dom = new JSDOM('<button id="opener">New item</button><div id="modal-root"></div>', { runScripts: 'outside-only' });
  const w = dom.window as any;
  w.eval(read('js/ui.js') + ';window.TestUI=UI;');
  w.document.querySelector('#opener').focus();
  return { dom, w };
}
describe('Chunk 1 regression coverage', () => {
  it('protects dirty drafts and restores focus after discard', () => {
    const { dom, w } = modalWindow();
    const m = w.TestUI.modal({ title: 'New item', protectChanges: true, bodyHTML: '<input value="">', confirmText: 'Save' });
    const input = m.overlay.querySelector('input'); input.value = 'Draft'; input.dispatchEvent(new w.Event('input', { bubbles: true }));
    m.overlay.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true }));
    expect(m.overlay.isConnected).toBe(true);
    w.confirm = () => false;
    m.overlay.querySelector('[data-close]').click();
    expect(m.overlay.isConnected).toBe(true);
    expect(input.value).toBe('Draft');
    input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    w.confirm = () => true;
    input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(m.overlay.isConnected).toBe(false);
    expect(w.document.activeElement.id).toBe('opener');
    dom.window.close();
  });
  it('closes a saved dirty draft and keeps the parent dialog open when a nested dialog closes', async () => {
    const { dom, w } = modalWindow();
    const parent = w.TestUI.modal({ title: 'Item', bodyHTML: '<input><button id="options">Option</button>' });
    parent.overlay.querySelector('#options').focus();
    const child = w.TestUI.modal({ title: 'Options', protectChanges: true, bodyHTML: '<input>', confirmText: 'Save', onConfirm: () => true });
    child.overlay.querySelector('input').dispatchEvent(new w.Event('input', { bubbles: true }));
    child.overlay.querySelector('[data-confirm]').click(); await tick();
    expect(child.overlay.isConnected).toBe(false);
    expect(parent.overlay.isConnected).toBe(true);
    expect(w.document.activeElement.id).toBe('options');
    dom.window.close();
  });
  it('resolves confirmation as cancelled on Escape', async () => {
    const { dom, w } = modalWindow();
    const answer = w.TestUI.confirmDialog('Discard?');
    w.document.activeElement.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(await answer).toBe(false);
    dom.window.close();
  });
  it('ignores older inventory responses and recovers a failed request without resetting filters', async () => {
    const dom = new JSDOM('<div id="view"></div><div id="modal-root"></div>', { runScripts: 'outside-only', url: 'http://localhost' });
    const w = dom.window as any;
    const requests: Array<{ url: string; resolve: (data: unknown) => void; reject: (err: Error) => void }> = [];
    w.API = { get: (url: string) => {
      if (url.startsWith('/inventory?')) return new Promise((resolve, reject) => requests.push({ url, resolve, reject }));
      return Promise.resolve(url.endsWith('form-config') ? null : url.endsWith('categories') ? ['Fasteners'] : []);
    }};
    let render: any;
    w.App = { register: (_: string, fn: any) => { render = fn; }, getDepartments: () => [], hasPermission: () => false };
    w.eval(read('js/ui.js') + '\n' + read('js/item-form-config.js') + '\n' + read('js/modules/inventory/inventory.js'));
    const view = w.document.querySelector('#view');
    const boot = render(view);
    const category = view.querySelector('#inv-cat');
    category.innerHTML = '<option value="">All</option><option value="Fasteners">Fasteners</option>';
    category.value = 'Fasteners';category.dispatchEvent(new w.Event('change'));
    requests[1]!.resolve([]); await tick();
    requests[0]!.resolve([{ id: 1, name: 'Stale item' }]); await boot;
    expect(view.textContent).not.toContain('Stale item');
    expect(view.querySelector('#inv-count').textContent).toBe('0 items shown');
    category.dispatchEvent(new w.Event('change'));
    requests[2]!.reject(new Error('Network interrupted')); await tick();
    view.querySelector('[data-retry]').click();
    expect(requests[3]!.url).toContain('category=Fasteners');
    requests[3]!.resolve([{ id: 2, name: 'Bolt', quantity: 2, min_quantity: 5, low_stock: true }]);await tick();
    expect(view.textContent).toContain('Bolt');
    expect(view.querySelector('[data-edit]').hidden).toBe(true);
    expect(view.querySelector('#inv-add').hidden).toBe(true);
    view.querySelector('#inv-clear').click();
    expect(requests[4]!.url).toBe('/inventory?kind=parts'); requests[4]!.resolve([]);await tick();
    dom.window.close();
  });
  it('shows zero stock and honest connection status without inviting unauthorized mobile actions', async () => {
    const dom = new JSDOM('<div id="view"></div><div id="m-toasts"></div>', { runScripts: 'outside-only' });
    const w = dom.window as any;
    let render: any;
    w.MApp = { route: (_: string, fn: any) => { render = fn; }, setTitle() {}, can: () => false };
    w.API = { get: (url: string) => Promise.resolve(url.endsWith('/stock')
      ? [{ location_name: 'Branch Store', quantity: 0 }]
      : { id: 1, name: 'Bolt', quantity: 0, min_quantity: 5, unit: 'pcs', history: [] }) };
    w.eval(read('mobile/lib/dom.js') + '\n' + read('mobile/modules/inventory/item-detail.js'));
    const view = w.document.querySelector('#view'); render(view, { id: 1 }); await tick();
    expect(view.textContent).toContain('Branch Store');
    expect(view.textContent).toContain('No recent stock movements.');
    expect(view.querySelector('.m-sr-saved').textContent).toContain('Online');
    expect(view.querySelectorAll('.m-arc button').length).toBe(0);
    expect(view.textContent).not.toContain('Add photo');
    expect(view.textContent).not.toContain('Add QR');
    dom.window.close();
  });

});
