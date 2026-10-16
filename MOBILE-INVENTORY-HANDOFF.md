# Inventory and production: mobile integration gaps

## Direct unit sale in same-order trip slips (2026-10-16)

The legacy `POST /finished-products/:id/units/allocate` `action:'sell'`
deducts RTS stock immediately. Schema v85 stamps `direct_sold_at`; the next
trip slip must include each directly sold serial and deducts only the rest of
that trip's load. A direct-sold unit cannot be omitted from the next manifest,
and cancel-remainder cannot discard one awaiting a slip. Older unslipped direct
sales are backfilled. Historical slips with double stock-out need manual ledger
review if found; they cannot be inferred safely from current balances. An old
unlinked sold serial with an ambiguous timestamp around an earlier trip also
needs manual review rather than automatic attribution.

Phone owner: `public/mobile/modules/inventory/allocate.js` still offers open
orders without a line picker and says “Sold / shipped” before any trip slip.
Load the exact physical sale line, show its build state, price, ship-from and
remaining quantity, and send `order_item_id`. Repeated-SKU phone *release*
allocation was updated separately; this older direct-sell screen remains the
gap. Show “Stock removed; awaiting trip slip” after a direct sale, and surface
the unslipped serial as required in the next phone load selector. The backend
rejects a missing/wrong/full line, wrong location, cancelled order or completed
sale; a partial same-order sale may still use a later trip.

The mobile `mSubmit` queue already sends a stable `Idempotency-Key`; the direct
sell endpoint now honors it. After a lost response, retry the **same** body and
key or reconcile the unit/order before a new attempt. Never sell the same unit
twice. No mobile source was changed here. Backend and disposable Playwright
checks cover response loss, desktop 390px/1440px slips, and phone delivery.

## Current owner decision: same-order partial trips (2026-10-16)

Partial vehicle loads now stay on **one sales order** with separate release slips and
separate delivery records. Unshipped goods remain committed and unavailable to other
sales until shipped or customer-cancelled. Mobile load selection supports exact serials,
batch quantities and complete CKD kits. Managers can plan each delivery trip; the
second handoff requires fresh proof/signature. Schema v84, PWA cache v108. This supersedes
historical backorder-splitting and “CKD partial UI pending” descriptions below. See the
same-order partial vehicle trips entry at the end for the current contract.

## Mobile exact sale-line allocation (2026-10-16)

The repeated-SKU handoff below is implemented for phone allocation. Staff see
line IDs, build states, prices/currency and remaining counts, choose the exact
matching line after scanning, then verify its sticker and quantity. Unique open
matches continue directly. Completed lines are excluded; stale line links return
to explicit choice. Availability is tied to the selected line/build and shared
pool, not summed across duplicate rows. Existing saved attempts retain their
original JSON and key; newly created requests include the exact sale-line ID.
QR stock/unit and batch allocation records display their line ownership. The
backend release context includes `unit_price` and currency. CKD whole-kit partial
release and pre-slip allocation undo remain separate steps. PWA cache v107.

## Repeated SKU sale lines: mobile release handoff (2026-10-15) — original backend contract

The sale order may now contain two physical lines for the same `item_id`, with
different `fulfillment_mode` (`assembled` or `semi_built`) and/or `unit_price`.
Show both commercial lines, their build-state tags, quantities, prices and line
IDs separately. CKD parent lines still expand into their frozen component lines;
do not allocate or deduct parent SKU stock. The desktop order editor now permits
repeating an item and the warehouse release screen targets each line separately.

For `POST /orders/:id/release`, send `order_item_id` inside each `bulk` entry
alongside `item_id`, `quantity` and optional `batch_id`. For a scanned serialized
unit, send top-level `order_item_id` with `codes` or `unit_ids` when more than one
matching sale line has that SKU and build state. The server can auto-match a
unique SKU/build-state line; an ambiguous request returns `409` with
`code:'line_required'`. Do not retry it without a line choice. For
`POST /orders/:id/release/unreserve`, send `order_item_id` in each bulk entry;
unit IDs already identify their reserved line. Display the exact sale-line ID
and build state in allocation and undo confirmations.

`GET /release-slips/orders/:id/context` exposes each line's `id`, each unit's
`order_item_id`, each batch allocation's `order_item_id`, and each availability
row's `order_item_id`. Key phone state by sale-line ID, not `item_id`; summing
duplicate SKU rows as independent free stock will overpromise. The release slip
records one row per sale line, and return intake must use its `slip_item_id` to
match serials/batches from that same sale line. Batch QR preview at
`GET /release-slips/orders/:id/unit?code=...` now includes `matching_lines`
with `order_item_id` and `remaining`. It reports the shared pool's availability;
when two matching lines exist, ask the employee to choose a sale line before
posting the release. The current phone `so.js` uses the first matching item line
and posts only `item_id`, so repeated-SKU scanning will receive `line_required`
until that screen is updated. No mobile source was
changed here. Backend tests cover repeated-price allocation, ambiguity, undo,
and stock-out; desktop Playwright checked 1440px and 390px widths.

A plain SKU/barcode QR preview with multiple matching sale lines returns
`state:'line_required'` and `matching_lines` rather than a misleading
`not_found`; the phone should present those line choices before quantity entry.

The older `POST /finished-products/:id/units/allocate` direct-unit sale action
also accepts optional `order_item_id`. It stamps the selected line on a sold
serial. Supply it when a sale has multiple matching lines; the server returns
`line_required` when the line is ambiguous. This endpoint already deducted
stock on direct sale, so phone workflows should use the sale release/slip path
for normal dispatch.

## Courier pickup mobile integration (2026-10-16)

Owner policy: collector name, photos, signature and GPS are optional for courier
pickup as well as own-driver delivery. Backend required collector/proof guards
are removed; supplied signature ownership validation and warehouse-out guards
remain. Desktop collection also permits empty evidence.

`#/deliveries` now identifies courier bookings, displays carrier/tracking, opens
**Record courier pickup** directly from a pending booking, and submits
`outcome:'courier_handoff'`. Terminal courier status is **Picked up by courier**,
not customer delivery. Tracking and optional evidence persist across restart;
unknown outcomes retain the original payload/key and upload identities. No extra
stock is deducted. Assignment and delivery permissions remain unchanged.

No dedicated courier Figma frame exists in the current role spec (delivery is
explicitly outside its frames). This step extends the existing vanilla delivery
components and recovery primitives; Work reference `46:548` was retrieved. It does
not claim a new courier screen was approved in Figma. CKD whole-kit partial UI
parity remains separate work.

## Courier pickup and whole-kit CKD partial release (2026-10-16) — historical backend handoff

**Delivery choice:** A `deliveries` booking now has `delivery_mode:'own'|'courier'`
(default `own`). A courier booking requires `courier_name`; it can also carry a
`tracking_number`. Planning may precede the sale release slip. A courier booking
must not use `out_for_delivery` or customer `delivered`; after the numbered slip
and stock-out, the assigned staff member or delivery manager uploads a `delivery`
photo (or delivery-linked signature) and calls
`POST /deliveries/:id/complete` with `{outcome:'courier_handoff',
recipient:'name of courier representative',tracking_number?}`. The server stores
the existing terminal `status:'delivered'` for compatibility and returns
`handoff:'courier'`; interpret a courier-mode delivered record as **picked up by
courier**, never as customer receipt. `pod_recipient`, `delivered_at`,
`delivered_by`, proof, courier and tracking identify the pickup. Our operational
delivery task ends at this proof; later carrier tracking is informational.
`GET /deliveries?order_id=<id>` can find the booking. A courier-mode booking
rejects driver dispatch and customer delivery with `courier_handoff_required`.
Only one pending/in-progress shipment booking may exist per sale; creation or
reassignment returns `409 shipment_already_booked` until the prior booking is
completed or cancelled. Show the existing choice instead of offering a second.
The desktop release-slip detail can book and confirm courier pickup; the phone
delivery module still assumes only our own driver flow and needs a distinct
courier pickup screen and language. The owner's optional recipient/evidence policy
for our own-driver deliveries remains in force; courier pickup requires a named
collector and proof because it closes our custody. Do not edit the mobile source
in this handoff.

**CKD partials:** With Sales authorization `partial_allowed:true`, the warehouse
may now issue a slip for one or more **whole** CKD kits from a larger CKD sale.
For a two-unit kit requiring one frame and two wheels each, pick one frame and
two wheels to ship one; the new backorder preserves the parent CKD line and
remaining child-part snapshot. A lone frame cannot leave as a kit; extra picked
components must be unreserved before the partial slip. Show whole-kit progress
from `parent_order_item_id` and component quantities, and block the phone slip
button when a picked kit is incomplete. Never interpret a CKD parent as an RTS
unit or deduct its SKU stock in addition to components. Browser/API regression
coverage: `tests/ckd-sales.test.ts` and `work/courier-ckd-browser.mjs` (the latter
is an ignored local verification script).

**Updated above:** The repeated-SKU sale-line blocker has been resolved in the
backend and desktop. The phone allocation screens still need the line-ID handoff.

## Final releasing, delivery and mobile authorization follow-up (2026-10-16)

This section supersedes the older final-proof/delivery gap below. Final warehouse-out
now persists photos, recipient signature and handoff context, then retains an immutable
attempt across restart/lost responses. Both photos and signature upload under stable
keys before slip issuance and attach atomically to the slip. Unknown results require
explicit original-attempt recovery; stock is not posted again. Saved attempts are
account/server scoped, discoverable independently of live queues and protected by
revision checks. Site-PC saves remain pending until authority confirmation.

Delivery start/POD now have durable drafts and immutable submissions, including
optional photo/signature/GPS/recipient/note state. Owner decisions: evidence stays
optional in-app, and a linked delivery may start before warehouse-out. The driver
screen no longer offers force-backorder sales completion. Delivery does not deduct
stock again. Server delivery permissions accept runners or managers and retain
assignment restrictions.

