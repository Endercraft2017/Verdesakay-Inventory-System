# Mobile stock actions and optional warehouse splits

Chunk 25 implements the approved Stock In, Stock Out, Transfer, Report Damage and saved-action views. It keeps the mobile header, dock, item picker, item-detail handoffs and permission gates.

## Forms and results

- Quantity uses positive whole numbers, matching the existing API schemas. Build state appears only for fresh server-identified finished products (`is_finished_product`); parts use `assembled` internally. Cached picker metadata does not decide an item's build state.
- Location balances and eligible movable quantities are distinct. Stock Out, Transfer and Damage prevent new negative source balances; reserved or serialized stock follows its existing workflow. Zero remaining is allowed. Stock In remains available for replenishment, provided its resulting balance is nonnegative.
- Short location names are not repeated beneath the selector; long paths remain visible. Quantity/build state share a row, and quantity fills the row for parts.
- Reads use account/server/route ownership and a 12-second bound, with loading, malformed-response and Retry states. Submission locks before storage/network awaits. JSON writes have a 15-second bound; uncertain results preserve their original key and exact payload.
- Transfer derives tracked quantity from selected unit IDs. Changing source/build state saves immediately and clears incompatible serial selection.
- A stock result replaces its form and opens at the top with its confirmation heading focused. It shows the original action, item, quantity/unit, locations, finished-product build state, reason and selected serials. Unknown, refused, phone-queued, site-PC pending, conflict and confirmed states have separate recovery paths. Incomplete write responses remain unresolved under the original request key.
- Damage retains its phone queue. Page and service worker atomically retain an owned response receipt when removing a delivered queue operation; disappearance alone never means success. Discard is distinguished from confirmation, and receipt-enabled queued actions expire before the server's seven-day retry-key retention window. Confirmed Damage keeps the existing attachment workflow, with scoped reads and repeated-pick protection.

## Optional sources in Stock Out

The single-source form remains the default. **Use other warehouses** expands quantities inline, starting with zero allocation at every source. The requested quantity must equal the explicit split, with each source at or below its movable balance. **Use one warehouse** restores the original source limit. No automatic allocation or transfer is implied.

The stock API now adds `assembled_movable` and `semi_built_movable` alongside existing fields. These exclude serialized units and protected sale/batch/production-kit/repair quantities; sale demand represented by reserved serials or batch allocations is not counted twice.

### Grouped write contract

`POST /api/inventory/:id/stock-out` requires the existing `inventory.adjust` permission, `application/json`, and a stable `Idempotency-Key` on a new request.

```json
{
  "quantity": 5,
  "reason": "Issued for service",
  "build_mode": "assembled",
  "sources": [
    { "location_id": 1, "quantity": 3 },
    { "location_id": 2, "quantity": 2 }
  ]
}
```

Each quantity is a positive whole number; source IDs must be unique, the source sum must equal `quantity`, and an action accepts at most 100 sources. Parts cannot request semi-built stock. Legacy order-picking adjustments cannot bypass order/kit release.

`BEGIN IMMEDIATE` covers source validation, every stock/history change and the authorized idempotency receipt. A source failure or receipt-storage failure rolls back everything. The middleware rechecks existing receipts inside that transaction; a concurrent/repeated request returns the original result, while changed bodies or accounts cannot reuse the key.

The response includes `ok`, the item's resulting grand-total `quantity`, `moved_quantity`, `build_mode`, and each source's quantity, location name and resulting location balance. An installed-PC acknowledgement retains its existing `X-Sync-State: local` and command identity.

New grouped actions cannot overdraw, including on an installed PC. Replaying an already-recorded physical action retains existing D1 discrepancy handling when another transaction changed stock while disconnected. This preserves the record of goods already moved; it does not authorize a new negative-stock submission.

## Verification

Automated coverage lives in:

- `tests/inventory-multi-source.test.ts`: explicit splits, exact-zero balances, permission/input validation, duplicate/concurrent retries, changed payloads, build states, protected sale/serial overlap, late-source rollback and receipt-storage rollback.
- `tests/sync-inventory.test.ts`: one grouped local command, replay identity, new local overdraw rejection and existing physical-action discrepancy handling.
- `tests/frontend-mobile-stock-actions.test.ts`: all four forms/results, category visibility, limits, optional sources, serial quantity, immediate locks, durable retries, malformed/late/timed-out reads, account changes and queued results.
- `tests/frontend-mobile-scan-sync-ux.test.ts`: owned queue receipts, worker delivery, discard, refusal and expiry.
- `scripts/test-mobile-stock-actions.mjs`: the actual mobile app/router/API and IndexedDB against disposable Express/SQLite, with real stock/history assertions, lost-response retry, queued Damage, exact serial transfer, photo cancellation, permissions, scrolling, keyboard use and light/dark accessibility scans.

Run `npm run check`, then `MOBILE_STOCK_ACTIONS_OUTPUT=<evidence directory> node scripts/test-mobile-stock-actions.mjs`. The browser script creates and deletes its own database; it never opens production records. Its site-PC response-header case is simulated; actual node/cloud replay is covered separately by sync integration tests. Camera hardware and production deployment are not exercised by these checks.

Validation on 24 October 2026 (Asia/Manila): the full repository check passed 307 files / 3,326 tests. Final focused coverage passed 69 tests after the result-scroll and JSON-contract follow-ups, and TypeScript passed. The real-backend stock browser run passed 13 scenarios and 14 WCAG A/AA scans with no runtime errors; the existing real-backend mobile Sales suite passed 19 compatibility cases.
