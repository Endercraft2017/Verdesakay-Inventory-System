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
import { db, queryOne, queryAll, run, getSetting, setSetting, nextSequence } from '../db';
import { requireAuth, requirePermission } from '../auth';
import {
  parseBody, statutoryDeductionsSchema, pettyCashFundSchema, pettyCashEntrySchema,
  ledgerSetupSchema, accountSchema, journalEntrySchema, glPeriodSchema, postingRulesSchema,
  paymentSchema,
} from '../validation';
import { toCsv } from '../csv';
import { validateJournalLines, accountBalance, DEFAULT_COA, type JournalLineInput } from '../ledger';
import {
  getPostingRules, setPostingRules, seedPostingRulesFromCoa,
  maybeAutoPostPayment, unpostSource,
} from '../accounting-autopost';
import { POSTING_RULE_KEYS, type PostingRules } from '../accounting-posting';
import type { Payment, PaymentAllocation } from '../types';
import type {
  PettyCashFund, PettyCashEntry, Account, JournalEntry, JournalLine, AccountingPeriod,
  AccountRootType,
} from '../types';
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

/* ================================================================= general ledger === */
/* Double-entry GL — ACCOUNTING-SYSTEM-PLAN.md Phase 0, modelled on Frappe Books.
   Read = accounting.view; write (COA, post, close) = accounting.manage. */

const LEDGER_KEY = 'accounting_ledger';   // { enabled, fiscal_year_start, base_currency }
interface LedgerSettings { enabled: boolean; fiscal_year_start: string; base_currency: string; }
const ledgerSettings = (): LedgerSettings => ({
  enabled: false, fiscal_year_start: '', base_currency: 'PHP',
  ...(getSetting<Partial<LedgerSettings>>(LEDGER_KEY) || {}),
});
function requireLedger(res: import('express').Response): boolean {
  if (!ledgerSettings().enabled) {
    res.status(409).json({ error: 'The general ledger is not set up yet — Accounting → Books → Set up.' });
    return false;
  }
  return true;
}
/** Reject an entry_date that falls inside a closed accounting period. */
function closedPeriodFor(date: string): AccountingPeriod | undefined {
  return queryOne<AccountingPeriod>(
    "SELECT * FROM accounting_periods WHERE status = 'closed' AND ? BETWEEN start_date AND end_date", date
  );
}
function loadLines(entryId: number): JournalLine[] {
  return queryAll<JournalLine>(`
    SELECT jl.*, a.code AS account_code, a.name AS account_name
    FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
    WHERE jl.entry_id = ? ORDER BY jl.sort, jl.id`, entryId);
}
function accountRefMap() {
  const m = new Map<number, { id: number; is_group: number; archived: number }>();
  for (const a of queryAll<{ id: number; is_group: number; archived: number }>(
    'SELECT id, is_group, archived FROM accounts'
  )) m.set(a.id, a);
  return m;
}

// GET /api/accounting/ledger/settings
router.get('/ledger/settings', (_req, res) => {
  const s = ledgerSettings();
  const counts = s.enabled
    ? queryOne<{ accounts: number; entries: number }>(
        'SELECT (SELECT COUNT(*) FROM accounts) AS accounts, (SELECT COUNT(*) FROM journal_entries) AS entries')
    : { accounts: 0, entries: 0 };
  res.json({ ...s, ...counts });
});