Mobile operational features now follow both effective desktop account permissions
and workspace modules, including direct URLs. Work/production tiles and Quick Orbit
use the same policy. A baseline employee keeps personal tools without operational
inventory/production/releasing/delivery/confidential-case access. Foreground, focus
and reconnect refresh permissions from the server. Inspectors can still open their
own repair-revision decisions. PWA cache v104.

The handoff at commit `6185481` was reconciled with current code in
`docs/reviews/mobile-handoff-6185481-review.md`; it lists remaining work and separates
already-completed historical audit rows. Highest follow-ups include courier pickup, whole-kit CKD partial-release parity, semi-built finishing intake, returns/disposition, allocation undo,
build-state stock movements and shortage/procurement context. Mobile sales pricing
suggestions are conditional on adding a Sales editor.

Validation: all 24 real-backend Playwright checks passed at 390×844, using actual
printed QR images through a virtual camera and a persistent Chromium profile for
Blob recovery. TypeScript, all 235 focused tests and the final integrated full suite
passed: **2,796 tests across 273 files**. This run includes upstream `0a53a32` and the
owner-confirmed backend policy alignment. See `docs/reviews/mobile-recovery-and-access-validation.md`.
Physical phone/printer acceptance is still required; this does not certify hardware
readiness or close the separate remaining integration list.


## Updated backend audit integration (2026-10-16)

Integrated upstream `0a53a32`, including the desktop slip/photo response-loss fixes,
physical-sale completion guards, assigned-driver/manager evidence access checks and
completed-evidence locks. The historical audit is in
`docs/reviews/release-delivery-playwright-audit.md`.

The owner explicitly reconfirmed the earlier delivery choice after reviewing that
handoff: **start before a slip is allowed; recipient, photos, signature and GPS are
optional**. Backend and mobile both follow this choice. Marking physical sale goods
Delivered and commercially completing the sale still require warehouse-out. A failed
attempt can record its required reason before a slip without moving stock. The
stricter dispatch/proof requirements in the earlier backend audit are superseded.
Mobile recovery retains exact keys/evidence and handles release-required results
without a forced stock action. Security and stock protections remain in place.


## Follow-up QR acceptance audit

See `docs/reviews/mobile-qr-playwright-audit.md` and repeat with
`npm run test:mobile:qr`. This audit uses actual backend stock transactions, printed
QR image → virtual camera → production scanner, narrow clerk roles, uploaded
proof/signature files and IndexedDB recovery after a committed-but-lost allocation
response. It fixes mixed tracking-type batch allocation, physical CKD component
preview mapping and silent blank unit-label printing after a template failure.

The test also confirms a remaining gap: handoff proof/signature drafts are not
persisted across page restart. Stock is safely blocked until recapture; this is not
durable proof or final-slip recovery. Physical phone/printer acceptance and delivery
remain open. Historical validation totals below describe earlier runs. Final merged audit validation:
TypeScript, 172 focused tests, all 13 real-backend virtual-camera Playwright checks,
and all 2,747 full-suite tests across 264 files passed. PWA cache v101. Preserved
upstream finishing-conversion/company-login work through `ee4beb6`.

## BOM markup and sales price suggestion (2026-10-16)

**Backend/desktop contract:** Product setup now stores optional
`attributes.selling_markup_percent` (0–10,000%; blank disables). The suggestion is
the current rolled-up BOM material, labor and overhead cost multiplied by
`1 + markup / 100`, rounded to two decimals. It excludes tax, freight and order
fees. `GET /api/finished-products/:id/price-suggestion` is readable with
`inventory.view` or `production.view` and returns `available`,
`suggested_unit_price`, `markup_percent` and `currency` without the cost breakdown.
It returns `available:false` when no markup is set, the BOM is empty/cyclic, or a
leaf component has no positive standard/purchase cost. The suggestion is calculated
at lookup time as component costs change; it is not written to the catalog sale
price or an existing order. Sales orders still start from `attributes.sale_price`.
On desktop, a sales user must explicitly press **Use suggestion** on a draft line;
they can then type a higher or lower negotiated price. Currency mismatch hides
the action. Approved lines stay locked.

**Mobile owner action:** If mobile creates or edits sale orders, show the suggested
unit price and markup next to the editable unit price, with an explicit apply
action. Never silently replace an entered price or reprice an existing order when
component costs change. Refresh after product selection or when reopening a draft;
show an unavailable reason and hide apply on currency mismatch. Keep shipping,
admin and other fees separate as non-stock lines. Mobile code was not changed here.

**Acceptance cases:** A cost of 80 with 25% markup offers 100; an existing 75
line stays 75 until apply; sales can then negotiate 90; zero/missing component
cost cannot produce a suggestion; clearing the markup disables it; a different
order currency cannot apply it; approved orders cannot reprice.

## QR stickers → RTS → exact sales allocation (2026-10-15)

User-confirmed workflow: attach the printed unit/batch QR sticker, scan it before RTS
stock entry, then scan the same stock label when allocating it to a sales order.
Authorized staff can also scan for a read-only dossier and quantities; lookup never
receives or allocates stock automatically.

New printed labels encode immutable `VDS:UNIT:<id>` / `VDS:BATCH:<id>` payloads while
retaining the human-readable serial/batch number on the sticker. Mobile dossiers,
mobile print sheets, desktop unit labels and desktop batch labels use the same
convention. Lookup, RTS, QC/QA identification and releasing accept these identities.
Unambiguous older label text remains compatible; ambiguous legacy labels must be
reprinted from the exact record.

Mobile confirmation uses shared `mScanner.verification`: every selected unit, or the
selected batch, must be scanned from the attached sticker. Manual search/selection
can discover a record but cannot satisfy verification; the verification scanner has
no manual-entry form. Printing is separate and cannot mark a sticker verified.
Batch receiving can be found by its QR and has a print action before posting.
Releasing resolves a batch against the sale product, build state and ship-from
location, shows its free quantity, then persists the exact `{item_id,batch_id,quantity}`
request before allocation. Existing immutable request/restart recovery is retained.

Schema v77 adds per-location `production_batch_stock`, exact `production_batch_allocations`,
count audit records and batch-return links. Products In establishes lot balances;
reservation does not move stock; warehouse-out consumes the same reserved lot.
Undo/cancellation frees reservations. Transfers preserve lot identity, ordinary
stock-outs consume free tracked lots after untracked stock, and held lots cannot be
silently taken by a generic movement. Legacy quantity API clients reserve known lots
FIFO; mobile batch allocation explicitly names the scanned lot. Inspected restocks
restore the linked shipped lot; multiple shipped batches require an explicit batch
on the return. Final delivery/proof recovery remains separate work.

Historical receipt totals are not remaining stock. Existing batches are not given
invented balances: a supervisor uses **Reconcile batch stock** in the dossier to
record a physical count and reason. This partitions existing build-state/location
stock, cannot add warehouse stock, cannot consume another lot's balance or undercut
reservations, requires the currently reviewed balance and records an audit row.
Older stock needs this reconciliation before exact-batch release.

Integrated concurrent remote form/payroll history commit `1916892`; batch schema uses
v77 to preserve its v76 migration. PWA cache v99. Validation: TypeScript passed; 177 focused tests passed; all 2,721
tests across 260 files passed in the frozen full run. Nine receiving/releasing
Chromium scenarios passed at 390×844, including decoding the actual generated unit
and batch QR images, exact-key retry after restart and no horizontal overflow. Figma
node context was retrieved for 74:68 and 78:109; the screenshot service returned
asset URLs whose download was refused (HTTP 403), so no pixel comparison is claimed.

Subsequent upstream SMTP/platform-billing commit `8e53710` was merged without
changes to the mobile QR workflow or batch schema. Post-merge TypeScript and all
161 targeted tests across seven files passed. The 2,721-test full run above precedes
this SMTP-only merge; the final targeted run covers its affected tests and the
mobile/lot workflow again.

## Semi-built is a complete package; finish the same unit (2026-10-15)

**Backend/desktop contract:** A semi-built unit is one complete product with the unassembled
parts packed alongside the assembled portion. It can ship as semi-built RTS. For a fully
built sale shortage, stock review now shows free semi-built stock at the ship-from
location, including a reminder when CKD components are short. A user with
`production.approve` or `production.manage` can explicitly choose a package to finish rather than draft a
new CKD-parts job. `GET /api/job-orders/convert-semi/options?product_item_id=&location_id=`
returns eligible `units`, exact QR `batches` with free quantities, and
`bulk_available` for genuinely untracked stock. Schema v79 adds
`semi_build_conversions.source_batch_id`: starting debits that exact batch, and
cancelling before QC returns the unit to the same batch. `GET /api/job-orders/convert-semi/demand`
gives production managers a narrow list of uncovered fully built sale demand without
customer or price data. `POST /api/job-orders/convert-semi`
is multipart with `product_item_id`, optional `order_id`, `source_location_id`,
`output_location_id`, either `source_unit_id` or `source_batch_id` when tracked,
physical `identifier`, optional
`finishing_cost` and `notes`, required `confirmed_complete_kit:true` after counting
the loose parts, and required `image`. Use an `Idempotency-Key` and keep
the exact request for a retry. Each request converts **one** package. It immediately
removes one semi-built RTS unit and creates an approved, released fully built job
order with one linked unit pending QC. The conversion job has zero BOM components:
the packed parts are not picked or deducted again. The source serial and received
cost carry into the new unit; for untracked stock the operator assigns a physical
identifier at intake. A final QC pass still leaves the unit non-sellable until
`POST /api/job-orders/:id/products-in` posts it into fully built RTS. The job detail
exposes `conversion_job_order_id`, `conversion_source_unit_id` and
`conversion_source_batch_id`; `GET /orders/:id/availability`
adds `lines[].semi_built_available`. A conversion can be cancelled before inspection
to return the same package to semi-built RTS; `POST /job-orders/:id/cancel` then
requires `confirmed_repacked:true` and a nonblank `reason`, with the actor, reason
and time saved on the conversion record.
Once inspection begins, use the normal
QC/rework path. Ordinary `POST /job-orders/:id/progress` and `/:id/units` cannot add
output to a conversion job.

