/** Integration tests: HR's "create account" shortcut from the employee form — hr.manage may
    create login accounts, but only with a staff role (HR_ASSIGNABLE_ROLES). */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';

let ctx: TestContext;
let adminToken: string;

beforeAll(async () => {
  ctx = await setupApp();
  adminToken = await login(ctx.api);
});
afterAll(() => cleanup(ctx));

describe('POST /api/users by an HR user', () => {
  it('creates a staff-role account and it can be linked to an employee', async () => {
    const hr = await createEmployee(ctx.api, adminToken, { username: 'hrcreator', role: 'hr' });
    const hdr = { Authorization: `Bearer ${hr.token}` };

    const res = await ctx.api.post('/api/users').set(hdr)
      .send({ username: 'floor.worker', full_name: 'Floor Worker', password: 'secret1', role: 'warehouse' });
    expect(res.status).toBe(201);

    const emp = await ctx.api.post('/api/hr/employees').set(hdr)
      .send({ employee_no: 'HRC-1', name: 'Floor Worker', user_id: res.body.id });
    expect(emp.status).toBe(201);
  });

  it('refuses privileged roles', async () => {
    const hr = await createEmployee(ctx.api, adminToken, { username: 'hrcreator2', role: 'hr' });
    const hdr = { Authorization: `Bearer ${hr.token}` };
    for (const role of ['admin', 'admin_staff', 'hr', 'accounting']) {
      const res = await ctx.api.post('/api/users').set(hdr)
        .send({ username: `priv.${role}`, full_name: 'Nope', password: 'secret1', role });
      expect(res.status).toBe(403);
    }
  });

  it('lets HR add staff-level access on top of the base role, but nothing privileged', async () => {
    const hr = await createEmployee(ctx.api, adminToken, { username: 'hraccess', role: 'hr' });
    const hdr = { Authorization: `Bearer ${hr.token}` };
    const acct = await ctx.api.post('/api/users').set(hdr)
      .send({ username: 'multi.role', full_name: 'Multi Role', password: 'secret1', role: 'qc_inspector' });

    const cat = await ctx.api.get('/api/users/permissions/catalog').set(hdr);
    expect(cat.status).toBe(200);
    expect(cat.body.grantable).toContain('production.inspect_qa');
    expect(cat.body.grantable).not.toContain('users.manage');
    expect(cat.body.assignableRoles).not.toContain('admin');

    // QC inspector who also does QA and releasing — a staff-level combination.
    const ok = await ctx.api.put(`/api/users/${acct.body.id}/permissions`).set(hdr)
      .send({ overrides: { 'production.inspect_qa': true, 'orders.release': true } });
    expect(ok.status).toBe(200);
    const access = await ctx.api.get(`/api/users/${acct.body.id}/access`).set(hdr);
    expect(JSON.parse(access.body.permission_overrides)).toEqual({ 'production.inspect_qa': true, 'orders.release': true });

    for (const key of ['users.manage', 'hr.manage', 'accounting.view']) {
      const bad = await ctx.api.put(`/api/users/${acct.body.id}/permissions`).set(hdr)
        .send({ overrides: { [key]: true } });
      expect(bad.status).toBe(403);
    }
  });

  it("refuses HR changing a privileged account's access", async () => {
    const hr = await createEmployee(ctx.api, adminToken, { username: 'hraccess2', role: 'hr' });
    const acct = await createEmployee(ctx.api, adminToken, { username: 'someaccountant', role: 'accounting' });
    const res = await ctx.api.put(`/api/users/${acct.id}/permissions`).set({ Authorization: `Bearer ${hr.token}` })
      .send({ overrides: { 'inventory.view': true } });
    expect(res.status).toBe(403);
  });

  it('still refuses users without users.manage or hr.manage', async () => {
    const staff = await createEmployee(ctx.api, adminToken, { username: 'plainstaff', role: 'warehouse' });
    const res = await ctx.api.post('/api/users').set({ Authorization: `Bearer ${staff.token}` })
      .send({ username: 'sneaky', full_name: 'Nope', password: 'secret1', role: 'warehouse' });
    expect(res.status).toBe(403);
  });
});
