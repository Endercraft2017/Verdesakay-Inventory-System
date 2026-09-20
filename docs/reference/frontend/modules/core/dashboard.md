# `public/js/views/dashboard.js`

## Purpose
Renders the landing page after login: KPI stat cards, a low-stock item list, and a
recent-messages panel, plus quick-action buttons that jump to other views. It is the
`dashboard` nav leaf (top of the primary nav, `NAV` in `nav-config.js`).

## Registered route(s)
```js
App.register('dashboard', async (view) => { ... })
```
Single route, no `filter` support — the callback signature doesn't even accept a second
argument.

## Structure / key functions
This file is a single `App.register` callback with one small local helper:

- **`statCard(cls, ic, label, value)`** — returns the HTML for one stat card
  (`.stat-card`, optional modifier class `warn`/`alert`, an `UI.icon`, and a value/label
  pair). Used inline to build the six cards in the `.cards` grid.
- **Data loading** — a single `Promise.all` fires up to six requests in parallel, each
  gated by a permission check so users without a given permission never issue the
  request (they get an inert fallback value instead — see below).
- **Render** — builds the topbar (greeting + 3 quick-action buttons), the `.cards` grid,
  and a `.grid-2` of two panels: "Items needing restock" (from `/inventory?low=1`) and
  "Recent messages" (first 5 inbox rows via `inbox.slice(0, 5)`).
- **Wiring** — `view.querySelectorAll('[data-go]')` click handlers call
  `App.navigate(b.dataset.go)` for the quick-action buttons and for clicking a message row
  (which just navigates to `messages`, it does not open the specific thread).

Empty states use `UI.emptyState(...)` for both the restock list and the recent-messages
list when there's nothing to show.

## API endpoints used
All conditional on the matching permission (see below); when the permission is absent the
call is skipped and a zero-value fallback is used instead so the `Promise.all` never rejects:

| Endpoint | Guard | Fallback if no permission |
|---|---|---|
| `GET /inventory/stats` | `inventory.view` | `{ total: 0, low_stock: 0, total_value: 0 }` |
| `GET /inventory?low=1` | `inventory.view` | `[]` |
| `GET /messages?box=inbox` | `messages.view` | `[]` |
| `GET /forms` | `forms.view` | `[]` |
| `GET /messages/unread-count` | `messages.view` | `{ count: 0 }` |
| `GET /users` | `users.manage` | `null` |

Note `stats.out_of_stock` is read directly in the card render (`stats.out_of_stock || 0`)
even though the fallback object above doesn't define it — harmless since the fallback is
only used when `inventory.view` is absent, in which case both stat cards show 0.

## Permissions honored
- `inventory.view` — gates the Inventory stats/low-stock requests and cards.
- `messages.view` — gates inbox/unread-count requests, the "Unread messages" card, and
  the recent-messages panel.
- `forms.view` — gates the `/forms` request and "Files available" card.
- `users.manage` — gates the `/users` request and the "Staff accounts" card (the card
  itself is conditionally included in the `.cards` grid via a ternary, not just hidden).

None of these gate the quick-action buttons (Item/Upload/Message) — those always render
and simply navigate; the destination view is responsible for its own permission checks.

## Dependencies
`App.getMe()`, `App.hasPermission()`, `App.navigate()`; `API.get`; `UI.icon`, `UI.esc`,
`UI.fmtDateShort`, `UI.initials`, `UI.emptyState`. No other view-local files.

## Notes / gotchas
- All six data requests run in one `Promise.all`, so a slow/failing permission-gated
  endpoint (rare, since gating already prevents unauthorized calls) would block the whole
  render — there's no per-panel error isolation or loading skeleton beyond the initial
  blank view.
- Clicking anywhere in a message row navigates to the `messages` view in general (no
  `filter` passed), it does not deep-link to that specific message/thread — that's on
  purpose, deep-linking into an open message would require a different filter contract.
