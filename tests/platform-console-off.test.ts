/** Without PLATFORM_CONSOLE=true the owner console does not exist at all — the whole
    `/_platform` path 404s and never falls through to the tenant SPA shell. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, type TestContext } from './helpers';

let ctx: TestContext;

beforeAll(async () => {
  delete process.env.PLATFORM_CONSOLE;
  ctx = await setupApp();
});
afterAll(() => cleanup(ctx));

it('404s the console API and the console page', async () => {
  const api = await ctx.api.get('/_platform/api/tenants');
  expect(api.status).toBe(404);
  expect(api.body.error).toBe('Not found');

  const page = await ctx.api.get('/_platform');
  expect(page.status).toBe(404);
});
