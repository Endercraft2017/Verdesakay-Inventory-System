/** Role usability and permission consistency. Every account/document here is disposable. */
import {beforeAll,afterAll,it,expect} from 'vitest';
import {setupApp,cleanup,login,createEmployee,type TestContext} from './helpers';
import {BUILTIN_ROLES,roleDefaults} from '../src/shared/permissions';
let ctx:TestContext, admin:string, db:typeof import('../src/shared/db');
let warehouse:{id:number;token:string}, buyer:{id:number;token:string}, reviewer:{id:number;token:string}, finance:{id:number;token:string};
const H=(token=admin)=>({Authorization:'Bearer '+token});
beforeAll(async()=>{
  ctx=await setupApp();admin=await login(ctx.api);db=await import('../src/shared/db');
  warehouse=await createEmployee(ctx.api,admin,{role:'warehouse'});
  buyer=await createEmployee(ctx.api,admin,{role:'buyer'});
  finance=await createEmployee(ctx.api,admin,{role:'finance_approver'});
  const permissions=['mobile.access','accounting.view','accounting.manage','accounting.post','inventory.costs','purchasing.view','purchasing.manage','purchasing.approve_bills','payroll.view','payroll.manage','payroll.approve','payroll.pay'];
  const role=await ctx.api.post('/api/roles').set(H()).send({key:'followup_reviewer',label:'Followup combined reviewer',permissions});expect(role.status).toBe(201);
  reviewer=await createEmployee(ctx.api,admin,{role:'followup_reviewer'});
});
afterAll(()=>cleanup(ctx));

async function purchase(){
  const item=(await ctx.api.post('/api/inventory').set(H()).send({name:'Followup supplier part',quantity:0})).body.id;
  const po=await ctx.api.post('/api/orders').set(H(buyer.token)).send({type:'purchase',items:[{item_id:item,name:'Followup supplier part',quantity:2,unit_price:123.45}]});expect(po.status).toBe(201);
  const line=(await ctx.api.get('/api/orders/'+po.body.id).set(H())).body.items[0].id;
  const bill=await ctx.api.post(`/api/purchasing/orders/${po.body.id}/bills`).set(H(buyer.token)).send({lines:[{item_id:item,order_item_id:line,name:'Followup supplier part',quantity:2,unit_price:123.45}]});expect(bill.status).toBe(201);
  return {po:po.body.id,item,line,bill:bill.body.id};
}

it('keeps warehouse receiving quantities while hiding prices, embedded match details and dashboard values',async()=>{
  const {po,bill}=await purchase();
  for(const path of [`/api/purchasing/orders/${po}`,`/api/purchasing/bills/${bill}`]){
    const r=await ctx.api.get(path).set(H(warehouse.token));expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain('123.45');expect(JSON.stringify(r.body)).not.toContain('246.9');
    if(r.body.lines)expect(r.body.lines[0]).toMatchObject({quantity:2,outstanding:2});
    expect(r.body.match).toBeUndefined();expect(r.body.match_json).toBeUndefined();
  }
  const report=await ctx.api.get('/api/analytics/overview').set(H(warehouse.token));expect(report.status).toBe(200);
  expect(Object.keys(report.body.purchasing).sort()).toEqual(['bills_to_approve','open_pos']);
  expect(report.body.inventory.stock_value).toBeUndefined();
  const priced=await ctx.api.get(`/api/purchasing/orders/${po}`).set(H(buyer.token));expect(priced.body.lines[0].unit_price).toBe(123.45);
  expect((await ctx.api.get('/api/analytics/overview').set(H(buyer.token))).body.purchasing.open_po_value).toBeGreaterThanOrEqual(246.9);
});

it('gives payroll reviewers minimal cutoff context while personnel and attendance remain denied',async()=>{
  const p=await ctx.api.post('/api/hr/periods').set(H()).send({label:'Followup payroll',start_date:'2026-10-01',end_date:'2026-10-15'});expect(p.status).toBe(201);
  const r=await ctx.api.get('/api/hr/payroll/cutoffs').set(H(finance.token));expect(r.status).toBe(200);
  expect(r.body.find((x:any)=>x.id===p.body.id)).toEqual({id:p.body.id,label:'Followup payroll',start_date:'2026-10-01',end_date:'2026-10-15'});
  for(const path of ['/api/hr/employees','/api/hr/periods',`/api/hr/periods/${p.body.id}/attendance`])expect((await ctx.api.get(path).set(H(finance.token))).status).toBe(403);
  expect((await ctx.api.get('/api/hr/payroll/cutoffs').set(H(warehouse.token))).status).toBe(403);
});

