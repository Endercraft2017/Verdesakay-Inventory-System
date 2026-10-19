# Job-order selection and legacy unit intake validation

Date: 2026-10-19. Branch: `restructure/module-architecture`.
Candidate mobile cache: v126. Database schema: 91.

## Implemented behavior

QC, QA and RTS open their eligible job-order groups first, with unit counts and
product/number. Choosing a group shows its eligible units or batches. Empty
queues state that no ongoing job orders exist for that stage. Direct unit links
continue to work. Selected-job completed history is scoped to that job.

An RTS clerk can start/resume a pre-system intake for one existing physical unit.
Required data: finished product, distinct physical identifier, storage location,
photo, reason and unit cost. The product's current cost prefills the editable
cost field. The normal catalogue/create/adjust permissions are not granted to
the clerk; `/rts/legacy/context` exposes only the intake choices.

The `LI` record is an inspection-only origin in the shared job/unit tables,
tagged `intake_origin=legacy` and excluded from normal manufacturing job lists.
No BOM kit, component consumption, available stock or manufacturing WIP release
is created. Additional manufactured output against the intake is refused. Its
fixed two-stage QC/QA policy cannot be disabled by a client-supplied stage count.
Checklist snapshots are frozen on entry. Stock remains unchanged at intake,
after QC, and after QA. Only the ordinary guarded Products In receipt adds it.
The unit retains the declared legacy valuation rather than a new BOM build cost.

The clerk sees pending QC/QA, rework, hold, failure and cancelled-intake labels.
Inspectors select the intake/unit and confirm its physical identifier before
inspection. A final QA pass makes it eligible for receiving. The existing
print/attach/camera-scan confirmation remains mandatory on the mobile stock
posting screen. Existing capacity, duplicate, hold and permission guards apply.

Form and compressed-picker photo drafts use account/server-scoped IndexedDB via
`mWorkflow`. Once submitted, the exact multipart payload/photo/key is immutable
and recoverable after restart or response loss. A backend intake key and hash
of parsed fields plus photo additionally prevent changed/foreign key reuse.
Duplicate physical identifiers are refused even with a different intake key.

## Verification

`node scripts/test-mobile-legacy-intake.mjs` passed seven scenarios against an
isolated real Express/SQLite server at 390x844:

1. Empty QC, QA and RTS queues show the no-job message.
2. Clerk intake form and photo survive closing/relaunching Chromium.
3. A committed intake with a dropped response retries with the original key and
   creates exactly one intake, without changing product or component stock.
4. A separate QC account opens the group/unit, confirms identity, and passes its
   checklist; a premature Products In call remains refused.
5. A separate QA account passes its checklist; stock still remains zero.
6. The clerk opens the RTS group/unit, completes review and prints a real label
   PDF. The decoded QR is the exact unit ID; the stock button remains disabled.
7. That printed QR is rendered as virtual-camera frames and scanned through the
   real scanner. Receipt adds one unit and leaves component stock unchanged.

The five existing pre-sticker identification scenarios also passed after being
adapted to select the job group first. No scanner callback or operational API
response was replaced. Response-loss tests deliberately drop only a committed
response. Passing browser runs had zero page errors.

TypeScript, syntax/whitespace checks and **192 tests across eight focused files**
passed. The eight dedicated legacy tests cover narrow-role context/creation,
no-stock/no-kit provenance, exact retry, changed/duplicate input, missing photo,
mandatory QC-before-QA and refusal of stage skipping, refusal of extra manufacture,
exact-once receipt/valuation, and photo-backed failed output remaining out of RTS.
Other focused files cover mobile rendering, checklist/stage requirements,
receiving/recovery and the permission matrix. This is not a full-suite claim.

The production-sync suite includes an actual disposable cloud/site simulation:
a disconnected site records the legacy photo/intake, QC, QA and receipt. Replay
preserves origin and the photo bytes, records two inspections and one stock
increase, consumes no kit, and creates no second increase on another sync round.
All five production-sync tests passed, included in the 192 above.

Reports, screenshots and print PDF are under ignored
`work/mobile-legacy-intake/`; pre-sticker evidence is under
`work/mobile-inspection-identity/`. No live tenant or customer stock was changed.
Physical print quality, a physical phone/PWA and an installed site-PC outage
remain unverified. No commit, push or deployed v126 is claimed by these tests.
