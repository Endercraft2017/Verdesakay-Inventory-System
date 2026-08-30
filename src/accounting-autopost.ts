/**
 * Auto-posting hooks — ACCOUNTING-SYSTEM-PLAN.md Phase 1.
 *
 * The DB-facing wrapper around `src/accounting-posting.ts`. Fires *after* the existing
 * document actions (a sale order confirmed, a vendor bill approved) — same best-effort
 * pattern as `maybeAutoPush` for QuickBooks: never throws, never blocks the response,
 * logs on failure. A posted document can be *unposted*, which writes a reversing entry
 * (the original posted rows are never deleted — CAS rule).
 */
import { db, queryOne, queryAll, run, getSetting, setSetting, nextSequence } from './db';
import {
  buildSalesEntry, buildPurchaseEntry, POSTING_RULE_KEYS,
  type PostingRules, type PostableDoc, type BuiltEntry,
} from './accounting-posting';
import { round2 } from './ledger';
import type { Order, VendorBill } from './types';

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
    ['purchase_expense_account_id', '5100'],
  ];
  let touched = false;
  for (const [key, code] of wants) {
    if (!cur[key] && byCode.has(code)) { cur[key] = byCode.get(code)!; touched = true; }
  }
  if (touched) setSetting(RULES_KEY, cur);
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

function autoPost(
  sourceType: 'sale_order' | 'vendor_bill',
  sourceId: number,
  doc: PostableDoc,
  userId: number | null
): AutoPostOutcome {
  if (!ledgerEnabled()) return { posted: false, skipped: 'ledger_off' };
  if (postedEntryForSource(sourceType, sourceId)) return { posted: false, skipped: 'already_posted' };
  if (round2(doc.total || 0) <= 0) return { posted: false, skipped: 'nothing_to_post' };
  const closed = periodClosedOn(doc.date);
  if (closed) return { posted: false, skipped: 'period_closed' };

  const built = sourceType === 'sale_order'
    ? buildSalesEntry(doc, getPostingRules(), sourceId)
    : buildPurchaseEntry(doc, getPostingRules(), sourceId);
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
      party_id: null, memo: o.customer_name ?? null,
    }, userId);
  } catch (e) {
    console.warn(`[gl] auto-post sale ${orderId} failed: ${(e as Error).message}`);
    return { posted: false, error: (e as Error).message };
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
      subtotal: b.subtotal, tax_amount: b.tax_amount, total: b.total,
      party_id: b.supplier_id ?? null, memo: b.vendor_ref ?? null,
    }, userId);
  } catch (e) {
    console.warn(`[gl] auto-post bill ${billId} failed: ${(e as Error).message}`);
    return { posted: false, error: (e as Error).message };
  }
}
