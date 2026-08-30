/**
 * Accounting — tax & statutory filings. These draw on payroll, sales and purchase data
 * but are the finance team's to file, so they live here (gated `accounting.view`) rather
 * than under HR. HR keeps the payroll worksheets (13th-month, final pay).
 *
 *  - BIR 2316 / 1601-C / 1604-C / 1604-C Alphalist  — withholding on compensation
 *  - BIR 0619-E                                     — expanded withholding remittance
 *  - BIR 2550M                                      — monthly VAT declaration
 *  - SSS R-3 / PhilHealth RF-1 / Pag-IBIG MCRF      — statutory contribution schedules
 */
import { Router } from 'express';
import { db, queryOne, queryAll, run } from '../db';
import { requireAuth, requirePermission } from '../auth';
import {
  parseBody, statutoryDeductionsSchema, pettyCashFundSchema, pettyCashEntrySchema,
} from '../validation';
import { toCsv } from '../csv';
import type { PettyCashFund, PettyCashEntry } from '../types';
import { effectiveTables } from '../payroll-tables';
import { compute2316 } from '../ph-2316';
import {
  alphalistScheduleRow, alphalistRowCells, ALPHALIST_SCHEDULE1_HEADERS,
  splitName, statusCode, separationCode,
} from '../ph-alphalist';
import { contributionSchedule, type Agency, type ContribEmployeeInput } from '../ph-contributions';
import { vat2550m, ewt0619e, EWT_ATCS, type EwtLine } from '../ph-vat-ewt';
import {
  yearPayslipRowsByEmployee, monthlyWithholdingReport, payslipTotalsForMonth,
  optsFromQuery, companyProfile,
} from '../ph-payroll-report-data';

const router = Router();
router.use(requireAuth);
router.use(requirePermission('accounting.view'));

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const yearOf = (v: unknown): string => (/^\d{4}$/.test(String(v)) ? String(v) : String(new Date().getFullYear()));
const monthOf = (v: unknown): string => (/^\d{4}-\d{2}$/.test(String(v)) ? String(v) : new Date().toISOString().slice(0, 7));

/* ------------------------------------------ BIR — withholding on compensation --- */

// GET /api/accounting/bir-1601c?year= — monthly withholding-tax remittance worksheet.
router.get('/bir-1601c', (req, res) => {
  const year = yearOf(req.query.year);
  res.json({ year, ...monthlyWithholdingReport(year) });
});

// GET /api/accounting/bir-1604c?year= — annual return face + Alphalist reconciliation.
router.get('/bir-1604c', (req, res) => {
  const year = yearOf(req.query.year);
  const { months, totals } = monthlyWithholdingReport(year);
  const rwt = effectiveTables(`${year}-12-31`).rwt;
  const opts = optsFromQuery(req.query as Record<string, unknown>);

  let alphalist_tax_due = 0;
  let alphalist_tax_withheld = 0;
  for (const [, list] of yearPayslipRowsByEmployee(year)) {
    const f = compute2316(list, rwt, year, opts);
    alphalist_tax_due = round2(alphalist_tax_due + f.tax_due);
    alphalist_tax_withheld = round2(alphalist_tax_withheld + f.total_tax_withheld);
  }
  const remitted = totals.tax_withheld;
  res.json({
    year, company: companyProfile(), months, totals,
    reconciliation: {
      tax_remitted_per_1601c: remitted,
      tax_withheld_per_alphalist: alphalist_tax_withheld,
      tax_due_per_alphalist: alphalist_tax_due,
      over_remittance: round2(Math.max(0, remitted - alphalist_tax_due)),
      under_remittance: round2(Math.max(0, alphalist_tax_due - remitted)),
    },
    note: 'BIR 1604-C annual return. Attach the Alphalist. Resolve any under-remittance before filing (deadline Jan 31).',
  });
});

