# Tests (`tests/`)

## Purpose
The Vitest suite. Every backend route file and most pure-logic frontend modules have a
matching `*.test.ts`. Backend tests drive the real Express app in-process via `supertest`
against a throwaway SQLite DB; frontend-module tests sandbox-load the plain `<script>` files
(no bundler) via `tests/helpers.ts`-style `vm` loading or direct `require` where the file
also does `module.exports` for CommonJS.

Run with `npm test` (once) or `npm run test:watch`. `npm run check` runs `tsc --noEmit` +
the full suite — run this before every commit.

## `tests/helpers.ts`
Shared setup, not a test file itself.
- **`setupApp()`** — creates an isolated temp SQLite DB file and uploads directory (sets
  `DB_PATH`/`UPLOAD_DIR` env vars before importing `src/db`), runs `init()`, and returns a
  `{ app, cleanup }` pair where `app` is the Express app from `createApp()`.
- **`login(app, username, password)`** — logs in via `POST /api/auth/login`, returns the
  bearer token.
- **`createEmployee(app, token, overrides?)`** — convenience helper to create an HR employee
  row for tests that need one.
- **`cleanup()`** — removes the temp DB file and uploads dir after a test file finishes.

Every backend test file calls `setupApp()` in a `beforeAll`/`beforeEach` and `cleanup()` in
`afterAll`, so `npm test` is fully headless — no manual DB setup, no running server, and test
files never share state with each other.

## Backend route/behavior tests

| File | `describe` blocks | Covers |
|---|---|---|
| `auth.test.ts` | auth, rbac, profile, change password | Login, `/auth/me`, logout, `requirePermission`/`requireRole` guards, last-admin-can't-be-demoted guard, profile update, password change. |
| `departments.test.ts` | departments | Usage counts, create/rename/delete, duplicate-name rejection, FK-set-null cascade on delete, `users.manage` vs `hr.manage` RBAC split (hr.manage can create + conditionally delete but never rename). |
| `inventory.test.ts` | inventory, extended attributes, item form-config | CRUD, stock in/out + history, negative-stock guard, low-stock filter, search, stats, `attributes` JSON round-trip, `form-config` GET/PUT + admin-only guard. |
| `forms.test.ts` | forms | Upload/download round-trip, department visibility rules, delete permissions (`forms.delete` vs uploader). |
| `messages.test.ts` | messages | Send, inbox/sent, unread count, mark-read, self-message guard, delete (sender/recipient only). |
| `personal.test.ts` | notes, tasks, bookmarks | CRUD for all three, strict per-user isolation (no cross-user read/update/delete), auth + validation. |
| `orders.test.ts` | orders | Auto-numbering (`SO-`/`JO-`/`PR-`), server-computed totals (ignores client-sent totals), list by `type`, update-replaces-line-items, delete cascade, validation, auth. Covers `sale`/`job`/`purchase`. |
| `templates.test.ts` | templates, company profile, template variables | Default template seeds, admin-only (`templates.edit`) CRUD, company profile get/put + permission guard, global variable registry. |
| `form-builder.test.ts` | form definitions, form records, global variables, hr payroll csv import | Form definition CRUD (`forms.manage` guard), record create/update/delete + per-form auto-numbering, cascade delete, global variable upsert/delete, CSV import endpoint (400 for non-`hr_payroll` forms, 404 unknown form, 400 missing file, pay-date stamping, field extraction, `completed` status). |
| `hr.test.ts` | hr | HR Payroll form auto-seed, employee CRUD (`employee_no` auto-gen, default `probationary` status, statutory numbers, photo data-URI validation, dept/status filters), 201-file document upload/list/download/delete, delete-blocked-with-attendance-history (409), cutoff creation, roster add pre-populates blank day rows for the date range, bulk daily attendance save (replace-in-place), Generate Payslips (create-or-update semantics, 400 on empty roster), `hr.view`/`hr.manage` RBAC. |
| `hr-migration.test.ts` | employees migration | Regression test for the `employees` table rebuild migration: seeds a raw pre-upgrade DB (old `active` flag + a live `attendance_records` FK), imports `src/db` fresh, asserts `init()` doesn't throw, `employee_no`/`status` are correctly backfilled, the FK survives, and `employee_seq` is advanced past backfilled numbers. |
| `ai.test.ts` | `POST /api/ai/chat`, executeTool unit tests | Chat endpoint auth/validation/503-when-unconfigured, and direct unit tests of individual `executeTool()` cases (permission enforcement, DB effects) without going through the Cerebras call. |

