/** Manufacturing Phase C: QA/QC gating, serialized units, explode-by-identifier. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, addSerializedUnits, type TestContext } from './helpers';

let ctx: TestContext;
let token: string;
const authHdr = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  ctx = await setupApp();
  token = await login(ctx.api);
});
afterAll(() => cleanup(ctx));

const mkItem = async (name: string, quantity = 0) =>
  (await ctx.api.post('/api/inventory').set(authHdr()).send({ name, quantity })).body.id as number;
const onHand = async (id: number) =>
  (await ctx.api.get(`/api/inventory/${id}`).set(authHdr())).body.quantity as number;

async function setupProduct(prefix: string) {
  const product = await mkItem(`${prefix} Product`);
  const part = await mkItem(`${prefix} Part`, 1000);
  await ctx.api.put(`/api/finished-products/${product}`).set(authHdr())
    .send({ components: [{ component_item_id: part, quantity: 2 }] });
  return { product, part };
}

async function releasedMO(prefix: string, qty: number, qc_stages: number) {
  const { product, part } = await setupProduct(prefix);
  const mo = (await ctx.api.post('/api/job-orders').set(authHdr())
    .send({ product_item_id: product, qty_ordered: qty, qc_stages })).body.id;
  await ctx.api.post(`/api/job-orders/${mo}/release`).set(authHdr());
  return { mo, product, part };
}

const unitsOf = async (mo: number) =>
  (await ctx.api.get(`/api/job-orders/${mo}/units`).set(authHdr())).body as Array<{ id: number; status: string; stage: number; identifier: string | null }>;

/** Receive everything a job order has awaiting Products In — a final QC pass sets a unit
    to 'passed', not 'in_stock'; this is the step that actually posts it (see
    job-orders.routes.ts POST /:id/products-in). */
async function receiveAll(mo: number): Promise<void> {
  const rec = (await ctx.api.get(`/api/job-orders/${mo}/receivable`).set(authHdr())).body;
  if (rec.units?.length) {
    const r = await ctx.api.post(`/api/job-orders/${mo}/products-in`).set(authHdr())
      .send({ location_id: rec.output_location_id, unit_ids: rec.units.map((u: { id: number }) => u.id) });
    if (r.status !== 201) throw new Error(`receive units failed: ${JSON.stringify(r.body)}`);
  }
}

