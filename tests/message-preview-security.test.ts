import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import dns from 'node:dns/promises';
import { setupApp, cleanup, login, type TestContext } from './helpers';
let ctx: TestContext;
let token: string;
beforeAll(async () => { ctx = await setupApp(); token = await login(ctx.api); });
afterAll(() => cleanup(ctx));
it('pins the actual preview connection after one DNS lookup', async () => {
  const lookup = vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as never);
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<title>Public preview</title>', { headers: { 'content-type': 'text/html' } }));
  try {
    const result = await ctx.api.get('/api/messages/link-preview').set('Authorization', `Bearer ${token}`).query({ url: 'https://preview-security.example/public' });
    expect(result.status).toBe(200);
    expect(result.body.title).toBe('Public preview');
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ dispatcher: expect.anything(), redirect: 'manual' });
  } finally { vi.restoreAllMocks(); }
});
it('rejects a redirect to metadata before making the second request', async () => {
  vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as never);
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } }));
  try {
    const result = await ctx.api.get('/api/messages/link-preview').set('Authorization', `Bearer ${token}`).query({ url: 'https://preview-security.example/redirect' });
    expect(result.status).toBe(404);
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally { vi.restoreAllMocks(); }
});
