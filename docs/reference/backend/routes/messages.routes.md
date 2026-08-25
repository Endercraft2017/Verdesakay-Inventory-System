# `src/routes/messages.routes.ts`

## Purpose
Internal user-to-user messaging: inbox/sent listing, unread count, send, mark-read, delete. Mounted
at `/api/messages`. All queries are scoped to the caller (`req.user!.id`) as sender or recipient.

## Routes / Exports

`router.use(requireAuth)` (line 8) — every route requires a valid session.

| Method & path | Auth | Schema | DB operations | Success response | Error cases |
|---|---|---|---|---|---|
| `GET /?box=inbox\|sent` | 🔑 any user | — | `box` defaults to `'inbox'` unless exactly `'sent'`. Inbox: joins `users` on `sender_id` (aliased `other_id`/`other_name`/`other_username`), `WHERE recipient_id = ?`. Sent: joins on `recipient_id` similarly, `WHERE sender_id = ?`. Both ordered `m.id DESC` | `200 [{id, subject, body, read_at?, created_at, other_id, other_name, other_username}, ...]` | — |
| `GET /unread-count` | 🔑 any user | — | `SELECT COUNT(*) FROM messages WHERE recipient_id = ? AND read_at IS NULL` | `200 {count}` | — |
| `POST /` | 🔑 any user | `sendMessageSchema` | Rejects self-send; `SELECT id FROM users WHERE id = ? AND active = 1` (recipient must exist and be active); `INSERT INTO messages (sender_id, recipient_id, subject, body)` | `201 {id}` | `400 {error:'You cannot message yourself'}`; `404 {error:'Recipient not found'}` |
| `POST /:id/read` | 🔑 any user | — | `UPDATE messages SET read_at = datetime('now') WHERE id = ? AND recipient_id = ? AND read_at IS NULL` (single scoped statement — no separate existence/ownership check) | `200 {ok: true, updated: info.changes}` (`updated` is `0` if the message didn't exist, wasn't addressed to the caller, or was already read) | — (no error status; "no-op" is reported via `updated: 0`, not a 404) |
| `DELETE /:id` | 🔑 any user (sender or recipient) | — | `DELETE FROM messages WHERE id = ? AND (sender_id = ? OR recipient_id = ?)` | `200 {ok: true}` | `404 {error:'Message not found'}` (`info.changes === 0` — covers both nonexistent and not-owned-by-caller) |

### Schema (from `src/validation.ts`)
- `sendMessageSchema = z.object({ recipient_id: z.coerce.number().int().positive(), subject: trimmed.max(200).optional().nullable(), body: trimmed.min(1).max(5000) })`

## Dependencies
- `express` — `Router`.
- `../db` — `queryOne`, `queryAll`, `run`.
- `../auth` — `requireAuth`.
- `../validation` — `parseBody`, `sendMessageSchema`.

(No `../types` import in this file — response shapes are inline/untyped SQL row objects.)

## Used by
- `src/app.ts` — mounted as `app.use('/api/messages', messagesRoutes)`.
- `tests/messages.test.ts` — send, inbox/sent, unread count, mark-read, self-message guard, delete.
- `public/js/views/messages.js` — Inbox/sent tabs, open/read thread, compose/reply modal, delete.
- `public/js/app.js` — unread-badge polling in the chrome (calls `GET /messages/unread-count`).
- `src/ai-tools.ts` — the AI Assistant's `get_messages`/`send_message`/`get_unread_count`/`mark_message_read`
  tools implement equivalent logic directly against the same tables (not by calling this HTTP route).

## Notes / gotchas
- `POST /:id/read` deliberately uses a single scoped `UPDATE ... WHERE id = ? AND recipient_id = ? AND read_at IS NULL`
  rather than a fetch-then-check pattern — it never 404s; callers should check the `updated` count
  if they need to distinguish "already read"/"not yours"/"doesn't exist" from an actual state change.
- `DELETE /:id` allows either the sender or the recipient to delete their own copy — there's a
  single shared `messages` row (no separate inbox/sent copies), so either party deleting it removes
  it for both.
- Recipient validation on send requires `active = 1` — messaging a deactivated account's user ID
  fails with 404 even though the account still exists.
