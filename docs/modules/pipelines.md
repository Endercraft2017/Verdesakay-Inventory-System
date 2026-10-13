# Feature pipelines

## Original company → registered tenant

1. **Preview** (`platform/adopt-default.ts`, CLI `scripts/adopt-default-tenant.ts`):
   validate source integrity, user/file counts, slug and unoccupied destinations.
2. **Quiesce** (operations): sync outstanding device work; stop every writer on the
   existing volume. `--apply --server-stopped` asserts this prerequisite.
3. **Preserve and verify** (`platform`): SQLite/WAL snapshot, platform snapshot,
   recursive upload backup/copy, file-hash and database-byte verification. Original
   DB/uploads remain untouched. Other tenants' upload folders are excluded.
4. **Register** (`platform`): catalog row and provisioning log in one transaction;
   preserve existing users/passwords/business records and default to unlimited entitlements.
5. **Cut over** (`app`, shared clients): configure path host and default redirect;
   serve `/<slug>` with normal tenant gates, scoped sessions/queues/PWA/chat; refuse
   old company APIs and skip the retired source in maintenance/backups/migrations.
6. **Validate** (operations): verify known records/uploads, existing login, new URL,
   devices and owner listing before resuming work.

Failure: refuse missing/corrupt sources, collisions, symlinks, changed files and
unstopped-writer assertions; retain originals and recovery artifacts for diagnosis.
Do not roll back to the original after new writes without reconciling them.
Runbook: `docs/VERDESAKAY-TENANT-CUTOVER.md`.

Real end-to-end business processes, as ordered module stages. See
`docs/modules/catalog.md` for what each module owns. Written per the "Mapping
feature pipelines" section of `~/.claude/CLAUDE.md` — when placing a new feature,
find its pipeline and stage here before deciding where the code goes.

## Sales order fulfillment

**Offline (phase 4c, docs/OFFLINE-FIRST.md §22):** the whole run, from intake to proof of delivery, works at a
site with the internet down. Decisions are made at the site of the order's stock location (else the main
site), and SO, RS and DEL numbers come from the site host's leased blocks. Release, the release slip (with
photos) and the proof of delivery are physical facts. An approval, release, slip or proof of delivery the
cloud would now refuse stands, flagged (D6). A slip's stock-out beyond stock is accepted and flagged (D1).

**Trigger:** a sale order is created (`modules/inventory`, `orders.routes.ts`).

1. **Intake** (`inventory`) — the desktop order editor (also responsive at phone
   widths) saves new sales in `open` status; approval is a subsequent action.
   Inventory links are explicit selections, while services/charges remain non-stock
   even when their name matches an inventory item. Positive quantities, valid dates,
   existing linked records, and one line per stock item are validated before saving.
   The editor identifies stock/non-stock lines, reports field errors without dropping
   unnamed lines, and visibly locks lines/tax after approval. New/edit/delete controls
   follow their respective permissions; view-only users can still inspect orders.
   The legacy direct-to-sale unit allocation shortcut is removed from intake; use the
   warehouse release stage for stock handoff.
   The API retains existing direct-to-firm creation behavior for integrations; normal
   intake UI does not offer it. Dedicated mobile warehouse screens begin at release;
   they do not create sales orders.
   **Audit hardening:** sales/job reads require `orders.view` (purchase access retains
   `purchasing.view`/`purchasing.manage`); partial edits preserve omitted
   fields and line IDs; explicit null resets an unpicked ship-from location. Browser
   saves carry a content revision and use authenticated, permission-checked retry
   keys. Stale interactive edits return 409 without replacing another person's changes.
   Already validated owning-site decisions retain D6 on cloud replay, with a clash recorded. Tax/currency
   lock with approved lines; ship-from locks once picking/fulfilment starts. Released
   status is assigned by warehouse picking, not manual intake/status edits.
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
   - **Release authorization** (Sales, before or during stages 3–5): who may receive the goods —
     pickup/delivery, recipient (ID masked to last 4), a time-limited token given to the
     recipient, handoff area, partial allowed. Issued/revoked from Sales Orders (key icon).
     Required for every order unless the company turns the `release_authorization_required`
     policy off (on by default); always enforced for an order that has one.
   - **Branch — authorization problem:** wrong / expired / used / revoked token → slip 409,
     zero stock change; the order shows as Blocked on the mobile queue until Sales reissues.
   - **Branch — token override:** the recipient can't present the token → the releaser asks a
     supervisor (push to `inventory.adjust`), who approves or declines with a reason (or a
     supervisor overrides directly). Approved: the slip goes without the token, once, and records
     who approved it and why. Declined: the token stays required. Never covers a missing,
     expired, used or revoked authorization.
   - **Branch — evidence:** a warehouse-out from the phone or desktop app without a handoff photo
     → 409 `blocked: 'evidence'`, zero stock change. Both apps upload the photos first.
   - **Branch — package:** every required package item of the products on the order must be
     confirmed on the slip, else 409 with the missing items, zero stock change.
   - **Branch — partial release:** an incomplete order releases only under an authorization
     that allows it; the order is split at the slip and the rest becomes a new approved
     backorder SO (back to stage 3). Without it: 409, nothing moves; the releaser requests it.
   - **Branch — release report:** the releaser flags a wrong unit, missing item, identity
     problem or partial request (`release_reports`); Sales is pushed and resolves it. Records only.
   - **Mobile (Releasing, Figma 78:*)** — `#/so`: authority → scan/verify units → package →
     handoff token (or supervisor override) → photo + signature proof → review → confirm
     warehouse-out (online-only, idempotent); photos upload first on the order and the slip takes
     them over; the signature attaches to the slip (`release`). Desktop Releasing can issue a
     partial slip under the same authority.
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

