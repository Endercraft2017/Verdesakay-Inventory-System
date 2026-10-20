/** Authorization audit regressions. All fixtures are disposable; no workspace accounts are changed. */
import { beforeAll, afterAll, it, expect } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';
import type { AuthUser } from '../src/shared/types';
let ctx: TestContext, admin: string;
let db: typeof import('../src/shared/db');
let analytics: typeof import('../src/modules/ai/ai-analytics');
const H = (token = admin) => ({Authorization: `Bearer ${token}`});
const auditUser: AuthUser = {id: 1,username:'probe',full_name:'Probe',role:'marketing',active:1,
  department_id:null,department_name:null,permissions:['audit.view']};
beforeAll(async()=>{ctx=await setupApp();admin=await login(ctx.api);db=await import('../src/shared/db');analytics=await import('../src/modules/ai/ai-analytics');});
afterAll(()=>cleanup(ctx));
it('AUDIT-01: audit.view SQL tool cannot expose pay through SQL',()=>{
  db.run("INSERT INTO employees(name,daily_rate) VALUES('Audit synthetic employee',789.12)");
  const result=analytics.executeAnalyticsTool('run_analytics_query',{sql:"SELECT daily_rate FROM employees WHERE name='Audit synthetic employee'"},auditUser);
  expect(result.success).toBe(false);
});
it('AUDIT-02: quoted users SQL is rejected',()=>{
  const result=analytics.executeAnalyticsTool('run_analytics_query',{sql:'SELECT * FROM "users" LIMIT 1'},auditUser);
  expect(result.success).toBe(false);
});
it('AUDIT-03: audit.view SQL tool cannot read MFA secrets',()=>{
  db.run("INSERT INTO user_mfa(user_id,secret) VALUES(1,'AUDIT_SYNTHETIC_SECRET')");
  const result=analytics.executeAnalyticsTool('run_analytics_query',{sql:'SELECT secret FROM user_mfa WHERE user_id=1'},auditUser);
  expect(result.success).toBe(false);
});
it('AUDIT-04: purchase-request approver cannot approve own cash request',async()=>{
  const account=await createEmployee(ctx.api,admin,{role:'purchase_approver'});
  const create=await ctx.api.post('/api/purchasing/requests').set(H(account.token)).send({reason:'Synthetic audit purchase',items:[{name:'Audit supply',quantity:1,estimated_unit_price:100}]});
  expect(create.status).toBe(201);
  const approval=await ctx.api.post(`/api/purchasing/requests/${create.body.id}/approve`).set(H(account.token))
    .send({approved_budget:100,purchase_mode:'requester_cash'});
  expect(approval.status).toBe(403);
  const row=db.queryOne<any>('SELECT requested_by,decided_by,buyer_id FROM purchase_requests WHERE id=?',create.body.id)!;
  expect(row.decided_by).toBeNull();
});
it('AUDIT-05: another ordinary account cannot read or delete someone else’s problem photos',async()=>{
  const a=await createEmployee(ctx.api,admin,{role:'marketing'}),b=await createEmployee(ctx.api,admin,{role:'marketing'});
  const photo=await ctx.api.post('/api/attachments').set(H(a.token)).field('kind','problem').field('ref_id','12345').attach('image',Buffer.from('audit-photo'),'audit.png');
  expect(photo.status).toBe(201);
  expect((await ctx.api.get('/api/attachments?kind=problem&ref_id=12345').set(H(b.token))).body.some((r:any)=>r.id===photo.body.id)).toBe(false);
  expect((await ctx.api.get(`/api/attachments/${photo.body.id}/image`).set(H(b.token))).status).toBe(403);
  expect((await ctx.api.delete(`/api/attachments/${photo.body.id}`).set(H(b.token))).status).toBe(403);
});
it('AUDIT-06: warehouse cannot add unit/build evidence without a production task',async()=>{
  const warehouse=await createEmployee(ctx.api,admin,{role:'warehouse'});
  const photo=await ctx.api.post('/api/attachments').set(H()).field('kind','qc_unit').field('ref_id','5678').attach('image',Buffer.from('audit-unit'),'audit.png');
  expect(photo.status).toBe(404);
  expect((await ctx.api.post('/api/attachments').set(H(warehouse.token)).field('kind','qc_unit').field('ref_id','5678').attach('image',Buffer.from('blocked'),'audit.png')).status).toBe(403);
});
it('AUDIT-07: stock adjustment cannot sell without release permission or sales authorization',async()=>{
  const warehouse=await createEmployee(ctx.api,admin,{role:'warehouse'});
  const product=(await ctx.api.post('/api/inventory').set(H()).send({name:'Audit ready unit',quantity:1})).body.id;
  const part=(await ctx.api.post('/api/inventory').set(H()).send({name:'Audit unit part',quantity:10})).body.id;
  expect((await ctx.api.put(`/api/finished-products/${product}`).set(H()).send({components:[{component_item_id:part,quantity:1}]})).status).toBe(200);
  const jo=(await ctx.api.post('/api/job-orders').set(H()).send({product_item_id:product,qty_ordered:1,qc_stages:1})).body.id;
  expect(jo).toBeTypeOf('number');
  const loc=(await ctx.api.get('/api/locations').set(H())).body[0].id;
  const unit=Number(db.run("INSERT INTO job_order_units(job_order_id,product_item_id,identifier,status,stage,location_id) VALUES(?,?,'AUDIT-DIRECT-SALE','in_stock',1,?)",jo,product,loc).lastInsertRowid);
  const order=(await ctx.api.post('/api/orders').set(H()).send({type:'sale',status:'open',customer_name:'Audit unapproved sale',location_id:loc,items:[{item_id:product,name:'Audit ready unit',quantity:1,unit_price:25}]})).body.id;
  const r=await ctx.api.post(`/api/finished-products/${product}/units/allocate`).set(H(warehouse.token)).send({action:'sell',order_id:order,unit_ids:[unit],build_mode:'assembled',reason:'Synthetic audit sale'});
  expect(r.status).toBe(403);
  expect(db.queryOne<any>('SELECT status FROM job_order_units WHERE id=?',unit)!.status).toBe('in_stock');
});
it('AUDIT-08: warehouse cannot inspect or restock customer returns',async()=>{
  const warehouse=await createEmployee(ctx.api,admin,{role:'warehouse'});
  await ctx.api.put('/api/release-slips/policy').set(H()).send({authorization_required:false});
  const item=(await ctx.api.post('/api/inventory').set(H()).send({name:'Audit returned bulk',quantity:2,unit_cost:10})).body.id;
  const order=(await ctx.api.post('/api/orders').set(H()).send({type:'sale',status:'approved',customer_name:'Audit customer',items:[{item_id:item,name:'Audit returned bulk',quantity:1,unit_price:30}]})).body.id;
  expect((await ctx.api.post(`/api/orders/${order}/accept-release`).set(H())).status).toBe(200);
  expect((await ctx.api.post(`/api/orders/${order}/release`).set(H()).send({bulk:[{item_id:item,quantity:1}]})).status).toBe(200);
  const issued=await ctx.api.post(`/api/orders/${order}/release-slip`).set(H()).send({collected_by:'Audit driver'});expect(issued.status).toBe(201);
  const slip=(await ctx.api.get(`/api/release-slips/${issued.body.id}`).set(H())).body;
  const photo=await ctx.api.post('/api/attachments').set(H()).field('kind','sales_return_proof').field('ref_id',String(slip.id)).attach('image',Buffer.from('audit-return'),'audit.png');expect(photo.status).toBe(201);
  const received=await ctx.api.post('/api/sales-returns').set(H(warehouse.token)).send({slip_id:slip.id,slip_item_id:slip.items[0].id,quantity:1,reason:'Synthetic audit return',evidence_ids:[photo.body.id]});expect(received.status).toBe(201);
  const inspected=await ctx.api.post(`/api/sales-returns/${received.body.id}/inspect`).set(H(warehouse.token)).send({decision:'restock',condition_note:'Synthetic check'});expect(inspected.status).toBe(403);
});
it('AUDIT-09: users.manage cannot promote oneself to Administrator',async()=>{
  const account=await createEmployee(ctx.api,admin,{role:'marketing'});
  expect((await ctx.api.put(`/api/users/${account.id}/permissions`).set(H()).send({overrides:{'users.manage':true}})).status).toBe(200);
  const promotion=await ctx.api.put(`/api/users/${account.id}`).set(H(account.token)).send({role:'admin'});
  expect(promotion.status).toBe(403);
  expect((await ctx.api.get('/api/auth/me').set(H(account.token))).body.user.role).toBe('marketing');
});
it('AUDIT-10: cached mutation responses are blocked after permission revocation',async()=>{
  const account=await createEmployee(ctx.api,admin,{role:'marketing'});
  await ctx.api.put(`/api/users/${account.id}/permissions`).set(H()).send({overrides:{'users.manage':true,'users.permissions':true,'security.manage':true}});
  const payload={label:'Audit cached role',permissions:['mobile.access']};
  const first=await ctx.api.post('/api/roles').set(H(account.token)).set('Idempotency-Key','audit-role-response-001').send(payload);expect(first.status).toBe(201);
  await ctx.api.put(`/api/users/${account.id}/permissions`).set(H()).send({overrides:{'users.manage':true,'users.permissions':false,'security.manage':false}});
  expect((await ctx.api.post('/api/roles').set(H(account.token)).send({...payload,label:'Audit blocked role'})).status).toBe(403);
  const replay=await ctx.api.post('/api/roles').set(H(account.token)).set('Idempotency-Key','audit-role-response-001').send(payload);
  expect(replay.status).toBe(409);expect(replay.body.code).toBe('saved_access_changed');
});

