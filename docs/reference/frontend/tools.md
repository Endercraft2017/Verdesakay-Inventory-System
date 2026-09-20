# `public/js/tools.js`

## Purpose
Wires the right-rail "personal tools" panel: a **real** AI assistant backed by
`POST /api/ai/chat` (see `docs/AI-AGENT.md` and `docs/reference/backend/ai-tools.md`), a
still-non-functional Email preview, and Notes / Scheduler (tasks) / Bookmarks (all persisted
per-user via `/api/notes|tasks|bookmarks`). Also wires right-click-to-bookmark on nav items.

## Exports / Public API
None. This is a self-invoking IIFE with no global export — it only wires DOM listeners as
a side effect of `document.addEventListener('DOMContentLoaded', init)` at the bottom of the
file. There is no `module.exports`; not unit-tested.

### Internal functions (not exported, but the effective "API" of this file's behavior)
- **`init()`** — for every `.rail-btn[data-tool]` element (the right icon rail buttons),
  inserts its icon (via `TOOL_ICONS` map: `ai→sparkles, notes→note, email→mail,
  scheduler→calendar, bookmarks→bookmark`) and wires a click to `openTool(tool)`. Also
  calls `wireBookmarkContextMenu()`.
- **`openTool(tool)`** — dispatches to `openAI`/`openNotes`/`openEmail`/`openScheduler`/
  `openBookmarks` based on `tool` (`'ai'|'notes'|'email'|'scheduler'|'bookmarks'`).
- **`openAI()`** *(rewired 2026-08-26 — see Notes)* — opens a `UI.drawer({ key: 'ai', ... })`
  chat backed by the real agentic endpoint. Maintains `aiHistory` (module-level array, reset
  each time the drawer opens), a flat `{role, content}[]` sent in full on every turn since the
  server is stateless. On submit: pushes the user turn, shows a bouncing-dots typing indicator
  (`.ai-typing`), calls `API.post('/ai/chat', { messages: aiHistory })`, then renders any
  `res.steps` as small pill "chips" (`toolLabel()` turns `search_inventory` into `search
  inventory`) above the reply, and the reply itself through `mdLite()` (escapes first, then
  `**bold**`/`` `code` ``/newlines). A thrown error (401 handled globally by `api.js`; 503 when
  `CEREBRAS_API_KEY` isn't set; 400/500 otherwise) renders as a red-tinted `.ai-error` message
  and pops the just-pushed user turn back off `aiHistory` so a failed turn isn't replayed to
  the model next time. Input/send button are disabled for the duration of the request.
- **`openEmail()`** — opens a `UI.drawer({ key: 'email', ... })` with disabled To/Subject/
  Message fields and a disabled Send button — a static, non-functional preview.
- **`openNotes()`** — opens a `UI.drawer({ key: 'notes', ... })`, loads `/notes` on open,
  renders a list with click-to-edit (`noteModal`) and per-row delete (with
  `UI.confirmDialog`). "New note" footer button opens `noteModal(null, refresh)`.
- **`noteModal(note, after)`** — a `UI.modal` with Title/Note fields; requires non-empty
  body; `POST /notes` (new) or `PUT /notes/:id` (edit); calls `after()` (the list's
  `refresh`) on success.
- **`openScheduler()`** — opens a `UI.drawer({ key: 'scheduler', ... })` for personal tasks:
  an inline add-form (title + due date) at the top of the drawer body, and a list below
  with checkbox-to-toggle-done (`PUT /tasks/:id`) and delete. Marks a task's due-date row
  `overdue` if `due_date < today` and not done.
- **`openBookmarks()`** — opens a `UI.drawer({ key: 'bookmarks', ... })`, loads `/bookmarks`,
  renders a list where clicking a row navigates there (`App.navigate(b.route, b.params)`)
  and closes the drawer; footer button "Bookmark current page" calls `addBookmark` with
  `App.currentLocation()`.
- **`addBookmark(label, route, params)`** — `POST /bookmarks` with `{label, route, params}`;
  toasts success/error. Shared by the drawer's footer button and the context-menu handler.
- **`wireBookmarkContextMenu()`** — a single delegated `contextmenu` listener on
  `document`: if the right-clicked element is `.tree-leaf` or `.primary-item`, prevents the
  default browser menu and shows a `UI.contextMenu` with two options — "Bookmark '<item
  label>'" (bookmarks that specific nav destination, reading its `route`/`filter` straight
  off the element's `data-route`/`data-filter` attributes, or resolving a primary's first
  leaf if a `.primary-item` was clicked) and "Bookmark current page" (bookmarks wherever the
  user actually is right now, via `App.currentLocation()`).

## Internal structure
Single top-level IIFE; module-level state is `TOOL_ICONS` (the icon-key map) and `aiHistory`
(the chat's conversation array, live only while the AI drawer is open). Every other drawer's
list is refreshed by re-fetching and re-rendering on every mutation — no client cache.

## Dependencies
`UI` (drawer/modal/confirmDialog/toast/icon/emptyState/esc/money), `API` (`/ai/chat` plus
notes/tasks/bookmarks CRUD), `App` (`App.navigate`, `App.currentLocation`), and the global
`NAV` array (read directly in `wireBookmarkContextMenu` to resolve a `.primary-item`'s first
leaf — falls back gracefully via `typeof NAV !== 'undefined'` check). Loaded **last** in
`index.html` (after `app.js` and all `views/*.js`), since it only wires listeners at
`DOMContentLoaded` and doesn't need to be ready before other modules load.

## Used by
Nothing calls into `tools.js` — it's pure top-level wiring with no exports for other
modules to consume. It is the *last* script tag in `index.html`.

## Notes / gotchas
- **(Fixed 2026-08-26)** The AI assistant used to be a hard-coded echo stub — despite a fully
  built, tested backend already existing (`src/modules/ai/ai.routes.ts`, `src/modules/ai/ai-tools.ts`, 18
  passing tests in `tests/ai.test.ts`) and `docs/AI-AGENT.md` documenting this exact frontend
  contract (`aiHistory`, typing indicator, tool chips, light markdown) as if it were already
  wired up. It wasn't — the file's own header comment claimed "no backend yet," which had
  become false. `openAI()` now actually calls `POST /api/ai/chat`; verified against a live
  isolated server that the real error path (503 when `CEREBRAS_API_KEY` is unset) renders
  correctly. Not verified in an actual browser (no headless-browser tooling in this
  environment) — worth a manual smoke test with a real `CEREBRAS_API_KEY` set.
- Email is still an **intentionally non-functional preview** — don't mistake the disabled
  form for a real integration; there's no corresponding backend route.
- `UI.drawer()` enforces a single-open-drawer policy keyed by `opts.key` — clicking the
  same rail icon twice toggles the drawer closed rather than reopening it (see `ui.js`).
  All five tool drawers pass a distinct `key` so switching between them doesn't accidentally
  toggle instead of switch.
- The bookmark context menu is wired via one delegated listener on `document`, not
  per-element listeners — this means it works correctly even as the nav tree is
  re-rendered by `app.js` on every `navigate()` call (no re-wiring needed).
