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
  paymentSchema, creditNoteSchema, taxCodeSchema,
} from '../validation';
import { toCsv } from '../csv';
import { validateJournalLines, accountBalance, DEFAULT_COA, type JournalLineInput } from '../ledger';
import {
  getPostingRules, setPostingRules, seedPostingRulesFromCoa,
  maybeAutoPostPayment, maybeAutoPostCreditNote, unpostSource,
} from '../accounting-autopost';
import { POSTING_RULE_KEYS, type PostingRules } from '../accounting-posting';
import type { Payment, PaymentAllocation, CreditNote, TaxCode } from '../types';
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
import { incomeTax1702, type IncomeTaxAdjustment } from '../ph-income-tax';
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

/** "2026-Q3" (or bare "2026-07"…"2026-09") -> {year, q, from, to, months[]}. Defaults to the current quarter. */
function quarterOf(v: unknown): { year: string; q: number; from: string; to: string; months: string[] } {
  const s = String(v ?? '');
  let year: number, q: number;
  const m = s.match(/^(\d{4})-?Q([1-4])$/i);
  if (m) { year = Number(m[1]); q = Number(m[2]); }
  else {
    const now = new Date();
    year = now.getFullYear();
    q = Math.floor(now.getMonth() / 3) + 1;
  }
  const startMonth = (q - 1) * 3; // 0-indexed
  const from = `${year}-${String(startMonth + 1).padStart(2, '0')}-01`;
  // Date.UTC so the quarter's last day isn't shifted back one by a positive-offset tz.
  const to = new Date(Date.UTC(year, startMonth + 3, 0)).toISOString().slice(0, 10);
  const months = [0, 1, 2].map((i) => `${year}-${String(startMonth + 1 + i).padStart(2, '0')}`);
  return { year: String(year), q, from, to, months };
}

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
  if (req.query.source === 'register') {
    // Build the lines straight from the month's withholding register (approved bills).
    const from = month + '-01';
    const end = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
    const byAtc = new Map<string, EwtLine & { _tax: number }>();
    for (const r of ewtRegisterRows(from, end)) {
      const k = r.atc || '(none)';
      const g = byAtc.get(k) || { atc: k, description: '', tax_base: 0, rate: (r.rate || 0) / 100, _tax: 0 };
      g.tax_base = Math.round((g.tax_base + r.base) * 100) / 100;
      g._tax = Math.round((g._tax + r.tax) * 100) / 100;
      byAtc.set(k, g);
    }
    // Use an effective rate so the 0619-E total matches the amounts actually withheld.
    lines = [...byAtc.values()].map(({ _tax, ...l }) => ({
      ...l, rate: l.tax_base > 0 ? _tax / l.tax_base : l.rate,
    }));
  } else if (typeof req.query.lines === 'string' && req.query.lines) {
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

/** Shared 2550M / 2550Q payload for a date range — re-sourced from the BIR sales &
 *  purchase journals (so exempt / zero-rated and credit / debit notes are already split
 *  and netted, unlike a raw SUM over the documents). */
function vatReturnPayload(from: string, to: string, q: Record<string, unknown>) {
  const s = salesJournalData(from, to).totals;
  const p = purchaseJournalData(from, to).totals;
  const worksheet = vat2550m({
    gross_sales: s.gross,
    output_vat_booked: s.vat,
    gross_purchases: p.gross,
    input_vat_booked: p.vat,
    amounts_vat_inclusive: q.vat_inclusive === '1' || q.vat_inclusive === 'true',
    input_vat_carry_over: Number(q.input_vat_carry_over) || 0,
    vat_payments: Number(q.vat_payments) || 0,
  });
  return {
    sources: { gross_sales: s.gross, gross_purchases: p.gross },
    breakdown: {
      sales: { vatable: s.vatable, exempt: s.exempt, zero_rated: s.zero_rated, output_vat: s.vat },
      purchases: { vatable: p.vatable, exempt: p.exempt, zero_rated: p.zero_rated, input_vat: p.vat },
    },
    worksheet,
  };
}

// GET /api/accounting/bir-2550m?month=&vat_inclusive=&input_vat_carry_over=&vat_payments=
// Monthly VAT declaration worksheet, re-sourced from the sales & purchase journals.
router.get('/bir-2550m', (req, res) => {
  const month = monthOf(req.query.month);
  const [from, to] = monthRange(month);
  res.json({
    month, company: companyProfile(),
    ...vatReturnPayload(from, to, req.query as Record<string, unknown>),
    note: 'Re-sourced from the BIR sales & purchase journals — exempt / zero-rated sales and '
      + 'credit / debit notes are already split and netted. Confirm disallowed input VAT before '
      + 'filing. Deadline: 20th of the following month.',
  });
});

// GET /api/accounting/bir-2550q?quarter=YYYY-Qn&vat_inclusive=&input_vat_carry_over=&vat_payments=
// Quarterly VAT declaration — the quarter's output less input, plus a per-month breakdown.
router.get('/bir-2550q', (req, res) => {
  const { year, q, from, to, months } = quarterOf(req.query.quarter);
  const monthly = months.map((m) => {
    const [mf, mt] = monthRange(m);
    const ms = salesJournalData(mf, mt).totals;
    const mp = purchaseJournalData(mf, mt).totals;
    return {
      month: m,
      output_vat: ms.vat, input_vat: mp.vat,
      net_vat: round2(ms.vat - mp.vat),
      vatable_sales: ms.vatable, vatable_purchases: mp.vatable,
    };
  });
  res.json({
    quarter: `${year}-Q${q}`, from, to, company: companyProfile(),
    monthly,
    ...vatReturnPayload(from, to, req.query as Record<string, unknown>),
    note: 'Quarterly VAT (2550Q). Attach the SLSP (Summary List of Sales / Purchases) when over '
      + 'the threshold. Deadline: the 25th day after the close of the quarter.',
  });
});

// GET /api/accounting/bir-1702?period=YYYY|YYYY-Qn&deduction=itemized|osd&adjustments=<json>
//   &rate=&small_corp=1&mcit=1&prior_payments=&creditable_withholding=&prior_year_excess=
// Corporate income tax worksheet — 1702Q (year-to-date through the quarter) / 1702-RT
// (full year). Book net income + gross income are sourced from the posted ledger for the
// range (excluding the Phase 4c year-end closing entry); everything else is entered.
router.get('/bir-1702', (req, res) => {
  const raw = String(req.query.period ?? '');
  const qm = raw.match(/^(\d{4})-?Q([1-4])$/i);
  let from: string, to: string, label: string, quarter: number | 'annual';
  if (qm) {
    const p = quarterOf(raw);
    from = `${p.year}-01-01`; to = p.to; label = `${p.year}-Q${p.q}`; quarter = p.q;
  } else {
    const y = yearOf(req.query.period);
    from = `${y}-01-01`; to = `${y}-12-31`; label = y; quarter = 'annual';
  }

  const r = queryOne<{ income: number; cogs: number; expense: number }>(`
    SELECT
      COALESCE(SUM(CASE WHEN a.root_type = 'income' THEN jl.credit - jl.debit ELSE 0 END), 0) AS income,
      COALESCE(SUM(CASE WHEN a.root_type = 'expense' AND a.account_type = 'cogs' THEN jl.debit - jl.credit ELSE 0 END), 0) AS cogs,
      COALESCE(SUM(CASE WHEN a.root_type = 'expense' THEN jl.debit - jl.credit ELSE 0 END), 0) AS expense
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
    JOIN accounts a ON a.id = jl.account_id
    WHERE je.status = 'posted' AND a.is_group = 0
      AND (je.source_type IS NULL OR je.source_type <> 'year_end_close')
      AND je.entry_date >= ? AND je.entry_date <= ?`, from, to);
  const grossIncome = round2((r?.income ?? 0) - (r?.cogs ?? 0));
  const bookNet = round2((r?.income ?? 0) - (r?.expense ?? 0));

  let adjustments: IncomeTaxAdjustment[] = [];
  if (typeof req.query.adjustments === 'string' && req.query.adjustments) {
    try {
      const parsed = JSON.parse(req.query.adjustments);
      if (Array.isArray(parsed)) {
        adjustments = parsed.map((a: Record<string, unknown>) => ({
          label: String(a.label ?? ''),
          kind: a.kind === 'deduct' ? 'deduct' : 'add',
          amount: Number(a.amount) || 0,
        }));
      }
    } catch { /* ignore — no adjustments */ }
  }

  const worksheet = incomeTax1702({
    gross_income: grossIncome,
    book_net_income: bookNet,
    deduction_method: req.query.deduction === 'osd' ? 'osd' : 'itemized',
    adjustments,
    rate: req.query.small_corp === '1' ? 0.20 : (Number(req.query.rate) || undefined),
    mcit_applies: req.query.mcit === '1',
    prior_payments: Number(req.query.prior_payments) || 0,
    creditable_withholding: Number(req.query.creditable_withholding) || 0,
    prior_year_excess: Number(req.query.prior_year_excess) || 0,
  });

  res.json({
    period: label, quarter, from, to, company: companyProfile(),
    form: quarter === 'annual' ? '1702-RT' : '1702Q',
    sources: { gross_income: grossIncome, book_net_income: bookNet },
    worksheet,
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
  res.json(queryAll<AccountingPeriod & { closed_by_name: string | null }>(
    `SELECT p.*, u.full_name AS closed_by_name FROM accounting_periods p
     LEFT JOIN users u ON u.id = p.closed_by
     ORDER BY p.start_date DESC`
  ));
});

router.post('/ledger/periods', requirePermission('accounting.manage'), (req, res) => {
  if (!requireLedger(res)) return;
  const b = parseBody(glPeriodSchema, req.body);
  if (b.end_date < b.start_date) { res.status(400).json({ error: 'End date is before the start date.' }); return; }
  const info = run('INSERT INTO accounting_periods (name, start_date, end_date) VALUES (?, ?, ?)',
    b.name, b.start_date, b.end_date);
  res.status(201).json({ id: Number(info.lastInsertRowid) });
});

/** The live (non-reversed) posted year-end closing entry for a period, if any. */
function liveClosingEntry(periodId: number): { id: number; number: string; entry_date: string } | undefined {
  return queryOne<{ id: number; number: string; entry_date: string }>(
    `SELECT id, number, entry_date FROM journal_entries je
     WHERE source_type = 'year_end_close' AND source_id = ? AND status = 'posted'
       AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_id = je.id)
     ORDER BY id DESC LIMIT 1`, periodId
  );
}

/** Post the closing journal entry for a fiscal period: zero every income / expense account
 *  by its movement within [start, end] and roll the net into Retained Earnings. Returns
 *  null when there is nothing to close. Caller wraps in its own guards. */
function postClosingEntry(period: AccountingPeriod, userId: number): {
  id: number; number: string; net_income: number; retained_earnings: { code: string; delta: number } | null;
} | null {
  const re = queryOne<{ id: number; code: string }>(
    "SELECT id, code FROM accounts WHERE account_type = 'retained_earnings' AND is_group = 0 ORDER BY code LIMIT 1");
  if (!re) throw Object.assign(new Error('Add a Retained Earnings account (account type "retained_earnings") before closing a period.'), { status: 400 });

  const rows = queryAll<{ id: number; root_type: AccountRootType; debit: number; credit: number }>(`
    SELECT jl.account_id AS id, a.root_type, SUM(jl.debit) AS debit, SUM(jl.credit) AS credit
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
    JOIN accounts a ON a.id = jl.account_id
    WHERE je.status = 'posted' AND a.is_group = 0 AND a.root_type IN ('income', 'expense')
      AND je.entry_date >= ? AND je.entry_date <= ?
    GROUP BY jl.account_id`, period.start_date, period.end_date);

  const lines: { account_id: number; debit: number; credit: number }[] = [];
  let netIncomeAmt = 0;
  for (const r of rows) {
    const nat = accountBalance(r.root_type, r.debit || 0, r.credit || 0); // ≥0 for a healthy account
    if (Math.abs(nat) < 0.005) continue;
    if (r.root_type === 'income') { lines.push({ account_id: r.id, debit: round2(nat), credit: 0 }); netIncomeAmt = round2(netIncomeAmt + nat); }
    else { lines.push({ account_id: r.id, debit: 0, credit: round2(nat) }); netIncomeAmt = round2(netIncomeAmt - nat); }
  }
  if (!lines.length) return null;

  // Balance to Retained Earnings: profit -> credit RE, loss -> debit RE.
  const reDelta = round2(netIncomeAmt);
  if (Math.abs(reDelta) >= 0.005) {
    lines.push(reDelta > 0
      ? { account_id: re.id, debit: 0, credit: reDelta }
      : { account_id: re.id, debit: -reDelta, credit: 0 });
  }

  db.exec('BEGIN');
  try {
    const number = nextSequence('je_number', 'JV', 6);
    const info = run(
      `INSERT INTO journal_entries (number, book, entry_date, memo, status, source_type, source_id, posted_by, posted_at, created_by)
       VALUES (?, 'general', ?, ?, 'posted', 'year_end_close', ?, ?, datetime('now'), ?)`,
      number, period.end_date, `Closing entries — ${period.name}`, period.id, userId, userId
    );
    const entryId = Number(info.lastInsertRowid);
    lines.forEach((l, i) => run(
      `INSERT INTO journal_lines (entry_id, account_id, debit, credit, memo, sort) VALUES (?, ?, ?, ?, ?, ?)`,
      entryId, l.account_id, l.debit, l.credit, null, i
    ));
    db.exec('COMMIT');
    return { id: entryId, number, net_income: round2(netIncomeAmt), retained_earnings: Math.abs(reDelta) >= 0.005 ? { code: re.code, delta: reDelta } : null };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** Reverse a period's live closing entry (used on reopen). Equal-and-opposite posted
 *  entry dated the period end, `reverses_id` links the two. */
function reverseClosingEntry(entryId: number, endDate: string, userId: number): { id: number; number: string } {
  const orig = queryOne<{ number: string; memo: string | null }>('SELECT number, memo FROM journal_entries WHERE id = ?', entryId)!;
  const src = queryAll<{ account_id: number; debit: number; credit: number }>(
    'SELECT account_id, debit, credit FROM journal_lines WHERE entry_id = ? ORDER BY sort, id', entryId);
  db.exec('BEGIN');
  try {
    const number = nextSequence('je_number', 'JV', 6);
    const info = run(
      `INSERT INTO journal_entries (number, book, entry_date, memo, status, reverses_id, source_type, source_id, posted_by, posted_at, created_by)
       VALUES (?, 'general', ?, ?, 'posted', ?, 'year_end_close', ?, ?, datetime('now'), ?)`,
      number, endDate, `Reversal of ${orig.number}${orig.memo ? ' — ' + orig.memo : ''}`, entryId,
      queryOne<{ source_id: number }>('SELECT source_id FROM journal_entries WHERE id = ?', entryId)!.source_id,
      userId, userId
    );
    const revId = Number(info.lastInsertRowid);
    src.forEach((l, i) => run(
      `INSERT INTO journal_lines (entry_id, account_id, debit, credit, memo, sort) VALUES (?, ?, ?, ?, ?, ?)`,
      revId, l.account_id, round2(l.credit), round2(l.debit), null, i
    ));
    db.exec('COMMIT');
    return { id: revId, number };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// POST /ledger/periods/:id/(close|reopen) — closing also posts the year-end closing entry
// (zero income/expense → Retained Earnings); reopening reverses it.
router.post('/ledger/periods/:id/:action(close|reopen)', requirePermission('accounting.manage'), (req, res) => {
  if (!requireLedger(res)) return;
  const id = Number(req.params.id);
  const period = queryOne<AccountingPeriod>('SELECT * FROM accounting_periods WHERE id = ?', id);
  if (!period) { res.status(404).json({ error: 'Period not found' }); return; }
  const closing = req.params.action === 'close';

  let closingEntry: ReturnType<typeof postClosingEntry> = null;
  let reversalEntry: { id: number; number: string } | null = null;

  if (closing) {
    if (period.status === 'closed') { res.status(409).json({ error: 'Period is already closed.' }); return; }
    const existing = liveClosingEntry(id);
    closingEntry = existing ? null : postClosingEntry(period, req.user!.id);
  } else {
    const live = liveClosingEntry(id);
    if (live) reversalEntry = reverseClosingEntry(live.id, live.entry_date, req.user!.id);
  }

  run(
    `UPDATE accounting_periods SET status = ?, closed_by = ?, closed_at = ? WHERE id = ?`,
    closing ? 'closed' : 'open', closing ? req.user!.id : null,
    closing ? new Date().toISOString() : null, id
  );
  res.json({ ok: true, status: closing ? 'closed' : 'open', closing_entry: closingEntry, reversal: reversalEntry });
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
  sales_returns_account_id: 'income',
  ewt_payable_account_id: 'liability',
  payroll_expense_account_id: 'expense',
  payroll_er_contrib_account_id: 'expense',
  sss_payable_account_id: 'liability',
  philhealth_payable_account_id: 'liability',
  pagibig_payable_account_id: 'liability',
  withholding_tax_payable_account_id: 'liability',
  net_pay_payable_account_id: 'liability',
  employee_advance_account_id: 'asset',
  inventory_asset_account_id: 'asset',
  wip_account_id: 'asset',
  mfg_variance_account_id: 'expense',
  grir_clearing_account_id: 'liability',
  cogs_account_id: 'expense',
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

// GET .../reports/cash-flow?from=&to= — indirect-method statement of cash flows.
// Re-groups the change in every non-cash account over the period: net income + the
// movement in working-capital / non-cash accounts (operating), in non-current assets
// (investing) and in non-current liabilities / equity (financing). By double-entry the
// three totals always sum to the change in cash & bank — `reconciles` is a rounding check.
// Operating vs investing vs financing is a presentation split, keyed off `account_type`
// and the default chart's numbering (1200s = non-current assets, 2200s = non-current
// liabilities); re-tag or renumber accounts to change how a line is grouped.
router.get('/ledger/reports/cash-flow', (req, res) => {
  if (!requireLedger(res)) return;
  const to = typeof req.query.to === 'string' ? req.query.to : new Date().toISOString().slice(0, 10);
  const from = typeof req.query.from === 'string' ? req.query.from
    : ledgerSettings().fiscal_year_start || to.slice(0, 8) + '01';
  const open = accountBalancesUpTo(addDays(from, -1) ?? undefined);
  const close = accountBalancesUpTo(to);
  const accts = queryAll<Account>("SELECT * FROM accounts WHERE is_group = 0 ORDER BY code");

  const bal = (m: Map<number, { debit: number; credit: number }>, a: Account): number => {
    const b = m.get(a.id) || { debit: 0, credit: 0 };
    return accountBalance(a.root_type, b.debit, b.credit);
  };
  const nonCurrentAsset = (a: Account) =>
    a.account_type === 'fixed_asset' || a.account_type === 'accumulated_depreciation' || /^12/.test(a.code);
  const nonCurrentLiab = (a: Account) => /^22/.test(a.code);

  type Line = { code: string; name: string; amount: number };
  const operating: Line[] = [], investing: Line[] = [], financing: Line[] = [];
  let cashOpen = 0, cashClose = 0;

  for (const a of accts) {
    if (a.account_type === 'cash' || a.account_type === 'bank') {
      cashOpen = round2(cashOpen + bal(open, a));
      cashClose = round2(cashClose + bal(close, a));
      continue;
    }
    if (a.root_type === 'income' || a.root_type === 'expense') continue; // captured in net income
    const delta = round2(bal(close, a) - bal(open, a));
    if (delta === 0) continue;
    // Cash impact: a rise in an asset consumes cash; a rise in a liability / equity provides it.
    const line: Line = { code: a.code, name: a.name, amount: a.root_type === 'asset' ? -delta : delta };
    if (a.root_type === 'asset') (nonCurrentAsset(a) && a.account_type !== 'accumulated_depreciation' ? investing : operating).push(line);
    else if (a.root_type === 'liability') (nonCurrentLiab(a) ? financing : operating).push(line);
    else financing.push(line); // equity
  }

  const netInc = netIncome(from, to);
  const opTotal = round2(netInc + operating.reduce((s, l) => s + l.amount, 0));
  const invTotal = round2(investing.reduce((s, l) => s + l.amount, 0));
  const finTotal = round2(financing.reduce((s, l) => s + l.amount, 0));
  const netChange = round2(opTotal + invTotal + finTotal);

  res.json({
    from, to,
    operating: { net_income: netInc, adjustments: operating, total: opTotal },
    investing: { items: investing, total: invTotal },
    financing: { items: financing, total: finTotal },
    net_change_in_cash: netChange,
    cash_beginning: round2(cashOpen),
    cash_ending: round2(cashClose),
    reconciles: Math.abs(netChange - round2(cashClose - cashOpen)) < 0.01,
  });
});

// GET .../reports/equity-changes?from=&to= — statement of changes in equity: opening,
// movement and closing per equity account, plus the period's net income (folded into
// retained earnings only at period-end close, shown separately until then). With
// `from` = the fiscal-year start, `closing_equity` matches the balance sheet's
// equity-with-earnings.
router.get('/ledger/reports/equity-changes', (req, res) => {
  if (!requireLedger(res)) return;
  const to = typeof req.query.to === 'string' ? req.query.to : new Date().toISOString().slice(0, 10);
  const from = typeof req.query.from === 'string' ? req.query.from
    : ledgerSettings().fiscal_year_start || to.slice(0, 8) + '01';
  const open = accountBalancesUpTo(addDays(from, -1) ?? undefined);
  const close = accountBalancesUpTo(to);

  const rows = queryAll<Account>("SELECT * FROM accounts WHERE is_group = 0 AND root_type = 'equity' ORDER BY code")
    .map((a) => {
      const ob = open.get(a.id) || { debit: 0, credit: 0 };
      const cb = close.get(a.id) || { debit: 0, credit: 0 };
      const opening = accountBalance('equity', ob.debit, ob.credit);
      const closing = accountBalance('equity', cb.debit, cb.credit);
      return { code: a.code, name: a.name, opening: round2(opening), movement: round2(closing - opening), closing: round2(closing) };
    });
  const netInc = netIncome(from, to);
  const openingEquity = round2(rows.reduce((s, r) => s + r.opening, 0));
  const movements = round2(rows.reduce((s, r) => s + r.movement, 0));

  res.json({
    from, to, rows,
    net_income_for_period: netInc,
    opening_equity: openingEquity,
    movements_total: movements,
    closing_equity: round2(openingEquity + movements + netInc),
  });
});

/** The Cash Receipts / Cash Disbursements book for a range: every posted entry in that
 *  cash journal, its cash-side movement, and the contra accounts each entry hit. */
function cashBookData(type: 'receipts' | 'disbursements', from: string, to: string) {
  const book = type === 'receipts' ? 'cash_receipts' : 'cash_disbursements';
  const cashAcctIds = new Set(queryAll<{ id: number }>(
    "SELECT id FROM accounts WHERE account_type IN ('cash','bank')").map((a) => a.id));

  const entries = queryAll<JournalEntry & { party_name?: string | null; source_number?: string | null }>(`
    SELECT je.*, p.party_name AS party_name, p.number AS source_number
    FROM journal_entries je
    LEFT JOIN payments p ON p.id = je.source_id AND je.source_type = 'payment'
    WHERE je.book = ? AND je.status = 'posted' AND je.entry_date >= ? AND je.entry_date <= ?
    ORDER BY je.entry_date, je.id`, book, from, to);

  const contraTotals = new Map<number, { code: string; name: string; debit: number; credit: number }>();
  let cashDebit = 0, cashCredit = 0;
  const rows = entries.map((e) => {
    let cIn = 0, cOut = 0;
    const contra: { code: string; name: string; debit: number; credit: number }[] = [];
    for (const l of loadLines(e.id)) {
      if (cashAcctIds.has(l.account_id)) { cIn = round2(cIn + l.debit); cOut = round2(cOut + l.credit); continue; }
      contra.push({ code: l.account_code ?? '', name: l.account_name ?? '', debit: round2(l.debit), credit: round2(l.credit) });
      const g = contraTotals.get(l.account_id) ?? { code: l.account_code ?? '', name: l.account_name ?? '', debit: 0, credit: 0 };
      g.debit = round2(g.debit + l.debit); g.credit = round2(g.credit + l.credit);
      contraTotals.set(l.account_id, g);
    }
    cashDebit = round2(cashDebit + cIn); cashCredit = round2(cashCredit + cOut);
    return {
      date: e.entry_date, number: e.number, ref: e.reference || e.source_number || null,
      party: e.party_name ?? null, memo: e.memo ?? null,
      source_type: e.source_type ?? null, source_id: e.source_id ?? null,
      cash_in: cIn, cash_out: cOut, contra,
    };
  });
  return {
    type, book, rows,
    cash_totals: { debit: cashDebit, credit: cashCredit, net: round2(cashDebit - cashCredit) },
    contra_totals: [...contraTotals.values()].sort((a, b) => (b.debit + b.credit) - (a.debit + a.credit)),
  };
}

// GET /api/accounting/cash-book?type=receipts|disbursements&from=&to=&format=csv
// The BIR Cash Receipts / Cash Disbursements books (see cashBookData). The payment
// auto-post (Phase 1b) is what fills these journals; manual entries booked to the
// cash_receipts / cash_disbursements journal show here too.
router.get('/cash-book', (req, res) => {
  if (!requireLedger(res)) return;
  const type = req.query.type === 'disbursements' ? 'disbursements' : 'receipts';
  const to = typeof req.query.to === 'string' ? req.query.to : new Date().toISOString().slice(0, 10);
  const from = typeof req.query.from === 'string' ? req.query.from : to.slice(0, 8) + '01';
  const d = cashBookData(type, from, to);

  if (req.query.format === 'csv') {
    const headers = ['Date', 'Entry', 'Ref', 'Party', 'Memo', 'Cash in', 'Cash out', 'Contra accounts'];
    const csvRows = d.rows.map((r) => ({
      Date: r.date, Entry: r.number, Ref: r.ref ?? '', Party: r.party ?? '', Memo: r.memo ?? '',
      'Cash in': r.cash_in, 'Cash out': r.cash_out,
      'Contra accounts': r.contra.map((c) => `${c.code} ${c.name} ${c.debit ? 'Dr ' + c.debit : 'Cr ' + c.credit}`).join('; '),
    }));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="cash-${type}-${from}_${to}.csv"`);
    res.send(toCsv(headers, csvRows));
    return;
  }
  res.json({ ...d, from, to });
});

/* ================================================ Books of Accounts (Phase 4b) === */
/* The registered books a Computerized Accounting System presents to the BIR: General
   Journal, General Ledger, Cash Receipts / Disbursements Books, Sales / Purchase Journals.
   All read from the posted `journal_lines`; see docs/ACCOUNTING-SYSTEM-PLAN.md §1.1 / §4.2. */

/** General Journal: every posted journal line for the range, chronological, grouped by entry. */
function generalJournalData(from: string, to: string) {
  const rows = queryAll<{
    entry_id: number; date: string; number: string; book: string; memo: string | null;
    account_code: string; account_name: string; line_memo: string | null; debit: number; credit: number;
  }>(`
    SELECT je.id AS entry_id, je.entry_date AS date, je.number, je.book, je.memo,
           a.code AS account_code, a.name AS account_name, jl.memo AS line_memo, jl.debit, jl.credit
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
    JOIN accounts a ON a.id = jl.account_id
    WHERE je.status = 'posted' AND je.entry_date >= ? AND je.entry_date <= ?
    ORDER BY je.entry_date, je.id, jl.sort, jl.id`, from, to);
  return {
    rows: rows.map((r) => ({ ...r, debit: round2(r.debit), credit: round2(r.credit) })),
    total_debit: round2(rows.reduce((s, r) => s + (r.debit || 0), 0)),
    total_credit: round2(rows.reduce((s, r) => s + (r.credit || 0), 0)),
  };
}

/** General Ledger, every account that has posted activity up to `to`: opening balance
 *  carried into `from`, the range's posted lines with a running balance, and the closing. */
function generalLedgerAllData(from: string, to: string) {
  const opening = accountBalancesUpTo(addDays(from, -1) ?? undefined);
  const accts = queryAll<Account>("SELECT * FROM accounts WHERE is_group = 0 ORDER BY code");
  const linesByAcct = new Map<number, { date: string; number: string; memo: string | null; line_memo: string | null; debit: number; credit: number }[]>();
  for (const l of queryAll<{ account_id: number; date: string; number: string; memo: string | null; line_memo: string | null; debit: number; credit: number }>(`
    SELECT jl.account_id, je.entry_date AS date, je.number, je.memo, jl.memo AS line_memo, jl.debit, jl.credit
    FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
    WHERE je.status = 'posted' AND je.entry_date >= ? AND je.entry_date <= ?
    ORDER BY je.entry_date, je.id, jl.sort, jl.id`, from, to)) {
    (linesByAcct.get(l.account_id) ?? linesByAcct.set(l.account_id, []).get(l.account_id)!).push(l);
  }

  const accountsOut = [];
  for (const a of accts) {
    const ob = opening.get(a.id);
    const lines = linesByAcct.get(a.id) ?? [];
    const openingBal = accountBalance(a.root_type, ob?.debit ?? 0, ob?.credit ?? 0);
    if (!lines.length && openingBal === 0) continue;   // no activity ever
    const dir = a.root_type === 'asset' || a.root_type === 'expense' ? 1 : -1;
    let running = openingBal;
    const entries = lines.map((l) => {
      running = round2(running + dir * ((l.debit || 0) - (l.credit || 0)));
      return { date: l.date, number: l.number, memo: l.line_memo || l.memo || '', debit: round2(l.debit), credit: round2(l.credit), running_balance: running };
    });
    accountsOut.push({
      account: { code: a.code, name: a.name, root_type: a.root_type },
      opening_balance: openingBal,
      entries,
      total_debit: round2(lines.reduce((s, l) => s + (l.debit || 0), 0)),
      total_credit: round2(lines.reduce((s, l) => s + (l.credit || 0), 0)),
      closing_balance: running,
    });
  }
  return { accounts: accountsOut };
}

// GET /api/accounting/ledger/reports/general-journal?from=&to=&format=csv
router.get('/ledger/reports/general-journal', (req, res) => {
  if (!requireLedger(res)) return;
  const to = typeof req.query.to === 'string' ? req.query.to : new Date().toISOString().slice(0, 10);
  const from = typeof req.query.from === 'string' ? req.query.from : ledgerSettings().fiscal_year_start || to.slice(0, 8) + '01';
  const d = generalJournalData(from, to);
  if (req.query.format === 'csv') {
    const headers = ['Date', 'Reference', 'Account code', 'Account', 'Particulars', 'Debit', 'Credit'];
    const csvRows = d.rows.map((r) => ({
      Date: r.date, Reference: r.number, 'Account code': r.account_code, Account: r.account_name,
      Particulars: r.line_memo || r.memo || '', Debit: r.debit || '', Credit: r.credit || '',
    }));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="general-journal-${from}_${to}.csv"`);
    res.send(toCsv(headers, csvRows));
    return;
  }
  res.json({ from, to, company: companyProfile(), ...d });
});

// GET /api/accounting/ledger/reports/general-ledger-all?from=&to=&format=csv
router.get('/ledger/reports/general-ledger-all', (req, res) => {
  if (!requireLedger(res)) return;
  const to = typeof req.query.to === 'string' ? req.query.to : new Date().toISOString().slice(0, 10);
  const from = typeof req.query.from === 'string' ? req.query.from : ledgerSettings().fiscal_year_start || to.slice(0, 8) + '01';
  const d = generalLedgerAllData(from, to);
  if (req.query.format === 'csv') {
    const headers = ['Account code', 'Account', 'Date', 'Reference', 'Particulars', 'Debit', 'Credit', 'Running balance'];
    const csvRows: Record<string, unknown>[] = [];
    for (const acc of d.accounts) {
      csvRows.push({ 'Account code': acc.account.code, Account: acc.account.name, Particulars: 'Opening balance', 'Running balance': acc.opening_balance });
      for (const e of acc.entries) csvRows.push({
        'Account code': acc.account.code, Account: acc.account.name, Date: e.date, Reference: e.number,
        Particulars: e.memo, Debit: e.debit || '', Credit: e.credit || '', 'Running balance': e.running_balance,
      });
      csvRows.push({ 'Account code': acc.account.code, Account: acc.account.name, Particulars: 'Closing balance', 'Running balance': acc.closing_balance });
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="general-ledger-${from}_${to}.csv"`);
    res.send(toCsv(headers, csvRows));
    return;
  }
  res.json({ from, to, company: companyProfile(), ...d });
});

// GET /api/accounting/books-of-accounts?from=&to= — the whole registered set in one
// payload, for a printable "Books of Accounts" document (BIR CAS presentation). Each book
// also has its own CSV endpoint (linked in `books[].csv`).
router.get('/books-of-accounts', (req, res) => {
  if (!requireLedger(res)) return;
  const to = typeof req.query.to === 'string' ? req.query.to : new Date().toISOString().slice(0, 10);
  const from = typeof req.query.from === 'string' ? req.query.from : ledgerSettings().fiscal_year_start || to.slice(0, 8) + '01';
  const range = `from=${from}&to=${to}`;
  res.json({
    company: companyProfile(),
    from, to,
    books: [
      { key: 'general_journal', title: 'General Journal', csv: `/api/accounting/ledger/reports/general-journal?${range}&format=csv`, data: generalJournalData(from, to) },
      { key: 'general_ledger', title: 'General Ledger', csv: `/api/accounting/ledger/reports/general-ledger-all?${range}&format=csv`, data: generalLedgerAllData(from, to) },
      { key: 'cash_receipts_book', title: 'Cash Receipts Book', csv: `/api/accounting/cash-book?type=receipts&${range}&format=csv`, data: cashBookData('receipts', from, to) },
      { key: 'cash_disbursements_book', title: 'Cash Disbursements Book', csv: `/api/accounting/cash-book?type=disbursements&${range}&format=csv`, data: cashBookData('disbursements', from, to) },
      { key: 'sales_journal', title: 'Sales Journal', csv: null, data: salesJournalData(from, to) },
      { key: 'purchase_journal', title: 'Purchase Journal', csv: null, data: purchaseJournalData(from, to) },
    ],
    note: 'Present these with the system description and sample reports for BIR CAS registration. '
      + 'The app does not register on your behalf (see docs/ACCOUNTING-SYSTEM-PLAN.md §7).',
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

/* ------------------------------------------------------------------- credit / debit notes --- */
/* Customer credit note (kind 'customer') -> reduces AR; supplier debit note ('supplier')
   -> reduces AP. Header-only; total = subtotal + tax_amount. Auto-posts a contra entry. */

// GET /api/accounting/credit-notes?kind=&party_id=&from=&to=&status=
router.get('/credit-notes', (req, res) => {
  if (!requireLedger(res)) return;
  const where: string[] = [];
  const params: unknown[] = [];
  const q = req.query;
  if (typeof q.kind === 'string') { where.push('n.kind = ?'); params.push(q.kind); }
  if (typeof q.status === 'string') { where.push('n.status = ?'); params.push(q.status); }
  if (q.party_id != null && q.party_id !== '') { where.push('n.party_id = ?'); params.push(Number(q.party_id)); }
  if (typeof q.from === 'string') { where.push('n.note_date >= ?'); params.push(q.from); }
  if (typeof q.to === 'string') { where.push('n.note_date <= ?'); params.push(q.to); }
  res.json(queryAll<CreditNote>(`
    SELECT n.*, u.full_name AS created_by_name
    FROM credit_notes n LEFT JOIN users u ON u.id = n.created_by
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY n.note_date DESC, n.id DESC LIMIT 500`, ...params));
});

router.get('/credit-notes/:id', (req, res) => {
  if (!requireLedger(res)) return;
  const n = queryOne<CreditNote>(`
    SELECT n.*, u.full_name AS created_by_name FROM credit_notes n
    LEFT JOIN users u ON u.id = n.created_by WHERE n.id = ?`, Number(req.params.id));
  if (!n) { res.status(404).json({ error: 'Credit note not found' }); return; }
  if (n.source_doc_type && n.source_doc_id) {
    const src = n.source_doc_type === 'sale_order'
      ? queryOne<{ number: string }>('SELECT number FROM orders WHERE id = ?', n.source_doc_id)
      : queryOne<{ number: string }>('SELECT number FROM vendor_bills WHERE id = ?', n.source_doc_id);
    n.source_doc_number = src?.number ?? null;
  }
  res.json(n);
});

// POST /api/accounting/credit-notes — issue a credit / debit note + auto-post.
router.post('/credit-notes', requirePermission('accounting.manage'), (req, res) => {
  if (!requireLedger(res)) return;
  const b = parseBody(creditNoteSchema, req.body);
  const total = round2((b.subtotal || 0) + (b.tax_amount || 0));
  if (total <= 0) { res.status(400).json({ error: 'A note needs a positive amount.' }); return; }

  let partyName = b.party_name ?? null;
  if (b.party_id != null) {
    const row = b.kind === 'customer'
      ? queryOne<{ name: string }>('SELECT name FROM customers WHERE id = ?', b.party_id)
      : queryOne<{ name: string }>('SELECT name FROM suppliers WHERE id = ?', b.party_id);
    if (!row) { res.status(400).json({ error: `${b.kind} not found.` }); return; }
    partyName = partyName ?? row.name;
  }
  const wantSrc = b.kind === 'customer' ? 'sale_order' : 'vendor_bill';
  if (b.source_doc_type && b.source_doc_type !== wantSrc) {
    res.status(400).json({ error: `A ${b.kind} note links to a ${wantSrc.replace('_', ' ')}.` });
    return;
  }

  const number = nextSequence(b.kind === 'customer' ? 'credit_note' : 'debit_note',
    b.kind === 'customer' ? 'CN' : 'DN', 5);
  const info = run(
    `INSERT INTO credit_notes
      (number, kind, party_id, party_name, note_date, source_doc_type, source_doc_id, tax_code_id, reason,
       subtotal, tax_amount, total, status, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'issued', ?)`,
    number, b.kind, b.party_id ?? null, partyName, b.note_date,
    b.source_doc_type ?? null, b.source_doc_id ?? null, b.tax_code_id ?? null, b.reason ?? null,
    round2(b.subtotal || 0), round2(b.tax_amount || 0), total, req.user!.id
  );
  const noteId = Number(info.lastInsertRowid);
  const posted = maybeAutoPostCreditNote(noteId, req.user!.id);
  res.status(201).json({ id: noteId, number, posted: posted.posted, entry: posted.entry ?? null, error: posted.error ?? null });
});

// POST /api/accounting/credit-notes/:id/void
router.post('/credit-notes/:id/void', requirePermission('accounting.manage'), (req, res) => {
  if (!requireLedger(res)) return;
  const id = Number(req.params.id);
  const n = queryOne<CreditNote>('SELECT * FROM credit_notes WHERE id = ?', id);
  if (!n) { res.status(404).json({ error: 'Credit note not found' }); return; }
  if (n.status === 'void') { res.status(409).json({ error: 'Already void.' }); return; }
  const rev = unpostSource('credit_note', id, req.user!.id);
  if (rev.error) { res.status(409).json({ error: `Could not reverse the ledger entry: ${rev.error}` }); return; }
  run("UPDATE credit_notes SET status = 'void' WHERE id = ?", id);
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
  })), asOf, 'sale_order', partyCredits('ar')));
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
    doc_id: r.id, doc_number: r.number, party_key: r.supplier_id ? `c${r.supplier_id}` : `n:${r.supplier_name ?? '—'}`,
    party_id: r.supplier_id, party_name: r.supplier_name ?? 'No supplier',
    doc_total: r.total, allocated: allocatedFor('vendor_bill', r.id),
    due_date: r.due_date || r.bill_date,
  })), asOf, 'vendor_bill', partyCredits('ap')));
});

function addDays(date: string | null, days: number): string | null {
  if (!date) return null;
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return date;
  d.setDate(d.getDate() + (Number(days) || 0));
  return d.toISOString().slice(0, 10);
}

/** On-account credit per party_id: issued credit/debit notes + the unapplied portion of
 *  posted payments. Reduces (or reverses) what the aged documents say is owed. Only
 *  covers parties with a real party_id (name-only rows stay un-netted). */
function partyCredits(side: 'ar' | 'ap'): Map<number, { name: string; credit_notes: number; unapplied_payments: number }> {
  const kind = side === 'ar' ? 'customer' : 'supplier';
  const direction = side === 'ar' ? 'in' : 'out';
  const m = new Map<number, { name: string; credit_notes: number; unapplied_payments: number }>();
  for (const r of queryAll<{ party_id: number; party_name: string | null; t: number }>(
    "SELECT party_id, party_name, COALESCE(SUM(total),0) AS t FROM credit_notes WHERE kind = ? AND status = 'issued' AND party_id IS NOT NULL GROUP BY party_id",
    kind
  )) m.set(r.party_id, { name: r.party_name ?? '', credit_notes: round2(r.t), unapplied_payments: 0 });
  for (const r of queryAll<{ party_id: number; party_name: string | null; unapplied: number }>(
    `SELECT p.party_id, p.party_name,
            COALESCE(SUM(p.amount),0) - COALESCE(SUM((SELECT COALESCE(SUM(amount),0) FROM payment_allocations WHERE payment_id = p.id)),0) AS unapplied
     FROM payments p
     WHERE p.party_type = ? AND p.direction = ? AND p.status = 'posted' AND p.party_id IS NOT NULL
     GROUP BY p.party_id`,
    kind, direction
  )) {
    const cur = m.get(r.party_id) ?? { name: r.party_name ?? '', credit_notes: 0, unapplied_payments: 0 };
    cur.unapplied_payments = round2(Math.max(0, r.unapplied));
    if (!cur.name) cur.name = r.party_name ?? '';
    m.set(r.party_id, cur);
  }
  return m;
}

interface AgingInput {
  doc_id: number; doc_number: string; party_key: string; party_id: number | null; party_name: string;
  doc_total: number; allocated: number; due_date: string | null;
}
function agingPayload(
  items: AgingInput[], asOf: string, docType: 'sale_order' | 'vendor_bill',
  credits: Map<number, { name: string; credit_notes: number; unapplied_payments: number }>
) {
  interface Row {
    party_id: number | null; party_name: string; buckets: Record<AgeBucket, number>;
    open: number; credits: number; total: number;
    docs: { doc_id: number; doc_number: string; due_date: string | null; outstanding: number; bucket: AgeBucket }[];
  }
  const byParty = new Map<string, Row>();
  const ensure = (key: string, id: number | null, name: string): Row => {
    let p = byParty.get(key);
    if (!p) {
      p = { party_id: id, party_name: name, buckets: emptyBuckets(), open: 0, credits: 0, total: 0, docs: [] };
      byParty.set(key, p);
    }
    return p;
  };
  for (const it of items) {
    const outstanding = round2(it.doc_total - it.allocated);
    if (outstanding <= 0.005) continue;
    const bucket = bucketFor(it.due_date, asOf);
    const p = ensure(it.party_key, it.party_id, it.party_name);
    p.buckets[bucket] = round2(p.buckets[bucket] + outstanding);
    p.open = round2(p.open + outstanding);
    p.docs.push({ doc_id: it.doc_id, doc_number: it.doc_number, due_date: it.due_date, outstanding, bucket });
  }
  for (const [pid, c] of credits) {
    const credit = round2(c.credit_notes + c.unapplied_payments);
    if (credit <= 0.005) continue;
    const p = ensure(`c${pid}`, pid, c.name || 'Unknown');
    p.credits = round2(p.credits + credit);
  }
  const parties = [...byParty.values()].map((p) => ({ ...p, total: round2(p.open - p.credits) }))
    .sort((a, b) => b.total - a.total);
  const totals = emptyBuckets();
  let open = 0, cr = 0;
  for (const p of parties) {
    for (const bk of AGE_BUCKETS) totals[bk] = round2(totals[bk] + p.buckets[bk]);
    open = round2(open + p.open);
    cr = round2(cr + p.credits);
  }
  return {
    as_of: asOf, doc_type: docType, buckets: AGE_BUCKETS, parties, totals,
    total_open: open, total_credits: cr, grand_total: round2(open - cr),
  };
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

  // A credit / debit note behaves like a negative charge (reduces what is owed).
  const notes = queryAll<{ date: string; ref: string; amount: number }>(`
    SELECT note_date AS date, number AS ref, total AS amount FROM credit_notes
    WHERE kind = ? AND party_id = ? AND status = 'issued'`, partyType, partyId);

  const events = [
    ...charges.filter((c) => inRange(c.date)).map((c) => ({ date: c.date, ref: c.ref, kind: 'charge' as const, charge: round2(c.amount), payment: 0 })),
    ...notes.filter((n) => inRange(n.date)).map((n) => ({ date: n.date, ref: n.ref, kind: 'credit_note' as const, charge: round2(-n.amount), payment: 0 })),
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

/* =========================================================== tax codes + BIR journals (Phase 2) === */
/* tax_codes classify a document for VAT / withholding. They drive which account the GL
   auto-post hits and which column the BIR sales / purchase journals put the amount in. */

// GET /api/accounting/tax-codes?kind=&active=
router.get('/tax-codes', (req, res) => {
  const where: string[] = [];
  const params: unknown[] = [];
  if (typeof req.query.kind === 'string') { where.push('t.kind = ?'); params.push(req.query.kind); }
  if (req.query.active === '1') where.push('t.active = 1');
  res.json(queryAll<TaxCode>(`
    SELECT t.*, a.name AS account_name FROM tax_codes t
    LEFT JOIN accounts a ON a.id = t.account_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY t.kind, t.code`, ...params));
});

router.post('/tax-codes', requirePermission('accounting.manage'), (req, res) => {
  const b = parseBody(taxCodeSchema, req.body);
  if (queryOne('SELECT id FROM tax_codes WHERE code = ?', b.code)) {
    res.status(409).json({ error: `Tax code ${b.code} already exists.` }); return;
  }
  const info = run(
    `INSERT INTO tax_codes (code, name, kind, rate, account_id, atc, active)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    b.code, b.name, b.kind, b.rate ?? 0, b.account_id ?? null, b.atc ?? null, b.active === false ? 0 : 1
  );
  res.status(201).json({ id: Number(info.lastInsertRowid) });
});

router.put('/tax-codes/:id', requirePermission('accounting.manage'), (req, res) => {
  const id = Number(req.params.id);
  const cur = queryOne<TaxCode>('SELECT * FROM tax_codes WHERE id = ?', id);
  if (!cur) { res.status(404).json({ error: 'Tax code not found' }); return; }
  const b = parseBody(taxCodeSchema, req.body);
  const dupe = queryOne<{ id: number }>('SELECT id FROM tax_codes WHERE code = ? AND id <> ?', b.code, id);
  if (dupe) { res.status(409).json({ error: `Tax code ${b.code} already exists.` }); return; }
  run(
    `UPDATE tax_codes SET code = ?, name = ?, kind = ?, rate = ?, account_id = ?, atc = ?, active = ? WHERE id = ?`,
    b.code, b.name, b.kind, b.rate ?? 0, b.account_id ?? null, b.atc ?? null,
    b.active === false ? 0 : 1, id
  );
  res.json({ ok: true });
});

router.delete('/tax-codes/:id', requirePermission('accounting.manage'), (req, res) => {
  const id = Number(req.params.id);
  const used = (queryOne<{ n: number }>(`
    SELECT (SELECT COUNT(*) FROM orders WHERE tax_code_id = ?)
         + (SELECT COUNT(*) FROM vendor_bills WHERE tax_code_id = ?)
         + (SELECT COUNT(*) FROM credit_notes WHERE tax_code_id = ?) AS n`, id, id, id)?.n ?? 0) > 0;
  if (used) { res.status(409).json({ error: 'This tax code is in use — deactivate it instead.' }); return; }
  const info = run('DELETE FROM tax_codes WHERE id = ?', id);
  if (!info.changes) { res.status(404).json({ error: 'Tax code not found' }); return; }
  res.json({ ok: true });
});

/* ---------------------------------------------------------------- BIR sales / purchase journals --- */

type VatColumns = { gross: number; vatable: number; exempt: number; zero_rated: number; vat: number };
function classify(
  taxKind: string | null, subtotal: number, taxAmount: number, total: number
): VatColumns & { unclassified: boolean } {
  const z = { gross: round2(total), vatable: 0, exempt: 0, zero_rated: 0, vat: 0, unclassified: false };
  if (taxKind === 'output_vat' || taxKind === 'input_vat') {
    return { ...z, vatable: round2(subtotal), vat: round2(taxAmount) };
  }
  if (taxKind === 'exempt') return { ...z, exempt: round2(total) };
  if (taxKind === 'zero_rated') return { ...z, zero_rated: round2(total) };
  // no / non-VAT code: infer from the tax amount
  if (round2(taxAmount) > 0) return { ...z, vatable: round2(subtotal), vat: round2(taxAmount), unclassified: true };
  return { ...z, exempt: round2(total), unclassified: true };
}
function sumCols(rows: { cols: VatColumns }[]): VatColumns {
  const t: VatColumns = { gross: 0, vatable: 0, exempt: 0, zero_rated: 0, vat: 0 };
  for (const r of rows) for (const k of Object.keys(t) as (keyof VatColumns)[]) t[k] = round2(t[k] + r.cols[k]);
  return t;
}

/* Per-line tax codes (mixed-rate documents). When any line of a sale / bill carries its
   own tax_code_id, classify the document line-by-line — a line's own code + rate decides
   its column — instead of forcing one treatment on the whole document. Lines without a
   code fall back to the document-level classification for their slice. Documents with no
   line codes at all take the original document-level path unchanged. */
interface LineTax { line_total: number; kind: string | null; rate: number }

function classifyLines(
  docKind: string | null, subtotal: number, taxAmount: number, total: number,
  lines: LineTax[] | undefined
): VatColumns & { unclassified: boolean } {
  if (!lines || !lines.some((l) => l.kind)) return classify(docKind, subtotal, taxAmount, total);
  const effRate = subtotal > 0 ? taxAmount / subtotal : 0;
  const z = { gross: 0, vatable: 0, exempt: 0, zero_rated: 0, vat: 0, unclassified: false };
  for (const l of lines) {
    const amt = round2(l.line_total || 0);
    if (l.kind === 'output_vat' || l.kind === 'input_vat') {
      const v = round2(amt * ((l.rate || 0) / 100));
      z.vatable = round2(z.vatable + amt); z.vat = round2(z.vat + v); z.gross = round2(z.gross + amt + v);
    } else if (l.kind === 'exempt') {
      z.exempt = round2(z.exempt + amt); z.gross = round2(z.gross + amt);
    } else if (l.kind === 'zero_rated') {
      z.zero_rated = round2(z.zero_rated + amt); z.gross = round2(z.gross + amt);
    } else {
      const sub = classify(docKind, amt, round2(amt * effRate), round2(amt * (1 + effRate)));
      z.vatable = round2(z.vatable + sub.vatable); z.exempt = round2(z.exempt + sub.exempt);
      z.zero_rated = round2(z.zero_rated + sub.zero_rated); z.vat = round2(z.vat + sub.vat);
      z.gross = round2(z.gross + sub.gross);
      z.unclassified = z.unclassified || sub.unclassified;
    }
  }
  return z;
}

/** line_total + tax-code kind/rate per parent document id, for [from, to]. */
function orderLinesByTax(from: string, to: string): Map<number, LineTax[]> {
  const m = new Map<number, LineTax[]>();
  for (const l of queryAll<{ doc_id: number; line_total: number; kind: string | null; rate: number }>(`
    SELECT oi.order_id AS doc_id, oi.line_total AS line_total, tc.kind AS kind, COALESCE(tc.rate, 0) AS rate
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    LEFT JOIN tax_codes tc ON tc.id = oi.tax_code_id
    WHERE ${CONFIRMED_SALE_SQL} AND o.order_date >= ? AND o.order_date <= ?`, from, to)) {
    (m.get(l.doc_id) ?? m.set(l.doc_id, []).get(l.doc_id)!).push({ line_total: l.line_total, kind: l.kind, rate: l.rate });
  }
  return m;
}
function billLinesByTax(from: string, to: string): Map<number, LineTax[]> {
  const m = new Map<number, LineTax[]>();
  for (const l of queryAll<{ doc_id: number; line_total: number; kind: string | null; rate: number }>(`
    SELECT vbi.bill_id AS doc_id, vbi.line_total AS line_total, tc.kind AS kind, COALESCE(tc.rate, 0) AS rate
    FROM vendor_bill_items vbi
    JOIN vendor_bills b ON b.id = vbi.bill_id
    LEFT JOIN tax_codes tc ON tc.id = vbi.tax_code_id
    WHERE b.status = 'approved' AND COALESCE(b.bill_date, substr(b.created_at,1,10)) >= ? AND COALESCE(b.bill_date, substr(b.created_at,1,10)) <= ?`, from, to)) {
    (m.get(l.doc_id) ?? m.set(l.doc_id, []).get(l.doc_id)!).push({ line_total: l.line_total, kind: l.kind, rate: l.rate });
  }
  return m;
}

interface JournalSrc {
  date: string | null; ref: string; name: string | null; tin?: string | null;
  subtotal: number; tax_amount: number; total: number; tax_kind: string | null;
}
function journalRow(r: JournalSrc, doc: string, sign: 1 | -1, lines?: LineTax[]) {
  const c = classifyLines(r.tax_kind, r.subtotal, r.tax_amount, r.total, lines);
  const cols: VatColumns = sign === 1 ? c : {
    gross: -c.gross, vatable: -c.vatable, exempt: -c.exempt, zero_rated: -c.zero_rated, vat: -c.vat,
  };
  return {
    date: r.date, ref: r.ref, name: r.name, tin: r.tin ?? null,
    doc, unclassified: c.unclassified, cols,
  };
}

/** BIR Sales Book rows + column totals for [from, to] — confirmed sales less customer
 *  credit notes, each classified into vatable / exempt / zero-rated + output VAT. */
function salesJournalData(from: string, to: string) {
  const sales = queryAll<{
    id: number; date: string | null; ref: string; name: string | null; tin: string | null;
    subtotal: number; tax_amount: number; total: number; tax_kind: string | null;
  }>(`
    SELECT o.id, o.order_date AS date, o.number AS ref, COALESCE(c.name, o.customer_name) AS name, c.tin AS tin,
           o.subtotal, o.tax_amount, o.total, tc.kind AS tax_kind
    FROM orders o
    LEFT JOIN customers c ON c.id = o.customer_id
    LEFT JOIN tax_codes tc ON tc.id = o.tax_code_id
    WHERE ${CONFIRMED_SALE_SQL} AND o.order_date >= ? AND o.order_date <= ?`, from, to);

  const notes = queryAll<{
    date: string; ref: string; name: string | null; tin: string | null;
    subtotal: number; tax_amount: number; total: number; tax_kind: string | null;
  }>(`
    SELECT n.note_date AS date, n.number AS ref, COALESCE(c.name, n.party_name) AS name, c.tin AS tin,
           n.subtotal, n.tax_amount, n.total, tc.kind AS tax_kind
    FROM credit_notes n
    LEFT JOIN customers c ON c.id = n.party_id
    LEFT JOIN tax_codes tc ON tc.id = n.tax_code_id
    WHERE n.kind = 'customer' AND n.status = 'issued' AND n.note_date >= ? AND n.note_date <= ?`, from, to);

  const linesByDoc = orderLinesByTax(from, to);
  const rows = [
    ...sales.map((r) => journalRow(r, 'sale', 1, linesByDoc.get(r.id))),
    ...notes.map((r) => journalRow(r, 'credit_note', -1)),
  ].sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.ref.localeCompare(b.ref));
  return { rows, totals: sumCols(rows) };
}

/** BIR Purchase Book rows + column totals for [from, to] — approved bills less supplier
 *  debit notes, each classified + input VAT. */
function purchaseJournalData(from: string, to: string) {
  const bills = queryAll<{
    id: number; date: string | null; ref: string; name: string | null;
    subtotal: number; tax_amount: number; total: number; tax_kind: string | null;
  }>(`
    SELECT b.id, COALESCE(b.bill_date, b.created_at) AS date, b.number AS ref, s.name AS name,
           b.subtotal, b.tax_amount, b.total, tc.kind AS tax_kind
    FROM vendor_bills b
    LEFT JOIN suppliers s ON s.id = b.supplier_id
    LEFT JOIN tax_codes tc ON tc.id = b.tax_code_id
    WHERE b.status = 'approved' AND COALESCE(b.bill_date, b.created_at) >= ? AND COALESCE(b.bill_date, b.created_at) <= ?`, from, to);

  const notes = queryAll<{
    date: string; ref: string; name: string | null;
    subtotal: number; tax_amount: number; total: number; tax_kind: string | null;
  }>(`
    SELECT n.note_date AS date, n.number AS ref, COALESCE(s.name, n.party_name) AS name,
           n.subtotal, n.tax_amount, n.total, tc.kind AS tax_kind
    FROM credit_notes n
    LEFT JOIN suppliers s ON s.id = n.party_id
    LEFT JOIN tax_codes tc ON tc.id = n.tax_code_id
    WHERE n.kind = 'supplier' AND n.status = 'issued' AND n.note_date >= ? AND n.note_date <= ?`, from, to);

  const linesByDoc = billLinesByTax(from, to);
  const rows = [
    ...bills.map((r) => journalRow(r, 'bill', 1, linesByDoc.get(r.id))),
    ...notes.map((r) => journalRow(r, 'debit_note', -1)),
  ].sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.ref.localeCompare(b.ref));
  return { rows, totals: sumCols(rows) };
}

function monthRange(month: string): [string, string] {
  // Date.UTC so the month's last day isn't shifted back one by a positive-offset tz.
  return [month + '-01', new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10)];
}

// GET /api/accounting/sales-journal?from=&to= — BIR Sales Book columns per sale + credit note.
router.get('/sales-journal', (req, res) => {
  if (!requireLedger(res)) return;
  const to = typeof req.query.to === 'string' ? req.query.to : new Date().toISOString().slice(0, 10);
  const from = typeof req.query.from === 'string' ? req.query.from : to.slice(0, 8) + '01';
  res.json({ from, to, ...salesJournalData(from, to) });
});

// GET /api/accounting/purchase-journal?from=&to= — BIR Purchase Book columns per bill + debit note.
router.get('/purchase-journal', (req, res) => {
  if (!requireLedger(res)) return;
  const to = typeof req.query.to === 'string' ? req.query.to : new Date().toISOString().slice(0, 10);
  const from = typeof req.query.from === 'string' ? req.query.from : to.slice(0, 8) + '01';
  res.json({ from, to, ...purchaseJournalData(from, to) });
});

/* ---------------------------------------------------------- expanded withholding (EWT) --- */
/* A vendor bill can withhold a % of its net and remit it to BIR (creditable withholding).
   These endpoints turn the withheld amounts into the register + BIR 2307 / 0619-E feed. */

interface EwtRow {
  date: string | null; ref: string; supplier_id: number | null; supplier: string | null;
  tin: string | null; atc: string | null; base: number; rate: number; tax: number;
}
function ewtRegisterRows(from: string, to: string, supplierId?: number): EwtRow[] {
  const params: unknown[] = [from, to];
  let sql = `
    SELECT COALESCE(b.bill_date, substr(b.created_at,1,10)) AS date, b.number AS ref,
           b.supplier_id, s.name AS supplier, s.tin AS tin, b.ewt_atc AS atc,
           b.subtotal AS base, b.ewt_rate AS rate, b.ewt_amount AS tax
    FROM vendor_bills b LEFT JOIN suppliers s ON s.id = b.supplier_id
    WHERE b.status = 'approved' AND b.ewt_amount > 0
      AND COALESCE(b.bill_date, substr(b.created_at,1,10)) >= ? AND COALESCE(b.bill_date, substr(b.created_at,1,10)) <= ?`;
  if (supplierId) { sql += ' AND b.supplier_id = ?'; params.push(supplierId); }
  sql += ' ORDER BY date, b.id';
  return queryAll<EwtRow>(sql, ...params).map((r) => ({ ...r, base: round2(r.base), tax: round2(r.tax) }));
}

// GET /api/accounting/ewt-register?from=&to=&supplier_id= — the creditable-withholding register.
router.get('/ewt-register', (req, res) => {
  const to = typeof req.query.to === 'string' ? req.query.to : new Date().toISOString().slice(0, 10);
  const from = typeof req.query.from === 'string' ? req.query.from : to.slice(0, 8) + '01';
  const supplierId = req.query.supplier_id ? Number(req.query.supplier_id) : undefined;
  const rows = ewtRegisterRows(from, to, supplierId);

  const byAtc = new Map<string, { atc: string; base: number; tax: number; count: number }>();
  for (const r of rows) {
    const k = r.atc || '(none)';
    const g = byAtc.get(k) || { atc: k, base: 0, tax: 0, count: 0 };
    g.base = round2(g.base + r.base); g.tax = round2(g.tax + r.tax); g.count += 1;
    byAtc.set(k, g);
  }
  res.json({
    from, to, rows,
    by_atc: [...byAtc.values()].sort((a, b) => b.tax - a.tax),
    total_base: round2(rows.reduce((s, r) => s + r.base, 0)),
    total_tax: round2(rows.reduce((s, r) => s + r.tax, 0)),
  });
});

// GET /api/accounting/bir-2307?supplier_id=&from=&to= — Certificate of Creditable Tax
// Withheld at Source, one per payee for the period (typically a quarter).
router.get('/bir-2307', (req, res) => {
  const supplierId = Number(req.query.supplier_id);
  if (!supplierId) { res.status(400).json({ error: 'supplier_id is required.' }); return; }
  const sup = queryOne<{ name: string; tin: string | null; address: string | null }>(
    'SELECT name, tin, address FROM suppliers WHERE id = ?', supplierId);
  if (!sup) { res.status(404).json({ error: 'Supplier not found.' }); return; }
  const to = typeof req.query.to === 'string' ? req.query.to : new Date().toISOString().slice(0, 10);
  const from = typeof req.query.from === 'string' ? req.query.from : to.slice(0, 8) + '01';
  const rows = ewtRegisterRows(from, to, supplierId);

  // One line per ATC × month (the 2307 breaks income payments down by month of the quarter).
  const byKey = new Map<string, { atc: string; month: string; base: number; tax: number }>();
  for (const r of rows) {
    const month = String(r.date || from).slice(0, 7);
    const k = `${r.atc || '(none)'}|${month}`;
    const g = byKey.get(k) || { atc: r.atc || '(none)', month, base: 0, tax: 0 };
    g.base = round2(g.base + r.base); g.tax = round2(g.tax + r.tax);
    byKey.set(k, g);
  }
  res.json({
    from, to, company: companyProfile(),
    payee: { name: sup.name, tin: sup.tin, address: sup.address },
    lines: [...byKey.values()].sort((a, b) => a.month.localeCompare(b.month) || a.atc.localeCompare(b.atc)),
    total_base: round2(rows.reduce((s, r) => s + r.base, 0)),
    total_tax: round2(rows.reduce((s, r) => s + r.tax, 0)),
    note: 'Give this to the supplier so they can claim the withheld amount as a tax credit.',
  });
});

/* ------------------------------------------------- quarterly / annual EWT: 1601-EQ + QAP --- */

/** One row per payee TIN × ATC over [from, to] — the QAP / 1604-E alphalist shape. */
function payeeAlphalist(from: string, to: string) {
  const rows = ewtRegisterRows(from, to);
  const byKey = new Map<string, {
    tin: string | null; name: string | null; atc: string; base: number; tax: number;
    rate: number; supplier_id: number | null;
  }>();
  for (const r of rows) {
    const k = `${r.supplier_id ?? 'x'}|${r.atc || '(none)'}`;
    const g = byKey.get(k) || {
      tin: r.tin, name: r.supplier, atc: r.atc || '(none)', base: 0, tax: 0, rate: r.rate,
      supplier_id: r.supplier_id,
    };
    g.base = round2(g.base + r.base); g.tax = round2(g.tax + r.tax);
    byKey.set(k, g);
  }
  return [...byKey.values()]
    .map((g) => ({ ...g, rate: g.base > 0 ? round2((g.tax / g.base) * 100) : g.rate }))
    .sort((a, b) => (a.name || '').localeCompare(b.name || '') || a.atc.localeCompare(b.atc));
}

// GET /api/accounting/bir-1601eq?quarter=YYYY-Qn — quarterly remittance return of EWT.
router.get('/bir-1601eq', (req, res) => {
  const { year, q, from, to, months } = quarterOf(req.query.quarter);
  const remitted = ((): number[] => {
    try {
      const p = JSON.parse(String(req.query.remitted ?? '[]'));
      return Array.isArray(p) ? p.map((n) => Number(n) || 0) : [0, 0, 0];
    } catch { return [0, 0, 0]; }
  })();
  const monthly = months.map((m, i) => {
    const rows = ewtRegisterRows(m + '-01', new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10));
    const base = round2(rows.reduce((s, r) => s + r.base, 0));
    const tax = round2(rows.reduce((s, r) => s + r.tax, 0));
    return { month: m, tax_base: base, tax_withheld: tax, remitted: round2(remitted[i] ?? 0), still_due: round2(tax - (remitted[i] ?? 0)) };
  });
  const alpha = payeeAlphalist(from, to);
  res.json({
    quarter: `${year}-Q${q}`, from, to, company: companyProfile(),
    monthly,
    total_tax_base: round2(monthly.reduce((s, m) => s + m.tax_base, 0)),
    total_tax_withheld: round2(monthly.reduce((s, m) => s + m.tax_withheld, 0)),
    total_remitted: round2(monthly.reduce((s, m) => s + m.remitted, 0)),
    still_due: round2(monthly.reduce((s, m) => s + m.still_due, 0)),
    payee_count: alpha.length,
    note: 'File 1601-EQ with the Quarterly Alphalist of Payees (QAP) attached. Deadline: last day of the month after the quarter.',
  });
});

const QAP_HEADERS = ['Payee TIN', 'Payee name', 'ATC', 'Nature of payment', 'Tax base', 'Rate %', 'Tax withheld'];
function qapCells(a: ReturnType<typeof payeeAlphalist>[number]): (string | number)[] {
  const ref = EWT_ATCS.find((x) => x.atc.split('/').includes(a.atc));
  return [a.tin ?? '', a.name ?? '', a.atc, ref?.description ?? '', a.base, a.rate, a.tax];
}

// GET /api/accounting/qap?quarter=YYYY-Qn&format=csv|dat — Quarterly Alphalist of Payees.
router.get('/qap', (req, res) => {
  const { year, q, from, to } = quarterOf(req.query.quarter);
  const rows = payeeAlphalist(from, to);
  const fmt = String(req.query.format ?? '');
  if (fmt === 'csv' || fmt === 'dat') {
    const sep = fmt === 'dat' ? '|' : ',';
    const body = (fmt === 'csv' ? QAP_HEADERS.join(',') + '\n' : '')
      + rows.map((r) => qapCells(r).map((c) => (fmt === 'csv' ? String(c).replace(/"/g, '""') : c)).join(sep)).join('\n');
    res.setHeader('Content-Type', fmt === 'csv' ? 'text/csv' : 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="QAP-${year}Q${q}.${fmt}"`);
    res.send(body);
    return;
  }
  res.json({
    quarter: `${year}-Q${q}`, from, to, company: companyProfile(),
    headers: QAP_HEADERS,
    rows: rows.map((r) => ({ tin: r.tin, name: r.name, atc: r.atc, base: r.base, rate: r.rate, tax: r.tax })),
    total_base: round2(rows.reduce((s, r) => s + r.base, 0)),
    total_tax: round2(rows.reduce((s, r) => s + r.tax, 0)),
  });
});

// GET /api/accounting/bir-1604e?year=&format=csv|dat — Annual Info Return of creditable
// income taxes withheld (expanded) + its alphalist of payees.
router.get('/bir-1604e', (req, res) => {
  const year = yearOf(req.query.year);
  const from = `${year}-01-01`, to = `${year}-12-31`;
  const rows = payeeAlphalist(from, to);
  const fmt = String(req.query.format ?? '');
  if (fmt === 'csv' || fmt === 'dat') {
    const sep = fmt === 'dat' ? '|' : ',';
    const body = (fmt === 'csv' ? QAP_HEADERS.join(',') + '\n' : '')
      + rows.map((r) => qapCells(r).map((c) => (fmt === 'csv' ? String(c).replace(/"/g, '""') : c)).join(sep)).join('\n');
    res.setHeader('Content-Type', fmt === 'csv' ? 'text/csv' : 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="1604E-alphalist-${year}.${fmt}"`);
    res.send(body);
    return;
  }
  res.json({
    year, company: companyProfile(),
    headers: QAP_HEADERS,
    rows: rows.map((r) => ({ tin: r.tin, name: r.name, atc: r.atc, base: r.base, rate: r.rate, tax: r.tax })),
    total_base: round2(rows.reduce((s, r) => s + r.base, 0)),
    total_tax: round2(rows.reduce((s, r) => s + r.tax, 0)),
    note: 'Deadline: 1 March of the following year. Attach the alphalist of payees.',
  });
});

/* -------------------------------------------------- Summary List of Sales / Purchases (SLSP) --- */

const SLSP_HEADERS = ['TIN', 'Name', 'Address', 'Gross', 'Exempt', 'Zero-rated', 'Taxable (net)', 'VAT'];
function slspRows(kind: 'sales' | 'purchases', from: string, to: string) {
  type Row = { party_id: number | null; tin: string | null; name: string | null; address: string | null } & VatColumns;
  const acc = new Map<string, Row>();
  const add = (key: string, seed: Omit<Row, keyof VatColumns>, c: VatColumns) => {
    let r = acc.get(key);
    if (!r) { r = { ...seed, gross: 0, vatable: 0, exempt: 0, zero_rated: 0, vat: 0 }; acc.set(key, r); }
    for (const k of ['gross', 'vatable', 'exempt', 'zero_rated', 'vat'] as (keyof VatColumns)[]) r[k] = round2(r[k] + c[k]);
  };

  if (kind === 'sales') {
    const linesByDoc = orderLinesByTax(from, to);
    for (const o of queryAll<{ id: number; subtotal: number; tax_amount: number; total: number; tax_kind: string | null;
      customer_id: number | null; name: string | null; tin: string | null; address: string | null }>(`
        SELECT o.id, o.subtotal, o.tax_amount, o.total, tc.kind AS tax_kind, o.customer_id,
               COALESCE(c.name, o.customer_name) AS name, c.tin AS tin, c.address AS address
        FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
        LEFT JOIN tax_codes tc ON tc.id = o.tax_code_id
        WHERE ${CONFIRMED_SALE_SQL} AND o.order_date >= ? AND o.order_date <= ?`, from, to)) {
      add(o.customer_id ? `c${o.customer_id}` : `n:${o.name}`,
        { party_id: o.customer_id, tin: o.tin, name: o.name, address: o.address },
        classifyLines(o.tax_kind, o.subtotal, o.tax_amount, o.total, linesByDoc.get(o.id)));
    }
    for (const n of queryAll<{ subtotal: number; tax_amount: number; total: number; tax_kind: string | null;
      party_id: number | null; name: string | null; tin: string | null; address: string | null }>(`
        SELECT n.subtotal, n.tax_amount, n.total, tc.kind AS tax_kind, n.party_id,
               COALESCE(c.name, n.party_name) AS name, c.tin AS tin, c.address AS address
        FROM credit_notes n LEFT JOIN customers c ON c.id = n.party_id
        LEFT JOIN tax_codes tc ON tc.id = n.tax_code_id
        WHERE n.kind = 'customer' AND n.status = 'issued' AND n.note_date >= ? AND n.note_date <= ?`, from, to)) {
      const c = classify(n.tax_kind, n.subtotal, n.tax_amount, n.total);
      add(n.party_id ? `c${n.party_id}` : `n:${n.name}`,
        { party_id: n.party_id, tin: n.tin, name: n.name, address: n.address },
        { gross: -c.gross, vatable: -c.vatable, exempt: -c.exempt, zero_rated: -c.zero_rated, vat: -c.vat });
    }
  } else {
    const linesByDoc = billLinesByTax(from, to);
    for (const b of queryAll<{ id: number; subtotal: number; tax_amount: number; total: number; tax_kind: string | null;
      supplier_id: number | null; name: string | null; tin: string | null; address: string | null }>(`
        SELECT b.id, b.subtotal, b.tax_amount, b.total, tc.kind AS tax_kind, b.supplier_id,
               s.name AS name, s.tin AS tin, s.address AS address
        FROM vendor_bills b LEFT JOIN suppliers s ON s.id = b.supplier_id
        LEFT JOIN tax_codes tc ON tc.id = b.tax_code_id
        WHERE b.status = 'approved' AND COALESCE(b.bill_date, substr(b.created_at,1,10)) >= ? AND COALESCE(b.bill_date, substr(b.created_at,1,10)) <= ?`, from, to)) {
      add(b.supplier_id ? `s${b.supplier_id}` : `n:${b.name}`,
        { party_id: b.supplier_id, tin: b.tin, name: b.name, address: b.address },
        classifyLines(b.tax_kind, b.subtotal, b.tax_amount, b.total, linesByDoc.get(b.id)));
    }
  }
  return [...acc.values()].sort((a, b) => (b.gross) - (a.gross));
}

// GET /api/accounting/slsp?quarter=YYYY-Qn&kind=sales|purchases&format=csv|dat
router.get('/slsp', (req, res) => {
  if (!requireLedger(res)) return;
  const kind = req.query.kind === 'purchases' ? 'purchases' : 'sales';
  const { year, q, from, to } = quarterOf(req.query.quarter);
  const rows = slspRows(kind, from, to);
  const fmt = String(req.query.format ?? '');
  const cells = (r: ReturnType<typeof slspRows>[number]) =>
    [r.tin ?? '', r.name ?? '', r.address ?? '', r.gross, r.exempt, r.zero_rated, r.vatable, r.vat];
  if (fmt === 'csv' || fmt === 'dat') {
    const sep = fmt === 'dat' ? '|' : ',';
    const body = (fmt === 'csv' ? SLSP_HEADERS.join(',') + '\n' : '')
      + rows.map((r) => cells(r).map((c) => (fmt === 'csv' ? `"${String(c).replace(/"/g, '""')}"` : c)).join(sep)).join('\n');
    res.setHeader('Content-Type', fmt === 'csv' ? 'text/csv' : 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="SL${kind === 'sales' ? 'S' : 'P'}-${year}Q${q}.${fmt}"`);
    res.send(body);
    return;
  }
  const tot = rows.reduce((t, r) => {
    for (const k of ['gross', 'vatable', 'exempt', 'zero_rated', 'vat'] as (keyof VatColumns)[]) t[k] = round2(t[k] + r[k]);
    return t;
  }, { gross: 0, vatable: 0, exempt: 0, zero_rated: 0, vat: 0 } as VatColumns);
  res.json({
    kind, quarter: `${year}-Q${q}`, from, to, company: companyProfile(),
    headers: SLSP_HEADERS,
    rows: rows.map((r) => ({ party_id: r.party_id, tin: r.tin, name: r.name, address: r.address, cols: { gross: r.gross, vatable: r.vatable, exempt: r.exempt, zero_rated: r.zero_rated, vat: r.vat } })),
    totals: tot,
  });
});

export default router;
