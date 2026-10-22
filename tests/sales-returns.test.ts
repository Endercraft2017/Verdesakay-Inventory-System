import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, addSerializedUnits, type TestContext } from './helpers';

let ctx: TestContext;
let token: string;
const H = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  ctx = await setupApp();
  token = await login(ctx.api);
  await ctx.api.put('/api/release-slips/policy').set(H()).send({ authorization_required: false });
});
afterAll(() => cleanup(ctx));

async function shippedBulk(name: string, qty: number) {
  const item = (await ctx.api.post('/api/inventory').set(H()).send({ name, quantity: qty + 5, unit_cost: 12 })).body.id;
  const order = (await ctx.api.post('/api/orders').set(H()).send({ type: 'sale', status: 'approved',
    customer_name: 'Return customer', items: [{ item_id: item, name, quantity: qty, unit_price: 40 }] })).body.id;
  expect((await ctx.api.post(`/api/orders/${order}/accept-release`).set(H())).status).toBe(200);
  expect((await ctx.api.post(`/api/orders/${order}/release`).set(H()).send({ bulk: [{ item_id: item, quantity: qty }] })).status).toBe(200);
  const issued = await ctx.api.post(`/api/orders/${order}/release-slip`).set(H()).send({ collected_by: 'Driver' });
  expect(issued.status).toBe(201);
  const slip = (await ctx.api.get(`/api/release-slips/${issued.body.id}`).set(H())).body;
  return { item, order, slip, line: slip.items[0] };
}

async function proof(slipId: number) {
  const up = await ctx.api.post('/api/attachments').set(H()).field('kind', 'sales_return_proof')
    .field('ref_id', String(slipId)).attach('image', Buffer.from('returned-goods'), 'return.png');
  expect(up.status).toBe(201);
  return up.body.id;
}

