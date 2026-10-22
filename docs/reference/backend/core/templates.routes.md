# `src/core/templates.routes.ts`

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
| `GET /:id` | 🔑 any user | — | Fetches one full template row including `body` and a content-derived `revision`. | `200` `DocTemplate` | `404` if not found |
| `POST /` | `requirePermission('templates.edit')` | `templateSchema` | Inserts `name, type, period, body, created_by`. | `201 { id, revision }` | 400 on invalid body; 404 for missing copy source; 409/428 for stale/missing source revision |
| `PUT /:id` | `requirePermission('templates.edit')` | `templateSchema` | Updates document content and print configuration only if `expected_revision` matches the current row. | `200 { ok: true, revision }` | 404 if not found; 428 if revision is missing; 409 if stale |
| `DELETE /:id` | `requirePermission('templates.edit')` | — | Deletes the template row. | `200 { ok: true }` | `404` if not found |

`templateSchema` (`src/shared/validation.ts`): `name` (1-120 chars), `type` enum `sale\|job\|purchase\|generic` (default `generic`), `period` (optional, ≤60 chars), `body` (1 to 5,000,000 chars — templates are full HTML+CSS documents). `companyProfileSchema` fields are optional/defaulted text plus `compress_images` (`boolish`, default `true`); `docVariableSchema` fields are all optional/defaulted text except `key` which must match `/^[a-zA-Z_][\w]{0,63}$/`.

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
- `docs/ARCHITECTURE.md`'s §4 API catalog only lists the `company`, base CRUD, and `templates.company`/`templates.edit` rows for this file — it does **not** document the `/variables*` and `/variables/catalog` endpoints or the `doc_variables` table, which exist in the current code (confirmed via `src/shared/db.ts`'s `CREATE TABLE IF NOT EXISTS doc_variables` and the unique index `idx_doc_variables_key`). Treat this file as the more current source for that surface.
- `POST /variables`'s uniqueness is per **scope + template_id**, not globally per key — the same `key` string can exist once in `scope='global'` and again in a specific template's `scope='template'` rows without conflicting (index is on `(scope, IFNULL(template_id, 0), key)`).
- `GET /variables` defaults `template_id` to `0` when not supplied, which will never match any real `template_id` (autoincrement PKs start at 1) — so an unscoped call to `GET /variables` effectively returns only `scope='global'` rows, not an error.
- `PUT /variables/:id` deliberately excludes `key`/`scope` from the update — the schema still requires them in the request body (via `docVariableSchema`) but the SQL only touches the other columns, meaning a client that "renames" the key by resubmitting won't actually change it. Callers should not read `key` back as reflecting a change if the UI only exposed `PUT`.
- `GET /` never selects `body` (only summary columns), so any caller needing to render/print a template must follow up with `GET /:id`.


## Save and copy contract

`GET /:id` returns a SHA-256 revision of the persisted content, metadata, print settings,
and timestamp. Send it as `expected_revision` on `PUT /:id`. The form-template body
endpoint requires the same revision when updating an existing linked template. A SQLite
savepoint keeps validation and writes in one snapshot; no schema migration is required.
The revised document is returned only after the write commits. A conflict leaves the
client's editor open without overwriting the server's content.

To save a copy, `POST /` accepts `source_template_id` and `source_revision` in addition
to the new template's complete content/configuration. Template-scoped variables are copied
in the same transaction; global variables retain their shared scope. Opening a copy does
not create a database row, and closing without saving has no database effect.

Style-only/empty formatted bodies are rejected. The frontend checks page margins and the
12-cell print-grid limit before saving. Company-profile controls use `templates.company`,
independently of document editing permission.

## Document studio

The authenticated `/templates/studio` router stores private drafts, saved version history,
shared working sessions, presence, comments, and company library items in tenant SQLite
tables initialized by schema version 48. Template triggers capture old/new saved snapshots
and retain the latest 100. Template/form deletion removes associated working data.

Document keys are canonical `template:id`, `form:id`, or private `new-template:key`.
Linked forms resolve to their template; first form publication migrates working data.
Drafts are user-scoped. Form scope permissions and template edit permissions are checked
for every document operation; company library writes require `templates.company`.

Draft/library writes use expected versions. Shared room writes merge independent stable
HTML blocks and metadata through `doc-studio-merge.ts`, returning 409 for conflicting
blocks or structural edits. Template publication additionally checks `studio_version`
through `doc-template-version.ts` and updates the working-room baseline atomically.
Explicit room reset restores the current published template using an expected version.
Presence expires after 30 seconds. Comment deletion is author-only.

