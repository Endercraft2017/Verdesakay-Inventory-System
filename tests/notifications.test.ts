/** Stored notification history (shared/push.ts notifyUser → `notifications`; /api/notifications):
 *  a row per person whether or not they have push set up, the push opening the record — or,
 *  without a phone screen for it, that very notification — and read state that is the person's own. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';

let ctx: TestContext;
let token: string;
let sales: { id: number; token: string };
let releaser: { id: number; token: string };
let __sentPush: typeof import('../src/shared/push').__sentPush;
const H = () => ({ Authorization: `Bearer ${token}` });
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  ctx = await setupApp();
  token = await login(ctx.api);
  sales = await createEmployee(ctx.api, token, { role: 'csr' });
  releaser = await createEmployee(ctx.api, token, { role: 'releasing_clerk' });
  ({ __sentPush } = await import('../src/shared/push'));
  // Only Sales has a phone subscribed; admin keeps no push devices.
  await ctx.api.post('/api/push/subscribe').set(bearer(sales.token))
    .send({ endpoint: 'https://fcm.googleapis.com/sub/sales-n', keys: { p256dh: 'BAY'.padEnd(87, 'x'), auth: 'abc123def456' } }); // gitleaks:allow -- synthetic push fixture, not a credential
});
afterAll(() => cleanup(ctx));

async function reportOnNewOrder(): Promise<{ order: number; number: string }> {
  const item = (await ctx.api.post('/api/inventory').set(H()).send({ name: 'Notif item ' + Date.now(), quantity: 5 })).body.id;
  const o = (await ctx.api.post('/api/orders').set(H()).send({ type: 'sale', customer_name: 'ACME', status: 'approved', force: true,
    items: [{ name: 'Item', item_id: item, quantity: 1, unit_price: 10 }] })).body.id as number;
  const r = await ctx.api.post(`/api/release-slips/orders/${o}/reports`).set(bearer(releaser.token))
    .send({ kind: 'identity', description: 'Recipient name does not match' });
  expect(r.status).toBe(201);
  return { order: o, number: (await ctx.api.get(`/api/orders/${o}`).set(H())).body.number };
}

describe('notification history', () => {
  it('keeps a row for everyone notified, with or without push, and the push opens that notification', async () => {
    __sentPush.length = 0;
    const { order, number } = await reportOnNewOrder();
    const mine = (await ctx.api.get('/api/notifications').set(bearer(sales.token))).body;
    const row = mine.items.find((n: { title: string }) => n.title === `Release report — ${number}`);
    expect(row).toMatchObject({ body: 'Recipient name does not match', read_at: null, link: { route: 'orders', params: { id: order } } });
    expect(mine.unread).toBeGreaterThanOrEqual(1);
    // The release report has no phone screen for Sales: the push lands on the notification itself.
    const push = __sentPush.find((p) => p.userId === sales.id && p.payload.title === `Release report — ${number}`);
    expect(push?.payload.url).toBe(`#/notifications?id=${row.id}`);
    // The admin (orders.edit, no push device) still has it in their history.
    const admin = (await ctx.api.get('/api/notifications').set(H())).body;
    expect(admin.items.some((n: { title: string }) => n.title === `Release report — ${number}`)).toBe(true);
  });

  it('marks read per person, and nobody can mark another person\'s', async () => {
    const mine = (await ctx.api.get('/api/notifications').set(bearer(sales.token))).body;
    const id = mine.items[0].id as number;
    expect((await ctx.api.post(`/api/notifications/${id}/read`).set(bearer(releaser.token)).send({})).status).toBe(404);
    const r = await ctx.api.post(`/api/notifications/${id}/read`).set(bearer(sales.token)).send({});
    expect(r.status).toBe(200);
    expect(r.body.unread).toBe(mine.unread - 1);
    await reportOnNewOrder();
    expect((await ctx.api.get('/api/notifications/unread-count').set(bearer(sales.token))).body.count).toBeGreaterThan(0);
    await ctx.api.post('/api/notifications/read-all').set(bearer(sales.token)).send({});
    expect((await ctx.api.get('/api/notifications/unread-count').set(bearer(sales.token))).body.count).toBe(0);
  });

  it('leaves chat to the inbox', async () => {
    const before = (await ctx.api.get('/api/notifications').set(bearer(sales.token))).body.items.length;
    await ctx.api.post('/api/messages').set(H()).send({ recipient_id: sales.id, body: 'hello' });
    expect((await ctx.api.get('/api/notifications').set(bearer(sales.token))).body.items.length).toBe(before);
  });
});
