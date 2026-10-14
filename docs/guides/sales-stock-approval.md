# Review stock and approve a sales order

Use this checkpoint after saving customer demand, before the warehouse accepts the order. You can inspect stock, plan missing supply, and explicitly approve a backorder.

## Before you start

Open **Sale Orders**. View access allows stock review; **Edit orders** allows approval and corrections. Draft production needs the Manufacturing module and **Adjust inventory**. Draft purchases need the Purchasing module and **Manage purchasing**.

## Steps

1. Save the sale as **open**, including its ship-from warehouse and linked inventory lines.
2. Select the row's **Review stock & approval** action. Alternatively, choose **approved** in an open order's editor and save; this saves the open details first, then opens the review.
3. Check the ship-from location. Compare ordered quantities, local on-hand stock, other orders, kit/repair holds, picked/shipped coverage, available quantities and shortages. Stock elsewhere needs a transfer.
4. If demand or the source is wrong, select **Edit quantities or ship-from** and save the correction. No automatic trim removes customer lines.
5. Select **Draft missing production** for products with a BOM. Review the resulting MOs in Production; drafts still need approval, kit release, production, inspection and Products In.
6. Select **Draft missing purchases** for missing bought items or production components. Review the resulting POs in Purchasing and receive actual deliveries into the required location.
7. Select **Refresh stock** after production receipts, purchases or transfers. Planned supply is displayed separately and does not clear stock shortages.
8. Select **Approve for warehouse** when covered. With shortages, select **Review backorder approval**, then explicitly confirm. Approval locks quantities/prices and sends the order to warehouse acceptance; it does not deduct, pick or ship stock.

## Tips and gotchas

- Changing or cancelling a sale does not automatically cancel existing supply drafts. Review linked MOs/POs with Production and Purchasing if demand falls.
- Shared components use one available pool; two products cannot independently promise the same material. Kit picks and repair holds reduce the pool at their source.
- Repeated draft actions create only additional demand. Existing live POs, partial receipts, cancellations and edited PO quantities affect purchasing cover. Finished output awaiting receipt prevents duplicate production, even if the MO is marked completed.
- Production planning follows direct job-order BOM components and saved job snapshots. A subassembly needs its own stock or production plan; this action does not automatically expand every nested BOM into raw-material jobs.
- **Awaiting release** lists firm orders with stock lines still unpicked. It includes stocked orders awaiting warehouse work, so it is not a shortage-only filter. Use the stock review for the actual shortage.
- Non-stock service/charge lines have no stock gate. Source-less stock orders use the default warehouse.
- A result saved on a site PC shows sync confirmation pending. Follow the current site's authority and sync status before treating it as cloud-confirmed.

## If something goes wrong

**Order changed since review:** refresh, inspect the latest order and decide again. **Stock changed:** the approval gate returns the new shortage; refresh and plan supply or explicitly approve a backorder. **No location:** create a stock location first. **No BOM:** define the recipe before drafting production. **Nothing created:** existing supply may already cover the demand; this is a normal result. Cancelled or fulfilled sales cannot create shortage supply.

Mobile integration follow-ups are tracked in the root [MOBILE-INVENTORY-HANDOFF.md](../../MOBILE-INVENTORY-HANDOFF.md). Mobile files were not changed by this desktop/backend refinement.