it('AUDIT-11: audit.view cannot read private note contents through the activity log',async()=>{
  const owner=await createEmployee(ctx.api,admin,{role:'marketing'}),reader=await createEmployee(ctx.api,admin,{role:'marketing'});
  await ctx.api.put(`/api/users/${reader.id}/permissions`).set(H()).send({overrides:{'audit.view':true}});
  const created=await ctx.api.post('/api/notes').set(H(owner.token)).send({title:'Audit private note',body:'AUDIT_ONLY_PRIVATE_TEXT'});expect(created.status).toBe(201);
  const log=await ctx.api.get('/api/activity?entity=personal').set(H(reader.token));expect(log.status).toBe(200);
  expect(JSON.stringify(log.body)).not.toContain('AUDIT_ONLY_PRIVATE_TEXT');
});

it('AUDIT-12: a CSR order editor cannot disable company-wide release authorization',async()=>{
  const csr=await createEmployee(ctx.api,admin,{role:'csr'});
  const changed=await ctx.api.put('/api/release-slips/policy').set(H(csr.token)).send({authorization_required:false});
  expect(changed.status).toBe(403);
});
it('AUDIT-13: AI knowledge retrieval denies purchasing notes to a sales-only permission',async()=>{
  const created=await ctx.api.post('/api/orders').set(H()).send({type:'purchase',supplier_name:'Audit supplier',notes:'quartz purchasing confidential marker',items:[{name:'Audit raw part',quantity:1,unit_price:25}]});
  expect(created.status).toBe(201);
  const rag=await import('../src/modules/ai/rag');rag.reindex();
  const found=rag.retrieve('quartz purchasing confidential marker',{...auditUser,permissions:['orders.view']},{source_types:['order_note']});
  expect(found.some(r=>r.snippet.includes('quartz purchasing confidential marker'))).toBe(false);
});
it('AUDIT-14: inventory.create-only CSV import cannot change existing inventory without inventory.edit',async()=>{
  const account=await createEmployee(ctx.api,admin,{role:'marketing'});
  expect((await ctx.api.put(`/api/users/${account.id}/permissions`).set(H()).send({overrides:{'inventory.create':true}})).status).toBe(200);
  const created=await ctx.api.post('/api/inventory').set(H()).send({name:'Audit protected master item',sku:'AUDIT-IMPORT-EXISTING',quantity:0});expect(created.status).toBe(201);
  expect((await ctx.api.put(`/api/inventory/${created.body.id}`).set(H(account.token)).send({name:'Not allowed direct edit'})).status).toBe(403);
  const imported=await ctx.api.post('/api/inventory/import').set(H(account.token)).send({csv:'name,sku\nAudit changed by create-only importer,AUDIT-IMPORT-EXISTING'});
  expect(imported.status).toBe(200);expect(imported.body.updated).toBe(0);expect(imported.body.errors).toHaveLength(1);
  expect(db.queryOne<any>('SELECT name FROM inventory_items WHERE id=?',created.body.id)!.name).toBe('Audit protected master item');
});

