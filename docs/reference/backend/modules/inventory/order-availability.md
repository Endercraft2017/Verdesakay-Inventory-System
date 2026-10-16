# `src/modules/inventory/order-availability.ts`

Shared sale available-to-promise (ATP) and supply planning. `orders.routes.ts` re-exports `orderAvailability` for existing import compatibility and uses it for approval gates and shortage actions.

## Stock calculation

The sale's ship-from location is used, falling back to the default warehouse. `inventory_stock` supplies local on-hand; `inventory_items.quantity` is only used to explain stock elsewhere. Other reservations at that location, other unfulfilled firm sales' bulk picks/unpicked demand, draft kit picks and repair holds reduce free stock. Own picked/reserved/shipped coverage is retained without subtracting shipped units from on-hand a second time. Repeated legacy sale lines share the stock pool rather than each seeing the original balance.

`available` is coverage for the order plus remaining free stock, so it may exceed ordered quantity. `shortfall` is `max(0, ordered - available)`. Draft supply never changes either field. Non-stock lines are skipped. QA/RTS mismatch holds apply before finished stock receipt; unreceived held output is not on-hand and is not subtracted again here.

## Planned supply

Linked job-order remaining cover is `max(0, qty_ordered - qty_scrapped - received_quantity)`, including completed jobs still awaiting receipt; cancelled jobs and jobs targeting another output location do not cover the selected warehouse. Direct BOM components match actual job-order snapshots, including subassemblies as stock items. Existing draft snapshots supply unpicked requirements; released kits already left stock and require no repeat purchase. Draft jobs' component pools use their own source locations. Shared material demand consumes one pool after the sale's own stock requirements.

The aggregate `purchase_requirements` contains `item_id`, `name`, `shortage`, `pending_purchase`, `to_purchase`. Live linked PO quantities minus GRN quantities provide pending cover. Current PO lines are used, so replacing lines or reducing quantities updates cover; cancelled/closed POs do not cover demand. New POs link via `sale_shortfall_purchases` (integer ID, two order FKs, unique purchase order, source index). Older exact system notes `Shortfall for <current SO number>` are recognized without a data migration, unless the PO already has a structured link to another sale. Arbitrary historical notes are not inferred.

## Response additions

The existing `{ok,short_lines,lines}` contract remains. Added `location_id`, `location_name`, `uses_default_location`, `non_stock_lines`, `purchase_requirements`, `linked_purchase_orders`. The legacy `committed_elsewhere` includes other orders and stock holds; `committed_orders` separates other sale commitments for display without counting holds twice. Line additions: `elsewhere_on_hand`, `kit_held`, `repair_held`; linked jobs include source/output locations. The availability GET additionally supplies `revision` and `order_status` in the same read.

## Decisions and sync

`shortfallActionSchema` and `orderStatusSchema` accept optional `expected_revision`. Desktop reviews supply it; legacy mobile callers remain valid without it. Stale interactive actions return `409 code:'stale_order'`. Stock is still recalculated within approval, even when the order revision matches.

Owning-site decisions retain D6 if the cloud revision diverges. Replay-only conflict audit rows are inserted **after** planned supply rows to avoid consuming those rows' allocated IDs. New links use normal replicated-table identity/session handling. Supply actions wrap the whole operation in a transaction; shared creation helpers use savepoints so one supplier/job failure rolls back the entire sale action.

Tests: `order-planning.test.ts`, `sync-order-planning.test.ts`, existing `order-availability.test.ts`, `order-shortfall-actions.test.ts`, `sync-sales.test.ts`. Mobile follow-up: [root handoff](../../../../../MOBILE-INVENTORY-HANDOFF.md).
