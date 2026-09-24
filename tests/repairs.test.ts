/** QC repair / rework — a failed-for-repair unit goes to rework, requests parts from
 *  the warehouse, and can only re-pass once its requests are dealt with. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, addSerializedUnits, type TestContext } from './helpers';

let ctx: TestContext;
let token: string;
const H = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  ctx = await setupApp();
  token = await login(ctx.api);
});
afterAll(() => cleanup(ctx));

const mkItem = async (name: string, quantity = 0) =>
  (await ctx.api.post('/api/inventory').set(H()).send({ name, quantity })).body.id as number;
const onHand = async (id: number) =>
  (await ctx.api.get(`/api/inventory/${id}`).set(H())).body.quantity as number;
const twinOf = async (itemId: number) => {
  const list = (await ctx.api.get('/api/inventory?damaged=only&include_damaged=1').set(H())).body as Array<{ id: number; attributes: { damaged_of?: number }; quantity: number }>;
  return list.find((i) => i.attributes && i.attributes.damaged_of === itemId);
};

/** A 1-QC-stage job order for a product with a plentiful `Part`, progressed so `qty`
 *  units are pending inspection. Also returns a spare `bolt` item for repair requests. */
async function reworkReady(prefix: string, qty: number) {
  const product = await mkItem(`${prefix} Product`);
  const part = await mkItem(`${prefix} Part`, 1000);
  const bolt = await mkItem(`${prefix} Bolt`, 100);
  await ctx.api.put(`/api/finished-products/${product}`).set(H())
    .send({ components: [{ component_item_id: part, quantity: 2 }] });
  const mo = (await ctx.api.post('/api/job-orders').set(H())
    .send({ product_item_id: product, qty_ordered: qty, qc_stages: 1 })).body.id;
  await ctx.api.post(`/api/job-orders/${mo}/release`).set(H());
  await ctx.api.post(`/api/job-orders/${mo}/accept`).set(H());
  await addSerializedUnits(ctx.api, token, mo, qty, prefix);
  const units = (await ctx.api.get(`/api/job-orders/${mo}/units`).set(H())).body as Array<{ id: number }>;
  return { product, part, bolt, mo, units };
}

const failForRepair = (mo: number, unitId: number) =>
  ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(H())
    .send({ unit_ids: [unitId], result: 'fail', disposition: 'repair', remarks: 'needs a new bolt' });