**Mobile owner action:** The phone sales stock review needs an explicit choice for
fully built shortages: draft a CKD-parts build or select an eligible semi-built
package for finishing, even when CKD parts are available. Emphasize the semi option
when CKD parts are short. The source picker must distinguish tracked serials, QR
batches and untracked stock; retain a serial, scan the exact QR batch for a batch
package, and assign a physical identifier when the package is non-serialized.
Photograph the package and show an unknown result after a timeout until the
same keyed request is reconciled. In the production and QC worklists, label the
conversion as **finishing an existing complete package** and present its linked
pending unit directly; do not offer component pick, another Add unit, or bulk
progress. Products In and sale release must continue to respect the current build
state, location and unit identity. The mobile source in `public/mobile/` was
inspected for this handoff but was not edited.

**Sales price and fee handoff:** On the desktop order editor the catalog
`attributes.sale_price` is only the starting price. Sales can replace the unit
price on that order, higher or lower, before approval. BOM material plus standard
labor and overhead calculate **production cost**, not an enforced selling price.
Shipping, admin and other fees are non-stock order lines with `description:'Order fee'`,
quantity 1 and an editable name/price. They appear in the order subtotal/tax/total
and commercial documents, but never reserve or deduct stock. The mobile sales-order
surface currently focuses on approval/releasing and has no equivalent price/fee
editor; if mobile order entry is added, preserve these separate cost and price
concepts, show fee totals, and lock price changes after approval as the API does.

**Acceptance cases:** Semi-built RTS remains shippable as-is; a fully built order
with no CKD parts but an eligible semi package offers conversion; explicit serial
selection starts one conversion without a second parts issue; a batch package keeps
its exact lot lineage; an untracked package
gets a new identifier and intake photo; a duplicate or reserved serial is refused;
QC pass alone does not make it RTS; Products In switches the same physical unit to
fully built; cancellation before QC restores semi RTS; retry with the original key
does not convert twice; a sale may override its unit price and add shipping/admin
fees without affecting stock.

## Integration with newer branch work (2026-10-15)

Mobile commit `5342728` is integrated with remote heads `e1c0439` and `f13e72a`, preserving both
histories. Earlier test totals below are historical; the remote baseline fix now
makes the HR payslip ownership test pass. Final merged validation: TypeScript passed,
174 focused tests passed, and all 2,699 tests across 257 files passed. Chromium at
390×844 passed QA hold pass/rectify/fail recovery, releasing acceptance/decimal/serial/CKD
recovery and single-unit/batch/grouped RTS recovery, with original keys and one
applied operation per request identity.

The phone hold-review screen now receives the frozen final-pass `checks` from
`GET /qc/holds`, prefills held answers and requires every required check to Pass
and every passed measurement to have a reading before enabling Pass. The reviewed
checklist joins the immutable decision payload and survives exact-key restart
recovery. Both stale-hold protection and the remote required-check enforcement
remain in the backend.

CKD parent lines are shown as a kit manifest with physical child quantities. The
phone excludes the commercial parent from allocation counts/quantity actions,
blocks an assembled parent serial, and currently disallows partial CKD handoff in its UI. The backend now permits whole-kit partials with Sales authorization. Existing
component availability and backend stock/return rules remain authoritative. Final
slip/proof recovery and downstream CKD result-copy review remain open. The newer
atomic Products In endpoint keeps compatibility with retained receipt payloads.
Optional storage hierarchy paths and procurement handoff additions remain separate
mobile follow-ups. PWA cache v98 includes both branches' shell additions.

Build-state integration validation: TypeScript and 178 focused tests passed;
all 11 Chromium recovery scenarios passed at 390×844. The full suite ran 2,704
tests: 2,702 passed, with two outdated discrepancy-reason assertions failing.
Those assertions were updated for the intentional variant audit suffix; all 11
sync-inventory tests then passed. No runtime code changed after the full run.

The subsequent build-state integration labels fully built/semi-built stock in approval,
RTS and releasing; excludes different build states from RTS groups; matches release
availability by fulfillment mode; and blocks cross-state serial scans. Approval
revisions include the build state. Stock transfer/adjustment build selectors, mobile
shortfall production creation and delivery/proof recovery remain open follow-ups.
The existing release API rejects duplicate physical item IDs on one sale, including
fully built and semi-built lines sharing a SKU; line-specific allocation remains a
backend follow-up before that mixed-line case can be fulfilled.

## Fully built / semi-built RTS variants and mixed sales supply

**Backend/desktop behavior:** Both build states retain the same product SKU. Sale lines send `fulfillment_mode:'assembled'` (fully built) or `'semi_built'`; job orders carry `build_mode:'assembled'|'semi_built'`. `POST /orders/:id/produce-shortfall` creates only the missing quantity, with the sale line's build state. Production QC and Products In still happen before either state becomes RTS stock. Products In posts to that state's location balance; sales availability, serialized scanning, bulk allocation and release select the matching balance. Existing pre-upgrade stock is treated as fully built/standard. A stand-alone `POST /job-orders` with no `order_id` builds RTS buffer stock; its `build_mode` selects the state. `GET /inventory/:id/stock` now returns `assembled_quantity` and `semi_built_quantity` alongside total `quantity`; transfer and adjust requests accept optional `build_mode` (default fully built/standard). CKD parts remain standard part stock and never reserve assembled units.

**Mobile owner action:** Show fully built, semi-built and CKD tags on sale/release lines and job orders. For semi-built scans, display a wrong-build-state result when a fully built serial with the same SKU is scanned (and vice versa). Show variant-specific stock at the ship-from location, not the item's combined total, and permit a partial RTS pick followed by production for only the remainder. Keep finished units pending until Products In confirms them. On mobile stock transfer/adjustment, expose the build state and send `build_mode`; without it, the server defaults to fully built and will refuse a semi-built-only stock-out. For tracked units, use `/finished-products/:id/units/allocate` with `action:'move'`, explicit `unit_ids` and matching `build_mode`; generic `/inventory/:id/transfer` returns `use_unit_move` so serial locations and stock cannot diverge. Distinguish stand-alone buffer jobs from sale-linked jobs. That backend handoff initially made no mobile edits; the integration above now covers approval, RTS and releasing.

**Mobile acceptance cases:** a semi-built order sees zero available when only fully built units exist; a fully built order does not consume semi-built stock; serialized cross-state scans are refused; bulk semi-built Products In increments only semi-built availability; a mixed order ships its ready quantity while a linked MO builds only the shortage; buffer MO has no sales link; transfer and return preserve the build state; CKD demand does not claim finished-unit stock.

## CKD sales using the same product SKU: mobile handoff

**Backend/desktop behavior:** A sales line can use `fulfillment_mode:'ckd'` while retaining the same `item_id`, SKU, unit price and ordered unit count as its built variant. The server snapshots direct BOM parts into `order_items` child lines (`fulfillment_mode:'ckd_component'`, `parent_order_item_id`). Each child has its physical quantity and zero sale price. Stock review, warehouse allocation, release slip, stock-out, cost and returns operate on those parts; the CKD parent is commercial/manifest only and does not consume finished-unit stock. Ordinary aftersales parts remain individual inventory-linked lines; `semi_built` remains on the production-stock path. An open CKD order retains its part snapshot across edits and BOM changes. Every part must be allocated for a full CKD slip; a partial slip may send whole kits with Sales authorization and backorder the remainder.

**Mobile owner action:** `public/mobile/modules/inventory/so.js` must show the parent as **1 CKD unit** and group its child parts underneath with their required quantities and ship-from availability. Offer scan/quantity allocation only on the child lines, not on the parent product SKU, even if assembled units with that SKU exist. Use `context.lines[].fulfillment_mode` and `parent_order_item_id`; the server rejects an attempt to allocate the CKD parent. Show a missing component as a CKD shortage, not as a need to build the finished unit. At confirmation, show the parent kit and all physical parts on the slip. Returns are recorded against component slip lines; the parent manifest line cannot be restocked as a built product. Do not use legacy Pick or a direct stock adjustment.

**Mobile acceptance cases:** a CKD order with assembled-unit stock but no parts is short; a CKD order with all parts but no assembled-unit stock is releasable; a BOM edit after order entry does not silently change its parts; stock changes between allocation and slip block the handoff; a second sale reserves the same part; a phone timeout after slip creation replays its original key; a component return restores that component only. Mobile source was inspected but not edited.

## Products In → finished stock → sales: 2026-10-14 handoff

**Owner:** mobile developer. **Backend/desktop status:** one `POST /api/job-orders/:id/products-in` now accepts `unit_ids` and `batches: [{batch_id, quantity}]` together, creating one atomic receipt and checking total location capacity before any line posts. The existing singular `batch_id` + `quantity` request remains supported. Batch quantities must be positive whole numbers; duplicate unit or batch IDs in one receipt are rejected. `Idempotency-Key` on this endpoint replays the same result for a lost response. Desktop uses one key per unchanged receipt attempt and shows the full location path and direct remaining capacity. That backend handoff initially made no mobile edits; the integration above now covers approval, RTS and releasing.

| Priority | Mobile evidence | Follow-up for mobile owner |
|---|---|---|
| **High** | `public/mobile/modules/manufacturing/receiving.js` batch `rts-post` uses `clamp(parseInt(input.value, 10))`. `1.5`, an empty value, or an over-remaining value silently changes to another quantity. | Parse the entire entry and reject invalid/decimal/over-remaining values with a clear correction message. Keep the server's integer and remaining-quantity checks authoritative. |
| **High** | The batch flow creates a retry key during view rendering; after navigation or restart an uncertain post can get a new key. Unit group keys and result state are held in the module's in-memory `draft`. | Persist the exact pending payload and key until confirmed, or reload receipt/receivable state before any retry. A lost response may mean stock already posted. Show **confirmation unknown** rather than “nothing saved,” and do not generate a new key for an uncertain unchanged request. |
| **Medium** | `locName()` and the stock/location screens show `l.name`, which is ambiguous when two shelves share a name under different roots. | Use the `path` from `/api/locations` for every receipt picker, review, and result; retain `location_id` for requests. Show direct room from `capacity - total_units`, and refresh on a capacity conflict. |
| **Medium** | Mobile unit grouping posts one request per job order; a group spanning jobs can partially succeed. | Show each job's confirmed receipt number and unresolved units separately. Retry only the unresolved job with its original key. Do not call a cross-job group “all recorded” if any request is pending or refused. |

