/** Per-tenant AI config: RBAC, key never returned, key_source resolution, chat 503. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';

let ctx: TestContext;
let token: string;
const authHdr = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  ctx = await setupApp();
  token = await login(ctx.api);
});
afterAll(() => cleanup(ctx));

describe('GET/PUT /api/ai/config', () => {
  it('requires users.manage', async () => {
    const wh = await createEmployee(ctx.api, token, { role: 'warehouse' });
    const r = await ctx.api.get('/api/ai/config').set('Authorization', `Bearer ${wh.token}`);
    expect(r.status).toBe(403);
  });

  it('reports model / endpoint / key state, never the key itself', async () => {
    const r = await ctx.api.get('/api/ai/config').set(authHdr());
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('model');
    expect(r.body).toHaveProperty('base_url');
    expect(r.body).not.toHaveProperty('api_key');
    // No env key in the test process → no tenant key yet.
    expect(r.body.key_source === 'none' || r.body.key_source === 'platform').toBe(true);
  });

  it('stores a workspace key (key_source → tenant) and clears it on empty', async () => {
    let r = await ctx.api.put('/api/ai/config').set(authHdr())
      .send({ model: 'my-model', base_url: 'https://llm.example/v1/chat/completions', api_key: 'csk-secret-123' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ model: 'my-model', has_key: true, key_source: 'tenant' });
    expect(r.body).not.toHaveProperty('api_key');

    // Passwordless update keeps the key.
    r = await ctx.api.put('/api/ai/config').set(authHdr()).send({ model: 'my-model-2' });
    expect(r.body.key_source).toBe('tenant');
    expect(r.body.model).toBe('my-model-2');

    // Explicit empty string clears it.
    r = await ctx.api.put('/api/ai/config').set(authHdr()).send({ api_key: '' });
    expect(r.body.key_source === 'none' || r.body.key_source === 'platform').toBe(true);
  });

  it('rejects a non-URL endpoint', async () => {
    const r = await ctx.api.put('/api/ai/config').set(authHdr()).send({ base_url: 'not a url' });
    expect(r.status).toBe(400);
  });
});

describe('POST /api/ai/chat without a key', () => {
  it('503s with a helpful message', async () => {
    await ctx.api.put('/api/ai/config').set(authHdr()).send({ api_key: '' });
    const r = await ctx.api.post('/api/ai/chat').set(authHdr()).send({ messages: [{ role: 'user', content: 'hi' }] });
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/not configured/i);
  });
});
