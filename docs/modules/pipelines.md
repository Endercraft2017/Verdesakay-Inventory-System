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
3. **Warehouse acceptance** (`inventory`) — the approved SO waits in Inventory →
   Releasing → Release Queue ("waiting for warehouse acceptance") until a releaser
   accepts it (`POST /orders/:id/accept-release`, stamps `warehouse_accepted_by/_at`).
   Picking is refused until then. Re-opening / cancelling clears the acceptance.
   Done by `inventory.adjust` holders (`releasing`/`warehouse`/`admin`/`admin_staff`) or
   the narrow mobile `releasing_clerk` role via `orders.release`.
4. **Pick / release** (`inventory`) — `POST /:id/release` (desktop Release Queue or
   mobile `so` view): scan unit QR labels → `job_order_units` `reserved`
   (`manufacturing` data), or enter quantities for bulk lines (`released_qty`). Records
   only — no stock movement. Auto-advances approved → `released` once every line is
   covered; `/:id/release/unreserve` undoes a pick (refused once a slip exists).
5. **Release slip — goods out** (`inventory` → `accounting`) —
   `POST /:id/release-slip` once the order is `released`: records who collected it,
   vehicle, notes, and snapshots lines + unit serials into `release_slips` /
   `release_slip_items` (number `RS-00001`); photos of the outgoing goods attach as
   `attachments` kind `release` (UI requires ≥1). Issuing it sets the SO `confirmed`,
   which runs `maybeFulfillSale`: **stock is deducted here** and reserved units → `sold`.
   A slipped order moves stock even with the general ledger off (COGS only posts with
   the ledger on). One slip per order. Printable from Release Slips.
   - **Branch — manual confirm (legacy):** an SO confirmed from the order form without a
     slip still behaves as before (stock + COGS only when the ledger is on).
6. **Delivery / fulfil** (`inventory`) — `POST /orders/:id/status` transitions
   delivery → fulfilled (mobile-triggered prompt supported); the delivery's proof of
   delivery (signature/GPS/photos) is captured at the customer.
7. **Posting** (`accounting`) — `accounting-autopost.ts` posts the sale to the
   ledger.

**Terminal states:** fulfilled (success); backordered (flagged via
`GET /orders?backorder=1`, surfaced on the analytics card) if a shortfall was never
resolved; cancelled at any stage (cancelling a slipped order reverses the stock-out; the
slip stays on record and shows the order as cancelled).

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
   - **Approval** (`manufacturing`, SCHEMA_VERSION 49) — a `production.approve` holder
     signs off the draft: `POST /:id/approve` stamps `approved_by` / `approved_at` /
     `approve_notes` (no status change; `POST /:id/unapprove` withdraws it). **Gate:**
     `/release` 409s (`needs_approval: true`) until approved. Editing the draft
     (`PUT /:id`, `PUT /:id/components`) clears the approval. `inventory.adjust` does
     *not* grant it, so the warehouse can't approve its own release. Short stock doesn't
     block approval — the response lists `shortfalls` as a warning.
   - **Stock check** — `GET /:id/availability` returns each planned component's
     need / have / short at the source location plus `in_stock`, `approved`, `releasable`.
   - Queues: `GET /job-orders?stage=awaiting_approval` (manager); for the warehouse,
     `?stage=awaiting_release` (every approved draft), split into `awaiting_warehouse`
     → `preparing` → `ready_to_release`.
   - Editing the draft or withdrawing approval (`resetPreRelease()`) also clears the
     warehouse's acceptance and picks, so the job order goes through every step again.