**Mobile acceptance cases:** decimal, blank and over-remaining batch entries; one batch partially received then retried; timeout after server receipt commit; full location after review; same-name shelves in separate roots; grouped units from two jobs where one post fails; receipt at the wrong warehouse leaving a sale short at its ship-from location. The backend and desktop tests cover atomic multi-line posting, capacity, retry replay, and finished stock becoming available for sale at the receipt location; phone route tests and narrow-screen verification remain with the mobile owner.

**Sharing status:** This handoff and its backend/desktop implementation belong on `restructure/module-architecture`. Completed mobile steps and remaining gaps are recorded below.

## QC/QA: mobile handoff (recorded unit → inspection → hold or final pass)

**Owner:** mobile developer. **Checked against code:** 2026-10-14. **Status:** QA hold recovery completed in mobile step 6; ordinary inspection/checklist gaps remain open. See `docs/reviews/qc-qa-stage-audit.md` for the backend/desktop audit. A final QA pass leaves a unit awaiting Products In; it does not add sellable stock. New job orders freeze their QC/QA checklist contents at kit release; editing a product checklist later does not change an active job. Legacy released jobs lack a historical snapshot.

**Mobile step 6 (2026-10-14):** hold decisions persist their exact outcome, reason,
disposition/rectification station, reviewed hold record and retry key before POST.
Inputs lock while sending; an uncertain decision explicitly replays the original
payload/key after restart. Scoped saved decisions stay discoverable even after the
unit leaves the authority hold list; Work counts merge live holds with saved records.
A definitive refusal requires reloading the current hold before correction with a
new key; key conflicts and expired attempts require supervisor reconciliation.
Backend `expected_hold_record_id` is optional for compatibility and returns
`409 code: stale_hold` if the unit now belongs to a different hold episode. Site-PC
acknowledgements remain pending through their original sync command. A confirmed
pass means Products In eligibility, not stock entry. Hold lookup failures (403,
server/network failure or a stuck request) show an unknown count and retry; a late
response after timeout does not paint an empty/success state. Hold-only reviewers
get review controls without inspection actions. Missing durable storage prevents
mutation. Figma 72:16, 72:396 and 72:435 were reviewed; Chromium restart tests at
390×844 covered pass, rectify and fail with one operation across two identical
requests. Focused tests also cover stale/new holds, corrected keys, local pending
results, scope isolation, storage failure and unknown/timeout counts.
Validation: TypeScript passed; four focused files passed (111 tests), with the final
mobile route checks also passing (93 tests). Full regression: 2,609 passed, with
only the previously reproduced HR payslip ownership failure
(`tests/payslip-owner-rename.test.ts:75`). All three 390×844 Chromium restart checks
passed with identical keys/payloads and one applied decision each.


**Mobile step 7 (2026-10-14): separate QC/QA unit reports and photos.**
QC/QA verify, recheck and review screens, plus the unit dossier, open **Issues and
photos** (`#/unit-issues?unit=...&role=qc|qa`). Each finding gets a separate report
(category, severity, description) with its own photo set: chassis and fairings can
be reported independently on one unit. Multiple unsent drafts on that unit retain
compressed photo bytes across restart, scoped to the account and API server. Work
has **Saved unit issue reports** for recovery. During an authority outage, saved
unit context permits reopening/editing drafts and starting another finding; live
reported issues show unknown, and submission waits for reconnect/reopening the unit.
A 403/404 does not fall back to saved context. Visible defects require a photo in
the phone form; an unphotographable issue can be saved as text by clearing that
checkbox. This is the recommended default pending an owner preference.

Report creation and individual photo uploads persist immutable keys before sending.
Unknown responses lock the original attempt for explicit recovery; confirmed photos
are skipped. Definitive refusals permit reviewed corrections with fresh keys;
expired/key-conflicting attempts require supervisor reconciliation. Site-PC results
remain pending until their original command confirms. Reporters and managers can
edit open reports, add photos, resolve and reopen. Backend ownership/status checks
also guard photo changes. Narrow inspectors read unit-linked reports/photos, not
the company-wide report feed. Ordinary reports remain informational; the inspection result
controls advancement, and **Pause** stops line work. The existing special
**Product-data mismatch** RTS blocker remains in force.

**Use issue-report photos** reuses the inspector's own, unused photos of this same
unit for fail/repair/hold evidence; it does not upload another copy. The backend
accepts both `qc_unit` and unit-linked `production_issue` evidence, retaining the
same inspector, unit and one-record rules. Evidence photos cannot be deleted.
No schema migration was needed. Figma 69:104, 69:364, 72:104 and 72:363 were reviewed;
shared role/photo/draft primitives were reused, route inventory and PWA cache updated
(v94). Real Chromium at 390×844 verified multiple saved drafts, actual large-image
compression, lost report/photo responses across restart, identical retry keys/bytes,
two distinct reports/photo links and no horizontal overflow, including disconnected
authority APIs while editing/recovering drafts. TypeScript and all 141 focused tests
passed. Full regression: 2,621 passed; only the existing, baseline-reproduced
`tests/payslip-owner-rename.test.ts:75` HR ownership failure remains (2,622 total).

**Mobile step 8 (2026-10-15): RTS stock-entry recovery.**
Serialized/grouped and non-serialized batch receipts now persist their exact
Products In payloads and keys before the first stock request. The shared scoped
IndexedDB store uses separate `rts-unit` and `rts-batch` namespaces; batch keys also
prevent two tabs creating separate attempts for the same batch. Each job order in
a group retains its own receipt, key, status and sync command. A lost response locks
original units/location/quantity/notes for **Retry original** after restart;
confirmed job orders are skipped and not-started ones are retained. The recommended
partial-group behavior keeps confirmed entries and recovers only the unresolved
ones. Receipt requests never enter the background offline queue.

**Saved stock entries** remain discoverable at the top of RTS even after the units
leave the live queue or the queue is unavailable. Live queue failure/timeout shows
an unknown count; a late timed-out response cannot paint a success/empty state.
Work counts merge unresolved saved units/batches with live candidates. Opening an
involved unit/batch routes to its retained attempt instead of generating a replacement.
A definitive refusal requires **Review remaining entries**, which returns to live
unit/batch review for a corrected request with a fresh key; confirmed stock remains
recorded. Unknown, expired/key-conflicting or pending site-PC attempts cannot be
cleared this way. Expired/conflicting attempts require supervisor reconciliation.
Local command acknowledgements stay pending and block the next group entry until
confirmed; failed/conflicting commands retain their original record for reconciliation.
Only fully confirmed results say Ready to sell or offer Record next/Print. Batch
entry rejects blank, fractional, negative and excessive quantities rather than
truncating/clamping user input into a stock request.

Implementation: `manufacturing/rts-recovery.js` reuses the existing draft, role and
sync-watch primitives; `receiving.js` keeps the current backend receipt/RTS checks.
No backend/schema changes were needed. Figma 74:16, 74:145, 74:280, 74:316 and 74:356
were reviewed; PWA cache is v95. Real Chromium at 390×844 covered single-unit,
partial-batch and multi-job-order restart recovery with identical keys/payloads,
no duplicate stock, saved-entry discovery during a failed queue lookup and no
horizontal overflow. TypeScript and all 152 focused tests passed. Full regression:
2,635 passed; only the existing, baseline-reproduced HR ownership failure remains
(`tests/payslip-owner-rename.test.ts:75`; 2,636 total).

**Mobile step 9 (2026-10-15): releasing acceptance and allocation.**
The release queue now separates **To accept**, **Allocating**, **Ready** and
**Blocked**; only accepted, fully allocated orders contribute to Ready for handoff.
Cards and stock review identify the ship-from warehouse. Bulk quantities use the
remaining demand capped by `context.availability[].free_to_allocate`, preserve
valid decimals and reject blank/non-positive/excessive input. Zero-free-stock lines
cannot be added. Serialized preview includes the unit's `location_id`; the phone
blocks a different ship-from location before allocation, while backend checks
remain authoritative.

Acceptance and serialized/bulk allocation persist an exact account/server-scoped
`release:<order>:action` record before POST. `inventory/release-actions.js` retains
the original JSON payload/key across response loss and restart, blocks replacement
of unresolved actions, and exposes saved actions even if the live queue is missing.
An exact retry applies once; allocation reserves goods and does not deduct stock.
A definitive refusal requires reviewing refreshed order/stock context before a
corrected key. Expired/key-conflicting attempts require reconciliation. Site-PC
results stay pending through their original sync command; failed/conflicting
commands remain retained. Completed actions also require fresh order review before
continuing. Acceptance gates allocation screens; account/server changes clear the
in-memory handoff state. No background submission or schema change was added.

Figma 78:16, 78:68, 78:109 and 78:147 were reviewed, using shared role/draft/sync
primitives. PWA cache is v96. Chromium at 390×844 verified acceptance, decimal bulk
and serialized allocation after a committed response loss/restart: identical keys
and payloads, one operation, saved-action discovery despite a failed live queue,
and no horizontal overflow. TypeScript and all 163 focused checks passed. Full
regression: 2,644 passed; only the previously baseline-reproduced HR payslip
ownership failure remains (`tests/payslip-owner-rename.test.ts:75`; 2,645 total).
**Remaining:** durable warehouse-out photo/signature/slip recovery, mobile undo of
allocations, accurate bulk/mixed warehouse-out result copy, legacy Pick retirement,
and delivery/return integration still need their own steps. This step does not
claim those gaps are closed.