## Pure-logic / frontend-module tests

| File | `describe` blocks | Covers |
|---|---|---|
| `unit.test.ts` | validation: login/createUser/inventory/messages, password hashing | zod schema edge cases + bcrypt hash/compare, no HTTP involved. |
| `frontend-nav.test.ts` | nav-config: ROUTE_NAMES, nav-config: structure | Sandbox-loads `nav-config.js`; asserts every tree leaf points to a registered route, admin-only flags are correct, ids are unique. |
| `frontend.test.ts` | frontend bootstrap | Sanity checks on the frontend bootstrap/script-load assumptions (see file for current scope — lighter-weight smoke test). |
| `item-form-config.test.ts` | item-form-config catalog | Sandbox-loads `item-form-config.js`; unique field keys, valid tab references, `ITEM_CORE_KEYS` match real `inventory_items` columns, choice-type fields have an `options` list. |
| `doc-template.test.ts` | renderTemplate | `{{var}}` / `{{#items}}` loop / `{{#if}}` (incl. nested) rendering, HTML-escaping, missing-variable handling, `ORDER_VARIABLES` palette catalog sanity. |
| `doc-context.test.ts` | buildDocContext | Tests for `doc-context.js`'s context-building helper (assembles the `{company, order/employee, items, ...}` render context fed to `doc-template.js`). |
| `doc-formula.test.ts` | doc-formula | Tests for `doc-formula.js`'s formula-builder/evaluator logic used by the document editor's formula fields. |
| `doc-editor.test.ts` | doc-editor transforms, sanitizeHtml, page setup + find/replace helpers | `bodyToEditorHtml`/`serializeEditor` round-trips (plain vars, formulas, control tokens, repeatable item rows, checkboxes, `{{var}}` inside `<img src>` → placeholder image via `data-var-src`), paste-hardening sanitizer, find/replace helper, `parsePageStyle`/`pageStyleTag`/`pageDims` mm-based size+margin round-trips incl. legacy `size: a4|letter portrait|landscape` format. |
| `hr-payroll-print.test.ts` | buildSlipContext, buildPayrollSlipsHtml | Per-slip context assembly, NET PAY math (`total_earnings - total_deductions`), 2-copies-per-employee / 2-per-page grouping with blank-slot padding for odd counts, string/number coercion, empty-list handling. |
| `hr-payroll-import.test.ts` | parseCsvRows, parsePayrollSummaryCsv | CSV tokenizer edge cases; department tagging from section-header rows, mid-cutoff rate-change row-splitting/merging, computed (not sheet-trusted) earnings/deductions totals, footer-row rejection, empty input. Rows are built positionally via a `row()`/`COL` helper rather than hand-typed comma strings, so column-offset drift can't silently pass. |

## Notes / gotchas
- Backend tests never touch the real `data.db` — each file gets its own temp DB via
  `setupApp()`/env var overrides in `src/db.ts` (`DB_PATH`/`UPLOAD_DIR`).
- When adding a new route or a new pure-logic module, add its test file here and follow the
  existing pattern (`setupApp()` for HTTP, sandbox `vm`/`require` load for browser-global
  frontend modules) rather than inventing a new harness.
- See [`docs/ARCHITECTURE.md §7`](../ARCHITECTURE.md) for the run/typecheck/test commands.