// GET /api/accounting/bir-2316?year= — one summary line per employee.
router.get('/bir-2316', (req, res) => {
  const year = yearOf(req.query.year);
  const opts = optsFromQuery(req.query as Record<string, unknown>);
  const rwt = effectiveTables(`${year}-12-31`).rwt;
  const rows = [...yearPayslipRowsByEmployee(year).entries()]
    .map(([employee_name, list]) => {
      const e = queryOne<{ id: number; tin_no: string | null; employee_no: string | null }>(
        'SELECT id, tin_no, employee_no FROM employees WHERE name = ? COLLATE NOCASE', employee_name
      );
      return {
        employee_name, employee_id: e?.id ?? null, tin_no: e?.tin_no ?? null,
        figures: compute2316(list, rwt, year, opts),
      };
    })
    .sort((a, b) => a.employee_name.localeCompare(b.employee_name));
  res.json({ year, company: companyProfile(), rows });
});

// GET /api/accounting/bir-2316/:employeeId?year= — one employee's full figures + 201 data.
router.get('/bir-2316/:employeeId', (req, res) => {
  const year = yearOf(req.query.year);
  const emp = queryOne<Record<string, unknown> & { name: string }>(
    `SELECT e.*, d.name AS department_name FROM employees e
     LEFT JOIN departments d ON d.id = e.department_id WHERE e.id = ?`,
    Number(req.params.employeeId)
  );
  if (!emp) { res.status(404).json({ error: 'Employee not found' }); return; }
  const rows = yearPayslipRowsByEmployee(year).get(emp.name) ?? [];
  const figures = compute2316(rows, effectiveTables(`${year}-12-31`).rwt, year, optsFromQuery(req.query as Record<string, unknown>));
  res.json({ year, company: companyProfile(), employee: emp, figures });
});

// GET /api/accounting/bir-alphalist?year= — 1604-C Alphalist Schedule 1, BIR column order.
router.get('/bir-alphalist', (req, res) => {
  const year = yearOf(req.query.year);
  const opts = optsFromQuery(req.query as Record<string, unknown>);
  const rwt = effectiveTables(`${year}-12-31`).rwt;

  const rows = [...yearPayslipRowsByEmployee(year).entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, list], i) => {
      const e = queryOne<{ tin_no: string | null; status: string | null }>(
        'SELECT tin_no, status FROM employees WHERE name = ? COLLATE NOCASE', name
      );
      return alphalistScheduleRow(i + 1, {
        ...splitName(name),
        tin: e?.tin_no ?? '',
        status_code: statusCode(e?.status),
        separation_code: separationCode(e?.status),
        period_from: '01/01', period_to: '12/31', nationality: '',
      }, compute2316(list, rwt, year, opts));
    });

  res.json({
    year, headers: ALPHALIST_SCHEDULE1_HEADERS, rows, cells: rows.map(alphalistRowCells),
    note: 'BIR 1604-C Alphalist — Schedule 1. Complete de-minimis / allowances / previous-employer '
      + 'columns, then convert to a .DAT with BIR\'s Alphalist Data Entry & Validation Module. Schedule 2 (MWE) omitted.',
  });
});

/* --------------------------------------------- BIR — expanded withholding + VAT --- */

