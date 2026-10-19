import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, addSerializedUnits, type TestContext } from './helpers';

let ctx:TestContext;
let admin:string;
let warehouse:string;
let warehouseId:number;
const H=(token:string)=>({Authorization:`Bearer ${token}`});
beforeAll(async()=>{
  ctx=await setupApp();
  admin=await login(ctx.api);
  const worker=await createEmployee(ctx.api,admin,{role:'warehouse'});
  warehouse=worker.token;warehouseId=worker.id;
});
afterAll(()=>cleanup(ctx));
const item=async(name:string,quantity=0)=>(await ctx.api.post('/api/inventory').set(H(admin)).send({name,quantity})).body.id as number;
const context=async(id:number,location=1,mode='assembled')=>(await ctx.api.get(
  `/api/inventory/stock-counts/context?item_id=${id}&location_id=${location}&build_mode=${mode}`).set(H(warehouse))).body;
const submit=async(c:any,changes:Record<string,unknown>={})=>ctx.api.post('/api/inventory/stock-counts').set(H(warehouse)).send({
  item_id:c.item_id,location_id:c.location_id,build_mode:c.build_mode,expected_quantity:c.book_quantity,
  expected_serial_ids:c.serials.map((s:any)=>s.id),
  expected_batches:c.batches.map((b:any)=>({batch_id:b.batch_id,quantity:b.quantity})),
  counted_untracked:c.untracked_quantity,
  counted_serial_codes:c.serials.map((s:any)=>s.code),
  counted_batches:c.batches.map((b:any)=>({batch_id:b.batch_id,quantity:b.quantity})),
  note:'Counted the exact warehouse shelf',...changes,
});

