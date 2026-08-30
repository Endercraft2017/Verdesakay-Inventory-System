/** Accounting → Tax & Compliance: BIR 0619-E / 2550M + the accounting.view gate.
    (The BIR 1601-C/1604-C/2316/Alphalist + contribution-schedule endpoints moved here
    from /api/hr and are covered in tests/hr.test.ts against their new /api/accounting paths.) */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';

let ctx: TestContext;
let token: string;
const hdr = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  ctx = await setupApp();
  token = await login(ctx.api);
});
afterAll(() => cleanup(ctx));

describe('accounting: 2550M (VAT)', () => {
  it('nets output VAT (sale orders) against input VAT (approved vendor bills)', async () => {
    const loc = (await ctx.api.get('/api/locations').set(hdr())).body.find((l: { is_default: number }) => l.is_default === 1).id;
    const item = (await ctx.api.post('/api/inventory').set(hdr()).send({ name: 'VAT Widget', quantity: 100 })).body.id;

    // A sale this month: total 11,200 incl. 1,200 VAT.
    await ctx.api.post('/api/orders').set(hdr()).send({
      type: 'sale', status: 'open', order_date: '2026-07-05', tax_percent: 12,
      items: [{ item_id: item, name: 'VAT Widget', quantity: 10, unit_price: 1000 }],
    });
    // A purchase this month, received + billed + approved: 5,600 incl. 600 VAT.
    const po = await ctx.api.post('/api/orders').set(hdr()).send({
      type: 'purchase', order_date: '2026-07-03', tax_percent: 12,
      items: [{ item_id: item, name: 'VAT Widget', quantity: 5, unit_price: 1000 }],
    });
    const oi = (await ctx.api.get(`/api/orders/${po.body.id}`).set(hdr())).body.items[0].id;
    await ctx.api.post(`/api/purchasing/orders/${po.body.id}/receipts`).set(hdr())
      .send({ location_id: loc, lines: [{ order_item_id: oi, item_id: item, name: 'VAT Widget', quantity: 5 }] });
    const bill = await ctx.api.post(`/api/purchasing/orders/${po.body.id}/bills`).set(hdr())
      .send({ bill_date: '2026-07-03', tax_percent: 12, lines: [{ order_item_id: oi, item_id: item, name: 'VAT Widget', quantity: 5, unit_price: 1000 }] });
    await ctx.api.post(`/api/purchasing/bills/${bill.body.id}/approve`).set(hdr()).send({});

    const r = await ctx.api.get('/api/accounting/bir-2550m?month=2026-07').set(hdr());
    expect(r.status).toBe(200);
    expect(r.body.worksheet.output_vat).toBeCloseTo(1_200, 2);
    expect(r.body.worksheet.input_vat_current).toBeCloseTo(600, 2);
    expect(r.body.worksheet.net_vat_payable).toBeCloseTo(600, 2);
  });
});

describe('accounting: 0619-E (expanded withholding)', () => {
  it('returns the ATC reference and computes tax from supplied lines', async () => {
    const seed = await ctx.api.get('/api/accounting/bir-0619e?month=2026-07').set(hdr());
    expect(seed.status).toBe(200);
    expect(Array.isArray(seed.body.atc_reference)).toBe(true);
    expect(seed.body.worksheet.total_tax_withheld).toBe(0);

    const lines = JSON.stringify([{ atc: 'WI100', description: 'Rentals', tax_base: 40000, rate: 0.05 }]);
    const r = await ctx.api.get('/api/accounting/bir-0619e').query({ month: '2026-07', lines, remitted_prior: 500 }).set(hdr());
    expect(r.body.worksheet.total_tax_withheld).toBe(2_000);
    expect(r.body.worksheet.still_payable).toBe(1_500);
  });
});

describe('accounting: permission gate', () => {
  it('needs accounting.view (warehouse 403, accounting 200)', async () => {
    const wh = await createEmployee(ctx.api, token, { role: 'warehouse', username: 'acc_wh' });
    const acc = await createEmployee(ctx.api, token, { role: 'accounting', username: 'acc_acc' });

    expect((await ctx.api.get('/api/accounting/bir-1601c?year=2026').set('Authorization', `Bearer ${wh.token}`)).status).toBe(403);
    expect((await ctx.api.get('/api/accounting/bir-1601c?year=2026').set('Authorization', `Bearer ${acc.token}`)).status).toBe(200);
    expect((await ctx.api.get('/api/accounting/bir-2550m?month=2026-07').set('Authorization', `Bearer ${acc.token}`)).status).toBe(200);
  });
});

