/** SaaS phase 6: plan quotas at the create endpoints + trial/past-due read-only gating.
    The `default` tenant is unlimited and never gated. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, type TestContext } from './helpers';

let ctx: TestContext;
let token: string;
let provisioning: typeof import('../src/platform/provisioning');
let platform: typeof import('../src/platform/platform');
const authHdr = () => ({ Authorization: `Bearer ${token}` });
const asTenant = (slug: string) => ({ 'X-Tenant': slug });

beforeAll(async () => {
  ctx = await setupApp();
  token = await login(ctx.api);
  provisioning = await import('../src/platform/provisioning');
  platform = await import('../src/platform/platform');
});
afterAll(() => cleanup(ctx));

describe('the default tenant is unlimited', () => {
  it('GET /api/tenant reports plan "unlimited" and no read-only', async () => {
    const r = await ctx.api.get('/api/tenant').set(authHdr());
    expect(r.status).toBe(200);
    expect(r.body.plan).toBe('unlimited');
    expect(r.body.read_only).toBe(false);
    expect(r.body.usage).toBeTruthy(); // admin sees usage
  });
});

describe('plan quotas on a named tenant', () => {
  let tkn: string;
  beforeAll(async () => {
    // 'trial' plan → users cap 5. The seeded admin is user #1.
    provisioning.createTenant({ slug: 'capco', name: 'Cap Co', admin_username: 'owner', admin_password: 'ownerpass1', plan: 'trial' });
    const r = await ctx.api.post('/api/auth/login').set(asTenant('capco')).send({ username: 'owner', password: 'ownerpass1' });
    tkn = r.body.token;
  });

  it('blocks the 6th user with a 402', async () => {
    const mk = (n: number) => ctx.api.post('/api/users').set(asTenant('capco')).set('Authorization', `Bearer ${tkn}`)
      .send({ username: `capuser${n}`, full_name: `Cap User ${n}`, password: 'secret1' });
    for (let i = 2; i <= 5; i++) expect((await mk(i)).status).toBe(201); // 1 (admin) + 4 = 5
    const sixth = await mk(6);
    expect(sixth.status).toBe(402);
    expect(sixth.body.error).toMatch(/limit/i);
  });

  it('GET /api/tenant shows the plan limits + usage', async () => {
    const r = await ctx.api.get('/api/tenant').set(asTenant('capco')).set('Authorization', `Bearer ${tkn}`);
    expect(r.body.plan).toBe('trial');
    expect(r.body.limits.users).toBe(5);
    expect(r.body.usage.users).toBe(5);
  });
});

describe('lapsed trial → read-only', () => {
  let tkn: string;
  beforeAll(async () => {
    provisioning.createTenant({ slug: 'lapsed', name: 'Lapsed Co', admin_username: 'owner', admin_password: 'ownerpass1', plan: 'trial' });
    platform.setTenantStatus('lapsed', 'trial');
    platform.setTrialEndsAt('lapsed', new Date(Date.now() - 86_400_000).toISOString()); // yesterday
    const r = await ctx.api.post('/api/auth/login').set(asTenant('lapsed')).send({ username: 'owner', password: 'ownerpass1' });
    tkn = r.body.token;
  });

  it('allows reads and auth, blocks writes with 402', async () => {
    expect((await ctx.api.get('/api/inventory').set(asTenant('lapsed')).set('Authorization', `Bearer ${tkn}`)).status).toBe(200);
    const w = await ctx.api.post('/api/inventory').set(asTenant('lapsed')).set('Authorization', `Bearer ${tkn}`)
      .send({ name: 'Nope', quantity: 1 });
    expect(w.status).toBe(402);

    const t = await ctx.api.get('/api/tenant').set(asTenant('lapsed')).set('Authorization', `Bearer ${tkn}`);
    expect(t.body.status).toBe('past_due');
    expect(t.body.read_only).toBe(true);
  });
});
