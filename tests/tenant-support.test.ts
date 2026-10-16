import bcrypt from 'bcryptjs';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { setupApp, cleanup, type TestContext } from './helpers';
let ctx: TestContext;
let owner: string, admin: string, other: string, employee: string;
const headers = (slug: string, token: string) => ({ 'X-Tenant': slug, Authorization: `Bearer ${token}` });
const op = () => ({ Authorization: `Bearer ${owner}` });
beforeAll(async () => {
  process.env.PLATFORM_CONSOLE = 'true';
  ctx = await setupApp();
  const { createTenant } = await import('../src/platform/provisioning');
  const { setTenantModules } = await import('../src/platform/platform');
  for (const slug of ['supportco', 'otherco']) {
    createTenant({ slug, name: slug, plan: 'complete', admin_username: 'owner', admin_password: 'ownerpass1' });
    setTenantModules(slug, []);
  }
  admin = (await ctx.api.post('/api/auth/login').set('X-Tenant', 'supportco').send({ username: 'owner', password: 'ownerpass1' })).body.token;
  other = (await ctx.api.post('/api/auth/login').set('X-Tenant', 'otherco').send({ username: 'owner', password: 'ownerpass1' })).body.token;
  const { withTenant, run } = await import('../src/shared/db');
  withTenant('supportco', () => run("INSERT INTO users(username,password_hash,full_name,role) VALUES(?,?,?,?)", 'staff', bcrypt.hashSync('staffpass1', 10), 'Staff', 'employee'));
  employee = (await ctx.api.post('/api/auth/login').set('X-Tenant', 'supportco').send({ username: 'staff', password: 'staffpass1' })).body.token;
  (await import('../src/platform/platform-users')).upsertPlatformUser('operator', 'ownerpass1');
  owner = (await ctx.api.post('/_platform/api/login').send({ username: 'operator', password: 'ownerpass1' })).body.token;
});
afterAll(() => { delete process.env.PLATFORM_CONSOLE; cleanup(ctx); });
describe('tenant admin support', () => {
  it('requires authenticated tenant administrators and validates report bodies', async () => {
    expect((await ctx.api.get('/api/support').set('X-Tenant', 'supportco')).status).toBe(401);
    expect((await ctx.api.get('/api/support').set(headers('supportco', employee))).status).toBe(403);
    expect((await ctx.api.post('/api/support').set(headers('supportco', admin)).send({ subject: 'Bug', description: '' })).status).toBe(400);
    expect((await ctx.api.post('/api/support').set(headers('supportco', admin)).send({ subject: 'Bug', description: 'Details', slug: 'otherco' })).status).toBe(400);
  });
  it('works without paid modules; owner receives tenant reports and both sides can reply', async () => {
    const report = { subject: '<script>bug</script>', description: 'Step 1: open screen. Expected save; got an error.', category: 'bug', priority: 'urgent' };
    const created = await ctx.api.post('/api/support').set(headers('supportco', admin)).send(report);
    expect(created.status).toBe(201);
    const id = created.body.id;
    const analytics = await ctx.api.get('/_platform/api/tenants/supportco/analytics').set(op());
    expect(analytics.body.support.find((t: { id: number }) => t.id === id)).toMatchObject({ ...report, source: 'tenant', status: 'open', by: 'owner' });
    expect((await ctx.api.get('/api/support').set(headers('otherco', other))).body).toEqual([]);
    expect((await ctx.api.post(`/api/support/${id}/replies`).set(headers('otherco', other)).send({ body: 'Cross tenant' })).status).toBe(404);
    expect((await ctx.api.post(`/_platform/api/tenants/otherco/support/${id}/replies`).set(op()).send({ body: 'Wrong tenant' })).status).toBe(404);
    expect((await ctx.api.post(`/_platform/api/tenants/supportco/support/${id}/replies`).set(op()).send({ body: 'We are investigating.' })).status).toBe(201);
    expect((await ctx.api.patch(`/_platform/api/tenants/supportco/support/${id}`).set(op()).send({ status: 'in_progress' })).status).toBe(200);
    expect((await ctx.api.post(`/api/support/${id}/replies`).set(headers('supportco', admin)).send({ body: 'Additional steps.' })).status).toBe(201);
    const tickets = (await ctx.api.get('/api/support').set(headers('supportco', admin))).body;
    expect(tickets[0].status).toBe('in_progress');
    expect(tickets[0].replies.map((r: {source: string}) => r.source)).toEqual(['owner', 'tenant']);
    // Owner-only legacy notes must never be exposed to tenant admins.
    await ctx.api.post('/_platform/api/tenants/supportco/support').set(op()).send({ subject: 'Internal investigation', status: 'open' });
    const ownerView = (await ctx.api.get('/_platform/api/tenants/supportco/analytics').set(op())).body.support;
    const internal = ownerView.find((t: {subject: string}) => t.subject === 'Internal investigation');
    expect((await ctx.api.get('/api/support').set(headers('supportco', admin))).body.some((t: {id: number}) => t.id === internal.id)).toBe(false);
    expect((await ctx.api.post(`/api/support/${internal.id}/replies`).set(headers('supportco', admin)).send({ body: 'Guessing a private id' })).status).toBe(404);
    expect((await ctx.api.patch(`/_platform/api/tenants/supportco/support/${id}`).set(op()).send({ status: 'resolved' })).status).toBe(200);
    expect((await ctx.api.get('/api/support').set(headers('supportco', admin))).body[0].status).toBe('resolved');
  });
});

