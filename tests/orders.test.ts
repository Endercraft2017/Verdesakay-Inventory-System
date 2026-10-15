/** Orders: create with auto number + server-computed totals, list by type, update
    (replace items + recompute), delete (cascades items), validation, auth. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';

let ctx: TestContext;
let token: string;
const hdr = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  ctx = await setupApp();
  token = await login(ctx.api);
});
afterAll(() => cleanup(ctx));

const sampleItems = [
  { name: 'Bond Paper', sku: 'PPR', quantity: 10, unit: 'reams', unit_price: 120 },
  { name: 'Marker', quantity: 5, unit: 'pcs', unit_price: 35 },
];

describe('orders', () => {
  it('requires authentication', async () => {
    expect((await ctx.api.get('/api/orders')).status).toBe(401);
  });

  it('creates a sale order with an auto number and server-computed totals', async () => {
    const res = await ctx.api.post('/api/orders').set(hdr())
      .send({ type: 'sale', customer_name: 'ACME', tax_percent: 12, items: sampleItems });
    expect(res.status).toBe(201);
    expect(res.body.number).toMatch(/^SO-\d{5}$/);

    const detail = await ctx.api.get('/api/orders/' + res.body.id).set(hdr());
    // 10*120 + 5*35 = 1375 subtotal; 12% tax = 165; total = 1540
    expect(detail.body.subtotal).toBe(1375);
    expect(detail.body.tax_amount).toBe(165);
    expect(detail.body.total).toBe(1540);
    expect(detail.body.items).toHaveLength(2);
    expect(detail.body.items[0].line_total).toBe(1200);
  });

  it('ignores client-sent totals (recomputes from line items)', async () => {
    const res = await ctx.api.post('/api/orders').set(hdr())
      .send({ type: 'sale', total: 999999, subtotal: 999999, items: [{ name: 'X', quantity: 2, unit_price: 50 }] });
    const detail = await ctx.api.get('/api/orders/' + res.body.id).set(hdr());
    expect(detail.body.total).toBe(100); // 2*50, not the bogus 999999
  });

  it('numbers job orders with the JO- prefix and a separate sequence', async () => {
    const res = await ctx.api.post('/api/orders').set(hdr())
      .send({ type: 'job', items: [{ name: 'Repair', quantity: 1, unit_price: 500 }] });
    expect(res.body.number).toMatch(/^JO-\d{5}$/);
  });

  it('creates a purchase request with the PR- prefix', async () => {
    const res = await ctx.api.post('/api/orders').set(hdr())
      .send({ type: 'purchase', items: [{ name: 'Bond Paper', quantity: 5, unit_price: 120 }] });
    expect(res.status).toBe(201);
    expect(res.body.number).toMatch(/^PR-\d{5}$/);
    const detail = await ctx.api.get('/api/orders/' + res.body.id).set(hdr());
    expect(detail.body.type).toBe('purchase');
    expect(detail.body.total).toBe(600);
  });

  it('lists by type', async () => {
    const sales = await ctx.api.get('/api/orders?type=sale').set(hdr());
    expect(sales.body.every((o: { type: string }) => o.type === 'sale')).toBe(true);
    const jobs = await ctx.api.get('/api/orders?type=job').set(hdr());
    expect(jobs.body.every((o: { type: string }) => o.type === 'job')).toBe(true);
  });

  it('updates an order, replacing items and recomputing totals', async () => {
    const created = await ctx.api.post('/api/orders').set(hdr())
      .send({ type: 'sale', items: [{ name: 'Old', quantity: 1, unit_price: 10 }] });
    const upd = await ctx.api.put('/api/orders/' + created.body.id).set(hdr())
      .send({ tax_percent: 0, items: [{ name: 'New', quantity: 3, unit_price: 100 }] });
    expect(upd.status).toBe(200);
    const detail = await ctx.api.get('/api/orders/' + created.body.id).set(hdr());
    expect(detail.body.items).toHaveLength(1);
    expect(detail.body.items[0].name).toBe('New');
    expect(detail.body.total).toBe(300);
  });

  it('rejects an order with no line items', async () => {
    const res = await ctx.api.post('/api/orders').set(hdr()).send({ type: 'sale', items: [] });
    expect(res.status).toBe(400);
  });

  it('deletes an order (and its items cascade)', async () => {
    const created = await ctx.api.post('/api/orders').set(hdr())
      .send({ type: 'sale', items: [{ name: 'Z', quantity: 1, unit_price: 1 }] });
    expect((await ctx.api.delete('/api/orders/' + created.body.id).set(hdr())).status).toBe(200);
    expect((await ctx.api.get('/api/orders/' + created.body.id).set(hdr())).status).toBe(404);
  });
});

describe('orders: RBAC on mutations', () => {
  it('a role with none of the orders.* permissions (hr) is rejected on create/update/delete', async () => {
    const order = await ctx.api.post('/api/orders').set(hdr())
      .send({ type: 'sale', items: [{ name: 'RBAC', quantity: 1, unit_price: 1 }] });
    const hr = await createEmployee(ctx.api, token, { username: 'rbac_hr_orders', role: 'hr' });
    const hrHdr = { Authorization: `Bearer ${hr.token}` };
    expect((await ctx.api.post('/api/orders').set(hrHdr).send({ type: 'sale', items: [{ name: 'x', quantity: 1, unit_price: 1 }] })).status).toBe(403);
    expect((await ctx.api.put(`/api/orders/${order.body.id}`).set(hrHdr).send({ items: [{ name: 'x', quantity: 1, unit_price: 1 }] })).status).toBe(403);
    expect((await ctx.api.delete(`/api/orders/${order.body.id}`).set(hrHdr)).status).toBe(403);
  });

  it('a role with orders.create/edit but not orders.delete (accounting) can create/edit but not delete', async () => {
    const staff = await createEmployee(ctx.api, token, { username: 'rbac_acct_orders', role: 'accounting' });
    const staffHdr = { Authorization: `Bearer ${staff.token}` };
    const created = await ctx.api.post('/api/orders').set(staffHdr)
      .send({ type: 'sale', items: [{ name: 'Acct', quantity: 1, unit_price: 10 }] });
    expect(created.status).toBe(201);
    expect((await ctx.api.put(`/api/orders/${created.body.id}`).set(staffHdr).send({ items: [{ name: 'Acct2', quantity: 1, unit_price: 10 }] })).status).toBe(200);
    expect((await ctx.api.delete(`/api/orders/${created.body.id}`).set(staffHdr)).status).toBe(403);
  });
});

describe('order intake validation', () => {
  const line = { name: 'Intake item', quantity: 1, unit_price: 10 };
  it.each([0, -1])('rejects quantity %s without creating an order', async (quantity) => {
    const before = (await ctx.api.get('/api/orders?type=sale').set(hdr())).body.length;
    const res = await ctx.api.post('/api/orders').set(hdr()).send({ type: 'sale', items: [{ ...line, quantity }] });
    expect(res.status).toBe(400);
    expect((await ctx.api.get('/api/orders?type=sale').set(hdr())).body).toHaveLength(before);
  });
  it('accepts positive fractional quantities and explicit zero-priced lines', async () => {
    const res = await ctx.api.post('/api/orders').set(hdr()).send({ type: 'sale', items: [{ ...line, quantity: 0.5, unit_price: 0 }] });
    expect(res.status).toBe(201);
  });
  it.each(['2026-02-30', 'tomorrow'])('rejects invalid order date %s', async (order_date) => {
    const res = await ctx.api.post('/api/orders').set(hdr()).send({ type: 'sale', order_date, items: [line] });
    expect(res.status).toBe(400);
  });
  it('accepts empty dates as unspecified', async () => {
    const res = await ctx.api.post('/api/orders').set(hdr()).send({ type: 'sale', order_date: '', items: [line] });
    expect(res.status).toBe(201);
    expect((await ctx.api.get('/api/orders/' + res.body.id).set(hdr())).body.order_date).toBeNull();
  });
  it.each(['customer_id', 'location_id', 'tax_code_id'])('rejects unknown %s with an actionable error', async (field) => {
    const res = await ctx.api.post('/api/orders').set(hdr()).send({ type: 'sale', [field]: 999999, items: [line] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not found/);
  });
  it('rejects a broken line inventory link on create and update', async () => {
    const bad = { ...line, item_id: 999999 };
    expect((await ctx.api.post('/api/orders').set(hdr()).send({ type: 'sale', items: [bad] })).status).toBe(400);
    const res = await ctx.api.post('/api/orders').set(hdr()).send({ type: 'sale', items: [line] });
    expect((await ctx.api.put('/api/orders/' + res.body.id).set(hdr()).send({ items: [bad] })).status).toBe(400);
    expect((await ctx.api.get('/api/orders/' + res.body.id).set(hdr())).body.items[0].item_id).toBeNull();
  });
  it('preserves repeated stock items as separate commercial lines', async () => {
    const item = await ctx.api.post('/api/inventory').set(hdr()).send({ name: 'Repeated stock' });
    const stockLine = { ...line, item_id: item.body.id };
    const res = await ctx.api.post('/api/orders').set(hdr()).send({ type: 'sale', items: [stockLine, { ...stockLine, name: 'Other label' }] });
    expect(res.status).toBe(201);
    const saved = (await ctx.api.get('/api/orders/' + res.body.id).set(hdr())).body.items;
    expect(saved.map((l: { item_id: number; name: string }) => [l.item_id, l.name]))
      .toEqual([[item.body.id, stockLine.name], [item.body.id, 'Other label']]);
  });
  it('does not auto-link a non-stock line by its name', async () => {
    await ctx.api.post('/api/inventory').set(hdr()).send({ name: 'Installation' });
    const res = await ctx.api.post('/api/orders').set(hdr()).send({ type: 'sale', items: [{ ...line, name: 'Installation' }] });
    expect((await ctx.api.get('/api/orders/' + res.body.id).set(hdr())).body.items[0].item_id).toBeNull();
  });
  it('fills linked customer details when the browser sends blank fields', async () => {
    const c = await ctx.api.post('/api/customers').set(hdr()).send({ name: 'Intake customer', phone: '09123456789' });
    const res = await ctx.api.post('/api/orders').set(hdr()).send({ type: 'sale', customer_id: c.body.id, customer_name: '', customer_contact: '  ', items: [line] });
    expect(res.status).toBe(201);
    const order = (await ctx.api.get('/api/orders/' + res.body.id).set(hdr())).body;
    expect(order.customer_name).toBe('Intake customer');
    expect(order.customer_contact).toBe('09123456789');
  });
});

describe('intake audit: edit safety and handoff', () => {
  const items = [{ name: 'Service', quantity: 1, unit_price: 25 }];
  const create = async (extra = {}) => (await ctx.api.post('/api/orders').set(hdr()).send({ type: 'sale', items, ...extra })).body.id as number;
  const get = async (id: number) => (await ctx.api.get('/api/orders/' + id).set(hdr())).body;
  it('denies order list/detail/availability to an account without view permission', async () => {
    const id = await create();
    const hr = await createEmployee(ctx.api, token, { username: 'no_order_reads', role: 'hr' });
    for (const path of ['/api/orders', `/api/orders/${id}`, `/api/orders/${id}/availability`]) {
      expect((await ctx.api.get(path).set({ Authorization: `Bearer ${hr.token}` })).status).toBe(403);
    }
  });
  it('preserves omitted header fields, status, totals, and line IDs during a notes-only edit', async () => {
    const c = (await ctx.api.post('/api/customers').set(hdr()).send({ name: 'Preserved customer' })).body.id;
    const id = await create({ customer_id: c, customer_contact: '0912', currency: 'USD', order_date: '2026-10-13', tax_percent: 12 });
    const before = await get(id);
    expect((await ctx.api.put(`/api/orders/${id}`).set(hdr()).send({ notes: 'Call before delivery' })).status).toBe(200);
    const after = await get(id);
    expect(after).toMatchObject({ customer_id: c, customer_contact: '0912', currency: 'USD', order_date: '2026-10-13', tax_percent: 12, total: 28, status: 'open', notes: 'Call before delivery' });
    expect(after.items).toEqual(before.items);
  });
  it('honors explicit null to reset ship-from to the default', async () => {
    const loc = (await ctx.api.post('/api/locations').set(hdr()).send({ name: 'Intake alternate', type: 'warehouse' })).body.id;
    const id = await create({ location_id: loc });
    expect((await ctx.api.put(`/api/orders/${id}`).set(hdr()).send({ location_id: null })).status).toBe(200);
    expect((await get(id)).location_id).toBeNull();
  });
  it('rejects a stale edit without losing the other editor’s changes', async () => {
    const id = await create();
    const first = await get(id);
    const saved = await ctx.api.put(`/api/orders/${id}`).set(hdr()).send({ notes: 'First editor', expected_revision: first.revision });
    expect(saved.status).toBe(200);
    const stale = await ctx.api.put(`/api/orders/${id}`).set(hdr()).send({ notes: 'Second editor', expected_revision: first.revision, items: [{ name: 'Overwrite', quantity: 2, unit_price: 99 }] });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('stale_order');
    expect((await get(id)).notes).toBe('First editor');
    expect((await get(id)).total).toBe(25);
  });
  it('permits legacy header updates on approved orders without accepting line/currency/tax edits', async () => {
    const id = await create({ status: 'approved', tax_percent: 12 });
    const original = await get(id);
    expect((await ctx.api.put(`/api/orders/${id}`).set(hdr()).send({ notes: 'Header update', currency: 'USD', tax_percent: 0, items: [{ name: '', quantity: 0 }] })).status).toBe(200);
    const got = await get(id);
    expect(got.status).toBe('approved');
    expect(got.currency).toBe('PHP');
    expect(got.tax_percent).toBe(12);
    expect(got.items).toEqual(original.items);
  });
  it('keeps locked zero-quantity legacy lines when editing a header', async () => {
    const id = await create({ status: 'approved' });
    const db = await import('../src/shared/db');
    db.run('UPDATE order_items SET quantity = 0, line_total = 0 WHERE order_id = ?', id);
    const r = await ctx.api.put(`/api/orders/${id}`).set(hdr()).send({ notes: 'Legacy note' });
    expect(r.status).toBe(200);
    expect((await get(id)).items[0].quantity).toBe(0);
  });
  it('blocks manual released status on create, update, and status-only paths', async () => {
    expect((await ctx.api.post('/api/orders').set(hdr()).send({ type: 'sale', status: 'released', items })).status).toBe(400);
    const id = await create({ status: 'approved' });
    expect((await ctx.api.put(`/api/orders/${id}`).set(hdr()).send({ status: 'released' })).status).toBe(400);
    expect((await ctx.api.post(`/api/orders/${id}/status`).set(hdr()).send({ status: 'released' })).status).toBe(400);
    expect((await get(id)).status).toBe('approved');
  });
  it('rejects unknown sale statuses and normalizes supported ones', async () => {
    expect((await ctx.api.post('/api/orders').set(hdr()).send({ type: 'sale', status: 'anything', items })).status).toBe(400);
    const id = await create({ status: 'OPEN', currency: 'usd' });
    expect((await get(id)).status).toBe('open');
    expect((await get(id)).currency).toBe('USD');
  });
  it('rejects overflow totals and invalid currency without writing an order', async () => {
    for (const extra of [{ currency: 'pesos' }, { items: [{ name: 'Overflow', quantity: 1e10, unit_price: 1e300 }] }]) {
      expect((await ctx.api.post('/api/orders').set(hdr()).send({ type: 'sale', items, ...extra })).status).toBe(400);
    }
  });
  it('replays an identical keyed create once even when the caller retries', async () => {
    const key = 'intake-test:retry-create';
    const before = (await ctx.api.get('/api/orders?type=sale').set(hdr())).body.length;
    const first = await ctx.api.post('/api/orders').set(hdr()).set('Idempotency-Key', key).send({ type: 'sale', items });
    const retry = await ctx.api.post('/api/orders').set(hdr()).set('Idempotency-Key', key).send({ type: 'sale', items });
    expect(retry.body.id).toBe(first.body.id);
    expect((await ctx.api.get('/api/orders?type=sale').set(hdr())).body).toHaveLength(before + 1);
  });
  it('does not replay a saved response to unauthenticated or unauthorized callers', async () => {
    const key = 'intake-test:private-response';
    const first = await ctx.api.post('/api/orders').set(hdr()).set('Idempotency-Key', key).send({ type: 'sale', items });
    expect(first.status).toBe(201);
    expect((await ctx.api.post('/api/orders/').set('Idempotency-Key', key).send({ type: 'sale', items })).status).toBe(401);
    const hr = await createEmployee(ctx.api, token, { username: 'no_cached_order_writes', role: 'hr' });
    expect((await ctx.api.post('/api/orders').set({ Authorization: `Bearer ${hr.token}` }).set('Idempotency-Key', key).send({ type: 'sale', items })).status).toBe(403);
    const csr = await createEmployee(ctx.api, token, { username: 'other_cached_order_writer', role: 'csr' });
    expect((await ctx.api.post('/api/orders').set({ Authorization: `Bearer ${csr.token}` }).set('Idempotency-Key', key).send({ type: 'sale', items })).status).toBe(409);
  });
  it('replays older order keys stored relative to the global /api mount', async () => {
    const key = 'intake-test:legacy-mount';
    const first = await ctx.api.post('/api/orders').set(hdr()).set('Idempotency-Key', key).send({ type: 'sale', items });
    const db = await import('../src/shared/db');
    db.run('UPDATE idempotency_keys SET path = ? WHERE key = ?', '/orders', key);
    const retry = await ctx.api.post('/api/orders').set(hdr()).set('Idempotency-Key', key).send({ type: 'sale', items });
    expect(retry.status).toBe(201);
    expect(retry.body.id).toBe(first.body.id);
    expect(retry.headers['idempotency-replayed']).toBe('true');
  });
});
