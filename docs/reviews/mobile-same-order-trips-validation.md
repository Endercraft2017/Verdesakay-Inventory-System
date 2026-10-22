# Same-order release and delivery trips

Owner policy, 2026-10-16: a sales order may leave in several physical loads. Its
unshipped remainder stays committed to the customer and cannot be promised to
another sale. Each actual vehicle load has its own release slip and delivery
record; customer cancellation is the only action that releases remaining demand.

## Implemented behavior

- Original SO quantities and prices remain intact. Net dispatched, bulk-dispatched
  and customer-cancelled counters retain shipment and cancellation history.
- Trip manifests preserve exact sale lines, serialized units and batch quantities.
  Partial batch reservations split into shipped and still-held rows. CKD manifests
  contain complete kits; extra components may stay reserved for the following trip.
- Only a trip's selected load leaves warehouse stock and posts its additional COGS.
  Replays cannot deduct or post it twice. Stale previous-slip revisions are refused.
- Sales cancels only unshipped remainder, with a reason, revision and stable request
  key. Previously shipped stock and completed delivery records remain unchanged.
- Mobile Release orders offers vehicle-load selection. The following trip starts
  with fresh handoff evidence; unresolved attempts keep the original immutable body,
  photos, acknowledgement and retry key across restart.
- Delivery planning supports a pending next trip or an exact issued slip. A delivery
  displays only its own manifest. Own-driver and courier evidence stay optional;
  starting before release is allowed, but a physical completion requires its own slip.
- Courier pickup closes carrier custody and never counts as customer delivery.
- A site-authoritative release remembers its validated delivery booking in sync
  context. Later cloud cancellation does not detach the site's saved proof. An
  intentionally unbooked site shipment cannot acquire an unrelated cloud booking.
- Inventory availability separates on-hand stock from commitments and respects the
  warehouse/build-state pools and kit/repair holds.

## Upgrade and scope

Schema v84 adds dispatch/cancellation counters, exact serial manifest membership,
batch-to-slip and delivery-to-slip links, and cancellation audit records. The upgrade
backfills only unambiguous historic links. It preserves historic backorder SOs and
leaves ambiguous old delivery records unassigned for staff review. It does not merge
historic orders or invent a delivered quantity. PWA cache v108.

Existing mobile Figma references 78:481, 78:401, 78:317 and 78:438 were reviewed;
the trip selection extends existing role cards and action controls. Delivery planning
uses existing mobile form controls; the role UX spec has no dedicated driver frame.
Playwright uses a disposable real Express/SQLite server, 390×844 Chromium and QR
images from actual print sheets passed through a virtual camera. Physical printer
quality and phone optics remain device acceptance work.

## Validation

- TypeScript: `npm run typecheck` passed.
- Focused mobile/backend run: 154 tests passed; sync/trip reconciliation run: 15 passed.
- Full suite: `npm test` — 2,832 tests across 278 files passed (498.69 seconds).
- Playwright: `npm run test:mobile:qr` — 34 checks passed, zero page errors.
- `npm run db:types` regenerated the schema types; `git diff --check` passed.

Focused backend/mobile tests cover two same-order trips, unavailable remainder, audited cancellation, stale
submissions, exact serial/batch identity, whole CKD kits, COGS and old-schema upgrade.
The browser scenario loads 3 of 5 units, delivers 3, then loads/delivers the remaining
2 on a separate slip and record under the original SO with fresh handoff evidence.
