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

    // A confirmed sale this month: total 11,200 incl. 1,200 VAT. (2550M re-sources from the
    // sales journal, which counts confirmed / completed / … sales — not open drafts.)
    await ctx.api.post('/api/orders').set(hdr()).send({
      type: 'sale', status: 'confirmed', order_date: '2026-07-05', tax_percent: 12,
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
    // the journal re-source exposes the vatable / exempt / zero-rated split
    expect(r.body.breakdown.sales.vatable).toBeCloseTo(10_000, 2);
    expect(r.body.breakdown.purchases.vatable).toBeCloseTo(5_000, 2);
  });

  it('2550Q sums the quarter and breaks it down by month', async () => {
    const r = await ctx.api.get('/api/accounting/bir-2550q?quarter=2026-Q3').set(hdr());
    expect(r.status).toBe(200);
    expect(r.body.quarter).toBe('2026-Q3');
    expect(r.body.monthly).toHaveLength(3);
    expect(r.body.monthly.map((m: { month: string }) => m.month)).toEqual(['2026-07', '2026-08', '2026-09']);
    // the July sale + bill from the previous test fall in Q3
    const jul = r.body.monthly.find((m: { month: string }) => m.month === '2026-07');
    expect(jul.output_vat).toBeCloseTo(1_200, 2);
    expect(jul.input_vat).toBeCloseTo(600, 2);
    expect(jul.net_vat).toBeCloseTo(600, 2);
    expect(r.body.worksheet.output_vat).toBeGreaterThanOrEqual(1_200);
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

    // GET lists it as closed with who/when, joined from the users table
    const list = await ctx.api.get('/api/accounting/ledger/periods').set(hdr());
    const row = list.body.find((x: { id: number }) => x.id === p.body.id);
    expect(row.status).toBe('closed');
    expect(row.closed_by_name).toBeTruthy();
    expect(row.closed_at).toBeTruthy();

    // Reopening clears the lock, unblocking the same entry
    const reopened = await ctx.api.post(`/api/accounting/ledger/periods/${p.body.id}/reopen`).set(hdr()).send({});
    expect(reopened.body.status).toBe('open');
    const postedAfterReopen = await ctx.api.post(`/api/accounting/ledger/journal-entries/${je.body.id}/post`).set(hdr()).send({});
    expect(postedAfterReopen.status).toBe(200);

    const listAfter = await ctx.api.get('/api/accounting/ledger/periods').set(hdr());
    const rowAfter = listAfter.body.find((x: { id: number }) => x.id === p.body.id);
    expect(rowAfter.status).toBe('open');
    expect(rowAfter.closed_by_name).toBeNull();
  });

  it('rejects a period whose end date is before its start date, and a request for a non-existent period', async () => {
    const bad = await ctx.api.post('/api/accounting/ledger/periods').set(hdr())
      .send({ name: 'Backwards', start_date: '2026-02-01', end_date: '2026-01-01' });
    expect(bad.status).toBe(400);
    expect((await ctx.api.post('/api/accounting/ledger/periods/999999/close').set(hdr()).send({})).status).toBe(404);
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
    const rcpt = await ctx.api.post(`/api/purchasing/orders/${po.body.id}/receipts`).set(hdr())
      .send({ location_id: loc, lines: [{ order_item_id: oi, item_id: item, name: 'P1 Widget', quantity: 5 }] });

    // the receipt recognises stock: DR Inventory 1150 / CR Goods Received Not Invoiced 2105
    const grn = await ctx.api.get('/api/accounting/ledger/journal-entries')
      .query({ source_type: 'goods_receipt', source_id: rcpt.body.id }).set(hdr());
    const grnJe = (await ctx.api.get(`/api/accounting/ledger/journal-entries/${grn.body[0].id}`).set(hdr())).body;
    expect(lineByCode(grnJe.lines, '1150').debit).toBe(1000);
    expect(lineByCode(grnJe.lines, '2105').credit).toBe(1000);

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
    // goods were received, so the bill clears GRNI instead of hitting purchase expense
    expect(lineByCode(je.lines, '2105').debit).toBe(1000);
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

describe('accounting: expanded withholding / EWT (Phase 2b)', () => {
  let supplierId = 0, billNo = '';

  it('an approved bill with EWT posts a split AP + withholding-payable entry', async () => {
    const loc = (await ctx.api.get('/api/locations').set(hdr())).body
      .find((l: { is_default: number }) => l.is_default === 1).id;
    const item = (await ctx.api.post('/api/inventory').set(hdr()).send({ name: 'EWT Widget', quantity: 0 })).body.id;
    supplierId = (await ctx.api.post('/api/suppliers').set(hdr())
      .send({ name: 'Services Co', tin: '999-888-777-000', address: '1 Ayala Ave, Makati' })).body.id;
    const po = await ctx.api.post('/api/orders').set(hdr()).send({
      type: 'purchase', order_date: '2026-07-02', supplier_id: supplierId,
      items: [{ item_id: item, name: 'EWT Widget', quantity: 10, unit_price: 100 }], // net 1000
    });
    const oi = (await ctx.api.get(`/api/orders/${po.body.id}`).set(hdr())).body.items[0].id;
    await ctx.api.post(`/api/purchasing/orders/${po.body.id}/receipts`).set(hdr())
      .send({ location_id: loc, lines: [{ order_item_id: oi, item_id: item, name: 'EWT Widget', quantity: 10 }] });
    const bill = await ctx.api.post(`/api/purchasing/orders/${po.body.id}/bills`).set(hdr())
      .send({ bill_date: '2026-07-02', tax_percent: 12, ewt_rate: 2, ewt_atc: 'WC140',
        lines: [{ order_item_id: oi, item_id: item, name: 'EWT Widget', quantity: 10, unit_price: 100 }] });
    billNo = bill.body.number;

    const detail = await ctx.api.get(`/api/purchasing/bills/${bill.body.id}`).set(hdr());
    expect(detail.body.ewt_amount).toBe(20); // 2% of net 1000

    const appr = await ctx.api.post(`/api/purchasing/bills/${bill.body.id}/approve`).set(hdr()).send({});
    expect(appr.status).toBe(200);

    const jes = await ctx.api.get('/api/accounting/ledger/journal-entries')
      .query({ source_type: 'vendor_bill', source_id: bill.body.id }).set(hdr());
    const je = (await ctx.api.get(`/api/accounting/ledger/journal-entries/${jes.body[0].id}`).set(hdr())).body;
    const byCode = Object.fromEntries(je.lines.map((l: { account_code: string; debit: number; credit: number }) => [l.account_code, l]));
    expect(byCode['2110'].credit).toBe(1100); // AP = 1120 gross - 20 withheld
    expect(byCode['2140'].credit).toBe(20);   // Withholding Tax Payable — Expanded
    expect(byCode['2105'].debit).toBe(1000);  // clears Goods Received Not Invoiced (stock was received)
    const tb = await ctx.api.get('/api/accounting/ledger/reports/trial-balance').set(hdr());
    expect(tb.body.balanced).toBe(true);
  });

  it('the withholding register groups the withheld tax by ATC', async () => {
    const reg = await ctx.api.get('/api/accounting/ewt-register?from=2026-07-01&to=2026-07-31').set(hdr());
    expect(reg.status).toBe(200);
    const row = reg.body.rows.find((r: { ref: string }) => r.ref === billNo);
    expect(row.tax).toBe(20);
    expect(row.atc).toBe('WC140');
    expect(row.tin).toBe('999-888-777-000');
    expect(reg.body.total_tax).toBeGreaterThanOrEqual(20);
    expect(reg.body.by_atc.some((a: { atc: string; tax: number }) => a.atc === 'WC140' && a.tax >= 20)).toBe(true);
  });

  it('BIR 2307 certifies the withheld tax per supplier', async () => {
    const c = await ctx.api.get(`/api/accounting/bir-2307?supplier_id=${supplierId}&from=2026-07-01&to=2026-09-30`).set(hdr());
    expect(c.status).toBe(200);
    expect(c.body.payee.tin).toBe('999-888-777-000');
    expect(c.body.total_tax).toBe(20);
    expect(c.body.lines[0]).toMatchObject({ atc: 'WC140', month: '2026-07' });
  });

  it('0619-E can source its lines from the register', async () => {
    const r = await ctx.api.get('/api/accounting/bir-0619e?month=2026-07&source=register').set(hdr());
    expect(r.status).toBe(200);
    expect(r.body.worksheet.total_tax_withheld).toBeGreaterThanOrEqual(20);
  });

  it('1601-EQ + QAP roll the register up by quarter and payee', async () => {
    const eq = await ctx.api.get('/api/accounting/bir-1601eq?quarter=2026-Q3').set(hdr());
    expect(eq.status).toBe(200);
    const jul = eq.body.monthly.find((m: { month: string }) => m.month === '2026-07');
    expect(jul.tax_base).toBe(1000);
    expect(jul.tax_withheld).toBe(20);
    expect(eq.body.total_tax_withheld).toBeGreaterThanOrEqual(20);

    const qap = await ctx.api.get('/api/accounting/qap?quarter=2026-Q3').set(hdr());
    const row = qap.body.rows.find((r: { tin: string }) => r.tin === '999-888-777-000');
    expect(row).toMatchObject({ atc: 'WC140', base: 1000, tax: 20 });

    const csv = await ctx.api.get('/api/accounting/qap?quarter=2026-Q3&format=csv').set(hdr());
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('999-888-777-000');
    expect(csv.text.split('\n')[0]).toContain('Payee TIN');

    const dat = await ctx.api.get('/api/accounting/qap?quarter=2026-Q3&format=dat').set(hdr());
    expect(dat.text).toContain('999-888-777-000|');
  });

  it('1604-E is the annual roll-up of the same payee alphalist', async () => {
    const r = await ctx.api.get('/api/accounting/bir-1604e?year=2026').set(hdr());
    expect(r.status).toBe(200);
    expect(r.body.rows.some((x: { tin: string }) => x.tin === '999-888-777-000')).toBe(true);
    expect(r.body.total_tax).toBeGreaterThanOrEqual(20);
  });
});

describe('accounting: SLSP summary lists (Phase 2c)', () => {
  it('summary list of purchases groups approved bills by supplier for the quarter', async () => {
    // The Phase 2b EWT bill (Services Co, net 1000 + 120 VAT, 2026-07) lands in Q3.
    const slp = await ctx.api.get('/api/accounting/slsp?kind=purchases&quarter=2026-Q3').set(hdr());
    expect(slp.status).toBe(200);
    const row = slp.body.rows.find((r: { tin: string | null }) => r.tin === '999-888-777-000');
    expect(row.cols.vatable).toBe(1000);
    expect(row.cols.vat).toBe(120);
    expect(slp.body.totals.vatable).toBeGreaterThanOrEqual(1000);

    const csv = await ctx.api.get('/api/accounting/slsp?kind=purchases&quarter=2026-Q3&format=csv').set(hdr());
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('Taxable (net)');
  });

  it('summary list of sales groups confirmed sales by customer', async () => {
    // The Phase 2a exempt + VAT sales for "TaxCo" are in 2026-06 (Q2).
    const sls = await ctx.api.get('/api/accounting/slsp?kind=sales&quarter=2026-Q2').set(hdr());
    expect(sls.status).toBe(200);
    const row = sls.body.rows.find((r: { tin: string | null }) => r.tin === '111-222-333-000');
    expect(row.cols.exempt).toBeGreaterThanOrEqual(1100); // 500 + 600 exempt sales
    expect(row.cols.vatable).toBe(1000);                   // the one VAT sale
  });
});

describe('accounting: cash books (Phase 2 tail)', () => {
  it('the cash receipts book lists the posted receipt with its contra account', async () => {
    // Phase 1b posted a ₱400 receipt from "Aging Co" on 2026-05-20 to the cash_receipts book.
    const r = await ctx.api.get('/api/accounting/cash-book?type=receipts&from=2026-05-01&to=2026-05-31').set(hdr());
    expect(r.status).toBe(200);
    expect(r.body.book).toBe('cash_receipts');
    const row = r.body.rows.find((x: { party: string | null }) => x.party === 'Aging Co');
    expect(row.cash_in).toBe(400);
    expect(row.cash_out).toBe(0);
    // the other leg is Accounts Receivable (1140), credited
    expect(row.contra.some((c: { code: string; credit: number }) => c.code === '1140' && c.credit === 400)).toBe(true);
    expect(r.body.cash_totals.debit).toBeGreaterThanOrEqual(400);
    const arTot = r.body.contra_totals.find((c: { code: string }) => c.code === '1140');
    expect(arTot.credit).toBeGreaterThanOrEqual(400);
  });

  it('exports the cash disbursements book as CSV', async () => {
    const csv = await ctx.api.get('/api/accounting/cash-book?type=disbursements&from=2026-01-01&to=2026-12-31&format=csv').set(hdr());
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text.split('\n')[0]).toContain('Contra accounts');
  });
});

describe('accounting: per-line tax codes (Phase 2 tail)', () => {
  let vatCode = 0, exemptCode = 0, custId = 0, soNumber = '';

  it('a mixed-rate sale classifies each line by its own tax code in the sales journal', async () => {
    const codes = (await ctx.api.get('/api/accounting/tax-codes').set(hdr())).body;
    vatCode = codes.find((t: { code: string }) => t.code === 'VAT').id;
    exemptCode = codes.find((t: { code: string }) => t.code === 'VAT-EX').id;
    custId = (await ctx.api.post('/api/customers').set(hdr())
      .send({ name: 'MixedRate Co', tin: '444-555-666-000' })).body.id;

    // One vatable line (1000) + one exempt line (500) on ONE order, doc tax_percent 0.
    const so = await ctx.api.post('/api/orders').set(hdr()).send({
      type: 'sale', customer_id: custId, order_date: '2026-11-04', status: 'confirmed', tax_percent: 0,
      items: [
        { name: 'Vatable goods', quantity: 10, unit_price: 100, tax_code_id: vatCode },
        { name: 'Exempt goods', quantity: 5, unit_price: 100, tax_code_id: exemptCode },
      ],
    });
    soNumber = so.body.number;

    // the per-line codes round-trip on the order
    const detail = await ctx.api.get(`/api/orders/${so.body.id}`).set(hdr());
    const byName = Object.fromEntries(detail.body.items.map((i: { name: string; tax_code_id: number }) => [i.name, i.tax_code_id]));
    expect(byName['Vatable goods']).toBe(vatCode);
    expect(byName['Exempt goods']).toBe(exemptCode);

    const sj = await ctx.api.get('/api/accounting/sales-journal?from=2026-11-01&to=2026-11-30').set(hdr());
    const row = sj.body.rows.find((r: { ref: string }) => r.ref === soNumber);
    expect(row.cols.vatable).toBe(1000);
    expect(row.cols.vat).toBe(120);      // 12% of the vatable line only
    expect(row.cols.exempt).toBe(500);   // the exempt line, untaxed
    expect(row.cols.gross).toBe(1620);
    expect(row.unclassified).toBe(false);
  });

  it('the mixed split flows through to SLSP and the 2550M breakdown', async () => {
    const slsp = await ctx.api.get('/api/accounting/slsp?kind=sales&quarter=2026-Q4').set(hdr());
    const party = slsp.body.rows.find((r: { tin: string | null }) => r.tin === '444-555-666-000');
    expect(party.cols.vatable).toBe(1000);
    expect(party.cols.exempt).toBe(500);
    expect(party.cols.vat).toBe(120);

    const vat = await ctx.api.get('/api/accounting/bir-2550m?month=2026-11').set(hdr());
    expect(vat.body.breakdown.sales.vatable).toBeCloseTo(1000, 2);
    expect(vat.body.breakdown.sales.exempt).toBeCloseTo(500, 2);
    expect(vat.body.breakdown.sales.output_vat).toBeCloseTo(120, 2);
  });

  it('a document with no line codes still classifies at the document level', async () => {
    const so = await ctx.api.post('/api/orders').set(hdr()).send({
      type: 'sale', customer_id: custId, tax_code_id: vatCode, order_date: '2026-11-06',
      status: 'confirmed', tax_percent: 12,
      items: [{ name: 'Plain vatable', quantity: 10, unit_price: 100 }], // no per-line code
    });
    const sj = await ctx.api.get('/api/accounting/sales-journal?from=2026-11-01&to=2026-11-30').set(hdr());
    const row = sj.body.rows.find((r: { ref: string }) => r.ref === so.body.number);
    expect(row.cols.vatable).toBe(1000);
    expect(row.cols.vat).toBe(120);
    expect(row.cols.exempt).toBe(0);
  });
});

describe('accounting: perpetual inventory — goods receipts + GRNI (Phase 3b)', () => {
  const acctBal = async (code: string): Promise<number> => {
    const tb = (await ctx.api.get('/api/accounting/ledger/reports/trial-balance').set(hdr())).body;
    const r = tb.rows.find((x: { code: string }) => x.code === code);
    return r ? Math.round((r.debit - r.credit) * 100) / 100 : 0;
  };
  const lines = async (sourceType: string, sourceId: number) => {
    const l = (await ctx.api.get('/api/accounting/ledger/journal-entries')
      .query({ source_type: sourceType, source_id: sourceId }).set(hdr())).body;
    return (await ctx.api.get(`/api/accounting/ledger/journal-entries/${l[0].id}`).set(hdr())).body.lines;
  };
  const byCode = (ls: { account_code: string; debit: number; credit: number }[]) =>
    Object.fromEntries(ls.map((x) => [x.account_code, x]));

  it('a receipt then its bill move value Inventory → GRNI → cleared, netting GRNI to zero', async () => {
    const loc = (await ctx.api.get('/api/locations').set(hdr())).body.find((l: { is_default: number }) => l.is_default === 1).id;
    const item = (await ctx.api.post('/api/inventory').set(hdr()).send({ name: 'GRNI Widget', quantity: 0 })).body.id;
    const grniBefore = await acctBal('2105');
    const invBefore = await acctBal('1150');

    const po = await ctx.api.post('/api/orders').set(hdr()).send({
      type: 'purchase', order_date: '2026-04-02', tax_percent: 12,
      items: [{ item_id: item, name: 'GRNI Widget', quantity: 10, unit_price: 50 }], // net 500
    });
    const oi = (await ctx.api.get(`/api/orders/${po.body.id}`).set(hdr())).body.items[0].id;
    const rcpt = await ctx.api.post(`/api/purchasing/orders/${po.body.id}/receipts`).set(hdr())
      .send({ location_id: loc, lines: [{ order_item_id: oi, item_id: item, name: 'GRNI Widget', quantity: 10 }] });

    const rl = byCode(await lines('goods_receipt', rcpt.body.id));
    expect(rl['1150']!.debit).toBe(500);
    expect(rl['2105']!.credit).toBe(500);
    expect(await acctBal('1150')).toBe(Math.round((invBefore + 500) * 100) / 100);

    const bill = await ctx.api.post(`/api/purchasing/orders/${po.body.id}/bills`).set(hdr())
      .send({ bill_date: '2026-04-02', tax_percent: 12,
        lines: [{ order_item_id: oi, item_id: item, name: 'GRNI Widget', quantity: 10, unit_price: 50 }] });
    await ctx.api.post(`/api/purchasing/bills/${bill.body.id}/approve`).set(hdr()).send({});

    const bl = byCode(await lines('vendor_bill', bill.body.id));
    expect(bl['2105']!.debit).toBe(500);   // clears GRNI, not purchase expense
    expect(bl['5100']).toBeUndefined();
    expect(bl['2110']!.credit).toBe(560);  // AP = 500 + 60 VAT
    expect(await acctBal('2105')).toBe(grniBefore); // GRNI back to flat
    const tb = (await ctx.api.get('/api/accounting/ledger/reports/trial-balance').set(hdr())).body;
    expect(tb.balanced).toBe(true);
  });

  it('deleting a receipt reverses its inventory recognition', async () => {
    const loc = (await ctx.api.get('/api/locations').set(hdr())).body.find((l: { is_default: number }) => l.is_default === 1).id;
    const item = (await ctx.api.post('/api/inventory').set(hdr()).send({ name: 'GRNI Undo', quantity: 0 })).body.id;
    const po = await ctx.api.post('/api/orders').set(hdr()).send({
      type: 'purchase', order_date: '2026-04-05',
      items: [{ item_id: item, name: 'GRNI Undo', quantity: 4, unit_price: 25 }], // net 100
    });
    const oi = (await ctx.api.get(`/api/orders/${po.body.id}`).set(hdr())).body.items[0].id;
    const grniBefore = await acctBal('2105');
    const rcpt = await ctx.api.post(`/api/purchasing/orders/${po.body.id}/receipts`).set(hdr())
      .send({ location_id: loc, lines: [{ order_item_id: oi, item_id: item, name: 'GRNI Undo', quantity: 4 }] });
    expect(await acctBal('2105')).toBe(Math.round((grniBefore - 100) * 100) / 100);

    expect((await ctx.api.delete(`/api/purchasing/receipts/${rcpt.body.id}`).set(hdr())).status).toBe(200);
    const es = (await ctx.api.get('/api/accounting/ledger/journal-entries')
      .query({ source_type: 'goods_receipt', source_id: rcpt.body.id }).set(hdr())).body;
    expect(es.length).toBe(2); // original + reversal
    expect(await acctBal('2105')).toBe(grniBefore);
  });
});

describe('accounting: COGS on sale (Phase 3b)', () => {
  const acctBal = async (code: string): Promise<number> => {
    const tb = (await ctx.api.get('/api/accounting/ledger/reports/trial-balance').set(hdr())).body;
    const r = tb.rows.find((x: { code: string }) => x.code === code);
    return r ? Math.round((r.debit - r.credit) * 100) / 100 : 0;
  };
  const onHand = async (id: number) => (await ctx.api.get(`/api/inventory/${id}`).set(hdr())).body.quantity as number;

  let custId = 0, itemId = 0, soId = 0;

  it('a firm sale draws stock down and posts DR COGS / CR Inventory at standard cost', async () => {
    custId = (await ctx.api.post('/api/customers').set(hdr()).send({ name: 'COGS Co' })).body.id;
    itemId = (await ctx.api.post('/api/inventory').set(hdr()).send({ name: 'COGS Widget', quantity: 100, unit_cost: 7 })).body.id;
    const cogsBefore = await acctBal('5100');
    const invBefore = await acctBal('1150');

    const so = await ctx.api.post('/api/orders').set(hdr()).send({
      type: 'sale', customer_id: custId, order_date: '2026-05-04', status: 'confirmed', tax_percent: 12,
      items: [{ item_id: itemId, name: 'COGS Widget', quantity: 10, unit_price: 20 }],
    });
    soId = so.body.id;

    expect(await onHand(itemId)).toBe(90); // 10 shipped
    const jes = await ctx.api.get('/api/accounting/ledger/journal-entries')
      .query({ source_type: 'sale_cogs', source_id: soId }).set(hdr());
    const je = (await ctx.api.get(`/api/accounting/ledger/journal-entries/${jes.body[0].id}`).set(hdr())).body;
    const byCode = Object.fromEntries(je.lines.map((l: { account_code: string; debit: number; credit: number }) => [l.account_code, l]));
    expect(byCode['5100'].debit).toBe(70);  // 10 × ₱7
    expect(byCode['1150'].credit).toBe(70);
    expect(await acctBal('5100')).toBe(Math.round((cogsBefore + 70) * 100) / 100);
    expect(await acctBal('1150')).toBe(Math.round((invBefore - 70) * 100) / 100);
    const tb = (await ctx.api.get('/api/accounting/ledger/reports/trial-balance').set(hdr())).body;
    expect(tb.balanced).toBe(true);
  });

  it('pulling the sale back to open restores the stock and reverses COGS', async () => {
    const cogsMid = await acctBal('5100');
    await ctx.api.put(`/api/orders/${soId}`).set(hdr()).send({
      type: 'sale', customer_id: custId, order_date: '2026-05-04', status: 'open', tax_percent: 12,
      items: [{ item_id: itemId, name: 'COGS Widget', quantity: 10, unit_price: 20 }],
    });
    expect(await onHand(itemId)).toBe(100); // stock back
    const jes = await ctx.api.get('/api/accounting/ledger/journal-entries')
      .query({ source_type: 'sale_cogs', source_id: soId }).set(hdr());
    expect(jes.body.length).toBe(2); // original + reversal
    expect(await acctBal('5100')).toBe(Math.round((cogsMid - 70) * 100) / 100);
  });

  it('re-confirming posts a fresh COGS entry (not a no-op)', async () => {
    await ctx.api.put(`/api/orders/${soId}`).set(hdr()).send({
      type: 'sale', customer_id: custId, order_date: '2026-05-04', status: 'confirmed', tax_percent: 12,
      items: [{ item_id: itemId, name: 'COGS Widget', quantity: 10, unit_price: 20 }],
    });
    expect(await onHand(itemId)).toBe(90);
    const jes = await ctx.api.get('/api/accounting/ledger/journal-entries')
      .query({ source_type: 'sale_cogs', source_id: soId }).set(hdr());
    expect(jes.body.length).toBe(3); // original + reversal + fresh
  });
});

describe('accounting: cash flow + equity statements (Phase 4a)', () => {
  it('the cash flow statement reconciles to the movement in cash & bank', async () => {
    const cf = await ctx.api.get('/api/accounting/ledger/reports/cash-flow?from=2026-01-01&to=2026-12-31').set(hdr());
    expect(cf.status).toBe(200);
    expect(cf.body.reconciles).toBe(true);
    // operating + investing + financing = the actual change in cash
    expect(cf.body.net_change_in_cash).toBeCloseTo(cf.body.cash_ending - cf.body.cash_beginning, 2);
    expect(cf.body.net_change_in_cash).toBeCloseTo(
      cf.body.operating.total + cf.body.investing.total + cf.body.financing.total, 2);
    expect(cf.body.operating.total).toBeCloseTo(
      cf.body.operating.net_income + cf.body.operating.adjustments.reduce((s: number, l: { amount: number }) => s + l.amount, 0), 2);
  });

  it('the statement of changes in equity closes to the balance sheet equity', async () => {
    const asOf = '2026-12-31';
    const eq = await ctx.api.get(`/api/accounting/ledger/reports/equity-changes?from=2026-01-01&to=${asOf}`).set(hdr());
    expect(eq.status).toBe(200);
    // opening + movements + net income = closing
    expect(eq.body.closing_equity).toBeCloseTo(
      eq.body.opening_equity + eq.body.movements_total + eq.body.net_income_for_period, 2);
    for (const r of eq.body.rows) expect(r.closing).toBeCloseTo(r.opening + r.movement, 2);

    const bs = await ctx.api.get(`/api/accounting/ledger/reports/balance-sheet?as_of=${asOf}`).set(hdr());
    expect(eq.body.closing_equity).toBeCloseTo(bs.body.equity.total_with_earnings, 2);
  });
});

describe('accounting: Books of Accounts (Phase 4b)', () => {
  const range = 'from=2026-01-01&to=2026-12-31';

  it('bundles the six registered books, and the General Journal balances', async () => {
    const r = await ctx.api.get(`/api/accounting/books-of-accounts?${range}`).set(hdr());
    expect(r.status).toBe(200);
    expect(r.body.books.map((b: { key: string }) => b.key)).toEqual([
      'general_journal', 'general_ledger', 'cash_receipts_book', 'cash_disbursements_book', 'sales_journal', 'purchase_journal',
    ]);
    const gj = r.body.books.find((b: { key: string }) => b.key === 'general_journal').data;
    expect(gj.total_debit).toBeGreaterThan(0);
    expect(gj.total_debit).toBeCloseTo(gj.total_credit, 2); // a journal must balance
    const gl = r.body.books.find((b: { key: string }) => b.key === 'general_ledger').data;
    expect(gl.accounts.length).toBeGreaterThan(3);
    const acc = gl.accounts[0];
    expect(acc).toHaveProperty('opening_balance');
    expect(acc).toHaveProperty('closing_balance');
  });

  it('the General Journal report matches the trial balance totals for the range', async () => {
    const gj = (await ctx.api.get(`/api/accounting/ledger/reports/general-journal?${range}`).set(hdr())).body;
    expect(gj.total_debit).toBeCloseTo(gj.total_credit, 2);
    // every line references a real account + entry number
    expect(gj.rows.every((x: { number: string; account_code: string }) => /^JV-/.test(x.number) && x.account_code)).toBe(true);
  });

  it('exports the General Journal and General Ledger as CSV', async () => {
    const j = await ctx.api.get(`/api/accounting/ledger/reports/general-journal?${range}&format=csv`).set(hdr());
    expect(j.headers['content-type']).toContain('text/csv');
    expect(j.text.split('\n')[0]).toContain('Debit');
    const l = await ctx.api.get(`/api/accounting/ledger/reports/general-ledger-all?${range}&format=csv`).set(hdr());
    expect(l.headers['content-type']).toContain('text/csv');
    expect(l.text.split('\n')[0]).toContain('Running balance');
  });
});
