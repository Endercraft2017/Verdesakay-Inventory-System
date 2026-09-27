/**
 * Auto-posting hooks — ACCOUNTING-SYSTEM-PLAN.md Phase 1.
 *
 * The DB-facing wrapper around `src/accounting-posting.ts`. Fires *after* the existing
 * document actions (a sale order confirmed, a vendor bill approved) — same best-effort
 * pattern as `maybeAutoPush` for QuickBooks: never throws, never blocks the response,
 * logs on failure. A posted document can be *unposted*, which writes a reversing entry
 * (the original posted rows are never deleted — CAS rule).
 */
import { db, queryOne, queryAll, run, getSetting, setSetting, nextSequence } from '../../shared/db';
import {
  buildSalesEntry, buildPurchaseEntry, buildPaymentEntry, buildCreditNoteEntry, buildPayrollEntry,
  buildJobOrderEntry, buildReceiptEntry, buildCogsEntry, POSTING_RULE_KEYS,
  type PostingRules, type PostableDoc, type BuiltEntry, type PayrollDoc,
} from './accounting-posting';
import { round2 } from './ledger';
import { applyStockChange, getDefaultLocationId } from '../inventory/inventory-stock';
import type { Order, VendorBill, Payment, CreditNote } from '../../shared/types';

const RULES_KEY = 'accounting_posting_rules';

export function ledgerEnabled(): boolean {
  return !!(getSetting<{ enabled?: boolean }>('accounting_ledger') || {}).enabled;
}

export function getPostingRules(): PostingRules {
  return { ...(getSetting<PostingRules>(RULES_KEY) || {}) };
}

export function setPostingRules(patch: Partial<PostingRules>): PostingRules {
  const next: PostingRules = { ...getPostingRules() };
  for (const k of POSTING_RULE_KEYS) {
    if (k in patch) next[k] = patch[k] == null ? null : Number(patch[k]);
  }
  setSetting(RULES_KEY, next);
  return next;
}

/** Fill any blank rule from the seeded chart of accounts (matched by the default codes). */
export function seedPostingRulesFromCoa(): PostingRules {
  const cur = getPostingRules();
  const byCode = new Map<string, number>();
  for (const a of queryAll<{ id: number; code: string }>('SELECT id, code FROM accounts')) {
    byCode.set(a.code, a.id);
  }
  const wants: [keyof PostingRules, string][] = [
    ['ar_account_id', '1140'],
    ['input_vat_account_id', '1160'],
    ['ap_account_id', '2110'],
    ['output_vat_account_id', '2120'],
    ['sales_income_account_id', '4100'],
    ['sales_returns_account_id', '4400'],
    ['purchase_expense_account_id', '5100'],
    ['ewt_payable_account_id', '2140'],
    ['withholding_tax_payable_account_id', '2130'],
    ['sss_payable_account_id', '2150'],
    ['philhealth_payable_account_id', '2160'],
    ['pagibig_payable_account_id', '2170'],
    ['net_pay_payable_account_id', '2185'],
    ['payroll_expense_account_id', '6100'],
    ['payroll_er_contrib_account_id', '6110'],
    ['employee_advance_account_id', '1190'],
    ['inventory_asset_account_id', '1150'],
    ['wip_account_id', '1152'],
    ['mfg_variance_account_id', '5150'],
    ['grir_clearing_account_id', '2105'],
    ['cogs_account_id', '5100'],
  ];
  let touched = false;
  for (const [key, code] of wants) {
    if (!cur[key] && byCode.has(code)) { cur[key] = byCode.get(code)!; touched = true; }
  }
  if (touched) setSetting(RULES_KEY, cur);

  // Link the seeded VAT tax codes to their GL accounts so a document tagged VAT / VAT-IN
  // posts to the right account without the user wiring anything.
  const outVat = byCode.get('2120'), inVat = byCode.get('1160');
  if (outVat) run("UPDATE tax_codes SET account_id = ? WHERE code = 'VAT' AND account_id IS NULL", outVat);
  if (inVat) run("UPDATE tax_codes SET account_id = ? WHERE code = 'VAT-IN' AND account_id IS NULL", inVat);

  return cur;
}