describe('slip-linked customer returns', () => {
  it('keeps rejected bulk goods out of sellable stock and salvages only to damage stock once', async () => {
    const { item, slip, line } = await shippedBulk('Salvage bulk goods', 2);
    const evidence = await proof(slip.id);
    const received = await ctx.api.post('/api/sales-returns').set(H()).send({ slip_id: slip.id,
      slip_item_id: line.id, quantity: 2, reason: 'Crushed in transit', evidence_ids: [evidence] });
    const id = received.body.id;
    const before = (await ctx.api.get(`/api/inventory/${item}`).set(H())).body.quantity;
    expect((await ctx.api.post(`/api/sales-returns/${id}/inspect`).set(H())
      .send({ decision: 'reject', condition_note: 'Broken packaging and parts' })).status).toBe(200);
    expect((await ctx.api.post(`/api/sales-returns/${id}/disposition`).set(H())
      .send({ decision: 'repair', note: 'Try to repair the batch' })).status).toBe(409);
    const loc = (await ctx.api.get('/api/locations').set(H())).body[0].id;
    const salvaged = await ctx.api.post(`/api/sales-returns/${id}/disposition`).set(H())
      .send({ decision: 'salvage', note: 'Recover usable material', location_id: loc });
    expect(salvaged.status).toBe(200);
    expect(salvaged.body.disposition_state).toBe('salvaged');
    expect((await ctx.api.get(`/api/inventory/${item}`).set(H())).body.quantity).toBe(before);
    const { queryOne, queryAll } = await import('../src/shared/db');
    const twin = queryOne<{ id: number; quantity: number }>(
      "SELECT id, quantity FROM inventory_items WHERE json_extract(attributes, '$.damaged_of') = ?", item);
    expect(twin?.quantity).toBe(2);
    expect((await ctx.api.post(`/api/sales-returns/${id}/disposition`).set(H())
      .send({ decision: 'salvage', note: 'Duplicate salvage', location_id: loc })).status).toBe(409);
    expect(queryOne<{ quantity: number }>('SELECT quantity FROM inventory_items WHERE id = ?', twin!.id)?.quantity).toBe(2);
    expect(queryAll<{ action: string }>('SELECT action FROM sales_return_disposition_events WHERE return_id = ?', id)
      .map((e) => e.action)).toEqual(['salvaged']);
  });

  it('disposes rejected bulk goods without making any stock available', async () => {
    const { item, slip, line } = await shippedBulk('Dispose bulk goods', 1);
    const evidence = await proof(slip.id);
    const received = await ctx.api.post('/api/sales-returns').set(H()).send({ slip_id: slip.id,
      slip_item_id: line.id, quantity: 1, reason: 'Unsafe to reuse', evidence_ids: [evidence] });
    const before = (await ctx.api.get(`/api/inventory/${item}`).set(H())).body.quantity;
    await ctx.api.post(`/api/sales-returns/${received.body.id}/inspect`).set(H())
      .send({ decision: 'reject', condition_note: 'Unsafe electrical damage' });
    const disposed = await ctx.api.post(`/api/sales-returns/${received.body.id}/disposition`).set(H())
      .send({ decision: 'dispose', note: 'Unrecoverable electrical damage' });
    expect(disposed.status).toBe(200);
    expect(disposed.body.disposition_state).toBe('disposed');
    expect((await ctx.api.get(`/api/inventory/${item}`).set(H())).body.quantity).toBe(before);
  });

  it('rolls salvage disposition back if damage-stock posting fails', async () => {
    const { item, slip, line } = await shippedBulk('Salvage rollback goods', 1);
    const evidence = await proof(slip.id);
    const received = await ctx.api.post('/api/sales-returns').set(H()).send({ slip_id: slip.id,
      slip_item_id: line.id, quantity: 1, reason: 'Outer case broken', evidence_ids: [evidence] });
    await ctx.api.post(`/api/sales-returns/${received.body.id}/inspect`).set(H())
      .send({ decision: 'reject', condition_note: 'Case cannot be sold' });
    const loc = (await ctx.api.get('/api/locations').set(H())).body[0].id;
    const { db, queryOne } = await import('../src/shared/db');
    db.exec(`CREATE TRIGGER stop_return_salvage BEFORE INSERT ON inventory_transactions
      WHEN NEW.reason LIKE 'Customer return %: salvage' BEGIN SELECT RAISE(ABORT, 'salvage fault'); END`);
    const body = { decision: 'salvage', note: 'Recover internal material', location_id: loc };
    const failed = await ctx.api.post(`/api/sales-returns/${received.body.id}/disposition`).set(H()).send(body);
    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect((await ctx.api.get(`/api/sales-returns/${received.body.id}`).set(H())).body.disposition_state).toBeNull();
    expect(queryOne('SELECT 1 FROM sales_return_disposition_events WHERE return_id = ?', received.body.id)).toBeUndefined();
    expect((await ctx.api.get(`/api/inventory/${item}`).set(H())).body.quantity).toBe(5);
    db.exec('DROP TRIGGER stop_return_salvage');
    expect((await ctx.api.post(`/api/sales-returns/${received.body.id}/disposition`).set(H()).send(body)).status).toBe(200);
  });
  it('receives evidence without restoring stock, then restocks once after inspection', async () => {
    const { item, order, slip, line } = await shippedBulk('Return bulk A', 4);
    expect(line.unit_cost).toBe(12);
    const before = (await ctx.api.get(`/api/inventory/${item}`).set(H())).body.quantity;
    const evidence = await proof(slip.id);
    const receiptBody = { slip_id: slip.id,
      slip_item_id: line.id, quantity: 2, reason: 'Customer changed order', evidence_ids: [evidence] };
    const received = await ctx.api.post('/api/sales-returns').set(H()).set('Idempotency-Key', 'return-retry-bulk-a').send(receiptBody);
    expect(received.status).toBe(201);
    const replay = await ctx.api.post('/api/sales-returns').set(H()).set('Idempotency-Key', 'return-retry-bulk-a').send(receiptBody);
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(received.body.id);
    expect(received.body.status).toBe('received');
    expect((await ctx.api.get(`/api/inventory/${item}`).set(H())).body.quantity).toBe(before);
    expect((await ctx.api.get(`/api/attachments?kind=sales_return&ref_id=${received.body.id}`).set(H())).body).toHaveLength(1);
    const context = (await ctx.api.get(`/api/sales-returns/slips/${slip.id}/context`).set(H())).body;
    expect(context.lines[0].returned_qty).toBe(2);
    const location = (await ctx.api.get('/api/locations').set(H())).body.find((l: { is_default: number }) => l.is_default).id;
    const inspected = await ctx.api.post(`/api/sales-returns/${received.body.id}/inspect`).set(H())
      .send({ decision: 'restock', condition_note: 'Packaging intact', location_id: location });
    expect(inspected.status).toBe(200);
    expect(inspected.body.status).toBe('restocked');
    expect((await ctx.api.get(`/api/inventory/${item}`).set(H())).body.quantity).toBe(before + 2);
    expect((await ctx.api.post(`/api/sales-returns/${received.body.id}/inspect`).set(H())
      .send({ decision: 'restock', condition_note: 'Again', location_id: location })).status).toBe(409);
    expect((await ctx.api.get(`/api/inventory/${item}`).set(H())).body.quantity).toBe(before + 2);
    expect((await ctx.api.get(`/api/orders/${order}`).set(H())).body.status).toBe('confirmed');
  });

  it('rejects excess return and invalid evidence; rejection never creates stock', async () => {
    const { item, slip, line } = await shippedBulk('Return bulk B', 3);
    const before = (await ctx.api.get(`/api/inventory/${item}`).set(H())).body.quantity;
    const noProof = await ctx.api.post('/api/sales-returns').set(H()).send({ slip_id: slip.id,
      slip_item_id: line.id, quantity: 1, reason: 'Damaged box', evidence_ids: [999999] });
    expect(noProof.status).toBe(409);
    const evidence = await proof(slip.id);
    const tooMany = await ctx.api.post('/api/sales-returns').set(H()).send({ slip_id: slip.id,
      slip_item_id: line.id, quantity: 4, reason: 'Damaged box', evidence_ids: [evidence] });
    expect(tooMany.status).toBe(409);
    expect(tooMany.body.code).toBe('return_exceeds_shipped');
    const received = await ctx.api.post('/api/sales-returns').set(H()).send({ slip_id: slip.id,
      slip_item_id: line.id, quantity: 3, reason: 'Damaged box', evidence_ids: [evidence] });
    expect(received.status).toBe(201);
    const inspected = await ctx.api.post(`/api/sales-returns/${received.body.id}/inspect`).set(H())
      .send({ decision: 'reject', condition_note: 'Damage confirmed' });
    expect(inspected.status).toBe(200);
    expect(inspected.body.status).toBe('rejected');
    expect((await ctx.api.get(`/api/inventory/${item}`).set(H())).body.quantity).toBe(before);
  });

  it('requires the exact sold serial and releases it for sale only after restock inspection', async () => {
    const item = (await ctx.api.post('/api/inventory').set(H()).send({ name: 'Returned serial product', unit_cost: 15 })).body.id;
    const part = (await ctx.api.post('/api/inventory').set(H()).send({ name: 'Returned serial component', quantity: 10 })).body.id;
    await ctx.api.put(`/api/finished-products/${item}`).set(H()).send({ components: [{ component_item_id: part, quantity: 1 }] });
    const mo = (await ctx.api.post('/api/job-orders').set(H()).send({ product_item_id: item, qty_ordered: 1, qc_stages: 1 })).body.id;
    await ctx.api.post(`/api/job-orders/${mo}/approve`).set(H());
    await ctx.api.post('/api/job-orders/warehouse-accept').set(H()).send({ job_order_ids: [mo] });
    await ctx.api.post('/api/job-orders/prepare').set(H()).send({ job_orders: [{ id: mo }] });
    await ctx.api.post(`/api/job-orders/${mo}/release`).set(H());
    await ctx.api.post(`/api/job-orders/${mo}/accept`).set(H());
    const [unitId] = await addSerializedUnits(ctx.api, token, mo, 1, 'RETURN');
    await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(H()).send({ unit_ids: [unitId], result: 'pass', identifier: 'RETURN-SN-1' });
    const rec = (await ctx.api.get(`/api/job-orders/${mo}/receivable`).set(H())).body;
    await ctx.api.post(`/api/job-orders/${mo}/products-in`).set(H())
      .send({ location_id: rec.output_location_id, unit_ids: [unitId] });
    const so = (await ctx.api.post('/api/orders').set(H()).send({ type: 'sale', status: 'approved',
      items: [{ item_id: item, name: 'Returned serial product', quantity: 1, unit_price: 80 }] })).body.id;
    await ctx.api.post(`/api/orders/${so}/accept-release`).set(H());
    await ctx.api.post(`/api/orders/${so}/release`).set(H()).send({ codes: ['RETURN-SN-1'] });
    const issued = await ctx.api.post(`/api/orders/${so}/release-slip`).set(H()).send({ collected_by: 'Driver' });
    expect(issued.status).toBe(201);
    const slip = (await ctx.api.get(`/api/release-slips/${issued.body.id}`).set(H())).body;
    const evidence = await proof(slip.id);
    const base = { slip_id: slip.id, slip_item_id: slip.items[0].id, quantity: 1,
      reason: 'Serial returned from buyer', evidence_ids: [evidence] };
    expect((await ctx.api.post('/api/sales-returns').set(H()).send(base)).status).toBe(409);
    const received = await ctx.api.post('/api/sales-returns').set(H()).send({ ...base, unit_id: unitId });
    expect(received.status).toBe(201);
    const before = (await ctx.api.get(`/api/inventory/${item}`).set(H())).body.quantity;
    const inspect = await ctx.api.post(`/api/sales-returns/${received.body.id}/inspect`).set(H())
      .send({ decision: 'restock', condition_note: 'Serial and seals intact' });
    expect(inspect.status).toBe(200);
    expect((await ctx.api.get(`/api/inventory/${item}`).set(H())).body.quantity).toBe(before + 1);
    const units = (await ctx.api.get(`/api/finished-products/${item}/units?status=all`).set(H())).body;
    expect(units.find((u: { id: number }) => u.id === unitId).status).toBe('in_stock');
    // A resale starts a new return cycle while retaining the earlier return history.
    const secondSale=(await ctx.api.post('/api/orders').set(H()).send({type:'sale',status:'approved',items:[{item_id:item,name:'Resold serial',quantity:1,unit_price:80}]})).body.id;
    await ctx.api.post(`/api/orders/${secondSale}/accept-release`).set(H());
    expect((await ctx.api.post(`/api/finished-products/${item}/units/allocate`).set(H()).send({action:'sell',unit_ids:[unitId],order_id:secondSale,order_item_id:(await ctx.api.get(`/api/orders/${secondSale}`).set(H())).body.items[0].id})).status).toBe(200);
    const secondSlip=(await ctx.api.post(`/api/orders/${secondSale}/release-slip`).set(H()).send({collected_by:'Second buyer'})).body.id;
    const secondContext=(await ctx.api.get(`/api/sales-returns/slips/${secondSlip}/context`).set(H())).body;
    expect(secondContext.units.map((u:any)=>u.id)).toContain(unitId);
    const evidence2=await proof(secondSlip);
    const secondReturn=await ctx.api.post('/api/sales-returns').set(H()).send({slip_id:secondSlip,slip_item_id:secondContext.lines[0].id,quantity:1,unit_id:unitId,reason:'Second customer returned serial',evidence_ids:[evidence2]});
    expect(secondReturn.status,JSON.stringify(secondReturn.body)).toBe(201);
    expect(secondReturn.body.id).not.toBe(received.body.id);
    expect((await ctx.api.post(`/api/sales-returns/${secondReturn.body.id}/inspect`).set(H()).send({decision:'restock',condition_note:'Second resale return is sound'})).status).toBe(200);
    const {queryOne}=await import('../src/shared/db');expect(queryOne<{direct_sold_at:string|null}>('SELECT direct_sold_at FROM job_order_units WHERE id=?',unitId)!.direct_sold_at).toBeNull();
    expect((await ctx.api.post('/api/sales-returns').set(H()).send({slip_id:secondSlip,slip_item_id:secondContext.lines[0].id,quantity:1,unit_id:unitId,reason:'Duplicate second receipt',evidence_ids:[evidence2]})).status).toBe(409);

  });

  it('repairs a rejected sold serial through parts, then reinspects without repeating production receipt', async () => {
    const item = (await ctx.api.post('/api/inventory').set(H()).send({ name: 'Repaired return unit', unit_cost: 20 })).body.id;
    const part = (await ctx.api.post('/api/inventory').set(H()).send({ name: 'Repaired return component', quantity: 12 })).body.id;
    await ctx.api.put(`/api/finished-products/${item}`).set(H()).send({ components: [{ component_item_id: part, quantity: 1 }] });
    const mo = (await ctx.api.post('/api/job-orders').set(H()).send({ product_item_id: item, qty_ordered: 1, qc_stages: 1 })).body.id;
    await ctx.api.post(`/api/job-orders/${mo}/approve`).set(H());
    await ctx.api.post('/api/job-orders/warehouse-accept').set(H()).send({ job_order_ids: [mo] });
    await ctx.api.post('/api/job-orders/prepare').set(H()).send({ job_orders: [{ id: mo }] });
    await ctx.api.post(`/api/job-orders/${mo}/release`).set(H());
    await ctx.api.post(`/api/job-orders/${mo}/accept`).set(H());
    const [unitId] = await addSerializedUnits(ctx.api, token, mo, 1, 'REWORK-RETURN');
    await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(H()).send({ unit_ids: [unitId], result: 'pass', identifier: 'REWORK-SN-1' });
    const receivable = (await ctx.api.get(`/api/job-orders/${mo}/receivable`).set(H())).body;
    await ctx.api.post(`/api/job-orders/${mo}/products-in`).set(H()).send({ location_id: receivable.output_location_id, unit_ids: [unitId] });
    const so = (await ctx.api.post('/api/orders').set(H()).send({ type: 'sale', status: 'approved',
      items: [{ item_id: item, name: 'Repaired return unit', quantity: 1, unit_price: 80 }] })).body.id;
    await ctx.api.post(`/api/orders/${so}/accept-release`).set(H());
    await ctx.api.post(`/api/orders/${so}/release`).set(H()).send({ codes: ['REWORK-SN-1'] });
    const issued = await ctx.api.post(`/api/orders/${so}/release-slip`).set(H()).send({ collected_by: 'Driver' });
    const slip = (await ctx.api.get(`/api/release-slips/${issued.body.id}`).set(H())).body;
    const evidence = await proof(slip.id);
    const received = await ctx.api.post('/api/sales-returns').set(H()).send({ slip_id: slip.id,
      slip_item_id: slip.items[0].id, quantity: 1, unit_id: unitId,
      reason: 'Unit failed after sale', evidence_ids: [evidence] });
    const id = received.body.id;
    const before = (await ctx.api.get(`/api/inventory/${item}`).set(H())).body.quantity;
    await ctx.api.post(`/api/sales-returns/${id}/inspect`).set(H())
      .send({ decision: 'reject', condition_note: 'Power supply failed' });
    const disposition = await ctx.api.post(`/api/sales-returns/${id}/disposition`).set(H())
      .send({ decision: 'repair', note: 'Replace power supply' });
    expect(disposition.status).toBe(200);
    expect(disposition.body.disposition_state).toBe('repair');
    const request = await ctx.api.post(`/api/production/units/${unitId}/repairs`).set(H()).send({
      kind: 'add', component_item_id: part, quantity: 1, notes: 'Repair supply' });
    expect(request.status).toBe(201);
    expect(request.body.sales_return_id).toBe(id);
    expect((await ctx.api.post(`/api/sales-returns/${id}/repair-complete`).set(H())
      .send({ note: 'Replaced failed supply' })).status).toBe(409);
    expect((await ctx.api.post(`/api/production/repairs/${request.body.id}/accept`).set(H())
      .send({ from_location_id: receivable.output_location_id })).status).toBe(200);
    expect((await ctx.api.post(`/api/sales-returns/${id}/repair-complete`).set(H())
      .send({ note: 'Replaced failed supply' })).status).toBe(200);
    const failed = await ctx.api.post(`/api/sales-returns/${id}/reinspect`).set(H())
      .send({ decision: 'reject', condition_note: 'Power test still fails' });
    expect(failed.status).toBe(200);
    expect(failed.body.disposition_state).toBe('repair');
    expect((await ctx.api.get(`/api/inventory/${item}`).set(H())).body.quantity).toBe(before);
    await ctx.api.post(`/api/sales-returns/${id}/repair-complete`).set(H()).send({ note: 'Replaced wiring and tested' });
    const passed = await ctx.api.post(`/api/sales-returns/${id}/reinspect`).set(H())
      .send({ decision: 'restock', condition_note: 'Power test passes now' });
    expect(passed.status).toBe(200);
    expect(passed.body.status).toBe('restocked');
    expect((await ctx.api.get(`/api/inventory/${item}`).set(H())).body.quantity).toBe(before + 1);
    expect((await ctx.api.post(`/api/sales-returns/${id}/reinspect`).set(H())
      .send({ decision: 'restock', condition_note: 'Duplicate passing test' })).status).toBe(409);
    const { queryOne } = await import('../src/shared/db');
    expect(queryOne<{ qty_done: number }>('SELECT qty_done FROM job_orders WHERE id = ?', mo)?.qty_done).toBe(1);
    expect(queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM production_receipts WHERE job_order_id = ?', mo)?.n).toBe(1);
    expect(queryOne<{ status: string; order_id: number | null }>('SELECT status, order_id FROM job_order_units WHERE id = ?', unitId))
      .toMatchObject({ status: 'in_stock', order_id: null });
  });

  it('reverses returned COGS at shipped cost and links a reviewed credit note without another stock move', async () => {
    expect((await ctx.api.post('/api/accounting/ledger/setup').set(H())
      .send({ fiscal_year_start: '2026-01-01' })).status).toBe(201);
    const { item, order, slip, line } = await shippedBulk('Return GL C', 2);
    const evidence = await proof(slip.id);
    const received = await ctx.api.post('/api/sales-returns').set(H()).send({ slip_id: slip.id,
      slip_item_id: line.id, quantity: 1, reason: 'Customer return for credit', evidence_ids: [evidence] });
    expect(received.status).toBe(201);
    const before = (await ctx.api.get(`/api/inventory/${item}`).set(H())).body.quantity;
    const inspected = await ctx.api.post(`/api/sales-returns/${received.body.id}/inspect`).set(H())
      .send({ decision: 'restock', condition_note: 'Passed resale inspection' });
    expect(inspected.status).toBe(200);
    expect(inspected.body.accounting.posted).toBe(true);
    const { queryAll } = await import('../src/shared/db');
    const lines = queryAll<{ debit: number; credit: number; account_type: string }>(`
      SELECT jl.debit, jl.credit, a.account_type FROM journal_lines jl
      JOIN accounts a ON a.id = jl.account_id JOIN journal_entries je ON je.id = jl.entry_id
      WHERE je.source_type = 'sales_return_cogs' AND je.source_id = ?`, received.body.id);
    expect(lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ debit: 12, account_type: 'stock' }),
      expect.objectContaining({ credit: 12, account_type: 'cogs' }),
    ]));
    const note = await ctx.api.post('/api/accounting/credit-notes').set(H()).send({
      kind: 'customer', note_date: '2026-10-13', source_doc_type: 'sale_order', source_doc_id: order,
      reason: 'One returned item', subtotal: 40, tax_amount: 0,
    });
    expect(note.status).toBe(201);
    const linked = await ctx.api.post(`/api/sales-returns/${received.body.id}/link-credit`).set(H())
      .send({ credit_note_id: note.body.id });
    expect(linked.status).toBe(200);
    expect(linked.body.credit_note_id).toBe(note.body.id);
    expect((await ctx.api.get(`/api/inventory/${item}`).set(H())).body.quantity).toBe(before + 1);
    expect((await ctx.api.post(`/api/sales-returns/${received.body.id}/link-credit`).set(H())
      .send({ credit_note_id: note.body.id })).status).toBe(409);
    expect((await ctx.api.post(`/api/accounting/credit-notes/${note.body.id}/void`).set(H())).status).toBe(200);
    expect((await ctx.api.get(`/api/sales-returns/${received.body.id}`).set(H())).body.credit_note_status).toBe('void');
  });

  it('rolls inspection back if inventory posting fails and permits a clean retry', async () => {
    const { item, slip, line } = await shippedBulk('Return atomic D', 1);
    const evidence = await proof(slip.id);
    const received = await ctx.api.post('/api/sales-returns').set(H()).send({ slip_id: slip.id,
      slip_item_id: line.id, quantity: 1, reason: 'Item returned to warehouse', evidence_ids: [evidence] });
    expect(received.status).toBe(201);
    const before = (await ctx.api.get(`/api/inventory/${item}`).set(H())).body.quantity;
    const { db } = await import('../src/shared/db');
    db.exec(`CREATE TRIGGER stop_customer_return BEFORE INSERT ON inventory_transactions
      WHEN NEW.reason LIKE 'Customer return %' BEGIN SELECT RAISE(ABORT, 'return stock fault'); END`);
    const body = { decision: 'restock', condition_note: 'Packaging intact' };
    const failed = await ctx.api.post(`/api/sales-returns/${received.body.id}/inspect`).set(H()).send(body);
    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect((await ctx.api.get(`/api/sales-returns/${received.body.id}`).set(H())).body.status).toBe('received');
    expect((await ctx.api.get(`/api/inventory/${item}`).set(H())).body.quantity).toBe(before);
    db.exec('DROP TRIGGER stop_customer_return');
    expect((await ctx.api.post(`/api/sales-returns/${received.body.id}/inspect`).set(H()).send(body)).status).toBe(200);
    expect((await ctx.api.get(`/api/inventory/${item}`).set(H())).body.quantity).toBe(before + 1);
  });
});
