/** Purchasing depth: goods receipts + vendor bills + 3-way match. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';
import { threeWayMatch, receiptStatus } from '../src/purchasing-match';

/* ------------------------------------------------------------------- pure --- */

describe('threeWayMatch (pure)', () => {
  const po = [
    { order_item_id: 1, name: 'Steel sheet', quantity: 100, unit_price: 50 },
    { order_item_id: 2, name: 'Bolts', quantity: 500, unit_price: 1 },
  ];

  it('passes when receipts cover the bill and prices match', () => {
    const r = threeWayMatch({
      poLines: po,
      receiptLines: [{ order_item_id: 1, name: 'Steel sheet', quantity: 100 }],
      billLines: [{ order_item_id: 1, name: 'Steel sheet', quantity: 100, unit_price: 50 }],
    });
    expect(r.ok).toBe(true);
  });

  it('fails when billed quantity exceeds what was received', () => {
    const r = threeWayMatch({
      poLines: po,
      receiptLines: [{ order_item_id: 1, name: 'Steel sheet', quantity: 60 }],
      billLines: [{ order_item_id: 1, name: 'Steel sheet', quantity: 100, unit_price: 50 }],
    });
    expect(r.ok).toBe(false);
    expect(r.lines.find((l) => l.order_item_id === 1)!.qty_ok).toBe(false);
  });

  it('fails when the unit price is outside tolerance', () => {
    const r = threeWayMatch({
      poLines: po,
      receiptLines: [{ order_item_id: 1, name: 'Steel sheet', quantity: 100 }],
      billLines: [{ order_item_id: 1, name: 'Steel sheet', quantity: 100, unit_price: 60 }], // +20%
      tolerance: { price_pct: 2, price_abs: 0, qty_pct: 0 },
    });
    expect(r.ok).toBe(false);
    expect(r.lines.find((l) => l.order_item_id === 1)!.price_ok).toBe(false);
  });

  it('counts already-approved bills against the received quantity', () => {
    const r = threeWayMatch({
      poLines: po,
      receiptLines: [{ order_item_id: 2, name: 'Bolts', quantity: 500 }],
      priorBillLines: [{ order_item_id: 2, name: 'Bolts', quantity: 400, unit_price: 1 }],
      billLines: [{ order_item_id: 2, name: 'Bolts', quantity: 200, unit_price: 1 }], // 400+200 > 500
    });
    expect(r.ok).toBe(false);
  });

  it('flags a charge that is not on the PO', () => {
    const r = threeWayMatch({
      poLines: po,
      receiptLines: [],
      billLines: [{ name: 'Pallet fee', quantity: 1, unit_price: 250 }],
    });
    expect(r.ok).toBe(false);
    expect(r.lines.find((l) => l.name === 'Pallet fee')!.on_po).toBe(false);
  });

  it('receiptStatus reflects progress', () => {
    const ordered = new Map([['oi:1', 100], ['oi:2', 500]]);
    expect(receiptStatus(ordered, new Map())).toBe('none');
    expect(receiptStatus(ordered, new Map([['oi:1', 100]]))).toBe('partial');
    expect(receiptStatus(ordered, new Map([['oi:1', 100], ['oi:2', 500]]))).toBe('complete');
    expect(receiptStatus(ordered, new Map([['oi:1', 120], ['oi:2', 500]]))).toBe('over');
  });
});

/* ------------------------------------------------------------ integration --- */

let ctx: TestContext;
let token: string;
const authHdr = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  ctx = await setupApp();
  token = await login(ctx.api);
});
afterAll(() => cleanup(ctx));

const defaultLocId = async () =>
  (await ctx.api.get('/api/locations').set(authHdr())).body.find((l: { is_default: number }) => l.is_default === 1).id as number;

const mkItem = async (name: string, quantity = 0) =>
  (await ctx.api.post('/api/inventory').set(authHdr()).send({ name, quantity })).body.id as number;

const stockOf = async (id: number) =>
  (await ctx.api.get(`/api/inventory/${id}`).set(authHdr())).body.quantity as number;

async function makePO(lines: { item_id: number; name: string; quantity: number; unit_price: number }[]) {
  const res = await ctx.api.post('/api/orders').set(authHdr()).send({ type: 'purchase', items: lines });
  expect(res.status).toBe(201);
  const full = await ctx.api.get(`/api/orders/${res.body.id}`).set(authHdr());
  const items = full.body.items as { id: number; name: string }[];
  expect(items.length).toBeGreaterThan(0);
  return { id: res.body.id as number, number: res.body.number as string, items, oiId: items[0]!.id };
}

