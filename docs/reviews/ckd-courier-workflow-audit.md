# CKD partial release and courier pickup audit (2026-10-16)

## Result

- A two-unit CKD sale can ship one complete kit with Sales' partial-release authorization. The slip contains the parent manifest and the shipped child components. The new approved backorder keeps the other parent and its original part snapshot, including `parent_order_item_id`. Stock is deducted for shipped components once; the finished-unit SKU balance is untouched.
- An incomplete kit cannot leave on a slip. If the warehouse picked extra components beyond the complete kits, it must undo those picks before the partial release. The desktop release queue reflects this at narrow and wide widths.
- A delivery can be booked as `own` or `courier`. A courier pickup has a named courier and optional tracking number. After the warehouse release slip, staff may record the representative who collected it and attach a pickup photo or signature; the owner subsequently chose optional evidence for courier pickup too. That terminal handoff closes our operational delivery task; the system does not claim that the customer has received it. The existing `delivered` database status is retained for compatibility, distinguished by `delivery_mode:'courier'` and response `handoff:'courier'`.
- A sale cannot have two active shipment bookings. A pending/in-progress own-driver booking must be completed or cancelled before the courier option is booked, and vice versa.
- The desktop release-slip view can book and confirm courier pickup. The phone now has a distinct courier pickup flow with saved tracking/evidence and original-request recovery; see root `MOBILE-INVENTORY-HANDOFF.md`.

## Verification

- `tests/ckd-sales.test.ts`: whole-kit partial and existing full-CKD/RTS/aftersales cases.
- `tests/deliveries.test.ts`: courier cannot use the own-driver dispatch/completion path, needs the warehouse slip before pickup, and permits optional pickup evidence; any supplied signature is validated and closed evidence is immutable.
- `tests/courier-migration.test.ts`: a version-80 database upgrades to the courier fields and its existing own-driver booking remains intact. `npm run db:types` regenerated the checked-in query types.
- `work/courier-ckd-browser.mjs` (local ignored script): real Express/SQLite plus Chromium at 1440px and 390px; books and closes courier pickup, inspects pickup proof, checks a half-picked CKD kit remains blocked and one fully picked kit enables partial release.
- Before integration with the mobile recovery commit, the full suite had 2,784 passing tests and one generated-type drift failure. After regeneration, the drift check and six affected test files passed (52 tests). TypeScript and `git diff --check` passed. The combined branch was then checked with TypeScript, 38 focused tests (including mobile evidence recovery), and real Chromium at both widths.
- Final combined full suite: **2,799 tests across 274 files passed**. After the active-booking guard was added during that run, delivery, sync-sales and CKD tests were repeated separately (20 passed); the desktop browser scenarios and TypeScript passed again.

## Remaining mixed-order limitation

Sales intake still rejects two commercial lines that reference the same inventory item. That includes a fully built and semi-built line under one SKU, and two lines with different negotiated prices. Removing the guard alone would count the same serialized unit on both lines and could ship a batch twice: unit ownership, release coverage, batch allocation, availability and reversal currently identify many allocations by order and item instead of sales-line ID. This needs a dedicated line-level allocation migration and desktop/mobile picking design, with legacy-order fallback and return/COGS regression coverage. No duplicate-line intake was enabled in this change.
