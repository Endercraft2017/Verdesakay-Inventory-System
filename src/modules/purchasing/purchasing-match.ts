/**
 * Three-way match (pure): Purchase Order ↔ Goods Receipts ↔ Vendor Bill.
 *
 * A vendor bill is safe to approve for payment when, for every line:
 *   - the cumulative billed quantity (this bill + already-approved bills) does not
 *     exceed what has actually been received, and
 *   - the billed unit price is within tolerance of the PO unit price.
 *
 * Everything is keyed by the PO line (`order_item_id`); a bill/receipt line with no
 * PO line falls back to a normalised name key so stray charges still surface.
 */

export interface MatchTolerance {
  /** Allowed unit-price drift as a percent of the PO price. */
  price_pct: number;
  /** Allowed unit-price drift as an absolute amount (whichever is larger wins). */
  price_abs: number;
  /** Allowed over-receipt / over-bill as a percent of the ordered/received qty. */
  qty_pct: number;
}

export const DEFAULT_TOLERANCE: MatchTolerance = { price_pct: 2, price_abs: 0, qty_pct: 0 };

export interface MatchInputLine {
  order_item_id?: number | null;
  name: string;
  quantity: number;
  unit_price?: number;
}

export interface MatchLine {
  key: string;
  order_item_id: number | null;
  name: string;
  ordered_qty: number;
  received_qty: number;
  prior_billed_qty: number;
  bill_qty: number;
  /** prior_billed_qty + bill_qty */
  billed_qty: number;
  po_unit_price: number | null;
  bill_unit_price: number | null;
  qty_ok: boolean;
  price_ok: boolean;
  on_po: boolean;
  issues: string[];
}

export interface MatchResult {
  ok: boolean;
  lines: MatchLine[];
  issues: string[];
  tolerance: MatchTolerance;
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');
const keyOf = (l: { order_item_id?: number | null; name: string }): string =>
  l.order_item_id != null ? `oi:${l.order_item_id}` : `nm:${norm(l.name)}`;

function sumByKey(lines: MatchInputLine[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of lines) m.set(keyOf(l), round2((m.get(keyOf(l)) ?? 0) + (Number(l.quantity) || 0)));
  return m;
}

export interface ThreeWayInput {
  poLines: MatchInputLine[];
  /** Every goods-receipt line for the PO (all receipts, flattened). */
  receiptLines: MatchInputLine[];
  /** The lines of the bill being matched. */
  billLines: MatchInputLine[];
  /** Lines of other already-approved bills for the same PO. */
  priorBillLines?: MatchInputLine[];
  tolerance?: MatchTolerance;
}

export function threeWayMatch(input: ThreeWayInput): MatchResult {
  const tol = input.tolerance ?? DEFAULT_TOLERANCE;
  const received = sumByKey(input.receiptLines);
  const priorBilled = sumByKey(input.priorBillLines ?? []);
  const billQty = sumByKey(input.billLines);

  const poByKey = new Map<string, MatchInputLine>();
  const poQty = new Map<string, number>();
  for (const l of input.poLines) {
    poByKey.set(keyOf(l), l);
    poQty.set(keyOf(l), round2((poQty.get(keyOf(l)) ?? 0) + (Number(l.quantity) || 0)));
  }
  // Bill price per key (last non-zero wins; bills rarely split a line).
  const billPrice = new Map<string, number>();
  for (const l of input.billLines) if (l.unit_price != null) billPrice.set(keyOf(l), Number(l.unit_price));

  const keys = new Set<string>([...billQty.keys(), ...poByKey.keys(), ...received.keys()]);
  const lines: MatchLine[] = [];
  const issues: string[] = [];

  for (const key of keys) {
    const po = poByKey.get(key);
    const name = po?.name ?? input.billLines.find((l) => keyOf(l) === key)?.name
      ?? input.receiptLines.find((l) => keyOf(l) === key)?.name ?? key;
    const ordered = poQty.get(key) ?? 0;
    const recv = received.get(key) ?? 0;
    const prior = priorBilled.get(key) ?? 0;
    const thisBill = billQty.get(key) ?? 0;
    const billedCum = round2(prior + thisBill);
    const poPrice = po?.unit_price ?? null;
    const bPrice = billPrice.has(key) ? (billPrice.get(key) as number) : null;

    const lineIssues: string[] = [];

    // Quantity: cumulative billed must not outrun received.
    const qtyAllowance = recv + Math.abs(recv) * (tol.qty_pct / 100);
    const qty_ok = thisBill === 0 || billedCum <= qtyAllowance + 1e-9;
    if (!qty_ok) {
      lineIssues.push(
        `Billed ${billedCum} but only ${recv} received` + (prior ? ` (${prior} already billed)` : '')
      );
    }

    // Price: billed unit price within tolerance of PO price.
    let price_ok = true;
    if (bPrice != null && poPrice != null) {
      const allow = Math.max(Math.abs(poPrice) * (tol.price_pct / 100), tol.price_abs);
      price_ok = Math.abs(bPrice - poPrice) <= allow + 1e-9;
      if (!price_ok) lineIssues.push(`Price ${bPrice} vs PO ${poPrice} (>${round2(allow)} off)`);
    }

    const on_po = poByKey.has(key);
    if (!on_po && thisBill > 0) lineIssues.push('Not on the purchase order');

    if (lineIssues.length) issues.push(`${name}: ${lineIssues.join('; ')}`);

    lines.push({
      key,
      order_item_id: po?.order_item_id ?? null,
      name,
      ordered_qty: ordered,
      received_qty: recv,
      prior_billed_qty: prior,
      bill_qty: thisBill,
      billed_qty: billedCum,
      po_unit_price: poPrice,
      bill_unit_price: bPrice,
      qty_ok,
      price_ok,
      on_po,
      issues: lineIssues,
    });
  }

  lines.sort((a, b) => a.name.localeCompare(b.name));
  return { ok: issues.length === 0, lines, issues, tolerance: tol };
}

/** Overall receiving progress for a PO, for the list/detail badges. */
export function receiptStatus(orderedByKey: Map<string, number>, receivedByKey: Map<string, number>):
  'none' | 'partial' | 'complete' | 'over' {
  let anyRecv = false;
  let allMet = true;
  let over = false;
  for (const [key, ordered] of orderedByKey) {
    const recv = receivedByKey.get(key) ?? 0;
    if (recv > 0) anyRecv = true;
    if (recv + 1e-9 < ordered) allMet = false;
    if (recv > ordered + 1e-9) over = true;
  }
  if (over) return 'over';
  if (!anyRecv) return 'none';
  return allMet ? 'complete' : 'partial';
}
