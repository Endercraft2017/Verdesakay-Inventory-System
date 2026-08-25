# `src/db.ts`

## Purpose
The database module: opens the SQLite connection (Node's built-in `node:sqlite`), owns the entire schema definition, runs idempotent migrations for existing databases, seeds first-run data (admin account, departments, default document templates, the HR Payroll form), and exports the typed query helpers (`queryOne`/`queryAll`/`run`) and settings key-value store (`getSetting`/`setSetting`) that every route module uses instead of touching `db.prepare(...)` directly. This is the single largest and most central file in the backend.

## Exports / Public API

### Connection & path constants
```ts
export const DB_PATH: string     // process.env.DB_PATH || <root>/data.db
export const UPLOAD_DIR: string  // process.env.UPLOAD_DIR || <root>/uploads
export const db: DatabaseSync    // the open node:sqlite connection
```
- `DB_PATH`/`UPLOAD_DIR` are env-overridable specifically so `tests/helpers.ts` can point each test run at an isolated throwaway file/directory instead of the real `data.db`/`uploads/`.
- On module load, `db.exec('PRAGMA journal_mode = WAL;')` (write-ahead logging, better concurrent read/write behavior) and `db.exec('PRAGMA foreign_keys = ON;')` (FK constraints enforced — cascades/restricts/set-nulls declared in the schema actually fire) run immediately, before `init()` is even called.
- `Param` type: `string | number | bigint | null | Uint8Array` — the subset of values `node:sqlite` accepts as bound parameters; used to cast the loosely-typed `unknown[]` args of the query helpers.

### Query helpers
```ts
export function queryOne<T>(sql: string, ...params: unknown[]): T | undefined
export function queryAll<T>(sql: string, ...params: unknown[]): T[]
export function run(sql: string, ...params: unknown[]): ReturnType<DatabaseSync['prepare']['run']>
```
Thin, typed wrappers around `db.prepare(sql).get/.all/.run(...params)`. `queryOne`/`queryAll` cast the raw result to caller-supplied type `T`/`T[]` (no runtime validation — the type parameter is a developer-asserted shape, not verified). `run` is used for INSERT/UPDATE/DELETE and returns node:sqlite's result object (has `.changes`, `.lastInsertRowid`). **Every route module is expected to go through these three functions rather than calling `db.prepare()` inline** (per `docs/ARCHITECTURE.md` §5 conventions) — it centralizes the `unknown[] -> Param[]` cast in one place.

### `init()`
```ts
export function init(): void
```
The one-time (called-once-per-process, safe-to-call-repeatedly) schema bootstrap. Runs a single large `db.exec(...)` containing `CREATE TABLE IF NOT EXISTS` for every table plus `CREATE INDEX IF NOT EXISTS` for every index (see §3 below for the full table list), then calls `migrate()`, `ensureUploadDir()`, and `seed()` in that order. Because every `CREATE` uses `IF NOT EXISTS`, re-running `init()` against an already-initialized DB is a no-op for schema creation — the real upgrade logic for *existing* databases lives in `migrate()`.

Tables created (see `docs/ARCHITECTURE.md` §3 for full column-level docs — kept in sync there): `departments`, `users`, `sessions`, `inventory_items`, `settings`, `notes`, `tasks`, `bookmarks`, `orders`, `order_items`, `doc_templates`, `inventory_transactions`, `forms`, `messages`, `form_definitions`, `form_records`, `global_variables`, `doc_variables`, `employees`, `employee_documents`, `attendance_periods`, `attendance_records`. Indexes cover FK columns used in hot lookups (`idx_form_records_def`, `idx_messages_recipient`/`_sender`, `idx_txn_item`, `idx_items_dept`, `idx_sessions_user`, `idx_notes_user`, `idx_tasks_user`, `idx_bookmarks_user`, `idx_orders_type`, `idx_order_items_order`, `idx_employees_dept`, `idx_attendance_period`/`_employee`, `idx_employee_documents_employee`) plus one composite unique index `idx_doc_variables_key` on `doc_variables(scope, IFNULL(template_id, 0), key)` (enforces a key is unique per scope+template, treating "no template" as `0` since SQLite unique indexes otherwise treat every `NULL` as distinct).

### `migrate()` (not exported — internal, but documented here per task instructions since it's structurally important)
```ts
function migrate(): void
```
Idempotent upgrade path for databases created by an older version of this schema. Each block independently inspects `PRAGMA table_info(<table>)` or `sqlite_master.sql` to detect whether the upgrade is still needed, so re-running `migrate()` (which happens on every `init()`, i.e. every process start) is always safe. What it handles, in order:
1. **`inventory_items.attributes`** — adds the column via `ALTER TABLE` if missing (older DBs predate the ECOUNT-style extended-attributes JSON column).
2. **`users` rebuild** — if `permission_overrides` is missing, rebuilds the whole table (SQLite can't add a column with the intended semantics via simple `ALTER` here because the goal also includes dropping the old two-role `CHECK` constraint): creates `users_new` with the current schema, copies rows across (remapping the legacy `'employee'` role value to `'admin_staff'` since `employee` is no longer a valid role), drops `users`, renames `users_new` → `users`. Wrapped in `BEGIN; ... COMMIT;`.
3. **`orders` rebuild** — if the `type` column's `CHECK` (read from `sqlite_master.sql`) doesn't mention `'purchase'`, rebuilds `orders` the same way to widen the `CHECK (type IN (...))` constraint, re-creates `idx_orders_type` afterward.
4. **`doc_templates` rebuild** — same pattern, widens `type` CHECK to include `'purchase'`. Note the rebuild's `INSERT INTO doc_templates_new (id,name,type,body,created_by,created_at,updated_at) SELECT ...` — it does **not** carry over a `period` column here (that column didn't exist yet at this migration step); the next migration step adds it separately.
5. **`doc_templates.period`** — adds the column via plain `ALTER TABLE` if still missing (handles DBs that already got step 4's rebuild before `period` existed).
6. **`form_records.period`** — adds the column via plain `ALTER TABLE` if missing (used for payroll-period grouping/filtering).
7. **`employees` rebuild** (the largest/most delicate step) — if the table exists (`empCols.length` check — skips entirely on a brand-new DB where `init()`'s own `CREATE TABLE` already has the new shape) and lacks a `status` column, rebuilds it to replace the old boolean `active` flag with the `status` enum plus the newer 201-file fields (`employee_no`, `start_date`, `sss_no`, `philhealth_no`, `pagibig_no`, `tin_no`, `photo`). Because `attendance_records.employee_id` has a live FK reference into `employees`, and SQLite enforces FK constraints across a `DROP TABLE` even mid-transaction, this step explicitly runs `PRAGMA foreign_keys = OFF;` **before** the `BEGIN...COMMIT` block and turns it back `ON` **after** — `PRAGMA` statements can't be toggled inside a transaction, which is why this bracketing sits outside the `db.exec` that contains the `BEGIN`/`COMMIT`. Backfill logic: `employee_no` is synthesized as `'EMP-' || printf('%05d', id)` and `status` becomes `'regular'` if the old `active = 1` else `'terminated'`. After the rebuild, it advances the `employee_seq` setting (see `nextEmployeeNumber`-style counters below) to `MAX(id)` if that's higher than the counter's current value — **required** so the next employee created post-migration doesn't collide with one of the backfilled `EMP-#####` numbers. (Regression-tested directly in `tests/hr-migration.test.ts`, which seeds a raw pre-upgrade DB and asserts `init()` survives it.)

### Settings store
```ts
export function getSetting<T>(key: string): T | undefined
export function setSetting(key: string, value: unknown): void
```
Generic JSON key-value store backed by the `settings` table (`key` TEXT PRIMARY KEY, `value` TEXT). `getSetting` reads the row and `JSON.parse`s the `value` column, returning `undefined` if the key doesn't exist **or** if the stored value fails to parse (parse errors are swallowed, not thrown). `setSetting` does an `INSERT ... ON CONFLICT(key) DO UPDATE` upsert, `JSON.stringify`-ing whatever is passed and bumping `updated_at`. Used for: the saved item-form layout (`item_form_config`), and every auto-numbering sequence counter (`order_seq_sale`/`order_seq_job`/`order_seq_purchase`, `form_seq_<form_def_id>`, `employee_seq` — these live in route files like `inventory.routes.ts`/`orders.routes.ts`/`form-builder.routes.ts`/`hr.routes.ts`, not in `db.ts` itself, but they all read/write through these two functions).

### Session/token helpers
```ts
export function cleanupSessions(): void
export function newToken(): string
```
- `cleanupSessions()` — `DELETE FROM sessions WHERE expires_at < datetime('now')`. Called on an hourly `setInterval` from `server.ts` and directly by `auth.ts`-adjacent test/route code where relevant.
- `newToken()` — `crypto.randomBytes(32).toString('hex')`, a 256-bit random session token. Used by `createSession()` in `src/auth.ts` (the only caller).

## Internal / non-exported helpers
- `ensureUploadDir()` — `fs.mkdirSync(UPLOAD_DIR, { recursive: true })` if it doesn't already exist. Called once from `init()`.
- `seed()` — first-run data seeding, called at the end of `init()`. Seeds `departments` (`Administration`, `Operations`, `Finance`, `Human Resources`, `IT`) only if the table is currently empty; seeds the default `admin` user (username `admin`, password from `ADMIN_PASSWORD` env var or `'admin123'`, bcrypt-hashed with cost 10, role `admin`, department = Administration if found) only if `users` is empty — prints the generated credentials to the console **unless** `process.env.DB_PATH` is set (i.e. suppressed during tests, which always set `DB_PATH` to a temp path). Then unconditionally calls `seedTemplates()` and `seedHrPayrollForm()` (both are independently idempotent, so they run — and no-op — on every subsequent `init()` too).
- `seedHrPayrollForm()` — inserts the `HR Payroll` form definition (slug `hr_payroll`, prefix `PAY`, icon `sheet`, 22 fields covering identity/period/rate/OT/earnings/deductions) into `form_definitions`, but only if no row with `slug = 'hr_payroll'` already exists. This guard means an admin who deletes or renames the seeded form via Form Builder will **not** get it silently recreated (checked by exact slug, not "does any HR-payroll-shaped form exist") — but a fresh DB, or one where it was never created, always gets it, which is what lets Time Keeping's "Generate Payslips" assume the form exists.
- `seedTemplates()` — seeds four default `doc_templates` rows, each independently existence-checked (so adding a new default template to this function later doesn't require a fresh DB to pick it up on old installs): `Sale Order`/`Job Order`/`Purchase Request` (type `sale`/`job`/`purchase`, only inserted as a trio if *none* of the three types exist yet — i.e. it won't back-fill just the missing one), `HR Payroll Slip` (checked by exact `name`), `Employee ID Card` (checked by exact `name`).
- `employeeIdTemplateBody()` — returns the literal HTML/CSS string for the seeded "Employee ID Card" template: a CR-80 card-sized (85.6mm × 54mm) layout with a dark header band (`{{company.name}}`), a photo + name/position/department body, and a footer band (`{{employee.employee_no}}` + issue date). Rendered against a `{company, employee, today}` context built client-side by `generateId()` in `public/js/views/hr-employees.js`.
- `payrollSlipTemplateBody()` — returns the literal HTML/CSS for the seeded "HR Payroll Slip" template: self-contained `<style>` block (not built from the shared order-document CSS), two-column EARNINGS/DEDUCTIONS layout, NET PAY line, signature lines. Rendered against a **flat** context (`{{employee_name}}`, `{{basic_salary}}`, ... — no nesting) matching the `hr_payroll` form's field keys directly, consumed by `public/js/hr-payroll-print.js`.
- `orderTemplateBody(title: string)` — returns the literal HTML for the seeded Sale/Job/Purchase order templates, parameterized only by the document's title heading (`'SALES ORDER'`/`'JOB ORDER'`/`'PURCHASE REQUEST'`); uses `{{company.*}}`, `{{order.*}}`, and a `{{#items}}...{{/items}}` loop with `{{#if ...}}` conditionals, rendered by the shared `public/js/doc-template.js` engine.

## Dependencies
- `node:path`, `node:fs`, `node:crypto` — path resolution, upload-dir creation, random token generation.
- `node:sqlite` (`DatabaseSync`) — the database driver itself (Node's built-in SQLite binding; no external DB driver package).
- `bcryptjs` — hashing the seeded admin password.

`db.ts` imports nothing from elsewhere in `src/` — it is the foundation every other backend module sits on.

## Used by
Every route module imports from `db.ts`: `src/routes/users.routes.ts`, `src/routes/hr.routes.ts`, `src/routes/templates.routes.ts`, `src/routes/personal.routes.ts`, `src/routes/messages.routes.ts`, `src/routes/orders.routes.ts`, `src/routes/forms.routes.ts`, `src/routes/inventory.routes.ts`, `src/routes/auth.routes.ts`, `src/routes/form-builder.routes.ts`, plus `src/ai-tools.ts`. `src/auth.ts` imports `db` (for direct session/user lookups) and `newToken`. `server.ts` imports `init` and `cleanupSessions` directly. `tests/helpers.ts` sets `DB_PATH`/`UPLOAD_DIR` env vars before importing `src/db` (so every test file gets its own throwaway database) and calls `init()`.

## Notes / gotchas
- **`migrate()` runs on every process start**, not just "once ever" — each block's guard condition (missing column, CHECK-constraint text, table row count) is what makes it safe to call repeatedly; a new migration must follow the same self-guarding pattern rather than assuming it runs only once.
- **Foreign keys are ON globally** (`PRAGMA foreign_keys = ON` at module load). Any table rebuild during a migration that involves `DROP TABLE` on a table with incoming FK references from other tables (as `employees` does from `attendance_records`) must bracket the rebuild with `PRAGMA foreign_keys = OFF/ON` *outside* the transaction, exactly as the `employees` migration does — `PRAGMA` can't be toggled mid-transaction in SQLite.
- **`queryOne`/`queryAll` perform no runtime shape validation** — the generic type parameter `T` is trusted, not checked. A schema drift between a `SELECT` and its declared `T` in `src/types.ts` will not surface as an error; it'll surface as `undefined`/garbage at the field the caller reads.
- Table rebuild migrations (`users`, `orders`, `doc_templates`, `employees`) all follow the same recipe: `CREATE ..._new`, `INSERT INTO ..._new SELECT ... FROM <old>`, `DROP TABLE <old>`, `ALTER TABLE ..._new RENAME TO <old>`, re-create any indexes that were dropped along with the old table. Any future column/constraint change serious enough to need a rebuild (rather than a plain `ALTER TABLE ADD COLUMN`) should follow this same pattern for consistency.
- The `settings` table doubles as a counter store for auto-numbering (`order_seq_*`, `form_seq_<id>`, `employee_seq`) — those counter keys are read/written from the *route* files, not from `db.ts`; if you're hunting for where `EMP-#####`/`SO-#####`/etc. numbers are generated, look in the relevant `*.routes.ts`, not here.
- `seedHrPayrollForm()`'s existence check is by exact `slug`, and `seedTemplates()`'s per-template checks are by exact `name` — renaming a seeded template/form in the UI does **not** make it get "re-seeded" under the old name on next restart (each seed function only checks for its own specific expected identifier), but it also means the guard won't catch a same-named-but-different-shape row an admin created independently.