**Offline (phase 4d, docs/OFFLINE-FIRST.md §23):** the purchase order, the goods receipt at the
site's warehouse (stock in), bill entry and approval all work with the internet down. Receipts are
physical facts owned by the receiving location's site. Bills are decided at the main site. PR,
GRN and BILL numbers come from the site host's blocks. A receipt against a PO line the cloud
removed meanwhile, or an approval whose match fails only on the cloud, stands, flagged (D6).

**Trigger:** a purchase order is created (`purchasing`), either manually or as a
draft raised by the sales-order shortfall flow above, or via
`POST /inventory/reorder-po` (low-stock reorder).
**Permissions:** `purchasing.view` to see POs, receipts and bills; `purchasing.manage` to create /
change POs and raise / approve bills; receiving (step 2) needs `inventory.adjust`
(`inventory/order-access.ts`). Desktop menu: Inventory → Purchasing → Purchase Orders → Goods
Receipts → Vendor Bills.

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

**Offline (phase 4b, docs/OFFLINE-FIRST.md §21):** the whole run works at a site with the internet
down — floor events are `physical`, decisions are made at the job order's site (its source location,
else the main site), numbers come from the site host's leased blocks; a release short on stock is
accepted and flagged (D1); a pick or approval the cloud would now refuse stands, flagged (D6).

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
     A returned unit shows the original issue and failed items for reinspection; waiting parts
     requests block the start. A failing / held result from the phone or desktop needs an evidence photo of
     that unit (uploaded first, sent as `evidence_ids`), else 409 and nothing is recorded.
   - **Branch — QA hold for review** (final pass only): the unit goes to `hold` — out of RTS, and
     the job order can't complete. Every QA inspector and `production.qa_review` holder is
     pushed; one of them decides it on the Hold tab (or the desktop job order) with a reason:
     **pass** (on to stage 6), **rectify** (rework, back to the Recheck list) or **fail**
     (scrap / dispose / recycle). The inspector who held it hears the outcome.
5. **Repair parts handoff** (`manufacturing` → `inventory`) — a side branch off
   stage 4: the warehouse parts clerk (`parts_clerk` role, or `production.repairs`)
   accepts or rejects the request (`POST /production/repairs/:id/accept|reject`);
   accepting is what actually issues the part from stock and (for a "replace") books
   the removed one into its damage twin. The unit can't be re-inspected while any of
   its requests are still `requested`.
   - **Hold:** raising the request holds its quantity at the first approved source with enough
     free stock (`repair_part_holds`, `stock-holds.ts`), so kit picking, other requests and the
     sale-order gate can't take it; the hold moves with an approved revision and drops on issue,
     reject or cancel.
   - **Rules at issue:** only an approved storage source (not a truck); stock held for other
     requests or kits isn't free (409 `held`); the scanned label must
     be the requested SKU and the picked quantity exactly the requested one — else 409, no
     stock change.
   - **Branch — shortage:** no approved source holds enough → the request stays open and
     blocked and holds nothing (computed live); the clerk can escalate it
     (`repair_request_events`), which pushes the requester and the warehouse supervisors.
   - **Branch — revision:** another part or quantity needs a formal revision proposed by the
     clerk and approved by the requester or a supervisor (never the proposer); issue is
     refused while it is pending, and on approval the request takes the new part / quantity.
     The requester is pushed and decides on the phone (`#/repairs?id=&step=decide`).
   - **Notify:** the requester is pushed when the part is issued or rejected.
   - **Mobile (Parts clerk, Figma 83:*)** — `#/repairs`: review → context → source → pick →
     review issue → confirm (online-only, idempotent); reject, shortage, revision, history.
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
   - **Mobile (RTS clerk, Figma 74:*)** — `#/receiving`, fed by `GET /api/rts/queue` (units
     across job orders): identify → verify (final-pass record, SKU) → stock details (storage
     location) → optional group of same-SKU units → review → final duplicate check (`POST
     /api/rts/check`) → confirm with a physical-verification tick → `products-in`, one call per
     job order, online-only with an idempotency key. **Branch — duplicate:** a unit already in
     finished goods or a serial already in stock is refused (409, existing receipt shown), zero
     stock change; the clerk removes it from the group. **Branch — location:** a truck/transit or
     missing location, or one without room under its capacity (location_capacities), is refused
     (400); the clerk picks another storage location — the picker shows each location's room and
     greys out a full one. **Branch —
     mismatch:** a `Product-data mismatch` production issue holds the unit (Issues tab; posting
     409s) until QA / inventory control resolve it. Read-only finished-goods lookup by serial,
     SKU, receipt or location (`GET /api/rts/lookup`).
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
   in localStorage until sent. Up to 4 photos, each redrawn on the phone into a fresh JPEG
   (metadata + filename gone) and held in memory only (never in the draft). A PDF becomes one
   page photo per free slot (drawn on the phone; the PDF file is never sent; pages past the
   free slots are dropped with a notice). Offline → nothing is sent or queued.
