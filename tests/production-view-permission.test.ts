/** production.view: the production screens' own read permission, split from inventory.view.
    The product catalog stays readable with either (sales orders and the warehouse use it). */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';

let ctx: TestContext;
let admin: string;
let stockOnly: string;   // inventory.view, no production.view
let prodOnly: string;    // production.view, no inventory.view
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  ctx = await setupApp();
  admin = await login(ctx.api);
  await ctx.api.post('/api/roles').set(auth(admin)).send({ label: 'Stock Only', permissions: ['inventory.view'] });
  await ctx.api.post('/api/roles').set(auth(admin)).send({ label: 'Production Viewer', permissions: ['production.view'] });
  stockOnly = (await createEmployee(ctx.api, admin, { username: 'stock.only', role: 'stock_only' })).token;
  prodOnly = (await createEmployee(ctx.api, admin, { username: 'prod.only', role: 'production_viewer' })).token;
});
afterAll(() => cleanup(ctx));

describe('production.view', () => {
  it('opens the production screens; inventory.view alone no longer does', async () => {
    for (const url of ['/api/job-orders', '/api/production/batches', '/api/production/repairs', '/api/qc/records']) {
      expect((await ctx.api.get(url).set(auth(prodOnly))).status, url).toBe(200);
      expect((await ctx.api.get(url).set(auth(stockOnly))).status, url).toBe(403);
    }
  });

  it('keeps the product catalog readable with either permission; BOM costing is production-only', async () => {
    for (const t of [stockOnly, prodOnly]) {
      expect((await ctx.api.get('/api/finished-products').set(auth(t))).status).toBe(200);
    }
    // The permission check runs before the product lookup, so no product is needed.
    expect((await ctx.api.get('/api/finished-products/999999/cost').set(auth(stockOnly))).status).toBe(403);
    expect((await ctx.api.get('/api/finished-products/999999/cost').set(auth(prodOnly))).status).not.toBe(403);
    // A sales/stock reader may request the price suggestion without BOM cost access.
    expect((await ctx.api.get('/api/finished-products/999999/price-suggestion').set(auth(stockOnly))).status).toBe(404);
  });

  it('splits the dashboards the same way', async () => {
    const stock = await ctx.api.get('/api/analytics/overview').set(auth(stockOnly));
    expect(stock.body).toHaveProperty('inventory');
    expect(stock.body).not.toHaveProperty('production');
    const prod = await ctx.api.get('/api/analytics/overview').set(auth(prodOnly));
    expect(prod.body).toHaveProperty('production');
    expect(prod.body).not.toHaveProperty('inventory');
  });

  it('keeps production screens separate from CSR and releasing stock reads', async () => {
    const { BUILTIN_ROLES } = await import('../src/shared/permissions');
    for (const r of BUILTIN_ROLES) {
      if (r.permissions.includes('inventory.view') && !['csr', 'releasing'].includes(r.key)) expect(r.permissions, r.key).toContain('production.view');
    }
    for (const key of ['csr', 'releasing']) expect(BUILTIN_ROLES.find((r) => r.key === key)?.permissions).not.toContain('production.view');
  });

  it('the upgrade gives it once to whoever could see inventory', async () => {
    const db = await import('../src/shared/db');
    db.run(`INSERT INTO roles (key, label, permissions) VALUES ('old_stock', 'Old Stock', ?)`, JSON.stringify(['inventory.view']));
    db.run("DELETE FROM settings WHERE key = 'migrated_production_view_split'");
    db.forceMigrate(db.DEFAULT_TENANT);
    const role = db.queryOne<{ permissions: string }>("SELECT permissions FROM roles WHERE key = 'old_stock'")!;
    expect(JSON.parse(role.permissions)).toEqual(['inventory.view', 'production.view']);

    // Taken away afterwards, it stays away on later upgrades.
    db.run(`UPDATE roles SET permissions = ? WHERE key = 'old_stock'`, JSON.stringify(['inventory.view']));
    db.forceMigrate(db.DEFAULT_TENANT);
    const after = db.queryOne<{ permissions: string }>("SELECT permissions FROM roles WHERE key = 'old_stock'")!;
    expect(JSON.parse(after.permissions)).toEqual(['inventory.view']);
  });
});