// POST /api/accounting/ledger/setup — seed the chart of accounts + the fiscal-year period.
router.post('/ledger/setup', requirePermission('accounting.manage'), (req, res) => {
  const input = parseBody(ledgerSetupSchema, req.body);
  const already = queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM accounts')?.n ?? 0;

  db.exec('BEGIN');
  try {
    if (!already) {
      const idByCode = new Map<string, number>();
      for (const a of DEFAULT_COA) {
        const info = run(
          `INSERT INTO accounts (code, name, root_type, account_type, parent_id, is_group, currency)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          a.code, a.name, a.root_type, a.account_type ?? null,
          a.parent ? idByCode.get(a.parent) ?? null : null, a.is_group ? 1 : 0, input.base_currency
        );
        idByCode.set(a.code, Number(info.lastInsertRowid));
      }
    }
    const y = input.fiscal_year_start.slice(0, 4);
    const end = new Date(input.fiscal_year_start);
    end.setFullYear(end.getFullYear() + 1);
    end.setDate(end.getDate() - 1);
    if (!queryOne('SELECT id FROM accounting_periods WHERE start_date = ?', input.fiscal_year_start)) {
      run('INSERT INTO accounting_periods (name, start_date, end_date) VALUES (?, ?, ?)',
        `FY ${y}`, input.fiscal_year_start, end.toISOString().slice(0, 10));
    }
    setSetting(LEDGER_KEY, { enabled: true, fiscal_year_start: input.fiscal_year_start, base_currency: input.base_currency });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  seedPostingRulesFromCoa();   // wire the default COA into the auto-posting rules
  res.status(201).json({ ok: true, seeded: !already });
});

/* --------------------------------------------------------------- chart of accounts --- */

const accountBalancesUpTo = (asOf?: string): Map<number, { debit: number; credit: number }> => {
  const rows = queryAll<{ account_id: number; debit: number; credit: number }>(`
    SELECT jl.account_id, SUM(jl.debit) AS debit, SUM(jl.credit) AS credit
    FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
    WHERE je.status = 'posted' ${asOf ? 'AND je.entry_date <= ?' : ''}
    GROUP BY jl.account_id`, ...(asOf ? [asOf] : []));
  const m = new Map<number, { debit: number; credit: number }>();
  for (const r of rows) m.set(r.account_id, { debit: r.debit || 0, credit: r.credit || 0 });
  return m;
};

// GET /api/accounting/ledger/accounts?tree=1
router.get('/ledger/accounts', (req, res) => {
  if (!requireLedger(res)) return;
  const bals = accountBalancesUpTo();
  const rows = queryAll<Account>(`
    SELECT a.*, p.code AS parent_code FROM accounts a
    LEFT JOIN accounts p ON p.id = a.parent_id
    ORDER BY a.code`).map((a) => {
    const b = bals.get(a.id) || { debit: 0, credit: 0 };
    return { ...a, balance: accountBalance(a.root_type, b.debit, b.credit) };
  });
  if (req.query.tree !== '1') { res.json(rows); return; }
  const byParent = new Map<number | null, Account[]>();
  for (const a of rows) {
    const k = a.parent_id ?? null;
    (byParent.get(k) || byParent.set(k, []).get(k)!).push(a);
  }
  const build = (pid: number | null): Account[] =>
    (byParent.get(pid) || []).map((a) => ({ ...a, children: build(a.id) }));
  res.json(build(null));
});

// POST /api/accounting/ledger/accounts
router.post('/ledger/accounts', requirePermission('accounting.manage'), (req, res) => {
  if (!requireLedger(res)) return;
  const b = parseBody(accountSchema, req.body);
  if (queryOne('SELECT id FROM accounts WHERE code = ?', b.code)) {
    res.status(409).json({ error: `Account code ${b.code} is already used.` });
    return;
  }
  let parentRoot: AccountRootType | null = null;
  if (b.parent_id != null) {
    const p = queryOne<{ root_type: AccountRootType; is_group: number }>(
      'SELECT root_type, is_group FROM accounts WHERE id = ?', b.parent_id);
    if (!p) { res.status(400).json({ error: 'Parent account not found.' }); return; }
    if (!p.is_group) { res.status(400).json({ error: 'The parent must be a group account.' }); return; }
    parentRoot = p.root_type;
  }
  if (parentRoot && parentRoot !== b.root_type) {
    res.status(400).json({ error: `Root type must match the parent (${parentRoot}).` });
    return;
  }
  const info = run(
    `INSERT INTO accounts (code, name, root_type, account_type, parent_id, is_group, currency, description)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    b.code, b.name, b.root_type, b.account_type ?? null, b.parent_id ?? null,
    b.is_group ? 1 : 0, b.currency || ledgerSettings().base_currency, b.description ?? null
  );
  res.status(201).json({ id: Number(info.lastInsertRowid) });
});

// PUT /api/accounting/ledger/accounts/:id  (rename / re-parent / archive; not root_type once used)
router.put('/ledger/accounts/:id', requirePermission('accounting.manage'), (req, res) => {
  if (!requireLedger(res)) return;
  const id = Number(req.params.id);
  const cur = queryOne<Account>('SELECT * FROM accounts WHERE id = ?', id);
  if (!cur) { res.status(404).json({ error: 'Account not found' }); return; }
  const b = parseBody(accountSchema, req.body);
  const used = (queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM journal_lines WHERE account_id = ?', id)?.n ?? 0) > 0;
  const hasChildren = (queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM accounts WHERE parent_id = ?', id)?.n ?? 0) > 0;
  if (used && b.root_type !== cur.root_type) {
    res.status(409).json({ error: 'This account already has ledger entries — its type can no longer change.' });
    return;
  }
  if (b.is_group && used) {
    res.status(409).json({ error: 'An account with entries cannot become a group.' });
    return;
  }
  if (!b.is_group && hasChildren) {
    res.status(409).json({ error: 'A group with sub-accounts cannot become a leaf.' });
    return;
  }
  run(
    `UPDATE accounts SET code = ?, name = ?, root_type = ?, account_type = ?, parent_id = ?,
       is_group = ?, currency = ?, description = ?, archived = ? WHERE id = ?`,
    b.code, b.name, b.root_type, b.account_type ?? null, b.parent_id ?? null,
    b.is_group ? 1 : 0, b.currency || cur.currency, b.description ?? null,
    b.archived ? 1 : 0, id
  );
  res.json({ ok: true });
});

// DELETE /api/accounting/ledger/accounts/:id — only an unused leaf with no children.
router.delete('/ledger/accounts/:id', requirePermission('accounting.manage'), (req, res) => {
  if (!requireLedger(res)) return;
  const id = Number(req.params.id);
  if ((queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM journal_lines WHERE account_id = ?', id)?.n ?? 0) > 0) {
    res.status(409).json({ error: 'This account has ledger entries — archive it instead.' });
    return;
  }
  if ((queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM accounts WHERE parent_id = ?', id)?.n ?? 0) > 0) {
    res.status(409).json({ error: 'This account has sub-accounts — remove or re-parent them first.' });
    return;
  }
  const info = run('DELETE FROM accounts WHERE id = ?', id);
  if (!info.changes) { res.status(404).json({ error: 'Account not found' }); return; }
  res.json({ ok: true });
});

/* ------------------------------------------------------------ accounting periods --- */

router.get('/ledger/periods', (_req, res) => {
  if (!requireLedger(res)) return;
  res.json(queryAll<AccountingPeriod>('SELECT * FROM accounting_periods ORDER BY start_date DESC'));
});

router.post('/ledger/periods', requirePermission('accounting.manage'), (req, res) => {
  if (!requireLedger(res)) return;
  const b = parseBody(glPeriodSchema, req.body);
  if (b.end_date < b.start_date) { res.status(400).json({ error: 'End date is before the start date.' }); return; }
  const info = run('INSERT INTO accounting_periods (name, start_date, end_date) VALUES (?, ?, ?)',
    b.name, b.start_date, b.end_date);
  res.status(201).json({ id: Number(info.lastInsertRowid) });
});

router.post('/ledger/periods/:id/:action(close|reopen)', requirePermission('accounting.manage'), (req, res) => {
  if (!requireLedger(res)) return;
  const id = Number(req.params.id);
  if (!queryOne('SELECT id FROM accounting_periods WHERE id = ?', id)) {
    res.status(404).json({ error: 'Period not found' }); return;
  }
  const closing = req.params.action === 'close';
  run(
    `UPDATE accounting_periods SET status = ?, closed_by = ?, closed_at = ? WHERE id = ?`,
    closing ? 'closed' : 'open', closing ? req.user!.id : null,
    closing ? new Date().toISOString() : null, id
  );
  res.json({ ok: true, status: closing ? 'closed' : 'open' });
});

/* ------------------------------------------------------------- auto-posting rules --- */
/* Which account each auto-posted amount lands on. Seeded from the default COA at setup;
   editable here. Sale-order confirm -> sales journal; vendor-bill approve -> purchase
   journal (src/accounting-autopost.ts). */

const POSTING_RULE_ROOT: Record<keyof PostingRules, AccountRootType> = {
  ar_account_id: 'asset',
  sales_income_account_id: 'income',
  output_vat_account_id: 'liability',
  ap_account_id: 'liability',
  purchase_expense_account_id: 'expense',
  input_vat_account_id: 'asset',
};

function postingRulesPayload() {
  const rules = getPostingRules();
  const accts = queryAll<{ id: number; code: string; name: string; root_type: AccountRootType }>(
    "SELECT id, code, name, root_type FROM accounts WHERE is_group = 0 AND archived = 0 ORDER BY code");
  const byId = new Map(accts.map((a) => [a.id, a]));
  const resolved: Record<string, { account_id: number; code: string; name: string } | null> = {};
  for (const k of POSTING_RULE_KEYS) {
    const id = rules[k];
    const a = id ? byId.get(Number(id)) : undefined;
    resolved[k] = a ? { account_id: a.id, code: a.code, name: a.name } : null;
  }
  return { rules, resolved, roots: POSTING_RULE_ROOT, accounts: accts };
}

router.get('/ledger/posting-rules', (_req, res) => {
  if (!requireLedger(res)) return;
  res.json(postingRulesPayload());
});

router.put('/ledger/posting-rules', requirePermission('accounting.manage'), (req, res) => {
  if (!requireLedger(res)) return;
  const b = parseBody(postingRulesSchema, req.body);
  for (const k of POSTING_RULE_KEYS) {
    const id = b[k];
    if (id == null) continue;
    const a = queryOne<{ is_group: number; archived: number; root_type: AccountRootType }>(
      'SELECT is_group, archived, root_type FROM accounts WHERE id = ?', id);
    if (!a) { res.status(400).json({ error: `${k}: account not found.` }); return; }
    if (a.is_group) { res.status(400).json({ error: `${k}: pick a leaf account, not a group.` }); return; }
    if (a.archived) { res.status(400).json({ error: `${k}: that account is archived.` }); return; }
    if (a.root_type !== POSTING_RULE_ROOT[k]) {
      res.status(400).json({ error: `${k}: expected ${POSTING_RULE_ROOT[k]} account, got ${a.root_type}.` });
      return;
    }
  }
  setPostingRules(b as Partial<PostingRules>);
  res.json(postingRulesPayload());
});

/* --------------------------------------------------------------- journal entries --- */

router.get('/ledger/journal-entries', (req, res) => {
  if (!requireLedger(res)) return;
  const where: string[] = [];
  const params: unknown[] = [];
  const q = req.query;
  if (typeof q.from === 'string') { where.push('je.entry_date >= ?'); params.push(q.from); }
  if (typeof q.to === 'string') { where.push('je.entry_date <= ?'); params.push(q.to); }
  if (typeof q.book === 'string') { where.push('je.book = ?'); params.push(q.book); }
  if (typeof q.status === 'string') { where.push('je.status = ?'); params.push(q.status); }
  if (typeof q.source_type === 'string') { where.push('je.source_type = ?'); params.push(q.source_type); }
  if (q.source_id != null && q.source_id !== '') { where.push('je.source_id = ?'); params.push(Number(q.source_id)); }
  if (q.auto === '1') where.push('je.source_type IS NOT NULL');
  if (typeof q.q === 'string' && q.q.trim()) {
    where.push('(je.number LIKE ? OR je.memo LIKE ? OR je.reference LIKE ?)');
    const like = `%${q.q.trim()}%`; params.push(like, like, like);
  }
  res.json(queryAll<JournalEntry>(`
    SELECT je.*, u.full_name AS created_by_name,
           (SELECT COALESCE(SUM(debit), 0) FROM journal_lines WHERE entry_id = je.id) AS total_debit,
           (SELECT r.number FROM journal_entries r WHERE r.reverses_id = je.id) AS reversed_by
    FROM journal_entries je LEFT JOIN users u ON u.id = je.created_by
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY je.entry_date DESC, je.id DESC LIMIT 500`, ...params));
});

router.get('/ledger/journal-entries/:id', (req, res) => {
  if (!requireLedger(res)) return;
  const je = queryOne<JournalEntry & { reversed_by?: string | null }>(`
    SELECT je.*, u.full_name AS created_by_name,
           (SELECT r.number FROM journal_entries r WHERE r.reverses_id = je.id) AS reversed_by
    FROM journal_entries je LEFT JOIN users u ON u.id = je.created_by WHERE je.id = ?`, Number(req.params.id));
  if (!je) { res.status(404).json({ error: 'Entry not found' }); return; }
  je.lines = loadLines(je.id);
  res.json(je);
});

function insertLines(entryId: number, lines: JournalLineInput[]): void {
  lines.forEach((l, i) => run(
    `INSERT INTO journal_lines (entry_id, account_id, debit, credit, party_type, party_id, memo, sort)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    entryId, l.account_id, round2(Number(l.debit) || 0), round2(Number(l.credit) || 0),
    l.party_type ?? null, l.party_id ?? null, l.memo ?? null, i
  ));
}

// POST /api/accounting/ledger/journal-entries — create a draft.
router.post('/ledger/journal-entries', requirePermission('accounting.manage'), (req, res) => {
  if (!requireLedger(res)) return;
  const b = parseBody(journalEntrySchema, req.body);
  const v = validateJournalLines(b.lines as JournalLineInput[], accountRefMap());
  if (!v.ok) { res.status(400).json({ error: v.errors[0], errors: v.errors }); return; }

  db.exec('BEGIN');
  try {
    const number = nextSequence('je_number', 'JV', 6);
    const info = run(
      `INSERT INTO journal_entries (number, book, entry_date, memo, reference, status, created_by)
       VALUES (?, ?, ?, ?, ?, 'draft', ?)`,
      number, b.book, b.entry_date, b.memo ?? null, b.reference ?? null, req.user!.id
    );
    insertLines(Number(info.lastInsertRowid), b.lines as JournalLineInput[]);
    db.exec('COMMIT');
    res.status(201).json({ id: Number(info.lastInsertRowid), number });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
});

// PUT — edit a draft.
router.put('/ledger/journal-entries/:id', requirePermission('accounting.manage'), (req, res) => {
  if (!requireLedger(res)) return;
  const je = queryOne<JournalEntry>('SELECT * FROM journal_entries WHERE id = ?', Number(req.params.id));
  if (!je) { res.status(404).json({ error: 'Entry not found' }); return; }
  if (je.status !== 'draft') { res.status(409).json({ error: 'Only a draft entry can be edited.' }); return; }
  const b = parseBody(journalEntrySchema, req.body);
  const v = validateJournalLines(b.lines as JournalLineInput[], accountRefMap());
  if (!v.ok) { res.status(400).json({ error: v.errors[0], errors: v.errors }); return; }
  db.exec('BEGIN');
  try {
    run(`UPDATE journal_entries SET book = ?, entry_date = ?, memo = ?, reference = ? WHERE id = ?`,
      b.book, b.entry_date, b.memo ?? null, b.reference ?? null, je.id);
    run('DELETE FROM journal_lines WHERE entry_id = ?', je.id);
    insertLines(je.id, b.lines as JournalLineInput[]);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  res.json({ ok: true });
});

// POST .../post — validate + lock into a closed-period check + mark posted.
router.post('/ledger/journal-entries/:id/post', requirePermission('accounting.manage'), (req, res) => {
  if (!requireLedger(res)) return;
  const je = queryOne<JournalEntry>('SELECT * FROM journal_entries WHERE id = ?', Number(req.params.id));
  if (!je) { res.status(404).json({ error: 'Entry not found' }); return; }
  if (je.status !== 'draft') { res.status(409).json({ error: `Entry is already ${je.status}.` }); return; }
  const v = validateJournalLines(loadLines(je.id) as JournalLineInput[], accountRefMap());
  if (!v.ok) { res.status(400).json({ error: v.errors[0], errors: v.errors }); return; }
  const closed = closedPeriodFor(je.entry_date);
  if (closed) { res.status(409).json({ error: `${je.entry_date} falls in a closed period (${closed.name}).` }); return; }
  run(`UPDATE journal_entries SET status = 'posted', posted_by = ?, posted_at = datetime('now') WHERE id = ?`,
    req.user!.id, je.id);
  res.json({ ok: true, status: 'posted' });
});

// POST .../void — a posted entry is reversed by an equal-and-opposite *posted* entry.
// The original stays posted (both entries remain in the ledger and net to zero — CAS
// rule: nothing is removed); the reversal's `reverses_id` links them.
router.post('/ledger/journal-entries/:id/void', requirePermission('accounting.manage'), (req, res) => {
  if (!requireLedger(res)) return;
  const je = queryOne<JournalEntry>('SELECT * FROM journal_entries WHERE id = ?', Number(req.params.id));
  if (!je) { res.status(404).json({ error: 'Entry not found' }); return; }
  if (je.status !== 'posted') { res.status(409).json({ error: 'Only a posted entry can be reversed.' }); return; }
  if (queryOne('SELECT id FROM journal_entries WHERE reverses_id = ?', je.id)) {
    res.status(409).json({ error: 'This entry has already been reversed.' });
    return;
  }
  const closed = closedPeriodFor(je.entry_date);
  if (closed) { res.status(409).json({ error: `Entry is in a closed period (${closed.name}).` }); return; }
  const lines = loadLines(je.id);

  db.exec('BEGIN');
  try {
    const number = nextSequence('je_number', 'JV', 6);
    const info = run(
      `INSERT INTO journal_entries (number, book, entry_date, memo, reference, status, reverses_id, posted_by, posted_at, created_by)
       VALUES (?, ?, ?, ?, ?, 'posted', ?, ?, datetime('now'), ?)`,
      number, je.book, new Date().toISOString().slice(0, 10),
      `Reversal of ${je.number}${je.memo ? ' — ' + je.memo : ''}`, je.reference ?? null,
      je.id, req.user!.id, req.user!.id
    );
    const revId = Number(info.lastInsertRowid);
    lines.forEach((l, i) => run(
      `INSERT INTO journal_lines (entry_id, account_id, debit, credit, party_type, party_id, memo, sort)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      revId, l.account_id, round2(l.credit), round2(l.debit), l.party_type, l.party_id, l.memo, i
    ));
    db.exec('COMMIT');
    res.json({ ok: true, reversal_id: revId, reversal_number: number });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
});

router.delete('/ledger/journal-entries/:id', requirePermission('accounting.manage'), (req, res) => {
  if (!requireLedger(res)) return;
  const je = queryOne<{ status: string }>('SELECT status FROM journal_entries WHERE id = ?', Number(req.params.id));
  if (!je) { res.status(404).json({ error: 'Entry not found' }); return; }
  if (je.status !== 'draft') { res.status(409).json({ error: 'Only a draft can be deleted — void a posted entry instead.' }); return; }
  run('DELETE FROM journal_entries WHERE id = ?', Number(req.params.id));
  res.json({ ok: true });
});

/* ---------------------------------------------------------------------- reports --- */

// GET .../reports/general-ledger?account_id=&from=&to=
router.get('/ledger/reports/general-ledger', (req, res) => {
  if (!requireLedger(res)) return;
  const accountId = Number(req.query.account_id);
  const acc = queryOne<Account>('SELECT * FROM accounts WHERE id = ?', accountId);
  if (!acc) { res.status(400).json({ error: 'Pick an account.' }); return; }
  const from = typeof req.query.from === 'string' ? req.query.from : null;
  const to = typeof req.query.to === 'string' ? req.query.to : null;

  const opRow = from ? queryOne<{ d: number; c: number }>(`
    SELECT COALESCE(SUM(jl.debit),0) AS d, COALESCE(SUM(jl.credit),0) AS c
    FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
    WHERE je.status = 'posted' AND jl.account_id = ? AND je.entry_date < ?`, accountId, from) : null;
  let running = accountBalance(acc.root_type, opRow?.d ?? 0, opRow?.c ?? 0);
  const opening = running;

  const rows = queryAll<{ id: number; number: string; entry_date: string; memo: string | null; debit: number; credit: number; line_memo: string | null }>(`
    SELECT je.id, je.number, je.entry_date, je.memo, jl.debit, jl.credit, jl.memo AS line_memo
    FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
    WHERE je.status = 'posted' AND jl.account_id = ?
      ${from ? 'AND je.entry_date >= ?' : ''} ${to ? 'AND je.entry_date <= ?' : ''}
    ORDER BY je.entry_date, je.id, jl.sort`,
    ...[accountId, from, to].filter((x) => x != null));

  const dir = acc.root_type === 'asset' || acc.root_type === 'expense' ? 1 : -1;
  const entries = rows.map((r) => {
    running = round2(running + dir * ((r.debit || 0) - (r.credit || 0)));
    return { ...r, running_balance: running };
  });
  res.json({
    account: acc, from, to,
    opening_balance: opening,
    entries,
    total_debit: round2(rows.reduce((s, r) => s + (r.debit || 0), 0)),
    total_credit: round2(rows.reduce((s, r) => s + (r.credit || 0), 0)),
    closing_balance: running,
  });
});

// GET .../reports/trial-balance?as_of=
router.get('/ledger/reports/trial-balance', (req, res) => {
  if (!requireLedger(res)) return;
  const asOf = typeof req.query.as_of === 'string' ? req.query.as_of : undefined;
  const bals = accountBalancesUpTo(asOf);
  const accts = queryAll<Account>("SELECT * FROM accounts WHERE is_group = 0 ORDER BY code");
  let totalDebit = 0, totalCredit = 0;
  const rows = accts.map((a) => {
    const b = bals.get(a.id) || { debit: 0, credit: 0 };
    // Net debit vs net credit — every account presented on whichever side it lands.
    const net = round2((b.debit || 0) - (b.credit || 0));
    const dCol = round2(Math.max(net, 0));
    const cCol = round2(Math.max(-net, 0));
    totalDebit = round2(totalDebit + dCol);
    totalCredit = round2(totalCredit + cCol);
    return { code: a.code, name: a.name, root_type: a.root_type, account_id: a.id, debit: dCol, credit: cCol };
  }).filter((r) => r.debit || r.credit);
  res.json({ as_of: asOf ?? null, rows, total_debit: totalDebit, total_credit: totalCredit, balanced: Math.abs(totalDebit - totalCredit) < 0.01 });
});

/** Net income (income − expense) for [from, to]. */
function netIncome(from: string, to: string): number {
  const r = queryOne<{ inc: number; exp: number }>(`
    SELECT
      COALESCE(SUM(CASE WHEN a.root_type = 'income'  THEN jl.credit - jl.debit ELSE 0 END), 0) AS inc,
      COALESCE(SUM(CASE WHEN a.root_type = 'expense' THEN jl.debit - jl.credit ELSE 0 END), 0) AS exp
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
    JOIN accounts a ON a.id = jl.account_id
    WHERE je.status = 'posted' AND je.entry_date >= ? AND je.entry_date <= ?`, from, to);
  return round2((r?.inc ?? 0) - (r?.exp ?? 0));
}

// GET .../reports/profit-and-loss?from=&to=
router.get('/ledger/reports/profit-and-loss', (req, res) => {
  if (!requireLedger(res)) return;
  const from = typeof req.query.from === 'string' ? req.query.from : ledgerSettings().fiscal_year_start;
  const to = typeof req.query.to === 'string' ? req.query.to : new Date().toISOString().slice(0, 10);
  const rows = queryAll<{ code: string; name: string; root_type: AccountRootType; amount: number }>(`
    SELECT a.code, a.name, a.root_type,
           SUM(CASE WHEN a.root_type = 'income' THEN jl.credit - jl.debit ELSE jl.debit - jl.credit END) AS amount
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
    JOIN accounts a ON a.id = jl.account_id
    WHERE je.status = 'posted' AND a.is_group = 0 AND a.root_type IN ('income','expense')
      AND je.entry_date >= ? AND je.entry_date <= ?
    GROUP BY a.id HAVING amount <> 0 ORDER BY a.code`, from, to);
  const income = rows.filter((r) => r.root_type === 'income').map((r) => ({ ...r, amount: round2(r.amount) }));
  const expense = rows.filter((r) => r.root_type === 'expense').map((r) => ({ ...r, amount: round2(r.amount) }));
  const totalIncome = round2(income.reduce((s, r) => s + r.amount, 0));
  const totalExpense = round2(expense.reduce((s, r) => s + r.amount, 0));
  res.json({ from, to, income, expense, total_income: totalIncome, total_expense: totalExpense, net_income: round2(totalIncome - totalExpense) });
});

// GET .../reports/balance-sheet?as_of=
router.get('/ledger/reports/balance-sheet', (req, res) => {
  if (!requireLedger(res)) return;
  const asOf = typeof req.query.as_of === 'string' ? req.query.as_of : new Date().toISOString().slice(0, 10);
  const fyStart = ledgerSettings().fiscal_year_start || asOf.slice(0, 4) + '-01-01';
  const bals = accountBalancesUpTo(asOf);
  const accts = queryAll<Account>("SELECT * FROM accounts WHERE is_group = 0 ORDER BY code");

  const sect = (root: AccountRootType) => {
    const items = accts.filter((a) => a.root_type === root).map((a) => {
      const b = bals.get(a.id) || { debit: 0, credit: 0 };
      return { code: a.code, name: a.name, amount: accountBalance(root, b.debit, b.credit) };
    }).filter((r) => r.amount !== 0);
    return { items, total: round2(items.reduce((s, r) => s + r.amount, 0)) };
  };
  const assets = sect('asset');
  const liabilities = sect('liability');
  const equity = sect('equity');
  const currentEarnings = netIncome(fyStart, asOf);
  const equityWithEarnings = round2(equity.total + currentEarnings);

  res.json({
    as_of: asOf,
    assets,
    liabilities,
    equity: { ...equity, current_period_earnings: currentEarnings, total_with_earnings: equityWithEarnings },
    total_assets: assets.total,
    total_liabilities_and_equity: round2(liabilities.total + equityWithEarnings),
    balanced: Math.abs(assets.total - (liabilities.total + equityWithEarnings)) < 0.01,
  });
});

/* ================================================ receivables & payables (Phase 1b) === */
/* Customer receipts / supplier payments settle open sale orders & vendor bills; the
   subledger reports age what's still outstanding. Read = accounting.view; write =
   accounting.manage. Needs the ledger set up (payments auto-post a cash-book entry). */

const CONFIRMED_SALE_SQL =
  "o.type = 'sale' AND lower(o.status) IN ('confirmed','completed','fulfilled','invoiced','paid')";

/** allocated-so-far per document, from non-void payments. */
function allocatedFor(docType: 'sale_order' | 'vendor_bill', docId: number): number {
  return round2(queryOne<{ a: number }>(
    `SELECT COALESCE(SUM(pa.amount), 0) AS a FROM payment_allocations pa
     JOIN payments p ON p.id = pa.payment_id AND p.status = 'posted'
     WHERE pa.doc_type = ? AND pa.doc_id = ?`, docType, docId
  )?.a ?? 0);
}

// GET /api/accounting/cash-accounts — cash / bank leaf accounts for the "deposit to" picker.
router.get('/cash-accounts', (_req, res) => {
  if (!requireLedger(res)) return;
  res.json(queryAll(
    `SELECT id, code, name, account_type FROM accounts
     WHERE is_group = 0 AND archived = 0 AND account_type IN ('cash','bank') ORDER BY code`
  ));
});

// GET /api/accounting/payments?direction=&party_type=&party_id=&from=&to=&status=
router.get('/payments', (req, res) => {
  if (!requireLedger(res)) return;
  const where: string[] = [];
  const params: unknown[] = [];
  const q = req.query;
  for (const [k, col] of [['direction', 'p.direction'], ['party_type', 'p.party_type'], ['status', 'p.status']] as const) {
    if (typeof q[k] === 'string') { where.push(`${col} = ?`); params.push(q[k]); }
  }
  if (q.party_id != null && q.party_id !== '') { where.push('p.party_id = ?'); params.push(Number(q.party_id)); }
  if (typeof q.from === 'string') { where.push('p.payment_date >= ?'); params.push(q.from); }
  if (typeof q.to === 'string') { where.push('p.payment_date <= ?'); params.push(q.to); }
  res.json(queryAll<Payment>(`
    SELECT p.*, u.full_name AS created_by_name, a.name AS deposit_account_name,
           (SELECT COALESCE(SUM(amount), 0) FROM payment_allocations WHERE payment_id = p.id) AS allocated
    FROM payments p
    LEFT JOIN users u ON u.id = p.created_by
    LEFT JOIN accounts a ON a.id = p.deposit_account_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY p.payment_date DESC, p.id DESC LIMIT 500`, ...params));
});

// GET /api/accounting/payments/:id — a payment + its allocations (with the doc numbers)
router.get('/payments/:id', (req, res) => {
  if (!requireLedger(res)) return;
  const p = queryOne<Payment>(`
    SELECT p.*, u.full_name AS created_by_name, a.name AS deposit_account_name
    FROM payments p LEFT JOIN users u ON u.id = p.created_by
    LEFT JOIN accounts a ON a.id = p.deposit_account_id WHERE p.id = ?`, Number(req.params.id));
  if (!p) { res.status(404).json({ error: 'Payment not found' }); return; }
  const allocs = queryAll<PaymentAllocationRow>(
    'SELECT * FROM payment_allocations WHERE payment_id = ? ORDER BY id', p.id);
  p.allocations = allocs.map((al) => {
    const doc = al.doc_type === 'sale_order'
      ? queryOne<{ number: string }>("SELECT number FROM orders WHERE id = ?", al.doc_id)
      : queryOne<{ number: string }>('SELECT number FROM vendor_bills WHERE id = ?', al.doc_id);
    return { ...al, doc_number: doc?.number ?? null };
  }) as PaymentAllocation[];
  res.json(p);
});

interface PaymentAllocationRow {
  id: number; payment_id: number; doc_type: 'sale_order' | 'vendor_bill'; doc_id: number; amount: number;
}

// POST /api/accounting/payments — record a receipt (in) / disbursement (out) + auto-post.
router.post('/payments', requirePermission('accounting.manage'), (req, res) => {
  if (!requireLedger(res)) return;
  const b = parseBody(paymentSchema, req.body);

  const deposit = queryOne<{ is_group: number; archived: number }>(
    'SELECT is_group, archived FROM accounts WHERE id = ?', b.deposit_account_id);
  if (!deposit || deposit.is_group || deposit.archived) {
    res.status(400).json({ error: 'Pick a postable cash / bank account to deposit to / pay from.' });
    return;
  }

  // Resolve the party name (snapshot) + validate any allocations belong to this party & direction.
  let partyName = b.party_name ?? null;
  if (b.party_id != null) {
    const row = b.party_type === 'customer'
      ? queryOne<{ name: string }>('SELECT name FROM customers WHERE id = ?', b.party_id)
      : queryOne<{ name: string }>('SELECT name FROM suppliers WHERE id = ?', b.party_id);
    if (!row) { res.status(400).json({ error: `${b.party_type} not found.` }); return; }
    partyName = partyName ?? row.name;
  }
  const wantDocType = b.direction === 'in' ? 'sale_order' : 'vendor_bill';
  const allocs = b.allocations ?? [];
  let allocTotal = 0;
  for (const al of allocs) {
    if (al.doc_type !== wantDocType) {
      res.status(400).json({ error: `A ${b.direction === 'in' ? 'receipt' : 'payment'} can only be applied to ${wantDocType.replace('_', ' ')}s.` });
      return;
    }
    const exists = al.doc_type === 'sale_order'
      ? queryOne('SELECT id FROM orders WHERE id = ?', al.doc_id)
      : queryOne('SELECT id FROM vendor_bills WHERE id = ?', al.doc_id);
    if (!exists) { res.status(400).json({ error: `Allocation target #${al.doc_id} not found.` }); return; }
    allocTotal = round2(allocTotal + al.amount);
  }
  if (allocTotal > round2(b.amount) + 0.005) {
    res.status(400).json({ error: `Allocations (${allocTotal}) exceed the payment amount (${round2(b.amount)}).` });
    return;
  }

  db.exec('BEGIN');
  let paymentId: number;
  try {
    const number = nextSequence(b.direction === 'in' ? 'payment_in' : 'payment_out',
      b.direction === 'in' ? 'RCT' : 'DV', 5);
    const info = run(
      `INSERT INTO payments
        (number, direction, party_type, party_id, party_name, payment_date, amount, method,
         reference, deposit_account_id, memo, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'posted', ?)`,
      number, b.direction, b.party_type, b.party_id ?? null, partyName, b.payment_date,
      round2(b.amount), b.method ?? null, b.reference ?? null, b.deposit_account_id, b.memo ?? null,
      req.user!.id
    );
    paymentId = Number(info.lastInsertRowid);
    for (const al of allocs) {
      run('INSERT INTO payment_allocations (payment_id, doc_type, doc_id, amount) VALUES (?, ?, ?, ?)',
        paymentId, al.doc_type, al.doc_id, round2(al.amount));
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  const posted = maybeAutoPostPayment(paymentId, req.user!.id);
  res.status(201).json({ id: paymentId, posted: posted.posted, entry: posted.entry ?? null, error: posted.error ?? null });
});

// POST /api/accounting/payments/:id/void — reverse the cash-book entry, mark it void.
router.post('/payments/:id/void', requirePermission('accounting.manage'), (req, res) => {
  if (!requireLedger(res)) return;
  const id = Number(req.params.id);
  const p = queryOne<Payment>('SELECT * FROM payments WHERE id = ?', id);
  if (!p) { res.status(404).json({ error: 'Payment not found' }); return; }
  if (p.status === 'void') { res.status(409).json({ error: 'Already void.' }); return; }
  const rev = unpostSource('payment', id, req.user!.id);
  if (rev.error) { res.status(409).json({ error: `Could not reverse the ledger entry: ${rev.error}` }); return; }
  run("UPDATE payments SET status = 'void' WHERE id = ?", id);
  res.json({ ok: true, reversal: rev.entry ?? null });
});

/* ---------------------------------------------------------------------- aging + statement --- */

const AGE_BUCKETS = ['current', '1_30', '31_60', '61_90', '90_plus'] as const;
type AgeBucket = typeof AGE_BUCKETS[number];
function bucketFor(dueDate: string | null, asOf: string): AgeBucket {
  if (!dueDate) return 'current';
  const days = Math.floor((Date.parse(asOf) - Date.parse(dueDate)) / 86_400_000);
  if (days <= 0) return 'current';
  if (days <= 30) return '1_30';
  if (days <= 60) return '31_60';
  if (days <= 90) return '61_90';
  return '90_plus';
}
const emptyBuckets = () => Object.fromEntries(AGE_BUCKETS.map((b) => [b, 0])) as Record<AgeBucket, number>;

// GET /api/accounting/ar-aging?as_of= — open sale orders per customer, aged by due date.
router.get('/ar-aging', (req, res) => {
  if (!requireLedger(res)) return;
  const asOf = typeof req.query.as_of === 'string' ? req.query.as_of : new Date().toISOString().slice(0, 10);
  const rows = queryAll<{
    id: number; number: string; order_date: string | null; total: number;
    customer_id: number | null; customer_name: string | null; terms: number | null;
  }>(`
    SELECT o.id, o.number, o.order_date, o.total, o.customer_id,
           COALESCE(c.name, o.customer_name) AS customer_name, c.payment_terms_days AS terms
    FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
    WHERE ${CONFIRMED_SALE_SQL} AND o.total > 0`);
  res.json(agingPayload(rows.map((r) => ({
    doc_id: r.id, doc_number: r.number, party_key: r.customer_id ? `c${r.customer_id}` : `n:${r.customer_name ?? '—'}`,
    party_id: r.customer_id, party_name: r.customer_name ?? 'No customer',
    doc_total: r.total, allocated: allocatedFor('sale_order', r.id),
    due_date: addDays(r.order_date, r.terms ?? 0),
  })), asOf, 'sale_order'));
});

// GET /api/accounting/ap-aging?as_of= — open vendor bills per supplier, aged by due date.
router.get('/ap-aging', (req, res) => {
  if (!requireLedger(res)) return;
  const asOf = typeof req.query.as_of === 'string' ? req.query.as_of : new Date().toISOString().slice(0, 10);
  const rows = queryAll<{
    id: number; number: string; bill_date: string | null; due_date: string | null;
    total: number; supplier_id: number | null; supplier_name: string | null;
  }>(`
    SELECT b.id, b.number, b.bill_date, b.due_date, b.total, b.supplier_id, s.name AS supplier_name
    FROM vendor_bills b LEFT JOIN suppliers s ON s.id = b.supplier_id
    WHERE b.status = 'approved' AND b.total > 0`);
  res.json(agingPayload(rows.map((r) => ({
    doc_id: r.id, doc_number: r.number, party_key: r.supplier_id ? `s${r.supplier_id}` : `n:${r.supplier_name ?? '—'}`,
    party_id: r.supplier_id, party_name: r.supplier_name ?? 'No supplier',
    doc_total: r.total, allocated: allocatedFor('vendor_bill', r.id),
    due_date: r.due_date || r.bill_date,
  })), asOf, 'vendor_bill'));
});

function addDays(date: string | null, days: number): string | null {
  if (!date) return null;
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return date;
  d.setDate(d.getDate() + (Number(days) || 0));
  return d.toISOString().slice(0, 10);
}

interface AgingInput {
  doc_id: number; doc_number: string; party_key: string; party_id: number | null; party_name: string;
  doc_total: number; allocated: number; due_date: string | null;
}
function agingPayload(items: AgingInput[], asOf: string, docType: 'sale_order' | 'vendor_bill') {
  const byParty = new Map<string, {
    party_id: number | null; party_name: string; buckets: Record<AgeBucket, number>;
    total: number; docs: { doc_id: number; doc_number: string; due_date: string | null; outstanding: number; bucket: AgeBucket }[];
  }>();
  for (const it of items) {
    const outstanding = round2(it.doc_total - it.allocated);
    if (outstanding <= 0.005) continue;
    const bucket = bucketFor(it.due_date, asOf);
    let p = byParty.get(it.party_key);
    if (!p) {
      p = { party_id: it.party_id, party_name: it.party_name, buckets: emptyBuckets(), total: 0, docs: [] };
      byParty.set(it.party_key, p);
    }
    p.buckets[bucket] = round2(p.buckets[bucket] + outstanding);
    p.total = round2(p.total + outstanding);
    p.docs.push({ doc_id: it.doc_id, doc_number: it.doc_number, due_date: it.due_date, outstanding, bucket });
  }
  const parties = [...byParty.values()].sort((a, b) => b.total - a.total);
  const totals = emptyBuckets();
  let grand = 0;
  for (const p of parties) {
    for (const bk of AGE_BUCKETS) totals[bk] = round2(totals[bk] + p.buckets[bk]);
    grand = round2(grand + p.total);
  }
  return { as_of: asOf, doc_type: docType, buckets: AGE_BUCKETS, parties, totals, grand_total: grand };
}

// GET /api/accounting/party-ledger?party_type=customer|supplier&party_id=&from=&to=
// A running statement: charges (invoices/bills) less payments.
router.get('/party-ledger', (req, res) => {
  if (!requireLedger(res)) return;
  const partyType = req.query.party_type === 'supplier' ? 'supplier' : 'customer';
  const partyId = Number(req.query.party_id);
  if (!partyId) { res.status(400).json({ error: 'party_id is required.' }); return; }
  const from = typeof req.query.from === 'string' ? req.query.from : null;
  const to = typeof req.query.to === 'string' ? req.query.to : null;
  const inRange = (d: string | null) => (!d) || ((!from || d >= from) && (!to || d <= to));

  const party = partyType === 'customer'
    ? queryOne<{ name: string }>('SELECT name FROM customers WHERE id = ?', partyId)
    : queryOne<{ name: string }>('SELECT name FROM suppliers WHERE id = ?', partyId);
  if (!party) { res.status(404).json({ error: `${partyType} not found.` }); return; }

  const charges = partyType === 'customer'
    ? queryAll<{ date: string | null; ref: string; amount: number }>(`
        SELECT o.order_date AS date, o.number AS ref, o.total AS amount FROM orders o
        WHERE o.customer_id = ? AND ${CONFIRMED_SALE_SQL}`, partyId)
    : queryAll<{ date: string | null; ref: string; amount: number }>(`
        SELECT COALESCE(bill_date, created_at) AS date, number AS ref, total AS amount
        FROM vendor_bills WHERE supplier_id = ? AND status = 'approved'`, partyId);

  const pays = queryAll<{ date: string; ref: string; amount: number; status: string }>(`
    SELECT payment_date AS date, number AS ref, amount, status FROM payments
    WHERE party_type = ? AND party_id = ? AND status = 'posted'`, partyType, partyId);

  const events = [
    ...charges.filter((c) => inRange(c.date)).map((c) => ({ date: c.date, ref: c.ref, kind: 'charge' as const, charge: round2(c.amount), payment: 0 })),
    ...pays.filter((p) => inRange(p.date)).map((p) => ({ date: p.date, ref: p.ref, kind: 'payment' as const, charge: 0, payment: round2(p.amount) })),
  ].sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.ref.localeCompare(b.ref));

  let balance = 0;
  const lines = events.map((e) => { balance = round2(balance + e.charge - e.payment); return { ...e, balance }; });
  res.json({
    party_type: partyType, party_id: partyId, party_name: party.name, from, to,
    lines,
    total_charges: round2(events.reduce((s, e) => s + e.charge, 0)),
    total_payments: round2(events.reduce((s, e) => s + e.payment, 0)),
    balance,
  });
});

export default router;