/** The live (non-reversed) posted entry for a document, if any. */
export function postedEntryForSource(
  sourceType: string, sourceId: number
): { id: number; number: string; status: string } | undefined {
  return queryOne<{ id: number; number: string; status: string }>(
    `SELECT je.id, je.number, je.status FROM journal_entries je
     WHERE je.source_type = ? AND je.source_id = ? AND je.status = 'posted'
       AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_id = je.id)
     ORDER BY je.id DESC LIMIT 1`,
    sourceType, sourceId
  );
}

function periodClosedOn(date: string): { name: string } | undefined {
  return queryOne<{ name: string }>(
    "SELECT name FROM accounting_periods WHERE status = 'closed' AND ? BETWEEN start_date AND end_date",
    date
  );
}

/** Insert a balanced BuiltEntry straight as a posted journal entry. Assumes the caller
 *  has already checked the ledger is on and the document isn't posted yet. */
function writePosted(built: BuiltEntry, userId: number | null): { id: number; number: string } {
  db.exec('BEGIN');
  try {
    const number = nextSequence('je_number', 'JV', 6);
    const info = run(
      `INSERT INTO journal_entries
         (number, book, entry_date, memo, reference, status, source_type, source_id,
          posted_by, posted_at, created_by)
       VALUES (?, ?, ?, ?, ?, 'posted', ?, ?, ?, datetime('now'), ?)`,
      number, built.book, built.entry_date, built.memo, built.reference,
      built.source_type, built.source_id, userId, userId
    );
    const entryId = Number(info.lastInsertRowid);
    built.lines.forEach((l, i) => run(
      `INSERT INTO journal_lines (entry_id, account_id, debit, credit, party_type, party_id, memo, sort)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      entryId, l.account_id, round2(Number(l.debit) || 0), round2(Number(l.credit) || 0),
      l.party_type ?? null, l.party_id ?? null, l.memo ?? null, i
    ));
    db.exec('COMMIT');
    return { id: entryId, number };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export interface AutoPostOutcome {
  posted: boolean;
  skipped?: 'ledger_off' | 'already_posted' | 'period_closed' | 'nothing_to_post';
  error?: string;
  entry?: { id: number; number: string };
}

/** If the document carries a tax code that names its own VAT account, use it in place of
 *  the default posting-rule VAT account (exempt / zero-rated / EWT codes change nothing). */
function rulesForTaxCode(taxCodeId: number | null | undefined, base: PostingRules): PostingRules {
  if (!taxCodeId) return base;
  const tc = queryOne<{ kind: string; account_id: number | null }>(
    'SELECT kind, account_id FROM tax_codes WHERE id = ?', taxCodeId);
  if (!tc || !tc.account_id) return base;
  if (tc.kind === 'output_vat') return { ...base, output_vat_account_id: tc.account_id };
  if (tc.kind === 'input_vat') return { ...base, input_vat_account_id: tc.account_id };
  return base;
}

function autoPost(
  sourceType: 'sale_order' | 'vendor_bill',
  sourceId: number,
  doc: PostableDoc,
  userId: number | null,
  rules: PostingRules = getPostingRules()
): AutoPostOutcome {
  if (!ledgerEnabled()) return { posted: false, skipped: 'ledger_off' };
  if (postedEntryForSource(sourceType, sourceId)) return { posted: false, skipped: 'already_posted' };
  if (round2(doc.total || 0) <= 0) return { posted: false, skipped: 'nothing_to_post' };
  const closed = periodClosedOn(doc.date);
  if (closed) return { posted: false, skipped: 'period_closed' };

  const built = sourceType === 'sale_order'
    ? buildSalesEntry(doc, rules, sourceId)
    : buildPurchaseEntry(doc, rules, sourceId);
  if (!built.ok) return { posted: false, error: built.error };

  try {
    const entry = writePosted(built.entry, userId);
    return { posted: true, entry };
  } catch (e) {
    return { posted: false, error: (e as Error).message };
  }
}

/** Reverse the live posted entry for a document (used when a confirmed sale is
 *  re-opened / cancelled, or on an explicit "unpost"). Best-effort. */
export function unpostSource(sourceType: string, sourceId: number, userId: number | null): AutoPostOutcome {
  try {
    return unpostSourceInner(sourceType, sourceId, userId);
  } catch (e) {
    console.warn(`[gl] unpost ${sourceType} ${sourceId} failed: ${(e as Error).message}`);
    return { posted: false, error: (e as Error).message };
  }
}

function unpostSourceInner(sourceType: string, sourceId: number, userId: number | null): AutoPostOutcome {
  const live = postedEntryForSource(sourceType, sourceId);
  if (!live) return { posted: false, skipped: 'already_posted' };
  const orig = queryOne<{ id: number; book: string; reference: string | null; memo: string | null; entry_date: string }>(
    'SELECT id, book, reference, memo, entry_date FROM journal_entries WHERE id = ?', live.id
  );
  if (!orig) return { posted: false, skipped: 'already_posted' };
  if (periodClosedOn(orig.entry_date)) return { posted: false, skipped: 'period_closed' };
  const lines = queryAll<{ account_id: number; debit: number; credit: number; party_type: string | null; party_id: number | null; memo: string | null }>(
    'SELECT account_id, debit, credit, party_type, party_id, memo FROM journal_lines WHERE entry_id = ? ORDER BY sort, id', live.id
  );
  db.exec('BEGIN');
  try {
    const number = nextSequence('je_number', 'JV', 6);
    const info = run(
      `INSERT INTO journal_entries
         (number, book, entry_date, memo, reference, status, reverses_id, source_type, source_id,
          posted_by, posted_at, created_by)
       VALUES (?, ?, ?, ?, ?, 'posted', ?, ?, ?, ?, datetime('now'), ?)`,
      number, orig.book, new Date().toISOString().slice(0, 10),
      `Reversal of ${live.number}${orig.memo ? ' — ' + orig.memo : ''}`, orig.reference ?? null,
      orig.id, sourceType, sourceId, userId, userId
    );
    const revId = Number(info.lastInsertRowid);
    lines.forEach((l, i) => run(
      `INSERT INTO journal_lines (entry_id, account_id, debit, credit, party_type, party_id, memo, sort)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      revId, l.account_id, round2(l.credit), round2(l.debit), l.party_type, l.party_id, l.memo, i
    ));
    db.exec('COMMIT');
    return { posted: false, entry: { id: revId, number } };
  } catch (e) {
    db.exec('ROLLBACK');
    return { posted: false, error: (e as Error).message };
  }
}

