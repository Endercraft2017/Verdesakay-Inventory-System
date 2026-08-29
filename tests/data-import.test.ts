/** CSV import/export for suppliers and employees (shared src/csv-import.ts machinery):
    upsert by natural key, department-by-name, per-row errors, dry-run, RBAC, round-trip. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';
import { parseCsvTable } from '../src/csv';

let ctx: TestContext;
let token: string;
const authHdr = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  ctx = await setupApp();
  token = await login(ctx.api);
});
afterAll(() => cleanup(ctx));

describe('POST /api/suppliers/import', () => {
  const imp = (csv: string, dry_run = false) =>
    ctx.api.post('/api/suppliers/import').set(authHdr()).send({ csv, dry_run });

  it('creates then updates suppliers keyed by name', async () => {
    const a = await imp('name,email,phone\nAcme Steel,sales@acme.test,123\nBolt Depot,,\n');
    expect(a.body).toMatchObject({ created: 2, updated: 0, skipped: 0 });

    const b = await imp('name,email,contact_person\nAcme Steel,new@acme.test,Jo Cruz\n');
    expect(b.body).toMatchObject({ created: 0, updated: 1 });

    const list = await ctx.api.get('/api/suppliers?q=Acme').set(authHdr());
    const acme = list.body.find((s: { name: string }) => s.name === 'Acme Steel');
    expect(acme.email).toBe('new@acme.test');
    expect(acme.contact_person).toBe('Jo Cruz');
  });

  it('errors a row with no name, keeps the rest', async () => {
    const r = await imp('name,email\n,x@y.test\nGood Vendor,g@v.test\n');
    expect(r.body).toMatchObject({ created: 1, skipped: 1 });
    expect(r.body.errors[0].row).toBe(1);
  });

  it('dry_run writes nothing', async () => {
    await imp('name\nGhost Vendor\n', true);
    const list = await ctx.api.get('/api/suppliers?q=Ghost').set(authHdr());
    expect(list.body.length).toBe(0);
  });

  it('400s when the name column is missing', async () => {
    const r = await imp('email\nx@y.test\n');
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/name/i);
  });

  it('round-trips through export', async () => {
    await imp('name,phone\nRT Vendor,555\n');
    const exp = await ctx.api.get('/api/suppliers/export').set(authHdr());
    expect(exp.status).toBe(200);
    expect(parseCsvTable(exp.text).rows.some((r) => r.name === 'RT Vendor')).toBe(true);
    const back = await imp(exp.text);
    expect(back.body.created).toBe(0);
    expect(back.body.skipped).toBe(0);
  });
});

describe('POST /api/hr/employees/import', () => {
  const imp = (csv: string, dry_run = false) =>
    ctx.api.post('/api/hr/employees/import').set(authHdr()).send({ csv, dry_run });

  it('creates employees, resolves department by name, upserts by employee_no', async () => {
    const r = await imp(
      'employee_no,name,department,position,rate_type,daily_rate\n' +
      'EMP-1001,Maria Santos,Operations,Machinist,daily,850\n' +
      'EMP-1002,Ben Reyes,Finance,Clerk,monthly,\n' // monthly needs monthly_rate -> error
    );
    expect(r.body.created).toBe(1);
    expect(r.body.skipped).toBe(1);

    const list = await ctx.api.get('/api/hr/employees?q=Maria').set(authHdr());
    const maria = list.body.find((e: { employee_no: string }) => e.employee_no === 'EMP-1001');
    expect(maria.department_name).toBe('Operations');
    expect(maria.daily_rate).toBe(850);

    const up = await imp('employee_no,name,department,rate_type,daily_rate\nEMP-1001,Maria S. Santos,Operations,daily,900\n');
    expect(up.body).toMatchObject({ created: 0, updated: 1 });
    const list2 = await ctx.api.get('/api/hr/employees?q=Maria').set(authHdr());
    expect(list2.body.find((e: { employee_no: string }) => e.employee_no === 'EMP-1001').name).toBe('Maria S. Santos');
  });

  it('errors an unknown department', async () => {
    const r = await imp('employee_no,name,department\nEMP-9,Nobody,Atlantis Dept\n');
    expect(r.body.skipped).toBe(1);
    expect(r.body.errors[0].message).toMatch(/unknown department/i);
    expect(r.body.errors[0].key).toBe('EMP-9');
  });

  it('requires hr.manage', async () => {
    const viewer = await createEmployee(ctx.api, token, { role: 'marketing' }); // no HR permissions
    const r = await ctx.api
      .post('/api/hr/employees/import')
      .set('Authorization', `Bearer ${viewer.token}`)
      .send({ csv: 'employee_no,name\nX,Y\n' });
    expect(r.status).toBe(403);
  });

  it('round-trips through export', async () => {
    await imp('employee_no,name,department,rate_type,daily_rate\nRT-1,Round Trip,Operations,daily,700\n');
    const exp = await ctx.api.get('/api/hr/employees/export').set(authHdr());
    const table = parseCsvTable(exp.text);
    expect(table.headers).toContain('employee_no');
    expect(table.rows.some((r) => r.employee_no === 'RT-1')).toBe(true);
    const back = await imp(exp.text);
    expect(back.body.skipped).toBe(0);
    expect(back.body.created).toBe(0);
  });
});
