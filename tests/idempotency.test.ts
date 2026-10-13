/** Idempotency-Key middleware: a retried mutating request is de-duplicated. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, type TestContext } from './helpers';

let ctx: TestContext;
let token: string;
const hdr = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  ctx = await setupApp();
  token = await login(ctx.api);
});
afterAll(() => cleanup(ctx));

async function makeItem(qty: number) {
  const r = await ctx.api.post('/api/inventory').set(hdr()).send({ name: 'Idem ' + Math.random(), quantity: qty });
  return r.body.id as number;
}

describe('idempotency', () => {
  it('replays the first response and applies the change only once', async () => {
    const id = await makeItem(100);
    const key = 'idem-test-key-0001';

    const first = await ctx.api.post(`/api/inventory/${id}/adjust`).set(hdr()).set('Idempotency-Key', key).send({ change: -10 });
    expect(first.status).toBe(200);
    expect(first.body.quantity).toBe(90);
    expect(first.headers['idempotency-replayed']).toBeUndefined();

    const retry = await ctx.api.post(`/api/inventory/${id}/adjust`).set(hdr()).set('Idempotency-Key', key).send({ change: -10 });
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual(first.body); // same response verbatim
    expect(retry.headers['idempotency-replayed']).toBe('true');

    const detail = await ctx.api.get(`/api/inventory/${id}`).set(hdr());
    expect(detail.body.quantity).toBe(90); // only one -10 applied
    expect(detail.body.history.filter((h: { change: number }) => h.change === -10)).toHaveLength(1);
  });

  it('a different key applies again', async () => {
    const id = await makeItem(50);
    await ctx.api.post(`/api/inventory/${id}/adjust`).set(hdr()).set('Idempotency-Key', 'idem-k-a').send({ change: -5 });
    await ctx.api.post(`/api/inventory/${id}/adjust`).set(hdr()).set('Idempotency-Key', 'idem-k-b').send({ change: -5 });
    const detail = await ctx.api.get(`/api/inventory/${id}`).set(hdr());
    expect(detail.body.quantity).toBe(40);
  });

  it('replays a deterministic 4xx too', async () => {
    const id = await makeItem(3);
    const key = 'idem-overdraw-1';
    const a = await ctx.api.post(`/api/inventory/${id}/adjust`).set(hdr()).set('Idempotency-Key', key).send({ change: -99 });
    expect(a.status).toBe(400);
    const b = await ctx.api.post(`/api/inventory/${id}/adjust`).set(hdr()).set('Idempotency-Key', key).send({ change: -99 });
    expect(b.status).toBe(400);
    expect(b.headers['idempotency-replayed']).toBe('true');
    expect(b.body).toEqual(a.body);
  });

  it('rejects a malformed key', async () => {
    const id = await makeItem(10);
    const res = await ctx.api.post(`/api/inventory/${id}/adjust`).set(hdr()).set('Idempotency-Key', 'short').send({ change: -1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Idempotency-Key/);
  });

  it('is a no-op when no key is sent', async () => {
    const id = await makeItem(20);
    await ctx.api.post(`/api/inventory/${id}/adjust`).set(hdr()).send({ change: -2 });
    await ctx.api.post(`/api/inventory/${id}/adjust`).set(hdr()).send({ change: -2 });
    const detail = await ctx.api.get(`/api/inventory/${id}`).set(hdr());
    expect(detail.body.quantity).toBe(16);
  });
  it('never serves a cached private response without authentication', async () => {
    const id = await makeItem(20);
    const key = 'idem-private-0001';
    await ctx.api.post(`/api/inventory/${id}/adjust`).set(hdr()).set('Idempotency-Key', key).send({ change: -2 });
    const res = await ctx.api.post(`/api/inventory/${id}/adjust`).set('Idempotency-Key', key).send({ change: -2 });
    expect(res.status).toBe(401);
    expect(res.headers['idempotency-replayed']).toBeUndefined();
  });
  it('does not reuse a key for a different resource', async () => {
    const first = await makeItem(20), second = await makeItem(20);
    const key = 'idem-resource-0001';
    await ctx.api.post(`/api/inventory/${first}/adjust`).set(hdr()).set('Idempotency-Key', key).send({ change: -2 });
    expect((await ctx.api.post(`/api/inventory/${second}/adjust`).set(hdr()).set('Idempotency-Key', key).send({ change: -2 })).status).toBe(409);
    expect((await ctx.api.get(`/api/inventory/${second}`).set(hdr())).body.quantity).toBe(20);
  });
});