2. **Ticket** (`core/confidential-reports`) — signed-in `POST /ticket`; the row stores only a
   hash + expiry, the request isn't logged, so the ticket can't be traced to the employee.
3. **Submit** — `POST /api/anonymous-reports` with the ticket and no auth header (multipart when
   photos are attached). Photos are metadata-stripped server-side (`shared/image-metadata.ts`)
   BEFORE the ticket is touched; then the ticket is consumed and report + photos stored in one
   transaction; returns `CR-#####` + a one-time access code (shown once). Handlers get a push
   with number + category (+ photo count) only.
4. **Triage / investigate** (`reports.confidential`) — status new → triaged → investigating;
   handlers view photos inline — opening the case marks its photos seen by a handler; replies
   are shown to the reporter as "Case handler".
5. **Reporter follow-up** — `POST /lookup` / `POST /followup` with number + code; a follow-up
   may carry photos (same stripping). The reporter sees their own photos (`POST /photo`, code in
   the body) and may remove one (`POST /photo/remove`) until a handler has seen it.

**Branches:** missing/expired/reused ticket → 403, nothing stored; a photo that isn't a
well-formed JPEG/PNG/WebP → 400, nothing stored, ticket still valid; >4 photos in a post or
>6 MB → 400; follow-up past 12 photos per report → 400; removing a photo a handler has already
seen, or on a closed report → 409; wrong code → 404 (constant-time compare); ticket cap reached
→ 429; follow-up on a closed report → 409.
**Terminal states:** resolved or closed (closed also blocks further reporter messages). A lost
access code can't be recovered — the reporter files a new report.
**Offline (phase 4f, docs/OFFLINE-FIRST.md §25):** steps 2–5 work at an installed PC, or a phone on the
site LAN, with no internet. The ticket and the access code never leave that PC. The report is held for a
random while, then sent with no identity and dated only. The reporter's provisional `CR-X…` number
stays a permanent alias of the real `CR-#####` the cloud gives it.

## Employee information change

**Offline (phase 4e, docs/OFFLINE-FIRST.md §24):** filing an information change, or any request, works
at a PC or a phone on the site LAN with no internet. HR's decision is made at the main site. A
request decided on the cloud meanwhile keeps the first outcome, flagged. Contact changes re-check
the password on the PC; it is never stored in the synced command.

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

**Branches:** duplicate legal name → 409, stays pending; invalid birth date (bad/impossible date,
under 15) or civil status outside the fixed list → 400 at filing; "Other official record" (not
stored on the record) → approved with an "update by hand" note; the filer may cancel while
pending; a second decision → 400.
**Terminal states:** approved (applied or noted for manual update), rejected, cancelled.

## Account session (sign in → use → sign out)

**Trigger:** someone signs in on the desktop (`/`) or mobile (`/m`) app — on their own device,
or with "I'm using someone else's phone" / "shared or borrowed computer" ticked.
0. **Connect (installed phone app only, docs/OFFLINE-FIRST.md §29)** — on first launch
   `public/mobile/native.js` asks for the server address (cloud or site host), checks it answers
   `GET /api/health`, and keeps it (`vds_api_base`); every later call goes there. Not reachable /
   not a Verdesakay server ⇒ stays on the Connect screen. The browser `/m` skips this step.
1. **Sign in** (`core/auth.routes` → `shared/auth.createSession`) — password check; the session
   records device ID (`X-Device-Id`, `shared/device.ts`), IP and user agent; the activity log
   gets a `login` row with the same device. Borrowed ⇒ `shared` session (4 h max, 30 min idle),
   token kept in sessionStorage. Mobile: if the phone's local data belongs to someone else
   (`vds_m_owner`), it is cleared before anything renders.
2. **Use** (`shared/auth.requireAuth`) — every request refreshes last-seen/last-IP (≤ 1/min);
   mutations are logged with IP + device; offline mobile writes queue under this account only
   (`lib/queue.js`). A phone punch is flagged if the phone is borrowed or usually someone
   else's (`hr/clock.ts`, `device_flag`).
3. **End** — one of: sign out (`POST /auth/logout`; mobile `MApp.signOut` first sends or warns
   about this person's queued actions and releases their push subscription on this device;
   borrowed ⇒ their local data is cleared), revoked from another of their devices
   (`/auth/sessions/...`) or by an admin (`/users/:id/sessions/...`), password change/reset
   (others end), account disabled, idle timeout (borrowed only), or expiry (12 h / 4 h).

**Branches:** borrowed vs own device (session length, push refused, data cleanup);
unsent queued actions at sign-out (send now if online, else confirm — they stay on the phone and
send only when that same person signs in there again); another account's queued actions on the
phone (listed as a count, never sent or discardable by the current person).
**Terminal states:** ended with `end_reason` logout / revoked / password / deactivated / idle /
expired; the row stays as sign-in history for 90 days (`cleanupSessions`), then is deleted.