describe('goods receipts post stock against a PO', () => {
  it('partial then full receipt drives the receipt status and stock', async () => {
    const loc = await defaultLocId();
    const steel = await mkItem('PO Steel');
    const po = await makePO([{ item_id: steel, name: 'PO Steel', quantity: 100, unit_price: 50 }]);
    

    const r1 = await ctx.api.post(`/api/purchasing/orders/${po.id}/receipts`).set(authHdr()).send({
      location_id: loc,
      lines: [{ order_item_id: po.oiId, item_id: steel, name: 'PO Steel', quantity: 40 }],
    });
    expect(r1.status).toBe(201);
    expect(await stockOf(steel)).toBe(40);

    let summary = await ctx.api.get(`/api/purchasing/orders/${po.id}`).set(authHdr());
    expect(summary.body.receipt_status).toBe('partial');
    expect(summary.body.lines[0].received).toBe(40);
    expect(summary.body.lines[0].outstanding).toBe(60);

    await ctx.api.post(`/api/purchasing/orders/${po.id}/receipts`).set(authHdr()).send({
      location_id: loc,
      lines: [{ order_item_id: po.oiId, item_id: steel, name: 'PO Steel', quantity: 60 }],
    });
    expect(await stockOf(steel)).toBe(100);
    summary = await ctx.api.get(`/api/purchasing/orders/${po.id}`).set(authHdr());
    expect(summary.body.receipt_status).toBe('complete');
  });

  it('deleting a receipt reverses the stock', async () => {
    const loc = await defaultLocId();
    const nut = await mkItem('PO Nut');
    const po = await makePO([{ item_id: nut, name: 'PO Nut', quantity: 10, unit_price: 2 }]);
    const rc = await ctx.api.post(`/api/purchasing/orders/${po.id}/receipts`).set(authHdr()).send({
      location_id: loc, lines: [{ order_item_id: po.oiId, item_id: nut, name: 'PO Nut', quantity: 10 }],
    });
    expect(await stockOf(nut)).toBe(10);
    const del = await ctx.api.delete(`/api/purchasing/receipts/${rc.body.id}`).set(authHdr());
    expect(del.status).toBe(200);
    expect(await stockOf(nut)).toBe(0);
  });

  it('rejects a non-purchase order', async () => {
    const it = await mkItem('SO Item', 5);
    const so = await ctx.api.post('/api/orders').set(authHdr())
      .send({ type: 'sale', items: [{ item_id: it, name: 'SO Item', quantity: 1, unit_price: 10 }] });
    const r = await ctx.api.post(`/api/purchasing/orders/${so.body.id}/receipts`).set(authHdr())
      .send({ location_id: await defaultLocId(), lines: [{ name: 'x', quantity: 1 }] });
    expect(r.status).toBe(400);
  });
});