/* --------------------------------------------------------------------- the hooks --- */

const CONFIRMED_SALE = new Set(['confirmed', 'completed', 'fulfilled', 'invoiced', 'paid']);

/** Called after a sale order is created / edited. Posts a confirmed sale to the sales
 *  journal; reverses a prior posting if the order is pulled back to open / cancelled. */
export function maybeAutoPostSale(orderId: number, userId: number | null): AutoPostOutcome {
  try {
    if (!ledgerEnabled()) return { posted: false, skipped: 'ledger_off' };
    const o = queryOne<Order>('SELECT * FROM orders WHERE id = ?', orderId);
    if (!o || o.type !== 'sale') return { posted: false, skipped: 'nothing_to_post' };
    const firm = CONFIRMED_SALE.has(String(o.status || '').toLowerCase());
    if (!firm) return unpostSource('sale_order', orderId, userId);
    return autoPost('sale_order', orderId, {
      number: o.number,
      date: o.order_date || o.created_at?.slice(0, 10) || new Date().toISOString().slice(0, 10),
      subtotal: o.subtotal, tax_amount: o.tax_amount, total: o.total,
      party_id: o.customer_id ?? null, memo: o.customer_name ?? null,
    }, userId, rulesForTaxCode(o.tax_code_id, getPostingRules()));
  } catch (e) {
    console.warn(`[gl] auto-post sale ${orderId} failed: ${(e as Error).message}`);
    return { posted: false, error: (e as Error).message };
  }
}

