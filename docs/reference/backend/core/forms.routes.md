# `src/core/forms.routes.ts`

## Purpose
Company document/file management: list (department-visibility-scoped), multipart upload to disk,
authenticated download, and delete (uploader-or-permission-gated). Mounted at `/api/forms`. Distinct
from the custom "Form Builder" records feature in `form-builder.routes.ts` and from HR's
`employee_documents` in `hr.routes.ts` — this is the general company file-share table (`forms`).

## Routes / Exports

`router.use(requireAuth)` (line 12) — every route requires a valid session.

| Method & path | Auth | Schema | DB operations | Success response | Error cases |
|---|---|---|---|---|---|
| `GET /` | 🔑 any user | — | `visibilityClause(user)` restricts to `f.department_id IS NULL OR f.department_id = ?` unless caller has `users.manage` (sees all); joins `departments`, `users` (uploader) | `200 [{id, title, description, category, original_name, mime_type, size_bytes, department_id, created_at, department_name, uploaded_by_name}, ...]`, newest first | — |
| `POST /` | 🔑 any user | multipart `file` field (no zod schema — multer + manual field reads) | `multer.diskStorage` writes to `UPLOAD_DIR` with a randomized filename (`Date.now()-<16 hex chars><ext>`, ext capped to 12 chars); reads `title`/`description`/`category`/`department_id` from `req.body`; `INSERT INTO forms (...)` | `201 {id}` | `400 {error:'A file is required'}` if `req.file` missing; multer errors (oversize etc.) caught by the trailing error-handling middleware → `400 {error:'Upload failed: <message>'}` |
| `GET /:id/download` | 🔑 any user | — | `SELECT * FROM forms WHERE id = ?`; visibility check (same rule as list, `users.manage` bypasses); `fs.existsSync` check on disk | Streams the file via `res.download(filePath, form.original_name)` | `404 {error:'Form not found'}`; `403 {error:'You do not have access to this file'}`; `410 {error:'File is missing on disk'}` |
| `DELETE /:id` | 🔑 any user (uploader) or 🔐 `forms.delete` | — | `SELECT * FROM forms WHERE id = ?`; permission check; `DELETE FROM forms WHERE id = ?`; best-effort `fs.promises.unlink` of the stored file (errors swallowed) | `200 {ok: true}` | `404 {error:'Form not found'}`; `403 {error:'Only the uploader or someone with delete permission can delete this file'}` |

Upload limits: `multer({storage, limits: {fileSize: 25 * 1024 * 1024}})` — 25 MB cap.

### Local helpers
- `storage` — `multer.diskStorage` config: destination `UPLOAD_DIR` (from `../db`), filename
  `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}` where `ext` is the original
  extension truncated to 12 chars.
- `visibilityClause(user: AuthUser): {sql, params}` — returns an empty clause (all rows) for
  `users.manage` holders, otherwise `' WHERE (f.department_id IS NULL OR f.department_id = ?)'`
  with `[user.department_id]`.

### Router-level error middleware (line 120)
A trailing `router.use((err, req, res, next) => ...)` specifically catches `multer.MulterError`
(e.g. file-too-large) and converts it to `400 {error: 'Upload failed: <message>'}`; anything else
is passed to `next(err)` (the app-wide central handler).

## Dependencies
- `node:path`, `node:fs`, `node:crypto` — path joining, existence/unlink checks, random filename component.
- `express` — `Router`, plus `Request`/`Response`/`NextFunction` types for the error middleware.
- `multer` — disk-storage file upload handling.
- `../db` — `queryOne`, `queryAll`, `run`, `UPLOAD_DIR`.
- `../auth` — `requireAuth`.
- `../types` — `AuthUser`, `FormRow`.

## Used by
- `src/app.ts` — mounted as `app.use('/api/forms', formsRoutes)`.
- `tests/forms.test.ts` — upload/download round-trip, department visibility, delete permissions.
- `public/js/views/forms.js` — Forms table view: upload modal, authenticated blob download,
  delete, Print (PDF/images in-app; Office docs = download).

## Notes / gotchas
- There is no zod schema for the upload body — `title`/`description`/`category`/`department_id`
  are read and trimmed/coerced manually from `req.body` (which arrives as strings via multipart
  form fields). `title` falls back to `req.file.originalname` if not supplied.
- `department_id: null` (the default when the field is omitted) means "visible to everyone" —
  this is the semantic used consistently by `visibilityClause` and by `hr.routes.ts`'s comment
  referencing this same pattern for `employee_documents`.
- Deleting a form removes the DB row first, then attempts to unlink the file — an unlink failure
  is silently swallowed (`.catch(() => {})`), so a delete can "succeed" at the API level while
  leaving an orphaned file on disk.
- Download authorization mirrors list visibility, but is re-checked independently per-request
  (not derived from the list endpoint) — a user can't download a file whose ID they guessed
  outside their department's visibility.