**Remaining in this section:** the first two original audit rows below are fixed.
Checklist configuration conflicts, stage grouping and ordinary queued-inspection
result copy remain open; RTS receiving recovery is completed in step 8; releasing and delivery integration
are the next pipeline steps.

| Priority | Mobile evidence | Handoff to mobile owner |
|---|---|---|
| **Critical** | `public/mobile/modules/manufacturing/qc.js` sends every QA hold decision with `idempotencyKey: 'hold-' + h.record_id`. The server now rejects reuse of a JSON key with a changed body (`409`); an exact retry replays the first response. | Bind a retry key to the exact immutable hold decision (pass, rectify or fail, reason and related fields). Reuse it only for that same payload after an uncertain result. If the choice changes, create a fresh key after reloading the hold/unit state. Treat a changed-body `409` as a conflict needing review, never as success. |
| **High** | The mobile QC queue turns a failed `GET /qc/holds` into `[]`, then shows zero holds. | Show an **Unable to load holds / Retry** state and unknown count on 403, offline, timeout or server failure. Do not tell a hold reviewer that the queue is empty unless the fetch succeeded. |
| **High** | Checklist answers in `qc.js` use item labels as keys. The backend now rejects duplicate labels within new checklists and blocks a new single-stage kit release if its QC/QA lists collide (`409 blocked: checklist`); an older active job with a collision is blocked at inspection. It also rejects mixed-stage unit selections and a passed measured check without a reading. | Show the checklist conflict as a configuration blocker with a path to a manager, not a generic retry. Group bulk actions by one inspection stage. Preserve readings and Pass/Issue/N/A per check; refresh the frozen job checklist after a conflict. Stable stage-qualified IDs remain the long-term contract. |
| **Medium** | The ordinary inspection flow distinguishes queued from recorded submissions, but some result copy still says “Recorded by” for a queued action. | Use **Queued on this device**, **Saved on site PC**, and **Confirmed by site authority** according to the actual response. Show final pass and Products In eligibility only after authority confirmation. |

**Mobile acceptance cases:** QC and QA checks with the same visible label; hold decision response lost after the server commits; reviewer changes a hold decision after a definitive response; hold fetch returns 403/500 or times out; queued inspection later conflicts or fails; final QA pass remains outside stock until Products In. Exercise inspector and hold-review roles on narrow phone screens and through offline/reconnect transitions. Backend checklist identity and evidence rules are still being refined, so align the phone contract with the finalized API before closing this handoff.

## Production recording: mobile handoff (accepted kit → output and line issues)

**Mobile step 1 (2026-10-14):** serialized recording recovery now persists entries,
photo bytes and immutable upload keys across browser restarts using
`public/mobile/lib/production-drafts.js`. Unknown attempts lock their original
payload and retry the same key; results retain unit IDs and distinguish site-PC
pending saves from authority confirmations. Drafts are scoped to account and
server/tenant; stale tabs cannot overwrite newer attempts. Entries never submitted
can be discarded separately from saved or uncertain attempts. Verified with
focused route/storage tests and Chromium at 390×844, including browser restart
after a simulated committed upload whose response was lost. Acceptance, bulk/scrap
retry keys were still pending at that step; they are covered by step 3 below.
Full issue management remains open.

**Mobile step 3 (2026-10-14):** kit acceptance, bulk output and scrap now persist
immutable JSON attempts using the account/server-scoped production draft store.
They send stable keys, lock submitted input, retain the original payload across
response loss/restart, and require explicit recovery before another recording
attempt. A definitive refusal is shown for review; returning to the job clears
that refused attempt so a corrected request receives a fresh key. Site-PC saves
remain pending until command confirmation. Expired/conflicting attempts require
reconciliation. Quantities reject blank, fractional, negative and over-remaining
values; pending/rework/held units are included in the still-to-record count.
Chromium restart checks at 390×844 cover all three actions: two identical requests,
one key, one applied operation. Kit release, QA hold and RTS key corrections remain
separate follow-up steps.

**Owner decision (2026-10-14):** kit/line reports stay informational. They do not
automatically block kit acceptance or production recording; Pause is the action
that stops work. The mobile kit-report copy now states this rule. Unit-linked issue listing, editing and resolution are now covered by step 7 above.
Whole-job kit/line issue management remains a subsequent implementation step.

**Verification:** TypeScript passed; the full regression run passed 2,563 tests,
with one existing failure in `tests/payslip-owner-rename.test.ts:75`. The identical
failure was reproduced on an untouched `709d0ad` checkout. Focused storage, route,
upload replay, shared-phone and PWA checks passed. A real Chromium restart retained
the original photo and key after simulated server commit/response loss: two HTTP
attempts, one operation key and one created unit, with no horizontal overflow.

**Owner decision for the next close-out step (2026-10-14):** closing early must stop
only unbuilt output and return unused components. Already-built units must remain
available for QC/QA, rework and receiving. This rule is now implemented: early close
preserves those units and open repair requests, returns unused components, refuses
new recording and defers WIP settlement until preserved output is resolved/received.
The phone confirmation subtracts built unresolved units from the unbuilt count.

**Phone photo compression (2026-10-14):** ordinary `mPhoto.pickFile()` and default
multi-photo pickers use the shared compressor before size validation and before
production drafts/retry payloads are frozen. JPEG/PNG/WebP over 1 MB use the existing
1920px / 0.82 JPEG settings when the result is smaller. Custom anonymous preparation
retains its stricter metadata-stripping contract; signatures and already-prepared
attachment blobs are not recompressed during upload. Chromium verified a large
3200×2400 photo shrank from approximately 26.4 MB to 1.55 MB at 1920×1440.

**Owner:** mobile developer. **Checked against code:** 2026-10-14. **Status:** open. Backend and desktop recording were audited and refined; no `public/mobile/` source was edited. The current server accepts a stable `Idempotency-Key` for `POST /api/job-orders/:id/accept`, `/progress`, and multipart `/units`. Retrying the *same request with the same key* replays its result without consuming parts or creating a second unit. `API.upload(path, formData, { idempotencyKey })` now supports that header on desktop; check the mobile API wrapper's equivalent before wiring it there. A finished unit still needs one identifier and photo in the same multipart request. Bulk output and scrap still use `/progress`, and neither path adds finished stock until Products In.

| Priority | Mobile evidence | Handoff to mobile owner |
|---|---|---|
| **Critical** | `public/mobile/modules/manufacturing/job-orders.js` `uploadUnit()` calls `API.upload` without a retry key and marks `r.saved` only after receiving a response. `interrupted()` states that every unsaved row is “still to send” and retries it. | Give each row a stable key for the exact identifier, batch and photo; retain it across a lost response and retry the same request. Label that row **confirmation unknown** until a replay or server check confirms the unit ID. Never infer “not saved” from a timeout, and never create a new key for an uncertain attempt. Show confirmed rows separately from uncertain and untouched rows. The returned unit ID is the reliable link to its photo and QC record; identifiers are not unique. |
| **High** | `output()` and `scrap()` post physical progress with no retry key; their failure path leaves the result uncertain. `acceptKit()` has the same issue. | Use stable per-attempt keys for acceptance and bulk/scrap progress. On a lost response, retry the exact payload with its key or refresh the job and its batch/unit record before claiming success or failure. Distinguish confirmed by the site authority from saved only on a PC (`API.syncLocal`). Do not double-consume parts on reconnect. |
| **High** | The mobile `remaining(jo)` calculation subtracts only `qty_done` and `qty_scrapped`, omitting units pending QC, in rework or on QA hold. It can invite recording more units than the server allows. | Show **still to record** as ordered minus done, scrap and unresolved units; label pending inspection separately. Refresh this count after each saved unit, inspection and scrap result, and keep the server's overage rejection authoritative. |
| **High** | `output()` uses `parseInt()` for finished and scrapped quantities; `scrap()` uses it for scrap. Decimal input such as `1.5` silently becomes `1`. | Parse the full value and reject non-whole, negative, empty or over-remaining quantities before posting. Use integer input hints, but still validate typed and pasted values. The server remains the final capacity check. |
| **High** | `problem()` reports only a kit-level issue, while the active production view has no way to list, edit, resolve or reopen line and unit issues. Its copy says a kit issue blocks recording until Warehouse resolves it, though the backend records issues without such a block. | Add an issue list and report action from the active job and unit record. Show category, severity, description, reporter, status, resolution and attached photos; allow reporter or manager to edit and resolve/reopen under the server's permissions. `production.manage` can now manage another worker's issue. Make the issue/acceptance copy match the actual gate: output needs kit acceptance, but an open issue by itself is informational. Pause separately when work must stop. |
| **Medium** | `sessions[jo.id]` and per-row photos live in memory. Leaving the view or reloading after an interrupted upload loses the unsent form, while the message says identifiers and photos are kept. | Keep unsent entries only while the browser truly retains them, or persist a recoverable draft with a clear photo-retake state. On reopening, refresh actual server units before showing an interrupted summary. Never promise a retained photo after a process restart unless its bytes are stored. |
| **Medium** | `interrupted()` reports “Recorded N of M” using only locally observed responses; an uncertain row is included in “still to send.” | Use **confirmed / confirmation unknown / not started** language. Disable edits to an uncertain row until its original key is replayed or an operator explicitly reconciles it. A local-only sync result must be shown as pending, not final production output. |

**Mobile acceptance cases:** response lost after a unit commit; same-key multipart replay returns the original unit ID and one photo; two distinct units with the same identifier remain distinct; response lost after `/progress` or kit acceptance; user changes a rejected row and gets a fresh key; decimal and over-remaining input are rejected; an open issue is visible but does not claim an enforced production block; a manager resolves a lead's issue; returning after app restart does not claim an in-memory photo still exists. Test these in the mobile route suite and verify the phone layout at narrow widths before marking this section complete.

