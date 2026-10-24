# Mobile stock lookup and activity

Chunk 24 covers five existing views: Find item, Item detail, Low stock, Location contents, and My activity. It implements the approved compact proposal while keeping the original header, Work navigation, floating item action arc, permissions, stock categories, and existing workflow destinations.

## User-visible changes

- Find item puts search first, groups results into compact native button rows, and labels recents as shortcuts that load current stock. Item type searches the server. Long names and SKUs wrap. Search failures retain the query and offer Retry. Results render in batches of 50 without hiding remaining matches permanently.
- Item detail groups on-hand, reorder, available, and sales commitments into one overview. The authoritative item response already contains stock and history, so no second stock request is needed. Totals explicitly cover all locations. Units and existing assembled/semi-built quantities remain distinct. Composition expands inline; recent movements use full Manila timestamps. A failed image differs from an absent photo.
- Low stock labels the quantity and reorder point with the item's unit, uses the server's inclusive `quantity <= min_quantity` wording, and combines filtering with refresh.
- Location contents keeps the selector and direct-stock scope. It never sums pieces, metres, and other units into one total. Empty parents with stocked descendants are explained. Long paths stay visible, and only the currently selected location's response may render.
- My activity retains the signed-in user's movement filter and uses the endpoint's total, limit, and offset. Newer/Older appear at both ends of the list. Full dates group movements in Asia/Manila; full reasons and location names remain visible. Empty, malformed, failed, and off-page responses have separate states.
- Native Back restores the previous query, filter, activity page, focus, and scroll position. The return state is private memory scoped to the sign-in, server, and permission set.

## Lifecycle and compatibility

All five views use the existing bounded `mReadScope`. Query and location changes invalidate older results before the API's late-response handling; departed or changed-account screens cannot repaint. Repeated picks, refreshes, photo actions, and form handoffs have one owner. Existing forms receive an isolated destination so a late form render cannot overwrite the next route.

The reusable picker keeps its `{el, focus}` contract, existing callbacks, and `.m-picker-item` / `.m-picker-list` automation selectors. Persistent Sales, batch, count, and repair pickers unlock after the callback completes; stock adjustment and transfer return their async form promises so duplicate handoffs stay locked. The locations helper keeps `load(force)`, `select`, `path`, and `list`, adding optional request ownership and clearing its memory cache when identity changes. Existing recent-item records remain readable without inventing their missing item type or current quantity. Legacy cached unit objects cannot revive an old serialized-unit status; live scan context still survives detail refresh.

`mPhoto.capture(itemId, opts)` adds optional ownership, abort, and upload-start hooks while preserving the old call signature. Native picker cancellation settles and removes the input. Account departure during compression prevents upload. Photo URLs are revoked on refresh, departure, or late completion. Only the upload transport is bounded; choosing a photo has no artificial timeout.

The existing Quick Orbit stays available and movable. Its default position clears the item action arc; saved positions retain their existing drag behavior. Stock styling is scoped in `public/mobile/stock.css`; the service-worker shell includes the new assets and advances to `v149`.

## Verification

- `npm run check` passed TypeScript and 3,265 tests across 305 files. The final exact-movement focus regression was then verified in the 51-test stock/Chunk 1 run and the full-app browser follow-up; the final TypeScript check passed again.
- The new `tests/frontend-mobile-stock-lookup-ux.test.ts` exercises stale results, account/server changes, cache ownership, typed result validation, timeouts, permission combinations, single handoffs, native photo cancellation, object URL cleanup, search restoration, direct/subtree stock semantics, and activity paging.
- Actual app source, router, API client, chrome, and native browser storage passed 89 fixture-based Playwright checks, including native Back and document scrolling, exact movement focus when an item repeats, keyboard activation, delayed locations, read-only accounts, long content, and 44 px targets from 320 × 640 through 1440 × 900.
- Twelve scoped axe scans (the five implemented views and current Find item results, each in light and dark mode) reported no WCAG 2 A/AA or 2.1 AA violations; no runtime errors were captured in those browser sessions.
- The existing mobile Sales acceptance script passed 19 checks against a disposable Express/SQLite backend, including repeated item selection and approval handoffs. It uses no production database.
- The existing read-only inventory bootstrap fixture now includes `stock` and `history`, matching the actual item endpoint rather than depending on the redundant second stock request.
- The earlier Chunk 1 fixture loads the shared helpers and checks zero stock plus loaded freshness rather than the removed connection-only badge.

Browser screenshots use fictional inventory and API responses. They establish frontend rendering and interaction behavior, not live server stock changes or measured completion speed with real users. Native photo cancellation was checked; camera hardware was not needed for this chunk.
