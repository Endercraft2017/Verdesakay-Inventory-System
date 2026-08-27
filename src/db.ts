/**
 * Database connection, schema creation, and first-run seeding.
 * Uses Node's built-in SQLite (node:sqlite). The DB file path can be overridden with
 * the DB_PATH env var so tests run against a throwaway database.
 */
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';

const ROOT = path.join(import.meta.dirname, '..');

export const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'data.db');
export const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(ROOT, 'uploads');

export const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

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

export function init(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS departments (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS users (
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

    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS inventory_items (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL,
      sku           TEXT UNIQUE,
      category      TEXT,
      department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
      quantity      INTEGER NOT NULL DEFAULT 0,
      unit          TEXT DEFAULT 'pcs',
      min_quantity  INTEGER NOT NULL DEFAULT 0,
      location      TEXT,
      notes         TEXT,
      attributes    TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
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
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title      TEXT NOT NULL,
      due_date   TEXT,
      done       INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS bookmarks (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label      TEXT NOT NULL,
      route      TEXT NOT NULL,
      params     TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

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
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
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
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_notes_user ON notes(user_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id);
    CREATE INDEX IF NOT EXISTS idx_bookmarks_user ON bookmarks(user_id);
    CREATE INDEX IF NOT EXISTS idx_orders_type ON orders(type);
    CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
    CREATE INDEX IF NOT EXISTS idx_employees_dept ON employees(department_id);
    CREATE INDEX IF NOT EXISTS idx_attendance_period ON attendance_records(period_id);
    CREATE INDEX IF NOT EXISTS idx_attendance_employee ON attendance_records(employee_id);
    CREATE INDEX IF NOT EXISTS idx_employee_documents_employee ON employee_documents(employee_id);
  `);

  migrate();
  ensureUploadDir();
  seed();
}

/** Idempotent schema upgrades for databases created before a column existed. */
function migrate(): void {
  const itemCols = db.prepare('PRAGMA table_info(inventory_items)').all() as { name: string }[];
  if (!itemCols.some((c) => c.name === 'attributes')) {
    db.exec('ALTER TABLE inventory_items ADD COLUMN attributes TEXT');
  }

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
}

/** Seed the "HR Payroll" form definition if no admin has already created one (matching
    what an admin would build via Form Builder) — needed so Time Keeping's "Generate
    Payslips" always has a target form, even on a fresh install. */
function seedHrPayrollForm(): void {
  if (db.prepare("SELECT id FROM form_definitions WHERE slug = 'hr_payroll'").get()) return;
  const textField = (key: string, label: string, required = false) =>
    ({ key, label, type: 'text', required, options: [], default: '' });
  const numField = (key: string, label: string) =>
    ({ key, label, type: 'number', required: false, options: [], default: '' });
  const fields = [
    textField('employee_name', 'Employee Name', true),
    textField('dept_position', 'Dept./Position'),
    textField('payroll_period', 'Payroll Period'),
    { key: 'pay_date', label: 'Pay Date', type: 'date', required: false, options: [], default: '' },
    numField('daily_rate', 'Daily Rate'),
    numField('days_worked', 'Days Worked'),
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
    numField('cash_advance', 'Cash Advance'),
    numField('late_absences', 'Late / Absences'),
    numField('total_deductions', 'Total Deductions'),
    numField('net_pay', 'Net Pay'),
  ];
  db.prepare(
    `INSERT INTO form_definitions (name, slug, number_prefix, icon, fields, scope)
     VALUES ('HR Payroll', 'hr_payroll', 'PAY', 'sheet', ?, 'hr')`
  ).run(JSON.stringify(fields));
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
      <div class="slip-line"><span>Cash Advance</span><span>{{cash_advance}}</span></div>
      <div class="slip-line"><span>Late / Absences</span><span>{{late_absences}}</span></div>
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

export function cleanupSessions(): void {
  db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
}

export function newToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

function ensureUploadDir(): void {
  if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  }
}
