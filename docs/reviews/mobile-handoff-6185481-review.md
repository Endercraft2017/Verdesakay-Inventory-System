# Mobile handoff reconciliation — 2026-10-16

Compared the exact `6185481:MOBILE-INVENTORY-HANDOFF.md` with branch
`restructure/module-architecture`, including upstream `0a53a32`. Historical audit
rows in that file are not all current: later numbered steps already resolve many
of them. This review distinguishes remaining mobile implementation from API work
and optional expansion. It does not authorize implementing all items in one step.

## Current work

1. Final warehouse-out: durable photos/signature and immutable slip recovery.
2. Delivery: durable start/POD recovery and accurate authority-confirmation states.

Validation passed: TypeScript, 235 focused tests, 24 real-backend Playwright checks
and all 2,796 full-suite tests across 273 files. The main handoff records the current policy. Delivery evidence remains optional, and a
linked delivery may start before a slip, by explicit owner decisions. Final sales
completion still obeys the backend release-slip guard. The driver screen no longer
offers a force-backorder stock action.

## Remaining implementation, ordered for review

| Priority | Item | Current source evidence and next step |
| --- | --- | --- |
| High | Retire legacy Pick | `public/mobile/modules/inventory/orders-fulfil.js` still registers `pick`, lists sales/jobs and contains per-line negative adjustments with memory-only progress. Redirect sales to V2 releasing; choose the proper production-kit entry for job demand. Preserve legitimate adjustment tools. Backend already refuses the dangerous legacy sales reason. |
| High | Semi-built finishing intake | No `convert-semi` calls under `public/mobile/`. Add explicit source selection (serial, exact scanned batch or untracked), complete-package confirmation, photo and durable multipart attempt. Label conversion jobs in production/QC and suppress Add unit/bulk/component pick for them. Backend already handles costs, source lineage and pre-QC cancellation. |
| High | Customer returns and repair disposition | No `sales-returns` calls under `public/mobile/`. Add slip-bound photographed receipt, permissioned inspection/restock/reject, then serialized repair/salvage/dispose and reinspection. No stock addition at receipt and no warehouse refund. Backend one-lifetime-return-per-serial remains a separate limitation. |
| Medium | Allocation correction | `so.js` has no `/release/unreserve` action. Add explicit pre-slip undo with exact unit/quantity review and durable request identity; never imply reversal after physical shipment. |
| Medium | Build-state stock movement | `transfer.js` and `stock-move.js` do not send `build_mode`; transfer uses combined location stock. Add matching variant balances and tracked-unit movement rather than generic transfer for serials. |
| Medium | Shortage/procurement context | No mobile `produce-shortfall` / `purchase-shortfall` calls. `kit-release.js` lacks pending PO/source-owner guidance. First expose read-only holds/planned supply; gate planning actions by role and distinguish sale-owned procurement from independent-job procurement. Draft supply never means on-hand stock. |
| Medium | QC configuration/stage handling | Audit `qc.js` for explicit `blocked:checklist`, homogeneous bulk stage selection, frozen checklist refresh and queued/PC/authority result wording. Existing hold decision/recovery and separate photographed issue reports are already implemented. These remaining cases need focused verification before marking closed. |
| Medium | Location hierarchy/capacity | `lib/locations.js` renders `l.name`, and RTS `locName` uses names. Use full paths in pickers/review/results, direct capacity context and conflict refresh so equal shelf names are unambiguous. |
| Medium | Whole-job issue management | Unit-linked QC/QA issue management exists; whole-job kit/line issue editing/resolution still needs its operator path. Reports stay informational; Pause stops work. |
| Medium | Legacy queued result audit | V2 recovery paths track sync commands, but legacy purchasing receipt/transfer/adjustment results still need an audit of queued, PC-local and authority-final copy and partial failures. |
| Conditional | Mobile Sales entry, prices and fees | Mobile currently focuses on approval/releasing. If adding Sales entry/edit, use catalog starting price, explicit price-suggestion apply, negotiated prices, separate non-stock fee lines and approval locking. No need to add pricing controls to clerk releasing screens. |
| Backend dependency | Same-SKU mixed physical sale lines | Release allocation rejects ambiguous duplicate physical `item_id` lines. Supporting fully built and semi-built lines of the same SKU together needs line-specific allocation API before mobile can offer it. |

## Already covered by earlier steps

- Persistent serialized production entry/photos; kit acceptance, bulk and scrap
  recovery; early close preserving already-built output.
- Partial warehouse kit picking/corrections, authority state handling, discoverable
  manager approval review and truthful issue-report messaging.
- Immutable QA hold decisions and unknown hold counts; separate per-issue photos.
- RTS quantity validation, per-job/grouped receipt recovery and exact QR verification.
- Releasing queue stages, decimal quantities, ship-from/build-state checks and
  durable acceptance/allocation requests.
- Immutable unit/batch QR labels, real scanner validation, exact-batch stock and
  sales reservations, mixed-history and CKD physical-component QR matching fixes.

## Still requires hardware acceptance

Use actual phones, printed/stuck labels and the intended printer; virtual-camera
Chromium cannot certify paper sizing, optics, camera focus, or device-specific
browser lifecycle behavior. See `mobile-qr-playwright-audit.md` for that checklist.

## Additional access audit requested by the owner

A baseline account with `mobile.access`, `messages.view` and `messages.send` keeps
personal tools. The central route gate now denies inventory/production/RTS/releasing/
delivery/confidential-case screens without matching permissions. Work and Quick Orbit
also respect enabled modules; `inventory.adjust` does not grant delivery access.
Focus, foreground and reconnect refresh desktop-admin permission changes. Inspectors'
requester-specific repair revision path is retained. Backend delivery checks now
accept a custom manage-only account while retaining assignment checks for runners.
An entirely disabled account is still subject to the normal authentication controls;
this change does not grant a separate mobile bypass.

## Updated handoff integration

The newer `0a53a32` backend handoff was also reviewed and integrated. After the
owner reconfirmed optional delivery evidence and pre-slip starts, both server and
phone were aligned to that policy. Delivered physical goods still need warehouse-out;
failed trips require a reason. Assigned-driver/manager evidence access, completed
evidence locks, desktop slip/photo response-loss fixes and physical sales completion
guards are retained. Earlier strict dispatch/proof assertions are superseded.
