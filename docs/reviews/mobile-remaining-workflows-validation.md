# Remaining mobile pipeline workflows — 2026-10-16

Owner authorization: implement the remaining mobile pipeline items. Owner return
policy: a restocked serial sold again may be returned against its new sale shipment.
The earlier optional delivery evidence and pre-slip start policies are unchanged.

## Implemented paths

- **Held allocation correction:** explicit serials, exact batch-allocation rows or
  untracked quantities. The backend validates ownership, amounts and consistent
  selection modes. Only reservations change; shipped goods and customer demand stay
  intact. Requests and keys survive response loss/restart through release recovery.
- **Customer returns:** entry from an issued mobile slip or Work, remaining shipped
  quantity/exact serial/batch, compressed photographs, durable receipt and separate
  warehouse inspection. Receipt adds no stock and issues no refund. Rejected goods
  support repair, salvage or disposal; serialized repair supports parts requests,
  explicit repair completion and warehouse reinspection. Finance handles credit notes.
- **Inspector boundary:** only serialized returns in repair/awaiting inspection are
  available through a minimal repair queue/detail response. Customer and commercial
  fields are omitted. Inspectors cannot inspect stock in or choose disposition.
- **Direct-sale integration:** the phone selects the exact commercial line, build state,
  price and ship-from. Stock-out recovers with its original body/key and is labelled
  “Stock removed; awaiting trip slip”. Unslipped direct units are mandatory on the
  next trip; the slip cannot deduct them twice. Repeat-sale membership is scoped to
  the current line and restock clears the previous direct-sale marker. Already-out
  units no longer hold the remaining on-hand stock a second time.
- **Repeat returns:** schema v86 replaces lifetime serial uniqueness with uniqueness
  per shipment. The migration retains return rows and dependent disposition/credit
  history. A second sale creates a separate return cycle; duplicate receipts on that
  shipment are still refused.
- **Semi-built finishing:** manager-scoped product/location context, optional sales
  demand link, serial/batch/untracked source, complete-package confirmation, photo and
  durable multipart intake. It creates one pending QC unit and one conversion job.
  Ordinary Add unit/output/scrap paths are suppressed; pre-inspection return to semi
  RTS requires confirmed repacking and a reason. QC/RTS remain the stock-entry path.
- **Movement:** adjustments/transfers select build state and show variant balances.
  Tracked transfers select exact physical serials and use the unit-allocation move API.
  Drafts, exact payloads and keys persist; queued/local acknowledgements never render
  as authority-confirmed stock movement. Unsent drafts can change their selected item.
- **Quality:** ordinary QC/QA decisions now use immutable durable attempts alongside
  existing hold recovery. Bulk selection stays on one job/stage and validates whole
  quantities. Refusals retain the original decision/evidence for review; live context
  is refreshed before corrected decisions.
- **Whole-job issues:** the existing report/photo workflow now supports a separately
  namespaced whole-job context, with report editing, resolution and reopening. Reports
  remain informational; Pause controls production work.
- **Read-only context/navigation:** full location paths, fresh direct RTS capacity,
  stock here/elsewhere/held/planned distinctions, and procurement-owner/pending-PO
  guidance. Primary Work tiles retain their order; All role queues now exposes every
  authorized queue on Work, including the new paths.

## Recovery and permissions

`workflow-attempt.js` reuses the account/server-scoped IndexedDB draft store, photo
compression and sync watcher. It persists JSON or multipart file bytes before posting,
uses explicit retry with the original key, retains unknown/conflicting attempts, and
waits for site-command confirmation. Definite refusals can return to a draft for a
reviewed correction. Navigation/account guards prevent stale async screens overwriting
another view. UI visibility and all writes retain backend permission enforcement.

## Design and scope

Existing references reviewed individually: 78:109, 78:438, 74:399, 66:240, 66:185,
69:104, 72:104 and Work 46:548. New returns/intake controls extend shared forms/cards; there are no
dedicated approved Figma screens for those exception paths. PWA cache v109 includes
the new helper and routes. Legacy purchasing/other adjustment tools outside these
pipeline paths keep their existing queue behavior; mobile Sales entry/pricing is not
introduced. Ambiguous historical trip links still require staff review.

## Automated acceptance

Type checking and schema-type regeneration passed. Focused mobile regression: 130
tests passed; integrated return/release/availability/direct-unit regression: 43 tests
passed. New Playwright acceptance: 10 checks passed with no browser errors.
Original QR/release/delivery Playwright acceptance: 34 checks passed with no browser
errors. Total: 44 passing browser checks. One initial QR attempt timed out in
Chromium persistent-context launch; a clean rerun passed without application changes.
Full regression: **2,844 tests passed across 281 files** (560.78 seconds).
The final return-draft serial correction was also covered by a separate 130-test
mobile regression and the final 10-check browser run.

Real-backend Playwright checks use disposable
Express/SQLite instances and 390×844 persistent Chromium profiles. The new script
covers correction replay, return photo/restart/receipt/inspection, finishing multipart
response loss, variant transfer/location paths, whole-job photographed resolution,
ordinary QC replay, inspector repair access, exact-serial draft restoration, direct-sale recovery/required
trip inclusion and manager/basic permission boundaries.
The original QR suite also checks actual print images through a virtual camera,
warehouse-out evidence recovery and same-order two-trip delivery.

## Manual acceptance still required

Actual phone cameras, printed/stuck labels and the intended printer must be checked
on hardware. Virtual-camera Chromium cannot certify paper sizing, focus/optics or
OS-specific browser termination behavior. No deployment or real stock mutation was
performed by the test fixtures.
