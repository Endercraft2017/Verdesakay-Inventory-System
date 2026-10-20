/** SaaS feature-module entitlements (src/modules.ts): plan-bundle defaults + a per-tenant
    override, enforced by requireModule() at the route mounts and surfaced on /api/tenant
    and the auth payloads. The `default` tenant has every module and is never gated. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, type TestContext } from './helpers';

let ctx: TestContext;
let token: string;
let provisioning: typeof import('../src/platform/provisioning');
let platform: typeof import('../src/platform/platform');
let mod: typeof import('../src/shared/modules'); // dynamic — after setupApp sets the env (see helpers.ts)
const authHdr = () => ({ Authorization: `Bearer ${token}` });
const asTenant = (slug: string) => ({ 'X-Tenant': slug });

beforeAll(async () => {
  ctx = await setupApp();
  token = await login(ctx.api);
  provisioning = await import('../src/platform/provisioning');
  platform = await import('../src/platform/platform');
  mod = await import('../src/shared/modules');
});
afterAll(() => cleanup(ctx));

describe('module resolver (unit)', () => {
  it('withDeps unions in dependencies, in canonical order', () => {
    expect(mod.withDeps(['manufacturing'])).toEqual(['inventory', 'manufacturing']);
    expect(mod.withDeps(['sales'])).toEqual(['inventory', 'sales']);
    expect(mod.withDeps(['purchasing'])).toEqual(['inventory', 'purchasing']);
    expect(mod.withDeps(['hr'])).toEqual(['hr']);
    expect(mod.withDeps(['nonsense', 'hr'])).toEqual(['hr']);
  });

  it('validateModuleList rejects unknown names and missing dependencies', () => {
    expect(() => mod.validateModuleList(['inventory', 'wat'])).toThrow(/unknown/i);
    expect(() => mod.validateModuleList(['manufacturing'])).toThrow(/requires "inventory"/);
    expect(mod.validateModuleList(['manufacturing', 'inventory'])).toEqual(['inventory', 'manufacturing']);
  });

  it('the default tenant has every module', () => {
    expect([...mod.enabledModules('default')].sort()).toEqual([...mod.MODULES].sort());
  });
});

describe('the default tenant is never gated', () => {
  it('GET /api/tenant + /api/auth/me expose the full module list', async () => {
    const t = await ctx.api.get('/api/tenant').set(authHdr());
    expect(t.body.modules).toEqual([...mod.MODULES]);
    const me = await ctx.api.get('/api/auth/me').set(authHdr());
    expect(me.body.user.modules).toEqual([...mod.MODULES]);
  });

  it('reaches HR / AI / accounting routes (no 402)', async () => {
    for (const p of ['/api/hr/employees', '/api/ai/messages', '/api/accounting/bir-1601c']) {
      expect((await ctx.api.get(p).set(authHdr())).status).not.toBe(402);
    }
  });
});

describe('plan bundle gates whole feature areas', () => {
  let tkn: string;
  beforeAll(async () => {
    // starter bundle includes Sales as its own entitlement, backed by Inventory stock.
    provisioning.createTenant({ slug: 'starterco', name: 'Starter Co', admin_username: 'owner', admin_password: 'ownerpass1', plan: 'starter' });
    const r = await ctx.api.post('/api/auth/login').set(asTenant('starterco')).send({ username: 'owner', password: 'ownerpass1' });
    tkn = r.body.token;
  });
  const hdr = () => ({ ...asTenant('starterco'), Authorization: `Bearer ${tkn}` });

  it('GET /api/tenant reports just the starter modules', async () => {
    const r = await ctx.api.get('/api/tenant').set(hdr());
    expect(r.body.modules).toEqual(['inventory', 'sales', 'purchasing', 'mobile']);
  });

  it('login + /api/auth/me carry the same list', async () => {
    const me = await ctx.api.get('/api/auth/me').set(hdr());
    expect(me.body.user.modules).toEqual(['inventory', 'sales', 'purchasing', 'mobile']);
  });

  it('allows an enabled area (inventory) and 402s a disabled one (hr / accounting / ai / manufacturing)', async () => {
    expect((await ctx.api.get('/api/inventory').set(hdr())).status).toBe(200);
    for (const p of ['/api/hr/employees', '/api/accounting/bir-1601c', '/api/ai/messages', '/api/job-orders']) {
      const r = await ctx.api.get(p).set(hdr());
      expect(r.status).toBe(402);
      expect(r.body.error).toMatch(/not enabled/i);
    }
  });

  it('the mobile app HTML is served (mobile is in the bundle)', async () => {
    const r = await ctx.api.get('/m').set(asTenant('starterco'));
    expect(r.status).toBe(200);
    expect(r.text).not.toMatch(/isn't enabled/i);
  });
});

describe('per-tenant override wins over the plan bundle', () => {
  let tkn: string;
  const hdr = () => ({ ...asTenant('modco'), Authorization: `Bearer ${tkn}` });
  beforeAll(async () => {
    provisioning.createTenant({ slug: 'modco', name: 'Mod Co', admin_username: 'owner', admin_password: 'ownerpass1', plan: 'complete' });
    const r = await ctx.api.post('/api/auth/login').set(asTenant('modco')).send({ username: 'owner', password: 'ownerpass1' });
    tkn = r.body.token;
  });

  it('"only HR" — everything else 402s', async () => {
    platform.setTenantModules('modco', ['hr']);
    const t = await ctx.api.get('/api/tenant').set(hdr());
    expect(t.body.modules).toEqual(['hr']);
    expect((await ctx.api.get('/api/hr/employees').set(hdr())).status).toBe(200);
    expect((await ctx.api.get('/api/inventory').set(hdr())).status).toBe(402);
    expect((await ctx.api.get('/api/ai/messages').set(hdr())).status).toBe(402);
  });

  it('manufacturing pulls inventory in as a dependency', async () => {
    platform.setTenantModules('modco', ['manufacturing']);
    const t = await ctx.api.get('/api/tenant').set(hdr());
    expect(t.body.modules).toEqual(['inventory', 'manufacturing']);
    expect((await ctx.api.get('/api/inventory').set(hdr())).status).toBe(200);
    expect((await ctx.api.get('/api/job-orders').set(hdr())).status).toBe(200);
    expect((await ctx.api.get('/api/hr/employees').set(hdr())).status).toBe(402);
  });

  it('mobile off → /m serves the "not enabled" notice, not the app', async () => {
    platform.setTenantModules('modco', ['inventory']);
    const r = await ctx.api.get('/m').set(asTenant('modco'));
    expect(r.status).toBe(200);
    expect(r.text).toMatch(/isn't enabled/i);
  });

  it('clearing the override falls back to the plan bundle', async () => {
    platform.setTenantModules('modco', null);
    const t = await ctx.api.get('/api/tenant').set(hdr());
    expect(t.body.modules).toEqual([...mod.MODULES]); // complete = everything
  });
});

describe('module isolation and downgrade safety', () => {
  let tkn: string;
  const hdr = () => ({ 'X-Tenant': 'isolationco', Authorization: `Bearer ${tkn}` });
  beforeAll(async () => {
    provisioning.createTenant({ slug: 'isolationco', name: 'Isolation', plan: 'complete', admin_username: 'owner', admin_password: 'ownerpass1' });
    tkn = (await ctx.api.post('/api/auth/login').set('X-Tenant', 'isolationco').send({ username: 'owner', password: 'ownerpass1' })).body.token;
  });
  it('each module configuration keeps core login and reporting available, with disabled areas blocked', async () => {
    const routes = { inventory: '/api/inventory', sales: '/api/customers', manufacturing: '/api/job-orders', purchasing: '/api/purchasing/goods-receipts', hr: '/api/hr/employees', accounting: '/api/accounting/bir-1601c', ai: '/api/ai/messages', email: '/api/mail/status', quickbooks: '/api/quickbooks/status' };
    for (const selected of [[], ...mod.MODULES.map(m => [m]), ...mod.MODULES.map(disabled => mod.MODULES.filter(m => m !== disabled))]) {
      platform.setTenantModules('isolationco', selected);
      const enabled = mod.enabledModules('isolationco');
      expect((await ctx.api.get('/api/auth/me').set(hdr())).status).toBe(200);
      const overview = await ctx.api.get('/api/analytics/overview').set(hdr());
      expect(overview.status).toBe(200);
      for (const [section, module] of Object.entries({ inventory: 'inventory', production: 'manufacturing', purchasing: 'purchasing', sales: 'sales', payroll: 'hr' })) {
        expect(Object.hasOwn(overview.body, section)).toBe(enabled.has(module as typeof mod.MODULES[number]));
      }
      for (const [module, route] of Object.entries(routes)) {
        const r = await ctx.api.get(route).set(hdr());
        if (!enabled.has(module as typeof mod.MODULES[number])) expect(r.status, module).toBe(402);
        else { expect(r.status, module).not.toBe(402); expect(r.status, module).toBeLessThan(500); }
      }
    }
  });
  it('shared inventory order actions cannot create disabled-module records', async () => {
    platform.setTenantModules('isolationco', ['inventory']);
    expect((await ctx.api.get('/api/orders?type=sale').set(hdr())).status).toBe(403);
    expect((await ctx.api.get('/api/customers').set(hdr())).status).toBe(402);
    expect((await ctx.api.get('/api/release-slips/queue').set(hdr())).status).toBe(402);
    expect((await ctx.api.post('/api/orders/1/accept-release').set(hdr()).send({})).status).toBe(402);
    expect((await ctx.api.post('/api/orders/1/status').set(hdr()).send({ status: 'approved' })).status).toBe(402);
    expect((await ctx.api.post('/api/orders/1/produce-shortfall').set(hdr()).send({})).status).toBe(402);
    expect((await ctx.api.post('/api/orders/1/purchase-shortfall').set(hdr()).send({})).status).toBe(402);
    expect((await ctx.api.post('/api/orders').set(hdr()).send({ type: 'purchase', items: [{ name: 'Paper', quantity: 1, unit_price: 10 }] })).status).toBe(403);
  });
  it('Sales can be enabled independently of Purchasing and Manufacturing', async () => {
    platform.setTenantModules('isolationco', ['inventory', 'sales']);
    expect((await ctx.api.get('/api/customers').set(hdr())).status).toBe(200);
    expect((await ctx.api.get('/api/orders?type=sale').set(hdr())).status).toBe(200);
    expect((await ctx.api.get('/api/orders?type=purchase').set(hdr())).status).toBe(403);
  });
  it('AI cannot call disabled-module tools even when the admin has all permissions', async () => {
    const { withTenant } = await import('../src/shared/db');
    const { getToolsForUser, executeTool } = await import('../src/modules/ai/ai-tools');
    platform.setTenantModules('isolationco', ['ai']);
    const user = (await ctx.api.get('/api/auth/me').set(hdr())).body.user;
    await withTenant('isolationco', async () => {
      const names = getToolsForUser(user).map(t => t.function.name);
      expect(names).not.toContain('search_inventory');
      expect(names).not.toContain('send_email');
      expect(names).toContain('get_notes');
      expect((await executeTool('search_inventory', {}, user)).success).toBe(false);
      expect((await executeTool('send_email', {}, user)).success).toBe(false);
    });
  });
  it('disabling inventory preserves its records and re-enabling restores access', async () => {
    const { withTenant, run, queryOne } = await import('../src/shared/db');
    withTenant('isolationco', () => run("INSERT INTO inventory_items(name,sku,unit) VALUES(?,?,?)", 'Preserved item', 'PRESERVE', 'pcs'));
    platform.setTenantModules('isolationco', []);
    expect((await ctx.api.get('/api/inventory').set(hdr())).status).toBe(402);
    expect(withTenant('isolationco', () => queryOne<{ name: string }>('SELECT name FROM inventory_items WHERE sku=?', 'PRESERVE')?.name)).toBe('Preserved item');
    platform.setTenantModules('isolationco', ['inventory']);
    expect((await ctx.api.get('/api/inventory').set(hdr())).body.some((i: {sku: string}) => i.sku === 'PRESERVE')).toBe(true);
  });
});