2. **Parts released — warehouse** (`manufacturing` → `inventory`, SCHEMA_VERSION 50).
   Done by the warehouse (`inventory.adjust`), in three steps that mirror sale-order
   releasing:
   1. **Accept** — `POST /job-orders/warehouse-accept {job_order_ids}` (one or many)
      stamps `warehouse_accepted_by/_at`. Refused unless the job order is an approved draft.
   2. **Prepare (pick)** — `POST /job-orders/prepare {job_orders:[{id, lines?}]}` sets
      `job_order_components.qty_picked`; leaving out `lines` picks the whole kit. Several
      kits can be picked in one request. `GET /job-orders/pick-list?ids=…` returns one
      combined pick list (per component and location, with a per-job-order split), and
      `&format=html` returns a printable version. A fully picked kit gets
      `prepared_by/_at`; a partial pick is saved but stays in `preparing`. Picks are
      checked against on-hand stock minus what other unreleased kits already picked
      (`pickedElsewhere()`), so two kits can't claim the same parts. **Branch — short:**
      the pick returns 400 with `shortfalls`, and
      `POST /:id/purchase-shortfall` drafts POs for the missing parts. No stock moves at
      this step.
   3. **Release = parts release slip** — `POST /:id/release {received_by?, notes?}`
      needs approved + accepted + prepared. It issues the numbered slip `PRS-#####`
      (`parts_release_slips` / `_items` store a copy of the lines), deducts the components
      from the source location (GL: Raw Materials → WIP), and moves the job order to
      `released`. The slip is kept in the app (paperless): `GET /parts-slips`,
      `/parts-slips/:id`, `/parts-slips/:id/print` (printable HTML). Photos of the kit
      are attachments of kind `parts_release` on the slip.
   - **Mobile (warehouse, Figma 62:*)** — `#/kit-release` walks the same three server steps as
     one guided flow: queue (Ready / Blocked by availability / Released awaiting acceptance) →
     verify kit (`GET /:id/availability`) → confirm with a "picked and counted" acknowledgement
     (runs accept → prepare → release in order) → released handoff. **Branch — short stock:**
     a shortfall (from availability or `prepare`) shows Release blocked with nothing deducted;
     "Report shortage" files a tracked `production_issues` row (category `Parts shortage`),
     not a loose message. Online-only; Quick Orbit "Scan job order" opens it by JO number.
   - **Mobile (production, Figma 66:*)** — `#/job-orders`: the Production Lead board (To accept /
     Active / Paused) → Accept parts kit (count acknowledgement) → Active production → Record
     production (how many) → Unit details, saved **one unit at a time** (identifier + photo per
     `POST /:id/units`). **Branch — connection lost:** Connection interrupted lists what the
     server saved vs. what is still on the phone; retry sends only unsaved rows. **Branch — kit
     problem:** a tracked `production_issues` row (Warehouse + Manager see it; recording stays
     locked until the kit is accepted). Scrap asks for a reason, kept on each scrapped unit's
     remarks (`/progress {reason}`). A Production Manager lands on Production control
     (paused / overdue / open-issue exceptions) → Manager actions → pause/resume/close early,
     each with a reason, and the audit history (`GET /:id/events`).
   - **Parts kit accepted** (`manufacturing`) — the production lead (`production_lead`
     role / `production.record`, or `inventory.adjust`) counts the kit against the
     Components list and signs for it: `POST /:id/accept` stamps `accepted_by` /
     `accepted_at` / `accept_notes` (SCHEMA_VERSION 45). No status change and no stock
     movement — it's the handover record. **Gate:** `/progress` and `/units` 409
     (`needs_acceptance: true`) until it's done (`needsAcceptance()`); job orders that
     already had output recorded before this step existed are exempt. **Branch — kit
     short/damaged:** the lead doesn't accept and files a production issue (below);
     the warehouse/supervisor fixes the release (cancel returns unused components).