describe('accounting: petty cash', () => {
  it('fund + money in/out with a running balance, opening carry, delete, and gates', async () => {
    // warehouse (no accounting.manage) can't create a fund
    const wh = await createEmployee(ctx.api, token, { role: 'warehouse', username: 'pc_wh' });
    const blocked = await ctx.api.post('/api/accounting/petty-cash/funds')
      .set('Authorization', `Bearer ${wh.token}`).send({ name: 'Nope', opening_balance: 100 });
    expect(blocked.status).toBe(403);

    const fund = await ctx.api.post('/api/accounting/petty-cash/funds').set(hdr())
      .send({ name: 'Main Petty Cash', custodian: 'Ana', opening_balance: 5000 });
    expect(fund.status).toBe(201);

    const list = await ctx.api.get('/api/accounting/petty-cash/funds').set(hdr());
    const f = list.body.find((x: { id: number }) => x.id === fund.body.id);
    expect(f.balance).toBe(5000);
    expect(f.entry_count).toBe(0);

    const post = (b: Record<string, unknown>) =>
      ctx.api.post(`/api/accounting/petty-cash/funds/${fund.body.id}/entries`).set(hdr()).send(b);
    await post({ entry_date: '2026-07-02', direction: 'out', amount: 350, category: 'Transport', counterparty: 'Grab' });
    await post({ entry_date: '2026-07-05', direction: 'out', amount: 1200, category: 'Office supplies' });
    await post({ entry_date: '2026-07-10', direction: 'in', amount: 2000, category: 'Replenishment', reference_no: 'OR-77' });

    const reg = await ctx.api.get(`/api/accounting/petty-cash/funds/${fund.body.id}/entries`).set(hdr());
    expect(reg.body.opening_balance).toBe(5000);
    expect(reg.body.totals).toMatchObject({ in: 2000, out: 1550, net: 450 });
    expect(reg.body.closing_balance).toBe(5450);
    expect(reg.body.entries.map((e: { running_balance: number }) => e.running_balance)).toEqual([4650, 3450, 5450]);

    // date-range: opening carries the earlier entries
    const ranged = await ctx.api.get(`/api/accounting/petty-cash/funds/${fund.body.id}/entries`)
      .query({ from: '2026-07-06' }).set(hdr());
    expect(ranged.body.opening_balance).toBe(3450); // 5000 - 350 - 1200
    expect(ranged.body.entries).toHaveLength(1);
    expect(ranged.body.closing_balance).toBe(5450);

    // deleting a fund with entries is blocked; an entry can be removed and the balance re-computes
    expect((await ctx.api.delete(`/api/accounting/petty-cash/funds/${fund.body.id}`).set(hdr())).status).toBe(409);
    const delId = reg.body.entries[1].id; // the 1,200 out
    expect((await ctx.api.delete(`/api/accounting/petty-cash/entries/${delId}`).set(hdr())).status).toBe(200);
    const after = await ctx.api.get(`/api/accounting/petty-cash/funds/${fund.body.id}/entries`).set(hdr());
    expect(after.body.closing_balance).toBe(6650); // 5000 - 350 + 2000

    // CSV
    const csv = await ctx.api.get(`/api/accounting/petty-cash/funds/${fund.body.id}/entries`)
      .query({ format: 'csv' }).set(hdr());
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('Running balance');
  });
});

describe('accounting: statutory deductions per employee', () => {
  it('lists employees with all four switches defaulting on; PUT toggles them; needs accounting.manage', async () => {
    const e1 = await ctx.api.post('/api/hr/employees').set(hdr()).send({ employee_no: 'SD-1', name: 'Deduct One', daily_rate: 900 });

    const list = await ctx.api.get('/api/accounting/statutory-deductions').set(hdr());
    expect(list.status).toBe(200);
    const row = list.body.rows.find((r: { id: number }) => r.id === e1.body.id);
    expect(row).toMatchObject({ deduct_sss: true, deduct_philhealth: true, deduct_pagibig: true, deduct_withholding_tax: true });

    // warehouse (no accounting.manage) can't write
    const wh = await createEmployee(ctx.api, token, { role: 'warehouse', username: 'sd_wh' });
    const blocked = await ctx.api.put('/api/accounting/statutory-deductions')
      .set('Authorization', `Bearer ${wh.token}`)
      .send({ updates: [{ employee_id: e1.body.id, deduct_sss: false }] });
    expect(blocked.status).toBe(403);

    const ok = await ctx.api.put('/api/accounting/statutory-deductions').set(hdr())
      .send({ updates: [{ employee_id: e1.body.id, deduct_sss: false, deduct_pagibig: false }] });
    expect(ok.status).toBe(200);
    expect(ok.body.updated).toBe(1);

    const after = await ctx.api.get('/api/accounting/statutory-deductions').set(hdr());
    const row2 = after.body.rows.find((r: { id: number }) => r.id === e1.body.id);
    expect(row2).toMatchObject({ deduct_sss: false, deduct_philhealth: true, deduct_pagibig: false, deduct_withholding_tax: true });
  });
});
