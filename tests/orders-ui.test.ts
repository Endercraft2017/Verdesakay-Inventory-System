/** Exercise the real order editor and UI helpers, with API responses controlled at
 * the network boundary. Covers lost lines, explicit links, locks, and permissions. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const root = path.join(import.meta.dirname, '..', 'public');
const windows: JSDOM[] = [];
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function setup(permissions = ['orders.create', 'orders.edit', 'orders.delete'], order?: Record<string, unknown>, responses: Record<string, unknown> = {}) {
  const dom = new JSDOM('<div id="view"></div><div id="modal-root"></div><div id="toasts"></div>', { runScripts: 'outside-only', url: 'http://localhost/' });
  windows.push(dom);
  const win = dom.window;
  const doc = win.document;
  const inventory = [{ id: 8, name: 'Motor', sku: 'M-8', unit: 'pcs', quantity: 12, attributes: { sale_price: 50 } }];
  const api = {
    get: vi.fn(async (url: string) => {
      if (Object.hasOwn(responses, url)) return responses[url];
      if (url === '/quickbooks/status') return {};
      if (url === '/customers') return [{ id: 3, name: 'Customer A', phone: '0912' }];
      if (url === '/finished-products') return [{ id: 8, name: 'Motor' }];
      if (url === '/locations' || url.startsWith('/accounting/')) return [];
      if (url.startsWith('/inventory?')) return inventory;
      if (url === '/orders/1') return order;
      if (url.startsWith('/orders?')) return order ? [order] : [];
      throw new Error('Unexpected GET: ' + url);
    }),
    post: vi.fn(async (_url: string, _body: Record<string, unknown>, _options?: { idempotencyKey: string }) => ({ id: 1, number: 'SO-00001' })),
    put: vi.fn(async (_url: string, _body: Record<string, unknown>, _options?: { idempotencyKey: string }) => ({ ok: true })),
  };
  let route!: (view: Element, filter: Record<string, unknown>) => Promise<void>;
  Object.assign(win, { API: api, App: { hasPermission: (p: string) => permissions.includes(p), register: (_: string, fn: typeof route) => { route = fn; } } });
  win.eval(fs.readFileSync(path.join(root, 'js/ui.js'), 'utf8') + '\n' + fs.readFileSync(path.join(root, 'js/modules/inventory/orders.js'), 'utf8'));
  await route(doc.querySelector('#view')!, order ? { id: 1 } : {});
  await flush();
  const click = (selector: string) => (doc.querySelector(selector) as HTMLButtonElement).click();
  const input = (selector: string, value: string) => {
    const el = doc.querySelector(selector) as HTMLInputElement;
    el.value = value;
    el.dispatchEvent(new win.Event('input', { bubbles: true }));
  };
  return { doc, win, api, inventory, click, input };
}

afterEach(() => { windows.splice(0).forEach((dom) => dom.window.close()); });

describe('sales order intake UI', () => {
  it('starts with an open order and explains the next checkpoint', async () => {
    const { doc, click } = await setup();
    click('#ord-new');
    expect(doc.querySelector('[data-confirm]')?.textContent).toBe('Save open order');
    expect(doc.querySelectorAll('[data-f="status"] option')).toHaveLength(1);
    expect(doc.querySelector('.order-editor-intro')?.textContent).toContain('Approval checks stock');
  });
  it('does not discard an unnamed line when another line is valid', async () => {
    const { doc, api, click, input } = await setup();
    click('#ord-new'); click('#ord-add-blank'); input('[data-row="0"] [data-k="name"]', 'Valid charge'); click('#ord-add-blank');
    click('[data-confirm]'); await flush();
    expect(api.post).not.toHaveBeenCalled();
    expect(doc.querySelector('[data-row="1"] [data-k="name"]')?.getAttribute('aria-invalid')).toBe('true');
    expect(doc.activeElement).toBe(doc.querySelector('[data-row="1"] [data-k="name"]'));
  });
  it('keeps a named non-stock charge unlinked without searching or creating inventory', async () => {
    const { api, click, input } = await setup();
    click('#ord-new'); click('#ord-add-blank'); input('[data-k="name"]', 'Motor');
    click('[data-confirm]'); await flush();
    expect(api.get.mock.calls.some(([url]) => url.startsWith('/inventory'))).toBe(false);
    expect(api.post).toHaveBeenCalledWith('/orders', expect.objectContaining({ status: 'open', items: [expect.objectContaining({ name: 'Motor', item_id: null })] }), expect.objectContaining({ idempotencyKey: expect.any(String) }));
  });
  it.each(['0', '-2', ''])('rejects invalid quantity "%s" before saving', async (quantity) => {
    const { doc, api, click, input } = await setup();
    click('#ord-new'); click('#ord-add-blank'); input('[data-k="name"]', 'Charge'); input('[data-k="quantity"]', quantity);
    click('[data-confirm]'); await flush();
    expect(api.post).not.toHaveBeenCalled();
    expect(doc.querySelector('[data-k="quantity"]')?.getAttribute('aria-invalid')).toBe('true');
  });
  it('keeps duplicate inventory selections on one line and focuses quantity', async () => {
    const { doc, click } = await setup();
    click('#ord-new'); click('#ord-add-inv'); await flush(); click('.order-pick-row');
    click('#ord-add-inv'); await flush(); click('.order-pick-row');
    expect(doc.querySelectorAll('[data-row]')).toHaveLength(1);
    expect(doc.activeElement).toBe(doc.querySelector('[data-k="quantity"]'));
    expect(doc.querySelector('.order-link-hint')?.textContent).toContain('Linked inventory');
  });
  it('shows approved lines and tax as locked while keeping header editable', async () => {
    const { doc } = await setup(undefined, { id: 1, number: 'SO-00001', status: 'approved', items: [{ name: 'Motor', quantity: 2, unit_price: 10, item_id: 8 }] });
    expect((doc.querySelector('[data-k="quantity"]') as HTMLInputElement).disabled).toBe(true);
    expect((doc.querySelector('[data-f="tax_percent"]') as HTMLInputElement).disabled).toBe(true);
    expect((doc.querySelector('[data-f="customer_name"]') as HTMLInputElement).disabled).toBe(false);
    expect(doc.querySelector('#ord-add-inv')).toBeNull();
    expect(doc.querySelector('#ord-allocate')).toBeNull();
    expect(doc.querySelector('.order-notice')?.textContent).toContain('clears warehouse reservations');
  });
  it('provides a view-only order without mutation controls', async () => {
    const { doc } = await setup([], { id: 1, number: 'SO-00001', status: 'open', items: [{ name: 'Charge', quantity: 1, unit_price: 10 }] });
    expect(doc.querySelector('#ord-new')).toBeNull();
    expect(doc.querySelector('[data-edit]')).toBeNull();
    expect(doc.querySelector('[data-del]')).toBeNull();
    expect(doc.querySelector('[data-confirm]')).toBeNull();
    expect((doc.querySelector('[data-f="status"]') as HTMLSelectElement).disabled).toBe(true);
  });
  it('fills customer fields from the selected record', async () => {
    const { doc, win, click } = await setup();
    click('#ord-new');
    const select = doc.querySelector('[data-f="customer_id"]') as HTMLSelectElement;
    select.value = '3'; select.dispatchEvent(new win.Event('change'));
    expect((doc.querySelector('[data-f="customer_name"]') as HTMLInputElement).value).toBe('Customer A');
    expect((doc.querySelector('[data-f="customer_contact"]') as HTMLInputElement).value).toBe('0912');
  });
  it('matches the server rounding of each line before summing', async () => {
    const { doc, click, input } = await setup();
    click('#ord-new');
    for (let i = 0; i < 2; i++) {
      click('#ord-add-blank'); input(`[data-row="${i}"] [data-k="unit_price"]`, '0.335');
    }
    expect(doc.querySelector('#ord-subtotal')?.textContent).toBe('0.68');
  });
  it('keeps an existing tax classification when its lookup is unavailable', async () => {
    const { api, click } = await setup(undefined, { id: 1, number: 'SO-00001', status: 'open', tax_code_id: 7, items: [{ name: 'Charge', quantity: 1, unit_price: 10 }] });
    click('[data-confirm]'); await flush();
    expect(api.put).toHaveBeenCalledWith('/orders/1', expect.objectContaining({ tax_code_id: 7 }), expect.objectContaining({ idempotencyKey: expect.any(String) }));
  });
  it('closes the picker on Escape and returns focus to its opener', async () => {
    const { doc, win, click } = await setup();
    click('#ord-new');
    (doc.querySelector('#ord-add-inv') as HTMLButtonElement).focus(); click('#ord-add-inv'); await flush();
    expect(doc.querySelectorAll('[role="dialog"]')).toHaveLength(2);
    doc.activeElement!.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await flush();
    expect(doc.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(doc.activeElement).toBe(doc.querySelector('#ord-add-inv'));
  });
  it('shows a recoverable error when inventory search fails', async () => {
    const { doc, api, click } = await setup();
    api.get.mockRejectedValueOnce(new Error('Inventory unavailable'));
    click('#ord-new'); click('#ord-add-inv'); await flush();
    expect(doc.querySelector('#pick-results')?.textContent).toContain('Inventory unavailable');
    click('[data-retry]'); await flush();
    expect(doc.querySelector('.order-pick-row')).not.toBeNull();
  });
  it('links a non-stock line only after an explicit selection', async () => {
    const { doc, api, click, input } = await setup();
    click('#ord-new'); click('#ord-add-blank'); input('[data-k="name"]', 'Motor');
    click('[data-link]'); await flush(); click('.order-pick-row'); await flush();
    expect(doc.querySelector('.order-link-hint')?.textContent).toContain('Linked inventory');
    click('[data-confirm]'); await flush();
    expect(api.post).toHaveBeenCalledWith('/orders', expect.objectContaining({ items: [expect.objectContaining({ item_id: 8 })] }), expect.objectContaining({ idempotencyKey: expect.any(String) }));
  });
  it('does not save a negative price or excessive tax', async () => {
    const { doc, api, click, input } = await setup();
    click('#ord-new'); click('#ord-add-blank'); input('[data-k="name"]', 'Charge'); input('[data-k="unit_price"]', '-1');
    click('[data-confirm]'); await flush();
    expect(doc.querySelector('[data-k="unit_price"]')?.getAttribute('aria-invalid')).toBe('true');
    input('[data-k="unit_price"]', '10'); input('[data-f="tax_percent"]', '101');
    click('[data-confirm]'); await flush();
    expect(api.post).not.toHaveBeenCalled();
    expect(doc.querySelector('[data-f="tax_percent"]')?.getAttribute('aria-invalid')).toBe('true');
  });
  it('preserves a saved inactive tax code while other active codes are loaded', async () => {
    const { doc, api, click } = await setup(undefined, { id: 1, number: 'SO-00001', status: 'open', tax_code_id: 7, items: [{ name: 'Charge', quantity: 1, unit_price: 10, tax_code_id: 7 }] }, {
      '/accounting/tax-codes?active=1': [{ id: 9, name: 'Active VAT', code: 'VAT' }],
    });
    expect((doc.querySelector('[data-f="tax_code_id"]') as HTMLSelectElement).value).toBe('7');
    expect((doc.querySelector('[data-k="tax_code_id"]') as HTMLSelectElement).value).toBe('7');
    click('[data-confirm]'); await flush();
    expect(api.put.mock.calls[0]?.[1].tax_code_id).toBe('7');
  });
  it('retains edits when a stale-order save is rejected and provides a review action', async () => {
    const { doc, api, click, input } = await setup(undefined, { id: 1, number: 'SO-00001', status: 'open', revision: 'a'.repeat(64), items: [{ name: 'Charge', quantity: 1, unit_price: 10 }] });
    api.put.mockRejectedValueOnce(Object.assign(new Error('Order changed'), { status: 409, data: { code: 'stale_order' } }));
    input('[data-f="notes"]', 'My changes'); click('[data-confirm]'); await flush();
    expect(api.put.mock.calls[0]?.[1].expected_revision).toBe('a'.repeat(64));
    expect((doc.querySelector('[data-f="notes"]') as HTMLTextAreaElement).value).toBe('My changes');
    expect(doc.querySelector('[data-modal-error] button')?.textContent).toBe('Review latest order');
  });
  it('reuses a save key on network retry but changes it when the payload changes', async () => {
    const { api, click, input } = await setup();
    click('#ord-new'); click('#ord-add-blank'); input('[data-k="name"]', 'Charge');
    api.post.mockRejectedValueOnce(new Error('Network unavailable'));
    click('[data-confirm]'); await flush();
    api.post.mockRejectedValueOnce(new Error('Network unavailable'));
    click('[data-confirm]'); await flush();
    expect(api.post.mock.calls[1]?.[2]?.idempotencyKey).toBe(api.post.mock.calls[0]?.[2]?.idempotencyKey);
    input('[data-k="quantity"]', '2'); click('[data-confirm]'); await flush();
    expect(api.post.mock.calls[2]?.[2]?.idempotencyKey).not.toBe(api.post.mock.calls[0]?.[2]?.idempotencyKey);
  });
  it('freezes fields and prevents closing while a save is pending', async () => {
    const { doc, api, click, input } = await setup();
    click('#ord-new'); click('#ord-add-blank'); input('[data-k="name"]', 'Charge');
    let resolve!: (r: { id: number; number: string }) => void;
    api.post.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    click('[data-confirm]'); await flush();
    expect((doc.querySelector('[data-k="quantity"]') as HTMLInputElement).disabled).toBe(true);
    click('.order-editor [data-close]'); await flush();
    expect(doc.querySelector('.order-editor')).not.toBeNull();
    resolve({ id: 1, number: 'SO-00001' }); await flush();
    expect(doc.querySelector('.order-editor')).toBeNull();
  });
  it('asks before discarding dirty input, and cancel keeps the editor intact', async () => {
    const { doc, click, input } = await setup();
    click('#ord-new'); click('#ord-add-blank'); input('[data-k="name"]', 'Unsaved');
    click('.order-editor [data-close]'); await flush();
    expect(doc.querySelectorAll('.modal-overlay')).toHaveLength(2);
    click('.modal-overlay:last-child [data-close]'); await flush();
    expect(doc.querySelectorAll('.modal-overlay')).toHaveLength(1);
    expect((doc.querySelector('[data-k="name"]') as HTMLInputElement).value).toBe('Unsaved');
  });
  it('allows an explicit inventory unlink without losing the line', async () => {
    const { api, click, doc } = await setup(undefined, { id: 1, number: 'SO-00001', status: 'open', items: [{ name: 'Motor', item_id: 8, quantity: 1, unit_price: 10 }] });
    click('[data-unlink]');
    expect(doc.querySelector('.order-link-hint')?.textContent).toContain('Non-stock');
    click('[data-confirm]'); await flush();
    expect((api.put.mock.calls[0]?.[1].items as Array<{ item_id: number | null }>)[0]?.item_id).toBeNull();
  });
  it('does not offer manual release status or editable currency after approval', async () => {
    const { doc } = await setup(undefined, { id: 1, number: 'SO-00001', status: 'approved', items: [{ name: 'Charge', quantity: 1, unit_price: 10 }] });
    expect(doc.querySelector('[data-f="status"] option[value="released"]')).toBeNull();
    expect((doc.querySelector('[data-f="currency"]') as HTMLInputElement).disabled).toBe(true);
  });
});
