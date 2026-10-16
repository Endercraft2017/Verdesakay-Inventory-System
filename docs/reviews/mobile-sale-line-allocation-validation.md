# Mobile exact sale-line allocation — 2026-10-16

`#/so` exposes physical line IDs, build state, price/currency and remaining
quantities. Repeated item/batch/serial matches require an explicit open-line
choice, followed by physical QR verification. A stale line link cannot silently
select another line. Completed lines are excluded; a unique open match proceeds.
CKD manifests remain separate from component allocation, with parent kit IDs
shown for component lines.

New allocations include `order_item_id` in the appropriate bulk or serial
payload. Saved recovery keeps that original line, quantity, serial/batch and key;
unknown results are retried without substituting a different line. Existing
saved requests remain unchanged. Shared stock is calculated for the same product
and build state, excluding current reservations, and is never summed across rows.
The release context includes line price and order currency to distinguish equal
products at different prices. No permission or stock-out rules were relaxed.

Verification completed:

- TypeScript passed.
- 160 focused mobile, order-release and release-slip tests passed.
- 33 real-backend Playwright checks passed at 390×844, with zero page errors.
- Repeated batch lines: select the second price line, commit then lose the
  allocation response, restart Chromium, retry identical body/key, allocate the
  remaining line, then confirm warehouse-out. Exact line IDs persist on both
  batch reservations and slip rows. Stock is deducted once, at the slip.
- Plain SKU: choose a semi-built line beside an assembled line; the other line
  remains unallocated and stock remains unchanged before physical warehouse-out.
- Serialized QR: choose the second same-SKU/same-build price line; the actual
  reserved unit carries its line ID and the first line remains empty.
- Focused restart tests cover bulk, batch and serial original-line recovery;
  stale links and build-specific quantities are covered separately.
- Figma 78:109 and 78:147 context/screenshots retrieved; the existing role
  primitives were extended. The new line-choice phone render was inspected.
- PWA cache v107. No new schema or external dependencies.

Full regression: all 2,823 tests across 276 files passed (513.15 seconds).
`git diff --check` passed.
CKD whole-kit partial release, pre-slip undo and physical phone/printer acceptance
remain separate work.
