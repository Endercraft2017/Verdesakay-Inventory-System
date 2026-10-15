/** Integration tests: tenant-defined roles (src/shared/roles.ts, /api/roles) — a role is a named
    permission bundle; accounts get their role's bundle plus their own overrides; every built-in
    role gives new accounts the phone app (mobile.access); HR may only assign staff-level roles. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';
import { BUILTIN_ROLES } from '../src/shared/permissions';

let ctx: TestContext;
let adminToken: string;
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function me(token: string): Promise<{ role: string; role_label: string; permissions: string[] }> {
  const res = await ctx.api.get('/api/auth/me').set(auth(token));
  expect(res.status).toBe(200);
  return res.body.user;
}

beforeAll(async () => {
  ctx = await setupApp();
  adminToken = await login(ctx.api);
});
afterAll(() => cleanup(ctx));

describe('built-in roles', () => {
  it('are seeded into the workspace, Administrator first and fixed', async () => {
    const res = await ctx.api.get('/api/roles').set(auth(adminToken));
    expect(res.status).toBe(200);
    const keys = res.body.map((r: { key: string }) => r.key);
    for (const r of BUILTIN_ROLES) expect(keys).toContain(r.key);
    expect(res.body[0]).toMatchObject({ key: 'admin', fixed: true, staff: false });
  });

  it('give every new account the phone app automatically', async () => {
    for (const role of ['admin_staff', 'accounting', 'hr', 'marketing', 'csr', 'warehouse', 'qc_inspector']) {
      const acct = await createEmployee(ctx.api, adminToken, { username: `mob.${role}`, role });
      const u = await me(acct.token);
      expect(u.permissions, role).toContain('mobile.access');
    }
  });

  it('label the account with the role name', async () => {
    const acct = await createEmployee(ctx.api, adminToken, { username: 'label.check', role: 'receiving_clerk' });
    expect((await me(acct.token)).role_label).toBe('Products In Clerk');
  });
});

describe('custom roles', () => {
  it('create a role, give it to an account, and the account gets exactly that bundle', async () => {
    const created = await ctx.api.post('/api/roles').set(auth(adminToken)).send({
      label: 'Line Supervisor', description: 'Runs one line',
      permissions: ['mobile.access', 'inventory.view', 'production.record', 'production.pause', 'not.a.permission'],
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ key: 'line_supervisor', label: 'Line Supervisor', staff: true });
    expect(created.body.permissions).not.toContain('not.a.permission');

    const acct = await createEmployee(ctx.api, adminToken, { username: 'line.sup', role: 'line_supervisor' });
    expect((await me(acct.token)).permissions.sort())
      .toEqual(['inventory.view', 'mobile.access', 'production.pause', 'production.record']);

    // Editing the role changes everyone holding it, on their next request.
    const upd = await ctx.api.put('/api/roles/line_supervisor').set(auth(adminToken))
      .send({ permissions: ['mobile.access', 'inventory.view', 'production.record', 'production.receive'] });
    expect(upd.status).toBe(200);
    expect((await ctx.api.get('/api/auth/me').set(auth(acct.token))).status).toBe(401);
    acct.token = await login(ctx.api, acct.username, acct.password);
    const after = (await me(acct.token)).permissions;
    expect(after).toContain('production.receive');
    expect(after).not.toContain('production.pause');

    // Per-person overrides still apply on top of the role.
    const ov = await ctx.api.put(`/api/users/${acct.id}/permissions`).set(auth(adminToken))
      .send({ overrides: { 'production.receive': false, 'orders.view': true } });
    expect(ov.status).toBe(200);
    acct.token = await login(ctx.api, acct.username, acct.password);
    const mine = (await me(acct.token)).permissions;
    expect(mine).not.toContain('production.receive');
    expect(mine).toContain('orders.view');
  });

  it('refuses a duplicate name and an unknown role on an account', async () => {
    const dup = await ctx.api.post('/api/roles').set(auth(adminToken)).send({ label: 'line supervisor' });
    expect(dup.status).toBe(409);
    const bad = await ctx.api.post('/api/users').set(auth(adminToken))
      .send({ username: 'ghost.role', full_name: 'Ghost', password: 'secret1', role: 'no_such_role' });
    expect(bad.status).toBe(400);
  });

  it('keeps Administrator fixed and only deletes a role nobody holds', async () => {
    expect((await ctx.api.put('/api/roles/admin').set(auth(adminToken)).send({ permissions: [] })).status).toBe(400);
    expect((await ctx.api.delete('/api/roles/admin').set(auth(adminToken))).status).toBe(400);
    expect((await ctx.api.delete('/api/roles/line_supervisor').set(auth(adminToken))).status).toBe(409);

    const temp = await ctx.api.post('/api/roles').set(auth(adminToken)).send({ label: 'Temp Role', permissions: [] });
    expect((await ctx.api.delete(`/api/roles/${temp.body.key}`).set(auth(adminToken))).status).toBe(200);
    const list = await ctx.api.get('/api/roles').set(auth(adminToken));
    expect(list.body.map((r: { key: string }) => r.key)).not.toContain(temp.body.key);
  });

  it('only users.manage can create or change roles', async () => {
    const staff = await createEmployee(ctx.api, adminToken, { username: 'not.admin', role: 'warehouse' });
    expect((await ctx.api.post('/api/roles').set(auth(staff.token)).send({ label: 'Sneaky' })).status).toBe(403);
    expect((await ctx.api.put('/api/roles/warehouse').set(auth(staff.token)).send({ permissions: ['users.manage'] })).status).toBe(403);
  });
});

describe('HR and custom roles', () => {
  it('HR may assign a staff-level custom role but not one carrying management permissions', async () => {
    await ctx.api.post('/api/roles').set(auth(adminToken))
      .send({ label: 'Packer', permissions: ['mobile.access', 'inventory.view', 'inventory.mobile'] });
    await ctx.api.post('/api/roles').set(auth(adminToken))
      .send({ label: 'Payroll Clerk', permissions: ['mobile.access', 'hr.view'] });
    const hr = await createEmployee(ctx.api, adminToken, { username: 'hr.roles', role: 'hr' });

    const cat = await ctx.api.get('/api/users/permissions/catalog').set(auth(hr.token));
    expect(cat.body.assignableRoles).toContain('packer');
    expect(cat.body.assignableRoles).not.toContain('payroll_clerk');

    const ok = await ctx.api.post('/api/users').set(auth(hr.token))
      .send({ username: 'packer.one', full_name: 'Packer One', password: 'secret1', role: 'packer' });
    expect(ok.status).toBe(201);
    const no = await ctx.api.post('/api/users').set(auth(hr.token))
      .send({ username: 'payroll.one', full_name: 'Payroll One', password: 'secret1', role: 'payroll_clerk' });
    expect(no.status).toBe(403);
  });
});
