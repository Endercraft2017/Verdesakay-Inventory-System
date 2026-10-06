/** Purchasing split from orders.* (src/modules/inventory/order-access.ts): purchase orders, goods
    receipts and vendor bills need purchasing.view / purchasing.manage; sale and job orders keep
    orders.*. Also: listing orders needs one of them (it used to be open to every account). */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';

let ctx: TestContext;
let admin: string;
let sales: string;   // orders.* only
let buyer: string;   // purchasing.* only
let nobody: string;  // neither
let poId: number;
let soId: number;
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const line = [{ name: 'Bolt', quantity: 2, unit_price: 5 }];

beforeAll(async () => {
  ctx = await setupApp();
  admin = await login(ctx.api);
  await ctx.api.post('/api/roles').set(auth(admin))
    .send({ label: 'Sales Desk', permissions: ['orders.view', 'orders.create', 'orders.edit', 'orders.delete'] });
  await ctx.api.post('/api/roles').set(auth(admin))
    .send({ label: 'Buyer', permissions: ['purchasing.view', 'purchasing.manage'] });
  await ctx.api.post('/api/roles').set(auth(admin)).send({ label: 'Floor', permissions: ['mobile.access'] });
  sales = (await createEmployee(ctx.api, admin, { username: 'sales.desk', role: 'sales_desk' })).token;
  buyer = (await createEmployee(ctx.api, admin, { username: 'buyer.one', role: 'buyer' })).token;
  nobody = (await createEmployee(ctx.api, admin, { username: 'floor.one', role: 'floor' })).token;
  poId = (await ctx.api.post('/api/orders').set(auth(admin)).send({ type: 'purchase', items: line })).body.id;
  soId = (await ctx.api.post('/api/orders').set(auth(admin)).send({ type: 'sale', items: line })).body.id;
});
afterAll(() => cleanup(ctx));

describe('orders.* without purchasing', () => {
  it('sees and makes sale orders but not purchase orders', async () => {
    const h = auth(sales);
    expect((await ctx.api.get('/api/orders?type=purchase').set(h)).status).toBe(403);
    const all = await ctx.api.get('/api/orders').set(h);
    expect(all.status).toBe(200);
    expect(all.body.map((o: { type: string }) => o.type)).not.toContain('purchase');
    expect(all.body.map((o: { id: number }) => o.id)).toContain(soId);
    expect((await ctx.api.get(`/api/orders/${poId}`).set(h)).status).toBe(403);
    expect((await ctx.api.post('/api/orders').set(h).send({ type: 'purchase', items: line })).status).toBe(403);
    expect((await ctx.api.post('/api/orders').set(h).send({ type: 'sale', items: line })).status).toBe(201);
    expect((await ctx.api.put(`/api/orders/${poId}`).set(h).send({ items: line })).status).toBe(403);
    expect((await ctx.api.delete(`/api/orders/${poId}`).set(h)).status).toBe(403);
  });

  it('has no goods receipts, vendor bills or reorder POs', async () => {
    const h = auth(sales);
    expect((await ctx.api.get('/api/purchasing/receipts').set(h)).status).toBe(403);
    expect((await ctx.api.get('/api/purchasing/bills').set(h)).status).toBe(403);
    expect((await ctx.api.get(`/api/purchasing/orders/${poId}`).set(h)).status).toBe(403);
    expect((await ctx.api.post('/api/inventory/reorder-po').set(h).send({})).status).toBe(403);
  });
});

describe('purchasing.* without orders', () => {
  it('runs purchase orders, receipts and bills but not sale orders', async () => {
    const h = auth(buyer);
    const list = await ctx.api.get('/api/orders?type=purchase').set(h);
    expect(list.status).toBe(200);
    expect(list.body.map((o: { id: number }) => o.id)).toContain(poId);
    expect((await ctx.api.get(`/api/orders/${poId}`).set(h)).status).toBe(200);
    expect((await ctx.api.post('/api/orders').set(h).send({ type: 'purchase', items: line })).status).toBe(201);
    expect((await ctx.api.get('/api/purchasing/receipts').set(h)).status).toBe(200);
    expect((await ctx.api.get('/api/purchasing/bills').set(h)).status).toBe(200);
    expect((await ctx.api.get('/api/orders?type=sale').set(h)).status).toBe(403);
    expect((await ctx.api.get(`/api/orders/${soId}`).set(h)).status).toBe(403);
    expect((await ctx.api.post('/api/orders').set(h).send({ type: 'sale', items: line })).status).toBe(403);
  });
});

describe('orders are no longer open to everyone', () => {
  it('an account with neither permission cannot list or open orders', async () => {
    expect((await ctx.api.get('/api/orders').set(auth(nobody))).status).toBe(403);
    expect((await ctx.api.get(`/api/orders/${soId}`).set(auth(nobody))).status).toBe(403);
  });
});

describe('nobody loses access', () => {
  it('built-in roles that could see / make orders keep purchase orders', async () => {
    const { roleDefaults } = await import('../src/shared/permissions');
    for (const r of ['admin_staff', 'accounting', 'releasing', 'csr']) {
      expect(roleDefaults(r), r).toEqual(expect.arrayContaining(['purchasing.view', 'purchasing.manage']));
    }
    expect(roleDefaults('warehouse')).toContain('purchasing.view'); // receives against POs
  });

  it('the upgrade grants the purchasing pair once, from orders.*', async () => {
    const db = await import('../src/shared/db');
    db.run(`INSERT INTO roles (key, label, permissions) VALUES ('old_sales', 'Old Sales', ?)`, JSON.stringify(['orders.view', 'orders.edit']));
    db.run(`INSERT INTO roles (key, label, permissions) VALUES ('old_viewer', 'Old Viewer', ?)`, JSON.stringify(['orders.view']));
    db.run("DELETE FROM settings WHERE key = 'migrated_purchasing_split'");
    db.forceMigrate(db.DEFAULT_TENANT);
    const perms = (k: string) => JSON.parse(db.queryOne<{ permissions: string }>('SELECT permissions FROM roles WHERE key = ?', k)!.permissions);
    expect(perms('old_sales')).toEqual(['orders.view', 'orders.edit', 'purchasing.view', 'purchasing.manage']);
    expect(perms('old_viewer')).toEqual(['orders.view', 'purchasing.view']);
  });
});
