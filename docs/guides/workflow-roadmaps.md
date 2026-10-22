# Cross-module workflow roadmaps

Open **Guide Center → Workflows & Pipelines** on the webapp, or **Work → Guides →
Workflows & Pipelines** on the phone. Follow the arrows from start to finish.
Every checkpoint lists its responsible team, prerequisite, action and result.
Dashed branches explain conditional recovery; this is instruction, not live progress.
A screen belonging to another role is described without granting access to it.

| Roadmap | Main handoff and completion check |
|---|---|
| Sales → parts → production → delivery → payment | Sales reviews exact local stock and linked supply; approved jobs pass through parts picking/slip, production acceptance, QC/QA and Products In. Only a trip slip deducts its physical sales load. |
| Purchasing → stock → bill → payment → ledger | Receiving posts stock; approved matched bills and allocated supplier payments are separate financial checkpoints. |
| Attendance → approvals → payroll → accounting | A roster and verified attendance/forms feed reviewed payroll, actual payment, explicit posting and compliance worksheets. |
| Sales release → multiple trips → driver or courier | Exact load manifests and current authority per trip; remaining demand stays on the same SO. Courier pickup records carrier custody. |
| CKD sale → component picking → whole-kit shipment | Ship whole kits from saved component lines. Extra picked components must be unreserved or complete another kit. Only shipped components leave stock. |
| Semi-built RTS → finishing → QC/QA → fully built RTS | Use one complete eligible package; no repeated BOM pick or Add unit. Inspect and receive the converted output once. |
| Customer return → inspection → restock/repair → credit | Receipt records custody without stock-in/refund. Warehouse inspection and return repair/reinspection own stock; Finance links the matching issued note separately. |
| Planned count → independent review → reconciliation | Count exact item/location/build-state stock, serials and batches. A different reviewer approves; only correction/verification completes the planned task. |
| Connected invoice form → submitted sales draft → fulfillment | Form/access configuration and source snapshots feed an atomic submission creating one open SO. This is not an issued accounting invoice or stock-out. |
| Payroll correction → history → later-cutoff review → ledger | Explicitly save corrections; review later unpaid same-month cutoffs oldest first. Paid locks and posting flags require separate handling. |
| QC/QA → issue evidence → repair/hold → RTS | Evidence-backed dispositions advance quality. Informational reports do not. Settle parts/reinspect and receive final-passed output before it becomes stock. |

## Important decisions

- For a sale-linked job, the **sale stock review owns combined component purchasing**.
  A standalone job has its own supply review. Check existing linked POs and receipts
  before drafting more. Planned supply is not available stock.
- Locations identify exact shelves/positions in the hierarchy. A receipt at another
  warehouse does not cover the sale's ship-from location; transfer it explicitly.
- Multi-trip loads retain original demand/history. Sales cancellation affects only
  the unshipped remainder. Shipped goods need a slip-linked return, not an allocation undo.
- Return repair completion and reinspection do not use manufacturing Products In.
  A serial resold later returns against the new slip, preserving its earlier cycle.
- A saved request or local site result may still be pending. After a lost response,
  review/recover that original attempt before creating another physical transaction.
- Inventory form entry needs the account permission and the form's role/account
  grant. Submitted linked form data is immutable; sales corrections happen on its SO.
  Archived definitions keep historical schemas/revisions and block new entries.

Related manuals: [connected forms](connected-data-forms.md),
[sales stock review](sales-stock-approval.md), [production](production-sop.md),
[shop floor to delivery](shop-floor-to-delivery-sop.md),
[phone operations](mobile-warehouse-app.md).

## Internal budget requests versus supplier receiving

**Internal purchase request → approved budget → liquidation** is a separate roadmap:

1. Staff with `purchasing.request` submit the reason, items, quantities and estimates.
   Items need not exist in the catalogue.
2. An approver with **`purchasing.approve_requests`** approves the overall budget and
   chooses requester cash or an eligible buyer. Supplier `purchasing.manage` alone
   does not grant this approval.
3. Record actual cash issued separately where applicable. The named buyer purchases
   within the approved total, uploads receipts and submits actual item costs.
4. The approver reviews liquidation, records exact change returned/reimbursement paid
   for requester cash, and closes, or returns it with a reason for correction.

None of these steps automatically creates a supplier PO, receives stock or pays a
supplier. The mobile **Receive PR** label refers to supplier goods receiving, not
this internal spending request.

## Pre-system physical units

**Pre-system unit → QC → QA → sticker → RTS stock** covers already-existing goods:

1. In mobile RTS recording choose **Enter or resume pre-system unit**. Enter one
   product/unit, distinct physical identifier, location, photo, reason and valuation.
2. The inspection-only LI record creates no stock, BOM kit or component consumption.
   QC selects the intake/job group and matches the physical identifier before checks.
3. QA performs the second pass. A sticker is not required before inspection; unclear
   identity must stop the check. Failed/rework/held units remain in their quality flow.
4. After final pass, receiving prints, attaches and camera-scans the correct sticker,
   verifies storage/capacity and posts ordinary Products In once. Only that receipt
   adds stock at the declared legacy cost.

Use the saved original intake after an interrupted response. Do not create another
intake or use manufacturing Add unit for the same physical item.
