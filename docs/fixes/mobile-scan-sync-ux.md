# Mobile Scan and Pending sync UX

Chunk 23 covers Scan entry, the scanner overlay, scanned result, Pending sync, and
the discard confirmation. It preserves the existing phone navigation, scanner
chrome, picked-item card, stock/production handoffs and queue cards. The result
uses **Scanned** once, in the top bar, with the matched item as its content heading.

Review: https://chatgpt.com/space/page_9a01899a68a881919c6bdc4e25c049a9

## Source findings and resulting behavior

- Lookup previously had no pending state, reopened the camera after every error,
  and could overwrite the next route. It now has one bounded, account-owned read
  through `mReadScope` and the API's existing `isCurrent` guard before 401 handling.
  The code stays available with inline Retry/Edit, and malformed responses remain
  recoverable. The camera still opens automatically on entry; errors do not reopen it.
- Item results retain quantity/UOM and SKU; unit and batch results retain production
  identity, balances, reservations, allocations and the existing record handoff.
  Adjustment buttons require `inventory.adjust` and the existing route access.
  Record buttons use existing record access. Scanning changes no stock.
- Scanner manual input now has a visible label, a responsive form, blank-code
  feedback and 44px close/light controls. Repeated keyed opens focus the same
  overlay. Permission/capability failures retain manual fallback, with Retry camera.
  Camera-only physical sticker verification elsewhere still forbids manual entry.
  Camera attempts are bounded; late native streams stop their own tracks, and a
  late ZXing reader owns its original video element. Hash/account/hidden-app/page
  departure closes the overlay. Torch state changes only after track acceptance.
- Pending sync no longer infers an active send from `navigator.onLine`. Full action
  labels, saved time and explicit waiting/sending/rejected/uncertain/local states
  are visible. A failed storage read shows recovery; previously loaded rows remain
  identified as last loaded, with actions disabled until a fresh read succeeds.
- Discard names the action and focuses Keep action. It explains that deleting a
  phone copy cannot undo a result received by the server/site PC. Repeated taps
  share one local operation; failure remains in the same dialog. Account/view
  departure closes it without painting a result on the next screen.

## Queue contract

`queue-store.js` is a small IndexedDB protocol shared by `queue.js` and `sw.js`.
It uses the existing version-2 `ops` and `meta` stores, so there is no schema reset
or deletion of existing queued work. Old unstamped rows retain their prior account
compatibility. New rows carry their account and configured server base.

A transaction reads the operation and sign-in metadata, then claims a 45-second
lease before a send. Page retry/flush jobs join locally; cross-tab and service-worker
claim/discard races use the same transaction. API/fetch work is bounded to 15 seconds,
including response bodies. Expired leases recover a closed/crashed sender. A late
settlement cannot recreate a discarded row or overwrite a newer lease. Native
browser worker/page contention is covered separately from the in-process tests.

The original idempotency key and body remain unchanged on retry. Multiple attempts
are not evidence of multiple stock movements; server deduplication remains
unchanged. Timeout/disconnect/account cancellation means **result not confirmed**,
not proof that the server did not receive the write. Deterministic rejection stays
visible and is not retried by automatic replay. Explicit Retry retains the same key.

A site-PC acknowledgement retains `local_command` and is checked through the existing
`GET /sync/command/:id`; it is never posted again as a fresh action. Confirmed commands
remove the tracked copy; rejected/conflicting commands stay marked for attention.
The empty state refers only to this account's phone queue, not all cloud sync.
The existing pending badge still counts tracked commands; sign-out uses `unsentCount`
to avoid describing an already acknowledged site-PC command as an unsent phone write.

Account changes abort page transport, guard late 401 handling and stop subsequent
old-account replay. Already-sent results may settle only their original lease/row.
The worker checks current sign-in metadata before each next operation. Foreign
account/server details are not rendered. All browser fixtures use fictional data;
no production DB or real stock transaction was used.

The new helper is declared before `queue.js` in the shell and precache. Worker
cache version is `v146`.

## Validation

- Focused source tests cover navigation/account departure, lookup recovery, precise
  item/batch handoffs, repeated taps, native IndexedDB transactions, cross-tab and
  worker contention, uncertain outcomes, local acknowledgements, lease recovery,
  delayed camera readers, torch failure, incomplete bodies and discard recovery.
- Actual-source Chromium: 44 checks, including a native service worker imported
  from the real script, two saved actions raced against a page flush, and offline
  shell installation. Ten targeted WCAG 2 A/AA and 2.1 AA scans passed across five
  surfaces in light/dark themes. Layouts, including long matched codes, were checked at 320/360/768/1024/1440px.
- The approved mock's 58 checks/10 scans are proposal evidence, separate from the
  implementation checks. Actual captures and the interactive mock remain in the Page.
- Full repository validation and final commit are recorded after completion below.

Physical camera/torch hardware and OS-scheduled background delivery were not tested.
Camera/track behavior uses isolated fixtures; native service-worker replay is invoked
explicitly. Server lookup, production labels and idempotency contracts use disposable
SQLite fixtures through the existing tests. No permission or stock rule changed.
