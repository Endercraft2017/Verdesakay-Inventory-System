# `src/core/messages.routes.ts`

## Purpose
Internal 1:1 chat: conversations, threaded messages with reply/edit/soft-delete/reactions,
file attachments, link-preview cards, unread count. Mounted at `/api/messages`. All
queries are scoped to the caller (`req.user!.id`) as sender or recipient. Real-time push
(`src/shared/ws.ts`'s `broadcast()`) fires after every mutation so open chat UIs update
live; every route still works fully over plain REST if a client has no WebSocket.

## Routes / Exports

`router.use(requireAuth)` (line ~14) — every route requires a valid session.

| Method & path | Auth | Notes |
|---|---|---|
| `GET /?box=inbox\|sent` | `messages.view` | **Legacy** email-style listing (subject/body, one row per message, no reply/reactions). Kept for `src/modules/ai/ai-tools.ts` and any other direct consumer; the chat UI uses `/conversations` + `/with/:userId` instead. |
| `GET /unread-count` | `messages.view` | `{count}` — unread received messages. |
| `GET /quota` | `messages.view` | `{used_bytes, cap_bytes}` — the caller's 5 GB attachment storage pool (shared across all messages they've sent; freed as messages are unsent). |
| `GET /conversations` | `messages.view` | One row per distinct counterpart: `{other_id, other_name, other_username, last_message, last_message_at, last_message_mine, unread_count}`. `last_message` reads `"Message was removed"` if the last message was soft-deleted. Sole data source for the chat UI's left-pane conversation list. |
| `GET /with/:userId?before=<id>&limit=<n>` | `messages.view` | The full thread with one counterpart, newest-first, `limit` capped to 200 (default 50), `before` for cursor pagination (older page). Each row: the raw message fields + `attachments`, `reactions: [{emoji,count,mine}]` (aggregated relative to the caller), `reply_to: {id,author,preview}\|null`, `mine: boolean`. |
| `POST /with/:userId/read` | `messages.view` | Bulk-marks every unread message *from* `userId` read in one statement — used when opening a thread. `{ok, updated}`. |
| `POST /` | `messages.send` | Send, optionally with up to 10 files (`multipart` field `files`, 10 MB each) and/or `reply_to_id` (must reference an existing, non-deleted message between the same two users). Broadcasts `message:new` to both parties, and still fires the existing `notifyUser` web-push. `201 {id, attachments}`. |
| `PATCH /:id` | `messages.send` | Sender-only edit — `{body}`. 403 if not the sender, 400 if the message was already removed. Sets `edited_at`. Broadcasts `message:edited`. `{ok, edited_at}`. |
| `DELETE /:id` | `messages.send` | Sender-only **soft delete** ("unsend"), not a hard delete: clears `body`/`subject`, sets `deleted_at`/`deleted_by`, deletes the message's attachments (DB rows + files on disk) and reactions. Idempotent (deleting an already-removed message is a no-op `200`, not a 404). 403 if the caller isn't the sender — the old "either party can delete their copy" behavior is gone; there's one shared row, so only the author can erase it for both sides. Broadcasts `message:deleted {id}`. |
| `POST /:id/react` | `messages.view` | `{emoji}` — sender or recipient of that message. One reaction per user per message (`message_reactions` `UNIQUE(message_id,user_id)`): re-sending the same emoji toggles it off, a different emoji replaces it. Broadcasts `reaction:changed {message_id, reactions}` (raw `[{emoji,user_id}]`, viewer-agnostic). `{ok, reactions}`. |
| `GET /:id/attachments/:attId` | `messages.view` | Streams a message's attached file; 403 if the caller isn't a participant. |
| `POST /:id/read` | `messages.view` | Single-message mark-read (kept alongside the bulk `/with/:userId/read`; used directly by the AI tools). Never 404s — see Notes. |
| `GET /link-preview?url=<url>` | `messages.view` | Fetch-and-cache Open Graph metadata for a chat link-preview card. See **Link previews** below. |

### Schema (from `src/shared/validation.ts`)
- `sendMessageSchema = z.object({ recipient_id, subject?, body, reply_to_id?: positive int })`
- `editMessageSchema = z.object({ body })`
- `reactSchema = z.object({ emoji: 1-8 chars })`