// GET /api/accounting/bir-0619e?month=&lines=<json>&remitted_prior= — EWT remittance
// worksheet. `lines` is a JSON array of { atc, description, tax_base, rate }; the ATC
// reference + a purchases hint come back so the accountant can fill it in.
router.get('/bir-0619e', (req, res) => {
  const month = monthOf(req.query.month);
  let lines: EwtLine[] = [];
  if (typeof req.query.lines === 'string' && req.query.lines) {
    try {
      const parsed = JSON.parse(req.query.lines);
      if (Array.isArray(parsed)) {
        lines = parsed.map((l: Record<string, unknown>) => ({
          atc: String(l.atc ?? ''), description: String(l.description ?? ''),
          tax_base: Number(l.tax_base) || 0, rate: Number(l.rate) || 0,
        }));
      }
    } catch { /* ignore — treat as no lines */ }
  }
  const remittedPrior = Number(req.query.remitted_prior) || 0;

  const purchases = queryOne<{ total: number }>(
    `SELECT COALESCE(SUM(subtotal), 0) AS total FROM vendor_bills
     WHERE status = 'approved' AND COALESCE(bill_date, substr(created_at,1,10)) LIKE ?`,
    `${month}%`
  );

  res.json({
    month, company: companyProfile(),
    atc_reference: EWT_ATCS,
    purchases_hint: round2(purchases?.total ?? 0),
    worksheet: ewt0619e(lines, remittedPrior),
    note: 'Enter one line per ATC (type of income payment) with its tax base and rate. '
      + 'The purchases hint is the month\'s approved vendor-bill subtotal — only the WT-applicable portion is the base.',
  });
});

// GET /api/accounting/bir-2550m?month=&vat_inclusive=&input_vat_carry_over=&vat_payments=
// Monthly VAT declaration worksheet from the month's sale orders (output) + approved
// vendor bills (input). Defaults use each document's own tax_amount; falls back to a
// 12% derivation when a document carries none.
router.get('/bir-2550m', (req, res) => {
  const month = monthOf(req.query.month);
  const like = `${month}%`;

  const sales = queryOne<{ gross: number; vat: number }>(
    `SELECT COALESCE(SUM(total), 0) AS gross, COALESCE(SUM(tax_amount), 0) AS vat
     FROM orders WHERE type = 'sale' AND status NOT IN ('cancelled')
       AND COALESCE(order_date, substr(created_at,1,10)) LIKE ?`, like
  );
  const purch = queryOne<{ gross: number; vat: number }>(
    `SELECT COALESCE(SUM(total), 0) AS gross, COALESCE(SUM(tax_amount), 0) AS vat
     FROM vendor_bills WHERE status = 'approved'
       AND COALESCE(bill_date, substr(created_at,1,10)) LIKE ?`, like
  );

  const worksheet = vat2550m({
    gross_sales: round2(sales?.gross ?? 0),
    output_vat_booked: round2(sales?.vat ?? 0),
    gross_purchases: round2(purch?.gross ?? 0),
    input_vat_booked: round2(purch?.vat ?? 0),
    amounts_vat_inclusive: req.query.vat_inclusive === '1' || req.query.vat_inclusive === 'true',
    input_vat_carry_over: Number(req.query.input_vat_carry_over) || 0,
    vat_payments: Number(req.query.vat_payments) || 0,
  });
  res.json({
    month, company: companyProfile(),
    sources: { gross_sales: round2(sales?.gross ?? 0), gross_purchases: round2(purch?.gross ?? 0) },
    worksheet,
    note: 'Worksheet from booked sale orders + approved vendor bills. Adjust for exempt / zero-rated '
      + 'sales and disallowed input VAT before filing. Deadline: 20th of the following month.',
  });
});

/* ------------------------------------ SSS / PhilHealth / Pag-IBIG schedules --- */

