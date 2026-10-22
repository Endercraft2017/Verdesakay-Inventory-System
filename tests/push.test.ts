/** Web-push: subscription CRUD, the VAPID key endpoint, and the low-stock /
 *  new-message notification triggers. Sends are captured in `__sentPush` (test mode). */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';
// NOTE: `run`/`__sentPush` are imported dynamically inside beforeAll, after setupApp() sets
// DB_PATH — a top-level `import ... from '../src/shared/db'` (directly, or transitively via
// '../src/shared/push', which itself imports './db') would evaluate DB_PATH before it's set (real
// data.db, not the throwaway per-file one). See helpers.ts's own doc comment.
let run: typeof import('../src/shared/db').run;
let __sentPush: typeof import('../src/shared/push').__sentPush;

let ctx: TestContext;
let token: string;
const hdr = (t = token) => ({ Authorization: `Bearer ${t}` });

const fakeSub = (endpoint: string) => ({
  endpoint,
  keys: { p256dh: 'BAY'.padEnd(87, 'x'), auth: 'abc123def456' },
});

beforeAll(async () => {
  ctx = await setupApp();
  ({ run } = await import('../src/shared/db'));
  ({ __sentPush } = await import('../src/shared/push'));
  token = await login(ctx.api);
});
afterAll(() => cleanup(ctx));
beforeEach(() => { __sentPush.length = 0; run('DELETE FROM push_subscriptions'); });

describe('web push', () => {
  it('exposes a VAPID public key (stable across calls)', async () => {
    const a = await ctx.api.get('/api/push/key').set(hdr());
    const b = await ctx.api.get('/api/push/key').set(hdr());
    expect(a.status).toBe(200);
    expect(typeof a.body.key).toBe('string');
    expect(a.body.key.length).toBeGreaterThan(80);
    expect(b.body.key).toBe(a.body.key);
  });

  it('subscribes, upserts by endpoint, and unsubscribes', async () => {
    const ep = 'https://push.example.com/sub/aaa';
    expect((await ctx.api.post('/api/push/subscribe').set(hdr()).send(fakeSub(ep))).status).toBe(201);
    expect((await ctx.api.post('/api/push/subscribe').set(hdr()).send(fakeSub(ep))).status).toBe(201); // upsert
    expect((await ctx.api.get('/api/push/status').set(hdr())).body.subscriptions).toBe(1);

    expect((await ctx.api.post('/api/push/unsubscribe').set(hdr()).send({ endpoint: ep })).status).toBe(200);
    expect((await ctx.api.get('/api/push/status').set(hdr())).body.subscriptions).toBe(0);
  });

  it('rejects a malformed subscription', async () => {
    const res = await ctx.api.post('/api/push/subscribe').set(hdr()).send({ endpoint: 'not-a-url' });
    expect(res.status).toBe(400);
  });

  it('POST /test notifies the caller\'s own devices', async () => {
    await ctx.api.post('/api/push/subscribe').set(hdr()).send(fakeSub('https://push.example.com/sub/test'));
    const res = await ctx.api.post('/api/push/test').set(hdr());
    expect(res.status).toBe(200);
    expect(__sentPush.some((p) => p.endpoint === 'https://push.example.com/sub/test')).toBe(true);
  });

  it('fires a low-stock notification on the downward crossing only', async () => {
    // admin (holds inventory.adjust) has a device registered
    await ctx.api.post('/api/push/subscribe').set(hdr()).send(fakeSub('https://push.example.com/sub/admin'));
    const { body } = await ctx.api.post('/api/inventory').set(hdr())
      .send({ name: 'Reorder Widget', quantity: 15, min_quantity: 10 });

    __sentPush.length = 0;
    await ctx.api.post(`/api/inventory/${body.id}/adjust`).set(hdr()).send({ change: -8 }); // 15 -> 7, crosses
    expect(__sentPush.some((p) => /Low stock/.test(p.payload.title))).toBe(true);

    __sentPush.length = 0;
    await ctx.api.post(`/api/inventory/${body.id}/adjust`).set(hdr()).send({ change: -1 }); // 7 -> 6, already low
    expect(__sentPush.some((p) => /Low stock/.test(p.payload.title))).toBe(false);
  });

  it('notifies the recipient of a new message', async () => {
    const bob = await createEmployee(ctx.api, token, { role: 'warehouse' });
    await ctx.api.post('/api/push/subscribe').set(hdr(bob.token)).send(fakeSub('https://push.example.com/sub/bob'));

    __sentPush.length = 0;
    const res = await ctx.api.post('/api/messages').set(hdr()).send({ recipient_id: bob.id, subject: 'Hi', body: 'check bay 3' });
    expect(res.status).toBe(201);
    expect(__sentPush.some((p) => p.userId === bob.id && /Hi/.test(p.payload.title))).toBe(true);
  });

  it('notifies authorized release and kit desks once when work becomes actionable', async () => {
    const releaser = await createEmployee(ctx.api, token, { role: 'releasing_clerk' });
    const warehouse = await createEmployee(ctx.api, token, { role: 'warehouse' });
    const unrelated = await createEmployee(ctx.api, token, { role: 'hr' });
    for (const [worker, name] of [[releaser, 'release'], [warehouse, 'warehouse'], [unrelated, 'hr']] as const) {
      await ctx.api.post('/api/push/subscribe').set(hdr(worker.token)).send(fakeSub(`https://push.example.com/sub/${name}`));
    }
    const stock = await ctx.api.post('/api/inventory').set(hdr()).send({ name: 'Push test stock', quantity: 2 });
    const sale = await ctx.api.post('/api/orders').set(hdr()).send({ type: 'sale', items: [{ item_id: stock.body.id, name: 'Push test stock', quantity: 1, unit_price: 10 }] });
    expect(sale.status).toBe(201);
    expect((await ctx.api.post(`/api/orders/${sale.body.id}/status`).set(hdr()).send({ status: 'approved' })).status).toBe(200);
    expect(__sentPush.some((push) => push.userId === releaser.id && push.payload.url === `#/so?id=${sale.body.id}`)).toBe(true);
    expect(__sentPush.some((push) => push.userId === unrelated.id && push.payload.url === `#/so?id=${sale.body.id}`)).toBe(false);
    const releaseNotices = __sentPush.filter((push) => push.userId === releaser.id && push.payload.url === `#/so?id=${sale.body.id}`).length;
    expect((await ctx.api.post(`/api/orders/${sale.body.id}/status`).set(hdr()).send({ status: 'approved' })).status).toBe(200);
    expect(__sentPush.filter((push) => push.userId === releaser.id && push.payload.url === `#/so?id=${sale.body.id}`).length).toBe(releaseNotices);

    const product = await ctx.api.post('/api/inventory').set(hdr()).send({ name: 'Push test product', quantity: 0 });
    await ctx.api.put(`/api/finished-products/${product.body.id}`).set(hdr()).send({ components: [] });
    const job = await ctx.api.post('/api/job-orders').set(hdr()).send({ product_item_id: product.body.id, qty_ordered: 1 });
    expect(job.status).toBe(201);
    expect((await ctx.api.post(`/api/job-orders/${job.body.id}/approve`).set(hdr()).send({})).status).toBe(200);
    expect(__sentPush.some((push) => push.userId === warehouse.id && push.payload.url === `#/kit-release?id=${job.body.id}`)).toBe(true);
    expect(__sentPush.some((push) => push.userId === unrelated.id && push.payload.url === `#/kit-release?id=${job.body.id}`)).toBe(false);
  });
});
