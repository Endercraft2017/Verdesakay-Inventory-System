# `public/js/modules/core/messages.js`

## Purpose
Full chat UI for internal 1:1 messaging: a conversation list (left pane) + a threaded
bubble view (right pane), with reactions, reply, edit, sender-only soft delete ("Message
was removed"), file/link previews, and live updates over `ChatWS`
(`public/js/lib/chat-ws.js`). Replaced the old Inbox/Sent email-style view entirely — there
is no `box`/subject-line concept left in this file.

## Registered route
```js
App.register('messages', async (view, filter) => { ... })
```
`filter.userId` (optional) deep-links straight into a conversation with that user id on
load; otherwise the view opens on the conversation list with no thread selected.

## Structure / key functions
- **`loadConversations()`** — `GET /messages/conversations`, renders the left pane
  (`renderConvoList`). Re-called after most mutations so unread counts/last-message
  previews stay current.
- **`openConversation(otherId, knownName)`** — builds the thread pane (header, message
  list, reply strip, compose bar), fetches `GET /messages/with/:otherId?limit=50`
  (newest-first — reversed before render so the thread reads oldest-at-top), then bulk
  marks it read via `POST /messages/with/:otherId/read`.
- **`loadOlder()`** — cursor-paginates further history via `?before=<oldest loaded id>`,
  prepending and preserving scroll position.
- **`bubbleHTML(m)`** — renders one message: mine/theirs alignment, quoted reply preview
  (click scrolls to the original), attachments (reusing `.msg-attach*` styling), a link-
  preview card slot, an "Edited" label, and — for a soft-deleted message — just the
  "Message was removed" placeholder with nothing else (no body/attachments/reactions).
- **`hydrateBubbleExtras(m)`** — post-render: loads authenticated photo and video previews via
  `API.blobUrl`, keeps media hidden behind a shimmer until decoded, shows attachment
  errors, and revokes blob URLs when bubbles are removed, and for the first URL found in the message body, fetches
  `GET /messages/link-preview?url=` (cached client-side in `linkPreviewCache` too) and
  injects a card on success; silently no-ops on failure.
- **Hover actions** (`.chat-hover-actions`, shown on `:hover` per bubble) — React (opens a
  small fixed 6-emoji popover, `openEmojiPopover`), Reply (`startReply`), and, sender-only,
  Edit (`startEdit`) / Unsend (`unsend`, confirms via `UI.confirmDialog` then `DELETE
  /messages/:id`). Clicking an existing reaction chip also toggles that emoji.
- **`applyReactions` / `applyEdited` / `applyRemoved`** — patch a single bubble in place
  (used by both the local action's success handler and the matching `ChatWS` event), so
  the thread never needs a full re-fetch for these.
- **Composer** (`wireComposer`) — auto-growing textarea, Enter to send / Shift+Enter for a
  newline, attach button, reply/edit mode swaps the send button between Send/Save. Typing
  pings `ChatWS.send({type:'typing', to})` at most once per 2.5s while the input changes.
- **`newMessageModal()`** — recipient picker (`GET /users`) to start a conversation that
  doesn't exist yet; just opens/creates the thread, doesn't pre-fill any text.

## Real-time (`ChatWS`)
Subscribes to `message:new` / `message:edited` / `message:deleted` / `reaction:changed` /
`typing` for as long as this view is mounted. Since `App`'s router has no unmount hook (a
view is just overwritten via `view.innerHTML = ...` on navigation), the module-level
`_chatWsHandlers` map is swapped — `ChatWS.off(...)` the previous render's handlers before
`ChatWS.on(...)`-ing the new ones — every time this route function runs, so re-visiting
Messages (or navigating away) never stacks duplicate listeners. `onWsMessageNew` always
refreshes the conversation list; it only touches the open thread's DOM if the event
belongs to the currently-open conversation (`belongsToActiveThread`).

**Fallback when `ChatWS` isn't connected:** `sendOrSave()` normally relies on the sender's
own broadcast echo (the server broadcasts to *both* participants, including the sender) to
append the just-sent bubble; if `ChatWS.connected` is false at send time, it calls
`reloadCurrentThread()` instead so the message doesn't stay invisible until the thread is
reopened. Edit/unsend apply their local patch directly regardless of `ChatWS` state — they
never depend on the echo.

## API endpoints used
| Endpoint | Used by |
|---|---|
| `GET /messages/conversations` | `loadConversations()` |
| `GET /messages/with/:id?before&limit` | `openConversation()`, `loadOlder()`, `reloadCurrentThread()` |
| `POST /messages/with/:id/read` | opening a thread, and an incoming message from the open counterpart |
| `POST /messages` (+ files, `reply_to_id`) | `sendOrSave()` |
| `PATCH /messages/:id` | `sendOrSave()` in edit mode |
| `DELETE /messages/:id` | `unsend()` |
| `POST /messages/:id/react` | `react()` |
| `GET /messages/link-preview?url=` | `hydrateBubbleExtras()` |
| `GET /users` | `newMessageModal()` (recipient list) |

## Permissions honored
None client-side (no `App.hasPermission` checks in this file) — every action is gated
server-side by `messages.view`/`messages.send` as documented in
`src/core/messages.routes.ts`; a 403 surfaces as a toast via the thrown `API` error.

## Dependencies
`App.getMe()`, `App.refreshUnread()`; `API.get/post/patch/del/upload/blobUrl/download`;
`UI.icon/esc/initials/fmtDateShort/fmtBytes/fileIconName/emptyState/toast/modal/
confirmDialog`; `window.ChatWS` (`public/js/lib/chat-ws.js`, optional — every code path
tolerates it being absent/disconnected); `window.ImageCompress` (optional, for outbound
image attachments, same as the old compose flow).

## Notes / gotchas
- **Reply-quote click-to-scroll only works if the original message is already loaded** in
  the current page of the thread — it does not auto-paginate backward to find an older
  message. Low-impact in practice (most replies quote something recent) but a known gap.
- **No group chat** — this view, like the API it calls, is strictly 1:1.
- `activeOtherId`/`messages` are plain closure variables reset on every `openConversation`
  call, not a persisted client-side cache — switching conversations always re-fetches.

Photo and video attachments include a separate Download button. Videos use native
inline playback controls; unsupported formats offer a download fallback. Loading
animations respect reduced-motion preferences.

Full-screen `PhotoViewer` and `AttachmentViewer` also keep media hidden until load
completion and use a light-sweep loading tile. Download errors appear separately
without replacing an existing preview.