it('allows past-due administrators to request billing help while business writes stay blocked', async () => {
  const { setTenantStatus } = await import('../src/platform/platform');
  setTenantStatus('supportco', 'past_due');
  try {
    expect((await ctx.api.post('/api/support').set(headers('supportco', admin)).send({ subject: 'Billing help', description: 'Please help restore our subscription.', category: 'issue' })).status).toBe(201);
    expect((await ctx.api.post('/api/inventory').set(headers('supportco', admin)).send({ name: 'Blocked' })).status).toBe(402);
  } finally { setTenantStatus('supportco', 'active'); }
});

it('submits a report from the tenant screen and renders ticket content as text', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { JSDOM } = await import('jsdom');
  const { vi } = await import('vitest');
  const dom = new JSDOM('<main id="view"></main>', { runScripts: 'outside-only' });
  const w = dom.window;
  let render!: (view: HTMLElement) => Promise<void>;
  const escape = (value: unknown) => { const e = w.document.createElement('span'); e.textContent = String(value); return e.innerHTML; };
  Object.assign(w, {
    App: { hasPermission: () => true, register: (_name: string, fn: typeof render) => { render = fn; } },
    UI: { esc: escape, toast: () => {} },
    API: {
      get: async (url: string) => (await ctx.api.get('/api' + url).set(headers('supportco', admin))).body,
      post: async (url: string, body: object) => {
        const response = await ctx.api.post('/api' + url).set(headers('supportco', admin)).send(body);
        if (response.status >= 400) throw new Error(response.body.error);
        return response.body;
      },
    },
  });
  try {
    w.eval(fs.readFileSync(path.join(import.meta.dirname, '../public/js/modules/core/support.js'), 'utf8'));
    const view = w.document.getElementById('view')!;
    await render(view);
    const form = view.querySelector<HTMLFormElement>('#support-form')!;
    (form.elements.namedItem('subject') as HTMLInputElement).value = 'UI bug submission';
    (form.elements.namedItem('description') as HTMLTextAreaElement).value = '<script>unsafe()</script>';
    form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(view.querySelector('#support-tickets')?.textContent).toContain('UI bug submission'));
    expect(view.querySelector('#support-tickets script')).toBeNull();
    expect(view.querySelector('#support-tickets')?.textContent).toContain('<script>unsafe()</script>');
    expect(view.querySelector('form[data-ticket]')).not.toBeNull();
  } finally { w.close(); }
});
