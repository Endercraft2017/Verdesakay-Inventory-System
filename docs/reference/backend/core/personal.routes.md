# `src/core/personal.routes.ts`

## Purpose
Per-user CRUD for the right-rail personal productivity tools: Notes, Tasks (Scheduler), and
Bookmarks. Every query is explicitly scoped to `req.user!.id`, so no user can read, update, or
delete another user's data — there is no admin override. Mounted at `/api` (so effective paths are
`/api/notes`, `/api/tasks`, `/api/bookmarks`).

## Routes / Exports

`router.use(requireAuth)` (line 10) — every route requires a valid session.

### Notes

| Method & path | Auth | Schema | DB operations | Success response | Error cases |
|---|---|---|---|---|---|
| `GET /notes` | 🔑 any user | — | `SELECT * FROM notes WHERE user_id = ? ORDER BY updated_at DESC` | `200 [Note, ...]` | — |
| `POST /notes` | 🔑 any user | `noteSchema` | `INSERT INTO notes (user_id, title, body)` | `201 {id}` | 400 via zod |
| `PUT /notes/:id` | 🔑 any user | `noteSchema` | `UPDATE notes SET title, body, updated_at WHERE id = ? AND user_id = ?` (ownership enforced in the WHERE clause) | `200 {ok: true}` | `404 {error:'Note not found'}` (covers both nonexistent and not-owned) |
| `DELETE /notes/:id` | 🔑 any user | — | `DELETE FROM notes WHERE id = ? AND user_id = ?` | `200 {ok: true}` | `404 {error:'Note not found'}` |

### Tasks (Scheduler)

| Method & path | Auth | Schema | DB operations | Success response | Error cases |
|---|---|---|---|---|---|
| `GET /tasks` | 🔑 any user | — | `SELECT * FROM tasks WHERE user_id = ? ORDER BY done ASC, (due_date IS NULL) ASC, due_date ASC, created_at ASC` (pending-and-dated tasks first) | `200 [Task, ...]` | — |
| `POST /tasks` | 🔑 any user | `taskSchema` | `INSERT INTO tasks (user_id, title, due_date, done)` | `201 {id}` | 400 via zod |
| `PUT /tasks/:id` | 🔑 any user | `updateTaskSchema` | Fetch-then-check (`SELECT * FROM tasks WHERE id = ? AND user_id = ?`) then `UPDATE tasks SET title, due_date, done WHERE id = ? AND user_id = ?`, merging supplied fields over the existing row | `200 {ok: true}` | `404 {error:'Task not found'}` |
| `DELETE /tasks/:id` | 🔑 any user | — | `DELETE FROM tasks WHERE id = ? AND user_id = ?` | `200 {ok: true}` | `404 {error:'Task not found'}` |

### Bookmarks

| Method & path | Auth | Schema | DB operations | Success response | Error cases |
|---|---|---|---|---|---|
| `GET /bookmarks` | 🔑 any user | — | `SELECT * FROM bookmarks WHERE user_id = ? ORDER BY created_at DESC`; `params` column (JSON text) parsed per-row via local `safeParse` | `200 [{...Bookmark, params: object|null}, ...]` | — |
| `POST /bookmarks` | 🔑 any user | `bookmarkSchema` | `INSERT INTO bookmarks (user_id, label, route, params)` (`params` JSON-stringified if present) | `201 {id}` | 400 via zod |
| `DELETE /bookmarks/:id` | 🔑 any user | — | `DELETE FROM bookmarks WHERE id = ? AND user_id = ?` | `200 {ok: true}` | `404 {error:'Bookmark not found'}` |

### Schemas (from `src/shared/validation.ts`)
- `noteSchema` — `{title: optional text ≤200 (nullable), body: 1-20000 chars}`.
- `taskSchema` — `{title: 1-300 chars, due_date: optional text ≤40 (nullable), done: boolish optional}`.
- `updateTaskSchema` — same shape, all fields optional (`title` optional too, unlike `taskSchema`).
- `bookmarkSchema` — `{label: 1-200, route: 1-80, params: optional record<string,string|number|boolean|null> (nullable)}`.

### Local helper
- `safeParse(s: string): unknown` — `JSON.parse` wrapped in try/catch, returning `null` on failure;
  used only for the `bookmarks.params` column when listing.

## Dependencies
- `express` — `Router`.
- `../db` — `queryOne`, `queryAll`, `run`.
- `../auth` — `requireAuth`.
- `../validation` — `parseBody`, `noteSchema`, `taskSchema`, `updateTaskSchema`, `bookmarkSchema`.
- `../types` — `Note`, `Task`, `Bookmark`.

## Used by
- `src/app.ts` — mounted as `app.use('/api', personalRoutes)` — comment in `app.ts` notes this
  covers `/api/notes`, `/api/tasks`, `/api/bookmarks`.
- `tests/personal.test.ts` — notes/tasks/bookmarks CRUD, per-user isolation (no cross-user
  read/update/delete), auth + validation.
- `public/js/tools.js` — right-rail Notes / Scheduler (tasks) / Bookmarks tools, and
  right-click-to-bookmark on nav items.
- `src/modules/ai/ai-tools.ts` — the AI Assistant's `get_notes`/`create_note`/`update_note`/`delete_note` and
  `get_tasks`/`create_task`/`update_task`/`delete_task` tools implement equivalent per-caller-scoped
  logic directly against the same tables (bookmarks have no AI tool equivalent).

## Notes / gotchas
- Ownership is enforced two different ways across the three resources: Notes and Bookmarks
  updates/deletes fold the ownership check directly into the SQL `WHERE` clause (no separate
  fetch); Tasks' `PUT /tasks/:id` does an explicit `SELECT ... WHERE id = ? AND user_id = ?` first,
  then merges fields before the `UPDATE` — functionally equivalent 404 behavior, different style.
- `taskSchema` requires `title`; `updateTaskSchema` makes `title` optional (falls back to the
  existing task's title if omitted) — the two schemas are intentionally different, not aliases.
- Every "not found" response in this file is a 404 that conflates two distinct causes (row doesn't
  exist vs. row belongs to another user) — by design, to avoid confirming/denying the existence of
  another user's resource ID.
- `bookmarks.params` is stored as JSON text and only parsed back to an object in the `GET /bookmarks`
  list handler (not in POST's response, which just returns `{id}`).