/** Outstanding Goods Received Not Invoiced for a purchase order: Σ its receipts' GRNI
 *  credits − Σ its bills' GRNI debits, from posted GL lines. Drives how much of the next
 *  vendor bill clears GRNI instead of hitting purchase expense. 0 when the ledger is off,
 *  the rule is unset, or nothing was posted. */
export function grirOpenForOrder(orderId: number): number {
  const acct = getPostingRules().grir_clearing_account_id;
  if (!acct || !orderId) return 0;
  const r = queryOne<{ bal: number }>(
    `SELECT COALESCE(SUM(jl.credit) - SUM(jl.debit), 0) AS bal
     FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
     WHERE je.status = 'posted' AND jl.account_id = ?
       AND ( (je.source_type = 'goods_receipt' AND je.source_id IN (SELECT id FROM goods_receipts WHERE order_id = ?))
          OR (je.source_type = 'vendor_bill'   AND je.source_id IN (SELECT id FROM vendor_bills   WHERE order_id = ?)) )`,
    acct, orderId, orderId
  );
  return round2(Math.max(0, r?.bal ?? 0));
}

/** Called after a goods receipt is posted. Recognises the stock: DR Inventory / CR Goods
 *  Received Not Invoiced, at the purchase-order line price. `unpostSource('goods_receipt', …)`
 *  on delete. Best-effort. */
export function maybeAutoPostGoodsReceipt(
  receiptId: number, number: string, date: string, amount: number, userId: number | null
): AutoPostOutcome {
  try {
    if (!ledgerEnabled()) return { posted: false, skipped: 'ledger_off' };
    if (postedEntryForSource('goods_receipt', receiptId)) return { posted: false, skipped: 'already_posted' };
    if (round2(amount) <= 0) return { posted: false, skipped: 'nothing_to_post' };
    if (periodClosedOn(date)) return { posted: false, skipped: 'period_closed' };
    const built = buildReceiptEntry({ number, date, amount }, getPostingRules(), receiptId);
    if (!built.ok) return { posted: false, error: built.error };
    const entry = writePosted(built.entry, userId);
    return { posted: true, entry };
  } catch (e) {
    console.warn(`[gl] auto-post goods receipt ${receiptId} failed: ${(e as Error).message}`);
    return { posted: false, error: (e as Error).message };
  }
}

/* ----------------------------------------------- sale fulfilment (perpetual inventory) --- */

interface FulfilLine { item_id: number | null; quantity: number; cost: number }

function saleLines(orderId: number): FulfilLine[] {
  return queryAll<FulfilLine>(
    `SELECT oi.item_id, oi.quantity, COALESCE(i.unit_cost, 0) AS cost
     FROM order_items oi LEFT JOIN inventory_items i ON i.id = oi.item_id
     WHERE oi.order_id = ?`, orderId
  );
}

/** Move a firm sale's goods out of stock (and reverse the move when pulled back), keeping
 *  perpetual inventory + COGS in step. Acts while the general ledger is on (turning the GL on
 *  opts a tenant into perpetual inventory), and also — without COGS — for any sale whose goods
 *  left on a release slip, since that slip is the physical stock-out. `force` = 'release' runs the
 *  restore branch regardless of status (used just before a sale is deleted). Best-effort. */
