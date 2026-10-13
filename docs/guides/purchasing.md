# Purchasing: receiving & vendor bills (3-way match)

**For:** warehouse / receiving staff, purchasing, accounts payable
**In the app:** Inventory → **Purchasing** (Goods Receipts, Vendor Bills), and the
**Receiving & bills** icon on a purchase-order row

---

## What it's for

A purchase order on its own is just a document. Purchasing adds the two things that make
it trustworthy:

1. **Goods receipts** — record what physically arrived, which posts that stock into a
   location.
2. **Vendor bills** — record the supplier's invoice, and don't let it be approved for
   payment until a **3-way match** passes:
   - billed quantity is covered by what was **received** (counting earlier approved
     bills), and
   - billed unit price is within tolerance of the **PO price**, and
   - nothing is billed that isn't on the PO.

## Before you start

- **Receiving** needs the **Adjust inventory** permission.
- **Raising and approving vendor bills** needs the **Edit orders** permission.
  (So the warehouse receives; accounting approves.)
- The purchase order should have its **Supplier** set (Orders → Purchase Orders → New/Edit).

## Receiving a delivery

1. Orders → **Purchase Orders** → click the **Receiving & bills** icon on the PO row
   (or Inventory → Purchasing → open the PO from a receipt/bill).
2. Click **Record receipt**.
3. Choose the **location** the goods go into.
4. For each line, enter the quantity that actually arrived (it pre-fills with what's
   still outstanding). Leave a line at 0 if none of it came.
5. **Post receipt.** Stock moves in immediately; you'll see it in the item's history as
   "Goods receipt GRN-…".
6. The PO panel now shows **received vs ordered** per line and an overall status:
   *not received → partial → received* (or *over-received* if a line exceeds the PO).

Receive as many times as there are deliveries. Recorded a receipt by mistake? Open it
and **Delete** — the stock it posted is reversed.

## Entering and approving a vendor bill

1. On the PO panel, click **New vendor bill**.
2. Enter the supplier's **invoice number**, bill date, due date, tax %, and the lines
   they're charging (pre-filled from the PO — adjust quantities/prices to match the
   invoice, add lines for extra charges).
3. Save. The bill starts as **draft**.
4. Open the bill and read the **3-way match panel**:
   - **Clean** → click **Approve**. Done.
   - **Exceptions** → each problem line is listed (billed more than received, price off,
     not on PO). Options:
     - Receive the missing quantity, then approve.
     - **Edit** the bill to match reality, then approve.
     - **Force approve** — records "Force-approved over N exception(s)" with your name and
       an optional note. Use for agreed surcharges, freight, rounding.
5. **Dispute** parks the bill with a reason instead of approving. Editing a disputed
   bill returns it to draft.

## Match tolerance

Open **Match tolerance** from Goods Receipts or Vendor Bills. The price percentage
starts at **2%**; the dialog also sets an absolute peso allowance and quantity percentage.
A price exception occurs only when both price allowances are exceeded (the looser one wins).
Changing the settings and clicking **Save** requires **orders.edit**.

## Phone receiving

**Work → Receive PR** is a quick stock movement, not a desktop goods receipt. It does
not create GRN coverage for the three-way bill match. Use **Record receipt** on the PO
when matching and approving vendor bills, and avoid recording the same delivery twice.

## Tips & gotchas

- **Receiving moves real stock.** Only post what actually arrived; use the reverse
  (delete) if you fat-finger it.
- **The match counts earlier approved bills.** You can't split one delivery across two
  bills that together exceed what was received.
- **Extra charges** (pallet fee, freight) that aren't PO lines will always flag — that's
  intentional. Force-approve with a note, or add them to the PO first.
- An **approved** bill can't be edited or deleted — **Dispute** it to re-open.

## If something goes wrong

| What you see | Why | Fix |
|---|---|---|
| "Not a purchase order" | You opened Purchasing for a sale/job order. | Only `type = purchase` orders have receiving. |
| Approve returns "3-way match failed" | Billed qty > received, or price outside tolerance, or a non-PO line. | Receive the shortfall / fix the bill / force-approve with a note. |
| Stock didn't change after a receipt | The line had no linked inventory item, or quantity 0. | Link the line to an item and enter a quantity. |
| "Dispute an approved bill instead of deleting it" | Approved bills are locked. | Use **Dispute** to re-open, then edit or delete. |
