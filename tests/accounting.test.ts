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

describe('accounting: general ledger (Phase 0)', () => {
  let cash = 0, sales = 0, ar = 0, rent = 0;

  it('setup seeds the chart of accounts + fiscal year and enables the ledger', async () => {
    const wh = await createEmployee(ctx.api, token, { role: 'warehouse', username: 'gl_wh' });
    expect((await ctx.api.post('/api/accounting/ledger/setup').set('Authorization', `Bearer ${wh.token}`)
      .send({ fiscal_year_start: '2026-01-01' })).status).toBe(403);

    const s = await ctx.api.post('/api/accounting/ledger/setup').set(hdr()).send({ fiscal_year_start: '2026-01-01' });
    expect(s.status).toBe(201);
    const st = await ctx.api.get('/api/accounting/ledger/settings').set(hdr());
    expect(st.body.enabled).toBe(true);
    expect(st.body.accounts).toBeGreaterThan(30);

    const accs = (await ctx.api.get('/api/accounting/ledger/accounts').set(hdr())).body;
    cash = accs.find((a: { code: string }) => a.code === '1110').id;
    ar = accs.find((a: { code: string }) => a.code === '1140').id;
    sales = accs.find((a: { code: string }) => a.code === '4100').id;
    rent = accs.find((a: { code: string }) => a.code === '6200').id;
  });

  it('rejects an unbalanced entry, posts a balanced one with a gapless number', async () => {
    const bad = await ctx.api.post('/api/accounting/ledger/journal-entries').set(hdr()).send({
      entry_date: '2026-02-01', lines: [{ account_id: cash, debit: 1000 }, { account_id: sales, credit: 900 }],
    });
    expect(bad.status).toBe(400);

    const je = await ctx.api.post('/api/accounting/ledger/journal-entries').set(hdr()).send({
      entry_date: '2026-02-01', memo: 'Cash sale',
      lines: [{ account_id: cash, debit: 1000 }, { account_id: sales, credit: 1000 }],
    });
    expect(je.status).toBe(201);
    expect(je.body.number).toMatch(/^JV-\d{6}$/);

    const posted = await ctx.api.post(`/api/accounting/ledger/journal-entries/${je.body.id}/post`).set(hdr()).send({});
    expect(posted.status).toBe(200);
    // a second post is rejected
    expect((await ctx.api.post(`/api/accounting/ledger/journal-entries/${je.body.id}/post`).set(hdr()).send({})).status).toBe(409);
  });

  it('void posts an equal-and-opposite reversing entry', async () => {
    const je = await ctx.api.post('/api/accounting/ledger/journal-entries').set(hdr()).send({
      entry_date: '2026-02-05', memo: 'Rent on account',
      lines: [{ account_id: rent, debit: 5000 }, { account_id: ar, credit: 5000 }],
    });
    await ctx.api.post(`/api/accounting/ledger/journal-entries/${je.body.id}/post`).set(hdr()).send({});
    const v = await ctx.api.post(`/api/accounting/ledger/journal-entries/${je.body.id}/void`).set(hdr()).send({});
    expect(v.status).toBe(200);
    const rev = await ctx.api.get(`/api/accounting/ledger/journal-entries/${v.body.reversal_id}`).set(hdr());
    expect(rev.body.reverses_id).toBe(je.body.id);
    const rentLine = rev.body.lines.find((l: { account_id: number }) => l.account_id === rent);
    expect(rentLine.credit).toBe(5000);   // debit and credit swapped
    // net effect of the rent account is now zero
    const tb = await ctx.api.get('/api/accounting/ledger/reports/trial-balance').set(hdr());
    expect(tb.body.balanced).toBe(true);
    expect(tb.body.rows.some((r: { account_id: number }) => r.account_id === rent)).toBe(false);
  });

  it('trial balance, P&L and balance sheet tie out', async () => {
    const tb = await ctx.api.get('/api/accounting/ledger/reports/trial-balance?as_of=2026-12-31').set(hdr());
    expect(tb.body.balanced).toBe(true);
    expect(tb.body.total_debit).toBe(tb.body.total_credit);

    const pnl = await ctx.api.get('/api/accounting/ledger/reports/profit-and-loss?from=2026-01-01&to=2026-12-31').set(hdr());
    expect(pnl.body.total_income).toBe(1000);   // only the surviving cash sale
    expect(pnl.body.net_income).toBe(1000);

    const bs = await ctx.api.get('/api/accounting/ledger/reports/balance-sheet?as_of=2026-12-31').set(hdr());
    expect(bs.body.balanced).toBe(true);
    expect(bs.body.equity.current_period_earnings).toBe(1000);
    expect(bs.body.total_assets).toBe(bs.body.total_liabilities_and_equity);
  });

  it('a closed period blocks posting into it', async () => {
    const p = await ctx.api.post('/api/accounting/ledger/periods').set(hdr())
      .send({ name: 'Jan 2026', start_date: '2026-01-01', end_date: '2026-01-31' });
    await ctx.api.post(`/api/accounting/ledger/periods/${p.body.id}/close`).set(hdr()).send({});
    const je = await ctx.api.post('/api/accounting/ledger/journal-entries').set(hdr()).send({
      entry_date: '2026-01-15', lines: [{ account_id: cash, debit: 10 }, { account_id: sales, credit: 10 }],
    });
    const posted = await ctx.api.post(`/api/accounting/ledger/journal-entries/${je.body.id}/post`).set(hdr()).send({});
    expect(posted.status).toBe(409);
    expect(posted.body.error).toMatch(/closed period/i);
  });

  it('an account with entries cannot be deleted or re-typed', async () => {
    expect((await ctx.api.delete(`/api/accounting/ledger/accounts/${cash}`).set(hdr())).status).toBe(409);
    const acc = (await ctx.api.get('/api/accounting/ledger/accounts').set(hdr())).body.find((a: { id: number }) => a.id === cash);
    const put = await ctx.api.put(`/api/accounting/ledger/accounts/${cash}`).set(hdr())
      .send({ ...acc, root_type: 'expense' });
    expect(put.status).toBe(409);
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

describe('accounting: auto-posting sales & purchases (Phase 1)', () => {
  // The Phase 0 block above has already run POST /ledger/setup, so the ledger is live.
  let soId = 0;
  const lineByCode = (lines: { account_code: string; debit: number; credit: number }[], code: string) =>
    lines.find((l) => l.account_code === code)!;

  it('setup seeded the posting rules from the default chart of accounts', async () => {
    const r = await ctx.api.get('/api/accounting/ledger/posting-rules').set(hdr());
    expect(r.status).toBe(200);
    expect(r.body.resolved.ar_account_id.code).toBe('1140');
    expect(r.body.resolved.sales_income_account_id.code).toBe('4100');
    expect(r.body.resolved.output_vat_account_id.code).toBe('2120');
    expect(r.body.resolved.ap_account_id.code).toBe('2110');
    expect(r.body.resolved.input_vat_account_id.code).toBe('1160');
  });

  it('rejects a posting rule pointed at the wrong root type', async () => {
    const accs = (await ctx.api.get('/api/accounting/ledger/accounts').set(hdr())).body;
    const rent = accs.find((a: { code: string }) => a.code === '6200').id; // an expense
    const bad = await ctx.api.put('/api/accounting/ledger/posting-rules').set(hdr())
      .send({ ar_account_id: rent });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/expected asset/i);
  });

  it('a confirmed sale order auto-posts to the sales journal', async () => {
    const so = await ctx.api.post('/api/orders').set(hdr()).send({
      type: 'sale', customer_name: 'Cust A', order_date: '2026-03-04', status: 'confirmed',
      tax_percent: 12,
      items: [{ name: 'Widget', quantity: 10, unit_price: 100 }], // subtotal 1000, VAT 120, total 1120
    });
    expect(so.status).toBe(201);
    soId = so.body.id;

    const list = await ctx.api.get('/api/accounting/ledger/journal-entries')
      .query({ source_type: 'sale_order', source_id: soId }).set(hdr());
    expect(list.body.length).toBe(1);

    const je = (await ctx.api.get(`/api/accounting/ledger/journal-entries/${list.body[0].id}`).set(hdr())).body;
    expect(je.status).toBe('posted');
    expect(je.book).toBe('sales');
    expect(lineByCode(je.lines, '1140').debit).toBe(1120);
    expect(lineByCode(je.lines, '4100').credit).toBe(1000);
    expect(lineByCode(je.lines, '2120').credit).toBe(120);
  });

  it('re-saving the still-confirmed order does not post a second entry', async () => {
    await ctx.api.put(`/api/orders/${soId}`).set(hdr()).send({
      customer_name: 'Cust A (rev)', order_date: '2026-03-04', status: 'confirmed', tax_percent: 12,
      items: [{ name: 'Widget', quantity: 10, unit_price: 100 }],
    });
    const list = await ctx.api.get('/api/accounting/ledger/journal-entries')
      .query({ source_type: 'sale_order', source_id: soId }).set(hdr());
    expect(list.body.length).toBe(1);
  });

  it('pulling the order back to open reverses the posting', async () => {
    await ctx.api.put(`/api/orders/${soId}`).set(hdr()).send({
      customer_name: 'Cust A', order_date: '2026-03-04', status: 'open', tax_percent: 12,
      items: [{ name: 'Widget', quantity: 10, unit_price: 100 }],
    });
    const list = await ctx.api.get('/api/accounting/ledger/journal-entries')
      .query({ source_type: 'sale_order', source_id: soId }).set(hdr());
    expect(list.body.length).toBe(2); // original + reversal, both posted
    const tb = await ctx.api.get('/api/accounting/ledger/reports/trial-balance').set(hdr());
    expect(tb.body.balanced).toBe(true);
  });

  it('an approved vendor bill auto-posts to the purchase journal', async () => {
    const loc = (await ctx.api.get('/api/locations').set(hdr())).body
      .find((l: { is_default: number }) => l.is_default === 1).id;
    const item = (await ctx.api.post('/api/inventory').set(hdr())
      .send({ name: 'P1 Widget', quantity: 0 })).body.id;
    const po = await ctx.api.post('/api/orders').set(hdr()).send({
      type: 'purchase', order_date: '2026-03-10', tax_percent: 12,
      items: [{ item_id: item, name: 'P1 Widget', quantity: 5, unit_price: 200 }], // sub 1000, VAT 120, total 1120
    });
    const oi = (await ctx.api.get(`/api/orders/${po.body.id}`).set(hdr())).body.items[0].id;
    await ctx.api.post(`/api/purchasing/orders/${po.body.id}/receipts`).set(hdr())
      .send({ location_id: loc, lines: [{ order_item_id: oi, item_id: item, name: 'P1 Widget', quantity: 5 }] });
    const bill = await ctx.api.post(`/api/purchasing/orders/${po.body.id}/bills`).set(hdr())
      .send({ bill_date: '2026-03-10', tax_percent: 12,
        lines: [{ order_item_id: oi, item_id: item, name: 'P1 Widget', quantity: 5, unit_price: 200 }] });
    const appr = await ctx.api.post(`/api/purchasing/bills/${bill.body.id}/approve`).set(hdr()).send({});
    expect(appr.status).toBe(200);

    const list = await ctx.api.get('/api/accounting/ledger/journal-entries')
      .query({ source_type: 'vendor_bill', source_id: bill.body.id }).set(hdr());
    expect(list.body.length).toBe(1);
    const je = (await ctx.api.get(`/api/accounting/ledger/journal-entries/${list.body[0].id}`).set(hdr())).body;
    expect(je.book).toBe('purchase');
    expect(lineByCode(je.lines, '5100').debit).toBe(1000);
    expect(lineByCode(je.lines, '1160').debit).toBe(120);
    expect(lineByCode(je.lines, '2110').credit).toBe(1120);

    // disputing the approved bill reverses it
    await ctx.api.post(`/api/purchasing/bills/${bill.body.id}/dispute`).set(hdr()).send({ note: 'wrong price' });
    const after = await ctx.api.get('/api/accounting/ledger/journal-entries')
      .query({ source_type: 'vendor_bill', source_id: bill.body.id }).set(hdr());
    expect(after.body.length).toBe(2);
    const tb = await ctx.api.get('/api/accounting/ledger/reports/trial-balance').set(hdr());
    expect(tb.body.balanced).toBe(true);
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

describe('accounting: receivables & payables (Phase 1b)', () => {
  // Ledger already set up by the Phase 0 block.
  let cashAcct = 0, custId = 0, soId = 0, receiptId = 0;

  it('exposes cash / bank accounts for the deposit picker', async () => {
    const r = await ctx.api.get('/api/accounting/cash-accounts').set(hdr());
    expect(r.status).toBe(200);
    cashAcct = r.body.find((a: { code: string }) => a.code === '1110').id;
    expect(cashAcct).toBeGreaterThan(0);
  });

  it('a confirmed sale for a customer shows in AR aging, aged by the customer terms', async () => {
    custId = (await ctx.api.post('/api/customers').set(hdr())
      .send({ name: 'Aging Co', payment_terms_days: 30 })).body.id;
    soId = (await ctx.api.post('/api/orders').set(hdr()).send({
      type: 'sale', customer_id: custId, order_date: '2026-05-01', status: 'confirmed',
      items: [{ name: 'Widget', quantity: 10, unit_price: 100 }], // total 1000, no tax
    })).body.id;

    const near = await ctx.api.get('/api/accounting/ar-aging?as_of=2026-05-15').set(hdr());
    const p1 = near.body.parties.find((p: { party_id: number }) => p.party_id === custId);
    expect(p1.total).toBe(1000);
    expect(p1.buckets.current).toBe(1000); // due 2026-05-31, not yet overdue

    const later = await ctx.api.get('/api/accounting/ar-aging?as_of=2026-07-15').set(hdr());
    const p2 = later.body.parties.find((p: { party_id: number }) => p.party_id === custId);
    expect(p2.buckets['31_60']).toBe(1000); // 45 days past due
  });

  it('a receipt allocated to the order reduces the open balance and posts a cash-book entry', async () => {
    const r = await ctx.api.post('/api/accounting/payments').set(hdr()).send({
      direction: 'in', party_type: 'customer', party_id: custId, payment_date: '2026-05-20',
      amount: 400, deposit_account_id: cashAcct,
      allocations: [{ doc_type: 'sale_order', doc_id: soId, amount: 400 }],
    });
    expect(r.status).toBe(201);
    expect(r.body.posted).toBe(true);
    receiptId = r.body.id;

    const aging = await ctx.api.get('/api/accounting/ar-aging?as_of=2026-05-25').set(hdr());
    const p = aging.body.parties.find((x: { party_id: number }) => x.party_id === custId);
    expect(p.total).toBe(600);

    const list = await ctx.api.get('/api/accounting/payments?direction=in').set(hdr());
    expect(list.body.find((x: { id: number }) => x.id === receiptId).allocated).toBe(400);

    const je = await ctx.api.get('/api/accounting/ledger/journal-entries')
      .query({ source_type: 'payment', source_id: receiptId }).set(hdr());
    expect(je.body.length).toBe(1);
    expect(je.body[0].book).toBe('cash_receipts');
  });

  it('party ledger runs charges less payments to a balance', async () => {
    const s = await ctx.api.get(`/api/accounting/party-ledger?party_type=customer&party_id=${custId}`).set(hdr());
    expect(s.body.total_charges).toBe(1000);
    expect(s.body.total_payments).toBe(400);
    expect(s.body.balance).toBe(600);
  });

  it('voiding the receipt restores the open balance and reverses the entry', async () => {
    const v = await ctx.api.post(`/api/accounting/payments/${receiptId}/void`).set(hdr()).send({});
    expect(v.status).toBe(200);
    const aging = await ctx.api.get('/api/accounting/ar-aging?as_of=2026-05-25').set(hdr());
    const p = aging.body.parties.find((x: { party_id: number }) => x.party_id === custId);
    expect(p.total).toBe(1000);
    const je = await ctx.api.get('/api/accounting/ledger/journal-entries')
      .query({ source_type: 'payment', source_id: receiptId }).set(hdr());
    expect(je.body.length).toBe(2); // original + reversal
    const tb = await ctx.api.get('/api/accounting/ledger/reports/trial-balance').set(hdr());
    expect(tb.body.balanced).toBe(true);
  });

  it('a customer credit note nets against the party in AR aging and reverses on void', async () => {
    const cn = await ctx.api.post('/api/accounting/credit-notes').set(hdr()).send({
      kind: 'customer', party_id: custId, note_date: '2026-05-22', subtotal: 250, tax_amount: 0,
      reason: 'Short shipment',
    });
    expect(cn.status).toBe(201);
    expect(cn.body.posted).toBe(true);

    const aging = await ctx.api.get('/api/accounting/ar-aging?as_of=2026-05-25').set(hdr());
    const p = aging.body.parties.find((x: { party_id: number }) => x.party_id === custId);
    expect(p.open).toBe(1000);
    expect(p.credits).toBe(250);
    expect(p.total).toBe(750);

    const je = await ctx.api.get('/api/accounting/ledger/journal-entries')
      .query({ source_type: 'credit_note', source_id: cn.body.id }).set(hdr());
    expect(je.body.length).toBe(1);
    expect(je.body[0].book).toBe('sales');

    const st = await ctx.api.get(`/api/accounting/party-ledger?party_type=customer&party_id=${custId}`).set(hdr());
    expect(st.body.lines.some((l: { kind: string; charge: number }) => l.kind === 'credit_note' && l.charge === -250)).toBe(true);

    await ctx.api.post(`/api/accounting/credit-notes/${cn.body.id}/void`).set(hdr()).send({});
    const after = await ctx.api.get('/api/accounting/ar-aging?as_of=2026-05-25').set(hdr());
    const p2 = after.body.parties.find((x: { party_id: number }) => x.party_id === custId);
    expect(p2.total).toBe(1000);
    const tb = await ctx.api.get('/api/accounting/ledger/reports/trial-balance').set(hdr());
    expect(tb.body.balanced).toBe(true);
  });

  it('AP aging + a disbursement against an approved vendor bill', async () => {
    const loc = (await ctx.api.get('/api/locations').set(hdr())).body
      .find((l: { is_default: number }) => l.is_default === 1).id;
    const item = (await ctx.api.post('/api/inventory').set(hdr()).send({ name: 'AP Widget', quantity: 0 })).body.id;
    const supplierId = (await ctx.api.post('/api/suppliers').set(hdr()).send({ name: 'AP Vendor Inc' })).body.id;
    const po = await ctx.api.post('/api/orders').set(hdr()).send({
      type: 'purchase', order_date: '2026-05-02', supplier_id: supplierId,
      items: [{ item_id: item, name: 'AP Widget', quantity: 4, unit_price: 250 }], // total 1000
    });
    const oi = (await ctx.api.get(`/api/orders/${po.body.id}`).set(hdr())).body.items[0].id;
    await ctx.api.post(`/api/purchasing/orders/${po.body.id}/receipts`).set(hdr())
      .send({ location_id: loc, lines: [{ order_item_id: oi, item_id: item, name: 'AP Widget', quantity: 4 }] });
    const bill = await ctx.api.post(`/api/purchasing/orders/${po.body.id}/bills`).set(hdr())
      .send({ bill_date: '2026-05-02', due_date: '2026-05-20',
        lines: [{ order_item_id: oi, item_id: item, name: 'AP Widget', quantity: 4, unit_price: 250 }] });
    await ctx.api.post(`/api/purchasing/bills/${bill.body.id}/approve`).set(hdr()).send({});

    const aging = await ctx.api.get('/api/accounting/ap-aging?as_of=2026-06-01').set(hdr());
    const p = aging.body.parties.find((x: { party_id: number | null }) => x.party_id === supplierId);
    expect(p.total).toBe(1000);
    expect(p.buckets['1_30']).toBe(1000); // due 2026-05-20, ~12 days past on 2026-06-01

    const pay = await ctx.api.post('/api/accounting/payments').set(hdr()).send({
      direction: 'out', party_type: 'supplier', party_id: supplierId, payment_date: '2026-05-18',
      amount: 1000, deposit_account_id: cashAcct,
      allocations: [{ doc_type: 'vendor_bill', doc_id: bill.body.id, amount: 1000 }],
    });
    expect(pay.status).toBe(201);
    const after = await ctx.api.get('/api/accounting/ap-aging?as_of=2026-06-01').set(hdr());
    expect(after.body.parties.find((x: { party_id: number | null }) => x.party_id === supplierId)).toBeUndefined();

    const tb = await ctx.api.get('/api/accounting/ledger/reports/trial-balance').set(hdr());
    expect(tb.body.balanced).toBe(true);
  });

  it('rejects an allocation whose type does not match the direction', async () => {
    const bad = await ctx.api.post('/api/accounting/payments').set(hdr()).send({
      direction: 'in', party_type: 'customer', party_id: custId, payment_date: '2026-05-20',
      amount: 100, deposit_account_id: cashAcct,
      allocations: [{ doc_type: 'vendor_bill', doc_id: 1, amount: 100 }],
    });
    expect(bad.status).toBe(400);
  });
});

describe('accounting: tax codes + BIR journals (Phase 2)', () => {
  let vatCode = 0, exemptCode = 0, custId = 0;

  it('ships the standard PH tax codes, VAT ones linked to GL accounts at setup', async () => {
    const r = await ctx.api.get('/api/accounting/tax-codes').set(hdr());
    expect(r.status).toBe(200);
    const byCode = Object.fromEntries(r.body.map((t: { code: string }) => [t.code, t]));
    expect(byCode.VAT.kind).toBe('output_vat');
    expect(byCode.VAT.rate).toBe(12);
    expect(byCode['VAT-EX'].kind).toBe('exempt');
    expect(byCode.EWT2.atc).toBe('WI100');
    // ledger/setup ran in the Phase 0 block, so the VAT codes are wired to 2120 / 1160
    const accs = (await ctx.api.get('/api/accounting/ledger/accounts').set(hdr())).body;
    expect(byCode.VAT.account_id).toBe(accs.find((a: { code: string }) => a.code === '2120').id);
    expect(byCode['VAT-IN'].account_id).toBe(accs.find((a: { code: string }) => a.code === '1160').id);
    vatCode = byCode.VAT.id;
    exemptCode = byCode['VAT-EX'].id;
  });

  it('CRUD a custom tax code; deleting one in use is blocked', async () => {
    const c = await ctx.api.post('/api/accounting/tax-codes').set(hdr())
      .send({ code: 'VAT-GOV', name: 'Sales to government (5% final)', kind: 'output_vat', rate: 12 });
    expect(c.status).toBe(201);
    expect((await ctx.api.put(`/api/accounting/tax-codes/${c.body.id}`).set(hdr())
      .send({ code: 'VAT-GOV', name: 'Gov sales', kind: 'output_vat', rate: 12, active: false })).status).toBe(200);
    expect((await ctx.api.delete(`/api/accounting/tax-codes/${c.body.id}`).set(hdr())).status).toBe(200);

    // now attach VAT-EX to an order, then it can't be deleted
    custId = (await ctx.api.post('/api/customers').set(hdr()).send({ name: 'TaxCo', tin: '111-222-333-000' })).body.id;
    await ctx.api.post('/api/orders').set(hdr()).send({
      type: 'sale', customer_id: custId, tax_code_id: exemptCode, order_date: '2026-06-03', status: 'confirmed',
      items: [{ name: 'Exempt goods', quantity: 1, unit_price: 500 }],
    });
    expect((await ctx.api.delete(`/api/accounting/tax-codes/${exemptCode}`).set(hdr())).status).toBe(409);
  });

  it('a VAT-exempt sale posts with no VAT leg and lands in the exempt column of the sales journal', async () => {
    const so = await ctx.api.post('/api/orders').set(hdr()).send({
      type: 'sale', customer_id: custId, tax_code_id: exemptCode, order_date: '2026-06-05', status: 'confirmed',
      items: [{ name: 'More exempt goods', quantity: 2, unit_price: 300 }], // total 600, no tax
    });
    const jes = await ctx.api.get('/api/accounting/ledger/journal-entries')
      .query({ source_type: 'sale_order', source_id: so.body.id }).set(hdr());
    const je = (await ctx.api.get(`/api/accounting/ledger/journal-entries/${jes.body[0].id}`).set(hdr())).body;
    expect(je.lines).toHaveLength(2); // DR AR / CR Sales, no output VAT

    const sj = await ctx.api.get('/api/accounting/sales-journal?from=2026-06-01&to=2026-06-30').set(hdr());
    expect(sj.status).toBe(200);
    const row = sj.body.rows.find((r: { ref: string }) => r.ref === so.body.number);
    expect(row.cols.exempt).toBe(600);
    expect(row.cols.vat).toBe(0);
    expect(row.tin).toBe('111-222-333-000');
    expect(sj.body.totals.exempt).toBeGreaterThanOrEqual(1100); // 500 + 600 from the two exempt sales
  });

  it('a VAT sale splits into vatable + output VAT columns', async () => {
    const so = await ctx.api.post('/api/orders').set(hdr()).send({
      type: 'sale', customer_id: custId, tax_code_id: vatCode, order_date: '2026-06-10', status: 'confirmed',
      tax_percent: 12, items: [{ name: 'Vatable goods', quantity: 10, unit_price: 100 }], // sub 1000, VAT 120
    });
    const sj = await ctx.api.get('/api/accounting/sales-journal?from=2026-06-01&to=2026-06-30').set(hdr());
    const row = sj.body.rows.find((r: { ref: string }) => r.ref === so.body.number);
    expect(row.cols.vatable).toBe(1000);
    expect(row.cols.vat).toBe(120);
    expect(row.cols.gross).toBe(1120);
  });

  it('purchase journal lists approved bills with their VAT split', async () => {
    const pj = await ctx.api.get('/api/accounting/purchase-journal?from=2026-01-01&to=2026-12-31').set(hdr());
    expect(pj.status).toBe(200);
    expect(Array.isArray(pj.body.rows)).toBe(true);
    expect(pj.body.totals).toHaveProperty('vatable');
  });
});