it('keeps supervisor working permissions and lets the existing Production Manager approve plans',async()=>{
  expect(BUILTIN_ROLES).toHaveLength(32);
  for(const [junior,senior]of [['csr','csr_supervisor'],['warehouse','warehouse_supervisor']]){
    for(const p of roleDefaults(junior!))expect(roleDefaults(senior!)).toContain(p);
  }
  const manager=await createEmployee(ctx.api,admin,{role:'production_manager'});
  const item=(await ctx.api.post('/api/inventory').set(H()).send({name:'Followup production',quantity:0})).body.id;
  const part=(await ctx.api.post('/api/inventory').set(H()).send({name:'Followup production component',quantity:10})).body.id;
  expect((await ctx.api.put(`/api/finished-products/${item}`).set(H()).send({components:[{component_item_id:part,quantity:1}]})).status).toBe(200);
  const jo=await ctx.api.post('/api/job-orders').set(H()).send({product_item_id:item,qty_ordered:1,qc_stages:2});expect(jo.status).toBe(201);
  expect((await ctx.api.post(`/api/job-orders/${jo.body.id}/approve`).set(H(manager.token)).send({})).status).toBe(200);
  expect((await ctx.api.post('/api/job-orders').set(H(manager.token)).send({product_item_id:item,qty_ordered:1})).status).toBe(403);
});

it('a journal editor cannot post their changes to another creator’s draft; independent reviewers can',async()=>{
  expect((await ctx.api.post('/api/accounting/ledger/setup').set(H()).send({fiscal_year_start:'2026-01-01'})).status).toBe(201);
  const accounts=(await ctx.api.get('/api/accounting/ledger/accounts').set(H())).body;
  const cash=accounts.find((a:any)=>a.code==='1110').id, sales=accounts.find((a:any)=>a.code==='4100').id;
  const body={entry_date:'2026-10-20',lines:[{account_id:cash,debit:10},{account_id:sales,credit:10}]};
  const entry=await ctx.api.post('/api/accounting/ledger/journal-entries').set(H()).send(body);expect(entry.status).toBe(201);
  expect((await ctx.api.put(`/api/accounting/ledger/journal-entries/${entry.body.id}`).set(H(reviewer.token)).send({...body,memo:'Reviewed draft edit'})).status).toBe(200);
  expect((await ctx.api.post(`/api/accounting/ledger/journal-entries/${entry.body.id}/post`).set(H(reviewer.token)).send({})).body.code).toBe('independent_approval_required');
  expect(db.queryOne<any>('SELECT created_by,last_edited_by FROM journal_entries WHERE id=?',entry.body.id)).toEqual({created_by:1,last_edited_by:reviewer.id});
  expect((await ctx.api.post(`/api/accounting/ledger/journal-entries/${entry.body.id}/post`).set(H(finance.token)).send({})).status).toBe(200);
});

it('a vendor-bill editor must hand the final draft to someone else for approval',async()=>{
  const {po,item,line,bill}=await purchase();
  expect((await ctx.api.post(`/api/purchasing/orders/${po}/receipts`).set(H(warehouse.token)).send({location_id:1,lines:[{order_item_id:line,item_id:item,name:'Followup supplier part',quantity:2}]})).status).toBe(201);
  const edit=await ctx.api.put(`/api/purchasing/bills/${bill}`).set(H(reviewer.token)).send({lines:[{order_item_id:line,item_id:item,name:'Followup supplier part',quantity:2,unit_price:123.45}]});expect(edit.status).toBe(200);
  const own=await ctx.api.post(`/api/purchasing/bills/${bill}/approve`).set(H(reviewer.token)).send({});expect(own.status).toBe(403);expect(own.body.code).toBe('independent_approval_required');
  const approver=await createEmployee(ctx.api,admin,{role:'purchase_approver'});
  expect((await ctx.api.post(`/api/purchasing/bills/${bill}/approve`).set(H(approver.token)).send({})).status).toBe(200);
});

