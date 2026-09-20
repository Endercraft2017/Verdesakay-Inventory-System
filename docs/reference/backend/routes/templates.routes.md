# `src/routes/templates.routes.ts`

## Purpose
Implements `/api/templates`: CRUD for printable document templates (`doc_templates`), the single company profile used for `{{company.*}}` template variables, and a template-variable registry (`doc_variables`) that backs the editor's variable palette — plus a read-only catalog of the data sources those variables can bind to. Reading templates/variables/company is open to any logged-in user; writes require specific permissions.

## Routes / Exports

All routes are mounted at `/api/templates` (`src/app.ts`) and require `requireAuth`.

### Company profile
| Method & path | Auth | Schema | What it does | Response | Errors |
|---|---|---|---|---|---|
| `GET /company` | 🔑 any user | — | Reads the `company_profile` key from `settings` via `getSetting`, spread over `EMPTY_COMPANY` defaults (`name/address/phone/email/logo_url` all `''`, `compress_images` `true`) so missing keys never come back `undefined`. | `200` `CompanyProfile` | — |
| `PUT /company` | `requirePermission('templates.company')` | `companyProfileSchema` | Builds a full `CompanyProfile` object (text fields `?? ''`, `compress_images` from `boolish.default(true)`) and writes it as one JSON blob via `setSetting(COMPANY_KEY, profile)`. | `200 { ok: true }` | 400 on invalid body; 403 if missing `templates.company` |

`compress_images` is a **client-side** storage saver, not enforced server-side: when on (the default), the web and mobile Messages composers pipe every picked image over ~1 MB through `public/js/lib/image-compress.js` (canvas downscale to 1920 px + JPEG re-encode) before upload. Non-images and already-small images are sent untouched.

### Template variables (`doc_variables`)
| Method & path | Auth | Schema | What it does | Response | Errors |
|---|---|---|---|---|---|
| `GET /variables/catalog` | 🔑 any user | — | Returns the static `DATA_SOURCE_CATALOG` (imported from `../doc-catalog`) — the list of bindable data-source fields shown when authoring a `field`-sourced variable. | `200` catalog array | — |
| `GET /variables?template_id=` | 🔑 any user | — | Returns variables visible to a given template: rows where `scope = 'global'` OR (`scope = 'template'` AND `template_id` matches the query param, defaulting to `0` if omitted), ordered by `category, sort, label`. | `200` `DocVariable[]` | — |
| `POST /variables` | `requirePermission('templates.edit')` | `docVariableSchema` | Inserts a row into `doc_variables` (`scope`, `template_id` forced `null` unless `scope==='template'`, `category`, `key`, `label`, `source_type`, `value`, `field_path`, `formula`, `data_type`, `sort`). | `201 { id }` | `409` if the INSERT throws (unique index `idx_doc_variables_key` on `(scope, IFNULL(template_id,0), key)` — duplicate key in the same scope); 400 on invalid body |
| `PUT /variables/:id` | `requirePermission('templates.edit')` | `docVariableSchema` | Updates all fields except `key` and `scope` (those are treated as fixed identity once created) plus `updated_at`. | `200 { ok: true }` | `404` if id not found |
| `DELETE /variables/:id` | `requirePermission('templates.edit')` | — | Deletes the variable row. | `200 { ok: true }` | `404` if id not found |

### Templates (`doc_templates`)
| Method & path | Auth | Schema | What it does | Response | Errors |
|---|---|---|---|---|---|
| `GET /?type=&period=` | 🔑 any user | — | Lists templates (`id,name,type,period,created_at,updated_at` only — no `body`). `type` filters to one of `sale\|job\|purchase\|generic` if given; `period` filters to an exact match if given. Ordered `period DESC, type, name`. | `200` `DocTemplate[]` (partial, no body) | — |
| `GET /:id` | 🔑 any user | — | Fetches one full template row including `body`. | `200` `DocTemplate` | `404` if not found |
| `POST /` | `requirePermission('templates.edit')` | `templateSchema` | Inserts `name, type, period, body, created_by`. | `201 { id }` | 400 on invalid body |
| `PUT /:id` | `requirePermission('templates.edit')` | `templateSchema` | Updates `name, type, period, body, updated_at`. | `200 { ok: true }` | `404` if not found |
| `DELETE /:id` | `requirePermission('templates.edit')` | — | Deletes the template row. | `200 { ok: true }` | `404` if not found |

`templateSchema` (`src/validation.ts`): `name` (1-120 chars), `type` enum `sale\|job\|purchase\|generic` (default `generic`), `period` (optional, ≤60 chars), `body` (1 to 5,000,000 chars — templates are full HTML+CSS documents). `companyProfileSchema` fields are optional/defaulted text plus `compress_images` (`boolish`, default `true`); `docVariableSchema` fields are all optional/defaulted text except `key` which must match `/^[a-zA-Z_][\w]{0,63}$/`.

## Dependencies
- `express` — `Router`.
- `../db` — `queryOne`, `queryAll`, `run`, `getSetting`, `setSetting`.
- `../auth` — `requireAuth`, `requirePermission`.
- `../validation` — `parseBody`, `templateSchema`, `companyProfileSchema`, `docVariableSchema`.
- `../types` — `DocTemplate`, `CompanyProfile`, `DocVariable` (type-only).
- `../doc-catalog` — `DATA_SOURCE_CATALOG`, the static list of data-source fields exposed by `GET /variables/catalog`.

## Used by
- Mounted in `src/app.ts`: `app.use('/api/templates', templatesRoutes)`.
- Frontend: `public/js/views/templates.js` — the Document Templates admin view (list, editor with variable palette + live preview, company profile editor, and the variable CRUD UI at `/templates/variables*`).
- Frontend (read-only): `public/js/views/orders.js` (renders order templates for printing) and `public/js/views/hr-employees.js` (renders the "Employee ID Card" template) both fetch template bodies via `GET /templates/:id`, but neither writes to this router.
- Tests: `tests/templates.test.ts` — default seeds, admin-only (`templates.edit`) CRUD, company profile get/put with a 403 check for a non-privileged role.

## Notes / gotchas
- `docs/ARCHITECTURE.md`'s §4 API catalog only lists the `company`, base CRUD, and `templates.company`/`templates.edit` rows for this file — it does **not** document the `/variables*` and `/variables/catalog` endpoints or the `doc_variables` table, which exist in the current code (confirmed via `src/db.ts`'s `CREATE TABLE IF NOT EXISTS doc_variables` and the unique index `idx_doc_variables_key`). Treat this file as the more current source for that surface.
- `POST /variables`'s uniqueness is per **scope + template_id**, not globally per key — the same `key` string can exist once in `scope='global'` and again in a specific template's `scope='template'` rows without conflicting (index is on `(scope, IFNULL(template_id, 0), key)`).
- `GET /variables` defaults `template_id` to `0` when not supplied, which will never match any real `template_id` (autoincrement PKs start at 1) — so an unscoped call to `GET /variables` effectively returns only `scope='global'` rows, not an error.
- `PUT /variables/:id` deliberately excludes `key`/`scope` from the update — the schema still requires them in the request body (via `docVariableSchema`) but the SQL only touches the other columns, meaning a client that "renames" the key by resubmitting won't actually change it. Callers should not read `key` back as reflecting a change if the UI only exposed `PUT`.
- `GET /` never selects `body` (only summary columns), so any caller needing to render/print a template must follow up with `GET /:id`.