describe('repair / rework parts requests', () => {
  it('accepting a replace request issues the part and books the old one into the damage twin', async () => {
    const { bolt, mo, units } = await reworkReady('RP', 2);
    await failForRepair(mo, units[0]!.id);

    const raised = await ctx.api.post(`/api/production/units/${units[0]!.id}/repairs`).set(H())
      .send({ kind: 'replace', component_item_id: bolt, quantity: 3, fault: 'assembler', return_to_damage: true });
    expect(raised.status).toBe(201);
    expect(raised.body.number).toMatch(/^RPR-\d{5}$/);
    expect(raised.body.status).toBe('requested');

    const boltBefore = await onHand(bolt);
    const accept = await ctx.api.post(`/api/production/repairs/${raised.body.id}/accept`).set(H())
      .send({ warehouse_remarks: 'handed over 3 pcs' });
    expect(accept.status).toBe(200);
    expect(accept.body.status).toBe('accepted');
    expect(accept.body.decided_by_name).toBeTruthy();

    expect(await onHand(bolt)).toBe(boltBefore - 3);      // replacement left storage
    const twin = await twinOf(bolt);
    expect(twin?.quantity).toBe(3);                       // the removed bolts went to damage
  });

  it('an "add" request only issues the part — no damage twin', async () => {
    const { bolt, mo, units } = await reworkReady('RA', 1);
    await failForRepair(mo, units[0]!.id);
    const raised = await ctx.api.post(`/api/production/units/${units[0]!.id}/repairs`).set(H())
      .send({ kind: 'add', component_item_id: bolt, quantity: 2, fault: 'supplier' });
    const boltBefore = await onHand(bolt);
    await ctx.api.post(`/api/production/repairs/${raised.body.id}/accept`).set(H()).send({});
    expect(await onHand(bolt)).toBe(boltBefore - 2);
    expect(await twinOf(bolt)).toBeUndefined();
  });

  it('a rework unit cannot be re-inspected while a request is still open, then can once accepted', async () => {
    const { bolt, mo, units } = await reworkReady('RB', 2);
    // unit 1 passes, unit 0 goes to repair
    await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(H())
      .send({ unit_ids: [units[1]!.id], result: 'pass' });
    await failForRepair(mo, units[0]!.id);

    const raised = await ctx.api.post(`/api/production/units/${units[0]!.id}/repairs`).set(H())
      .send({ kind: 'replace', component_item_id: bolt, quantity: 1, fault: 'production' });

    // still open -> blocked
    const blocked = await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(H())
      .send({ unit_ids: [units[0]!.id], result: 'pass' });
    expect(blocked.status).toBe(409);

    let jo = (await ctx.api.get(`/api/job-orders/${mo}`).set(H())).body;
    expect(jo.status).toBe('in_progress');               // held open by the rework unit

    await ctx.api.post(`/api/production/repairs/${raised.body.id}/accept`).set(H()).send({});

    // now it re-passes -> queued for Products In -> job order completes
    const pass = await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(H())
      .send({ unit_ids: [units[0]!.id], result: 'pass' });
    expect(pass.status).toBe(200);
    expect(pass.body.job_order.status).toBe('completed');
    expect(pass.body.job_order.qty_done).toBe(2);
    expect((await ctx.api.get(`/api/job-orders/${mo}/units`).set(H())).body
      .find((u: { id: number }) => u.id === units[0]!.id).status).toBe('passed');

    // receiving it posts it into stock
    const rec = (await ctx.api.get(`/api/job-orders/${mo}/receivable`).set(H())).body;
    const recv = await ctx.api.post(`/api/job-orders/${mo}/products-in`).set(H())
      .send({ location_id: rec.output_location_id, unit_ids: [units[0]!.id] });
    expect(recv.status).toBe(201);
    expect((await ctx.api.get(`/api/job-orders/${mo}/units`).set(H())).body
      .find((u: { id: number }) => u.id === units[0]!.id).status).toBe('in_stock');
  });

  it('a rejected request does not block re-inspection and moves no stock', async () => {
    const { bolt, mo, units } = await reworkReady('RR', 1);
    await failForRepair(mo, units[0]!.id);
    const raised = await ctx.api.post(`/api/production/units/${units[0]!.id}/repairs`).set(H())
      .send({ kind: 'replace', component_item_id: bolt, quantity: 1 });
    const boltBefore = await onHand(bolt);

    const rej = await ctx.api.post(`/api/production/repairs/${raised.body.id}/reject`).set(H())
      .send({ warehouse_remarks: 'not our part — check with production' });
    expect(rej.status).toBe(200);
    expect(rej.body.status).toBe('rejected');
    expect(await onHand(bolt)).toBe(boltBefore);

    const pass = await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(H())
      .send({ unit_ids: [units[0]!.id], result: 'pass' });
    expect(pass.status).toBe(200);
  });

  it('guards: parts can only be requested for a rework unit; accept/reject are one-shot', async () => {
    const { bolt, mo, units } = await reworkReady('RG', 2);
    // unit still pending (not rework) -> 409
    const early = await ctx.api.post(`/api/production/units/${units[0]!.id}/repairs`).set(H())
      .send({ kind: 'add', component_item_id: bolt, quantity: 1 });
    expect(early.status).toBe(409);

    await failForRepair(mo, units[0]!.id);
    const raised = await ctx.api.post(`/api/production/units/${units[0]!.id}/repairs`).set(H())
      .send({ kind: 'add', component_item_id: bolt, quantity: 1 });
    await ctx.api.post(`/api/production/repairs/${raised.body.id}/accept`).set(H()).send({});
    const twice = await ctx.api.post(`/api/production/repairs/${raised.body.id}/accept`).set(H()).send({});
    expect(twice.status).toBe(409);
    const rejectAccepted = await ctx.api.post(`/api/production/repairs/${raised.body.id}/reject`).set(H())
      .send({ warehouse_remarks: 'too late' });
    expect(rejectAccepted.status).toBe(409);
  });

  it('cancelling a job order scraps dangling pending/rework units and cancels open requests', async () => {
    const { bolt, mo, units } = await reworkReady('RC', 3);
    await failForRepair(mo, units[0]!.id);                      // unit 0 → rework
    const raised = await ctx.api.post(`/api/production/units/${units[0]!.id}/repairs`).set(H())
      .send({ kind: 'add', component_item_id: bolt, quantity: 1 });
    // units 1 & 2 left pending

    const cancel = await ctx.api.post(`/api/job-orders/${mo}/cancel`).set(H());
    expect(cancel.status).toBe(200);
    expect(cancel.body.job_order.status).toBe('cancelled');

    const after = (await ctx.api.get(`/api/job-orders/${mo}/units`).set(H())).body as Array<{ id: number; status: string }>;
    expect(after.every((u) => u.status === 'scrapped')).toBe(true);   // rework + 2 pending all scrapped
    expect(cancel.body.job_order.qty_scrapped).toBe(3);

    const req = (await ctx.api.get(`/api/production/repairs?job_order=${mo}`).set(H())).body;
    expect(req.find((r: { id: number }) => r.id === raised.body.id).status).toBe('cancelled');
  });

  it('a fail with a non-repair disposition stays terminal (scrapped)', async () => {
    const { mo, units } = await reworkReady('RT', 2);
    const r = await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(H())
      .send({ unit_ids: [units[0]!.id], result: 'fail', disposition: 'recycle', remarks: 'cracked casing' });
    expect(r.status).toBe(200);
    expect(r.body.job_order.qty_scrapped).toBe(1);
    expect((await ctx.api.get(`/api/job-orders/${mo}/units`).set(H())).body
      .find((u: { id: number }) => u.id === units[0]!.id).status).toBe('failed');
  });
});