## Account access (define role → create account → adjust one person)

**Trigger:** an administrator sets up who can do what, or HR onboards an employee.
1. **Define roles** (`core/roles.routes`, Admin → Accounts → Roles; `users.manage`) — a role is a
   named permission bundle in `roles`. Built-ins are seeded once; the workspace adds, edits,
   duplicates and deletes its own. Administrator is fixed (everything).
2. **Create the account with a role** (`POST /api/users`; Admin → Accounts, or HR's employee form)
   — the account gets the role's bundle, including the phone app (`mobile.access`) by default.
   HR without `users.manage` may only pick staff roles (`shared/permissions.isStaffRole`).
3. **Adjust one person** (`PUT /api/users/:id/permissions`, the Access drawer) — sparse overrides
   add or remove single permissions on top of the role; HR only for staff-role accounts and
   staff-level permissions.
4. **Enforce** (`shared/auth.requireAuth` → `shared/roles.userPermissions`) — each request
   resolves role bundle + overrides; routes check permissions, menus hide screens the account
   can't open (`nav-config.js`).

**Branches:** HR picks a management role or permission ⇒ 403; unknown role ⇒ 400; role edited ⇒
every holder's access changes on their next request; deleting a role still held ⇒ 409 (move the
accounts first).
**Terminal states:** account active with its effective permissions; role deleted (only when
unused); account disabled (`PUT /users/:id` active=false ends its sessions).

## Company asset issuance (issue → hold → return)

**Offline (phase 4e):** issuing and returning are `physical` (they work with no internet); deleting an
issuance is a `claim` at the main site.

**Trigger:** HR hands company property (laptop, tool, uniform, ID…) to an employee.
All stages are `modules/hr` (`hr.routes.ts`); every mutation lands in the Activity log with a
readable summary (`asset-issue`, `asset-returned|lost|damaged`, `asset-issuance-delete`).
1. **Issue** (`hr.manage`) — employee record → Assets issued → Issue asset →
   `POST /api/hr/employees/:id/assets` creates a numbered Asset Issuance Form (AI-00001) with one
   line per item, all `issued`; the signable form prints from the "Asset Issuance Form" template.
2. **Hold** — the item shows on the employee's record and in HR → Employees → Company Assets
   (`GET /api/hr/assets`, default "still out"). Resigned/terminated holders are flagged and
   counted ("Held by people who left") — the clearance worklist.
3. **Check in** (`hr.manage`) — per line, from either screen:
   `POST /api/hr/assets/:id/items/:itemId/return` with returned / lost / damaged.

**Branches:** lines on one form return independently; a check-in can be re-saved (the log keeps
the previous details); a form entered in error can be deleted (rows are erased, the log keeps a
snapshot). Not linked to Inventory stock — issuing moves no stock.
**Terminal states:** each line returned, lost or damaged; or the whole form deleted.
**Not built:** lost/damaged → salary deduction or final-pay charge is manual.

## Payroll run

**Trigger:** a payroll period/cutoff is closed (`hr`, `hr.routes.ts`).
**Permissions:** timekeeping (punches, cutoffs, daily records) is `hr.view` / `hr.manage`; every pay
step — rates, payroll rules, generate / post / mark paid / email payslips, 13th month, final pay —
is `payroll.view` / `payroll.manage` (`payroll/pay-access.ts`), so a timekeeping clerk can close
cutoffs without seeing pay.
**Terminal state "paid" is permanent:** every Mark Paid / Unmark Paid is logged to
`payslip_paid_history`, and a payslip with any entry there can't be deleted (only unmarked and
corrected), so the payroll record keeps every slip that was ever paid.