describe('job orders — QA/QC', () => {
  it('adding serialized units via POST /:id/units queues them for inspection (no stock yet)', async () => {
    const { mo, product } = await releasedMO('QC1', 5, 1);
    const ids = await addSerializedUnits(ctx.api, token, mo, 4, 'QC1');
    expect(ids).toHaveLength(4);
    const jo = (await ctx.api.get(`/api/job-orders/${mo}`).set(authHdr())).body;
    expect(jo.qty_done).toBe(0);
    expect(jo.units_summary.pending).toBe(4);
    expect(await onHand(product)).toBe(0);

    const units = await unitsOf(mo);
    expect(units.length).toBe(4);
    expect(units.every((u) => u.status === 'pending' && u.stage === 0)).toBe(true);

    // the old bulk done_delta path is no longer available for a serialized job order
    // (see tests/job-order-add-unit.test.ts for the full coverage of that rejection)
    const bulk = await ctx.api.post(`/api/job-orders/${mo}/progress`).set(authHdr()).send({ done_delta: 1 });
    expect(bulk.status).toBe(400);
  });

  it('the job-order list carries units_pending for the mobile QA/QC worklist', async () => {
    const { mo } = await releasedMO('QCLIST', 5, 1);
    await addSerializedUnits(ctx.api, token, mo, 3, 'QCLIST');
    const list = await ctx.api.get('/api/job-orders').set(authHdr());
    const row = list.body.find((j: { id: number }) => j.id === mo);
    expect(row.units_pending).toBe(3);
    expect(row.qc_stages).toBe(1);
  });

  it('a single-stage pass queues the unit for Products In; a fail scraps it with remarks', async () => {
    const { mo, product } = await releasedMO('QC2', 5, 1);
    await addSerializedUnits(ctx.api, token, mo, 3, 'QC2');
    const units = await unitsOf(mo);

    const pass = await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(authHdr())
      .send({ unit_ids: [units[0]!.id, units[1]!.id], result: 'pass' });
    expect(pass.body.job_order.qty_done).toBe(2);
    expect((await unitsOf(mo)).find((u) => u.id === units[0]!.id)!.status).toBe('passed');
    expect(await onHand(product)).toBe(0); // not yet received
    await receiveAll(mo);
    expect(await onHand(product)).toBe(2);

    // a fail needs a disposition
    const noDisp = await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(authHdr())
      .send({ unit_ids: [units[2]!.id], result: 'fail', remarks: 'weld cracked' });
    expect(noDisp.status).toBe(400);

    const fail = await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(authHdr())
      .send({ unit_ids: [units[2]!.id], result: 'fail', disposition: 'scrap', remarks: 'weld cracked' });
    expect(fail.body.job_order.qty_scrapped).toBe(1);
    expect(await onHand(product)).toBe(2); // failed unit not added

    const log = (await ctx.api.get(`/api/job-orders/${mo}/qc`).set(authHdr())).body;
    expect(log.some((q: { result: string; remarks: string; disposition: string }) =>
      q.result === 'fail' && q.remarks === 'weld cracked' && q.disposition === 'scrap')).toBe(true);
    const after = await unitsOf(mo);
    expect(after.find((u) => u.id === units[2]!.id)!.status).toBe('failed');
  });

  it('a repair disposition sends the unit to rework and holds the job order open', async () => {
    const { mo } = await releasedMO('QCRW', 2, 1);
    await addSerializedUnits(ctx.api, token, mo, 2, 'QCRW');
    const units = await unitsOf(mo);

    // one passes into stock, the other goes to repair
    await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(authHdr())
      .send({ unit_ids: [units[0]!.id], result: 'pass' });
    const rw = await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(authHdr())
      .send({ unit_ids: [units[1]!.id], result: 'fail', disposition: 'repair', remarks: 'panel gap' });
    expect(rw.status).toBe(200);
    expect(rw.body.job_order.qty_scrapped).toBe(0);       // repair is not a scrap
    expect(rw.body.job_order.status).toBe('in_progress');  // still open — a unit is in rework
    expect(rw.body.job_order.units_summary.rework).toBe(1);
    expect((await unitsOf(mo)).find((u) => u.id === units[1]!.id)!.status).toBe('rework');
  });

  it('two-stage QA→QC needs two passes before the unit counts', async () => {
    const { mo, product } = await releasedMO('QC3', 2, 2);
    await addSerializedUnits(ctx.api, token, mo, 2, 'QC3');
    const units = await unitsOf(mo);

    await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(authHdr())
      .send({ unit_ids: [units[0]!.id], result: 'pass' }); // stage 1 (QA)
    expect(await onHand(product)).toBe(0);
    expect((await unitsOf(mo)).find((u) => u.id === units[0]!.id)!.status).toBe('pending');
    expect((await unitsOf(mo)).find((u) => u.id === units[0]!.id)!.stage).toBe(1);

    await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(authHdr())
      .send({ unit_ids: [units[0]!.id], result: 'pass' }); // stage 2 (QC)
    expect((await unitsOf(mo)).find((u) => u.id === units[0]!.id)!.status).toBe('passed');
    expect(await onHand(product)).toBe(0); // not yet received
    await receiveAll(mo);
    expect(await onHand(product)).toBe(1);
    expect((await unitsOf(mo)).find((u) => u.id === units[0]!.id)!.status).toBe('in_stock');
  });

  it('an identifier can be set at inspection and shared across units', async () => {
    const { mo, product } = await releasedMO('QC4', 4, 1);
    await addSerializedUnits(ctx.api, token, mo, 4, 'QC4');
    const units = await unitsOf(mo);

    await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(authHdr())
      .send({ unit_ids: [units[0]!.id, units[1]!.id, units[2]!.id], result: 'pass', identifier: 'PRADO-BLK-01' });
    await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(authHdr())
      .send({ unit_ids: [units[3]!.id], result: 'pass', identifier: 'PRADO-BLK-02' });
    await receiveAll(mo); // only 'in_stock'/'reserved' units are explodable — Products In gets them there

    const detail = (await ctx.api.get(`/api/finished-products/${product}`).set(authHdr())).body;
    expect(detail.serialized_total).toBe(4);
    expect(detail.bulk_untracked).toBe(0);
    const grp = Object.fromEntries(detail.units.map((u: { identifier: string; quantity: number }) => [u.identifier, u.quantity]));
    expect(grp['PRADO-BLK-01']).toBe(3);
    expect(grp['PRADO-BLK-02']).toBe(1);
  });

  it('explode shows bulk (non-serialised) stock alongside identified units', async () => {
    const { mo, product } = await releasedMO('QC5', 2, 1);
    await ctx.api.post(`/api/inventory/${product}/adjust`).set(authHdr()).send({ change: 5, reason: 'opening balance' });
    await addSerializedUnits(ctx.api, token, mo, 2, 'QC5');
    const units = await unitsOf(mo);
    await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(authHdr())
      .send({ unit_ids: units.map((u) => u.id), result: 'pass', identifier: 'SN-9' });
    await receiveAll(mo);

    const detail = (await ctx.api.get(`/api/finished-products/${product}`).set(authHdr())).body;
    expect(await onHand(product)).toBe(7); // 5 bulk + 2 built
    expect(detail.serialized_total).toBe(2);
    expect(detail.bulk_untracked).toBe(5);
  });

  it('auto-completes only once nothing is left pending; rejects bad inspect targets', async () => {
    const { mo, part } = await releasedMO('QC6', 3, 1);
    const beforePart = await onHand(part); // released already deducted 6
    await addSerializedUnits(ctx.api, token, mo, 3, 'QC6');
    let jo = (await ctx.api.get(`/api/job-orders/${mo}`).set(authHdr())).body;
    expect(jo.status).toBe('in_progress'); // 3 pending, not done

    const units = await unitsOf(mo);
    const pass = await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(authHdr())
      .send({ unit_ids: units.map((u) => u.id), result: 'pass' });
    expect(pass.body.job_order.status).toBe('completed');

    // already-inspected units can't be inspected again
    const again = await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(authHdr())
      .send({ unit_ids: [units[0]!.id], result: 'pass' });
    expect(again.status).toBe(409);
    // unknown unit id
    const bogus = await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(authHdr())
      .send({ unit_ids: [999999], result: 'pass' });
    expect(bogus.status).toBe(400);
    expect(beforePart).toBeGreaterThanOrEqual(0);
  });
});
