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

it('never replays a protected response to an anonymous or different caller', async () => {
  const id = await makeItem(100);
  const key = 'private-replay-key';
  const path = `/api/inventory/${id}/adjust`;
  const first = await ctx.api.post(path).set(hdr()).set('Idempotency-Key', key).send({ change: -1 });
  expect(first.status).toBe(200);
  const anonymous = await ctx.api.post(path).set('Idempotency-Key', key).send({ change: -1 });
  expect(anonymous.status).toBe(401);
  const { createEmployee } = await import('./helpers');
  const other = await createEmployee(ctx.api, token, { username: 'idem-other', role: 'admin_staff' });
  await ctx.api.put(`/api/users/${other.id}/permissions`).set(hdr()).send({ overrides: { 'inventory.adjust': false } });
  const foreign = await ctx.api.post(path).set('Authorization', `Bearer ${await login(ctx.api, other.username, other.password)}`).set('Idempotency-Key', key).send({ change: -1 });
  expect(foreign.status).toBe(403);
  expect(foreign.headers['idempotency-replayed']).toBeUndefined();
});

it('refuses changed payloads and routes with a reused key', async () => {
  const id = await makeItem(100);
  const path = `/api/inventory/${id}/adjust`;
  const key = 'bound-request-key';
  expect((await ctx.api.post(path).set(hdr()).set('Idempotency-Key', key).send({ change: -1 })).status).toBe(200);
  expect((await ctx.api.post(path).set(hdr()).set('Idempotency-Key', key).send({ change: -10 })).status).toBe(409);
  expect((await ctx.api.post('/api/inventory').set(hdr()).set('Idempotency-Key', key).send({ name: 'Wrong route' })).status).toBe(409);
});

it('does not cache sign-in tokens or bypass logout revocation', async () => {
  const key = 'never-cache-login';
  const first = await ctx.api.post('/api/auth/login').set('Idempotency-Key', key).send({ username: 'admin', password: 'admin123' });
  expect(first.status).toBe(200);
  const bad = await ctx.api.post('/api/auth/login').set('Idempotency-Key', key).send({ username: 'admin', password: 'wrong' });
  expect(bad.status).toBe(401);
  const id = await makeItem(100);
  const path = `/api/inventory/${id}/adjust`;
  const headers = { Authorization: `Bearer ${first.body.token}`, 'Idempotency-Key': 'revoked-replay-key' };
  expect((await ctx.api.post(path).set(headers).send({ change: -1 })).status).toBe(200);
  await ctx.api.post('/api/auth/logout').set('Authorization', headers.Authorization).send({});
  expect((await ctx.api.post(path).set(headers).send({ change: -1 })).status).toBe(401);
});

it('rejects a concurrent retry while the first asynchronous mutation is in flight', async () => {
  let writes = 0;
  const express = (await import('express')).default;
  const request = (await import('supertest')).default;
  const { idempotency } = await import('../src/shared/idempotency');
  const fixture = express();
  fixture.use(express.json(), idempotency);
  fixture.post('/api/audit-delayed', (_req, res) => {
    writes++;
    setTimeout(() => res.json({ ok: true }), 30);
  });
  const results = await Promise.all([0, 1].map(() => request(fixture).post('/api/audit-delayed').set(hdr()).set('Idempotency-Key', 'concurrent-retry-key').send({ value: 1 })));
  expect(results.map(r => r.status).sort()).toEqual([200, 409]);
  expect(writes).toBe(1);
});

it('does not duplicate a pre-upgrade action when its legacy key is retried', async () => {
  const id = await makeItem(9);
  const { run } = await import('../src/shared/db');
  run('INSERT INTO idempotency_keys (key, user_id, method, path, status_code, response) VALUES (?, ?, ?, ?, ?, ?)', 'legacy-stock-key', 1, 'POST', '/adjust', 200, '{"quantity":9}');
  const retry = await ctx.api.post(`/api/inventory/${id}/adjust`).set(hdr()).set('Idempotency-Key', 'legacy-stock-key').send({ change: -1 });
  expect(retry.status).toBe(409);
  expect((await ctx.api.get(`/api/inventory/${id}`).set(hdr())).body.quantity).toBe(9);
});