**Offline (phase 4g, docs/OFFLINE-FIRST.md §26):** the whole run, from cutoff to marked paid, works at the
main site with the internet down; payslip numbers come from the site host's blocks. Emailing payslips waits
for the internet (it uses the company's mail server, which only the cloud has).

0. **Punch capture** (`hr`, runs daily before any cutoff) — kiosk punches at an office PC
   (with the kiosk lock on — default when internet-facing — only PCs an HR manager approved;
   `kiosk-devices.ts`),
   or phone punches: the rotating kiosk QR, plus the phone's GPS inside an office radius
   when the location lock is on (`clock-geofence.ts`). Branches: no/imprecise location or
   outside every office radius → refused; employee marked "can time in outside the office"
   → may punch without the QR from anywhere (`source = remote`), location required and
   stored. Employee status `suspended` (or resigned/terminated) → every punch refused
   (`punchBlockedReason`). A phone punch: the employee picks the slot (Time in / Afternoon out /
   Afternoon in / Time out — the kiosk's four), then the scan passes those checks and is held at
   its own time (`punch-holds.ts`, 5-minute expiry); the auto-captured selfie then records that
   slot at the scan time with the photo kept beside it. Re-doing a slot replaces its time and
   photo (`setSlotPunch`). No selfie, or an expired scan → nothing recorded. Kiosk punches stay
   automatic (in/out decided by the day's punches). Lands in `time_punches` with its location. A phone punch from a
   borrowed-phone sign-in, or from a phone another account usually uses, is recorded with a
   `device_flag` for HR to review in the Punch Log — never refused (a forgotten phone is a real
   reason; see "Account session" above).
   - **Offline (phase 4a, docs/OFFLINE-FIRST.md §20):** punches, corrections and punch photos are
     `physical` — they work on an installed PC / its site host with the internet down and keep the
     minute they happened; the kiosk code is checked for that minute, a locked kiosk is re-checked
     on the cloud, a borrowed phone stays flagged, photos travel with the punch.
   - **Next-day time-out (2026-10-04):** yesterday has a time-in but no time-out, today has no
     punch yet, and the punch comes before the employee's time-in time today (today's shift
     start; no shift → yesterday's own time-in time) ⇒ it is **yesterday's time-out**
     (`clock.ts` `openShiftToClose`; e.g. a driver in at 08:00, out at 06:00 the next morning,
     or an overnight 22:00–06:00 shift). At/after that time ⇒ today's time-in, as before. The
     phone shows them still clocked in on yesterday's shift until then. Stage 2 reads a time-out
     earlier than the time-in as the next morning for any shift, so those hours count as worked
     (past the shift end = OT, paid only per the OT-form rule) instead of undertime.
1. **Attendance reconciliation** (`hr`) — punches/kiosk data reconciled into
   `attendance_records` (lunch bracket, offsets, corrections all applied before
   this point). HR links request forms per day on the Daily Time grid. Rest-day branch
   (`hr/rest-day.ts`): an approved **Change of Rest Day** moves the rest day (its original
   date → working day, its new date → rest day); a worked rest day earns its premium only with
   an approved **Rest Day Work Request** when Policy Settings requires it, otherwise it pays
   as an ordinary day. A pending rest-day form changes nothing until approved.
   Early OT branch (2026-10-04): on a day timed in 1 h+ before the shift start, the grid's
   "Make a new form → Overtime" offers an **Early OT** tick; ticked, stage 2 pays that early time
   as OT, sharing the day's OT cap with after-shift OT (early first). Not ticked / no form ⇒ the
   early time is unpaid presence (flagged as unrecorded OT).
2. **Computation** (`payroll`) — `hr-payroll-compute.ts` applies pay-per-hour-basis
   rules, OT cap, night differential, statutory deduction tables
   (`payroll-tables.ts`, `ph-statutory.ts`). Half-day branch: a linked Half Day request, HR's
   half-day mark, or (no form linked) a first time-in at/after lunch start (PM) or a departure
   at lunch (AM) credits 0.5 day, late judged against that half's start; the Daily Report
   (stage 0, live) uses the same rule, so it shows the same half days before the cutoff closes.
   Statutory branch (2026-10-05): SSS / Pag-IBIG are computed on the month's actual pay — the
   cutoffs ending in the month, read from the employee's earlier payslips — and the month's last
   deducting cutoff trues up what earlier cutoffs took; a fund scheduled only on an earlier cutoff
   uses the full-month rate (month not over yet). PhilHealth uses the fixed monthly basic rate.
   Always-whole-day branch (2026-10-05): an employee with "Always paid a whole day" gets a
   full day for any day with both a time-in and a time-out — no half day, late or undertime.
3. **Payslip** (`hr`) — generated per employee as a `draft`; Other Deductions itemized.
   Employees see drafts on mobile as previews that may still change (no download).
   HR reviews the cutoff on Forms → HR Payroll: **Print All** (slips), **Print Summary** (A4
   landscape register — totals, department subtotals, every payslip, Prepared/Checked/Approved
   lines; 2026-10-05) and **Download Excel** read the same totals (`public/js/hr-payroll-export.js`).
   Rate change branch (2026-10-05): HR → Employees → Edit → Pay → **Change rate** (new rate +
   effective date, today or backdated) logs the rate, then redoes stage 2–3 for that employee on
   every cutoff ending on or after the date (`POST /hr/employees/:id/rate-change`, oldest first).
   First-rate branch (2026-10-08): when an unset zero rate is filled for earlier history, start
   recomputation at that earliest repaired date too. Impossible effective dates are rejected
   before any history or payslip mutation.
   Unpaid payslips are rewritten in place; a payslip already marked Paid is left as paid and
   reported with what it is short (or over) at the new rate, for HR to settle by hand or un-mark
   and regenerate. A recomputed cutoff whose payroll was already posted to the GL is flagged for
   re-posting (stage 4). Cutoffs with no payslip yet just use the new rate when generated.
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
   compliance forms. Agency schedules count a payslip toward the month its cutoff ends in
   (SSS IRR), not its pay date.

**Terminal states:** posted + filed (a period, once posted, is not recomputed in
place — corrections go through a new adjustment, not a rewrite of history).

## Offline operation & sync (record → site → cloud) — partial

Design: `docs/OFFLINE-FIRST.md` (§10–11 = built). **Built (phases 1–2, 2026-09-30):** stages 1, 3
and 4 between a node and the cloud — over HTTP (`syncWithCloud` / `startSyncLoop`, phase 3a) and
in-process for tests (`syncOnce`); every inventory-module route classed; desktop badges + the
needs-attention inbox (phase 3b: `X-Sync-State` marking, status pill, `#/sync`); stage 2 as a relay
(phase 3c-i: LAN PCs sync with their site host, which forwards to the cloud); site decisions
(phase 3c-ii: `claim`s decided at the owning site; the cloud keeps them, flagging clashes — D6).
Pipelines offline so far (phase 4): time clock (4a), production run with site number blocks (4b),
sales order fulfillment (4c), purchase-to-pay (4d), HR requests, approvals
and records (4e), confidential reports (4f), payroll (4g), accounting (4h); every business
pipeline above now runs offline.
Every mutating route is classed or listed with a reason (phase 4i; guard test
`tests/sync-route-classes.test.ts`). **Not built:** mobile sync UI. This pipeline wraps the
business pipelines above: every stage in them whose route is classed `merge` / `physical` /
`claim` runs through it. Only `online`-class stages (QuickBooks sync, sending email/SMS, AI,
SaaS billing) need internet; nothing is cloud-only (decision D2).
**Trigger:** any write on an installed desktop node, or on a phone using a site host over the
LAN (e.g. a stock withdrawal, a punch, a QC result).
1. **Record** (owning module's route, via `sync/`) — the API call becomes a command (actor,
   device, `occurred_at`, HLC, sync class, allocation plan of node-partitioned IDs / provisional
   numbers); the route handler runs optimistically on the node with side effects held in the
   outbox and discarded. Badge: "Saved on this device". `claim` without the record's home
   authority reachable → refused here ("needs site connection"); `online` without internet →
   refused ("needs internet"). A route with no class at all is refused on a node (503, "needs an
   internet connection") — its writes would never sync. *(Built: `sync/capture.ts`; `claim` is
   always refused until phase 3 adds site hosts.)*
2. **Site confirm** (`sync/` on the site host; *built in phases 3c-i/ii: "confirmed on site"; for
   a `claim` on a record the site owns the site's decision is kept by the cloud (D6); final numbers
   from leased blocks come in phase 4*) — the host
   replays the command through the same
   handler against the site's data (same allocation plan, command clock, permission re-check),
   issues final numbers from its leased block, and fans the resulting changeset out to every
   node on the LAN; nodes rebase. LAN side effects (live screen updates) fire here. Badge:
   "Confirmed on site".
3. **Cloud confirm** (`sync/` on the cloud) — the host forwards commands (anonymous-channel ones
   stripped of actor/device/node/time and delayed into a later batch); the cloud replays them against every site's combined data, assigns the final
   `authority_seq`, keeps site-issued IDs/numbers, and returns effects from other sites. Badge:
   "Synced". *(Built: `sync/authority.ts` `acceptCommand` / `pullFor`, `sync/rebase.ts`
   `applyConfirmed` — undo pending, apply effects, record verdicts, re-run pending.)*
4. **Side effects** (cloud only) — outbox: email, web push, QuickBooks push, AI — exactly
   once, where the command became final. (Accounting auto-post is a DB write inside the handler,
   so it travels as part of the confirmed effect, not the outbox.)

**Data carried:** command (API call + metadata; uploads as SHA-256 blobs sent first — built, phase 3e) up; confirmed effects (SQLite changesets) down,
to every node (full replica; only node-local tables such as session tokens and integration
secrets stay put, sensitive fields travel encrypted); files as SHA-256
blobs pushed before their command.
**Branches:** a `claim` on a record another site owns (or with no main site set) → refused offline;
a LAN PC's `claim` with no recent contact with its host → refused; no site host reachable → stays `local`, retried; validation / permission failure at
replay → `rejected`, shown to the actor; `physical` command breaking an invariant (stock below
zero, unit already sold) → accepted and flagged into the conflict inbox (built for stock:
`stock_discrepancies`, decision D1); actor's permission
revoked before the node learned of it → accepted and flagged; replay result differs from the
optimistic run → badge + inbox; duplicate delivery → dropped by idempotency key; command from an
app version outside the supported window → conflict inbox for re-entry.
**Terminal states:** `cloud_confirmed`; `rejected`; flagged/conflict resolved by a supervisor
(which records a correcting command — history is never rewritten).

## Site host failover

Design: `docs/OFFLINE-FIRST.md` §4; built in phase 5a (§30: take-over by an admin, step-down, PCs
following a new host, full re-sync) and 5b (§31: automatic election at 3+ voting PCs). Not yet tried on
real office networks.
**Trigger:** the site host is lost (switched off, broken, gone) during an outage, or a site PC
can't reach its host for 3 sync rounds.
1. **Mirror** (`sync/`, every round): each site PC keeps from its host the commands the host holds
   unconfirmed, the site's PCs with their credentials and LAN addresses, the cloud's address, the term and
   the site's certificate authority.
2. **Take over** (`sync/` + `desktop/`): an admin on a site PC confirms the host is off. The PC queues the
   mirrored commands as its own, starts term + 1 and a new stream, and restarts as the host (HTTPS on the
   LAN). At 3+ voting PCs this happens by itself (5b): no heartbeat for the lease → an election under the
   next term → the PC with a majority of votes (never one behind the voters) takes over.
3. **Follow** (`sync/`): the site's other PCs miss their host for 3 rounds, ask the site's PCs who hosts it
   now (`/whoami`: site, term), switch, send again what the old host had accepted, and re-sync from the new
   host.
4. **Claim** (`sync/`, the cloud as referee): when the new host reaches the cloud it claims the site with
   its term, sends every command it holds (the old host's too) and re-syncs from the cloud.
5. **Step down** (`sync/`): a returning former host hears of the higher term from the cloud. It sends what
   it still holds, gives up its unused number block, follows the new host and re-syncs from it.

**Branches:** two PCs take over at once → the first to claim at the cloud wins and the other steps down,
with clashing decisions flagged (D6); the old host was only cut off, not dead → both decide until they
reach the cloud, and clashes are flagged; a PC with a damaged copy → **Re-sync this PC**, or automatically
on divergence.
**Terminal states:** one host per site under the latest term, recorded at the cloud; every command recorded
anywhere on the site reaches the cloud once.

## Installed PC enrolment (enrol → snapshot → sync) — partial

Design: `docs/OFFLINE-FIRST.md` §13. **Trigger:** someone sets up a PC to work offline.
1. **Enrol** (`sync/transport.ts`, cloud) — an admin with `users.manage` signs in from the PC
   (the desktop app's setup screen, `electron/setup.html`, or `npm run sync:enrol`); `POST /api/sync/nodes` issues the next node number and a node token
   (stored hashed). The first enrolment switches the workspace to sync mode (cloud role).
   - **Branch — site host** (`--as-host`): registered `is_host`; it serves its LAN from then on.
   - **Branch — LAN PC** (`--host <URL>`): the script asks the host its node number
     (`/api/sync/whoami`) and registers as its PC (`host_node_no`); the host learns about it on its
     next cloud round (`/api/sync/members`), then hands out the snapshot (step 2 runs on the host).
2. **Snapshot** (cloud) — `GET /api/sync/snapshot`: the workspace as of the latest effect with every
   credential removed (node-local tables emptied, secret settings deleted, VACUUMed).
3. **Adopt** (`sync/client.ts`, PC) — the copy becomes the PC's database with the node role and its
   cloud link (`sync_remote`); users sign in to it with their normal passwords.
4. **Sync** (PC ↔ cloud) — with `DEPLOY_MODE=node` the server runs `startSyncLoop`: the "Offline
   operation & sync" pipeline above, every 15 s while reachable.

**Branches:** not an admin → 403, nothing switched on; target is itself an installed PC → 409; the
database file already exists → refused (enrol into a fresh file); cloud unreachable during a sync
round → the PC keeps working locally and retries.
**Terminal states:** enrolled and syncing; revoked (`POST /api/sync/nodes/:no/revoke` — its token
stops working at once; its rows keep their ids); diverged (sync loop stops — re-enrol).
**Phone setup (site host):** a phone opens `http://<host>:3001`, installs the site certificate
once, then uses `https://<host>:3000/m` on the office Wi-Fi (D5).

## Workspace billing (sign up / invoice → pay → confirm → open) — partial

Built 2026-10-10, design `docs/SAAS-READINESS.md` §12. **Trigger:** a company signs up on the public
website, or the owner issues an invoice (monthly plan, implementation fee).
1. **Sign up** (`platform/signup.routes.ts`, website) — workspace created with `awaiting_payment`
   (locked to sign-in, Billing, Support); quote priced from the price list; first month's invoice
   issued automatically when every chosen module and the seat price are priced. *Skipped* for
   workspaces the owner creates in the console (never locked).
2. **Invoice** (`platform/billing.ts`, console) — reference `<prefix>-<year>-0001`, gross, net of 2%
   EWT, due date. Status `open`.
3. **Pay** (customer, desktop Admin → Billing) — by GCash (number + QR shown) or bank transfer, then
   **Report payment** with channel, reference no., amount, date, receipt screenshot, optional 2307.
   Status `payment_submitted`. *Planned:* PayMongo checkout as a third, automatic branch.
4. **Confirm** (operator, console Billing) — checks GCash history / bank app; confirm or reject with
   a note the customer sees; or records a payment seen directly (check, bank app).
5. **Open / activate** (`platform/billing.ts`) — confirmed ≥ net − ₱1 → `paid`; the workspace's
   `awaiting_payment` lock lifts; a `trial`/`past_due` workspace becomes `active`.

**Branches:** proof doesn't match → rejected, back to `open`; short payment → stays `open` with a
balance; owner opens a waiting workspace without payment; sign-up with an unpriced module → no
automatic invoice, owner issues it; a `suspended` workspace is not reopened by a payment.
**Terminal states:** paid (workspace open/active); voided; overdue → flagged only (moving to
`past_due` / `suspended` is manual; automatic step planned). Customer routes are sync class `online`.

## Sales inquiry (website → follow-up → workspace) — working

Built 2026-10-10 (`docs/SAAS-READINESS.md` §12). **Trigger:** a visitor sends the website's
**Talk to us** form.
1. **Inquire** (`platform/inquiries.routes.ts`, public site) — name, company, email, mobile,
   employees, modules of interest, message → `inquiries` row, status `new`. The form also shows the
   owner's phone / email / Messenger (console-set) for direct contact.
2. **Follow up** (owner, console → Inquiries) — call / email; status `contacted`, private notes.
3. **Create workspace** (console, prefilled from the inquiry) — linked to the inquiry; optionally
   **locked until first payment**, which hands over to the "Workspace billing" pipeline (invoice →
   pay → confirm → open). Unlocked, it is usable at once.

**Branches:** bot fills the hidden field → accepted silently, nothing stored; invalid fields → 400;
more than 5 per hour from one connection → 429. **Terminal states:** `won` (workspace created and
linked), `lost`. The owner sets these; nothing changes them automatically.


## Design, link and print a form layout

Trigger: a form manager opens Print templates, or an editor opens the document library.
1. Core resolves the template/form identity and edit scope, then loads HTML and revision.
2. The studio edits text/design pages, fields, sections, tables and review markup. Local
   undo/recovery preserves unsaved changes; cloud rooms/version checks protect shared edits.
3. Publication validates the revision and shared version. Multipage layouts require 1×1
   printing with Continuous off. Alternative links do not silently change the form default.
4. The form manager chooses a default or selects an alternative for one print. Rendering
   binds record/company/custom fields and the preview uses the same physical print layout.
5. Single designs can use configurable grids; explicit multipage designs bypass grids.
   Word conversion reports unsupported visual/template features and retains import originals.

Failures: permission/stale-revision/shared-version errors retain local work; retry after
reviewing the latest document. Server private/shared working tables are cloud-only and
are excluded from offline replication; publication follows the existing claim workflow.

Editing transaction detail (Wordcraft port phase 1): capture the selection before an input,
coalesce consecutive typing/deletion at the same caret, and close the group on movement,
paste or toolbar activation. Undo/redo restores both HTML and anchor/focus. Composition
keeps the live DOM intact until commit; shared-room reconciliation waits for composition
to finish. Track-changes composition remains outside the supported review scope.

Formatting dispatch captures selection, restores the document focus, checks the edit
boundary, closes pending typing, executes the command and commits an undo transaction.
Dialogs return focus/selection to the surface after dismissal; locked selections refuse
formatting rather than silently changing protected content.

Clipboard serialization writes canonical HTML/plain bindings and paste restores editable
chips after sanitization. List Tab changes level; table Tab traverses merged physical
cells and creates an undoable data row at the end. Token boundary movement/deletion
operates on whole chips and respects the review/locked-content guards.

Model-backed paragraph alignment captures the current document into versioned nodes,
resolves selected paragraph paths, rejects locked ancestors, creates an immutable model
change and patches only changed style attributes. Existing caret/history and shared
publication then persist canonical HTML. Unknown markup and opaque SVG remain preserved.

Selected inline formatting validates structural text endpoints/values, captures a model
with ephemeral selection bookmarks, produces immutable run changes and patches selected
text/attributes. It then restores anchor/focus and removes bookmarks before history/shared
publish snapshots. Atomic/derived/review-deleted content stays unchanged. Word conversion
keeps explicit inherited-format resets and emits per-run formatting inside revisions.

Caret formatting choices store ephemeral marks and update toolbar state only. Captured
beforeinput starts the existing history transaction; marked ordinary text inserts an owned
run, while native composition is marked after commit using its final text range. Tracked
text first creates attributed revisions, then applies marks only to the inserted text.
Normalization coalesces identical owned runs and restores the caret before snapshots.
Whole-field formatting wraps the live chip; serialization replaces only the chip with its
raw binding. Selected inline decoration removal isolates the selected wrapper fragments,
keeps unselected paint and other marks, and removes all temporary bookmarks before history,
shared saves and Word export. General deletion and block/caret decorations remain native.

Paragraph text editing now follows: capture history boundary → validate editable endpoints,
protected atoms and paragraph scope → replace/insert text or resolve one Unicode grapheme
for deletion → apply pending character/script/decoration marks → unwrap/coalesce owned runs
within the block → restore the caret → record the existing HTML snapshot/shared change.
Field chips delete/replace atomically; unaffected chips retain live identity. Structural
boundaries delegate after lock checks. Composition and tracked text keep their handlers,
with pending formats applied to committed/new revision text. Clear Formatting restores
paragraph character defaults without changing paragraph layout; selections across differing
paragraph defaults delegate rather than forcing one font/size onto all blocks.

Editor workspace controls are UI state: metadata settings visibility, active ribbon tab,
inspector panel, menus and fit/zoom do not alter saved document HTML or dirty/history state.
Ribbon and sidebar collapse also remain UI state, recalculate page fit, and keep tools
reachable. Selecting a ribbon tab expands its controls; inspector collapse returns focus.
Inspector color/spacing pickers write validated CSS through the existing history/save
pipeline. Color swatches normalize their display only; existing alpha remains until edited.
Variable bank → search/category → Insert restores the remembered editor range and inserts
the canonical chip through the command registry; Copy writes the full template token and
does not edit the document. Click a chip → select its outer boundaries → Delete/Backspace
uses atomic deletion and an undo snapshot. Starter fields are not regenerated on save.
The selected font/style/point-size readout follows current text rather than field-label
chrome; mixed values are shown explicitly. Inspector point sizes write CSS pt values through
the existing change/history path. Find/replace mounts above the workspace; source editing,
print preview, fields, drafts and shared rooms retain their existing command/save pipelines.
