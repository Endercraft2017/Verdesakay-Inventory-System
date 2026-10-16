# Slip-linked customer returns: implementation and audit

**Date:** 2026-10-13. **Branch:** `restructure/module-architecture`. This step covers a physical return after a sale's release slip. It does not reopen or cancel the shipped sale. Mobile source remains with the mobile developer; see `MOBILE-INVENTORY-HANDOFF.md`.

## Operator flow

1. Open Inventory → Releasing → Release Slips and open the original slip. “Record goods received” requires a shipped line, quantity or sold serial, return reason and a fresh photo. The numbered `SR-` receipt is linked to the slip, but inventory remains out of stock.
2. A user with `inventory.adjust` inspects the receipt and records the condition. **Restock** adds the inspected quantity at the selected location; **Reject** keeps it out of sellable inventory. This decision is one-time and is atomic with the stock and serialized-unit change. After rejection, choose repair (serialized units), salvage into damage stock, or disposal. A repaired unit needs a separate fresh return inspection before it can be restocked.
3. Finance issues a customer credit note in Accounting, selecting the original sale order. A user with `accounting.manage` links that issued note to the return from the slip. Credit approval never changes inventory. A voided note remains in accounting history; Finance can link a replacement note.

The new `sales_returns` table stores the source slip/line, item, quantity, optional exact serialized unit, receiving proof, condition, inspection disposition, location and current credit link. `sales_return_credit_links` retains the history of each note linked. New slips snapshot `release_slip_items.unit_cost`; a restocked return reverses COGS at that cost when the ledger is enabled. A failed or skipped posting does not undo the physical receiving decision and remains visible as a reconciliation task.

## API and guards

`GET /api/sales-returns/slips/:slipId/context` supplies shipped lines, remaining returnable quantity, sold serials and prior receipts. `POST /api/sales-returns` checks the slip-line link, aggregate returned quantity, exact sold serial where applicable and proof uploaded for the slip. `POST /api/sales-returns/:id/inspect` requires an inventory adjuster; `POST /api/sales-returns/:id/link-credit` requires Accounting management and a matching issued customer note sourced to the same sale and customer.

The receipt and inspection endpoints are classified as physical site actions for offline sync. The credit link is a claim. Clients must use authority-confirmed results and refresh after conflicts; the current desktop UI performs these actions, while mobile needs its own implementation.

## Remaining gaps and next decisions

| Priority | Gap | Next action |
|---|---|---|
| High | Mobile has no return receipt/inspection screens yet. | Mobile owner should implement or explicitly hide this flow; do not reuse legacy Pick or stock adjustment as a return. |
| Medium | Slips issued before this schema did not record unit cost, so an old return can restock but its COGS reversal reports `cost_missing`. Closed periods and missing posting rules can also leave the GL behind. | Add an Accounting reconciliation queue with reviewed cost entry and a retry action. Preserve physical receiving even when posting needs review. |
| Medium | Finance can issue multiple credit notes against the same sale outside the physical return UI; the existing note API has no sale-line quantity cap. | Decide policy for return-specific refund limits, tax rounding and partial allowances before automating note issuance. |
| Medium | Bulk rejected goods have no serial-level repair path. | Split a bulk receipt into individually tracked repair lots if this becomes a business requirement; until then bulk can be salvaged or disposed. |
| Medium | `sales_returns.unit_id` is unique for the lifetime of a serial. A repaired and resold serial cannot be received again on a later slip. | Before allowing repeat serial sales returns, migrate that constraint to a per-slip or per-sale rule and audit the sold-serial context query. |
| Medium | The return workflow covers customer goods tied to a release slip. Legacy sales completed without a slip have no original physical handoff record. | Reconcile or migrate those sales before offering automated returns for them. |

## Verification

Focused integration tests cover receipt without stock movement, proof and shipped-quantity validation, a replayed receipt key, one-time restock/rejection, exact serial return, atomic inspection rollback on stock-posting failure, COGS reversal at shipped cost and credit linkage/void. `npm run check` passed: 230 files and 2,435 tests, including the generated database-type freshness check. A real Chromium session completed slip → photo-backed return receipt → inspection → restock; stock stayed at 3 after receipt and rose to 4 after inspection. At 390 px the desktop document width matched the viewport, with no page errors.

## Rejected-goods follow-up (schema v68)

`sales_return_dispositions` records the current rejected-return state; `sales_return_disposition_events` retains each transition. The original `sales_returns.status` remains `rejected` during repair and changes to `restocked` only after a passed reinspection. Salvage adds the quantity to the damage twin, leaving the original item out of sellable stock. Disposal adds no inventory. Return repair parts requests carry `sales_return_id` into the existing warehouse queue, and completion is blocked while any request is pending. Return reinspection never calls job-order inspection or `products-in`, preventing a second manufacturing receipt or increment to `qty_done`. Finance follow-up remains separate from this Inventory/Production step.

Focused integration coverage now includes salvage, disposal, salvage rollback, a return-linked parts request, blocked completion with a pending request, failed reinspection, successful reinspection, and no duplicate production output. `npm run check` passed with 230 files and 2,439 tests. Desktop JavaScript syntax and diff checks passed. Browser-level responsive review of the new dialogs remains for the next UI validation pass.
