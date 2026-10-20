/** Stock adjustment must never substitute for a named production or release permission. */
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';
import { BUILTIN_ROLES } from '../src/shared/permissions';
let ctx: TestContext;
let admin: string;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
beforeAll(async () => { ctx = await setupApp(); admin = await login(ctx.api); });
afterAll(() => cleanup(ctx));
const gates = [
  { method: 'get', path: '/api/qc/queue', permissions: ['production.inspect_qc', 'production.inspect_qa'] },
  { method: 'get', path: '/api/qc/holds', permissions: ['production.inspect_qa', 'production.qa_review'] },
  { method: 'get', path: '/api/rts/queue', permissions: ['production.receive'] },
  { method: 'post', path: '/api/job-orders/999999/accept', permissions: ['production.record'] },
  { method: 'post', path: '/api/job-orders/999999/units/inspect', permissions: ['production.inspect_qc', 'production.inspect_qa'] },
  { method: 'post', path: '/api/job-orders/999999/products-in', permissions: ['production.receive'] },
  { method: 'post', path: '/api/job-orders/999999/pause', permissions: ['production.pause', 'production.manage'] },
  { method: 'post', path: '/api/production/repairs/999999/accept', permissions: ['production.repairs'] },
  { method: 'post', path: '/api/orders/999999/release', permissions: ['orders.release'] },
  { method: 'get', path: '/api/release-slips/orders/999999/context', permissions: ['orders.release'] },
  { method: 'post', path: '/api/job-orders/999999/units/999999/hold-decision', permissions: ['production.inspect_qa', 'production.qa_review'] },
  { method: 'post', path: '/api/job-orders/999999/close', permissions: ['production.manage'] },
] as const;
async function check(token: string, permissions: readonly string[]) {
  for (const gate of gates) {
    const res = await ctx.api[gate.method](gate.path).set(auth(token)).send({});
    const allowed = gate.permissions.some(p => permissions.includes(p));
    if (allowed) {
      expect(res.status, gate.path).not.toBe(401);
      expect(res.status, gate.path).not.toBe(403);
    } else expect(res.status, gate.path).toBe(403);
  }
}
describe('every built-in role', () => {
  for (const role of BUILTIN_ROLES) {
    it(`${role.key} uses only its explicit task permissions`, async () => {
      const acct = await createEmployee(ctx.api, admin, { role: role.key });
      const me = await ctx.api.get('/api/auth/me').set(auth(acct.token));
      await check(acct.token, me.body.user.permissions);
    });
  }
});
it('custom stock role cannot bypass task revocations; role edits apply to existing sessions', async () => {
  const create = await ctx.api.post('/api/roles').set(auth(admin)).send({ label: 'Stock boundary test',
    permissions: ['mobile.access', 'inventory.adjust', 'production.view', 'orders.view'] });
  expect(create.status).toBe(201);
  const acct = await createEmployee(ctx.api, admin, { role: create.body.key });
  await check(acct.token, []);
  const update = await ctx.api.put(`/api/roles/${create.body.key}`).set(auth(admin))
    .send({ permissions: ['mobile.access', 'inventory.adjust', 'production.view', 'orders.view', 'production.receive'] });
  expect(update.status).toBe(200);
  expect((await ctx.api.get('/api/rts/queue').set(auth(acct.token))).status).toBe(200);
  expect((await ctx.api.put(`/api/users/${acct.id}/permissions`).set(auth(admin))
    .send({ overrides: { 'production.receive': false } })).status).toBe(200);
  expect((await ctx.api.get('/api/rts/queue').set(auth(acct.token))).status).toBe(403);
});