it('CSR prepares customer sales and tracks them; a supervisor approves, while operations remain separate',async()=>{
  const csr=await createEmployee(ctx.api,admin,{role:'csr'}),sup=await createEmployee(ctx.api,admin,{role:'csr_supervisor'});
  const customer=await ctx.api.post('/api/customers').set(H(csr.token)).send({name:'CSR Customer'});expect(customer.status).toBe(201);
  expect((await ctx.api.put(`/api/customers/${customer.body.id}`).set(H(csr.token)).send({phone:'09171234567'})).status).toBe(200);
  const sale=await ctx.api.post('/api/orders').set(H(csr.token)).send({type:'sale',customer_id:customer.body.id,customer_name:'CSR Customer',items:[{name:'Service',quantity:1,unit_price:10}]});expect(sale.status).toBe(201);
  expect((await ctx.api.put(`/api/orders/${sale.body.id}`).set(H(csr.token)).send({notes:'Customer follow-up'})).status).toBe(200);
  expect((await ctx.api.get(`/api/orders/${sale.body.id}`).set(H(csr.token))).status).toBe(200);
  expect((await ctx.api.post(`/api/orders/${sale.body.id}/status`).set(H(csr.token)).send({status:'approved'})).status).toBe(403);
  expect((await ctx.api.post(`/api/orders/${sale.body.id}/status`).set(H(sup.token)).send({status:'approved'})).status).toBe(200);
  for(const token of [csr.token,sup.token]) {
    expect((await ctx.api.post('/api/orders').set(H(token)).send({type:'purchase',items:[{name:'Supplier goods',quantity:1,unit_price:1}]})).status).toBe(403);
    expect((await ctx.api.get('/api/orders?type=purchase').set(H(token))).status).toBe(403);
    expect((await ctx.api.post('/api/accounting/payments').set(H(token)).send({})).status).toBe(403);
    expect((await ctx.api.get('/api/hr/employees').set(H(token))).status).toBe(403);
  }
  expect((await ctx.api.post(`/api/orders/${sale.body.id}/release`).set(H(csr.token)).send({})).status).toBe(403);
  expect((await ctx.api.post(`/api/orders/${sale.body.id}/cancel-remainder`).set(H(csr.token)).send({})).status).toBe(403);
});
it('production recorders work only assigned jobs and assignment does not grant a different task',async()=>{
  const lead=await createEmployee(ctx.api,admin,{role:'production_lead'}),other=await createEmployee(ctx.api,admin,{role:'production_lead'});
  const product=(await ctx.api.post('/api/inventory').set(H()).send({name:'Assigned production',quantity:0})).body.id;
  await ctx.api.put(`/api/finished-products/${product}`).set(H()).send({components:[]});
  const jo=(await ctx.api.post('/api/job-orders').set(H()).send({product_item_id:product,qty_ordered:2,qc_stages:0})).body.id;expect(jo).toBeTypeOf('number');
  expect((await ctx.api.get(`/api/job-orders/${jo}`).set(H(lead.token))).status).toBe(403);
  expect((await ctx.api.post(`/api/job-orders/${jo}/progress`).set(H(lead.token)).send({done_delta:1})).body.code).toBe('job_assignment_required');
  expect((await ctx.api.put(`/api/job-orders/${jo}/assignees`).set(H()).send({user_ids:[lead.id]})).status).toBe(200);
  expect((await ctx.api.get(`/api/job-orders/${jo}`).set(H(lead.token))).status).toBe(200);
  expect((await ctx.api.get(`/api/job-orders/${jo}`).set(H(other.token))).status).toBe(403);
  expect((await ctx.api.get('/api/job-orders').set(H(other.token))).body).toEqual([]);
  expect((await ctx.api.put(`/api/job-orders/${jo}/assignees`).set(H(lead.token)).send({user_ids:[other.id]})).status).toBe(403);
  expect((await ctx.api.post(`/api/job-orders/${jo}/approve`).set(H(lead.token)).send({})).status).toBe(403);
});
it('inventory cost values are hidden and cannot be overwritten by a catalog editor',async()=>{
  const csr=await createEmployee(ctx.api,admin,{role:'csr'});
  await ctx.api.put(`/api/users/${csr.id}/permissions`).set(H()).send({overrides:{'inventory.edit':true}});
  const item=(await ctx.api.post('/api/inventory').set(H()).send({name:'Private cost',unit_cost:123,attributes:{std_labor_cost:45,color:'red'}})).body.id;
  const read=await ctx.api.get(`/api/inventory/${item}`).set(H(csr.token));expect(read.status).toBe(200);expect(read.body.unit_cost).toBeUndefined();expect(read.body.attributes.std_labor_cost).toBeUndefined();
  expect((await ctx.api.put(`/api/inventory/${item}`).set(H(csr.token)).send({unit_cost:0})).status).toBe(403);
  expect((await ctx.api.put(`/api/inventory/${item}`).set(H(csr.token)).send({attributes:{color:'blue'}})).status).toBe(200);
  const stored=db.queryOne<any>('SELECT unit_cost,attributes FROM inventory_items WHERE id=?',item)!;expect(stored.unit_cost).toBe(123);expect(JSON.parse(stored.attributes)).toMatchObject({std_labor_cost:45,color:'blue'});
});
it('the built-in migration updates role bundles once, preserves custom roles and every account exception',async()=>{
  const account=await createEmployee(ctx.api,admin,{role:'warehouse'});
  db.run('UPDATE users SET permission_overrides=? WHERE id=?',JSON.stringify({'production.inspect_qa':true}),account.id);
  const before=db.queryAll<any>('SELECT * FROM users ORDER BY id');
  db.run("INSERT INTO roles(key,label,description,permissions) VALUES('custom_audit_role','Custom audit role','custom','[\"inventory.view\"]')");
  db.run("UPDATE roles SET permissions='[\"inventory.adjust\",\"orders.edit\"]' WHERE key='csr'");
  db.run("UPDATE roles SET label='Custom existing timekeeper',permissions='[\"messages.view\"]' WHERE key='timekeeper'");
  db.run("DELETE FROM settings WHERE key='role_audit_profiles_v1'");
  db.closeAllConnections();db.init();
  expect(db.queryAll<any>('SELECT * FROM users ORDER BY id')).toEqual(before);
  const csr=JSON.parse(db.queryOne<any>("SELECT permissions FROM roles WHERE key='csr'")!.permissions);
  expect(csr).toContain('orders.create');expect(csr).not.toContain('inventory.adjust');expect(csr).not.toContain('orders.approve');
  expect(db.queryOne<any>("SELECT permissions FROM roles WHERE key='custom_audit_role'")!.permissions).toBe('["inventory.view"]');
  expect(db.queryOne<any>("SELECT permissions FROM roles WHERE key='timekeeper'")!.permissions).toBe('["messages.view"]');
  db.run("UPDATE roles SET description='Owner edited after migration' WHERE key='csr'");db.closeAllConnections();db.init();
  expect(db.queryOne<any>("SELECT description FROM roles WHERE key='csr'")!.description).toBe('Owner edited after migration');
});

