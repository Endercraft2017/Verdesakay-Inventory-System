# `public/js/views/forms.js`

## Purpose
The "Forms & Files" module: a searchable/filterable file table with department-scoped
visibility, upload, authenticated download, in-app print for PDFs/images, and delete.
Renders the `forms` nav leaf (`All Files`).

## Registered route(s)
```js
App.register('forms', async (view) => { ... })
```
Single route, no `filter` support (callback ignores a second argument).

## Structure / key functions
- **`load()`** — fetches `GET /forms` into `all`, refreshes the category `<select>`, then
  `applyFilters()`.
- **`refreshCategoryOptions()`** — rebuilds `#forms-cat` options from the distinct,
  sorted `category` values present in `all`, preserving the current selection.
- **`applyFilters()`** — client-side filter of `all` by `filters.q` (matches title +
  category + original filename, case-insensitive substring) and `filters.category`
  (exact match), then `render()`s the result. Filtering is entirely client-side after one
  full fetch — there's no server round-trip per keystroke.
- **`render(list)`** — table rows: file-type icon (via `UI.fileIconName`), title,
  description, category, a visibility pill (`department_name` badge or "All staff"),
  size (`UI.fmtBytes`), uploader/date. Row actions: Print (only if `isPrintable`),
  Download, Delete (only if permitted — see below). Whole row is clickable to trigger
  download (unless the click landed in `.actions`). Empty state distinguishes "no files
  yet" (with an Upload CTA) from "no matching files" (filtered-empty, no CTA).
- **`isPrintable(f)`** — true if the file extension is in `PRINTABLE_EXT` (`pdf, png, jpg,
  jpeg, gif, webp, bmp, svg`) or `mime_type` matches `/pdf|image\//`.
- **`printFile(f)`** *(unified 2026-08-25 — see Notes)* — authenticated `fetch` of the download
  endpoint (manual `Authorization: Bearer` header, not `API.get`, because it needs the raw blob
  rather than parsed JSON), builds an object URL, then opens the same preview-modal + iframe used
  elsewhere (`orders.js`, `form-records.js`'s `printSlips()`, `hr-employees.js`'s ID-card
  preview): PDFs set `iframe.src = url` (renders in the browser's native PDF viewer, in-place);
  images set `iframe.srcdoc = UI.printableHtml('<img src="...">', title)`. Either way, the modal's
  "Print…" button calls `iframe.contentWindow.print()`. The object URL is revoked after 60s via
  `setTimeout`.
- **`download(id)`** — same authenticated blob fetch, but builds a synthetic `<a
  download>` from the `Content-Disposition` filename and clicks it to save, then revokes
  the object URL immediately.
- **`uploadModal()`** — file input (25MB note is UI-only, not enforced client-side; the
  25MB cap is server-side via multer) + title/category/visibility(department)/description
  fields; visibility select defaults to "All staff (shared)" with per-department options
  from `App.getDepartments()`. On confirm, builds a `FormData` and `API.upload('/forms',
  fd)`.
- **`del(id, list)`** — confirm dialog then `DELETE /forms/:id`.
- Toolbar wiring: search input (filters immediately, no debounce — filtering is
  client-side so this is cheap), category select, upload button.

## API endpoints used
| Endpoint | Used by |
|---|---|
| `GET /forms` | `load()` |
| `GET /forms/:id/download` | `printFile()`, `download()` (raw `fetch`, not `API.get`, to get a Blob) |
| `POST /forms` (multipart) | `uploadModal()` via `API.upload` |
| `DELETE /forms/:id` | `del()` |

## Permissions honored
- `forms.delete` — a Delete button is shown if the caller has this permission **or**
  `f.uploaded_by_name === me.full_name` (own upload) — matches the server rule described
  in `docs/ARCHITECTURE.md` §4 ("uploader or `forms.delete` permission"). Note the
  ownership check compares by display name rather than uploader id (no `uploaded_by_id` /
  `me.id` comparison available in the row shape used here).
- No other `App.hasPermission` gating in this file — upload and general viewing are not
  further restricted client-side (server-side department-visibility filtering already
  scopes what `GET /forms` returns per user).

## Dependencies
`App.getDepartments()`; `API.get/upload/del`, plus raw `fetch` + `API.getToken()` for blob
downloads; `UI.icon`, `UI.esc`, `UI.fmtBytes`, `UI.fmtDate`, `UI.emptyState`, `UI.toast`,
`UI.modal`, `UI.confirmDialog`, `UI.fileIconName`, `UI.printDocument`.

## Notes / gotchas
- **Downloads/prints bypass `API.get`** because `API`'s helpers assume JSON responses;
  file bytes need the raw `fetch` + manual bearer header + `.blob()` dance seen in both
  `printFile` and `download`.
- **(Fixed 2026-08-25)** PDF printing used to be the one place in the codebase still using
  `window.open()` — popup-blocker-riskable, unlike every other print flow (`orders.js`,
  `form-records.js`'s `printSlips()`, `hr-employees.js`'s ID-card preview). Now unified onto the
  same iframe-in-modal pattern by pointing the iframe's `src` (not `srcdoc`) at the blob URL, so
  the browser's native PDF viewer renders it in-place — not visually verified in a real browser
  in this environment (no headless-browser tooling available here), but this is the same
  technique used broadly to embed PDFs via iframe and matches the established pattern exactly;
  worth a manual smoke test.
- **Filtering is entirely client-side** after one `GET /forms` — search/category changes
  never re-hit the server. This keeps the list snappy but means very large file lists are
  filtered in-browser.