## Production kit: mobile handoff (approval → pick → release → lead acceptance)

**2026-10-14 optional location hierarchy:** `GET /api/locations` and `GET /api/locations/:id` now return `parent_id`, `path` and `depth` (maximum five levels). Existing flat locations remain roots. Desktop New Item asks for a root starting-stock location and reveals each optional child level only after **+ Add level**; stock is placed at the last selected level. Mobile source was not changed. Update `mLocations` and the stock-in/out, receiving, transfer and kit pick views to display `path` so duplicate shelf/bin names in different warehouses are distinguishable. A parent can still hold direct stock, so do not assume its children's stock is available at the parent's ID. Test root-only, five-level selection, duplicate child names under different roots, and offline sync of a leaf `location_id`.

**2026-10-14 completion of that step:** `GET /api/locations` and `/:id` now also return `total_units`/`item_count` for the exact node and `subtree_units`/`subtree_item_count` for all levels below it. Never use the roll-up as pickable stock; every receipt, transfer, kit pick and stock move still requires one exact `location_id`. Desktop New Item can choose existing children or enter new names behind each **+ Add level**; `POST /api/inventory` accepts `location_id` (last existing parent) plus optional `new_location_levels: string[]` (up to four). Item, new locations and initial stock save atomically. Item records now expose `preferred_location_id` even with zero stock; editing the preference does not transfer stock. Mobile must show that difference, show full paths in duplicate-name pickers, and keep a stable location ID in queued/offline requests. Test parent direct stock versus descendants, same-named shelves under different warehouses, a failed item save rolling back new levels, and a receipt at one shelf leaving a kit at another shelf short. No mobile source was edited.

**2026-10-14 component shortage recovery:** `GET /api/job-orders/:id/availability` now also returns `purchase_requirements[]` (`component_item_id`, `need`, `have`, `held_elsewhere`, `available`, `short`, `pending_purchase`, `to_purchase`) and `linked_purchase_orders[]` (`id`, `number`, `item_id`, `outstanding`). A PO draft never makes a blocked kit releasable. `POST /api/job-orders/:id/purchase-shortfall` is repeat-safe for a draft job order: it creates only demand beyond live linked PO outstanding quantities, accounting for edits, cancellation and partial receipts. A receipt at another location does not fill the job's source-location stock. The phone's `kit-release.js` currently shows the shortage and files a tracked issue, but does not show pending PO supply or offer a procurement handoff. Show the pending PO numbers/remaining quantities and source location in the blocked screen for authorized warehouse readers; route purchasing actions to staff with `inventory.adjust`, rather than implying the warehouse clerk can buy parts. Refresh after a receipt, PO change or retry. No mobile source was edited.

**Sale-linked job exception:** Availability now has `supply_planning_order: {id,number}` when a job belongs to a sale. In this case `purchase_requirements` and `linked_purchase_orders` are empty because the sale owns aggregate component procurement; the kit's `lines` and `shortfalls` still show its local stock gap. Do not draft from the job. `POST /api/job-orders/:id/purchase-shortfall` returns `409 code:'sale_supply_owner'` with that order; route authorized staff to `GET /api/orders/:id/availability` and the sale stock review, then use the sale's `purchase-shortfall` action. Show the order number on the mobile blocked-kit screen. Sale cancellation or closure also blocks job-level procurement until the link/planning ownership is resolved by a supervisor.

**Owner:** mobile developer. **Checked against code:** 2026-10-14 on `restructure/module-architecture`. **Status:** warehouse phone fixes completed in step 4; manager approval review completed in step 5. Desktop and mobile support partial picks and corrections.

**Mobile step 4 (2026-10-14):** warehouse acceptance, per-component picking and
physical release are now separate phone actions. Queue availability failures go to
Review, never Ready; Ready requires the server's `releasable` flag. Picking shows
accepted, partially picked and fully picked stages, supports partial counts and
pre-slip corrections, and distinguishes on-hand, held and free stock at the source.
Unsaved count edits disable release until they are saved or restored; unchanged
picks do not generate unnecessary commands. Final confirmation reloads availability.
Each action persists its immutable JSON payload and retry key in account/server-scoped
IndexedDB before POST. Interrupted attempts reload job/slip context and explicitly
replay the original action; retries survive browser restart. Definitive refusals
require review before correction, while expired/key-conflict attempts require
supervisor reconciliation. Site-PC results remain pending and are watched through
the original sync command. Cached local acknowledgements now preserve their sync
headers on backend replay. Both shortage response shapes are shown correctly;
commitment shortages prompt review rather than blanket replenishment. Non-released
deep links show their actual status. Shortage report drafts are account/server scoped.
Figma 62:14, 79, 150, 205, 264 and 317 were reviewed; Chromium checks at 390×844
covered restart and identical-key/payload recovery for all three actions.
Validation: TypeScript passed; five focused test files passed (113 tests), with the
final mobile route checks also passing (76 tests). Full regression: 2,586 passed,
one previously reproduced HR payslip ownership failure
(`tests/payslip-owner-rename.test.ts:75`). No new regression failures.


**Mobile step 5 (2026-10-14):** managers and narrow `production.approve` holders
can open Awaiting approval from Work and the Production hub; production managers
also have an entry in manager control.
Draft review shows quantity, source/output locations, team/schedule, planner notes,
inspection stages, planned component snapshot and live on-hand/held/free/picked stock.
Short demand can still be approved after acknowledging warehouse follow-up; approval
does not deduct stock. Unknown stock or inconsistent plan/availability loads block
approval until refreshed. Backend detail and availability return `approval_revision`;
approval accepts optional `expected_revision` and returns `409 stale_job_order` when
the reviewed plan changed. Content revisions include plan/component/checklist fields,
not live stock or second-resolution update times. Existing clients without the optional
revision keep their contract. Availability permits narrow approvers without broad
inventory reads. Approval attempts persist the original note, plan summary, revision
and key across restarts; exact replay applies once. Refusals require fresh review/key.
Saved attempts remain discoverable in the approval queue even after the authority
removes an approved draft, and badge counts merge server drafts with scoped recovery
records. Site-PC acknowledgements remain pending. Manager issue cards use Open issue,
consistent with informational reports and separate Pause. Figma 66:515 and 66:580
were reviewed; Chromium verified the 390×844 queue, short-stock acknowledgement,
restart discovery and identical-payload/key recovery.
Validation: TypeScript, focused approval/recovery tests and the narrow-role access
matrix passed. The final full regression run loaded the final permission gate:
2,598 tests passed; the sole failure remains the previously reproduced HR payslip
ownership case (`tests/payslip-owner-rename.test.ts:75`). Chromium restart recovery
applied one approval across two identical-key/payload requests at 390×844.


**Remaining in this section:** full production issue management remains a later
step. Production acceptance recovery and informational issue copy were completed
in step 3. The audit table below records the original gaps; rows 1–6 and
9 are addressed by step 4, row 8 by step 3, and row 7 by step 5.

The server's `GET /api/job-orders/:id/availability` reports each component's `need`, `have` (source-location on-hand), `held_elsewhere` (other kit picks and repair holds), `available` (free at that location), and `short`. Its `releasable` flag also requires approval, warehouse acceptance and a fully prepared kit. `GET /api/job-orders/pick-list?ids=…` reports `held_elsewhere` and `free_for_list`. The final `POST /api/job-orders/:id/release` checks free stock again, issues one numbered parts slip, deducts the components, and changes the job state in one transaction. Warehouse acceptance and picking are separate earlier actions; a failed *chain* can leave those stages saved even when no slip or stock deduction occurred.

| Priority | Mobile evidence | Handoff to mobile owner |
|---|---|---|
| **High** | `public/mobile/modules/manufacturing/kit-release.js` `queue()`: an availability request error sets `_short = null`; `!j._short` then places the kit in **Ready**. | Add an **Availability unknown / retry** state. A failed lookup must never increase the ready count or invite release. Show approved, accepted, partially picked and fully picked stages separately; `shortfalls.length === 0` alone does not mean `releasable`. |
| **High** | `kit-release.js` `verify()` displays `Math.min(l.have,l.need) / need` and `confirm()` reloads availability but does not inspect `shortfalls` or `releasable` before offering the final action. | Display source location, on-hand, held, free, needed and picked quantities. Recheck the current server state before confirmation, including direct links to `?step=confirm`. Keep the server's final check authoritative when stock changes later. |
| **High** | `kit-release.js` `confirm()` calls `/warehouse-accept`, `/prepare` (full pick), then `/:id/release` without `idempotencyKey`. `public/js/api.js` sends `Idempotency-Key` only when the caller opts in. A failed request currently shows a generic release failure even if acceptance or pick saved. | Use a stable retry key for the physical release request, follow any `API.syncLocal(result)` command instead of treating a PC-local save as final, and reload the job and slip after a timeout/409 before retrying. Show which earlier stages actually saved. Do not state “nothing was saved” for an uncertain network outcome. The three calls are **not** one atomic operation. |
| **High** | `kit-release.js` maps every shortfall as `{picking,available}`. `/prepare` returns that shape, while final `/:id/release` returns `{need,have,held_elsewhere,available,short}`. | Parse the two response shapes separately; otherwise a final-release refusal displays missing quantities. After either refusal, refresh availability and do not show a success/slip until the authority confirms one. |
| **High** | `kit-release.js` only offers a one-tap full pick. Desktop can save per-component partial counts, correct them, then issue the slip. | Give warehouse phone users partial-pick and pre-slip correction parity. A phone-heavy warehouse must be able to finish a normal partial kit without switching to desktop. Keep release all-or-nothing; a partial pick does not deduct stock. |
| **Medium** | `kit-release.js` `blocked()` and `report()` say stock must be corrected/replenished even when on-hand is adequate but held by another kit or repair. | Distinguish physically missing stock from committed stock and route the latter to commitment review/reassignment. Include on-hand, held, free and source location in the report. |
| **High** | `public/mobile/modules/manufacturing/production.js` and `job-orders.js` manager lists only show released/in-progress/paused work. `draftView()` can approve a direct-linked draft but shows no components, source location or availability. | Add a discoverable **Awaiting approval** queue using `GET /job-orders?stage=awaiting_approval`; let managers inspect the component snapshot, quantity, location and stock warnings before signing. Approval plans demand; a short kit may still be approved, but must be clearly marked for warehouse follow-up. |
| **High** | `job-orders.js` `acceptKit()` has a count checkbox and calls `/:id/accept` without a retry key or read-after-error. `problem()` says “Production stays blocked until Warehouse resolves it.” The issue route records an issue, but `needsAcceptance()` and `/:id/accept` do not check open issues. | After an uncertain acceptance response, reload `accepted_at` before retrying or claiming failure; use a stable key where supported. Align the issue message with actual enforcement. If unresolved kit issues should gate acceptance, coordinate a backend rule before promising that block in the phone UI. The current gate is only “accept before recording output.” |
| **Low** | `kit-release.js` `withJob()` routes any non-draft job to `done()`, whose headline says parts released successfully. | Confirm a parts slip/released state before showing success; a cancelled or otherwise non-draft deep link should show its real status. |