describe('physical stock count',()=>{
  it('plans one exact stock position, assigns its count, and creates the next recurring check only after reconciliation',async()=>{
    const itemId=await item('Cycle count bolts',5);
    const due=new Date(Date.now()+2*86400000).toISOString().slice(0,10);
    const plan=()=>ctx.api.post('/api/inventory/stock-counts/tasks').set(H(admin)).send({
      item_id:itemId,location_id:1,build_mode:'assembled',assigned_to:warehouseId,due_date:due,
      repeat_days:30,note:'Check the labelled bolts shelf',
    });
    const created=await plan();
    expect(created.status).toBe(201);
    const taskId=created.body.id;
    expect(created.body).toMatchObject({status:'open',assigned_to:warehouseId,overdue:false});
    expect((await plan()).body.code).toBe('task_exists');
    const coverage=(await ctx.api.get('/api/inventory/stock-counts/tasks/coverage').set(H(admin))).body;
    expect(coverage).toEqual(expect.arrayContaining([expect.objectContaining({item_id:itemId,location_id:1,
      open_task_id:taskId,last_count_at:null})]));
    expect((await submit(await context(itemId),{counted_untracked:4})).body.code).toBe('planned_task_required');
    const wrongWorker=await ctx.api.post('/api/inventory/stock-counts').set(H(admin)).send({
      item_id:itemId,location_id:1,build_mode:'assembled',expected_quantity:5,expected_serial_ids:[],expected_batches:[],
      counted_untracked:4,counted_serial_codes:[],counted_batches:[],note:'I counted this exact stock shelf',task_id:taskId,
    });
    expect(wrongWorker.body.code).toBe('task_mismatch');
    const counted=await submit(await context(itemId),{task_id:taskId,counted_untracked:4});
    expect(counted.status).toBe(201);
    expect(counted.body).toMatchObject({task_id:taskId,task_status:'open'});
    expect((await submit(await context(itemId),{task_id:taskId,counted_untracked:4})).body.code).toBe('task_in_progress');
    expect((await ctx.api.put(`/api/inventory/stock-counts/tasks/${taskId}`).set(H(admin)).send({
      assigned_to:warehouseId,due_date:due,repeat_days:30,note:'Trying to edit an active count',
    })).status).toBe(409);
    expect((await ctx.api.post(`/api/inventory/stock-counts/tasks/${taskId}/cancel`).set(H(admin))
      .send({note:'Trying to cancel an active count'})).status).toBe(409);
    expect((await ctx.api.post(`/api/inventory/stock-counts/${counted.body.id}/approve`).set(H(warehouse))
      .send({note:'I checked the assigned count'})).status).toBe(409);
    expect((await ctx.api.post(`/api/inventory/stock-counts/${counted.body.id}/approve`).set(H(admin))
      .send({note:'Independently approved cycle count'})).status).toBe(200);
    expect((await ctx.api.get(`/api/inventory/stock-counts/tasks?status=open&mine=1`).set(H(warehouse))).body)
      .toEqual(expect.arrayContaining([expect.objectContaining({id:taskId,latest_count_status:'approved'})]));
    const applied=await ctx.api.post(`/api/inventory/stock-counts/${counted.body.id}/apply`).set(H(admin)).send({});
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({status:'applied',task_status:'completed',current_quantity:4});
    expect((await ctx.api.post(`/api/inventory/stock-counts/${counted.body.id}/apply`).set(H(admin)).send({})).status).toBe(200);
    const tasks=(await ctx.api.get('/api/inventory/stock-counts/tasks?status=all').set(H(admin))).body;
    expect(tasks.filter((t:any)=>t.item_id===itemId)).toHaveLength(2);
    expect(tasks).toEqual(expect.arrayContaining([expect.objectContaining({id:taskId,status:'completed'}),
      expect.objectContaining({previous_task_id:taskId,status:'open',repeat_days:30})]));
    expect((await ctx.api.get('/api/inventory/stock-counts/tasks/coverage').set(H(admin))).body)
      .toEqual(expect.arrayContaining([expect.objectContaining({item_id:itemId,last_count_at:expect.any(String)})]));
    expect((await ctx.api.get(`/api/inventory/${itemId}`).set(H(admin))).body.quantity).toBe(4);
    const semi=await ctx.api.post('/api/inventory/stock-counts/tasks').set(H(admin)).send({
      item_id:itemId,location_id:1,build_mode:'semi_built',assigned_to:warehouseId,due_date:due,
      note:'Check the separate semi-built balance',
    });
    expect(semi.status).toBe(201);
    expect(semi.body.build_mode).toBe('semi_built');
  });

  it('keeps an overdue assignment open after rejection, allows recount, and supports supervised cancellation',async()=>{
    const itemId=await item('Overdue shelf checks',3);
    const due='2020-01-01';
    const created=await ctx.api.post('/api/inventory/stock-counts/tasks').set(H(admin)).send({
      item_id:itemId,location_id:1,build_mode:'assembled',assigned_to:warehouseId,due_date:due,
      repeat_days:null,note:'Count this shelf after the stock discrepancy',
    });
    expect(created.status).toBe(201);
    expect(created.body.overdue).toBe(true);
    const taskId=created.body.id;
    const first=await submit(await context(itemId),{task_id:taskId,counted_untracked:2});
    expect(first.status).toBe(201);
    await ctx.api.post(`/api/inventory/${itemId}/adjust`).set(H(admin))
      .send({change:1,reason:'Received another box before review'});
    const stale=await ctx.api.post(`/api/inventory/stock-counts/${first.body.id}/approve`).set(H(admin))
      .send({note:'I checked the old shelf snapshot'});
    expect(stale.body.code).toBe('stale_count');
    expect((await ctx.api.post(`/api/inventory/stock-counts/${first.body.id}/reject`).set(H(admin))
      .send({note:'The shelf labels need another check'})).status).toBe(200);
    const open=(await ctx.api.get('/api/inventory/stock-counts/tasks?status=open').set(H(admin))).body;
    expect(open).toEqual(expect.arrayContaining([expect.objectContaining({id:taskId,overdue:true,latest_count_status:'rejected'})]));
    const second=await submit(await context(itemId),{task_id:taskId,counted_untracked:4});
    expect(second.status).toBe(201);
    expect(second.body.id).not.toBe(first.body.id);
    await ctx.api.post(`/api/inventory/stock-counts/${second.body.id}/approve`).set(H(admin))
      .send({note:'Verified this second shelf observation'});
    expect((await ctx.api.post(`/api/inventory/stock-counts/${second.body.id}/verify`).set(H(admin))
      .send({note:'No stock movement needed after recount'})).status).toBe(200);
    expect((await ctx.api.get('/api/inventory/stock-counts/tasks?status=completed').set(H(admin))).body)
      .toEqual(expect.arrayContaining([expect.objectContaining({id:taskId,status:'completed'})]));
    const another=await ctx.api.post('/api/inventory/stock-counts/tasks').set(H(admin)).send({
      item_id:itemId,location_id:1,build_mode:'assembled',assigned_to:warehouseId,due_date:due,note:'One more shelf check',
    });
    expect(another.status).toBe(201);
    const edited=await ctx.api.put(`/api/inventory/stock-counts/tasks/${another.body.id}`).set(H(admin)).send({
      assigned_to:warehouseId,due_date:'2020-01-02',repeat_days:14,note:'Updated shelf inspection instructions',
    });
    expect(edited.body).toMatchObject({due_date:'2020-01-02',repeat_days:14,note:'Updated shelf inspection instructions'});
    const cancelled=await ctx.api.post(`/api/inventory/stock-counts/tasks/${another.body.id}/cancel`).set(H(admin))
      .send({note:'This check was scheduled in error'});
    expect(cancelled.body).toMatchObject({status:'cancelled',cancel_note:'This check was scheduled in error'});
    expect((await ctx.api.get('/api/inventory/stock-counts/tasks?status=open').set(H(admin))).body
      .some((t:any)=>t.id===another.body.id)).toBe(false);
    const emptyId=await item('Empty shelf position');
    const nonCounter=await createEmployee(ctx.api,admin,{role:'hr'});
    expect((await ctx.api.post('/api/inventory/stock-counts/tasks').set(H(admin)).send({
      item_id:emptyId,location_id:1,build_mode:'assembled',assigned_to:nonCounter.id,due_date:due,
    })).status).toBe(400);
    const empty=await ctx.api.post('/api/inventory/stock-counts/tasks').set(H(admin)).send({
      item_id:emptyId,location_id:1,build_mode:'assembled',assigned_to:warehouseId,due_date:due,
      note:'Confirm that this shelf is empty',
    });
    expect(empty.status).toBe(201);
    expect((await ctx.api.get('/api/inventory/stock-counts/tasks/coverage').set(H(admin))).body)
      .toEqual(expect.arrayContaining([expect.objectContaining({item_id:emptyId,quantity:0,open_task_id:empty.body.id})]));
    expect((await ctx.api.post('/api/inventory/stock-counts/tasks').set(H(admin)).send({
      item_id:emptyId,location_id:1,build_mode:'semi_built',assigned_to:warehouseId,due_date:'2020-02-30',
    })).status).toBe(400);
  });

  it('lets an assigned worker observe and reconcile a negative book balance',async()=>{
    const itemId=await item('Overdrawn cycle shelf');
    const {run}=await import('../src/shared/db');
    // An offline overdraw can persist a negative book position that online stock-out refuses.
    run('UPDATE inventory_items SET quantity=-1 WHERE id=?',itemId);
    run('INSERT INTO inventory_stock(item_id,location_id,quantity) VALUES(?,1,-1)',itemId);
    run("INSERT INTO inventory_variant_stock(item_id,location_id,build_mode,quantity) VALUES(?,1,'assembled',-1)",itemId);
    const c=await context(itemId);
    expect(c).toMatchObject({book_quantity:-1,untracked_quantity:-1});
    const task=(await ctx.api.post('/api/inventory/stock-counts/tasks').set(H(admin)).send({
      item_id:itemId,location_id:1,build_mode:'assembled',assigned_to:warehouseId,
      due_date:new Date().toISOString().slice(0,10),note:'Check the overdrawn shelf',
    })).body;
    const created=await submit(c,{task_id:task.id,counted_untracked:0});
    expect(created.status).toBe(201);
    await ctx.api.post(`/api/inventory/stock-counts/${created.body.id}/approve`).set(H(admin))
      .send({note:'Verified the shelf really is empty'});
    const applied=await ctx.api.post(`/api/inventory/stock-counts/${created.body.id}/apply`).set(H(admin)).send({});
    expect(applied.body).toMatchObject({status:'applied',current_quantity:0,task_status:'completed'});
  });

  it('closes a linked discrepancy only after reconciliation and preserves the count reference on retry',async()=>{
    const itemId=await item('Discrepancy shelf item',5);
    const {run,queryOne}=await import('../src/shared/db');
    const source=Number(run(`INSERT INTO stock_discrepancies(item_id,location_id,change,location_balance_after,reason)
      VALUES(?,?,?,?,?)`,itemId,1,-1,5,'Offline stock-out needs verification').lastInsertRowid);
    const c=await context(itemId);
    const created=await submit(c,{source_kind:'discrepancy',source_id:source,counted_untracked:4});
    expect(created.status).toBe(201);
    const path=`/api/inventory/stock-counts/${created.body.id}`;
    const close=(token:string,note='Verified physical shelf and corrected one missing item')=>
      ctx.api.post(`${path}/close-source`).set(H(token)).send({note});
    expect((await close(admin)).status).toBe(409);
    expect((await ctx.api.post(`${path}/approve`).set(H(admin)).send({note:'Approved exact shelf observation'})).status).toBe(200);
    expect((await close(admin)).status).toBe(409);
    expect((await ctx.api.post(`${path}/apply`).set(H(admin)).send({})).status).toBe(200);
    expect((await ctx.api.post(`${path}/close-source`).send({note:'Verified physical shelf and corrected one missing item'})).status).toBe(401);
    expect((await close(admin)).body).toMatchObject({source_status:'resolved',source_close_note:'Verified physical shelf and corrected one missing item'});
    expect((await close(admin)).status).toBe(200);
    expect((await close(admin,'Different later decision')).status).toBe(409);
    const resolution=queryOne<{resolution_note:string;status:string}>(
      'SELECT resolution_note,status FROM stock_discrepancies WHERE id=?',source)!;
    expect(resolution).toMatchObject({status:'resolved',resolution_note:`Physical count #${created.body.id}: Verified physical shelf and corrected one missing item`});
    expect((await ctx.api.get(`/api/inventory/${itemId}`).set(H(admin))).body.quantity).toBe(4);
    expect((await submit(await context(itemId),{source_kind:'discrepancy',source_id:source})).status).toBe(409);
  });

  it('requires current physical evidence before linked issue closure',async()=>{
    const itemId=await item('Moving discrepancy item',3);
    const {run}=await import('../src/shared/db');
    const source=Number(run(`INSERT INTO stock_discrepancies(item_id,location_id,change,location_balance_after,reason)
      VALUES(?,?,?,?,?)`,itemId,1,-1,3,'Offline count finding').lastInsertRowid);
    const created=await submit(await context(itemId),{source_kind:'discrepancy',source_id:source,counted_untracked:2});
    const path=`/api/inventory/stock-counts/${created.body.id}`;
    await ctx.api.post(`${path}/approve`).set(H(admin)).send({note:'Approved after physical verification'});
    await ctx.api.post(`${path}/apply`).set(H(admin)).send({});
    await ctx.api.post(`/api/inventory/${itemId}/adjust`).set(H(admin)).send({change:1,reason:'A new box arrived'});
    const blocked=await ctx.api.post(`${path}/close-source`).set(H(admin))
      .send({note:'I reviewed the corrected shelf count'});
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('stale_count');
    expect((await ctx.api.get('/api/inventory/discrepancies').set(H(admin))).body
      .some((d:any)=>d.id===source)).toBe(true);
  });

  it('records a count, requires an independent reviewer, and applies only its untracked variance once',async()=>{
    const id=await item('Counted bolts',5),c=await context(id);
    expect(c).toMatchObject({book_quantity:5,untracked_quantity:5,serials:[],batches:[]});
    const created=await submit(c,{counted_untracked:3});
    expect(created.status).toBe(201);
    const countId=created.body.id;
    expect(created.body).toMatchObject({book_quantity:5,counted_quantity:3,variance:-2,status:'submitted'});
    expect((await ctx.api.post(`/api/inventory/stock-counts/${countId}/approve`).set(H(warehouse))
      .send({note:'Verified the shelf count and signed off'})).status).toBe(409);
    expect((await ctx.api.post(`/api/inventory/stock-counts/${countId}/apply`).set(H(admin)).send({})).status).toBe(409);
    expect((await ctx.api.post(`/api/inventory/stock-counts/${countId}/approve`).set(H(admin))
      .send({note:'Verified the shelf count and signed off'})).status).toBe(200);
    const applied=await ctx.api.post(`/api/inventory/stock-counts/${countId}/apply`).set(H(admin)).send({});
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({status:'applied',current_quantity:3});
    expect(applied.body.transaction_id).toBeTypeOf('number');
    expect((await ctx.api.post(`/api/inventory/stock-counts/${countId}/apply`).set(H(admin)).send({})).status).toBe(200);
    const detail=(await ctx.api.get(`/api/inventory/${id}`).set(H(admin))).body;
    expect(detail.quantity).toBe(3);
    expect(detail.history.filter((t:any)=>String(t.reason).startsWith(`Stock count #${countId}:`))).toHaveLength(1);
  });

  it('rejects stale counts before approval and rejects a stale snapshot at submission',async()=>{
    const id=await item('Moving washers',4),c=await context(id);
    const created=await submit(c,{counted_untracked:4});
    expect(created.status).toBe(201);
    await ctx.api.post(`/api/inventory/${id}/adjust`).set(H(admin)).send({change:1,reason:'Received another box'});
    const approve=await ctx.api.post(`/api/inventory/stock-counts/${created.body.id}/approve`).set(H(admin))
      .send({note:'Checked against a current count'});
    expect(approve.status).toBe(409);
    expect(approve.body.code).toBe('stale_count');
    const stale=await submit(c,{counted_untracked:4});
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('stale_count');
  });

  it('blocks generic correction when a serialized unit is missing from the count',async()=>{
    const product=await item('Tracked count product');
    const part=await item('Tracked count component',10);
    await ctx.api.put(`/api/finished-products/${product}`).set(H(admin))
      .send({components:[{component_item_id:part,quantity:1}]});
    const mo=(await ctx.api.post('/api/job-orders').set(H(admin))
      .send({product_item_id:product,qty_ordered:1,qc_stages:1})).body.id;
    await ctx.api.post(`/api/job-orders/${mo}/approve`).set(H(admin));
    await ctx.api.post('/api/job-orders/warehouse-accept').set(H(admin)).send({job_order_ids:[mo]});
    await ctx.api.post('/api/job-orders/prepare').set(H(admin)).send({job_orders:[{id:mo}]});
    await ctx.api.post(`/api/job-orders/${mo}/release`).set(H(admin));
    await ctx.api.post(`/api/job-orders/${mo}/accept`).set(H(admin));
    await addSerializedUnits(ctx.api,admin,mo,1,'COUNT-SERIAL');
    const pending=(await ctx.api.get(`/api/job-orders/${mo}/units`).set(H(admin))).body[0];
    await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(H(admin))
      .send({unit_ids:[pending.id],result:'pass',identifier:'COUNT-SERIAL-1'});
    const receivable=(await ctx.api.get(`/api/job-orders/${mo}/receivable`).set(H(admin))).body;
    await ctx.api.post(`/api/job-orders/${mo}/products-in`).set(H(admin))
      .send({location_id:receivable.output_location_id,unit_ids:receivable.units.map((u:any)=>u.id)});
    const c=await context(product,receivable.output_location_id);
    expect(c.serials).toHaveLength(1);
    const generic=await ctx.api.post(`/api/inventory/${product}/adjust`).set(H(admin))
      .send({location_id:receivable.output_location_id,change:-1,reason:'Count loss'});
    expect(generic.status).toBe(409);
    expect(generic.body.code).toBe('use_unit_workflow');
    const damage=await ctx.api.post(`/api/inventory/${product}/damage`).set(H(admin))
      .send({location_id:receivable.output_location_id,quantity:1,reason:'Missing unit'});
    expect(damage.status).toBe(409);
    expect(damage.body.code).toBe('use_unit_workflow');
    const created=await submit(c,{counted_serial_codes:[]});
    expect(created.status).toBe(201);
    expect(created.body.missing_serials).toEqual([expect.objectContaining({
      id:pending.id,code:'COUNT-SERIAL-1',job_order_id:mo,status:'in_stock',
    })]);
    expect(created.body.unexpected_serials).toEqual([]);
    const countId=created.body.id;
    expect((await ctx.api.post(`/api/inventory/stock-counts/${countId}/approve`).set(H(admin))
      .send({note:'Confirmed the serial was absent from the shelf'})).status).toBe(200);
    const blocked=await ctx.api.post(`/api/inventory/stock-counts/${countId}/apply`).set(H(admin)).send({});
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('tracked_resolution_required');
    expect((await ctx.api.get(`/api/inventory/${product}`).set(H(admin))).body.quantity).toBe(1);

    const otherMode=await context(product,receivable.output_location_id,'semi_built');
    const found=await submit(otherMode,{counted_serial_codes:['COUNT-SERIAL-1','UNKNOWN-LABEL']});
    expect(found.status).toBe(201);
    expect(found.body).toMatchObject({counted_quantity:2,missing_serials:[],unexpected_serials:[
      {code:'COUNT-SERIAL-1',matches:[{id:pending.id,job_order_id:mo,status:'in_stock'}]},
      {code:'UNKNOWN-LABEL',matches:[]},
    ]});
    expect((await ctx.api.post(`/api/inventory/stock-counts/${found.body.id}/approve`).set(H(admin))
      .send({note:'Investigate both unexpected unit labels'})).status).toBe(200);
    expect((await ctx.api.post(`/api/inventory/stock-counts/${found.body.id}/apply`).set(H(admin)).send({})).body.code)
      .toBe('tracked_resolution_required');
    expect((await ctx.api.post(`/api/inventory/stock-counts/${found.body.id}/verify`).set(H(admin))
      .send({note:'No exact unit movement has reconciled these labels'})).body.code).toBe('not_reconciled');
    expect((await ctx.api.get(`/api/inventory/${product}`).set(H(admin))).body.quantity).toBe(1);
    expect((await submit(otherMode,{counted_serial_codes:['LABEL','label']})).status).toBe(400);
  });

  it('corrects the exact named batch and links its movement to the approved count',async()=>{
    const product=await item('Tracked batch count product');
    const part=await item('Tracked batch count component',10);
    await ctx.api.put(`/api/finished-products/${product}`).set(H(admin))
      .send({components:[{component_item_id:part,quantity:1}]});
    const mo=(await ctx.api.post('/api/job-orders').set(H(admin))
      .send({product_item_id:product,qty_ordered:2,qc_stages:0})).body.id;
    await ctx.api.post(`/api/job-orders/${mo}/approve`).set(H(admin));
    await ctx.api.post('/api/job-orders/warehouse-accept').set(H(admin)).send({job_order_ids:[mo]});
    await ctx.api.post('/api/job-orders/prepare').set(H(admin)).send({job_orders:[{id:mo}]});
    await ctx.api.post(`/api/job-orders/${mo}/release`).set(H(admin));
    await ctx.api.post(`/api/job-orders/${mo}/accept`).set(H(admin));
    expect((await ctx.api.post(`/api/job-orders/${mo}/progress`).set(H(admin)).send({done_delta:2})).status).toBe(200);
    const receivable=(await ctx.api.get(`/api/job-orders/${mo}/receivable`).set(H(admin))).body;
    expect((await ctx.api.post(`/api/job-orders/${mo}/products-in`).set(H(admin))
      .send({location_id:receivable.output_location_id,batch_id:receivable.batches[0].id,quantity:2})).status).toBe(201);
    const c=await context(product,receivable.output_location_id);
    expect(c.batches).toEqual([expect.objectContaining({quantity:2})]);
    const created=await submit(c,{counted_batches:[{batch_id:c.batches[0].batch_id,quantity:1}]});
    expect(created.status).toBe(201);
    expect((await ctx.api.post(`/api/inventory/stock-counts/${created.body.id}/approve`).set(H(admin))
      .send({note:'Verified the lot sticker and count'})).status).toBe(200);
    const so=(await ctx.api.post('/api/orders').set(H(admin)).send({type:'sale',status:'approved',
      customer_name:'Count reservation',items:[{item_id:product,name:'Tracked batch count product',quantity:2,unit_price:10}]})).body.id;
    await ctx.api.post(`/api/orders/${so}/accept-release`).set(H(admin));
    expect((await ctx.api.post(`/api/orders/${so}/release`).set(H(admin))
      .send({bulk:[{item_id:product,batch_id:c.batches[0].batch_id,quantity:2}]})).status).toBe(200);
    const reserved=await ctx.api.post(`/api/inventory/stock-counts/${created.body.id}/apply`).set(H(admin)).send({});
    expect(reserved.status).toBe(409);
    expect(reserved.body.code).toBe('batch_reserved');
    await ctx.api.post(`/api/orders/${so}/release/unreserve`).set(H(admin)).send({bulk:[{item_id:product,quantity:2}]});
    const applied=await ctx.api.post(`/api/inventory/stock-counts/${created.body.id}/apply`).set(H(admin)).send({});
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({status:'applied',current_quantity:1,
      movements:[{batch_id:c.batches[0].batch_id,change:-1}]});
    const {batchBalances}=await import('../src/modules/inventory/batch-stock');
    expect(batchBalances(c.batches[0].batch_id)[0]?.on_hand).toBe(1);
    expect((await ctx.api.get(`/api/inventory/${product}`).set(H(admin))).body.quantity).toBe(1);
    const fresh=await context(product,receivable.output_location_id);
    const extra=await submit(fresh,{counted_batches:[{batch_id:fresh.batches[0].batch_id,quantity:3}]});
    expect(extra.status).toBe(201);
    await ctx.api.post(`/api/inventory/stock-counts/${extra.body.id}/approve`).set(H(admin))
      .send({note:'Checked the new reported batch count'});
    const provenance=await ctx.api.post(`/api/inventory/stock-counts/${extra.body.id}/apply`).set(H(admin)).send({});
    expect(provenance.status).toBe(409);
    expect(provenance.body.code).toBe('batch_provenance');
  });
});