it('payroll edits require another reviewer, while paying another person’s draft does not require GL posting',async()=>{
  const form=db.queryOne<any>("SELECT id FROM form_definitions WHERE slug='hr_payroll'");
  const id=Number(db.run("INSERT INTO form_records(form_def_id,number,data,status,period,created_by) VALUES(?,?,?,'draft',?,1)",form.id,'FOLLOWUP-PAY-01',JSON.stringify({employee_name:'Synthetic payroll fixture',net_pay:100,total_earnings:100}),'Followup payroll').lastInsertRowid);
  const edit=await ctx.api.put(`/api/form-records/${id}`).set(H(reviewer.token)).send({data:{employee_name:'Synthetic payroll fixture',net_pay:110,total_earnings:110}});expect(edit.status).toBe(200);
  expect((await ctx.api.post(`/api/hr/payroll/${id}/mark-paid`).set(H(reviewer.token))).body.code).toBe('independent_approval_required');
  const period=db.queryOne<any>("SELECT id FROM attendance_periods WHERE label='Followup payroll'");
  expect((await ctx.api.post(`/api/hr/periods/${period.id}/post-payroll-gl`).set(H(reviewer.token)).send({})).body.code).toBe('independent_approval_required');
  expect((await ctx.api.post(`/api/hr/payroll/${id}/mark-paid`).set(H(finance.token))).status).toBe(200);
});

it('regenerating another person’s payslip records the preparer and prevents self-review',async()=>{
  const employee=await ctx.api.post('/api/hr/employees').set(H()).send({employee_no:'FOLLOWUP-REGEN',name:'Synthetic regeneration fixture',daily_rate:500});expect(employee.status).toBe(201);
  const period=await ctx.api.post('/api/hr/periods').set(H()).send({label:'Followup regeneration',start_date:'2026-10-01',end_date:'2026-10-01'});expect(period.status).toBe(201);
  expect((await ctx.api.post(`/api/hr/periods/${period.body.id}/employees`).set(H()).send({employee_id:employee.body.id})).status).toBe(201);
  const generate=()=>ctx.api.post(`/api/hr/periods/${period.body.id}/generate-payslips`);
  expect((await generate().set(H()).send({payroll_period:'Followup regeneration'})).status).toBe(201);
  expect((await generate().set(H(reviewer.token)).send({payroll_period:'Followup regeneration'})).status).toBe(201);
  const slip=db.queryOne<any>("SELECT id,created_by,last_edited_by FROM form_records WHERE period='Followup regeneration'")!;
  expect(slip.created_by).toBe(1);expect(slip.last_edited_by).toBe(reviewer.id);
  const posting=await ctx.api.post(`/api/hr/periods/${period.body.id}/post-payroll-gl`).set(H(reviewer.token)).send({});
  expect(posting.status).toBe(403);expect(posting.body.code).toBe('independent_approval_required');
});

it('upgrades only unchanged default role bundles once, preserving custom roles, deletions and all account rows',()=>{
  const additions:Record<string,string[]>={production_manager:['production.approve'],csr_supervisor:['forms.upload'],warehouse_supervisor:['forms.view','forms.fill.inventory']};
  for(const [key,added]of Object.entries(additions))db.run('UPDATE roles SET permissions=? WHERE key=?',JSON.stringify(roleDefaults(key).filter(p=>!added.includes(p))),key);
  // An intentionally customized manager and a deleted unused supervisor must stay that way.
  db.run("UPDATE roles SET permissions='[\"mobile.access\"]' WHERE key='production_manager'");
  db.run("DELETE FROM roles WHERE key='warehouse_supervisor'");
  db.run("DELETE FROM settings WHERE key='role_permission_followup_v1'");
  const before=db.queryAll('SELECT * FROM users ORDER BY id');db.closeAllConnections();db.init();
  expect(db.queryAll('SELECT * FROM users ORDER BY id')).toEqual(before);
  expect(JSON.parse(db.queryOne<any>("SELECT permissions FROM roles WHERE key='csr_supervisor'")!.permissions)).toContain('forms.upload');
  expect(JSON.parse(db.queryOne<any>("SELECT permissions FROM roles WHERE key='production_manager'")!.permissions)).toEqual(['mobile.access']);
  expect(db.queryOne("SELECT key FROM roles WHERE key='warehouse_supervisor'")).toBeUndefined();
  db.run("UPDATE roles SET permissions='[\"mobile.access\"]' WHERE key='csr_supervisor'");db.closeAllConnections();db.init();
  expect(JSON.parse(db.queryOne<any>("SELECT permissions FROM roles WHERE key='csr_supervisor'")!.permissions)).toEqual(['mobile.access']);
});
