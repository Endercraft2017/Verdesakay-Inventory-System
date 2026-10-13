# Capturing a sales order

Use this step to record what the customer needs before checking stock and approving
the order for the warehouse.

## Before you start

Open **Sale Orders** in the desktop app. You need **Create orders** for a new order
and **Edit orders** to save changes. Staff with view access can open order details
without editing them. The same editor adapts to a narrow browser; the dedicated
mobile warehouse app handles release, rather than sales intake.

## Record the customer and items

1. Select **New Sale Order**. It starts as **open**.
2. Choose a customer on file to fill their name and contact, or enter walk-in details.
   Check the ship-from location, order date, and currency.
3. Use **Add inventory item** for physical goods. Search by name or SKU and choose
   the item. The picker shows on-hand stock across locations; this is not a promise
   that stock is available for this order. Items with no stock can still be ordered.
4. Enter a positive quantity and a non-negative price. Free items may have a price
   of zero. If the same stock item is needed again, update its existing quantity.
   Each stock item must use one line so warehouse release and availability can
   track its full quantity together.
5. Use **Add non-stock line** for delivery fees, installation, or other services.
   These lines do not reserve, deduct, or trigger production of inventory. Typing
   an inventory item's name does not link it automatically. Use **Link inventory
   item** if that line should represent stock instead. **Make non-stock** removes a
   link without deleting the line.
6. Review the stock/non-stock line count, totals, tax, and notes. Select **Save open
   order**. Saving intake does not approve the order or move stock.

The intake editor does not allocate or sell finished units. Warehouse release is
handled at the release stage after approval; use that workflow to choose goods.

## Correcting mistakes

An unnamed line or invalid quantity/price stays on screen. The editor focuses the
field to correct; it does not silently remove the line. Dates must be valid calendar
dates. A deleted customer, location, inventory item, or tax code must be replaced
before saving. If inventory search fails, select **Try again**.

After approval, line items, tax classification, and currency are locked. The ship-from
location is also locked once picking or fulfilment has started. To change lines, save the order as
**open**, then reopen its editor. Reopening clears warehouse reservations, so
coordinate that change with the warehouse. Approval and shortage resolution are
the next workflow checkpoint.

The editor asks before discarding unsaved changes and prevents editing or closing
while a save is pending. If another person changes the order while it is open, your
save is blocked and your edits remain on screen. Use **Review latest order** to load
their changes after confirming that your own unsaved edits may be discarded. A
network retry of the same save reuses its save key to avoid creating another order.

## Scope of this refinement

This changes the intake editor and validation. Existing orders are not migrated.
The API still supports existing integrations that create directly into a firm status,
with the existing stock-availability gate. The broader approval/status lifecycle
and dedicated mobile release/picking flows need their own workflow reviews.
Manual entry of **released** is blocked: the warehouse release action sets it after
picking. API edits may omit unchanged fields; browser edits carry an edit revision,
while legacy integrations can continue without one. Offline edits validated at the
owning site keep the existing site-decision sync rules when replayed to the cloud. Existing dates and currency
must satisfy validation when saving; unsupported historic values require correction.
