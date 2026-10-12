/** Website "Talk to us" inquiries (docs/SAAS-READINESS.md §12): the public form stores a lead in
    platform.db, the owner works it in the console and creates the workspace from it — optionally
    locked until the first payment. The site shows the owner's contact details beside the form. */
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { setupApp, cleanup, type TestContext } from './helpers';

let ctx: TestContext;
const host = 'otom.afkcube.com';
let op = '';
const opHdr = () => ({ Authorization: `Bearer ${op}`, Host: host });
const form = (extra: Record<string, unknown> = {}) => ({
  name: 'Maria Santos', company: 'Santos Metalworks', email: 'Maria@Santos.test', phone: '0917 123 4567',
  employees: '51-100', modules: ['hr', 'inventory'], message: 'We have 2 branches.', ...extra,
});

beforeAll(async () => {
  process.env.TENANT_PATH_HOST = host;
  process.env.PLATFORM_CONSOLE = 'true';
  process.env.PLATFORM_HOST = host;
  ctx = await setupApp();
  const users = await import('../src/platform/platform-users');
  users.upsertPlatformUser('boss', 'bosspass1', 'Owner');
  op = (await ctx.api.post('/_platform/api/login').set('Host', host).send({ username: 'boss', password: 'bosspass1' })).body.token;
});
afterAll(() => {
  for (const key of ['TENANT_PATH_HOST', 'PLATFORM_CONSOLE', 'PLATFORM_HOST']) delete process.env[key];
  cleanup(ctx);
});

describe('the website form', () => {
  it('serves the Talk to us page and stores a valid inquiry', async () => {
    const page = await ctx.api.get('/contact').set('Host', host);
    expect(page.status).toBe(200);
    expect(page.text).toContain('Talk to us');
    const r = await ctx.api.post('/site/inquiry').set('Host', host).send(form());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const list = (await ctx.api.get('/_platform/api/inquiries').set(opHdr())).body;
    expect(list.new_count).toBe(1);
    expect(list.inquiries[0]).toMatchObject({ company: 'Santos Metalworks', email: 'maria@santos.test', employees: '51-100', modules: ['hr', 'inventory'], status: 'new' });
  });

  it('rejects bad input and quietly drops bots', async () => {
    for (const extra of [{ name: '' }, { email: 'nope' }, { phone: 'call me' }, { modules: ['teleport'] }, { employees: '9000' }, { message: 'x'.repeat(2001) }]) {
      expect((await ctx.api.post('/site/inquiry').set('Host', host).send(form(extra))).status).toBe(400);
    }
    const bot = await ctx.api.post('/site/inquiry').set('Host', host).send(form({ website: 'http://spam.test' }));
    expect(bot.status).toBe(201);
    expect((await ctx.api.get('/_platform/api/inquiries').set(opHdr())).body.inquiries).toHaveLength(1);
  });

  it('only the public site host takes inquiries', async () => {
    expect((await ctx.api.post('/site/inquiry').set('Host', 'other.example.test').send(form())).status).toBe(404);
  });

  it('shows the owner’s contact details once set', async () => {
    expect((await ctx.api.get('/site/config').set('Host', host)).body.contact).toEqual({ email: '', phone: '', messenger: '' });
    expect((await ctx.api.put('/_platform/api/site/contact').set(opHdr()).send({ email: 'bad' })).status).toBe(400);
    expect((await ctx.api.put('/_platform/api/site/contact').set(opHdr()).send({ messenger: 'http://evil.test' })).status).toBe(400);
    const ok = await ctx.api.put('/_platform/api/site/contact').set(opHdr()).send({ email: 'sales@otom.test', phone: '0917 555 0000', messenger: 'https://m.me/otom' });
    expect(ok.status).toBe(200);
    expect((await ctx.api.get('/site/config').set('Host', host)).body.contact).toEqual({ email: 'sales@otom.test', phone: '0917 555 0000', messenger: 'https://m.me/otom' });
  });
});

describe('the console', () => {
  it('needs an operator', async () => {
    expect((await ctx.api.get('/_platform/api/inquiries').set('Host', host)).status).toBe(401);
  });

  it('tracks status and notes, and creates a linked workspace, locked until paid when asked', async () => {
    const id = (await ctx.api.get('/_platform/api/inquiries').set(opHdr())).body.inquiries[0].id;
    expect((await ctx.api.patch(`/_platform/api/inquiries/${id}`).set(opHdr()).send({ status: 'hot' })).status).toBe(400);
    const p = await ctx.api.patch(`/_platform/api/inquiries/${id}`).set(opHdr()).send({ status: 'contacted', notes: 'Demo on Monday' });
    expect(p.body).toMatchObject({ status: 'contacted', notes: 'Demo on Monday' });

    const t = await ctx.api.post('/_platform/api/tenants').set(opHdr()).send({
      name: 'Santos Metalworks', slug: 'santos', admin_username: 'owner', admin_password: 'secret123',
      admin_email: 'maria@santos.test', awaiting_payment: true, inquiry_id: id,
    });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    expect(t.body.awaiting_payment).toBe(true);
    const linked = (await ctx.api.get('/_platform/api/inquiries').set(opHdr())).body.inquiries.find((i: { id: number }) => i.id === id);
    expect(linked.tenant_slug).toBe('santos');

    // locked: sign-in works, the rest waits for the first payment
    const login = await ctx.api.post('/santos/api/auth/login').set('Host', host).send({ username: 'owner', password: 'secret123' });
    const h = { Host: host, Authorization: `Bearer ${login.body.token}` };
    expect((await ctx.api.get('/santos/api/users').set(h)).status).toBe(402);
  });

  it('a workspace created without the lock is usable straight away', async () => {
    const t = await ctx.api.post('/_platform/api/tenants').set(opHdr()).send({
      name: 'Open Co', slug: 'openco', admin_username: 'owner', admin_password: 'secret123', admin_email: 'o@open.test',
    });
    expect(t.body.awaiting_payment).toBe(false);
  });
});