// GET /api/accounting/contribution-schedule?month=YYYY-MM&agency=&format=csv
router.get('/contribution-schedule', (req, res) => {
  const month = monthOf(req.query.month);
  const agency = (['sss', 'philhealth', 'pagibig'] as const).includes(req.query.agency as Agency)
    ? (req.query.agency as Agency) : 'sss';

  const flagCol = agency === 'sss' ? 'deduct_sss'
    : agency === 'philhealth' ? 'deduct_philhealth' : 'deduct_pagibig';
  const employees: ContribEmployeeInput[] = [...payslipTotalsForMonth(month).entries()]
    .map(([name, v]) => {
      const e = queryOne<{ sss_no: string | null; philhealth_no: string | null; pagibig_no: string | null; flag: number }>(
        `SELECT sss_no, philhealth_no, pagibig_no, COALESCE(${flagCol}, 1) AS flag
         FROM employees WHERE name = ? COLLATE NOCASE`, name
      );
      // An employee switched off for this fund (Accounting → Statutory Deductions) isn't
      // remitted, so they don't belong on this schedule.
      if (e && !e.flag) return null;
      const id_number = agency === 'sss' ? e?.sss_no
        : agency === 'philhealth' ? e?.philhealth_no : e?.pagibig_no;
      return { name, id_number: id_number ?? null, monthly_comp: v.comp, monthly_basic: v.basic };
    })
    .filter((x): x is ContribEmployeeInput => x !== null);

  const schedule = contributionSchedule(agency, month, employees, effectiveTables(`${month}-15`));

  if (req.query.format === 'csv') {
    const rows = schedule.cells.map((c) => {
      const o: Record<string, unknown> = {};
      schedule.headers.forEach((h, i) => { o[h] = c[i]; });
      return o;
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${agency}-schedule-${month}.csv"`);
    res.send(toCsv(schedule.headers, rows));
    return;
  }
  res.json({ ...schedule, company: companyProfile() });
});

/* ------------------------------- statutory deductions ↔ payroll --- */

// GET /api/accounting/statutory-deductions — every employee + the four per-person
// switches (default on) that `generate-payslips` honours. Accounting decides what is
// actually deducted / remitted; HR runs the payroll. See docs/ACCOUNTING-SYSTEM-PLAN.md §6.
router.get('/statutory-deductions', (_req, res) => {
  const rows = queryAll<{
    id: number; name: string; employee_no: string | null; status: string | null;
    department_name: string | null;
    deduct_sss: number; deduct_philhealth: number; deduct_pagibig: number; deduct_withholding_tax: number;
  }>(`
    SELECT e.id, e.name, e.employee_no, e.status, d.name AS department_name,
           COALESCE(e.deduct_sss, 1) AS deduct_sss,
           COALESCE(e.deduct_philhealth, 1) AS deduct_philhealth,
           COALESCE(e.deduct_pagibig, 1) AS deduct_pagibig,
           COALESCE(e.deduct_withholding_tax, 1) AS deduct_withholding_tax
    FROM employees e LEFT JOIN departments d ON d.id = e.department_id
    ORDER BY e.name COLLATE NOCASE`);
  res.json({
    rows: rows.map((r) => ({
      ...r,
      deduct_sss: !!r.deduct_sss, deduct_philhealth: !!r.deduct_philhealth,
      deduct_pagibig: !!r.deduct_pagibig, deduct_withholding_tax: !!r.deduct_withholding_tax,
    })),
    note: 'An off switch zeroes that contribution on the employee\'s payslip the next time '
      + 'payslips are generated, and drops them from that fund\'s remittance schedule. The '
      + 'company-wide master is HR → Time Keeping → Policy Settings → Auto-compute statutory.',
  });
});

// PUT /api/accounting/statutory-deductions — { updates: [{ employee_id, deduct_* }] }.
router.put('/statutory-deductions', requirePermission('accounting.manage'), (req, res) => {
  const { updates } = parseBody(statutoryDeductionsSchema, req.body);
  const cols = ['deduct_sss', 'deduct_philhealth', 'deduct_pagibig', 'deduct_withholding_tax'] as const;

  db.exec('BEGIN');
  try {
    let changed = 0;
    for (const u of updates) {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const c of cols) {
        if (u[c] !== undefined) { sets.push(`${c} = ?`); vals.push(u[c] ? 1 : 0); }
      }
      if (!sets.length) continue;
      const info = run(
        `UPDATE employees SET ${sets.join(', ')} WHERE id = ?`,
        ...vals, u.employee_id
      );
      changed += Number(info.changes);
    }
    db.exec('COMMIT');
    res.json({ ok: true, updated: changed });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
});

/* --------------------------------------------------------------- petty cash --- */
// A named cash fund + a running money-in / money-out register. Informal ledger for now;
// maps to the Cash Receipts / Cash Disbursements books once the GL lands.

const fundBalanceExpr = `(
  f.opening_balance
  + COALESCE((SELECT SUM(CASE WHEN e.direction = 'in' THEN e.amount ELSE -e.amount END)
             FROM petty_cash_entries e WHERE e.fund_id = f.id), 0)
)`;

// GET /api/accounting/petty-cash/funds — all funds + current balance + entry count.
router.get('/petty-cash/funds', (req, res) => {
  const where = req.query.active === '0' ? '' : 'WHERE f.active = 1';
  res.json(queryAll<PettyCashFund>(`
    SELECT f.*, l.name AS location_name,
           ${fundBalanceExpr} AS balance,
           (SELECT COUNT(*) FROM petty_cash_entries e WHERE e.fund_id = f.id) AS entry_count
    FROM petty_cash_funds f
    LEFT JOIN locations l ON l.id = f.location_id
    ${where}
    ORDER BY f.active DESC, f.name COLLATE NOCASE`));
});

// POST /api/accounting/petty-cash/funds
router.post('/petty-cash/funds', requirePermission('accounting.manage'), (req, res) => {
  const b = parseBody(pettyCashFundSchema, req.body);
  if (b.location_id != null && !queryOne('SELECT id FROM locations WHERE id = ?', b.location_id)) {
    res.status(400).json({ error: 'That location does not exist' });
    return;
  }
  const info = run(
    `INSERT INTO petty_cash_funds (name, custodian, location_id, opening_balance, currency, active, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    b.name, b.custodian ?? null, b.location_id ?? null, b.opening_balance,
    b.currency || 'PHP', b.active === false ? 0 : 1, b.notes ?? null, req.user!.id
  );
  res.status(201).json({ id: Number(info.lastInsertRowid) });
});

// PUT /api/accounting/petty-cash/funds/:id
router.put('/petty-cash/funds/:id', requirePermission('accounting.manage'), (req, res) => {
  const id = Number(req.params.id);
  if (!queryOne('SELECT id FROM petty_cash_funds WHERE id = ?', id)) {
    res.status(404).json({ error: 'Fund not found' });
    return;
  }
  const b = parseBody(pettyCashFundSchema, req.body);
  run(
    `UPDATE petty_cash_funds SET name = ?, custodian = ?, location_id = ?, opening_balance = ?,
       currency = ?, active = ?, notes = ? WHERE id = ?`,
    b.name, b.custodian ?? null, b.location_id ?? null, b.opening_balance,
    b.currency || 'PHP', b.active === false ? 0 : 1, b.notes ?? null, id
  );
  res.json({ ok: true });
});

// DELETE /api/accounting/petty-cash/funds/:id — only while it has no entries.
router.delete('/petty-cash/funds/:id', requirePermission('accounting.manage'), (req, res) => {
  const id = Number(req.params.id);
  const n = queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM petty_cash_entries WHERE fund_id = ?', id)?.n ?? 0;
  if (n > 0) {
    res.status(409).json({ error: `This fund has ${n} entr${n === 1 ? 'y' : 'ies'} — deactivate it instead of deleting.` });
    return;
  }
  const info = run('DELETE FROM petty_cash_funds WHERE id = ?', id);
  if (!info.changes) { res.status(404).json({ error: 'Fund not found' }); return; }
  res.json({ ok: true });
});

// GET /api/accounting/petty-cash/funds/:id/entries?from=&to=&format=csv
// Register for the date range, each row with its running balance, plus the opening
// balance carried into the range and the in/out totals.
router.get('/petty-cash/funds/:id/entries', (req, res) => {
  const fund = queryOne<PettyCashFund>('SELECT * FROM petty_cash_funds WHERE id = ?', Number(req.params.id));
  if (!fund) { res.status(404).json({ error: 'Fund not found' }); return; }

  const from = typeof req.query.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : null;
  const to = typeof req.query.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to) ? req.query.to : null;

  const signed = (e: { direction: string; amount: number }) => (e.direction === 'in' ? 1 : -1) * (Number(e.amount) || 0);

  // Opening balance carried into the range = fund opening + everything strictly before `from`.
  let opening = fund.opening_balance;
  if (from) {
    const prior = queryAll<{ direction: string; amount: number }>(
      "SELECT direction, amount FROM petty_cash_entries WHERE fund_id = ? AND entry_date < ?",
      fund.id, from
    );
    opening = round2(prior.reduce((s, e) => s + signed(e), 0) + fund.opening_balance);
  }

  const rows = queryAll<PettyCashEntry>(`
    SELECT e.*, u.full_name AS recorded_by_name
    FROM petty_cash_entries e LEFT JOIN users u ON u.id = e.recorded_by
    WHERE e.fund_id = ?
      ${from ? 'AND e.entry_date >= ?' : ''} ${to ? 'AND e.entry_date <= ?' : ''}
    ORDER BY e.entry_date, e.id`,
    ...[fund.id, from, to].filter((x) => x != null)
  );

  let bal = opening;
  let totalIn = 0, totalOut = 0;
  const withRunning = rows.map((e) => {
    bal = round2(bal + signed(e));
    if (e.direction === 'in') totalIn = round2(totalIn + e.amount); else totalOut = round2(totalOut + e.amount);
    return { ...e, running_balance: bal };
  });

  if (req.query.format === 'csv') {
    const headers = ['Date', 'Direction', 'Category', 'Payee / Source', 'Reference', 'Amount', 'Running balance', 'Notes', 'Recorded by'];
    const csvRows = withRunning.map((e) => ({
      Date: e.entry_date, Direction: e.direction, Category: e.category ?? '', 'Payee / Source': e.counterparty ?? '',
      Reference: e.reference_no ?? '', Amount: e.direction === 'in' ? e.amount : -e.amount,
      'Running balance': e.running_balance, Notes: e.notes ?? '', 'Recorded by': e.recorded_by_name ?? '',
    }));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="petty-cash-${fund.name.replace(/\W+/g, '-')}.csv"`);
    res.send(toCsv(headers, csvRows));
    return;
  }

  res.json({
    fund,
    from, to,
    opening_balance: round2(opening),
    entries: withRunning,
    totals: { in: totalIn, out: totalOut, net: round2(totalIn - totalOut) },
    closing_balance: round2(bal),
  });
});

// POST /api/accounting/petty-cash/funds/:id/entries
router.post('/petty-cash/funds/:id/entries', requirePermission('accounting.manage'), (req, res) => {
  const id = Number(req.params.id);
  if (!queryOne('SELECT id FROM petty_cash_funds WHERE id = ?', id)) {
    res.status(404).json({ error: 'Fund not found' });
    return;
  }
  const b = parseBody(pettyCashEntrySchema, req.body);
  const info = run(
    `INSERT INTO petty_cash_entries (fund_id, entry_date, direction, amount, category, counterparty, reference_no, notes, recorded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, b.entry_date, b.direction, b.amount, b.category ?? null, b.counterparty ?? null,
    b.reference_no ?? null, b.notes ?? null, req.user!.id
  );
  res.status(201).json({ id: Number(info.lastInsertRowid) });
});

// DELETE /api/accounting/petty-cash/entries/:id
router.delete('/petty-cash/entries/:id', requirePermission('accounting.manage'), (req, res) => {
  const info = run('DELETE FROM petty_cash_entries WHERE id = ?', Number(req.params.id));
  if (!info.changes) { res.status(404).json({ error: 'Entry not found' }); return; }
  res.json({ ok: true });
});

export default router;