### Data model (`src/shared/db.ts`, SCHEMA_VERSION 44)
- `messages` gained `reply_to_id` (`ON DELETE SET NULL`), `edited_at`, `deleted_at`, `deleted_by`.
- `message_reactions(id, message_id, user_id, emoji, created_at)`, `UNIQUE(message_id, user_id)`.
- `link_previews(url PK, title, description, image_url, site_name, fetched_at, failed)` — cache only, not user data.

## Link previews
`fetchLinkPreview()` fetches the URL itself (manual redirects, ≤3 hops) and hand-parses
`<meta property="og:*">` / `<title>` tags with small regexes — no HTML-parsing dependency,
consistent with this codebase's preference for dependency-free parsing (see
`public/js/lib/barcode.js`). SSRF-guarded: only `http:`/`https:`, the hostname (and every
redirect hop's hostname) is resolved and rejected if it's loopback/private/link-local
(`isPrivateHost`/`isPrivateIp`), 5s timeout, 2 MB body cap, `content-type: text/html`
required. Results (including failures, via `failed=1`) are cached in `link_previews` for
`LINK_PREVIEW_TTL_MS` (7 days) so the same link isn't refetched on every render.

## Real-time (`src/shared/ws.ts`)
`broadcast(tenantSlug, userIds, event)` pushes a JSON `{type, data}` frame to every open
WebSocket for those users in that tenant. The client (`public/js/lib/chat-ws.js`) connects
to `/ws?token=<bearer token>` and auto-reconnects with backoff; every UI here degrades to
its REST-only behavior (a manual re-fetch, see `messages.js`'s `reloadCurrentThread`) if
the socket never connects at all.

## Dependencies
- `express`, `multer` — as before.
- `node:dns/promises`, `node:net` — link-preview SSRF host checks.
- `../shared/db` — `queryOne`, `queryAll`, `run`, `uploadDir`, `tenantStore`, `DEFAULT_TENANT`.
- `../shared/auth` — `requireAuth`, `requirePermission`.
- `../shared/validation` — `parseBody`, `sendMessageSchema`, `editMessageSchema`, `reactSchema`.
- `../shared/push` — `notifyUser` (unchanged; still fires on every send regardless of WS).
- `../shared/ws` — `broadcast`.

## Used by
- `src/app.ts` — mounted as `app.use('/api/messages', messagesRoutes)`.
- `tests/messages.test.ts` — full coverage of the above, including one real WebSocket
  round-trip test (connects with the `ws` client package against a throwaway
  `http.createServer`, not `supertest`, since a plain HTTP mock can't upgrade a connection).
- `public/js/modules/core/messages.js` — the desktop chat UI.
- `public/mobile/modules/core/inbox.js` — the mobile chat UI (adds swipe-to-reply and a
  long-press action sheet in place of desktop's hover actions).
- `public/js/app.js` / `public/mobile/app.js` — open/close the shared `ChatWS` connection
  on login/logout and patch the unread badge from `message:new`/`message:deleted` events.
- `src/modules/ai/ai-tools.ts` — `get_messages`/`send_message`/`get_unread_count`/
  `mark_message_read` still implement equivalent logic directly against the same tables
  (not by calling this HTTP route); `get_messages` filters `deleted_at IS NULL` so a
  sender-unsent message doesn't read to the AI as blank content.

## Notes / gotchas
- `POST /:id/read` deliberately uses a single scoped `UPDATE ... WHERE id = ? AND
  recipient_id = ? AND read_at IS NULL` rather than a fetch-then-check pattern — it never
  404s; callers should check the `updated` count if they need to distinguish
  "already read"/"not yours"/"doesn't exist" from an actual state change.
- Recipient validation on send requires `active = 1` — messaging a deactivated account's
  user ID fails with 404 even though the account still exists.
- No group chat — everything here is strictly pairwise (`sender_id`/`recipient_id`), by
  design; a group model would be a materially larger schema change (participants table).
- `broadcast()` payloads for `message:new` include aggregation-free `reactions` (always
  `[]` at creation) via `hydrateMessageForBroadcast`; `reaction:changed` sends the raw
  per-user rows rather than the REST endpoints' viewer-relative `{emoji,count,mine}` shape,
  since one broadcast fans out to two viewers with different "mine" — clients aggregate
  locally using their own user id.