3. **Actual production / recording** (`manufacturing`) — done by the line lead
   (`production_lead` role, or any account holding `production.record`). How a unit
   is recorded depends on whether the job order is QC-gated (`qc_stages > 0`,
   serialized) or not: non-serialized output still goes through `POST /:id/progress`
   ("Record production") as a bulk `production_batches` quantity; a serialized job
   order's units are each added individually via `POST /:id/units`, a multipart request
   in which the identifier (motor/serial no.) **and** the photo (`image`, saved as
   `qc_unit` attachment) are both required and saved together. Since SCHEMA_VERSION 50 a
   unit can't exist, and so can't reach QC, without its photo; the request returns 400
   `needs_photo` if the photo is missing. `/progress`'s bulk `done_delta` refuses to run
   on a serialized job order for this reason. Either path consumes components by BOM
   ratio and moves the job order to `in_progress`.
   - **Pause / resume / close early** — `POST /:id/pause|resume|close {reason}`. Pause and
     resume: `inventory.adjust`, `production.pause` (a lead trusted to stop the line) or
     `production.manage` (Production Manager). Close early (returns unused components):
     `inventory.adjust` or `production.manage`. A reason is required unless the caller holds
     the broad `inventory.adjust` override (400 otherwise). `paused_by/_at` + `pause_reason`
     hold the current hold; every action is appended to `job_order_events` (actor, reason,
     time) — `GET /:id/events`. A manager still cannot release, cancel or delete.
   - **Issue reports** (`/api/production-issues`, `production-issues.routes.ts`) — anyone
     on the floor (`production.record`, `inspect_qc`/`inspect_qa`, `inventory.adjust`,
     `production.approve`) files an issue against the whole job order or one unit
     (category, severity, description, photos as `production_issue` attachments). The
     reporter can edit it while it's open, and a manager can too. The reporter or a manager
     resolves or re-opens it. Records only; nothing is blocked. `open_issues` is shown on the
     job order.
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
   - **Mobile (QC / QA, Figma 69:* / 72:*)** — `#/qc?role=qc|qa`, fed by `GET /api/qc/queue`:
     queue (Ready / Reinspect or Recheck / Completed today) → identify (scan or serial search;
     only units on the inspector's own pass open) → verify (QA also sees the QC record) →
     checklist steps (Pass / Issue / N/A, readings, remarks; N/A can't satisfy a required check;
     draft kept on the phone) → review → one disposition: **Pass** to QA or RTS (may queue
     offline, shown as queued, never as recorded); **Return for repair / rectification** —
     category, instruction, station, priority + a required photo (`qc_unit` attachment), online
     only; **Fail / reject** (scrap, dispose, recycle) with reason, photo and a review tick.
     QA's **Hold for QA Manager review** is recorded as a repair routed to "QA Manager review",
     so the unit stays out of RTS and returns on the Recheck list. A returned unit shows the
     original issue and failed items for reinspection; waiting parts requests block the start.
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

## Confidential (anonymous) report

**Trigger:** an employee chooses "Anonymous report" in the mobile Reporting hub
(`#/anonymous-report`).

1. **Draft** (mobile, device only) — category, optional title, details, date, location; kept
   in localStorage until sent. No attachments. Offline → nothing is sent or queued.
2. **Ticket** (`core/confidential-reports`) — signed-in `POST /ticket`; the row stores only a
   hash + expiry, the request isn't logged, so the ticket can't be traced to the employee.
3. **Submit** — `POST /api/anonymous-reports` with the ticket and no auth header; ticket
   consumed in the same transaction; returns `CR-#####` + a one-time access code (shown once).
   Handlers get a push with number + category only.
4. **Triage / investigate** (`reports.confidential`) — status new → triaged → investigating;
   replies are shown to the reporter as "Case handler".
5. **Reporter follow-up** — `POST /lookup` / `POST /followup` with number + code.

**Branches:** missing/expired/reused ticket → 403, nothing stored; wrong code → 404 (constant-time
compare); ticket cap reached → 429; follow-up on a closed report → 409.
**Terminal states:** resolved or closed (closed also blocks further reporter messages). A lost
access code can't be recovered — the reporter files a new report.

## Employee information change

**Trigger:** an employee opens Profile → Personal details on mobile.

**Branch A — direct edit (no approval):** preferred name and personal contact / emergency
details. `PUT /api/me/profile` with the current password → saved at once, one history row per
field → a contact change clears HR verification and pings `hr.manage` → HR confirms via
`POST /api/hr/employee-profiles/:id/verify`. Terminal: saved (verified or awaiting verification).

**Branch B — authoritative field (approval required):** legal name, SSS/PhilHealth/Pag-IBIG/TIN,
birth date, civil status, other official record.
1. **File** (`core/form-builder` → `hr/info-change`) — "Request an information change" opens the
   Request Center on `information_change`; the server validates, fixes the subject to the filer
   and snapshots the current value; status `pending`. The record is unchanged.
2. **Decide** (`core/me` approvals, `hr.manage` only) — approve applies the change to the
   employee record in the same transaction as the decision and logs it; reject changes nothing.
3. **Notify** — the filer gets a push; the Request Center shows the decision and note.

**Branches:** duplicate legal name → 409, stays pending; field not stored on the record →
approved with an "update by hand" note; the filer may cancel while pending; a second decision → 400.
**Terminal states:** approved (applied or noted for manual update), rejected, cancelled.

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
3. **Payslip** (`hr`) — generated per employee as a `draft`; Other Deductions itemized.
   Employees see drafts on mobile as previews that may still change (no download).
3a. **Finalize & release** (`hr` → `payroll` → `core/me`) — HR marks the payslip Paid (locks
   it). Only then does the employee's list carry `finalized` + `download_url`, and
   `GET /api/me/payslips/:id/pdf` render it (`payroll/payslip-pdf.ts`), re-checking ownership
   and Paid at download time and logging each download. Branch: HR un-marks Paid to correct
   it → download blocked again (409) until re-marked.
4. **Ledger posting** (`accounting`) — `hr.routes.ts` calls
   `accounting-autopost.ts`'s `maybeAutoPostPayroll`.
5. **Statutory filing** (`accounting`, under Tax & Compliance) — `payroll`'s
   `ph-2316.ts`/`ph-alphalist.ts`/`ph-contributions.ts`/`ph-vat-ewt.ts` compute the
   filings (2316, 1601-C/1604-C, Alphalist, 0619-E, 2550M, SSS/PhilHealth/Pag-IBIG
   schedules); 13th-month and final-pay stay under `hr`/`payroll`, not filed as
   compliance forms.

**Terminal states:** posted + filed (a period, once posted, is not recomputed in
place — corrections go through a new adjustment, not a rewrite of history).
