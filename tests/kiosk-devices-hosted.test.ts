/** On an internet-facing server (BEHIND_PROXY / Railway) the kiosk lock is ON by default, so a
 *  fresh hosted install is safe before HR touches any setting. HR can still turn it off. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, type TestContext } from './helpers';

let ctx: TestContext;
let adminToken: string;
const A = () => ({ Authorization: `Bearer ${adminToken}` });

beforeAll(async () => {
  process.env.BEHIND_PROXY = 'true'; // read when src/shared/hosting.ts is first imported
  ctx = await setupApp();
  adminToken = await login(ctx.api);
});
afterAll(() => { delete process.env.BEHIND_PROXY; cleanup(ctx); });

describe('hosted default', () => {
  it('locks the kiosk until a PC is approved', async () => {
    const info = await ctx.api.get('/api/hr/clock/kiosk-devices').set(A());
    expect(info.body).toMatchObject({ lock_active: true, lock_setting: null });
    expect((await ctx.api.get('/api/hr/clock/code').set(A())).status).toBe(403);

    const { token } = (await ctx.api.post('/api/hr/clock/kiosk-devices').set(A()).send({ name: 'Front desk PC' })).body;
    expect((await ctx.api.get('/api/hr/clock/code').set({ ...A(), 'X-Kiosk-Token': token })).status).toBe(200);
  });

  it('an explicit "off" from HR overrides the hosted default', async () => {
    await ctx.api.put('/api/hr/clock/kiosk-lock').set(A()).send({ enabled: false });
    expect((await ctx.api.get('/api/hr/clock/code').set(A())).status).toBe(200);
  });
});
