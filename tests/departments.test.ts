/** Integration tests: department management (create, usage counts, rename, delete, RBAC). */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';

let ctx: TestContext;
let adminToken: string;
const admin = () => ({ Authorization: `Bearer ${adminToken}` });

beforeAll(async () => {
  ctx = await setupApp();
  adminToken = await login(ctx.api);
});
afterAll(() => cleanup(ctx));

describe('departments', () => {
  it('lists seeded departments with usage counts', async () => {
    const res = await ctx.api.get('/api/users/departments').set(admin());
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(5);
    const admins = res.body.find((d: { name: string }) => d.name === 'Administration');
    expect(admins.user_count).toBeGreaterThanOrEqual(1); // seeded admin is in Administration
    expect(typeof admins.item_count).toBe('number');
    expect(typeof admins.form_count).toBe('number');
  });

  it('creates, renames, then deletes a department', async () => {
    const created = await ctx.api.post('/api/users/departments').set(admin()).send({ name: 'Logistics' });
    expect(created.status).toBe(201);
    const id = created.body.id;

    const renamed = await ctx.api.put(`/api/users/departments/${id}`).set(admin()).send({ name: 'Supply Chain' });
    expect(renamed.status).toBe(200);
    let list = await ctx.api.get('/api/users/departments/list').set(admin());
    expect(list.body.some((d: { name: string }) => d.name === 'Supply Chain')).toBe(true);

    const deleted = await ctx.api.delete(`/api/users/departments/${id}`).set(admin());
    expect(deleted.status).toBe(200);
    list = await ctx.api.get('/api/users/departments/list').set(admin());
    expect(list.body.some((d: { id: number }) => d.id === id)).toBe(false);
  });

  it('rejects a duplicate name on rename', async () => {
    const a = await ctx.api.post('/api/users/departments').set(admin()).send({ name: 'Alpha Dept' });
    await ctx.api.post('/api/users/departments').set(admin()).send({ name: 'Beta Dept' });
    const clash = await ctx.api.put(`/api/users/departments/${a.body.id}`).set(admin()).send({ name: 'Beta Dept' });
    expect(clash.status).toBe(409);
  });

  it('unassigns members when their department is deleted (FK set null)', async () => {
    const dept = await ctx.api.post('/api/users/departments').set(admin()).send({ name: 'Temp Dept' });
    const emp = await createEmployee(ctx.api, adminToken, { username: 'tempdeptuser', department_id: dept.body.id });

    await ctx.api.delete(`/api/users/departments/${dept.body.id}`).set(admin());

    const users = await ctx.api.get('/api/users').set(admin());
    const found = users.body.find((u: { id: number }) => u.id === emp.id);
    expect(found.department_id).toBeNull();
  });

  it('blocks employees from managing departments', async () => {
    const emp = await createEmployee(ctx.api, adminToken, { username: 'deptblocked' });
    const create = await ctx.api.post('/api/users/departments').set({ Authorization: `Bearer ${emp.token}` }).send({ name: 'Nope' });
    expect(create.status).toBe(403);
    const usage = await ctx.api.get('/api/users/departments').set({ Authorization: `Bearer ${emp.token}` });
    expect(usage.status).toBe(403);
  });

  it('lets an hr.manage user create a department and delete it while unused, but never rename', async () => {
    const hrUser = await createEmployee(ctx.api, adminToken, { username: 'depthr', role: 'hr' });
    const hdr = { Authorization: `Bearer ${hrUser.token}` };

    const created = await ctx.api.post('/api/users/departments').set(hdr).send({ name: 'HR-Made Dept' });
    expect(created.status).toBe(201);

    const rename = await ctx.api.put(`/api/users/departments/${created.body.id}`).set(hdr).send({ name: 'Renamed' });
    expect(rename.status).toBe(403);

    const del = await ctx.api.delete(`/api/users/departments/${created.body.id}`).set(hdr);
    expect(del.status).toBe(200);
    const list = await ctx.api.get('/api/users/departments/list').set(hdr);
    expect(list.body.some((d: { id: number }) => d.id === created.body.id)).toBe(false);
  });

  it('blocks hr.manage from deleting a department still used outside HR (a user account)', async () => {
    const dept = await ctx.api.post('/api/users/departments').set(admin()).send({ name: 'Used By User Dept' });
    await createEmployee(ctx.api, adminToken, { username: 'usesdept', department_id: dept.body.id });

    const hrUser = await createEmployee(ctx.api, adminToken, { username: 'depthr2', role: 'hr' });
    const del = await ctx.api.delete(`/api/users/departments/${dept.body.id}`).set({ Authorization: `Bearer ${hrUser.token}` });
    expect(del.status).toBe(409);

    // An admin can still delete it (unconditional, as before).
    expect((await ctx.api.delete(`/api/users/departments/${dept.body.id}`).set(admin())).status).toBe(200);
  });

  it('lets hr.manage delete a department only used by employees (HR\'s own domain)', async () => {
    const dept = await ctx.api.post('/api/users/departments').set(admin()).send({ name: 'HR-Only Dept' });
    await ctx.api.post('/api/hr/employees').set(admin()).send({ name: 'Dept User Employee', department_id: dept.body.id });

    const hrUser = await createEmployee(ctx.api, adminToken, { username: 'depthr3', role: 'hr' });
    const del = await ctx.api.delete(`/api/users/departments/${dept.body.id}`).set({ Authorization: `Bearer ${hrUser.token}` });
    expect(del.status).toBe(200);
  });
});
