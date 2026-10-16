/** Enumerate actual Express registrations, including nested routers; no regex-only source gate. */
import { beforeAll, afterAll, it, expect } from 'vitest';
import { setupApp, cleanup, type TestContext } from './helpers';
let ctx: TestContext;
beforeAll(async () => { ctx = await setupApp(); });
afterAll(() => cleanup(ctx));
type Endpoint = { method: string; path: string };
function endpoints(stack: any[], prefix = ''): Endpoint[] {
  const found: Endpoint[] = [];
  for (const layer of stack) {
    if (layer.route) {
      for (const path of [layer.route.path].flat()) for (const method of Object.keys(layer.route.methods)) found.push({ method, path: prefix + path });
    } else if (layer.handle?.stack) {
      const base = layer.regexp.fast_slash ? '' : layer.regexp.source.split('\\/?')[0].replace(/^\^/, '').replace(/\\\//g, '/');
      found.push(...endpoints(layer.handle.stack, prefix + base));
    }
  }
  return found;
}
it('denies anonymous access across every registered protected API route and method', async () => {
  const routes = endpoints((ctx.app as any)._router.stack).filter(r => r.path.startsWith('/api/'));
  const publicPaths = /^\/api\/(?:health\/?$|signup\/?$|auth\/(?:login(?:\/mfa)?|forgot-password|reset-password|cancel-recovery)\/?$|anonymous-reports(?:\/|$)|quickbooks\/callback\/?$|sync(?:\/|$)|desktop(?:\/|$))/;
  const failures: unknown[] = [];
  let checked = 0;
  for (const route of routes) {
    if (publicPaths.test(route.path)) continue; // separate signature/ticket/recovery tests cover these
    const path = route.path.replace(/:([A-Za-z0-9_]+)(?:\([^)]*\))?\??/g, '1');
    const call = (ctx.api as any)[route.method];
    if (!call) continue;
    const res = await call.call(ctx.api, path).send({});
    checked++;
    if (![401, 403, 404].includes(res.status)) failures.push({ ...route, status: res.status });
  }
  console.log(JSON.stringify({ audit: 'registered anonymous API boundary', checked, failures: failures.length }));
  expect(checked).toBeGreaterThan(300);
  expect(failures).toEqual([]);
}, 60_000);