export function maybeFulfillSale(orderId: number, userId: number | null, force?: 'release'): void {
  try {
    const o = queryOne<Order>('SELECT * FROM orders WHERE id = ?', orderId);
    if (!o || o.type !== 'sale') return;
    // Stock follows the sale when the ledger is on (perpetual inventory), or — ledger or not —
    // once a release slip recorded the goods physically leaving. COGS only posts with the ledger.
    const ledger = ledgerEnabled();
    if (!ledger && !queryOne('SELECT id FROM release_slips WHERE order_id = ?', orderId)) return;
    const wantFulfilled = force === 'release' ? false : CONFIRMED_SALE.has(String(o.status || '').toLowerCase());
    if (wantFulfilled === !!o.fulfilled_at) return;   // already in the right state

    const lines = saleLines(orderId).filter((l) => l.item_id != null && (l.quantity || 0) > 0);
    let loc: number;
    try { loc = o.location_id ?? getDefaultLocationId(); } catch { return; }  // no locations → skip
    const date = o.order_date || o.created_at?.slice(0, 10) || new Date().toISOString().slice(0, 10);
    const sign = wantFulfilled ? -1 : 1;
    const reason = wantFulfilled ? `Sold — ${o.number}` : `Sale reversed — ${o.number}`;

    db.exec('BEGIN');
    try {
      for (const l of lines) {
        applyStockChange({ itemId: l.item_id!, locationId: loc, change: sign * l.quantity, userId, reason });
        // Serialized units a warehouse releaser earmarked for this order follow the line:
        // `reserved` → `sold` as the goods leave, and back on a reversal. (No extra stock
        // move — the unit's quantity is already inside the line total handled above.)
        run(
          `UPDATE job_order_units SET status = ?, updated_at = datetime('now')
           WHERE order_id = ? AND product_item_id = ? AND status = ?`,
          wantFulfilled ? 'sold' : 'reserved',
          orderId,
          l.item_id,
          wantFulfilled ? 'reserved' : 'sold'
        );
      }
      run(`UPDATE orders SET fulfilled_at = ${wantFulfilled ? "datetime('now')" : 'NULL'} WHERE id = ?`, orderId);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }

    if (!ledger) return;
    if (wantFulfilled) {
      // `fulfilled_at` (just set above) is the idempotency guard — this block only runs on
      // the not-fulfilled → fulfilled transition, so post unconditionally. A stale reversal
      // from an earlier confirm/reopen cycle is left in place; the fresh entry stands beside
      // it and the pair nets to zero (CAS rule — nothing is edited or removed).
      const amount = round2(lines.reduce((s, l) => s + l.quantity * (l.cost || 0), 0));
      if (amount > 0 && !periodClosedOn(date)) {
        const built = buildCogsEntry({ number: o.number, date, amount }, getPostingRules(), orderId);
        if (built.ok) { try { writePosted(built.entry, userId); } catch (e) { console.warn(`[gl] COGS ${orderId}: ${(e as Error).message}`); } }
      }
    } else {
      unpostSource('sale_cogs', orderId, userId);
    }
  } catch (e) {
    console.warn(`[inv] fulfil sale ${orderId} failed: ${(e as Error).message}`);
  }
}

/** Called after a vendor bill is approved. Posts it to the purchase journal. */
export function maybeAutoPostVendorBill(billId: number, userId: number | null): AutoPostOutcome {
  try {
    if (!ledgerEnabled()) return { posted: false, skipped: 'ledger_off' };
    const b = queryOne<VendorBill>('SELECT * FROM vendor_bills WHERE id = ?', billId);
    if (!b || b.status !== 'approved') return { posted: false, skipped: 'nothing_to_post' };
    return autoPost('vendor_bill', billId, {
      number: b.number,
      date: b.bill_date || b.created_at?.slice(0, 10) || new Date().toISOString().slice(0, 10),
      subtotal: b.subtotal, tax_amount: b.tax_amount, total: b.total, ewt_amount: b.ewt_amount || 0,
      grir_amount: b.order_id ? grirOpenForOrder(b.order_id) : 0,
      party_id: b.supplier_id ?? null, memo: b.vendor_ref ?? null,
    }, userId, rulesForTaxCode(b.tax_code_id, getPostingRules()));
  } catch (e) {
    console.warn(`[gl] auto-post bill ${billId} failed: ${(e as Error).message}`);
    return { posted: false, error: (e as Error).message };
  }
}