**Mobile acceptance cases:** an availability fetch fails; stock is on-hand but held elsewhere; the warehouse accepts an order and picks only some components; a partial count is corrected; stock changes between verify and release; final release returns its own shortfall shape; a timeout occurs after warehouse acceptance, after prepare, after physical release, and after production-lead acceptance; a site PC returns `X-Sync-State: local`; a lead reports a kit issue then revisits acceptance; a manager finds and reviews an unapproved draft; a non-released deep link does not claim a completed handoff. Add these to the mobile route tests in `tests/frontend-mobile.test.ts` when implementing. Current tests cover the happy-path chain and prepare-style shortage, but not these cases.

## New handoff: rejected-return disposition and repair

**Backend/desktop ready; mobile owner action required.** A rejected `sales_returns` receipt remains outside sellable stock. `GET /api/sales-returns/slips/:slipId/context` and `GET /api/sales-returns/:id` now include `disposition_state`, `decision_note`, and `repair_note`; `GET /api/sales-returns/:id/events` returns the decision history. `POST /api/sales-returns/:id/disposition` (`inventory.adjust`, physical sync) takes `{decision:'repair'|'salvage'|'dispose', note, location_id?}`. Repair is available only for a tracked serial. Salvage requires a location and adds only to the item's damage twin. Disposal adds no stock. A disposition can be recorded only once.

For a serialized repair, the unit becomes `returned_rework`. Production can use `POST /api/production/units/:unitId/repairs` for parts; the warehouse queue returns `sales_return_id` and `sales_return_number` on these requests. `POST /api/sales-returns/:id/repair-complete` takes `{note}` and refuses while parts requests are pending. `POST /api/sales-returns/:id/reinspect` (`inventory.adjust`, physical sync) takes `{decision:'restock'|'reject', condition_note, location_id?}`. A failed reinspection returns the unit to repair. A pass alone adds original-item stock and makes the serial available, without a second job-order completion or production receipt. All step buttons should reflect authority-confirmed states, show pending/conflict results, and retain idempotency keys across retries. Do not use the original `job-orders/:id/units/inspect` or `products-in` path for sold returns.

**Mobile gaps:** `public/mobile/` currently has no return-disposition, rework-completion, or return-reinspection screen. Add an operator path from the original slip/return with the state-specific actions, a parts-request link for production, and a clear damage-stock versus sellable-stock result. Bulk rejected goods currently support salvage or disposal; serial-level repair is required for the repair path. The backend currently permits only one lifetime return per serial because `sales_returns.unit_id` is unique; a later resale and second return needs a schema/API follow-up before the phone should offer it. Mobile source remains owned by the mobile developer and was not edited here.

## New handoff: customer returns after a release slip

The desktop/backend return flow now starts from an issued slip. `GET /api/sales-returns/slips/:slipId/context` gives the shipped line remainder and sold serial choices. `POST /api/sales-returns` records one shipped line, quantity or exact unit, reason, and one or more photos uploaded as `sales_return_proof` with `ref_id=slipId`; the server attaches the photos to the numbered return. Receipt **does not add stock**. `POST /api/sales-returns/:id/inspect` (`inventory.adjust`) records a condition and either `restock` with a location or `reject`. Only restock adds stock and makes a sold serial available again. Finance separately issues a customer credit note linked to the original sale order, then uses `POST /api/sales-returns/:id/link-credit` (`accounting.manage`). Do not let a warehouse account create or imply a refund.

**Mobile owner action:** add a return entry point from a completed V2 slip, a camera-backed receipt, a clearly permissioned inspection step, and pending/site-confirmed/error states. Give each receipt and inspection a stable idempotency key across retries. Show remaining returnable quantity and require the exact sold serial; refresh on `409 return_exceeds_shipped`, `return_serial_required`, or `return_inspected`. Do not change the shipped sale status or post a positive stock adjustment directly. No `public/mobile/` files were changed in this step.

**Owner:** mobile developer. **Audit date:** 2026-10-13. **Branch:** `restructure/module-architecture`.
**Scope:** sales intake → availability/approval → shortage drafts → warehouse release → production receipt. Mobile implementation was inspected only; no files under `public/mobile/` were changed.

