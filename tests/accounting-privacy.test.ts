import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {setupApp,cleanup,login,createEmployee,type TestContext} from './helpers';
let ctx:TestContext, accountant:string, warehouse:string, employeeId:number;
const fields=['id','employee_no','name','position','tin_no','birth_date','birth_date_mdy','sss_no','philhealth_no','pagibig_no','department_name'];
beforeAll(async()=>{
 ctx=await setupApp();const admin=await login(ctx.api);
 accountant=(await createEmployee(ctx.api,admin,{role:'accounting',username:'privacy_accountant'})).token;
 warehouse=(await createEmployee(ctx.api,admin,{role:'warehouse',username:'privacy_warehouse'})).token;
 const {run}=await import('../src/shared/db');
 employeeId=Number(run(`INSERT INTO employees(employee_no,name,position,tin_no,birth_date,sss_no,philhealth_no,pagibig_no,daily_rate,monthly_rate,photo,civil_status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,'PRIV-2316','Synthetic Tax Employee','Clerk','SYNTHETIC-TIN','1991-03-07','SYNTHETIC-SSS','SYNTHETIC-PH','SYNTHETIC-PI',1234,26000,'private-photo.jpg','married').lastInsertRowid);
});
afterAll(()=>cleanup(ctx));
describe('BIR 2316 employee projection',()=>{
 it('allows an accountant without general HR/payroll access to print the bounded tax identity',async()=>{
  expect((await ctx.api.get('/api/hr/employees').set('Authorization',`Bearer ${accountant}`)).status).toBe(403);
  const res=await ctx.api.get(`/api/accounting/bir-2316/${employeeId}?year=2026`).set('Authorization',`Bearer ${accountant}`);
  expect(res.status).toBe(200);expect(res.headers['cache-control']).toContain('no-store');
  expect(res.body.employee).toMatchObject({id:employeeId,name:'Synthetic Tax Employee',employee_no:'PRIV-2316',tin_no:'SYNTHETIC-TIN',birth_date_mdy:'03/07/1991',sss_no:'SYNTHETIC-SSS',philhealth_no:'SYNTHETIC-PH',pagibig_no:'SYNTHETIC-PI'});
  expect(Object.keys(res.body.employee).sort()).toEqual([...fields].sort());
  expect(res.body.figures.payslip_count).toBe(0);
 });
 it('denies unauthenticated callers and roles without accounting.view',async()=>{
  expect((await ctx.api.get(`/api/accounting/bir-2316/${employeeId}`)).status).toBe(401);
  expect((await ctx.api.get(`/api/accounting/bir-2316/${employeeId}`).set('Authorization',`Bearer ${warehouse}`)).status).toBe(403);
 });
 it('returns 404 for a missing employee',async()=>{
  expect((await ctx.api.get('/api/accounting/bir-2316/999999').set('Authorization',`Bearer ${accountant}`)).status).toBe(404);
 });
 it('keeps blank birth dates and missing departments printable',async()=>{
  const {run}=await import('../src/shared/db');run('UPDATE employees SET birth_date=NULL WHERE id=?',employeeId);
  const res=await ctx.api.get(`/api/accounting/bir-2316/${employeeId}`).set('Authorization',`Bearer ${accountant}`);
  expect(res.status).toBe(200);expect(res.body.employee.birth_date_mdy).toBe('');expect(res.body.employee.department_name).toBeNull();
 });
 it('does not disclose a future employee column automatically',async()=>{
  const {run}=await import('../src/shared/db');run("ALTER TABLE employees ADD COLUMN audit_private_fixture TEXT DEFAULT 'not-for-tax-report'");
  const res=await ctx.api.get(`/api/accounting/bir-2316/${employeeId}`).set('Authorization',`Bearer ${accountant}`);
  expect(res.status).toBe(200);expect(Object.keys(res.body.employee).sort()).toEqual([...fields].sort());
  expect(JSON.stringify(res.body)).not.toContain('not-for-tax-report');
 });
});