it('account support cannot reset or disable an otherwise ordinary role with privileged overrides',async()=>{
  const support=await createEmployee(ctx.api,admin,{role:'account_support'}),privileged=await createEmployee(ctx.api,admin,{role:'employee'}),ordinary=await createEmployee(ctx.api,admin,{role:'employee'});
  await ctx.api.put(`/api/users/${privileged.id}/permissions`).set(H()).send({overrides:{'users.permissions':true}});
  expect((await ctx.api.post(`/api/users/${privileged.id}/reset-password`).set(H(support.token)).send({new_password:'blocked1234'})).status).toBe(403);
  expect((await ctx.api.put(`/api/users/${privileged.id}`).set(H(support.token)).send({active:false})).status).toBe(403);
  expect((await ctx.api.post(`/api/users/${ordinary.id}/reset-password`).set(H(support.token)).send({new_password:'allowed1234'})).status).toBe(200);
});
it('a counter with separate review authority still cannot approve their own count',async()=>{
  const counter=await createEmployee(ctx.api,admin,{role:'warehouse_supervisor'});
  const item=(await ctx.api.post('/api/inventory').set(H()).send({name:'Independent count',quantity:1})).body.id;
  const c=(await ctx.api.get(`/api/inventory/stock-counts/context?item_id=${item}&location_id=1&build_mode=assembled`).set(H(counter.token))).body;
  const created=await ctx.api.post('/api/inventory/stock-counts').set(H(counter.token)).send({item_id:item,location_id:1,build_mode:'assembled',expected_quantity:c.book_quantity,expected_serial_ids:[],expected_batches:[],counted_untracked:0,counted_serial_codes:[],counted_batches:[],note:'Physical independent count'});
  expect(created.status).toBe(201);
  expect((await ctx.api.post(`/api/inventory/stock-counts/${created.body.id}/approve`).set(H(counter.token)).send({note:'Self approval must be rejected'})).status).toBe(409);
});
it('receivers see supplier goods without acquisition prices; the buyer sees the price',async()=>{
  const warehouse=await createEmployee(ctx.api,admin,{role:'warehouse'}),buyer=await createEmployee(ctx.api,admin,{role:'buyer'});
  const order=(await ctx.api.post('/api/orders').set(H()).send({type:'purchase',supplier_name:'Cost-protected supplier',items:[{name:'Private acquisition',quantity:1,unit_price:765.43}]})).body.id;
  const received=await ctx.api.get(`/api/orders/${order}`).set(H(warehouse.token));expect(received.status).toBe(200);expect(received.body.total).toBeUndefined();expect(received.body.items[0].unit_price).toBeUndefined();expect(JSON.stringify(received.body)).not.toContain('765.43');
  const prepared=await ctx.api.get(`/api/orders/${order}`).set(H(buyer.token));expect(prepared.body.items[0].unit_price).toBe(765.43);
});
it('the assistant cannot bypass stock authority or change an approved sale without the review workflow',async()=>{
  const ai=await import('../src/modules/ai/ai-tools');
  const editor={...auditUser,role:'csr',permissions:['orders.edit','orders.create','inventory.create'] as AuthUser['permissions']};
  expect((await ai.executeTool('create_inventory_item',{name:'Blocked starting stock',quantity:10},editor)).success).toBe(false);
  const sale=(await ctx.api.post('/api/orders').set(H()).send({type:'sale',status:'approved',items:[{name:'Approved service',quantity:1,unit_price:1}]})).body.id;
  expect((await ai.executeTool('update_order',{id:sale,notes:'Must not reopen'},editor)).success).toBe(false);
  expect(db.queryOne<any>('SELECT status FROM orders WHERE id=?',sale)!.status).toBe('approved');
});
it('finance preparation cannot read employee tax detail, change deductions, issue credit, or move cash',async()=>{
  const clerk=await createEmployee(ctx.api,admin,{role:'accounting'});
  for(const path of ['/bir-2316','/bir-alphalist','/contribution-schedule','/statutory-deductions']) expect((await ctx.api.get('/api/accounting'+path).set(H(clerk.token))).status).toBe(403);
  expect((await ctx.api.put('/api/accounting/statutory-deductions').set(H(clerk.token)).send({updates:[]})).status).toBe(403);
  for(const path of ['/credit-notes','/petty-cash/funds/1/entries']) expect((await ctx.api.post('/api/accounting'+path).set(H(clerk.token)).send({})).status).toBe(403);
});
it('a production planner can select components, save a BOM, plan and assign a job, without cost or inspection authority',async()=>{
  const planner=await createEmployee(ctx.api,admin,{role:'production_planner'});
  const product=(await ctx.api.post('/api/inventory').set(H()).send({name:'Planner product',quantity:0})).body.id;
  const part=(await ctx.api.post('/api/inventory').set(H()).send({name:'Planner component',quantity:5})).body.id;
  expect((await ctx.api.get('/api/inventory').set(H(planner.token))).status).toBe(200);
  expect((await ctx.api.get('/api/production/employees').set(H(planner.token))).status).toBe(200);
  expect((await ctx.api.put(`/api/finished-products/${product}`).set(H(planner.token)).send({components:[{component_item_id:part,quantity:1}]})).status).toBe(200);
  expect((await ctx.api.put(`/api/finished-products/${product}`).set(H(planner.token)).send({components:[],std_labor_cost:1})).status).toBe(403);
  expect((await ctx.api.get(`/api/finished-products/${product}/cost`).set(H(planner.token))).status).toBe(403);
  const job=await ctx.api.post('/api/job-orders').set(H(planner.token)).send({product_item_id:product,qty_ordered:1,qc_stages:1});expect(job.status).toBe(201);
  expect((await ctx.api.post(`/api/job-orders/${job.body.id}/approve`).set(H(planner.token)).send({})).status).toBe(403);
  const lead=await createEmployee(ctx.api,admin,{role:'production_lead'});
  expect((await ctx.api.put(`/api/job-orders/${job.body.id}/assignees`).set(H(planner.token)).send({user_ids:[lead.id]})).status).toBe(200);
});
