# Feature pipelines

Real end-to-end business processes, as ordered module stages. See
`docs/modules/catalog.md` for what each module owns. Written per the "Mapping
feature pipelines" section of `~/.claude/CLAUDE.md` — when placing a new feature,
find its pipeline and stage here before deciding where the code goes.

## Sales order fulfillment

**Trigger:** a sale order is created (`modules/inventory`, `orders.routes.ts`).

1. **Intake** (`inventory`) — order created in `open` status.
2. **Availability check** (`inventory`) — on approve, an ATP (available-to-promise)
   gate runs (`GET /orders/:id/availability`); short of stock returns 409 unless
   forced.
   - **Branch — shortfall:** `POST /orders/:id/produce-shortfall` raises a linked
     draft MO in `manufacturing` (BOM-checked first), or
     `POST /orders/:id/purchase-shortfall` raises draft POs in `purchasing`
     (one per supplier).
3. **Approved → Released** (`inventory`) — release scans unit QR codes and marks
   `job_order_units` `reserved` (`manufacturing` data, records only — no stock
   movement yet).
4. **Confirmed** (`inventory` → `manufacturing`) — `maybeFulfillSale` moves stock at
   confirm time, not release time.
5. **Delivery / fulfil** (`inventory`) — `POST /orders/:id/status` transitions
   delivery → fulfilled (mobile-triggered prompt supported).
6. **Posting** (`accounting`) — `accounting-autopost.ts` posts the sale to the
   ledger.

**Terminal states:** fulfilled (success); backordered (flagged via
`GET /orders?backorder=1`, surfaced on the analytics card) if a shortfall was never
resolved; cancelled at any pre-confirm stage.

## Purchase-to-pay

**Trigger:** a purchase order is created (`purchasing`), either manually or as a
draft raised by the sales-order shortfall flow above, or via
`POST /inventory/reorder-po` (low-stock reorder).

1. **PO created** (`purchasing`) — draft or open.
2. **Goods receipt** (`purchasing`) — a GRN records what physically arrived;
   *this is the real "received" checkpoint* and posts stock into `inventory`.
3. **3-way match** (`purchasing`) — a vendor bill is only postable once it's
   matched against the PO and its receipt(s); mismatches block the bill.
4. **Posting** (`accounting`) — the matched bill posts to AP / the ledger.

Mobile's "Receive PR" quick-action bypasses steps 2-3 (records receipt without the
match) — a known, deliberate shortcut for warehouse speed, not a bug.

**Terminal states:** bill posted (success); PO cancelled before receipt.

## Production / manufacturing run

**Trigger:** a job order is created (`manufacturing`) — manually, or as a draft
raised by the sales-order shortfall flow.

1. **Job order opened** (`manufacturing`) — BOM resolved (`bom-explode.ts`,
   `bom-resolvers.ts`); products with no BOM are allowed (standard labor/overhead
   costing instead of component explosion).
2. **Scheduling** (`manufacturing`) — assigned to a team/schedule slot.
3. **Products in / receiving** (`manufacturing`) — mirrors the Goods Receipt
   pattern: an explicit screen for components physically arriving at the floor,
   consuming `inventory` stock.
4. **Recording / batches** (`manufacturing`) — production_batches track batch-level
   output; unit-level QR dossiers for serialized items.
5. **QC** (`manufacturing`) — disposition per unit or batch; a `fail` disposition
   can raise a repair/rework job or a parts request back to the warehouse
   (`inventory`).
6. **Finished goods** (`manufacturing` → `inventory`) — completed output posts into
   stock.
7. **Posting** (`accounting`) — job-order costs (labor/overhead/materials) post via
   `accounting-autopost.ts`.

**Terminal states:** completed (stock posted); cancelled (job-order cancel cleanup
releases any reserved components back to available stock).

## Payroll run

**Trigger:** a payroll period/cutoff is closed (`hr`, `hr.routes.ts`).

1. **Attendance reconciliation** (`hr`) — punches/kiosk data reconciled into
   `attendance_records` (lunch bracket, offsets, corrections all applied before
   this point).
2. **Computation** (`payroll`) — `hr-payroll-compute.ts` applies pay-per-hour-basis
   rules, OT cap, night differential, statutory deduction tables
   (`payroll-tables.ts`, `ph-statutory.ts`).
3. **Payslip** (`hr`) — generated per employee; Other Deductions itemized.
4. **Ledger posting** (`accounting`) — `hr.routes.ts` calls
   `accounting-autopost.ts`'s `maybeAutoPostPayroll`.
5. **Statutory filing** (`accounting`, under Tax & Compliance) — `payroll`'s
   `ph-2316.ts`/`ph-alphalist.ts`/`ph-contributions.ts`/`ph-vat-ewt.ts` compute the
   filings (2316, 1601-C/1604-C, Alphalist, 0619-E, 2550M, SSS/PhilHealth/Pag-IBIG
   schedules); 13th-month and final-pay stay under `hr`/`payroll`, not filed as
   compliance forms.

**Terminal states:** posted + filed (a period, once posted, is not recomputed in
place — corrections go through a new adjustment, not a rewrite of history).
