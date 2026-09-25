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
3. **Approved → Released** (`inventory`) — done by the releasing person
   (`releasing`/`warehouse`/`admin`/`admin_staff` roles via `inventory.adjust`, or the
   narrow `releasing_clerk` role via `orders.release` — mobile-only account scoped to
   just this action, not general stock adjustment; `POST /:id/release` /
   `/:id/release/unreserve` accept either). Release scans unit QR codes and marks
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

1. **Job order opened** (`manufacturing`) — `draft`; BOM resolved (`bom-explode.ts`,
   `bom-resolvers.ts`); products with no BOM are allowed (standard labor/overhead
   costing instead of component explosion). Optionally assigned to a team/schedule
   slot (Scheduling) before release — supporting, not a gating stage.
2. **Parts released** (`manufacturing`) — `POST /:id/release`; BOM components are
   deducted from the source location's `inventory` stock (GL: Raw Materials → WIP)
   and the job order moves to `released`. Done by the warehouse (`inventory.adjust`);
   stamps `released_by`/`released_at`.
   - **Parts kit accepted** (`manufacturing`) — the production lead (`production_lead`
     role / `production.record`, or `inventory.adjust`) counts the kit against the
     Components list and signs for it: `POST /:id/accept` stamps `accepted_by` /
     `accepted_at` / `accept_notes` (SCHEMA_VERSION 45). No status change and no stock
     movement — it's the handover record. **Gate:** `/progress` and `/units` 409
     (`needs_acceptance: true`) until it's done (`needsAcceptance()`); job orders that
     already had output recorded before this step existed are exempt. **Branch — kit
     short/damaged:** the lead doesn't accept and reports it (mobile Report a problem);
     the warehouse/supervisor fixes the release (cancel returns unused components).
3. **Actual production / recording** (`manufacturing`) — done by the line lead
   (`production_lead` role, or any account holding `production.record`). How a unit
   is recorded depends on whether the job order is QC-gated (`qc_stages > 0`,
   serialized) or not: non-serialized output still goes through `POST /:id/progress`
   ("Record production") as a bulk `production_batches` quantity; a serialized job
   order's units are each added individually via `POST /:id/units`, with their
   identifier (motor/serial no.) required at creation and a photo required right
   after via `POST /attachments` (`kind: 'qc_unit'`) — `/progress`'s bulk `done_delta`
   refuses to run on a serialized job order for this reason. Either path consumes
   components by BOM ratio and moves the job order to `in_progress`.
4. **Inspection — QC then QA** (`manufacturing`) — done by two distinct inspector
   roles, not one shared one: `qc_inspector` (`production.inspect_qc`) does the
   first pass (performance/technical check), `qa_inspector` (`production.inspect_qa`)
   does the final pass (appearance check). Per-unit or batch-level, up to
   `job_orders.qc_stages` passes. A single-stage job order runs both checklists
   together in one combined pass, which either role's permission covers; a
   multi-stage one is strictly enforced per pass — `POST /:id/units/inspect` checks
   which stage(s) the submitted units are actually on and 403s a `qc_inspector`
   account trying to record a final/QA pass (and vice versa for `qa_inspector` on a
   first/QC pass), on top of the door-level `inspectDoorGate` that just confirms the
   caller holds *some* inspect permission. A `fail` disposition can raise a
   repair/rework job or a parts request back to the warehouse (`inventory`) — either
   inspect permission covers raising that request (`POST
   /production/units/:unitId/repairs`), since it's the inspector who discovers the
   unit needs a part, regardless of which pass they're on.
5. **Repair parts handoff** (`manufacturing` → `inventory`) — a side branch off
   stage 4: the warehouse parts clerk (`parts_clerk` role, or `production.repairs`)
   accepts or rejects the request (`POST /production/repairs/:id/accept|reject`);
   accepting is what actually issues the part from stock and (for a "replace") books
   the removed one into its damage twin. The unit can't be re-inspected while any of
   its requests are still `requested`.
6. **Products In / RTS recording** (`manufacturing` → `inventory`) — done by the
   receiving clerk (`receiving_clerk` role, or `production.receive`). Mirrors the
   Purchasing Goods Receipt pattern: passed units / signed-off batches post into
   stock at a chosen location, becoming sellable/reservable. Mobile's "Receive PR"-
   style shortcuts don't apply here; this step always runs. Mobile has its own full
   screen for it (`public/mobile/modules/manufacturing/receiving.js`, route
   `receiving`) — not a bypass, the same `GET /:id/receivable` + `POST
   /:id/products-in` desktop uses, plus a continuous QR-scan-to-receive mode and a
   unit dossier (`record.js`: photo, QR, printable label) reachable from either
   platform.
7. **Posting** (`accounting`) — job-order costs (labor/overhead/materials) post via
   `accounting-autopost.ts`.

**Roles**: stages 3/4/5/6 each also accept the broad `inventory.adjust` permission
(admin/`warehouse`/`admin_staff`/`releasing` keep working unchanged) — the narrow
`production_lead`/`qc_inspector`/`qa_inspector`/`parts_clerk`/`receiving_clerk` roles
exist so a mobile-only account can be scoped to exactly one stage (and, for the two
inspector roles, one specific pass within stage 4) instead of sharing full inventory
access (`src/shared/permissions.ts`, `requireAnyPermission([...])` in
`job-orders.routes.ts` / `production.routes.ts`). Job-order lifecycle actions
themselves (create, release, pause, cancel, close, schedule, component edits) stay
`inventory.adjust`-only — none of the five narrow roles can do those.

Which step a given unit or batch is currently at is a UI-computed label (no extra
stored field) — see `public/js/lib/production-steps.js`, surfaced on the Job
Orders list/detail, the QC/QA inspection queue, and Production Batches.

**Terminal states:** completed (stock posted); cancelled (job-order cancel cleanup
releases any reserved components back to available stock).

## Payroll run

**Trigger:** a payroll period/cutoff is closed (`hr`, `hr.routes.ts`).

0. **Punch capture** (`hr`, runs daily before any cutoff) — kiosk punches at an office PC
   (with the kiosk lock on — default when internet-facing — only PCs an HR manager approved;
   `kiosk-devices.ts`),
   or phone punches: the rotating kiosk QR, plus the phone's GPS inside an office radius
   when the location lock is on (`clock-geofence.ts`). Branches: no/imprecise location or
   outside every office radius → refused; employee marked "can time in outside the office"
   → may punch without the QR from anywhere (`source = remote`), location required and
   stored. Lands in `time_punches` with its location.
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
