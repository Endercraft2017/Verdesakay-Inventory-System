# `public/js/views/messages.js`

## Purpose
Internal messaging: Inbox/Sent tabs, thread view with reply, compose modal, delete.
Renders the `messages` nav leaf's `Inbox` and `Sent` sub-destinations.

## Registered route(s)
```js
App.register('messages', async (view, filter) => { ... })
```
- `filter.box` — `'sent'` opens the Sent tab; anything else (including absent) opens
  `'inbox'` (the default). Set by the nav leaves `{ route: 'messages', filter: { box:
  'inbox' } }` / `{ ..., filter: { box: 'sent' } }`. Stored in the local `box` variable,
  which the tab buttons subsequently mutate directly (not re-read from `filter` again).

## Structure / key functions
- **`setTab()`** — toggles the `secondary` class on the two tab buttons so the active one
  loses the `secondary` (muted) styling.
- **`load()`** — `GET /messages?box=<box>`. Empty state differs by tab ("Your inbox is
  empty" vs "No sent messages"), both with a Compose CTA. Non-empty: renders `.msg-list`
  rows (avatar initials via `UI.initials`, unread rows get an `unread` class + "NEW" pill
  when `box === 'inbox' && !m.read_at`, subject, body preview, relative date). Each row
  click opens `openMessage()`.
- **`openMessage(m)`** — if viewing an unread inbox message, immediately `POST
  /messages/:id/read` (fire-and-forget with a bare `catch {}`) and calls
  `App.refreshUnread()` to update the chrome's unread badge. Then opens a modal showing the
  full message (From/To label toggles by `box`, sender's name+username, date, full body).
  `confirmText` is `'Reply'` when in Inbox (`null` — i.e. no confirm button — when in
  Sent, since you can't reply to your own sent message from this dialog); `onConfirm`
  opens `composeModal()` pre-filled with the other party, prefixed subject `'Re: ' +
  subject`. `onOpen` manually injects a Delete button into the modal's `.modal-foot` via
  `prepend` (styled `margin-right:auto` to push it left of Close/Reply) since `UI.modal`
  doesn't have a built-in extra-footer-button option; its click handler deletes then closes
  the overlay and reloads the list. After closing, if still on Inbox, `setTimeout(load,
  300)` refreshes the list (to reflect the now-read state / unread badge count) — the 300ms
  delay is not otherwise explained but nothing else fires on it.
- **`composeModal(toId, toName, subject)`** — fetches `GET /users` for the recipient
  `<select>` (excludes self via `u.id !== me.id`; each option is labeled `Full Name
  (@username) · Department`), pre-selects `toId` if given (from a reply). On confirm:
  validates recipient + non-empty body, `POST /messages` with `{ recipient_id, subject,
  body }`; only reloads the list if currently on the Sent tab (an Inbox view sending a
  reply doesn't need to refresh its own inbox).
- Tab buttons and the Compose button are wired once at the bottom; `box = b.dataset.box;
  load()` on tab click.

## API endpoints used
| Endpoint | Used by |
|---|---|
| `GET /messages?box=inbox\|sent` | `load()` |
| `POST /messages/:id/read` | `openMessage()` (marking an opened unread inbox message read) |
| `GET /users` | `composeModal()` (recipient list) |
| `POST /messages` | `composeModal()` (send) |
| `DELETE /messages/:id` | `openMessage()`'s injected Delete button |

## Permissions honored
None — no `App.hasPermission` checks in this file. Server-side, all `/messages` routes
require only 🔑 any logged-in user (per `docs/ARCHITECTURE.md` §4); delete is
self-scoped server-side to sender/recipient of that message.

## Dependencies
`App.getMe()`, `App.refreshUnread()`; `API.get/post/del`; `UI.icon`, `UI.esc`,
`UI.initials`, `UI.fmtDate`, `UI.fmtDateShort`, `UI.emptyState`, `UI.toast`, `UI.modal`.

## Notes / gotchas
- **Delete button is hand-inserted into the modal footer**, not a `UI.modal` option — if
  `UI.modal`'s footer markup (`.modal-foot`) changes shape, this `prepend` wiring in
  `openMessage`'s `onOpen` would need updating too.
- **Read-marking is fire-and-forget**: `openMessage` awaits the `POST /:id/read` call but
  swallows any error silently (`catch {}`), so a failed read-mark doesn't block opening the
  message — the unread badge/list state might drift from server truth if that request
  fails, self-correcting only on next `load()`.
- **Reply only available from Inbox.** `openMessage`'s `confirmText`/`onConfirm` are
  `null` when viewing a Sent message, so there is no button-driven way to reply from the
  Sent tab's thread view — the user must use the top-level Compose button instead.
