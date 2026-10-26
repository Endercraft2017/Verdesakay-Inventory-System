import { it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';

function setup() {
  const dom = new JSDOM('<body></body>', { runScripts: 'outside-only', url: 'https://localhost/m' });
  const win = dom.window as any;
  win.mEl = (html: string) => { const wrap = win.document.createElement('div'); wrap.innerHTML = html; return wrap.firstElementChild; };
  win.mEsc = (value: unknown) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  win.API = { get: async () => [{ id: 7, name: 'Registered buyer', phone: '09123456789' }] };
  win.RoleUI = { field: (label: string, value: unknown) => `<p>${label}: ${value}</p>`, section: (label: string) => `<h2>${label}</h2>` };
  win.eval(fs.readFileSync(path.join(import.meta.dirname, '../public/mobile/lib/sale-ui.js'), 'utf8'));
  return { dom, win };
}
it('customer changes cannot overwrite unrelated order draft fields', () => {
  const { dom, win } = setup();
  try {
    const batch = { customer_id: 7, customer_name: 'Registered buyer', notes: 'Initial', expected_date: '2026-12-01' };
    const picker = win.mSaleUI.customerPicker({ value: batch, onChange: (identity: unknown) => Object.assign(batch, identity) });
    win.document.body.appendChild(picker.el);
    batch.notes = 'Changed before customer'; batch.expected_date = '2026-12-20';
    const name = picker.el.querySelector('[data-customer-name]'); name.value = 'Walk-in buyer'; name.dispatchEvent(new win.Event('input'));
    expect(batch).toMatchObject({ customer_id: null, customer_name: 'Walk-in buyer', notes: 'Changed before customer', expected_date: '2026-12-20' });
    expect(Object.keys(picker.value()).sort()).toEqual(['customer_contact', 'customer_id', 'customer_mode', 'customer_name']);
  } finally { dom.window.close(); }
});
it('actual dates require successful handoff status and courier dates never mean customer delivery', () => {
  const { dom, win } = setup();
  try {
    const html = win.mSaleUI.deliveryFacts({ expected_date: '2026-12-20', delivery_events: [
      { number: 'DROP-OWN', status: 'delivered', delivery_mode: 'own', delivered_at: '2026-10-24 03:00:00', release_slip_number: 'SLIP-1' },
      { number: 'DROP-COURIER', status: 'delivered', delivery_mode: 'courier', delivered_at: '2026-10-24 04:00:00', release_slip_number: 'SLIP-2' },
      { number: 'FAILED-DROP', status: 'failed', delivery_mode: 'own', delivered_at: '2026-10-24 05:00:00' },
      { number: 'NO-DATE', status: 'delivered', delivery_mode: 'own', delivered_at: null },
    ] });
    expect(html).toContain('Target delivery date: 2026-12-20');
    expect(html).toContain('Customer delivery: SLIP-1 · DROP-OWN');
    expect(html).toContain('Courier pickup / handoff: SLIP-2 · DROP-COURIER');
    expect(html).not.toMatch(/FAILED-DROP|NO-DATE|input/);
  } finally { dom.window.close(); }
});

it('a first trip never marks an order complete while authoritative stock demand remains', () => {
  const { dom, win } = setup();
  try {
    const partial = { id: 42, status: 'approved', release_slip_number: 'RS-1', backordered: 0, fulfillment_remaining: 3, fulfillment_dispatched: 1 };
    expect(win.mSaleUI.fulfillmentStage(partial, {})).toBe(2);
    expect(win.mSaleUI.fulfillmentStage({ ...partial, fulfillment_remaining: 0, fulfillment_dispatched: 4 }, {})).toBe(3);
    expect(win.mSaleUI.fulfillmentStage({ ...partial, fulfillment: { remaining: 3, dispatched: 1 }, fulfillment_remaining: 0 }, {})).toBe(2);
  } finally { dom.window.close(); }
});
it('fulfillment details keep shipped, held, remaining and CKD kit quantities distinct', () => {
  const { dom, win } = setup();
  try {
    win.RoleUI.lines = (rows: unknown) => JSON.stringify(rows);
    const rows = win.mSaleUI.orderProgress({ items: [
      { id: 1, item_id: 1, name: 'Exact sale line', quantity: 4, dispatched_qty: 1, dispatched_bulk_qty: 1, released_qty: 3, unit: 'pcs' },
      { id: 2, item_id: 2, name: 'CKD product', quantity: 2, dispatched_qty: 0, fulfillment_mode: 'ckd' },
      { id: 3, item_id: 3, name: 'Bolt', quantity: 6, released_qty: 3, parent_order_item_id: 2 },
      { id: 4, item_id: 4, name: 'Cable', quantity: 4, released_qty: 2, parent_order_item_id: 2 },
    ] });
    expect(rows).toContain('1 pcs shipped');expect(rows).toContain('2 pcs held · 3 pcs still to ship');
    expect(rows).toContain('1 kits held · 2 kits still to ship');expect(rows).not.toContain('Line #3');
  } finally { dom.window.close(); }
});
