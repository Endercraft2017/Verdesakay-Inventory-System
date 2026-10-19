import bcrypt from 'bcryptjs';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
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
    createTenant({ slug, name: slug, plan: 'complete', admin_username: 'owner', admin_password: 'ownerpass1-test-only' });
    setTenantModules(slug, []);
  }
  admin = (await ctx.api.post('/api/auth/login').set('X-Tenant', 'supportco').send({ username: 'owner', password: 'ownerpass1-test-only' })).body.token;
  other = (await ctx.api.post('/api/auth/login').set('X-Tenant', 'otherco').send({ username: 'owner', password: 'ownerpass1-test-only' })).body.token;
  const { withTenant, run } = await import('../src/shared/db');
  withTenant('supportco', () => run("INSERT INTO users(username,password_hash,full_name,role) VALUES(?,?,?,?)", 'staff', bcrypt.hashSync('staffpass1-test-only', 10), 'Staff', 'employee'));
  employee = (await ctx.api.post('/api/auth/login').set('X-Tenant', 'supportco').send({ username: 'staff', password: 'staffpass1-test-only' })).body.token;
  (await import('../src/platform/platform-users')).upsertPlatformUser('operator', 'ownerpass1-test-only');
  owner = (await ctx.api.post('/_platform/api/login').send({ username: 'operator', password: 'ownerpass1-test-only' })).body.token;
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


describe('support and owner-details error boundaries', () => {
  it.each([
    ['tenant create', 'tenant_support', 'INSERT'],
    ['owner create', 'tenant_support', 'INSERT'],
    ['tenant reply', 'tenant_support_replies', 'INSERT'],
    ['owner reply', 'tenant_support_replies', 'INSERT'],
    ['owner update', 'tenant_support', 'UPDATE'],
    ['owner details', 'tenant_owner_details', 'INSERT'],
  ])('hides storage failures for %s and preserves stored records', async (operation, table, mutation) => {
    const { platformDb } = await import('../src/platform/platform');
    const { addSupport, listSupport } = await import('../src/platform/owner-analytics');
    const id = addSupport('supportco', { subject: 'Fault-test ticket', description: 'Keep original' }, 'owner', 'tenant');
    listSupport('supportco'); // Complete lazy schema setup before fault injection.
    const database = platformDb();
    const before = database.prepare(`SELECT * FROM ${table}`).all();
    const marker = 'synthetic-private-storage-path-and-query';
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    database.exec(`CREATE TRIGGER support_error_probe BEFORE ${mutation} ON ${table} BEGIN SELECT RAISE(ABORT, '${marker}'); END`);
    try {
      const tenantHeaders = headers('supportco', admin);
      const prefix = '/_platform/api/tenants/supportco';
      const response = operation === 'tenant create'
        ? await ctx.api.post('/api/support').set(tenantHeaders).send({ subject: 'New', description: 'New report' })
        : operation === 'owner create'
        ? await ctx.api.post(prefix + '/support').set(op()).send({ subject: 'New', status: 'open' })
        : operation === 'tenant reply'
        ? await ctx.api.post(`/api/support/${id}/replies`).set(tenantHeaders).send({ body: 'New reply' })
        : operation === 'owner reply'
        ? await ctx.api.post(prefix + `/support/${id}/replies`).set(op()).send({ body: 'New reply' })
        : operation === 'owner update'
        ? await ctx.api.patch(prefix + `/support/${id}`).set(op()).send({ status: 'resolved' })
        : await ctx.api.put(prefix + '/owner-details').set(op()).send({ notes: 'New private notes' });
      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Internal server error', request_id: response.headers['x-request-id'] });
      expect(response.body.request_id).toBeTruthy();
      expect(JSON.stringify([...log.mock.calls, ...errorLog.mock.calls])).not.toContain(marker);
      expect(JSON.stringify(log.mock.calls)).toContain(response.body.request_id);
      expect(database.prepare(`SELECT * FROM ${table}`).all()).toEqual(before);
    } finally {
      database.exec('DROP TRIGGER support_error_probe');
      log.mockRestore(); errorLog.mockRestore();
    }
  });

  it.each([
    ['tenant create', 'post', '/api/support', { subject: '', description: 'Details' }, 'subject'],
    ['tenant reply', 'post', '/api/support/1/replies', { body: '' }, 'body'],
    ['owner create', 'post', '/_platform/api/tenants/supportco/support', { subject: '', status: 'open' }, 'subject'],
    ['owner reply', 'post', '/_platform/api/tenants/supportco/support/1/replies', { body: '' }, 'body'],
    ['owner update', 'patch', '/_platform/api/tenants/supportco/support/1', { status: 'invalid' }, 'status'],
    ['owner details', 'put', '/_platform/api/tenants/supportco/owner-details', { contact_email: 'invalid' }, 'contact_email'],
  ] as const)('retains useful validation for %s without a serialized schema exception', async (operation, method, path, body, field) => {
    const response = await ctx.api[method](path).set(operation.startsWith('tenant') ? headers('supportco', admin) : op()).send(body);
    expect(response.status).toBe(400);
    expect(response.body.error).toContain(field + ':');
    expect(response.body.error).not.toContain('"code"');
    expect(response.body.request_id).toBe(response.headers['x-request-id']);
    expect(response.body.request_id).toBeTruthy();
  });
});


it.each(['not-a-number', '0', '-1', '1.5', '9007199254740992'])('rejects invalid ticket identity %s before database access', async id => {
  const prefix = '/_platform/api/tenants/supportco/support/';
  const requests = [
    ctx.api.post(`/api/support/${id}/replies`).set(headers('supportco', admin)).send({ body: 'Reply' }),
    ctx.api.post(prefix + id + '/replies').set(op()).send({ body: 'Reply' }),
    ctx.api.patch(prefix + id).set(op()).send({ status: 'resolved' }),
  ];
  for (const request of requests) {
    const response = await request;
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/id:|Invalid resource identifier/);
    expect(response.headers['x-request-id']).toBeTruthy();
    if (id === 'not-a-number') expect(response.body.request_id).toBe(response.headers['x-request-id']);
  }
});
