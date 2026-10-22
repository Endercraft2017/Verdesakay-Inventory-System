# Mobile courier pickup validation — 2026-10-16

Courier bookings now expose Record courier pickup rather than Start delivery.
Carrier/tracking appear in context, and terminal records say Picked up by courier.
Collector, photos, signature and GPS are optional by owner decision across mobile,
backend and desktop collection. Warehouse-out and assignment checks remain;
supplied signatures must belong to the booking. Collection does not deduct stock.

Tracking/photos and original submissions use the existing scoped durable recovery.
The browser tests close/reopen persistent Chromium, verify restored tracking and
photo bytes, then lose a committed pickup response and retry the original key/body.
The server returns one pickup and one photo. Empty-evidence physical pickup is
refused before warehouse-out and succeeds after its slip without another stock-out.

Verification:

- TypeScript passed.
- 182 focused tests across six files passed.
- All 2,819 tests across 276 files passed (495.62 seconds).
- All 27 real-backend Playwright checks passed at 390×844; zero page errors.
- Restored-draft and confirmed-record screenshots were inspected; no horizontal overflow.
- `git diff --check` passed. PWA cache v106.

The role specification has no dedicated courier/driver Figma frame. The existing
vanilla delivery components were extended; Work reference 46:548 was retrieved.
This does not claim dedicated courier design approval or physical phone testing.
CKD whole-kit partial UI parity remains a separate handoff item.

The final gate includes shared-branch updates through `d27979c` (sale-line
allocation, invoice recovery and form-entry access). Rebase conflicts retained
both sets of documentation; courier and release APIs were retested together. A
production-approval assertion now waits for its actual ready control instead of
a fixed 80 ms delay. Repeated-SKU mobile line selection remains a separate gap
recorded in the handoff; unique-line courier release compatibility passed.
