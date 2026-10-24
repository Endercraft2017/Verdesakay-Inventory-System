# Mobile Sales capture and approval handoff

2026-10-24, Asia/Manila. Implements the current phone-owner contract at the top of
`MOBILE-INVENTORY-HANDOFF.md`, using the two existing sale-entry routes. No new
Sales/Inventory/Production authority is assigned to employees.

## Demonstrated gaps and fixes

| Finding | Resulting behavior |
| --- | --- |
| Phone capture omitted the target date and explicit registered-customer choice. | Both forms offer optional target delivery date and searchable registered customer versus explicit walk-in entry. Name edits clear the old registry ID. Search failures offer retry and leave walk-in available. |
| An approval-only employee could not reach the Sales desk. | Effective `orders.view` plus `orders.approve` opens existing Sales views. Create/edit actions retain their own gates. Manual production planning remains forbidden. |
| A custom Sales creator received 403 from the product picker. | Create/edit permission permits a limited catalog/SKU response, including product classification. Costs, supplier/private attributes, full inventory, stock changes and production unit/batch reads remain protected. |
| Phone had no current approval/automatic-production handoff. | Review availability and revision, explicitly accept part/CKD backorder, then approve. Confirmed results read current linked job numbers, quantities and expandable read-only progress. Production still owns subsequent approval and physical work. |
| Customer changes could reset previously edited target/notes during implementation. | Picker state contains identity fields only. A regression edits target/notes before selecting a customer and verifies the persisted order. |
| Restarting an old edit could adopt a newer revision over unreviewed draft values. | Draft retains its original revision. If the current sale changed, saving is blocked until the employee explicitly loads the current sale. |
| Server approval followed by response loss could leave an already-approved order without an obvious recovery path. | Saved approval is available from its exact sale. Reload/retry preserves the original request and key; no duplicate production job. |
| Site-PC acknowledgement could be confused with final linked production work. | Pending acknowledgement stays pending and hides the final production result. Confirmed acknowledgement loads current availability rather than trusting local result IDs. |
| Dates and courier custody needed distinct meanings. | Target date is editable only during capture/open edit. Actual dates come from successful delivery events. Each trip shows its slip number/date; courier pickup is distinct from customer delivery. Failed drops with timestamps are excluded. |
| Narrow-screen form labels and the legacy dark-theme save button failed contrast checks. | Scoped Sales styles use theme text tokens, explicit search labels and readable label sizing. Both forms pass the targeted checks in both themes. |

Customer JO records remain read-only even for administrators. Approval refusals
(missing BOM, stale order, newly consumed stock) retain an open sale and require a
fresh review. Approval and preview reads do not move inventory stock.

## Reproducible verification

```sh
MOBILE_SALES_OUTPUT=work/mobile-sales-verified node scripts/test-mobile-sales-handoff.mjs
WAREHOUSE_KIT_UX=1 WAREHOUSE_UX_OUTPUT=work/mobile-sales-kit-regression node scripts/test-warehouse-ux.mjs
node scripts/test-mobile-qr-ux.mjs
npx vitest run tests/sales-picker-access.test.ts tests/mobile-sale-ui.test.ts \
  tests/access-matrix.test.ts tests/order-planning.test.ts tests/order-trips.test.ts \
  tests/orders.test.ts tests/frontend-mobile.test.ts \
  tests/frontend-mobile-work-navigation-ux.test.ts tests/frontend-mobile-scan-sync-ux.test.ts
npm run typecheck
```

The Sales script creates fresh local Express/SQLite data and separate creator,
approver, revoked and basic employee contexts. Its 19 scenarios compare browser
results with real API responses and read-only SQLite queries. Coverage includes
both capture routes, edit/restart conflicts, keyboard customer selection,
customer-service failure/retry, minimal permissions, no-BOM refusal, stale order
and stale stock, explicit backorder, repeat approval, response loss/reload,
offline and pending acknowledgement, unauthorized direct links, read-only
Customer JOs, two separate own/courier trips, failed-drop exclusion, late errors
after leaving Home, and both 390px themes.

Evidence: `work/mobile-sales-verified/report.json` contains source hashes,
effective profiles and request/response evidence. Each case saves a Playwright
trace and screenshot. `capture-*-light.png`, `capture-*-dark.png` and the four
`a11y-*.json` files cover both forms. Open a trace with
`npx playwright show-trace work/mobile-sales-verified/<case>.zip`.

The kit regression passes 12 cases. The full 34-case QR/release/delivery suite passes;
two outdated driver-link assertions now require refusal guidance and the absence
of a release action for an employee who lacks releasing permission. This changes
test expectations, not delivery policy. Starting before a slip and optional
evidence remain allowed; completion still requires the warehouse-out handoff.

The focused regression run passes 287 tests, with two additional helper tests
passing separately. The final UI rerun covers the helper and all mobile bootstrap/
recovery checks. TypeScript passes. Detailed logs are under `work/mobile-sales-*`.

## Limits

These are local browser/API/database checks, not deployed sandbox acceptance or
demonstrated human usability. Chromium touch emulation does not prove physical
phone keyboards, camera optics, printer output or phone-storage retention.
The QR suite uses a virtual camera with images of actual generated QR labels.
Site-PC local/confirmed response headers and command polling are simulated;
cross-machine replay and ID remapping still require a real disconnected site-PC
installation. Targeted accessibility scans do not establish whole-app WCAG
conformance. No representative employee usability session was available.