Desktop/backend stage 2 now uses the ship-from warehouse, sale commitments, draft kit picks and repair holds. Production and purchase drafts cover *planning* demand, never stock availability. See [the operator guide](docs/guides/sales-stock-approval.md), [pipeline](docs/modules/pipelines.md#sales-order-fulfillment), and [API reference](docs/reference/backend/modules/inventory/order-availability.md).

### Warehouse release follow-up (stage 3)

The backend now validates each allocation request against uncommitted stock at the sale's ship-from location, rejects bulk entry for serialized products, and rejects ambiguous duplicate stock lines. `GET /release-slips/orders/:id/context` now returns `order.location_name` and `availability[]` (`item_id`, `free_to_allocate`, `on_hand`, `committed_elsewhere`, `kit_held`, `repair_held`). `GET /release-slips/queue` includes `location_name`. These fields are read-only context for the phone; the server remains authoritative when stock changes between viewing and posting.

| Priority / state | Mobile evidence | Follow-up for mobile owner |
|---|---|---|
| **High — fixed in step 9** | `so.js` `queue()` labels unaccepted, partially allocated orders “Ready for handoff” unless authorization/reports block them | Separate **To accept**, **Allocating**, **Ready for handoff**, and **Blocked** or change the hero and card language. A valid token does not mean goods are ready. Display ship-from location on cards. |
| **Medium — fixed in step 9** | `so.js` `scan()` offers the full order remainder as a bulk default and `parseInt()` truncates fractional units | Use `context.availability[].free_to_allocate`, a decimal-safe input for measured goods, and a blocked state when local uncommitted stock is zero. Keep `409` refresh/review behavior when availability changes. |
| **Medium — fixed in step 9** | `so.js` `unit()` shows any in-stock unit on this order as “Ready to sell” without checking its location in the preview | Show the unit's location against `context.order.location_name` before confirmation; the release API now rejects wrong-location units. Guide staff to transfer stock rather than retrying the scan. |
| **Medium — open** | `so.js` `done()` hardcodes “Unit released” and “Inventory updated” for bulk and mixed orders | Use actual slip line quantities and show whether the result is confirmed at site authority or saved locally awaiting sync. Avoid saying “unit” for a bulk-only sale. |

The canonical V2 release flow and its photo, token, package, partial-release, and retry-key checks remain the path to build on. Do not restore the legacy Pick stock adjustment route. See `docs/reviews/warehouse-release-audit.md` for backend and desktop findings.

### Backend protections added after the stage 3 audit

- New legacy `POST /inventory/:id/adjust` requests with a negative change and `reason:'Picked for order …'` now return `409 code:'use_release_workflow'`. Previously recorded offline commands may replay; the old Pick screen must be retired or redirected to V2 release/production kit flows. Until then, show this error as a blocked workflow, never as “picked.”
- A stock sale that has entered warehouse acceptance, or has a delivered proof, cannot be confirmed/completed/fulfilled without a release slip. `POST /orders/:id/status` and order editing return `409 code:'release_required'`, including when `force:true`. The legacy Delivery completion prompt must direct the user to the warehouse/Sales handoff instead of offering “Complete as backorder.”
- Once a release slip exists, the sale cannot be reopened, cancelled or deleted through ordinary order actions (`409 code:'already_shipped'`). A real physical return needs a separate return/correction workflow; do not imply that cancelling the order puts goods back on hand.
- Slip creation and stock movement now commit atomically. If stock posting fails, the slip and order status roll back; retry after the error is resolved. Accounting COGS is a separate idempotent follow-up and can retry without a second stock movement.
- `POST /orders/:id/release/unreserve` now rejects missing/duplicate units and quantities greater than the actual bulk allocation instead of silently succeeding. The desktop view exposes an undo action. V2 mobile currently has no equivalent; add an explicit, permission-checked correction step before slip issuance. A slipped order remains irreversible through this endpoint.

## Gaps for the mobile developer

| Priority / state | Evidence | Gap and requested follow-up |
|---|---|---|
| **High — mobile change required** | `public/mobile/modules/inventory/orders-fulfil.js`: `pickForm`, `postLine`; registered `pick` route in `public/mobile/app.js` | Legacy Pick lists open sales/jobs and posts `/inventory/:itemId/adjust` with a negative quantity. The backend now rejects its `Picked for order …` adjustment instead of risking a second deduction. Retire or redirect the legacy sale pick route to `so`; investigate job-order picking separately. Preserve intentional stock-adjustment tools outside fulfilment. |
| **High — open** | Same file, `postLine`, “Pick all lines” | Local `done` is set for queued work and the result says “Picked”; per-line errors are caught, so a batch can show success after some failed lines. Progress is memory-only and resetting the screen can submit the same demand again. Require durable order allocation, explicit partial/error states and authority-confirmed results. |
| **High — mobile change required** | `public/mobile/modules/inventory/deliveries.js`: `completeOrder` | Delivery completion offers `{status:'completed',force:true}` after a stock 409. The backend now refuses completion without a slip once warehouse acceptance or delivery proof exists, even with `force:true`. Handle `code:'release_required'` by routing unresolved warehouse work to Sales/releasing staff; do not offer “Complete as backorder” for this case. Do not introduce a second deduction after a slip. |
| **Medium — open** | `orders-fulfil.js`: location selector, `parseInt` quantity input | Legacy picking uses a generic location selector instead of the order's ship-from location, and truncates fractional quantities. The replacement should use order context and remaining quantities; ignore non-stock lines and preserve valid measured quantities. |
| **Medium — product decision** | No sales `GET /orders/:id/availability`, `produce-shortfall` or `purchase-shortfall` calls under `public/mobile/` | Mobile warehouse roles intentionally start after Sales approval; they do not need CSR/procurement rights. Decide whether to add read-only shortage context to release queues, or give authorized mobile Sales/Purchasing roles their own review screen. Do not label an authorization-valid order “stock ready” using authorization state alone. |
| **Medium — open** | `deliveries.js` status calls; new optional revision fields | Existing mobile callers do not send a review revision. API compatibility is retained, but they can act on an old order view. For any new decision/review screen send the latest `revision`; handle `409 code:'stale_order'` by refreshing and requiring a new decision. Never silently force a stale decision. |
| **Medium — review** | `public/mobile/lib/queue.js`, legacy receive/pick results | `mSubmit` distinguishes `{queued:true}` from `{ok:true,response,local}`. Audit each result screen for queued, saved on PC, confirmed by site/cloud authority and rejected states; a local response must not look like cloud confirmation. V2 release/RTS already use `API.syncLocal`; keep that behavior. |
| **Low — open** | `public/mobile/modules/inventory/so.js`: allocation stage | Mobile release does not show the new breakdown of other orders, kit holds, repair holds and stock elsewhere. Backend checks still enforce release rules. Read-only shortage detail would make blocked stock easier to explain. |

## Integrations already aligned

- V2 `so.js` uses `/release-slips/queue`, order context, warehouse acceptance, `/orders/:id/release`, then `/orders/:id/release-slip`. Allocation reserves stock; a slip records physical warehouse-out. It uses retry keys, authorization/package/evidence checks, and a site-PC pending indication. Keep this as the canonical mobile sales release path.
- V2 `receiving.js` uses RTS checks and `/job-orders/:id/products-in`, with durable per-job retry keys, partial-group progress and restart recovery (step 8). QC-passed output becomes sellable stock only after receipt. A mismatch hold blocks RTS before stock entry, so sales availability must not subtract that unreceived unit from on-hand a second time.
- Legacy receiving posts actual GRNs to `/purchasing/orders/:id/receipts`. Partial receipts remain supported. Stock increases only in the receive location; a receipt elsewhere requires a transfer to satisfy a sale at its selected warehouse.
- Backend claim/physical route classifications and owning-site decisions remain in force. New planning links replicate; automated coverage checks site host, cloud and LAN peer after an outage. This is backend integration evidence, not a claim that every mobile screen was exercised.

## API contracts for mobile work

All paths below are under `/api`; mutations retain backend permissions and module gates.

| Endpoint | Contract / meaning |
|---|---|
| `GET /orders/:id/availability` | Existing `ok`, `short_lines`, `lines` remain. Added `revision`, `order_status`, `location_id/name`, `uses_default_location`, `non_stock_lines`, `purchase_requirements`, `linked_purchase_orders`. Each stock line separates `on_hand`, `elsewhere_on_hand`, `committed_elsewhere` (total other commitments including holds), `committed_orders` (sale commitments only), `kit_held`, `repair_held`, `covered_here`, `available`, `shortfall`. |
| `POST /orders/:id/status` | `{status,force?,expected_revision?}`. Approval rechecks stock. `force:true` explicitly accepts shortage and **does not** make supply available. New review UIs should use only `status:'approved'` here for approval. Completion after warehouse acceptance or delivered proof requires a slip; `409 code:'release_required'` is not bypassed by `force:true`. |
| `POST /orders/:id/produce-shortfall` | `{expected_revision?}`. Open/approved/released unfulfilled sales only. Returns `created`, `skipped`, refreshed availability. Linked jobs include completed but unreceived output; scraps can trigger incremental replacement production. A created MO is a draft, requiring production approval, warehouse kit release, production, QC/QA and receipt. |
| `POST /orders/:id/purchase-shortfall` | `{expected_revision?}`. Same lifecycle limit; Purchasing permission required. Aggregates shared components, deducts existing live linked PO outstanding quantities, drafts only the remainder. `created[]` includes PO `id` and `number`; empty is a successful no-op. Receipt/cancellation/PO edits change coverage. |
| Any review mutation | `409 code:'stale_order'` = refresh the order and re-review. `409 availability` = stock changed; show fresh shortages rather than declaring approval successful. `403` = role/module restriction; keep the action blocked. Network failure = uncertain outcome; refresh before retrying. |

Manufacturing jobs snapshot **direct** BOM components, including subassemblies as stock items. Sale planning mirrors that execution model; it does not automatically turn a nested recipe into raw-material jobs. Multi-level explosion is a separate analysis tool. Existing draft job snapshots take precedence if the product recipe is edited later.

New sale-generated POs have durable `sale_shortfall_purchases` links, surviving note and line edits. Older POs with exactly `Shortfall for <current SO number>` are recognized for compatibility. Other historical drafts need procurement review; do not assume arbitrary notes link supply to a sale. Linked PO coverage is planning, not a stock reservation or a confirmed delivery date.

## Mobile acceptance checklist

1. Open sale: cannot pick/ship. Approved sale: requires warehouse acceptance before allocation.
2. Stock exists only elsewhere: show the ship-from shortage; do not approve it as local stock.
3. Another firm sale, picked kit or repair hold: show the reduced availability at the same location.
4. Draft MO/PO exists: show planned quantities, while sale shortage remains until receipt.
5. Repeat a planning action after a timeout/reconnect: no duplicate supply; handle an empty `created` result normally.
6. QC passed, output not received: still short; no duplicate MO. Receive once: stock becomes available at the receive location.
7. Sale changed since review: explicit refresh/re-review. Stock changed since review: new shortage response.
8. Queue while phone has no authority connection: pending, never “picked/released/received” as a final fact. Reconnect to the site authority, then inspect command state.
9. Full/partial release, authorization expiry, missing proof, wrong package, concurrent allocation: preserve current V2 blockers and recorded slip semantics.
10. Delivery after an issued release slip: verify zero second deduction; unresolved release/shortage goes to Sales/supervisor.

Update the mobile role handoff, route inventory tests and service-worker cache when implementing these changes. This audit does not alter the mobile role permissions or decide the design of new mobile Sales screens.

### Mobile legacy Pick retirement (2026-10-16)

The obsolete `#/pick` route now returns to permission-filtered Work (`46:548`).
Sales use Release orders (`#/so`); production uses Kit releases (`#/kit-release`).
The old order list, per-line negative adjustments and false batch-success result
are removed. Commercial order IDs are never reused as manufacturing job IDs.
Purchase-order receiving and intentional stock-adjustment tools remain available.
Old bookmarks perform no stock action; canonical queues retain their own gates.

**Next-step owner decision (2026-10-16):** courier evidence should also stay
optional, matching own-driver delivery. This overrides the required collector/proof
policy described in the courier handoff above. That alignment is now implemented in the courier step described at the top;
legacy Pick retirement itself did not implement it. Warehouse-out remains required before closing custody.

Legacy Pick retirement validation: TypeScript passed; 125 focused mobile tests
passed; all 2,800 tests across 274 files passed; 25 real-backend Playwright checks
passed at 390×844 with zero page errors. Work `46:548` screenshot checked against
the Figma reference. Legacy bookmarks perform no stock writes and both canonical
release queues remain reachable. PWA cache v105. Physical-device acceptance remains
separate. Courier evidence policy alignment remains the next step.

Courier step validation: TypeScript, 182 focused tests, all 2,819 full-suite tests
and 27 real-backend Playwright checks passed. See
`docs/reviews/mobile-courier-pickup-validation.md` for scenarios and scope.

Exact sale-line allocation validation: TypeScript, 160 focused tests, all 2,823
full-suite tests across 276 files, and 33 real-backend Playwright checks passed.
See `docs/reviews/mobile-sale-line-allocation-validation.md` for scenarios and scope.

### Same-order partial vehicle trips (2026-10-16)

Owner decision supersedes the earlier backorder-splitting description: keep one sales
order, hold all unshipped demand for that customer, and create a separate release slip
and delivery record for each actual load. Mobile Release orders offers **Choose vehicle
load**, with exact serials and reserved batch quantities. Ship complete CKD kits only;
extra components may remain held. Each trip uses fresh handoff proof/signature and
Sales authorization. Existing unresolved attempts retain their immutable payload/key.

Mobile managers can **Plan delivery trip** before warehouse-out or for a specific slip.
Bookings and delivered manifests never copy the full order quantity. Own-driver and
courier evidence remain optional; starts before the slip remain allowed. A successful
physical delivery requires its own slip. Only Sales' audited **Cancel customer remainder**
action frees unshipped stock; earlier releases and deliveries remain unchanged.

Schema v84 adds dispatch/cancellation counters and exact trip identity links; ambiguous
historic delivery links stay unassigned for review. Historic backorder SOs are retained.
Validation: TypeScript passed; 154 focused mobile/backend tests and 15 sync/trip
checks passed; all 2,832 tests across 278 files passed; all 34 real-backend
Playwright checks passed at 390×844 with zero page errors. See
`docs/reviews/mobile-same-order-trips-validation.md` for behavior, upgrade and scope.
