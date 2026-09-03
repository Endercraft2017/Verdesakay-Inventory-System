/**
 * Database connection, schema creation, and first-run seeding.
 * Uses Node's built-in SQLite (node:sqlite). The DB file path can be overridden with
 * the DB_PATH env var so tests run against a throwaway database.
 *
 * Multi-tenancy (see docs/SAAS-READINESS.md): one SQLite file per tenant. A request
 * runs inside `tenantStore` (AsyncLocalStorage) carrying that tenant's connection;
 * `activeDb()` resolves it, and the exported `db` is a thin proxy onto `activeDb()`
 * so the many existing `db.prepare(...)` / `db.exec(...)` call sites stay unchanged.
 * With a single tenant (the default), everything behaves exactly as before.
 */
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import { SSS_2026, PHILHEALTH_2026, PAGIBIG_2026, RWT_2026 } from './ph-statutory';
import { DEFAULT_COA } from './ledger';

const ROOT = path.join(import.meta.dirname, '..');

export const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'data.db');
export const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(ROOT, 'uploads');
/** Where non-default tenant DB files live (`<DATA_DIR>/<slug>.db`). */
export const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
/** The tenant used when nothing else is resolved — the single-tenant install. */
export const DEFAULT_TENANT = 'default';

export interface TenantContext {
  db: DatabaseSync;
  slug: string;
}

/** Set for the duration of a request by the tenant-resolution middleware. */
export const tenantStore = new AsyncLocalStorage<TenantContext>();

/** Open connections, keyed by tenant slug. Opened + migrated on first use. */
const registry = new Map<string, DatabaseSync>();

function connectionPath(slug: string): string {
  return slug === DEFAULT_TENANT ? DB_PATH : path.join(DATA_DIR, `${slug}.db`);
}

function openConnection(slug: string): DatabaseSync {
  if (slug !== DEFAULT_TENANT && !fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  const conn = new DatabaseSync(connectionPath(slug));
  conn.exec('PRAGMA journal_mode = WAL;');
  conn.exec('PRAGMA foreign_keys = ON;');
  return conn;
}

/** Bumped whenever `migrate()` gains a step. A DB already at this version skips the
    (cheap but not free) PRAGMA-probe pass on every cold open. `createSchema()` and
    `seed()` are always safe to re-run (`… IF NOT EXISTS`, count-guarded). */
export const SCHEMA_VERSION = 21; // 20: employees.late_exempt; 21: attendance_records.min_hours_decision

/** The connection for `slug`, opening + creating/migrating its schema on first use. */
export function getDb(slug: string = DEFAULT_TENANT): DatabaseSync {
  const existing = registry.get(slug);
  if (existing) return existing;
  const conn = openConnection(slug);
  registry.set(slug, conn);
  // Run schema setup with this connection active so the db.exec / getSetting calls
  // inside createSchema/migrate/seed resolve to it via activeDb().
  tenantStore.run({ db: conn, slug }, () => {
    createSchema();
    if ((getSetting<number>('schema_version') ?? 0) < SCHEMA_VERSION) {
      migrate();
      setSetting('schema_version', SCHEMA_VERSION);
    }
    ensureUploadDir();
    seed();
  });
  return conn;
}

/** Force `createSchema()` + `migrate()` on an open tenant, ignoring `schema_version`.
    Used by the deploy-time `migrate:all` runner. */
export function forceMigrate(slug: string): void {
  withTenant(slug, () => {
    createSchema();
    migrate();
    setSetting('schema_version', SCHEMA_VERSION);
  });
}

/** The active tenant's connection — the request's, or the default outside a request. */
export function activeDb(): DatabaseSync {
  return tenantStore.getStore()?.db ?? getDb(DEFAULT_TENANT);
}

/** Run `fn` with `slug` as the active tenant. For background jobs / provisioning that
    aren't inside a request (`cleanupSessions`, RAG reindex, mail retry, …). */
export function withTenant<T>(slug: string, fn: () => T): T {
  return tenantStore.run({ db: getDb(slug), slug }, fn);
}

/** Proxy onto `activeDb()` so `import { db }` call sites don't each need to resolve
    the tenant. Only `.prepare()` / `.exec()` are ever used on it. */
export const db: DatabaseSync = new Proxy({} as DatabaseSync, {
  get(_target, prop) {
    const real = activeDb() as unknown as Record<string | symbol, unknown>;
    const value = real[prop];
    return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(real) : value;
  },
});

/** A value that can be bound to a SQL parameter. */
export type Param = string | number | bigint | null | Uint8Array;

/** Run a query and return the first row typed as T (or undefined). */
export function queryOne<T>(sql: string, ...params: unknown[]): T | undefined {
  return db.prepare(sql).get(...(params as Param[])) as unknown as T | undefined;
}

/** Run a query and return all rows typed as T[]. */
export function queryAll<T>(sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...(params as Param[])) as unknown as T[];
}

/** Execute an INSERT/UPDATE/DELETE and return the run result. */
export function run(sql: string, ...params: unknown[]) {
  return db.prepare(sql).run(...(params as Param[]));
}

/** Open (if needed) + migrate the default tenant's database. Safe to call repeatedly. */
export function init(): void {
  getDb(DEFAULT_TENANT);
}