describe('vendor bills + 3-way match gate', () => {
  it('blocks approval until receipts cover the bill, then allows it', async () => {
    const loc = await defaultLocId();
    const wire = await mkItem('PO Wire');
    const po = await makePO([{ item_id: wire, name: 'PO Wire', quantity: 100, unit_price: 5 }]);
    

    // Receive 60, bill 100 → match should fail on quantity.
    await ctx.api.post(`/api/purchasing/orders/${po.id}/receipts`).set(authHdr()).send({
      location_id: loc, lines: [{ order_item_id: po.oiId, item_id: wire, name: 'PO Wire', quantity: 60 }],
    });
    const bill = await ctx.api.post(`/api/purchasing/orders/${po.id}/bills`).set(authHdr()).send({
      vendor_ref: 'INV-777',
      lines: [{ order_item_id: po.oiId, item_id: wire, name: 'PO Wire', quantity: 100, unit_price: 5 }],
    });
    expect(bill.status).toBe(201);

    const blocked = await ctx.api.post(`/api/purchasing/bills/${bill.body.id}/approve`).set(authHdr()).send({});
    expect(blocked.status).toBe(409);
    expect(blocked.body.match.ok).toBe(false);

    // Receive the rest, then approval passes.
    await ctx.api.post(`/api/purchasing/orders/${po.id}/receipts`).set(authHdr()).send({
      location_id: loc, lines: [{ order_item_id: po.oiId, item_id: wire, name: 'PO Wire', quantity: 40 }],
    });
    const ok = await ctx.api.post(`/api/purchasing/bills/${bill.body.id}/approve`).set(authHdr()).send({});
    expect(ok.status).toBe(200);
    const detail = await ctx.api.get(`/api/purchasing/bills/${bill.body.id}`).set(authHdr());
    expect(detail.body.status).toBe('approved');
    expect(detail.body.approved_by_name).toBeTruthy();
  });

  it('force-approves a price mismatch and records the override', async () => {
    const loc = await defaultLocId();
    const paint = await mkItem('PO Paint');
    const po = await makePO([{ item_id: paint, name: 'PO Paint', quantity: 10, unit_price: 100 }]);
    
    await ctx.api.post(`/api/purchasing/orders/${po.id}/receipts`).set(authHdr()).send({
      location_id: loc, lines: [{ order_item_id: po.oiId, item_id: paint, name: 'PO Paint', quantity: 10 }],
    });
    const bill = await ctx.api.post(`/api/purchasing/orders/${po.id}/bills`).set(authHdr()).send({
      lines: [{ order_item_id: po.oiId, item_id: paint, name: 'PO Paint', quantity: 10, unit_price: 130 }],
    });
    const blocked = await ctx.api.post(`/api/purchasing/bills/${bill.body.id}/approve`).set(authHdr()).send({});
    expect(blocked.status).toBe(409);

    const forced = await ctx.api.post(`/api/purchasing/bills/${bill.body.id}/approve`).set(authHdr())
      .send({ force: true, note: 'agreed surcharge' });
    expect(forced.status).toBe(200);
    expect(forced.body.forced).toBe(true);
    const detail = await ctx.api.get(`/api/purchasing/bills/${bill.body.id}`).set(authHdr());
    expect(detail.body.notes).toMatch(/Force-approved/);
  });

  it('disputes a bill and blocks deleting an approved one', async () => {
    const loc = await defaultLocId();
    const glue = await mkItem('PO Glue');
    const po = await makePO([{ item_id: glue, name: 'PO Glue', quantity: 5, unit_price: 20 }]);
    
    await ctx.api.post(`/api/purchasing/orders/${po.id}/receipts`).set(authHdr()).send({
      location_id: loc, lines: [{ order_item_id: po.oiId, item_id: glue, name: 'PO Glue', quantity: 5 }],
    });
    const bill = await ctx.api.post(`/api/purchasing/orders/${po.id}/bills`).set(authHdr()).send({
      lines: [{ order_item_id: po.oiId, item_id: glue, name: 'PO Glue', quantity: 5, unit_price: 20 }],
    });
    const disp = await ctx.api.post(`/api/purchasing/bills/${bill.body.id}/dispute`).set(authHdr())
      .send({ note: 'wrong PO' });
    expect(disp.status).toBe(200);
    expect((await ctx.api.get(`/api/purchasing/bills/${bill.body.id}`).set(authHdr())).body.status).toBe('disputed');

    // editing a disputed bill flips it back to draft
    await ctx.api.put(`/api/purchasing/bills/${bill.body.id}`).set(authHdr()).send({
      lines: [{ order_item_id: po.oiId, item_id: glue, name: 'PO Glue', quantity: 5, unit_price: 20 }],
    });
    await ctx.api.post(`/api/purchasing/bills/${bill.body.id}/approve`).set(authHdr()).send({});
    const del = await ctx.api.delete(`/api/purchasing/bills/${bill.body.id}`).set(authHdr());
    expect(del.status).toBe(409);
  });
});

describe('purchasing permissions', () => {
  it('receiving needs inventory.adjust; billing needs orders.edit', async () => {
    const loc = await defaultLocId();
    const csr = await createEmployee(ctx.api, token, { role: 'csr', username: 'pur_csr' }); // orders.edit, no inventory.adjust
    const wh = await createEmployee(ctx.api, token, { role: 'warehouse', username: 'pur_wh' }); // inventory.adjust, no orders.edit
    const item = await mkItem('Perm Item');
    const po = await makePO([{ item_id: item, name: 'Perm Item', quantity: 4, unit_price: 3 }]);
    

    const csrRecv = await ctx.api.post(`/api/purchasing/orders/${po.id}/receipts`)
      .set('Authorization', `Bearer ${csr.token}`)
      .send({ location_id: loc, lines: [{ order_item_id: po.oiId, item_id: item, name: 'Perm Item', quantity: 4 }] });
    expect(csrRecv.status).toBe(403);

    const whRecv = await ctx.api.post(`/api/purchasing/orders/${po.id}/receipts`)
      .set('Authorization', `Bearer ${wh.token}`)
      .send({ location_id: loc, lines: [{ order_item_id: po.oiId, item_id: item, name: 'Perm Item', quantity: 4 }] });
    expect(whRecv.status).toBe(201);

    const whBill = await ctx.api.post(`/api/purchasing/orders/${po.id}/bills`)
      .set('Authorization', `Bearer ${wh.token}`)
      .send({ lines: [{ order_item_id: po.oiId, item_id: item, name: 'Perm Item', quantity: 4, unit_price: 3 }] });
    expect(whBill.status).toBe(403);
  });
});