Endpoints under `/documents/:key`: history and individual snapshots, draft GET/PUT/DELETE,
room GET/PUT and reset POST, presence POST/DELETE, and comments GET/POST/PUT/DELETE.
`/library` exposes company styles/assets/brand settings with optimistic mutation guards.

## Form layout assignments (schema 49)

`form_template_links` associates multiple layouts with each form definition. The existing
`form_definitions.template_id` remains the explicit default, so automated email/file actions
continue to use the selected default. Migration preserves existing assignments, assigns the
seeded payslip by ID, and creates starter layouts for unlinked forms once. New forms receive
an escaped starter layout transactionally. Renaming a linked payslip does not change its
assignment or recreate the original named payslip on restart.

Scope-authorized `/form-definitions/:id/templates` GET lists layouts/default/shared counts;
POST links an existing layout (`template_id`, optional `make_default`). DELETE with a layout
ID unlinks without deleting the underlying template; removing the default selects a remaining
layout. Deleting a template similarly selects a remaining layout only for affected forms.
`PUT /form-definitions/:id/template` selects the default and ensures it is linked.

`PUT /form-definitions/:id/template-body` accepts an explicit linked `template_id` to edit
an alternative. `template_id: null` creates another linked layout without changing an
existing default; omitting the field retains legacy default-edit semantics. Duplication
uses `source_template_id`/`source_revision` and copies template-scoped variables. Saved and
shared revision checks remain required when editing. Studio authorization includes linked
alternatives; private new-layout drafts use scope-checked `new-template:form-ID-UUID` keys.
Payslip email resolves the form's assigned default by ID, never by template name.

## Built-in document assignments (schema 50)

`document_defaults` stores explicit template IDs for sales orders, job orders, purchase
requests, employee ID cards, asset issuance, and BIR 2316. The Template Library's
**Built-in defaults** dialog manages these assignments. Authenticated GET
`/templates/defaults` lists roles; GET `/templates/defaults/:key` returns the assigned
full template; PUT requires `templates.edit` and a template of the role's expected type.
Renaming or copying a template does not change an assignment. Deleting an assigned
built-in template is rejected until a replacement is selected. Missing assignments
return an actionable error instead of silently choosing another template. Payslips
continue to use the HR Payroll form's default in Form Builder.

Startup links newly seeded forms while preserving deliberately unlinked existing forms.
Each missing built-in order template is seeded independently. Original unconfigured
payslip layouts receive an explicit 2-by-2 repeat grid once to preserve their output;
subsequent printing honors the selected template's saved grid and page settings.

Form archive notices and payroll email render with the shared escaped template renderer,
including loops, conditional blocks, company context, and template variables. Browser
payslip printing also retains custom record fields and record metadata. Time inputs are
supported by form validation and the builder; overtime and holiday presets use the
`work_date` field consumed by payroll, with legacy record fallback retained.


## Document conversion

POST `/templates/studio/documents/:key/export-docx` accepts an unsaved HTML body, name
and page dimensions/margin; returns DOCX base64, filename and conversion notes. POST
`/templates/studio/documents/:key/import-docx` accepts one multipart `file` (8 MB max),
returns sanitized HTML and notes. Both use the document resolver's edit permissions
before processing. Conversion is read-only: publication remains an explicit editor save.

`document-conversion.ts` uses htmlparser2/docx for export and Mammoth for semantic import.
JSZip validates required document structure, entry count and expanded-size limits.
External file access is disabled. Import keeps supported safe embedded raster images
and links/bookmarks, while the UI preserves access to the selected original. Exports
report freeform/CSS/image limitations instead of silently promising a lossless layout.


Multipage template bodies (multiple `data-doc-design-page` elements or forced page boundaries)
reject rows/columns above 1 or Continuous mode in published-template and draft/shared schemas.
Shared-room merge results are validated too. Existing room/history/draft snapshots normalize
incompatible grid values when opened, preserving content; generic and payslip print helpers
bypass grids for older incompatible bodies. No schema migration is needed: structured page,
style, section, note and revision metadata lives in the existing HTML body.

DOCX export now creates actual Word paragraph styles, section dimensions/columns, headers,
footers/page fields, contents fields, footnotes and inserted/deleted runs. Browser linked notes
appear at the document end; Word positions footnotes. Contents fields update in Word. Visual
page backgrounds/freeform geometry remain conversion limitations and are reported.