/** Called after a payment is recorded. Posts it to the cash receipts / disbursements book. */
export function maybeAutoPostPayment(paymentId: number, userId: number | null): AutoPostOutcome {
  try {
    if (!ledgerEnabled()) return { posted: false, skipped: 'ledger_off' };
    const p = queryOne<Payment>('SELECT * FROM payments WHERE id = ?', paymentId);
    if (!p || p.status !== 'posted') return { posted: false, skipped: 'nothing_to_post' };
    if (postedEntryForSource('payment', paymentId)) return { posted: false, skipped: 'already_posted' };
    if (round2(p.amount || 0) <= 0) return { posted: false, skipped: 'nothing_to_post' };
    if (periodClosedOn(p.payment_date)) return { posted: false, skipped: 'period_closed' };
    if (!p.deposit_account_id) return { posted: false, error: 'No cash / bank account on the payment.' };

    const built = buildPaymentEntry({
      number: p.number, date: p.payment_date, direction: p.direction, amount: p.amount,
      deposit_account_id: p.deposit_account_id, party_type: p.party_type,
      party_id: p.party_id ?? null, memo: p.party_name ?? p.memo ?? null,
    }, getPostingRules(), paymentId);
    if (!built.ok) return { posted: false, error: built.error };
    const entry = writePosted(built.entry, userId);
    return { posted: true, entry };
  } catch (e) {
    console.warn(`[gl] auto-post payment ${paymentId} failed: ${(e as Error).message}`);
    return { posted: false, error: (e as Error).message };
  }
}

/** Called after a credit / debit note is issued. Posts the contra entry. */
export function maybeAutoPostCreditNote(noteId: number, userId: number | null): AutoPostOutcome {
  try {
    if (!ledgerEnabled()) return { posted: false, skipped: 'ledger_off' };
    const n = queryOne<CreditNote>('SELECT * FROM credit_notes WHERE id = ?', noteId);
    if (!n || n.status !== 'issued') return { posted: false, skipped: 'nothing_to_post' };
    if (postedEntryForSource('credit_note', noteId)) return { posted: false, skipped: 'already_posted' };
    if (round2(n.total || 0) <= 0) return { posted: false, skipped: 'nothing_to_post' };
    if (periodClosedOn(n.note_date)) return { posted: false, skipped: 'period_closed' };

    const built = buildCreditNoteEntry({
      number: n.number, date: n.note_date, kind: n.kind,
      subtotal: n.subtotal, tax_amount: n.tax_amount, total: n.total,
      party_id: n.party_id ?? null, memo: n.party_name ?? n.reason ?? null,
    }, rulesForTaxCode(n.tax_code_id, getPostingRules()), noteId);
    if (!built.ok) return { posted: false, error: built.error };
    const entry = writePosted(built.entry, userId);
    return { posted: true, entry };
  } catch (e) {
    console.warn(`[gl] auto-post credit note ${noteId} failed: ${(e as Error).message}`);
    return { posted: false, error: (e as Error).message };
  }
}

/* ------------------------------------------------------ manufacturing / job orders --- */

/** The current WIP debit balance a job order still carries in the GL (Σ its posted
 *  DR WIP − CR WIP). Drives the `settle` true-up at close. 0 when the ledger is off or
 *  nothing was posted for this job order. */
export function jobOrderWipBalance(joId: number): number {
  const wip = getPostingRules().wip_account_id;
  if (!wip) return 0;
  const r = queryOne<{ bal: number }>(
    `SELECT COALESCE(SUM(jl.debit) - SUM(jl.credit), 0) AS bal
     FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
     WHERE je.status = 'posted' AND je.source_type = 'job_order' AND je.source_id = ? AND jl.account_id = ?`,
    joId, wip
  );
  return round2(r?.bal ?? 0);
}

/** Post one job-order cost movement (release / produce / settle) straight as a posted
 *  entry. Unlike the sale / bill hooks a job order posts many entries under one source_id,
 *  so this never checks `postedEntryForSource`. Best-effort — never throws. */