function createSchema(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS departments (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT NOT NULL UNIQUE,
      -- The user who approves this department's mobile requests / attendance
      -- corrections (see src/routes/me.routes.ts). NULL ⇒ only hr.manage holders can.
      head_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS users (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      username             TEXT NOT NULL UNIQUE,
      full_name            TEXT NOT NULL,
      email                TEXT,
      password_hash        TEXT NOT NULL,
      role                 TEXT NOT NULL DEFAULT 'admin_staff',
      department_id        INTEGER REFERENCES departments(id) ON DELETE SET NULL,
      active               INTEGER NOT NULL DEFAULT 1,
      permission_overrides TEXT NOT NULL DEFAULT '{}',
      created_at           TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- One-time password-reset tokens (hashed). See src/routes/auth.routes.ts.
    CREATE TABLE IF NOT EXISTS password_resets (
      token_hash TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      used       INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );

    -- Idempotency for retried mutating requests (the mobile offline queue supplies an
    -- Idempotency-Key header). A replayed key returns the first response verbatim
    -- instead of applying the change again. See src/idempotency.ts.
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key         TEXT PRIMARY KEY,
      user_id     INTEGER,
      method      TEXT NOT NULL,
      path        TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      response    TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Web-push subscriptions (one per browser/device). See src/push.ts.
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint   TEXT NOT NULL UNIQUE,
      p256dh     TEXT NOT NULL,
      auth       TEXT NOT NULL,
      user_agent TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Raw time-clock events. Employees punch by scanning the office kiosk's rotating
    -- QR (from the mobile app) or by typing their employee no. + name at the kiosk.
    -- HR reconciles these into attendance_records per cutoff. See src/clock.ts.
    CREATE TABLE IF NOT EXISTS time_punches (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      ts          TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      work_date   TEXT NOT NULL,
      kind        TEXT NOT NULL,     -- 'in' | 'out'
      segment     TEXT NOT NULL,     -- morning_in | lunch_out | afternoon_in | afternoon_out | other_in | other_out
      source      TEXT NOT NULL,     -- 'phone' | 'kiosk'
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_punch_emp_date ON time_punches(employee_id, work_date);

    -- Company-wide announcements shown on the mobile home + an announcements view.
    -- Anyone can read the active ones; posting/editing needs the 'announce' permission.
    CREATE TABLE IF NOT EXISTS announcements (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      title      TEXT NOT NULL,
      body       TEXT NOT NULL,
      pinned     INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT,                 -- "YYYY-MM-DD HH:MM" local; hidden once past
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Employee-filed fixes for a missed / wrong time punch. An approver (the
    -- filer's department head, or any hr.manage holder) decides; on approval the
    -- matching attendance_records row for that work_date is filled in.
    CREATE TABLE IF NOT EXISTS time_corrections (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id   INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
      work_date     TEXT NOT NULL,
      requested_in  TEXT,              -- "HH:MM" or NULL
      requested_out TEXT,              -- "HH:MM" or NULL
      reason        TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','approved','rejected','cancelled')),
      decided_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      decided_at    TEXT,
      decision_note TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_time_corrections_emp ON time_corrections(employee_id);
    CREATE INDEX IF NOT EXISTS idx_time_corrections_status ON time_corrections(status);

    CREATE TABLE IF NOT EXISTS suppliers (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      name           TEXT NOT NULL,
      contact_person TEXT,
      phone          TEXT,
      email          TEXT,
      address        TEXT,
      notes          TEXT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS locations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      type        TEXT NOT NULL DEFAULT 'warehouse',
      address     TEXT,
      notes       TEXT,
      is_default  INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS inventory_items (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL,
      sku           TEXT UNIQUE,
      category      TEXT,
      department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
      supplier_id   INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
      quantity      INTEGER NOT NULL DEFAULT 0,
      unit          TEXT DEFAULT 'pcs',
      min_quantity  INTEGER NOT NULL DEFAULT 0,
      location      TEXT,
      notes         TEXT,
      attributes    TEXT,
      image_path    TEXT,
      is_finished_product INTEGER NOT NULL DEFAULT 0,
      qc_checklist_id INTEGER REFERENCES qc_checklists(id) ON DELETE SET NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Bill of materials: the components an item flagged is_finished_product is built from.
    CREATE TABLE IF NOT EXISTS bom_components (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      product_item_id   INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      component_item_id INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      quantity          REAL NOT NULL DEFAULT 1,
      notes             TEXT,
      sort              INTEGER NOT NULL DEFAULT 0,
      UNIQUE(product_item_id, component_item_id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS notes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title      TEXT,
      body       TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title       TEXT NOT NULL,
      due_date    TEXT,               -- "YYYY-MM-DD" or "YYYY-MM-DD HH:MM" (scheduler)
      notes       TEXT,
      remind_at   TEXT,               -- "YYYY-MM-DD HH:MM" local; fires one push then clears
      remind_sent INTEGER NOT NULL DEFAULT 0,
      done        INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS bookmarks (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label      TEXT NOT NULL,
      route      TEXT NOT NULL,
      params     TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- AI Assistant chat history: persists per user across sessions/reloads until they
    -- clear it (DELETE /api/ai/messages). steps is the tool-call trail for an assistant
    -- turn (JSON), kept so record/report links still work after a reload.
    CREATE TABLE IF NOT EXISTS ai_messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role       TEXT NOT NULL CHECK (role IN ('user','assistant')),
      content    TEXT NOT NULL,
      steps      TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ai_messages_user ON ai_messages(user_id, id);

    CREATE TABLE IF NOT EXISTS orders (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      type             TEXT NOT NULL CHECK (type IN ('sale','job','purchase')),
      number           TEXT NOT NULL UNIQUE,
      customer_name    TEXT,
      customer_contact TEXT,
      order_date       TEXT,
      status           TEXT NOT NULL DEFAULT 'open',
      notes            TEXT,
      currency         TEXT NOT NULL DEFAULT 'PHP',
      subtotal         REAL NOT NULL DEFAULT 0,
      tax_percent      REAL NOT NULL DEFAULT 0,
      tax_amount       REAL NOT NULL DEFAULT 0,
      total            REAL NOT NULL DEFAULT 0,
      created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      item_id     INTEGER REFERENCES inventory_items(id) ON DELETE SET NULL,
      name        TEXT NOT NULL,
      sku         TEXT,
      description TEXT,
      quantity    REAL NOT NULL DEFAULT 1,
      unit        TEXT,
      unit_price  REAL NOT NULL DEFAULT 0,
      line_total  REAL NOT NULL DEFAULT 0,
      sort        INTEGER NOT NULL DEFAULT 0
    );

    -- Manufacturing job orders (Phase B). Consume a product's BOM to build N units.
    CREATE TABLE IF NOT EXISTS job_orders (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      number             TEXT NOT NULL UNIQUE,
      order_id           INTEGER REFERENCES orders(id) ON DELETE SET NULL,
      product_item_id    INTEGER REFERENCES inventory_items(id) ON DELETE SET NULL,
      product_name       TEXT NOT NULL,
      qty_ordered        INTEGER NOT NULL,
      qty_done           INTEGER NOT NULL DEFAULT 0,
      qty_scrapped       INTEGER NOT NULL DEFAULT 0,
      status             TEXT NOT NULL DEFAULT 'draft',
      source_location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
      output_location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
      qc_stages          INTEGER NOT NULL DEFAULT 0,
      notes              TEXT,
      created_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
      released_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
      released_at        TEXT,
      closed_at          TEXT,
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS job_order_components (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      job_order_id      INTEGER NOT NULL REFERENCES job_orders(id) ON DELETE CASCADE,
      component_item_id INTEGER REFERENCES inventory_items(id) ON DELETE SET NULL,
      component_name    TEXT NOT NULL,
      qty_per_unit      INTEGER NOT NULL,
      qty_planned       INTEGER NOT NULL,
      qty_consumed      INTEGER NOT NULL DEFAULT 0,
      UNIQUE(job_order_id, component_item_id)
    );

    -- Phase C: one row per physical unit produced by a job order, plus its QA/QC log.
    -- status: pending | in_stock | failed | scrapped | sold. order_id ties a
    -- sold / relocated unit to the sales order that consumed or moved it.
    CREATE TABLE IF NOT EXISTS job_order_units (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      job_order_id    INTEGER NOT NULL REFERENCES job_orders(id) ON DELETE CASCADE,
      product_item_id INTEGER REFERENCES inventory_items(id) ON DELETE SET NULL,
      identifier      TEXT,
      status          TEXT NOT NULL DEFAULT 'pending',
      stage           INTEGER NOT NULL DEFAULT 0,
      location_id     INTEGER REFERENCES locations(id) ON DELETE SET NULL,
      order_id        INTEGER REFERENCES orders(id) ON DELETE SET NULL,
      remarks         TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS qc_records (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      job_order_id INTEGER NOT NULL REFERENCES job_orders(id) ON DELETE CASCADE,
      unit_id      INTEGER REFERENCES job_order_units(id) ON DELETE CASCADE,
      stage        INTEGER NOT NULL,
      result       TEXT NOT NULL,
      remarks      TEXT,
      -- JSON snapshot of the checklist the inspector filled: [{label, ok, note}].
      checklist    TEXT,
      inspector_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Named QA/QC checklist templates. A finished product points at one via
    -- inventory_items.qc_checklist_id; the is_default row is used for products
    -- with none attached. The items column is JSON: [{label, required, stage}].
    CREATE TABLE IF NOT EXISTS qc_checklists (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      items      TEXT NOT NULL DEFAULT '[]',
      is_default INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS doc_templates (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      type       TEXT NOT NULL DEFAULT 'generic' CHECK (type IN ('sale','job','purchase','generic')),
      body       TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS inventory_transactions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id       INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
      change        INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      reason        TEXT,
      location_id           INTEGER REFERENCES locations(id) ON DELETE SET NULL,
      location_balance_after INTEGER,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Per-location stock. inventory_items.quantity stays the cached grand total;
    -- this is the breakdown, kept in sync by src/inventory-stock.ts.
    CREATE TABLE IF NOT EXISTS inventory_stock (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id     INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
      quantity    INTEGER NOT NULL DEFAULT 0,
      UNIQUE(item_id, location_id)
    );

    CREATE TABLE IF NOT EXISTS activity_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      user_name   TEXT,
      method      TEXT NOT NULL,
      path        TEXT NOT NULL,
      entity      TEXT,
      entity_id   TEXT,
      action      TEXT,
      status_code INTEGER,
      ip          TEXT,
      summary     TEXT,
      meta        TEXT
    );

    CREATE TABLE IF NOT EXISTS forms (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      title         TEXT NOT NULL,
      description   TEXT,
      category      TEXT,
      stored_name   TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type     TEXT,
      size_bytes    INTEGER NOT NULL DEFAULT 0,
      department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
      uploaded_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      subject      TEXT,
      body         TEXT NOT NULL,
      read_at      TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Files/images/documents attached to a message. Counted against the sender's
    -- per-user storage cap (see MESSAGE_STORAGE_CAP in messages.routes.ts); freed
    -- automatically when the parent message is deleted (ON DELETE CASCADE).
    CREATE TABLE IF NOT EXISTS message_attachments (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id    INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      stored_name   TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type     TEXT,
      size_bytes    INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_message_attachments_message ON message_attachments(message_id);

    CREATE TABLE IF NOT EXISTS form_definitions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL,
      slug          TEXT NOT NULL UNIQUE,
      number_prefix TEXT NOT NULL DEFAULT 'FM',
      icon          TEXT NOT NULL DEFAULT 'file',
      fields        TEXT NOT NULL DEFAULT '[]',
      created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT
    );

    CREATE TABLE IF NOT EXISTS form_records (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      form_def_id INTEGER NOT NULL REFERENCES form_definitions(id) ON DELETE CASCADE,
      number      TEXT NOT NULL UNIQUE,
      data        TEXT NOT NULL DEFAULT '{}',
      status      TEXT NOT NULL DEFAULT 'draft',
      created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT
    );

    CREATE TABLE IF NOT EXISTS global_variables (
      key        TEXT PRIMARY KEY,
      label      TEXT NOT NULL,
      value      TEXT NOT NULL DEFAULT '',
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Document-template variable registry: categorized, global or template-local,
    -- each a constant / bound data field / formula. (Distinct from the form-builder's
    -- flat global_variables above.)
    CREATE TABLE IF NOT EXISTS doc_variables (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      scope       TEXT NOT NULL DEFAULT 'global' CHECK (scope IN ('global','template')),
      template_id INTEGER REFERENCES doc_templates(id) ON DELETE CASCADE,
      category    TEXT NOT NULL DEFAULT 'Custom',
      key         TEXT NOT NULL,
      label       TEXT NOT NULL,
      source_type TEXT NOT NULL DEFAULT 'constant' CHECK (source_type IN ('constant','field','formula')),
      value       TEXT,
      field_path  TEXT,
      formula     TEXT,
      data_type   TEXT NOT NULL DEFAULT 'text' CHECK (data_type IN ('text','number','currency','date')),
      sort        INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS employees (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_no   TEXT UNIQUE,
      name          TEXT NOT NULL,
      department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
      position      TEXT,
      daily_rate    REAL NOT NULL DEFAULT 0,
      status        TEXT NOT NULL DEFAULT 'probationary'
                      CHECK (status IN ('probationary','regular','resigned','terminated')),
      start_date    TEXT,
      sss_no        TEXT,
      philhealth_no TEXT,
      pagibig_no    TEXT,
      tin_no        TEXT,
      photo         TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS employee_documents (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id   INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      title         TEXT NOT NULL,
      stored_name   TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type     TEXT,
      size_bytes    INTEGER NOT NULL DEFAULT 0,
      uploaded_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS shifts (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time   TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0
    );

    -- Versioned PH statutory rate tables (SSS / PhilHealth / Pag-IBIG / BIR withholding).
    -- One row per (kind, effective_from); the payroll engine uses the latest row whose
    -- effective_from is on or before the pay date. Admin-editable — see src/ph-statutory.ts
    -- and docs/PH-PAYROLL-COMPLIANCE.md.
    CREATE TABLE IF NOT EXISTS payroll_tables (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      kind           TEXT NOT NULL CHECK (kind IN ('sss','philhealth','pagibig','rwt')),
      effective_from TEXT NOT NULL,
      data           TEXT NOT NULL,
      note           TEXT,
      created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(kind, effective_from)
    );

    CREATE TABLE IF NOT EXISTS attendance_periods (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      label      TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date   TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS attendance_records (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      period_id   INTEGER NOT NULL REFERENCES attendance_periods(id) ON DELETE CASCADE,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
      work_date   TEXT NOT NULL,
      time_in     TEXT,
      time_out    TEXT,
      notes       TEXT,
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(period_id, employee_id, work_date)
    );

    CREATE INDEX IF NOT EXISTS idx_form_records_def ON form_records(form_def_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_doc_variables_key ON doc_variables(scope, IFNULL(template_id, 0), key);

    CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient_id);
    CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);
    CREATE INDEX IF NOT EXISTS idx_txn_item ON inventory_transactions(item_id);
    CREATE INDEX IF NOT EXISTS idx_items_dept ON inventory_items(department_id);
    CREATE INDEX IF NOT EXISTS idx_stock_item ON inventory_stock(item_id);
    CREATE INDEX IF NOT EXISTS idx_stock_location ON inventory_stock(location_id);
    CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_activity_user ON activity_log(user_id);
    CREATE INDEX IF NOT EXISTS idx_activity_entity ON activity_log(entity);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_notes_user ON notes(user_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id);
    CREATE INDEX IF NOT EXISTS idx_bookmarks_user ON bookmarks(user_id);
    CREATE INDEX IF NOT EXISTS idx_orders_type ON orders(type);
    CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
    CREATE INDEX IF NOT EXISTS idx_job_orders_status ON job_orders(status);
    CREATE INDEX IF NOT EXISTS idx_job_orders_order ON job_orders(order_id);
    CREATE INDEX IF NOT EXISTS idx_joc_job_order ON job_order_components(job_order_id);
    CREATE INDEX IF NOT EXISTS idx_jou_job_order ON job_order_units(job_order_id);
    CREATE INDEX IF NOT EXISTS idx_jou_product ON job_order_units(product_item_id, status);
    CREATE INDEX IF NOT EXISTS idx_qc_job_order ON qc_records(job_order_id);
    CREATE INDEX IF NOT EXISTS idx_employees_dept ON employees(department_id);
    CREATE INDEX IF NOT EXISTS idx_attendance_period ON attendance_records(period_id);
    CREATE INDEX IF NOT EXISTS idx_attendance_employee ON attendance_records(employee_id);
    CREATE INDEX IF NOT EXISTS idx_employee_documents_employee ON employee_documents(employee_id);

    CREATE TABLE IF NOT EXISTS mail_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      to_addr     TEXT NOT NULL,
      subject     TEXT,
      status      TEXT NOT NULL,
      provider_id TEXT,
      error       TEXT,
      sent_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_mail_log_created ON mail_log(created_at);

    -- Photo attachments hung off another record for documentation (QC unit
    -- inspections, damage reports, problem reports). Files live under UPLOAD_DIR;
    -- served by GET /api/attachments/:id/image. See src/routes/attachments.routes.ts.
    CREATE TABLE IF NOT EXISTS attachments (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      kind        TEXT NOT NULL,      -- 'qc_unit' | 'damage' | 'problem'
      ref_id      INTEGER NOT NULL,
      image_path  TEXT NOT NULL,
      caption     TEXT,
      uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_attachments_ref ON attachments(kind, ref_id);

    -- Field deliveries / drops + their proof of delivery (recipient, signature,
    -- GPS, photos). See src/routes/deliveries.routes.ts. Permission-gated:
    -- delivery.run (do your assigned drops) / delivery.manage (plan + see all).
    CREATE TABLE IF NOT EXISTS deliveries (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      number         TEXT NOT NULL UNIQUE,
      order_id       INTEGER REFERENCES orders(id) ON DELETE SET NULL,
      customer_name  TEXT,
      address        TEXT,
      contact_phone  TEXT,
      scheduled_date TEXT,
      assigned_to    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      status         TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','out_for_delivery','delivered','failed','cancelled')),
      notes          TEXT,
      pod_recipient  TEXT,
      pod_signature_attachment_id INTEGER REFERENCES attachments(id) ON DELETE SET NULL,
      pod_lat        REAL,
      pod_lng        REAL,
      pod_note       TEXT,
      delivered_at   TEXT,
      delivered_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_deliveries_assigned ON deliveries(assigned_to, status);
    CREATE INDEX IF NOT EXISTS idx_deliveries_date ON deliveries(scheduled_date);

    -- Links between a local record and its QuickBooks Online counterpart, so a re-push
    -- updates rather than duplicates. See src/quickbooks.ts.
    CREATE TABLE IF NOT EXISTS qbo_links (
      entity     TEXT NOT NULL,   -- 'order' | 'customer' | 'item' | 'vendor'
      local_id   TEXT NOT NULL,   -- our id (order id, "name:Acme", "sku:HB-M8"…)
      qbo_type   TEXT NOT NULL,   -- 'Invoice' | 'Bill' | 'Customer' | 'Item' | 'Vendor'
      qbo_id     TEXT NOT NULL,
      sync_token TEXT,            -- QBO optimistic-lock token from the last write
      synced_at  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (entity, local_id)
    );

    -- Purchasing: goods receipts against a purchase order + vendor bills + 3-way match.
    -- A purchase order is an orders row with type = 'purchase'.
    CREATE TABLE IF NOT EXISTS goods_receipts (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      number        TEXT NOT NULL UNIQUE,               -- GRN-00001
      order_id      INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      supplier_id   INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
      location_id   INTEGER REFERENCES locations(id) ON DELETE SET NULL,
      received_date TEXT,
      notes         TEXT,
      received_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS goods_receipt_items (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_id    INTEGER NOT NULL REFERENCES goods_receipts(id) ON DELETE CASCADE,
      order_item_id INTEGER REFERENCES order_items(id) ON DELETE SET NULL,
      item_id       INTEGER REFERENCES inventory_items(id) ON DELETE SET NULL,
      name          TEXT NOT NULL,
      sku           TEXT,
      quantity      REAL NOT NULL DEFAULT 0,
      unit          TEXT,
      sort          INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS vendor_bills (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      number        TEXT NOT NULL UNIQUE,               -- BILL-00001 (our internal ref)
      vendor_ref    TEXT,                               -- the supplier's own invoice no.
      order_id      INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      supplier_id   INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
      bill_date     TEXT,
      due_date      TEXT,
      currency      TEXT NOT NULL DEFAULT 'PHP',
      subtotal      REAL NOT NULL DEFAULT 0,
      tax_percent   REAL NOT NULL DEFAULT 0,
      tax_amount    REAL NOT NULL DEFAULT 0,
      total         REAL NOT NULL DEFAULT 0,
      status        TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','approved','disputed')),
      match_json    TEXT,                               -- snapshot of the last 3-way match
      dispute_note  TEXT,
      approved_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      approved_at   TEXT,
      notes         TEXT,
      created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS vendor_bill_items (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      bill_id       INTEGER NOT NULL REFERENCES vendor_bills(id) ON DELETE CASCADE,
      order_item_id INTEGER REFERENCES order_items(id) ON DELETE SET NULL,
      item_id       INTEGER REFERENCES inventory_items(id) ON DELETE SET NULL,
      name          TEXT NOT NULL,
      sku           TEXT,
      quantity      REAL NOT NULL DEFAULT 0,
      unit          TEXT,
      unit_price    REAL NOT NULL DEFAULT 0,
      line_total    REAL NOT NULL DEFAULT 0,
      sort          INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_grn_order ON goods_receipts(order_id);
    CREATE INDEX IF NOT EXISTS idx_grn_items_receipt ON goods_receipt_items(receipt_id);
    CREATE INDEX IF NOT EXISTS idx_vbills_order ON vendor_bills(order_id);
    CREATE INDEX IF NOT EXISTS idx_vbills_status ON vendor_bills(status);
    CREATE INDEX IF NOT EXISTS idx_vbill_items_bill ON vendor_bill_items(bill_id);

    -- Petty cash: named cash funds + a running money-in / money-out register per fund.
    -- Informal ledger for now; maps to the Cash Receipts / Cash Disbursements books once
    -- the general ledger lands (see docs/ACCOUNTING-SYSTEM-PLAN.md).
    CREATE TABLE IF NOT EXISTS petty_cash_funds (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT NOT NULL,
      custodian       TEXT,
      location_id     INTEGER REFERENCES locations(id) ON DELETE SET NULL,
      opening_balance REAL NOT NULL DEFAULT 0,
      currency        TEXT NOT NULL DEFAULT 'PHP',
      active          INTEGER NOT NULL DEFAULT 1,
      notes           TEXT,
      created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS petty_cash_entries (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      fund_id       INTEGER NOT NULL REFERENCES petty_cash_funds(id) ON DELETE CASCADE,
      entry_date    TEXT NOT NULL,                      -- YYYY-MM-DD
      direction     TEXT NOT NULL CHECK (direction IN ('in','out')),
      amount        REAL NOT NULL,                      -- always > 0
      category      TEXT,                               -- 'Replenishment', 'Supplies', 'Transport', ...
      counterparty  TEXT,                               -- payee (out) / source (in)
      reference_no  TEXT,                               -- OR / voucher / receipt no.
      notes         TEXT,
      recorded_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_pce_fund ON petty_cash_entries(fund_id, entry_date);

    -- Double-entry general ledger (ACCOUNTING-SYSTEM-PLAN.md Phase 0), modelled on
    -- Frappe Books: Account (tree) / JournalEntry + JournalEntryAccount / Accounting
    -- LedgerEntry. journal_lines of a posted entry ARE the ledger. Gated by
    -- settings.accounting_ledger.enabled; POST /accounting/ledger/setup seeds the COA.
    CREATE TABLE IF NOT EXISTS accounts (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      code         TEXT NOT NULL UNIQUE,
      name         TEXT NOT NULL,
      root_type    TEXT NOT NULL CHECK (root_type IN ('asset','liability','equity','income','expense')),
      account_type TEXT,                          -- cash/bank/receivable/payable/tax/stock/cogs/depreciation/round_off/…
      parent_id    INTEGER REFERENCES accounts(id) ON DELETE RESTRICT,
      is_group     INTEGER NOT NULL DEFAULT 0,    -- header node, not directly postable
      currency     TEXT NOT NULL DEFAULT 'PHP',
      description  TEXT,
      archived     INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_accounts_parent ON accounts(parent_id);

    CREATE TABLE IF NOT EXISTS accounting_periods (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date   TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
      closed_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      closed_at  TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS journal_entries (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      number      TEXT NOT NULL UNIQUE,           -- JV-000001, gapless
      book        TEXT NOT NULL DEFAULT 'general'
                    CHECK (book IN ('general','sales','purchase','cash_receipts','cash_disbursements','payroll')),
      entry_date  TEXT NOT NULL,
      memo        TEXT,
      reference   TEXT,
      source_type TEXT,                           -- 'order' | 'vendor_bill' | 'payslip' | 'petty_cash' | … (auto-post link)
      source_id   INTEGER,
      status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','void')),
      reverses_id INTEGER REFERENCES journal_entries(id) ON DELETE SET NULL,
      posted_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      posted_at   TEXT,
      created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_je_date ON journal_entries(entry_date);
    CREATE INDEX IF NOT EXISTS idx_je_source ON journal_entries(source_type, source_id);

    CREATE TABLE IF NOT EXISTS journal_lines (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id   INTEGER NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      debit      REAL NOT NULL DEFAULT 0,
      credit     REAL NOT NULL DEFAULT 0,
      party_type TEXT,                            -- 'customer' | 'supplier' | 'employee'
      party_id   INTEGER,
      memo       TEXT,
      sort       INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_jl_entry ON journal_lines(entry_id);
    CREATE INDEX IF NOT EXISTS idx_jl_account ON journal_lines(account_id);

    -- Customers registry (the AR-side counterpart of suppliers). Sale orders point
    -- at one via orders.customer_id. See src/routes/customers.routes.ts.
    CREATE TABLE IF NOT EXISTS customers (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      name               TEXT NOT NULL,
      contact_person     TEXT,
      phone              TEXT,
      email              TEXT,
      address            TEXT,
      tin                TEXT,
      payment_terms_days INTEGER NOT NULL DEFAULT 0,
      notes              TEXT,
      archived           INTEGER NOT NULL DEFAULT 0,
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Money received from a customer / paid to a supplier. Auto-posts to the cash
    -- receipts / disbursements book and settles the AR / AP control account.
    -- payment_allocations optionally pins a payment against specific sale orders /
    -- vendor bills so AR / AP aging can compute an open balance per document.
    -- See src/routes/accounting.routes.ts (payments) + src/accounting-autopost.ts.
    CREATE TABLE IF NOT EXISTS payments (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      number             TEXT NOT NULL UNIQUE,
      direction          TEXT NOT NULL CHECK (direction IN ('in','out')),
      party_type         TEXT NOT NULL CHECK (party_type IN ('customer','supplier')),
      party_id           INTEGER,
      party_name         TEXT,
      payment_date       TEXT NOT NULL,
      amount             REAL NOT NULL,
      method             TEXT,
      reference          TEXT,
      deposit_account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
      memo               TEXT,
      status             TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','void')),
      created_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_payments_party ON payments(party_type, party_id);
    CREATE TABLE IF NOT EXISTS payment_allocations (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
      doc_type   TEXT NOT NULL CHECK (doc_type IN ('sale_order','vendor_bill')),
      doc_id     INTEGER NOT NULL,
      amount     REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pay_alloc_doc ON payment_allocations(doc_type, doc_id);

    -- Credit notes (customer: sales return / allowance -> reduces AR) and debit notes
    -- (supplier: purchase return / allowance -> reduces AP). Header-only, like payments.
    -- Auto-posts a contra entry; nets against the party in AR / AP aging.
    CREATE TABLE IF NOT EXISTS credit_notes (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      number          TEXT NOT NULL UNIQUE,
      kind            TEXT NOT NULL CHECK (kind IN ('customer','supplier')),
      party_id        INTEGER,
      party_name      TEXT,
      note_date       TEXT NOT NULL,
      source_doc_type TEXT CHECK (source_doc_type IN ('sale_order','vendor_bill')),
      source_doc_id   INTEGER,
      reason          TEXT,
      subtotal        REAL NOT NULL DEFAULT 0,
      tax_amount      REAL NOT NULL DEFAULT 0,
      total           REAL NOT NULL DEFAULT 0,
      status          TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','void')),
      created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_credit_notes_party ON credit_notes(kind, party_id);

    -- Tax codes: the VAT / withholding classifications a document can carry. Drives the
    -- GL auto-post (which VAT account) and the BIR sales / purchase journals (which
    -- column). Seeded with the standard PH set below; editable. See accounting.routes.ts.
    CREATE TABLE IF NOT EXISTS tax_codes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      code       TEXT NOT NULL UNIQUE,
      name       TEXT NOT NULL,
      kind       TEXT NOT NULL CHECK (kind IN ('output_vat','input_vat','exempt','zero_rated','ewt')),
      rate       REAL NOT NULL DEFAULT 0,
      account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
      atc        TEXT,
      active     INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Full-text index for the AI knowledge search (RAG). Rebuilt by src/rag.ts;
    -- rows carry an ACL (permission key) + optional dept_id for retrieval filtering.
    CREATE VIRTUAL TABLE IF NOT EXISTS doc_chunks USING fts5(
      body,
      ref_label   UNINDEXED,
      source_type UNINDEXED,
      source_id   UNINDEXED,
      acl         UNINDEXED,
      dept_id     UNINDEXED,
      tokenize = 'porter unicode61'
    );
  `);
}

/** Idempotent schema upgrades for databases created before a column existed. */
function migrate(): void {
  const itemCols = db.prepare('PRAGMA table_info(inventory_items)').all() as { name: string }[];
  if (!itemCols.some((c) => c.name === 'attributes')) {
    db.exec('ALTER TABLE inventory_items ADD COLUMN attributes TEXT');
  }
  if (!itemCols.some((c) => c.name === 'image_path')) {
    db.exec('ALTER TABLE inventory_items ADD COLUMN image_path TEXT');
  }
  if (!itemCols.some((c) => c.name === 'supplier_id')) {
    db.exec('ALTER TABLE inventory_items ADD COLUMN supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL');
  }
  if (!itemCols.some((c) => c.name === 'is_finished_product')) {
    db.exec('ALTER TABLE inventory_items ADD COLUMN is_finished_product INTEGER NOT NULL DEFAULT 0');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_items_supplier ON inventory_items(supplier_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_bom_product ON bom_components(product_item_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_bom_component ON bom_components(component_item_id)');

  // ---- Tasks: scheduling + reminders ----
  const taskCols = db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
  if (!taskCols.some((c) => c.name === 'notes')) db.exec('ALTER TABLE tasks ADD COLUMN notes TEXT');
  if (!taskCols.some((c) => c.name === 'remind_at')) db.exec('ALTER TABLE tasks ADD COLUMN remind_at TEXT');
  if (!taskCols.some((c) => c.name === 'remind_sent')) db.exec('ALTER TABLE tasks ADD COLUMN remind_sent INTEGER NOT NULL DEFAULT 0');

  // ---- Per-location stock (Phase 4) ----
  const txnCols = db.prepare('PRAGMA table_info(inventory_transactions)').all() as { name: string }[];
  if (!txnCols.some((c) => c.name === 'location_id')) {
    db.exec('ALTER TABLE inventory_transactions ADD COLUMN location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL');
  }
  if (!txnCols.some((c) => c.name === 'location_balance_after')) {
    db.exec('ALTER TABLE inventory_transactions ADD COLUMN location_balance_after INTEGER');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_txn_location ON inventory_transactions(location_id)');

  // Every install needs exactly one default location. Seed it, then move each item's
  // existing single-column quantity into a per-location row there (once).
  const locCount = (db.prepare('SELECT COUNT(*) AS n FROM locations').get() as { n: number }).n;
  if (locCount === 0) {
    db.prepare("INSERT INTO locations (name, type, is_default) VALUES ('Main', 'warehouse', 1)").run();
  } else if ((db.prepare('SELECT COUNT(*) AS n FROM locations WHERE is_default = 1').get() as { n: number }).n === 0) {
    db.exec('UPDATE locations SET is_default = 1 WHERE id = (SELECT MIN(id) FROM locations)');
  }
  const defaultLoc = (db.prepare('SELECT id FROM locations WHERE is_default = 1 LIMIT 1').get() as { id: number }).id;
  db.prepare(
    `INSERT INTO inventory_stock (item_id, location_id, quantity)
     SELECT i.id, ?, i.quantity FROM inventory_items i
     WHERE i.quantity <> 0
       AND NOT EXISTS (SELECT 1 FROM inventory_stock s WHERE s.item_id = i.id)`
  ).run(defaultLoc);
  db.prepare('UPDATE inventory_transactions SET location_id = ? WHERE location_id IS NULL').run(defaultLoc);

  // Blank SKUs must be stored as NULL, never '': the UNIQUE constraint on sku exempts only
  // NULL, so two items both saved with an empty SKU would collide. Older rows predate the
  // validation layer normalizing this (see optionalSku in validation.ts).
  db.exec("UPDATE inventory_items SET sku = NULL WHERE sku = ''");

  // Rebuild users table to add permission_overrides and drop old two-role CHECK constraint.
  const userCols = db.prepare('PRAGMA table_info(users)').all() as { name: string }[];
  if (!userCols.some((c) => c.name === 'permission_overrides')) {
    db.exec(`
      BEGIN;
      CREATE TABLE users_new (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        username             TEXT NOT NULL UNIQUE,
        full_name            TEXT NOT NULL,
        password_hash        TEXT NOT NULL,
        role                 TEXT NOT NULL DEFAULT 'admin_staff',
        department_id        INTEGER REFERENCES departments(id) ON DELETE SET NULL,
        active               INTEGER NOT NULL DEFAULT 1,
        permission_overrides TEXT NOT NULL DEFAULT '{}',
        created_at           TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO users_new
        (id, username, full_name, password_hash, role, department_id, active, created_at)
        SELECT id, username, full_name, password_hash,
               CASE role WHEN 'employee' THEN 'admin_staff' ELSE role END,
               department_id, active, created_at
        FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
      COMMIT;
    `);
  }
  // Optional contact email (password reset, billing contact).
  if (!db.prepare('PRAGMA table_info(users)').all().some((c) => (c as { name: string }).name === 'email')) {
    db.exec('ALTER TABLE users ADD COLUMN email TEXT');
  }

  // Rebuild orders table to add 'purchase' to the type CHECK constraint.
  const ordersSchema = (db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='orders'"
  ).get() as { sql: string } | undefined)?.sql ?? '';
  if (!ordersSchema.includes("'purchase'")) {
    db.exec(`
      BEGIN;
      CREATE TABLE orders_new (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        type             TEXT NOT NULL CHECK (type IN ('sale','job','purchase')),
        number           TEXT NOT NULL UNIQUE,
        customer_name    TEXT,
        customer_contact TEXT,
        order_date       TEXT,
        status           TEXT NOT NULL DEFAULT 'open',
        notes            TEXT,
        currency         TEXT NOT NULL DEFAULT 'PHP',
        subtotal         REAL NOT NULL DEFAULT 0,
        tax_percent      REAL NOT NULL DEFAULT 0,
        tax_amount       REAL NOT NULL DEFAULT 0,
        total            REAL NOT NULL DEFAULT 0,
        created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO orders_new SELECT * FROM orders;
      DROP TABLE orders;
      ALTER TABLE orders_new RENAME TO orders;
      CREATE INDEX IF NOT EXISTS idx_orders_type ON orders(type);
      COMMIT;
    `);
  }

  // Rebuild doc_templates to add 'purchase' to the type CHECK constraint.
  const templatesSchema = (db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='doc_templates'"
  ).get() as { sql: string } | undefined)?.sql ?? '';
  if (!templatesSchema.includes("'purchase'")) {
    db.exec(`
      BEGIN;
      CREATE TABLE doc_templates_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL,
        type       TEXT NOT NULL DEFAULT 'generic' CHECK (type IN ('sale','job','purchase','generic')),
        period     TEXT,
        body       TEXT NOT NULL,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO doc_templates_new (id,name,type,body,created_by,created_at,updated_at)
        SELECT id,name,type,body,created_by,created_at,updated_at FROM doc_templates;
      DROP TABLE doc_templates;
      ALTER TABLE doc_templates_new RENAME TO doc_templates;
      COMMIT;
    `);
  }

  // Add period column for DBs that already had 'purchase' but not the period column.
  const tplCols = db.prepare('PRAGMA table_info(doc_templates)').all() as { name: string }[];
  if (!tplCols.some((c) => c.name === 'period')) {
    db.exec('ALTER TABLE doc_templates ADD COLUMN period TEXT');
  }

  // Add period column to form_records for payroll-period grouping.
  const frCols = db.prepare('PRAGMA table_info(form_records)').all() as { name: string }[];
  if (!frCols.some((c) => c.name === 'period')) {
    db.exec('ALTER TABLE form_records ADD COLUMN period TEXT');
  }

  // Link a form definition to a doc_template for printing its records — ON DELETE SET NULL so
  // deleting the template directly (from Documents > Templates) just un-links it gracefully.
  const fdCols = db.prepare('PRAGMA table_info(form_definitions)').all() as { name: string }[];
  if (!fdCols.some((c) => c.name === 'template_id')) {
    db.exec('ALTER TABLE form_definitions ADD COLUMN template_id INTEGER REFERENCES doc_templates(id) ON DELETE SET NULL');
  }

  // Which section owns a form (drives forms.manage.<scope> access control + nav placement).
  // NULL = "General", an unowned bucket manageable only by admin (see canManageScope()).
  if (!fdCols.some((c) => c.name === 'scope')) {
    db.exec("ALTER TABLE form_definitions ADD COLUMN scope TEXT CHECK (scope IN ('hr','inventory','admin','accounting'))");
  }
  // The one existing form whose section is unambiguous — everything else stays General rather
  // than guessing.
  db.exec("UPDATE form_definitions SET scope = 'hr' WHERE slug = 'hr_payroll' AND scope IS NULL");

  // Rebuild employees to replace the bare `active` flag with a proper employment-status
  // enum plus the 201-file fields (employee_no, start_date, statutory numbers, photo).
  // Foreign keys must be OFF for this: attendance_records.employee_id references employees,
  // and SQLite enforces FK constraints across a DROP TABLE even mid-rebuild (PRAGMA can only
  // be toggled outside a transaction, so it brackets the whole BEGIN/COMMIT below).
  const empCols = db.prepare('PRAGMA table_info(employees)').all() as { name: string }[];
  if (empCols.length && !empCols.some((c) => c.name === 'status')) {
    db.exec('PRAGMA foreign_keys = OFF;');
    db.exec(`
      BEGIN;
      CREATE TABLE employees_new (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_no   TEXT UNIQUE,
        name          TEXT NOT NULL,
        department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
        position      TEXT,
        daily_rate    REAL NOT NULL DEFAULT 0,
        status        TEXT NOT NULL DEFAULT 'probationary'
                        CHECK (status IN ('probationary','regular','resigned','terminated')),
        start_date    TEXT,
        sss_no        TEXT,
        philhealth_no TEXT,
        pagibig_no    TEXT,
        tin_no        TEXT,
        photo         TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO employees_new (id, employee_no, name, department_id, position, daily_rate, status, created_at)
        SELECT id, 'EMP-' || printf('%05d', id), name, department_id, position, daily_rate,
               CASE WHEN active = 1 THEN 'regular' ELSE 'terminated' END, created_at
        FROM employees;
      DROP TABLE employees;
      ALTER TABLE employees_new RENAME TO employees;
      CREATE INDEX IF NOT EXISTS idx_employees_dept ON employees(department_id);
      COMMIT;
    `);
    db.exec('PRAGMA foreign_keys = ON;');

    // Advance the employee_no counter past the backfilled EMP-##### numbers so the next
    // employee created via nextEmployeeNumber() doesn't collide with one of them.
    const maxId = (db.prepare('SELECT MAX(id) AS id FROM employees').get() as { id: number | null }).id;
    if (maxId && maxId > (getSetting<number>('employee_seq') || 0)) {
      setSetting('employee_seq', maxId);
    }
  }

  // Optional per-day shift assignment (covers rotating shifts — a day just points at whichever
  // shift applied that day) and an optional reference link to the OT/Half Day/Leave/Undertime/
  // Offset form record backing that day, both ON DELETE SET NULL (deleting a shift or a form
  // record gracefully un-links rather than blocking, same pattern as form_definitions.template_id).
  const arCols = db.prepare('PRAGMA table_info(attendance_records)').all() as { name: string }[];
  if (!arCols.some((c) => c.name === 'shift_id')) {
    db.exec('ALTER TABLE attendance_records ADD COLUMN shift_id INTEGER REFERENCES shifts(id) ON DELETE SET NULL');
  }
  if (!arCols.some((c) => c.name === 'form_record_id')) {
    db.exec('ALTER TABLE attendance_records ADD COLUMN form_record_id INTEGER REFERENCES form_records(id) ON DELETE SET NULL');
  }
  // Per-record holiday override: null = inherit whatever the Company Holidays calendar says
  // for this work_date (if anything); 'none' = explicitly *not* a holiday for this person even
  // if the calendar says otherwise (e.g. a 24/7 site); 'regular'/'special_non_working'/
  // 'special_working' = force that type regardless of the calendar. See hr-payroll-compute.ts.
  if (!arCols.some((c) => c.name === 'holiday_type')) {
    db.exec('ALTER TABLE attendance_records ADD COLUMN holiday_type TEXT');
  }
  // Per-record rest-day override: null = inherit the weekly pattern (employees.rest_days else
  // PayrollPolicy.default_rest_days) for this work_date's weekday; 'yes' = force this date to be
  // a rest day for this one employee even though its weekday isn't in the pattern (covers a
  // rotating/varying rest day that changes month to month); 'no' = force it *not* a rest day
  // even though its weekday is in the pattern. See hr.routes.ts generate-payslips. (SCHEMA_VERSION 18)
  if (!arCols.some((c) => c.name === 'rest_day')) {
    db.exec('ALTER TABLE attendance_records ADD COLUMN rest_day TEXT');
  }
  // HR's explicit allow/deny decision on a day that came in under PayrollPolicy.
  // min_work_minutes — null = no decision yet (still pays actual hours, same as 'allow'); see
  // hr-payroll-compute.ts's minimum-hours check. (SCHEMA_VERSION 21)
  if (!arCols.some((c) => c.name === 'min_hours_decision')) {
    db.exec('ALTER TABLE attendance_records ADD COLUMN min_hours_decision TEXT');
  }

  // An employee's *usual* shift — purely a UI pre-fill for new attendance days, never enforced,
  // so a rotating employee can still be assigned a different shift on any given day.
  const empCols2 = db.prepare('PRAGMA table_info(employees)').all() as { name: string }[];
  if (!empCols2.some((c) => c.name === 'default_shift_id')) {
    db.exec('ALTER TABLE employees ADD COLUMN default_shift_id INTEGER REFERENCES shifts(id) ON DELETE SET NULL');
  }
  // JSON array of weekday indices (0=Sun..6=Sat) this employee rests on; null = use the
  // company-wide PayrollPolicy.default_rest_days instead. Never enforced against attendance —
  // purely what the payroll engine checks to apply the rest-day pay premium.
  if (!empCols2.some((c) => c.name === 'rest_days')) {
    db.exec('ALTER TABLE employees ADD COLUMN rest_days TEXT');
  }

  // Rate can be entered as a true daily rate or as a monthly salary; when monthly, daily_rate is
  // kept as the always-correct EFFECTIVE daily rate (computed at save time from monthly_rate /
  // payroll_policy.monthly_rate_divisor) so the payroll engine downstream never has to care which
  // way it was entered — it just reads daily_rate like it always has.
  const empCols3 = db.prepare('PRAGMA table_info(employees)').all() as { name: string }[];
  if (!empCols3.some((c) => c.name === 'rate_type')) {
    db.exec("ALTER TABLE employees ADD COLUMN rate_type TEXT NOT NULL DEFAULT 'daily'");
  }
  if (!empCols3.some((c) => c.name === 'monthly_rate')) {
    db.exec('ALTER TABLE employees ADD COLUMN monthly_rate REAL');
  }

  // Per-employee statutory-deduction switches, controlled from Accounting → Statutory
  // Deductions. Default 1 (deduct); an off flag zeroes that contribution in
  // generate-payslips (and drops the employee from the agency schedule for that fund).
  for (const col of ['deduct_sss', 'deduct_philhealth', 'deduct_pagibig', 'deduct_withholding_tax']) {
    if (!empCols3.some((c) => c.name === col)) {
      db.exec(`ALTER TABLE employees ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 1`);
    }
  }

  // Per-employee "exempt from late deductions" — e.g. the company president, or anyone else
  // whose actual clock-in time HR doesn't want penalized. Default 0 (not exempt, ordinary
  // rules apply); an on flag zeroes the late deduction in generate-payslips
  // (src/hr-payroll-compute.ts's computeAttendanceForEmployee) while still reporting the real
  // lateness — HR can see the pattern, it just doesn't cost the employee anything.
  if (!empCols3.some((c) => c.name === 'late_exempt')) {
    db.exec('ALTER TABLE employees ADD COLUMN late_exempt INTEGER NOT NULL DEFAULT 0');
  }

  // Simple fixed-bank paid-leave balance, admin-set per employee (not accrual-based — no
  // monthly math, no carry-over rules). Default 5 matches PH Service Incentive Leave's
  // minimum but is freely editable per employee, not treated as law. Consumed as Leave
  // Request forms are approved with with_pay = 'Yes' (src/routes/me.routes.ts).
  if (!empCols3.some((c) => c.name === 'leave_days_per_year')) {
    db.exec('ALTER TABLE employees ADD COLUMN leave_days_per_year REAL NOT NULL DEFAULT 5');
  }
  if (!empCols3.some((c) => c.name === 'leave_days_used')) {
    db.exec('ALTER TABLE employees ADD COLUMN leave_days_used REAL NOT NULL DEFAULT 0');
  }

  // Optional link from an HR employee record to the login account they use — lets an employee's
  // 201-file data and their user account be traced to each other. A partial unique index (rather
  // than a UNIQUE column, which SQLite's ADD COLUMN can't express directly) keeps the 1:1
  // relationship enforced at the DB level while still allowing any number of unlinked (NULL) rows.
  const empCols4 = db.prepare('PRAGMA table_info(employees)').all() as { name: string }[];
  if (!empCols4.some((c) => c.name === 'user_id')) {
    db.exec('ALTER TABLE employees ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_user_id ON employees(user_id) WHERE user_id IS NOT NULL');

  // Department head — approves that department's mobile requests / attendance corrections.
  const deptCols = db.prepare('PRAGMA table_info(departments)').all() as { name: string }[];
  if (!deptCols.some((c) => c.name === 'head_user_id')) {
    db.exec('ALTER TABLE departments ADD COLUMN head_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
  }

  // QA/QC: who released a job order + the filled-checklist snapshot per inspection.
  const joCols = db.prepare('PRAGMA table_info(job_orders)').all() as { name: string }[];
  if (!joCols.some((c) => c.name === 'released_by')) {
    db.exec('ALTER TABLE job_orders ADD COLUMN released_by INTEGER REFERENCES users(id) ON DELETE SET NULL');
  }
  const qcCols = db.prepare('PRAGMA table_info(qc_records)').all() as { name: string }[];
  if (!qcCols.some((c) => c.name === 'checklist')) {
    db.exec('ALTER TABLE qc_records ADD COLUMN checklist TEXT');
  }
  // Named QA/QC checklists + per-product attachment (replaces the single settings key).
  const iiCols = db.prepare('PRAGMA table_info(inventory_items)').all() as { name: string }[];
  if (!iiCols.some((c) => c.name === 'qc_checklist_id')) {
    db.exec('ALTER TABLE inventory_items ADD COLUMN qc_checklist_id INTEGER REFERENCES qc_checklists(id) ON DELETE SET NULL');
  }
  // Serialized-unit lifecycle: link a sold / relocated finished unit to its sales order.
  const jouCols = db.prepare('PRAGMA table_info(job_order_units)').all() as { name: string }[];
  if (!jouCols.some((c) => c.name === 'order_id')) {
    db.exec('ALTER TABLE job_order_units ADD COLUMN order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL');
  }

  // Purchasing: a purchase order can name the supplier it's raised against + an
  // expected delivery date (both optional; older POs just carried the vendor name in
  // customer_name). goods_receipts / vendor_bills tables come from createSchema().
  const orderCols = db.prepare('PRAGMA table_info(orders)').all() as { name: string }[];
  if (!orderCols.some((c) => c.name === 'supplier_id')) {
    db.exec('ALTER TABLE orders ADD COLUMN supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL');
  }
  if (!orderCols.some((c) => c.name === 'expected_date')) {
    db.exec('ALTER TABLE orders ADD COLUMN expected_date TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_orders_supplier ON orders(supplier_id)');

  // Sale orders can name the customer they're raised for (customers table comes from
  // createSchema()). Older orders just carried the name in customer_name. (SCHEMA_VERSION 7)
  if (!orderCols.some((c) => c.name === 'customer_id')) {
    db.exec('ALTER TABLE orders ADD COLUMN customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id)');

  // A sale order / vendor bill can carry a tax code (VAT 12 / exempt / zero-rated / EWT),
  // used by the GL auto-post and the BIR sales / purchase journals. (SCHEMA_VERSION 8)
  if (!orderCols.some((c) => c.name === 'tax_code_id')) {
    db.exec('ALTER TABLE orders ADD COLUMN tax_code_id INTEGER REFERENCES tax_codes(id) ON DELETE SET NULL');
  }
  const vbillCols = db.prepare('PRAGMA table_info(vendor_bills)').all() as { name: string }[];
  if (!vbillCols.some((c) => c.name === 'tax_code_id')) {
    db.exec('ALTER TABLE vendor_bills ADD COLUMN tax_code_id INTEGER REFERENCES tax_codes(id) ON DELETE SET NULL');
  }
  const cnoteCols = db.prepare('PRAGMA table_info(credit_notes)').all() as { name: string }[];
  if (cnoteCols.length && !cnoteCols.some((c) => c.name === 'tax_code_id')) {
    db.exec('ALTER TABLE credit_notes ADD COLUMN tax_code_id INTEGER REFERENCES tax_codes(id) ON DELETE SET NULL');
  }

  // Expanded withholding tax (EWT / creditable) held back on a vendor bill: the buyer
  // pays part of the bill to BIR instead of the supplier. Feeds the withholding register
  // + BIR 2307 / 0619-E / 1601-EQ. (SCHEMA_VERSION 9)
  const vbillCols2 = db.prepare('PRAGMA table_info(vendor_bills)').all() as { name: string }[];
  if (!vbillCols2.some((c) => c.name === 'ewt_rate')) {
    db.exec('ALTER TABLE vendor_bills ADD COLUMN ewt_rate REAL NOT NULL DEFAULT 0');
  }
  if (!vbillCols2.some((c) => c.name === 'ewt_amount')) {
    db.exec('ALTER TABLE vendor_bills ADD COLUMN ewt_amount REAL NOT NULL DEFAULT 0');
  }
  if (!vbillCols2.some((c) => c.name === 'ewt_atc')) {
    db.exec('ALTER TABLE vendor_bills ADD COLUMN ewt_atc TEXT');
  }
  // Suppliers get a TIN for the BIR 2307 / withholding register (customers already have one).
  const supCols = db.prepare('PRAGMA table_info(suppliers)').all() as { name: string }[];
  if (!supCols.some((c) => c.name === 'tin')) {
    db.exec('ALTER TABLE suppliers ADD COLUMN tin TEXT');
  }

  // Per-line tax code on a sale order / vendor bill line, for mixed-rate documents (some
  // lines vatable, some exempt / zero-rated). The BIR sales / purchase journals, SLSP and
  // 2550M/Q classify per line when any line carries one, else fall back to the document's
  // own tax_code_id. (SCHEMA_VERSION 11)
  const oiCols = db.prepare('PRAGMA table_info(order_items)').all() as { name: string }[];
  if (!oiCols.some((c) => c.name === 'tax_code_id')) {
    db.exec('ALTER TABLE order_items ADD COLUMN tax_code_id INTEGER REFERENCES tax_codes(id) ON DELETE SET NULL');
  }
  const vbiCols = db.prepare('PRAGMA table_info(vendor_bill_items)').all() as { name: string }[];
  if (!vbiCols.some((c) => c.name === 'tax_code_id')) {
    db.exec('ALTER TABLE vendor_bill_items ADD COLUMN tax_code_id INTEGER REFERENCES tax_codes(id) ON DELETE SET NULL');
  }

  // A standard unit cost per item — used to value raw materials into Work in Process and
  // finished goods out of it when a job order is posted to the GL (ACCOUNTING-SYSTEM-PLAN
  // Phase 3b). Editable on the item form; 0 until set. (SCHEMA_VERSION 12)
  const invCols = db.prepare('PRAGMA table_info(inventory_items)').all() as { name: string }[];
  if (!invCols.some((c) => c.name === 'unit_cost')) {
    db.exec('ALTER TABLE inventory_items ADD COLUMN unit_cost REAL NOT NULL DEFAULT 0');
  }

  // Sale orders: `location_id` is where stock ships from, `fulfilled_at` marks that the
  // sale's lines have been drawn down from stock (a firm sale consumes stock and posts
  // COGS once the GL is on — ACCOUNTING-SYSTEM-PLAN Phase 3b). (SCHEMA_VERSION 14)
  const orderCols2 = db.prepare('PRAGMA table_info(orders)').all() as { name: string }[];
  if (!orderCols2.some((c) => c.name === 'location_id')) {
    db.exec('ALTER TABLE orders ADD COLUMN location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL');
  }
  if (!orderCols2.some((c) => c.name === 'fulfilled_at')) {
    db.exec('ALTER TABLE orders ADD COLUMN fulfilled_at TEXT');
  }

  // Backfill chart-of-accounts entries added to DEFAULT_COA after a tenant already ran
  // ledger/setup (Work in Process / Manufacturing Variance at SCHEMA_VERSION 12, Goods
  // Received Not Invoiced at 13). New codes only — never touches an existing account.
  // No-op when the ledger isn't set up yet.
  const haveAccounts = (db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n;
  if (haveAccounts > 0) {
    const idByCode = new Map<string, number>();
    for (const a of db.prepare('SELECT id, code FROM accounts').all() as { id: number; code: string }[]) {
      idByCode.set(a.code, a.id);
    }
    const baseCcy = (db.prepare("SELECT value FROM settings WHERE key = 'accounting_ledger'").get() as { value: string } | undefined);
    let ccy = 'PHP';
    try { ccy = baseCcy ? (JSON.parse(baseCcy.value).base_currency || 'PHP') : 'PHP'; } catch { /* keep PHP */ }
    for (const a of DEFAULT_COA) {
      if (idByCode.has(a.code)) continue;
      const info = db.prepare(
        `INSERT INTO accounts (code, name, root_type, account_type, parent_id, is_group, currency)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(a.code, a.name, a.root_type, a.account_type ?? null,
        a.parent ? idByCode.get(a.parent) ?? null : null, a.is_group ? 1 : 0, ccy);
      idByCode.set(a.code, Number(info.lastInsertRowid));
    }
  }

  // Carry a pre-existing single checklist (settings key `qc_checklist`) into a named row.
  const legacy = getSetting<{ items?: unknown[] } | unknown[]>('qc_checklist');
  const legacyItems = Array.isArray(legacy) ? legacy : (legacy && Array.isArray(legacy.items) ? legacy.items : null);
  if (legacyItems && legacyItems.length) {
    const have = db.prepare('SELECT COUNT(*) AS n FROM qc_checklists').get() as { n: number };
    if (have.n === 0) {
      db.prepare("INSERT INTO qc_checklists (name, items, is_default) VALUES ('Default checklist', ?, 1)")
        .run(JSON.stringify(legacyItems));
    }
  }

  // Product variants (SCHEMA_VERSION 15): variants of the same base product (e.g. "Office
  // Chair" in Red / Blue / Green) stay full, separate inventory_items rows — accurate
  // per-variant stock and their own SKU/BOM/etc — sharing a plain-text `product_group` so
  // the UI can list/filter/pick them together. The variant's own descriptor (color, size,
  // spec) already had a home: the existing `spec` attribute (json attributes.spec),
  // included in inventory search since before this — no change needed there.
  const itemCols2 = db.prepare('PRAGMA table_info(inventory_items)').all() as { name: string }[];
  if (!itemCols2.some((c) => c.name === 'product_group')) {
    db.exec('ALTER TABLE inventory_items ADD COLUMN product_group TEXT');
  }

  // (SCHEMA_VERSION 16) The seeded "HR Payroll Slip" doc_template is insert-only (see
  // seedTemplates()'s own comment) — an install that already has one won't pick up
  // payrollSlipTemplateBody()'s new "Days Absent" row / corrected "Late" label just from a
  // source change. Surgical string replace instead of overwriting the row outright, so an
  // admin's own styling/logo customizations survive — a template that's been edited enough
  // that these exact substrings are gone is left alone rather than guessed at.
  const slipTpl = db.prepare("SELECT id, body FROM doc_templates WHERE name = 'HR Payroll Slip'").get() as
    { id: number; body: string } | undefined;
  if (slipTpl) {
    let body = slipTpl.body;
    let touched = false;
    if (body.includes('>Late / Absences<')) {
      body = body.replace('>Late / Absences<', '>Late<');
      touched = true;
    }
    if (!body.includes('{{days_absent}}') && body.includes('{{days_worked}}')) {
      body = body.replace(
        '<span class="v">{{days_worked}}</span></div>',
        '<span class="v">{{days_worked}}</span></div>\n  <div class="slip-row"><span class="l">Days Absent:</span><span class="v">{{days_absent}}</span></div>'
      );
      touched = true;
    }
    if (touched) db.prepare('UPDATE doc_templates SET body = ?, updated_at = datetime(\'now\') WHERE id = ?').run(body, slipTpl.id);
  }

  // (SCHEMA_VERSION 19) Form actions — a form definition can carry a JSON list of automated
  // actions that fire when a record is created / approved (notify the linked employee, file
  // the rendered form into their 201, email them, feed a no-work range into payroll, …).
  // form_record_action_runs is the per-(record, action) idempotency + audit log so re-saving
  // a record never re-fires an action. See src/form-actions.ts.
  const fdCols2 = db.prepare('PRAGMA table_info(form_definitions)').all() as { name: string }[];
  if (!fdCols2.some((c) => c.name === 'actions')) {
    db.exec("ALTER TABLE form_definitions ADD COLUMN actions TEXT NOT NULL DEFAULT '[]'");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS form_record_action_runs (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      form_record_id INTEGER NOT NULL REFERENCES form_records(id) ON DELETE CASCADE,
      action_type    TEXT NOT NULL,
      status         TEXT NOT NULL,
      detail         TEXT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_form_record_action_runs_record
      ON form_record_action_runs(form_record_id);
  `);
}

/** Read a JSON-encoded setting, or undefined if unset / unparseable. */
export function getSetting<T>(key: string): T | undefined {
  const row = queryOne<{ value: string }>('SELECT value FROM settings WHERE key = ?', key);
  if (!row) return undefined;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return undefined;
  }
}

/** Upsert a setting, JSON-encoding the value. */
export function setSetting(key: string, value: unknown): void {
  run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    key,
    JSON.stringify(value)
  );
}

/**
 * Read-increment-write a named counter in `settings`, returning a zero-padded auto number
 * (e.g. `SO-00001`). Shared by every route that auto-numbers a document — orders, form
 * records, and HR employees — so the counter logic can't drift out of sync between them.
 */
export function nextSequence(key: string, prefix: string, pad = 5): string {
  const next = (getSetting<number>(key) || 0) + 1;
  setSetting(key, next);
  return `${prefix}-${String(next).padStart(pad, '0')}`;
}

function seed(): void {
  const deptCount = (db.prepare('SELECT COUNT(*) AS c FROM departments').get() as { c: number }).c;
  if (deptCount === 0) {
    const insertDept = db.prepare('INSERT INTO departments (name) VALUES (?)');
    for (const name of ['Administration', 'Operations', 'Finance', 'Human Resources', 'IT']) {
      insertDept.run(name);
    }
  }

  const userCount = (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
  if (userCount === 0) {
    const adminDept = db
      .prepare('SELECT id FROM departments WHERE name = ?')
      .get('Administration') as { id: number } | undefined;
    const password = process.env.ADMIN_PASSWORD || 'admin123';
    const hash = bcrypt.hashSync(password, 10);
    db.prepare(
      `INSERT INTO users (username, full_name, password_hash, role, department_id)
       VALUES (?, ?, ?, 'admin', ?)`
    ).run('admin', 'System Administrator', hash, adminDept ? adminDept.id : null);

    if (!process.env.DB_PATH) {
      // Only print credentials for a real server start, not during tests.
      console.log('========================================================');
      console.log('  Default admin account created:');
      console.log('     username: admin');
      console.log(`     password: ${password}`);
      console.log('  >> Log in and change this password immediately. <<');
      console.log('========================================================');
    }
  }

  seedTemplates();
  seedHrPayrollForm();
  seedNoWorkMemoForm();
  seedHrRequestForms();
  seedMemoForms();
  seedCompanyHolidaysForm();
  seedPayrollTables();
  seedTaxCodes();
}

/** Standard PH tax classifications. Idempotent (INSERT OR IGNORE by code). `account_id`
    is filled in at ledger setup (seedPostingRulesFromCoa). */
function seedTaxCodes(): void {
  const rows: [string, string, string, number, string | null][] = [
    ['VAT',     'Output VAT 12%',            'output_vat', 12, null],
    ['VAT-IN',  'Input VAT 12%',             'input_vat',  12, null],
    ['VAT-EX',  'VAT-exempt',                'exempt',      0, null],
    ['VAT-ZR',  'Zero-rated (0%)',           'zero_rated',  0, null],
    ['EWT1',    'Expanded withholding 1%',   'ewt',         1, 'WI010'],
    ['EWT2',    'Expanded withholding 2%',   'ewt',         2, 'WI100'],
    ['EWT5',    'Expanded withholding 5%',   'ewt',         5, 'WI040'],
    ['EWT10',   'Expanded withholding 10%',  'ewt',        10, 'WI070'],
    ['EWT15',   'Expanded withholding 15%',  'ewt',        15, 'WI090'],
  ];
  const ins = db.prepare(
    'INSERT OR IGNORE INTO tax_codes (code, name, kind, rate, atc) VALUES (?, ?, ?, ?, ?)'
  );
  for (const r of rows) ins.run(...r);
}

/** Seed the 2026 PH statutory rate tables if none exist yet. Idempotent per kind so a
    later addition doesn't need a fresh DB. See src/ph-statutory.ts. */
function seedPayrollTables(): void {
  const seeds: Array<{ kind: string; data: unknown }> = [
    { kind: 'sss', data: SSS_2026 },
    { kind: 'philhealth', data: PHILHEALTH_2026 },
    { kind: 'pagibig', data: PAGIBIG_2026 },
    { kind: 'rwt', data: RWT_2026 },
  ];
  const ins = db.prepare(
    `INSERT OR IGNORE INTO payroll_tables (kind, effective_from, data, note)
     VALUES (?, '2026-01-01', ?, 'Seed — 2026 schedule. Verify against the current SSS circular / BIR RMC.')`
  );
  for (const s of seeds) {
    if (!db.prepare('SELECT 1 FROM payroll_tables WHERE kind = ?').get(s.kind)) {
      ins.run(s.kind, JSON.stringify(s.data));
    }
  }
}

/** Seed the "HR Payroll" form definition if no admin has already created one (matching
    what an admin would build via Form Builder) — needed so Time Keeping's "Generate
    Payslips" always has a target form, even on a fresh install. */
function seedHrPayrollForm(): void {
  const existing = db.prepare("SELECT id, fields FROM form_definitions WHERE slug = 'hr_payroll'").get() as
    { id: number; fields: string } | undefined;
  if (existing) {
    // Touch up an install that already had hr_payroll seeded: employee_name became an
    // 'employee' dropdown field, and a 'withholding_tax' field was added (auto-computed
    // BIR withholding — see src/ph-statutory.ts). Keep old and new installs consistent.
    try {
      const fields = JSON.parse(existing.fields) as { key: string; label?: string; type: string }[];
      let touched = false;
      const nameField = fields.find((f) => f.key === 'employee_name');
      if (nameField && nameField.type !== 'employee') { nameField.type = 'employee'; touched = true; }
      if (!fields.some((f) => f.key === 'withholding_tax')) {
        const at = fields.findIndex((f) => f.key === 'pagibig');
        const wt = { key: 'withholding_tax', label: 'Withholding Tax', type: 'number', required: false, options: [], default: '' };
        fields.splice(at >= 0 ? at + 1 : fields.length, 0, wt);
        touched = true;
      }
      // days_absent (informational — see hr-payroll-compute.ts) added 2026-09-01, plus fixing
      // late_absences' label: it never held an absence figure, only the late-arrival deduction.
      if (!fields.some((f) => f.key === 'days_absent')) {
        const at = fields.findIndex((f) => f.key === 'days_worked');
        const da = { key: 'days_absent', label: 'Days Absent', type: 'number', required: false, options: [], default: '' };
        fields.splice(at >= 0 ? at + 1 : fields.length, 0, da);
        touched = true;
      }
      const lateField = fields.find((f) => f.key === 'late_absences');
      if (lateField && lateField.label !== 'Late') { lateField.label = 'Late'; touched = true; }
      if (touched) db.prepare('UPDATE form_definitions SET fields = ? WHERE id = ?').run(JSON.stringify(fields), existing.id);
    } catch { /* leave as-is if the stored fields are somehow unparseable */ }
    return;
  }
  const textField = (key: string, label: string, required = false) =>
    ({ key, label, type: 'text', required, options: [], default: '' });
  const numField = (key: string, label: string) =>
    ({ key, label, type: 'number', required: false, options: [], default: '' });
  const fields = [
    { key: 'employee_name', label: 'Employee Name', type: 'employee', required: true, options: [], default: '' },
    textField('dept_position', 'Dept./Position'),
    textField('payroll_period', 'Payroll Period'),
    { key: 'pay_date', label: 'Pay Date', type: 'date', required: false, options: [], default: '' },
    numField('daily_rate', 'Daily Rate'),
    numField('days_worked', 'Days Worked'),
    numField('days_absent', 'Days Absent'),
    numField('ot_hours', 'OT Hours'),
    numField('ot_rate_hour', 'OT Rate/Hour'),
    numField('basic_salary', 'Basic Salary'),
    numField('overtime_pay', 'Overtime Pay'),
    numField('undertime_pay', 'Undertime Pay'),
    numField('holiday_pay', 'Holiday Pay'),
    numField('special_holiday_30', 'Special Holiday 30%'),
    numField('rest_day_ot', 'Rest Day OT'),
    numField('total_earnings', 'Total Earnings'),
    numField('sss', 'SSS'),
    numField('philhealth', 'PhilHealth'),
    numField('pagibig', 'Pag-IBIG'),
    numField('withholding_tax', 'Withholding Tax'),
    numField('cash_advance', 'Cash Advance'),
    // Key stays late_absences for backward compat (GL posting, CSV import, tests all read it)
    // but the label is deliberately just "Late" — it has only ever held the late-arrival peso
    // deduction, never an absence figure (see days_absent above, and the field's own comment
    // in src/hr-payroll-compute.ts).
    numField('late_absences', 'Late'),
    numField('total_deductions', 'Total Deductions'),
    numField('net_pay', 'Net Pay'),
  ];
  db.prepare(
    `INSERT INTO form_definitions (name, slug, number_prefix, icon, fields, scope)
     VALUES ('HR Payroll', 'hr_payroll', 'PAY', 'sheet', ?, 'hr')`
  ).run(JSON.stringify(fields));
}

/** Item 2: "add Holidays and paid/unpaid work cancellations" — the compute engine
    (src/hr-payroll-compute.ts) has always understood a company-wide "No Work Memo" covering
    a date range (holiday, typhoon suspension, equipment failure — paid or unpaid, applies to
    every employee automatically, no per-employee linking), but the `no_work_memo` form was
    only ever created by hand via Form Builder -> Quick Add — never auto-seeded like
    hr_payroll, so a fresh (or this) install has nowhere to actually make one. Auto-seeded now
    so Time Keeping's "Holidays / No Work" button (hr-timekeeping.js) always has a form to
    write records into, the same way Payroll's button always has hr_payroll. */
function seedNoWorkMemoForm(): void {
  const existing = db.prepare("SELECT id, actions FROM form_definitions WHERE slug = 'no_work_memo'").get() as
    { id: number; actions: string } | undefined;
  if (existing) {
    // Touch up an install that had no_work_memo seeded before the apply_no_work action existed
    // (or otherwise lost it) — without this action, the form never actually fed
    // generate-payslips (buildNoWorkResolver/noWorkFormIdsWithAction in hr.routes.ts only pulls
    // from forms carrying it), even though the record list and Daily Time's day-tag display both
    // look fully functional — that display reads no_work_memo records directly by slug, not
    // through this action, so the gap was invisible there. A real bug found live: an UNPAID
    // memo on a date is numerically indistinguishable from a plain absence either way, so it can
    // silently look correct even when never actually applied — only a PAID memo (or one that
    // should override a Regular Holiday's own pay) exposes it.
    try {
      const actions = JSON.parse(existing.actions || '[]') as { type: string }[];
      if (!actions.some((a) => a.type === 'apply_no_work')) {
        actions.push({ type: 'apply_no_work' });
        db.prepare('UPDATE form_definitions SET actions = ? WHERE id = ?').run(JSON.stringify(actions), existing.id);
      }
    } catch { /* leave as-is if the stored actions are somehow unparseable */ }
    return;
  }
  const fields = [
    { key: 'date_from', label: 'Date From', type: 'date', required: true, options: [], default: '' },
    { key: 'date_to', label: 'Date To', type: 'date', required: true, options: [], default: '' },
    { key: 'reason', label: 'Reason', type: 'textarea', required: true, options: [], default: '' },
    { key: 'paid', label: 'Paid?', type: 'select', required: true, options: ['Yes', 'No'], default: 'Yes' },
  ];
  // apply_no_work marks this form as a driver of paid/unpaid no-work days in payroll
  // generation (src/routes/hr.routes.ts generate-payslips). Any form carrying this action
  // plus date_from/date_to/paid fields feeds the same engine — no_work_memo is just the
  // pre-seeded one.
  const actions = [{ type: 'apply_no_work' }];
  db.prepare(
    `INSERT INTO form_definitions (name, slug, number_prefix, icon, fields, scope, actions)
     VALUES ('No Work Memo', 'no_work_memo', 'NW', 'alert', ?, 'hr', ?)`
  ).run(JSON.stringify(fields), JSON.stringify(actions));
}

/** src/hr-payroll-compute.ts has always understood a day linked to an 'overtime_request' /
    'undertime_request' / 'offset_form' / 'holiday_work_request' form (by slug — see
    AttendanceDay.linkedForm), and src/routes/me.routes.ts's REQUEST_SLUGS has always listed all
    four as forms an employee may self-file from mobile — but unlike hr_payroll/no_work_memo/
    company_holiday, none of the four were ever auto-seeded, only ever created by hand via Form
    Builder -> Quick Add. A real gap found live: on an install where nobody happened to create
    them, mobile's "New request" screen (GET /me/request-types, which only lists forms that
    already exist) silently just never offered Overtime/Undertime/Offset/Holiday Work as
    options — no error, they simply weren't there — and HR's Daily Time "link a form" picker had
    nothing to link either. Auto-seeded now, each independently by slug (same as seedMemoForms
    below) so an install that already hand-created one of these isn't touched, only the missing
    ones are added. None carry a special `actions` entry — the compute engine reads them
    directly by slug, not through an action-based lookup like no_work_memo needs. */
function seedHrRequestForms(): void {
  const employeeField = { key: 'employee_name', label: 'Employee', type: 'employee', required: true, options: [], default: '' };
  const dateField = (key: string, label: string) => ({ key, label, type: 'date', required: true, options: [], default: '' });
  const area = (key: string, label: string, required = false) => ({ key, label, type: 'textarea', required, options: [], default: '' });

  const FORMS: Array<{ name: string; slug: string; prefix: string; icon: string; fields: unknown[] }> = [
    {
      name: 'Overtime Request', slug: 'overtime_request', prefix: 'OT', icon: 'history',
      fields: [
        { ...employeeField },
        dateField('work_date', 'Date'),
        // Informational only — actual OT hours/pay are computed from the day's real clock-in/
        // out against the shift (src/hr-payroll-compute.ts); this form only authorizes it.
        { key: 'hours_estimate', label: 'Estimated OT Hours', type: 'number', required: false, options: [], default: '' },
        area('reason', 'Reason', true),
      ],
    },
    {
      name: 'Undertime Request', slug: 'undertime_request', prefix: 'UT', icon: 'history',
      fields: [
        { ...employeeField },
        dateField('work_date', 'Date'),
        // with_pay is read directly by the compute engine — 'Yes' waives the undertime
        // deduction outright (a company-authorized paid early release), 'No' still deducts
        // (documentation only). Same self-selected-at-filing pattern as leave_request's own
        // with_pay field.
        { key: 'with_pay', label: 'With Pay?', type: 'select', required: true, options: ['Yes', 'No'], default: 'No' },
        area('reason', 'Reason', true),
      ],
    },
    {
      name: 'Offset Form', slug: 'offset_form', prefix: 'OFS', icon: 'history',
      fields: [
        { ...employeeField },
        dateField('work_date', 'Date'),
        // new_time_out is read directly by the compute engine as this day's shifted expected
        // end time (arrived late, agreed to leave later instead of a deduction).
        { key: 'new_time_out', label: 'New Time Out', type: 'time', required: true, options: [], default: '' },
        area('reason', 'Reason', true),
      ],
    },
    {
      name: 'Holiday Work Request', slug: 'holiday_work_request', prefix: 'HW', icon: 'calendar',
      fields: [
        { ...employeeField },
        dateField('work_date', 'Date'),
        // holiday_type and hours_worked are both read directly by the compute engine to pay
        // the correct DOLE premium (100% for Regular, 30% for Special Non-Working) on top of
        // the hours actually worked.
        { key: 'holiday_type', label: 'Holiday Type', type: 'select', required: true, options: ['Regular Holiday', 'Special Non-Working Holiday'], default: '' },
        { key: 'hours_worked', label: 'Hours Worked', type: 'number', required: true, options: [], default: '' },
        area('reason', 'Reason'),
      ],
    },
    {
      // Also in REQUEST_SLUGS (me.routes.ts) and read directly by slug in
      // hr-payroll-compute.ts, same as the four above — was missing here even though those
      // weren't, the one payroll-critical request form still only ever created by hand. Field
      // shape matches what installs that already hand-created it are already using.
      name: 'Half Day Request', slug: 'halfday_request', prefix: 'HD', icon: 'history',
      fields: [
        { ...employeeField },
        { key: 'department', label: 'Department', type: 'text', required: false, options: [], default: '' },
        dateField('date', 'Date'),
        // Read directly by the compute engine (halfDayWindow) to judge late/undertime against
        // just this half's own AM/PM window instead of the full shift.
        { key: 'session', label: 'Session', type: 'select', required: true, options: ['Morning (AM)', 'Afternoon (PM)'], default: '' },
        area('reason', 'Reason', true),
        { key: 'approved_by', label: 'Approved By', type: 'text', required: false, options: [], default: '' },
      ],
    },
  ];
  for (const f of FORMS) {
    if (db.prepare('SELECT id FROM form_definitions WHERE slug = ?').get(f.slug)) continue;
    db.prepare(
      `INSERT INTO form_definitions (name, slug, number_prefix, icon, fields, scope)
       VALUES (?, ?, ?, ?, ?, 'hr')`
    ).run(f.name, f.slug, f.prefix, f.icon, JSON.stringify(f.fields));
  }
}

/** Item 4: ready-made HR memo / notice forms. Each is a normal form_definition (so it uses
    the same Data Forms record UI, Form Builder editor and printable doc_template) but ships
    with a curated field set, a default printable template body, and a preset `actions` list
    that fires on record creation — the linked employee is messaged (their login account) and
    the rendered notice is filed into their 201 documents. HR can restyle the template and
    tune the actions in Form Builder afterward. Each seeded independently by slug so adding a
    new one later doesn't need a fresh database. */
function seedMemoForms(): void {
  const employeeField = { key: 'employee_name', label: 'Employee', type: 'employee', required: true, options: [], default: '' };
  const text = (key: string, label: string, required = false) => ({ key, label, type: 'text', required, options: [], default: '' });
  const date = (key: string, label: string, required = false) => ({ key, label, type: 'date', required, options: [], default: '' });
  const area = (key: string, label: string, required = false) => ({ key, label, type: 'textarea', required, options: [], default: '' });

  const NOTIFY = { type: 'notify_employee', run_on: 'create' };
  const FILE201 = { type: 'save_to_201', run_on: 'create' };

  const MEMOS: Array<{
    name: string; slug: string; prefix: string; icon: string;
    fields: unknown[]; actions: unknown[];
  }> = [
    {
      name: 'Notice to Explain (NTE)', slug: 'nte', prefix: 'NTE', icon: 'alert',
      fields: [
        { ...employeeField },
        text('subject', 'Subject / Charge', true),
        date('incident_date', 'Date of Incident', true),
        area('details', 'Details of the Alleged Infraction', true),
        date('response_deadline', 'Written Explanation Due By', true),
      ],
      actions: [NOTIFY, FILE201, { type: 'create_followup_task', due_field: 'response_deadline', title: 'NTE response due' }],
    },
    {
      name: 'General Memo', slug: 'memo_general', prefix: 'MEMO', icon: 'note',
      fields: [
        { ...employeeField, required: false },
        text('subject', 'Subject', true),
        area('body', 'Memo Body', true),
        date('effective_date', 'Effective Date'),
      ],
      actions: [NOTIFY, FILE201],
    },
    {
      name: 'Notice of Disciplinary Action', slug: 'disciplinary_action', prefix: 'NODA', icon: 'alert',
      fields: [
        { ...employeeField },
        text('offense', 'Offense', true),
        {
          key: 'penalty', label: 'Penalty', type: 'select', required: true,
          options: ['Verbal Warning', 'Written Warning', 'Suspension', 'Preventive Suspension', 'Dismissal'],
          default: 'Written Warning',
        },
        date('effective_date', 'Effective Date', true),
        area('details', 'Findings / Basis', true),
      ],
      actions: [NOTIFY, FILE201],
    },
    {
      name: 'Return to Work Order', slug: 'return_to_work', prefix: 'RTW', icon: 'calendar',
      fields: [
        { ...employeeField },
        date('return_date', 'Report Back to Work On', true),
        area('notes', 'Notes / Conditions'),
      ],
      actions: [NOTIFY, FILE201],
    },
    {
      name: 'Incident Report', slug: 'incident_report', prefix: 'IR', icon: 'alert',
      fields: [
        { ...employeeField, label: 'Employee Involved', required: false },
        date('incident_date', 'Date of Incident', true),
        text('location', 'Location'),
        area('description', 'What Happened', true),
        text('witnesses', 'Witnesses'),
      ],
      actions: [FILE201],
    },
    {
      name: 'Certificate of Employment', slug: 'coe', prefix: 'COE', icon: 'file',
      fields: [
        { ...employeeField },
        text('position', 'Position'),
        date('date_started', 'Date Started'),
        date('date_ended', 'Date Ended (blank if still employed)'),
        text('purpose', 'Purpose'),
      ],
      actions: [NOTIFY, FILE201],
    },
  ];

  const insertDef = db.prepare(
    `INSERT INTO form_definitions (name, slug, number_prefix, icon, fields, scope, actions, template_id)
     VALUES (?, ?, ?, ?, ?, 'hr', ?, ?)`
  );
  const insertTpl = db.prepare(
    "INSERT INTO doc_templates (name, type, body) VALUES (?, 'generic', ?)"
  );
  for (const m of MEMOS) {
    if (db.prepare('SELECT id FROM form_definitions WHERE slug = ?').get(m.slug)) continue;
    const tplId = Number(insertTpl.run(m.name, memoTemplateBody(m.name, m.fields as Array<{ key: string; label: string }>)).lastInsertRowid);
    insertDef.run(m.name, m.slug, m.prefix, m.icon, JSON.stringify(m.fields), JSON.stringify(m.actions), tplId);
  }
}

/** A plain, restyleable printable body for a seeded memo — company letterhead, a heading,
    then one labelled line per form field ({{key}} placeholders the form-record print flow
    and src/form-actions.ts both substitute). Deliberately minimal; HR edits it in the doc
    editor from Form Builder. */
function memoTemplateBody(title: string, fields: Array<{ key: string; label: string }>): string {
  const rows = fields
    .map((f) => `  <div class="mm-row"><span class="mm-l">${f.label}</span><span class="mm-v">{{${f.key}}}</span></div>`)
    .join('\n');
  return `<style>
  .memo { font-family: Arial, Helvetica, sans-serif; font-size: 12px; color: #111; max-width: 720px; margin: 0 auto; }
  .memo h1 { font-size: 15px; text-align: center; letter-spacing: .04em; margin: 0 0 2px; }
  .memo .co { text-align: center; color: #555; font-size: 11px; margin-bottom: 16px; }
  .memo h2 { font-size: 13px; border-bottom: 2px solid #222; padding-bottom: 3px; margin: 14px 0 10px; }
  .memo .mm-row { display: flex; gap: 12px; padding: 4px 2px; border-bottom: 1px dotted #ccc; }
  .memo .mm-l { width: 200px; color: #444; font-weight: 600; }
  .memo .mm-v { flex: 1; white-space: pre-wrap; }
  .memo .sig { display: flex; justify-content: space-between; margin-top: 40px; }
  .memo .sig div { width: 46%; border-top: 1px solid #666; padding-top: 3px; text-align: center; font-size: 11px; color: #444; }
</style>
<div class="memo">
  <h1>{{company.name}}</h1>
  <div class="co">{{company.address}}</div>
  <h2>${title.toUpperCase()}</h2>
  <div class="mm-row"><span class="mm-l">Reference No.</span><span class="mm-v">{{number}}</span></div>
  <div class="mm-row"><span class="mm-l">Date Issued</span><span class="mm-v">{{today}}</span></div>
${rows}
  <div class="sig">
    <div>Issued by (HR)</div>
    <div>Received by (Employee)</div>
  </div>
</div>`;
}

/** The PH public-holiday calendar HR marks pay premiums against — applies to every employee
    automatically for the date (see src/hr-payroll-compute.ts), same "company-wide, no
    per-employee linking" shape as No Work Memo, but with the specific Regular/Special
    Non-Working/Special Working distinction the law actually pays differently (DOLE Labor
    Advisory No. 12-25, 2026: 200%/130% worked, 100%/no-pay unworked). Seeded with the
    statutorily-fixed annual dates (Labor Code Art. 94 regular holidays; RA 9256 Ninoy Aquino
    Day; the Immaculate Conception feast) plus 2026's confirmed movable dates (Proclamation
    No. 1006) — a starting reference, not a permanent source of truth: Eid'l Fitr/Eid'l Adha
    and any year-specific additions are proclaimed separately and need adding by hand, and this
    whole list should be checked against the actual yearly proclamation. Admin can edit/add/
    delete freely via the same generic form-records UI No Work Memo already uses. */
function seedCompanyHolidaysForm(): void {
  if (db.prepare("SELECT id FROM form_definitions WHERE slug = 'company_holiday'").get()) return;
  const fields = [
    { key: 'date', label: 'Date', type: 'date', required: true, options: [], default: '' },
    { key: 'name', label: 'Holiday Name', type: 'text', required: true, options: [], default: '' },
    {
      key: 'type', label: 'Type', type: 'select', required: true,
      options: ['Regular Holiday', 'Special Non-Working Holiday', 'Special Working Holiday'],
      default: 'Regular Holiday',
    },
  ];
  const formId = Number(
    db.prepare(
      `INSERT INTO form_definitions (name, slug, number_prefix, icon, fields, scope)
       VALUES ('Company Holidays', 'company_holiday', 'HOL', 'calendar', ?, 'hr')`
    ).run(JSON.stringify(fields)).lastInsertRowid
  );
  const REGULAR = 'Regular Holiday';
  const SPECIAL = 'Special Non-Working Holiday';
  const seedRows: Array<[string, string, string]> = [
    ['2026-01-01', "New Year's Day", REGULAR],
    ['2026-04-02', 'Maundy Thursday', REGULAR],
    ['2026-04-03', 'Good Friday', REGULAR],
    ['2026-04-09', 'Araw ng Kagitingan', REGULAR],
    ['2026-05-01', 'Labor Day', REGULAR],
    ['2026-06-12', 'Independence Day', REGULAR],
    ['2026-08-31', 'National Heroes Day', REGULAR],
    ['2026-11-30', 'Bonifacio Day', REGULAR],
    ['2026-12-25', 'Christmas Day', REGULAR],
    ['2026-12-30', 'Rizal Day', REGULAR],
    ['2026-02-17', 'Chinese New Year', SPECIAL],
    ['2026-04-04', 'Black Saturday', SPECIAL],
    ['2026-08-21', 'Ninoy Aquino Day', SPECIAL],
    ['2026-11-02', "All Souls' Day", SPECIAL],
    ['2026-12-08', 'Feast of the Immaculate Conception', SPECIAL],
    ['2026-12-24', 'Christmas Eve', SPECIAL],
  ];
  const insertRecord = db.prepare(
    `INSERT INTO form_records (form_def_id, number, data, status) VALUES (?, ?, ?, 'approved')`
  );
  for (const [date, name, type] of seedRows) {
    const number = nextSequence(`form_seq_${formId}`, 'HOL');
    insertRecord.run(formId, number, JSON.stringify({ date, name, type }));
  }
}

/** Seed default templates — each checked independently so adding a new default later
    doesn't require a fresh database (unlike form_definitions, templates are meant to
    ship with sensible defaults; see docs/ARCHITECTURE.md). */
function seedTemplates(): void {
  const insert = db.prepare('INSERT INTO doc_templates (name, type, body) VALUES (?, ?, ?)');
  const hasType = (type: string) =>
    (db.prepare('SELECT COUNT(*) AS c FROM doc_templates WHERE type = ?').get(type) as { c: number }).c > 0;
  if (!hasType('sale') && !hasType('job') && !hasType('purchase')) {
    insert.run('Sale Order', 'sale', orderTemplateBody('SALES ORDER'));
    insert.run('Job Order', 'job', orderTemplateBody('JOB ORDER'));
    insert.run('Purchase Request', 'purchase', orderTemplateBody('PURCHASE REQUEST'));
  }
  if (!db.prepare('SELECT id FROM doc_templates WHERE name = ?').get('HR Payroll Slip')) {
    insert.run('HR Payroll Slip', 'generic', payrollSlipTemplateBody());
  }
  if (!db.prepare('SELECT id FROM doc_templates WHERE name = ?').get('Employee ID Card')) {
    insert.run('Employee ID Card', 'generic', employeeIdTemplateBody());
  }
  if (!db.prepare('SELECT id FROM doc_templates WHERE name = ?').get('BIR 2316')) {
    insert.run('BIR 2316', 'generic', bir2316TemplateBody());
  }
}

/** Printable BIR-2316-style Certificate of Compensation Payment / Tax Withheld.
    Rendered against {company, employee, f (pre-formatted figures), year, today} — see
    bir2316Modal() in hr-timekeeping.js. A worksheet layout, not the pixel-exact BIR form. */
function bir2316TemplateBody(): string {
  return `<style>
  .f2316 { font-family: Arial, sans-serif; font-size: 11px; color: #111; max-width: 720px; margin: 0 auto; }
  .f2316 h2 { text-align: center; font-size: 14px; margin: 0 0 2px; letter-spacing: .04em; }
  .f2316 .sub { text-align: center; font-size: 10px; color: #555; margin-bottom: 10px; }
  .f2316 .part { font-weight: 700; background: #eef4fb; border: 1px solid #c6d4e6; padding: 3px 6px; margin: 10px 0 4px; }
  .f2316 .row { display: flex; justify-content: space-between; gap: 12px; padding: 2px 4px; border-bottom: 1px dotted #ccc; }
  .f2316 .row .l { color: #333; }
  .f2316 .row .v { font-weight: 600; text-align: right; white-space: nowrap; }
  .f2316 .tot { border-bottom: 2px solid #222; font-weight: 700; }
  .f2316 .grand { display: flex; justify-content: space-between; font-size: 12px; font-weight: 800;
    border-top: 2px solid #222; border-bottom: 2px solid #222; padding: 4px; margin-top: 6px; }
  .f2316 .sig { display: flex; justify-content: space-between; margin-top: 26px; font-size: 10px; color: #444; }
  .f2316 .sig div { width: 46%; border-top: 1px solid #666; padding-top: 3px; text-align: center; }
  .f2316 .note { font-size: 9px; color: #777; margin-top: 14px; }
</style>
<div class="f2316">
  <h2>CERTIFICATE OF COMPENSATION PAYMENT / TAX WITHHELD</h2>
  <div class="sub">BIR Form 2316 &mdash; For the Year {{year}} &nbsp;&middot;&nbsp; (worksheet generated {{today}})</div>

  <div class="part">Part I &mdash; Employee</div>
  <div class="row"><span class="l">Name</span><span class="v">{{employee.name}}</span></div>
  <div class="row"><span class="l">TIN</span><span class="v">{{employee.tin_no}}</span></div>
  <div class="row"><span class="l">Employee No.</span><span class="v">{{employee.employee_no}}</span></div>
  <div class="row"><span class="l">Position / Department</span><span class="v">{{employee.position}} / {{employee.department}}</span></div>
  <div class="row"><span class="l">SSS / PhilHealth / Pag-IBIG</span><span class="v">{{employee.sss_no}} / {{employee.philhealth_no}} / {{employee.pagibig_no}}</span></div>

  <div class="part">Part II &mdash; Employer</div>
  <div class="row"><span class="l">Name</span><span class="v">{{company.name}}</span></div>
  <div class="row"><span class="l">TIN</span><span class="v">{{company.tin}}</span></div>
  <div class="row"><span class="l">Registered address</span><span class="v">{{company.address}}</span></div>

  <div class="part">Part IV-B &mdash; Non-Taxable / Exempt Compensation Income</div>
  <div class="row"><span class="l">SSS, PhilHealth, Pag-IBIG &amp; union dues (employee share)</span><span class="v">{{f.sss_gsis_phic_pagibig_union}}</span></div>
  <div class="row"><span class="l">13th-month pay and other benefits (max {{f.thirteenth_month_ceiling}})</span><span class="v">{{f.thirteenth_month_and_other_benefits}}</span></div>
  <div class="row"><span class="l">De-minimis benefits</span><span class="v">{{f.de_minimis}}</span></div>
  <div class="row tot"><span class="l">Total Non-Taxable / Exempt Compensation Income</span><span class="v">{{f.total_non_taxable}}</span></div>

  <div class="part">Part IV-B &mdash; Taxable Compensation Income (present employer)</div>
  <div class="row"><span class="l">Basic salary</span><span class="v">{{f.basic_salary}}</span></div>
  <div class="row"><span class="l">Overtime pay</span><span class="v">{{f.overtime_pay}}</span></div>
  <div class="row"><span class="l">Holiday pay</span><span class="v">{{f.holiday_pay}}</span></div>
  <div class="row"><span class="l">Night differential / rest-day / other</span><span class="v">{{f.night_diff_and_other}}</span></div>
  <div class="row"><span class="l">Taxable 13th-month &amp; other benefits (excess over ceiling)</span><span class="v">{{f.taxable_13th_month_excess}}</span></div>

  <div class="part">Part IV-A &mdash; Summary</div>
  <div class="row"><span class="l">Gross Compensation Income (present employer)</span><span class="v">{{f.gross_compensation}}</span></div>
  <div class="row"><span class="l">Less: Total Non-Taxable / Exempt</span><span class="v">{{f.total_non_taxable}}</span></div>
  <div class="row"><span class="l">Taxable Compensation Income (present employer)</span><span class="v">{{f.taxable_compensation_present}}</span></div>
  <div class="row"><span class="l">Add: Taxable Compensation (previous employer)</span><span class="v">{{f.taxable_compensation_previous}}</span></div>
  <div class="row tot"><span class="l">Gross Taxable Compensation Income</span><span class="v">{{f.gross_taxable_compensation}}</span></div>
  <div class="row"><span class="l">Tax Due</span><span class="v">{{f.tax_due}}</span></div>
  <div class="row"><span class="l">Amount of Taxes Withheld &mdash; present employer</span><span class="v">{{f.tax_withheld_present}}</span></div>
  <div class="row"><span class="l">Amount of Taxes Withheld &mdash; previous employer</span><span class="v">{{f.tax_withheld_previous}}</span></div>
  <div class="row tot"><span class="l">Total Amount of Taxes Withheld</span><span class="v">{{f.total_tax_withheld}}</span></div>
  <div class="grand"><span>{{f.over_withheld_label}}</span><span>{{f.over_withheld_abs}}</span></div>

  <div class="sig">
    <div>{{employee.name}}<br/><span style="font-size:9px">Employee signature over printed name</span></div>
    <div>{{company.name}}<br/><span style="font-size:9px">Authorized employer representative</span></div>
  </div>
  <p class="note">Worksheet computed from {{f.payslip_count}} payslip(s) for {{year}}. De-minimis, allowances and
    previous-employer amounts are not tracked in payroll &mdash; verify and complete them, and validate against the
    official BIR form before issuing or filing.</p>
</div>`;
}

/** Default printable HTML for one virtual employee ID — CR-80 card size (~85.6mm x 54mm),
    **front and back side by side** on one landscape page (85.6*2 + 6mm gap = 177.2mm x 54mm,
    set as the page's own @page size so it opens already sized correctly in the editor) so both
    halves print together, ready to cut out and glue/laminate back-to-back. A ready-to-print
    starting design (header band, photo + name/role, footer band on the front; return-if-lost
    note + signature line on the back) meant to be edited in place (recolor, resize, swap which
    side has the photo, flip to a portrait card via the Layout tab's Width/Height swap, …) rather
    than built from scratch. Rendered against {company, employee, today} — see generateId() in
    hr-employees.js. */
function employeeIdTemplateBody(): string {
  return `<style data-docpage>@page{size:177.2mm 54mm;margin:3mm}</style>
<style>
  .idcard-page { display: flex; gap: 6mm; }
  .idcard { width: 85.6mm; height: 54mm; border-radius: 3mm; overflow: hidden; box-sizing: border-box;
    font-family: Arial, sans-serif; display: flex; flex-direction: column; box-shadow: 0 0 0 1px #ccc; }
  .idcard-head { background: #16243d; color: #fff; text-align: center; padding: 2.5mm 2mm 2mm; }
  .idcard-co { font-weight: 800; font-size: 10px; letter-spacing: 0.05em; text-transform: uppercase; }
  .idcard-tag { font-size: 6.5px; letter-spacing: 0.06em; opacity: 0.75; margin-top: 0.8mm; text-transform: uppercase; }
  .idcard-body { flex: 1; display: flex; align-items: center; gap: 3mm; padding: 3mm 4mm; min-height: 0; }
  .idcard-photo { width: 20mm; height: 20mm; border-radius: 50%; object-fit: cover; border: 2px solid #16243d; flex-shrink: 0; }
  .idcard-info { flex: 1; min-width: 0; }
  .idcard-name { font-weight: 800; font-size: 12px; color: #16243d; line-height: 1.25; }
  .idcard-role { font-size: 9.5px; color: #333; margin-top: 0.5mm; }
  .idcard-dept { font-size: 8.5px; color: #666; }
  .idcard-foot { background: #eef4fb; border-top: 1px solid #c6d4e6; text-align: center;
    padding: 1.3mm; font-size: 7.5px; color: #5d6b84; letter-spacing: 0.03em; }
  .idcard-back-body { flex: 1; padding: 3mm 4mm; font-size: 8px; color: #333; line-height: 1.5; }
  .idcard-back-body p { margin: 0 0 1.5mm; }
  .idcard-back-label { font-weight: 700; color: #16243d; }
  .idcard-sig { margin-top: 4mm; border-top: 1px solid #999; padding-top: 1mm; font-size: 7px;
    color: #666; text-align: center; }
</style>
<div class="idcard-page">
  <div class="idcard idcard-front">
    <div class="idcard-head">
      <div class="idcard-co">{{company.name}}</div>
      <div class="idcard-tag">Employee Identification Card</div>
    </div>
    <div class="idcard-body">
      <img class="idcard-photo" src="{{employee.photo}}" alt="" />
      <div class="idcard-info">
        <div class="idcard-name">{{employee.name}}</div>
        <div class="idcard-role">{{employee.position}}</div>
        <div class="idcard-dept">{{employee.department}}</div>
      </div>
    </div>
    <div class="idcard-foot">{{employee.employee_no}} &middot; Issued {{today}}</div>
  </div>
  <div class="idcard idcard-back">
    <div class="idcard-head">
      <div class="idcard-co">{{company.name}}</div>
      <div class="idcard-tag">If found, please return to</div>
    </div>
    <div class="idcard-back-body">
      <p><span class="idcard-back-label">{{company.name}}</span></p>
      <p>{{company.address}}</p>
      <p>{{company.phone}}</p>
      <div class="idcard-sig">Employee Signature</div>
    </div>
    <div class="idcard-foot">This card remains the property of {{company.name}}</div>
  </div>
</div>`;
}

/** Default printable HTML for one HR Payroll slip (self-contained: embeds its own
    <style>, since it isn't built from the shared order-document CSS). Rendered against
    a flat context matching the HR Payroll form's fields (see hr-payroll-print.js). */
function payrollSlipTemplateBody(): string {
  return `<style>
  .slip { border: 1px solid #222; padding: 8px 10px; font-size: 11px; }
  .slip h3 { text-align: center; margin: 0 0 8px; font-size: 12.5px; letter-spacing: 0.04em; }
  .slip-row { display: flex; justify-content: space-between; gap: 6px; margin-bottom: 3px; }
  .slip-row .l { color: #333; }
  .slip-row .v { font-weight: 600; text-align: right; }
  .slip-cols { display: flex; gap: 10px; margin-top: 6px; }
  .slip-col { flex: 1; min-width: 0; }
  .slip-col h4 { margin: 0 0 4px; font-size: 10.5px; border-bottom: 1px solid #999; padding-bottom: 2px; }
  .slip-line { display: flex; justify-content: space-between; gap: 4px; font-size: 10.5px; margin-bottom: 2px; }
  .slip-total { display: flex; justify-content: space-between; font-weight: 700; border-top: 1px solid #999; margin-top: 4px; padding-top: 3px; font-size: 10.5px; }
  .slip-net { display: flex; justify-content: space-between; font-weight: 700; font-size: 13px; border-top: 2px solid #222; border-bottom: 2px solid #222; margin-top: 8px; padding: 4px 0; }
  .slip-sig { display: flex; justify-content: space-between; margin-top: 18px; font-size: 9.5px; color: #555; }
  .slip-sig div { text-align: center; width: 46%; border-top: 1px solid #666; padding-top: 3px; }
</style>
<div class="slip">
  <h3>EMPLOYEE PAYROLL SLIP</h3>
  <div class="slip-row"><span class="l">Employee Name:</span><span class="v">{{employee_name}}</span></div>
  <div class="slip-row"><span class="l">Dept./Position:</span><span class="v">{{dept_position}}</span></div>
  <div class="slip-row"><span class="l">Payroll Period:</span><span class="v">{{payroll_period}}</span></div>
  <div class="slip-row"><span class="l">Pay Date:</span><span class="v">{{pay_date}}</span></div>
  <div class="slip-row"><span class="l">Daily Rate:</span><span class="v">{{daily_rate}}</span></div>
  <div class="slip-row"><span class="l">Days Worked:</span><span class="v">{{days_worked}}</span></div>
  <div class="slip-row"><span class="l">Days Absent:</span><span class="v">{{days_absent}}</span></div>
  <div class="slip-row"><span class="l">OT Hours:</span><span class="v">{{ot_hours}}</span></div>
  <div class="slip-row"><span class="l">OT Rate/Hour:</span><span class="v">{{ot_rate_hour}}</span></div>
  <div class="slip-cols">
    <div class="slip-col">
      <h4>EARNINGS</h4>
      <div class="slip-line"><span>Basic Salary</span><span>{{basic_salary}}</span></div>
      <div class="slip-line"><span>Overtime Pay</span><span>{{overtime_pay}}</span></div>
      <div class="slip-line"><span>Undertime</span><span>{{undertime_pay}}</span></div>
      <div class="slip-line"><span>Holiday Pay</span><span>{{holiday_pay}}</span></div>
      <div class="slip-line"><span>Special Holiday 30%</span><span>{{special_holiday_30}}</span></div>
      <div class="slip-line"><span>Rest Day OT</span><span>{{rest_day_ot}}</span></div>
      <div class="slip-total"><span>Total Earnings</span><span>{{total_earnings}}</span></div>
    </div>
    <div class="slip-col">
      <h4>DEDUCTIONS</h4>
      <div class="slip-line"><span>SSS</span><span>{{sss}}</span></div>
      <div class="slip-line"><span>PhilHealth</span><span>{{philhealth}}</span></div>
      <div class="slip-line"><span>Pag-IBIG</span><span>{{pagibig}}</span></div>
      <div class="slip-line"><span>Withholding Tax</span><span>{{withholding_tax}}</span></div>
      <div class="slip-line"><span>Cash Advance</span><span>{{cash_advance}}</span></div>
      <div class="slip-line"><span>Late</span><span>{{late_absences}}</span></div>
      <div class="slip-total"><span>Total Deductions</span><span>{{total_deductions}}</span></div>
    </div>
  </div>
  <div class="slip-net"><span>NET PAY</span><span>{{net_pay}}</span></div>
  <div class="slip-sig">
    <div>Employee Signature</div>
    <div>Authorized Signature</div>
  </div>
</div>`;
}

/** Default printable HTML for an order document (uses {{variables}} / {{#items}}). */
function orderTemplateBody(title: string): string {
  return `<div class="doc">
  <header class="doc-head">
    <div class="doc-company">
      <h1>{{company.name}}</h1>
      <div>{{company.address}}</div>
      <div>{{company.phone}}{{#if company.email}} · {{company.email}}{{/if}}</div>
    </div>
    <div class="doc-meta">
      <h2>${title}</h2>
      <div>No: <strong>{{order.no}}</strong></div>
      <div>Date: {{order.date}}</div>
      <div>Status: {{order.status}}</div>
    </div>
  </header>
  <section class="doc-parties">
    <div><span class="muted">Customer</span><br/><strong>{{order.customer_name}}</strong></div>
    <div>{{order.customer_contact}}</div>
  </section>
  <table class="doc-table">
    <thead><tr><th>#</th><th>Item</th><th>SKU</th><th class="r">Qty</th><th>Unit</th><th class="r">Unit Price</th><th class="r">Total</th></tr></thead>
    <tbody>
      {{#items}}<tr><td>{{index}}</td><td>{{name}}{{#if description}}<div class="muted">{{description}}</div>{{/if}}</td><td>{{sku}}</td><td class="r">{{quantity}}</td><td>{{unit}}</td><td class="r">{{unit_price}}</td><td class="r">{{line_total}}</td></tr>{{/items}}
    </tbody>
  </table>
  <section class="doc-totals">
    <div>Subtotal: <strong>{{order.subtotal}}</strong></div>
    {{#if order.tax_amount}}<div>Tax ({{order.tax_percent}}%): {{order.tax_amount}}</div>{{/if}}
    <div class="grand">TOTAL: {{order.currency}} {{order.total}}</div>
  </section>
  {{#if order.notes}}<section class="doc-notes"><span class="muted">Notes</span><br/>{{order.notes}}</section>{{/if}}
  <footer class="doc-foot">Prepared by {{user.name}} · {{today}}</footer>
</div>`;
}

/** How long the app-wide activity_log is kept. Rows older than this are swept on the
    housekeeping timer; admins can still prune earlier by hand via DELETE /api/activity. */
export const ACTIVITY_LOG_RETENTION_DAYS = 31;

export function cleanupSessions(): void {
  // Runs on a timer, outside any request — sweep every open tenant connection.
  for (const slug of registry.keys()) {
    withTenant(slug, () => {
      db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
      // Idempotency keys are only useful for as long as a client might still be retrying;
      // a week is far more than enough for a flaky-LAN offline queue.
      db.prepare("DELETE FROM idempotency_keys WHERE created_at < datetime('now', '-7 days')").run();
      db.prepare("DELETE FROM password_resets WHERE used = 1 OR expires_at < datetime('now')").run();
      // Cap the audit trail at roughly a month so it can't grow without bound.
      db.prepare(
        `DELETE FROM activity_log WHERE created_at < datetime('now', '-${ACTIVITY_LOG_RETENTION_DAYS} days')`
      ).run();
    });
  }
}

export function newToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

function ensureUploadDir(): void {
  if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  }
}

/** The upload folder for the current request's tenant — `UPLOAD_DIR` for the `default`
    tenant, `UPLOAD_DIR/<slug>` otherwise. Created on demand. All file read/write/delete
    for stored uploads (item images, form files, 201 docs, AI reports) goes through this
    so one tenant's files can be quota'd, exported, or deleted as a unit. */
export function uploadDir(slug?: string): string {
  const s = slug ?? tenantStore.getStore()?.slug ?? DEFAULT_TENANT;
  const dir = s === DEFAULT_TENANT ? UPLOAD_DIR : path.join(UPLOAD_DIR, s);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}