export function postJobOrderMovement(
  joId: number, joNumber: string, date: string,
  kind: 'release' | 'produce' | 'settle',
  amount: number, userId: number | null, returnAmount = 0
): AutoPostOutcome {
  try {
    if (!ledgerEnabled()) return { posted: false, skipped: 'ledger_off' };
    if (periodClosedOn(date)) return { posted: false, skipped: 'period_closed' };
    if (kind === 'settle' ? Math.abs(round2(amount)) < 0.005 : round2(amount) <= 0) {
      return { posted: false, skipped: 'nothing_to_post' };
    }
    const built = buildJobOrderEntry(
      { number: joNumber, date, kind, amount, return_amount: returnAmount }, getPostingRules(), joId
    );
    if (!built.ok) return { posted: false, error: built.error };
    const entry = writePosted(built.entry, userId);
    return { posted: true, entry };
  } catch (e) {
    console.warn(`[gl] job order ${joId} ${kind} post failed: ${(e as Error).message}`);
    return { posted: false, error: (e as Error).message };
  }
}

/** Called from the explicit "Post to GL" action (not fired automatically on every
 *  generate-payslips call — see the payroll gap-fix plan for why: unlike a sale or bill,
 *  a cutoff's payslips are commonly regenerated several times before payroll is final, and
 *  the other maybeAutoPost* hooks silently no-op once a source is already posted, which
 *  would leave the payroll journal stale). If a live posted entry already exists for this
 *  period, it's reversed first so a re-post always reflects the current numbers. */
export function maybeAutoPostPayroll(periodId: number, payrollPeriod: string, userId: number | null): AutoPostOutcome {
  try {
    if (!ledgerEnabled()) return { posted: false, skipped: 'ledger_off' };
    const form = queryOne<{ id: number }>("SELECT id FROM form_definitions WHERE slug = 'hr_payroll'");
    if (!form) return { posted: false, skipped: 'nothing_to_post' };
    const records = queryAll<{ data: string }>(
      'SELECT data FROM form_records WHERE form_def_id = ? AND period = ?', form.id, payrollPeriod
    ).map((r) => { try { return JSON.parse(r.data) as Record<string, unknown>; } catch { return {}; } });
    if (!records.length) return { posted: false, skipped: 'nothing_to_post' };

    const num = (v: unknown): number => Number(v) || 0;
    const sum = (fn: (d: Record<string, unknown>) => number) => round2(records.reduce((s, d) => s + fn(d), 0));
    const er = (d: Record<string, unknown>) => (d.employer_contributions ?? {}) as Record<string, unknown>;

    const doc: PayrollDoc = {
      number: payrollPeriod,
      date: (records.find((d) => d.pay_date)?.pay_date as string) || new Date().toISOString().slice(0, 10),
      gross_total: sum((d) => num(d.total_earnings)),
      late_total: sum((d) => num(d.late_absences)),
      er_contrib_total: sum((d) => num(er(d).sss_er) + num(er(d).sss_ec) + num(er(d).philhealth_er) + num(er(d).pagibig_er)),
      sss_payable_total: sum((d) => num(d.sss) + num(er(d).sss_er) + num(er(d).sss_ec)),
      philhealth_payable_total: sum((d) => num(d.philhealth) + num(er(d).philhealth_er)),
      pagibig_payable_total: sum((d) => num(d.pagibig) + num(er(d).pagibig_er)),
      withholding_tax_total: sum((d) => num(d.withholding_tax)),
      net_pay_total: sum((d) => num(d.net_pay)),
      cash_advance_total: sum((d) => num(d.cash_advance)),
    };
    if (round2(doc.gross_total - doc.late_total) <= 0) return { posted: false, skipped: 'nothing_to_post' };
    if (periodClosedOn(doc.date)) return { posted: false, skipped: 'period_closed' };

    if (postedEntryForSource('payroll_run', periodId)) unpostSource('payroll_run', periodId, userId);

    const built = buildPayrollEntry(doc, getPostingRules(), periodId);
    if (!built.ok) return { posted: false, error: built.error };
    const entry = writePosted(built.entry, userId);
    return { posted: true, entry };
  } catch (e) {
    console.warn(`[gl] auto-post payroll period ${periodId} failed: ${(e as Error).message}`);
    return { posted: false, error: (e as Error).message };
  }
}
