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
import { createRequire } from 'node:module';
const {field:printFormField}=createRequire(import.meta.url)('../../public/js/lib/form-print.js') as {field:(field:{key:string;label:string;type?:string;source?:string;format?:string;currency?:string},classes:{row:string;label:string;value:string})=>string};
import { createDocumentDefaultsSchema, initializeDocumentDefaults } from './document-defaults';
import { createFormTemplateSchema } from './form-template-schema';
import { createFormHistorySchema } from './form-history-schema';
import { configureFormHistoryConnection } from './form-history-context';
import { createStudioSchema } from './doc-studio-schema';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import { SSS_2026, PHILHEALTH_2026, PAGIBIG_2026, RWT_2026 } from '../modules/payroll/ph-statutory';
import { DEFAULT_COA } from '../modules/accounting/ledger';
import { preMigrationSnapshot, backupDir, mirrorDir } from './backup';
import { BUILTIN_ROLES, ADMIN_ROLE, roleDefaults } from './permissions';
import { syncHooks } from './sync-context';

const ROOT = path.join(import.meta.dirname, '..', '..');

export const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'db', 'data.db');
export const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(ROOT, 'uploads');
/** Where non-default tenant DB files live (`<DATA_DIR>/<slug>.db`). */
export const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'db', 'tenants');
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
  const dbFile = connectionPath(slug);
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const conn = new DatabaseSync(dbFile);
  // Persisted history triggers can run during migration, before history schema setup.
  configureFormHistoryConnection(conn);
  conn.exec('PRAGMA journal_mode = WAL;');
  conn.exec('PRAGMA foreign_keys = ON;');
  return conn;
}

/** Bumped whenever `migrate()` gains a step. A DB already at this version skips the
    (cheap but not free) PRAGMA-probe pass on every cold open. `createSchema()` and
    `seed()` are always safe to re-run (`… IF NOT EXISTS`, count-guarded). */
// 89: bind linked issue closure to an applied count and captured sale-audit evidence.
// 88: structured location/build-state stock counts and supervised resolution.
// 87: record human reviews of historical direct-sale stock-out candidates.
// 86: permit a serialized unit to return once per separate sale shipment.
// 85: mark units sold directly before a trip slip so stock-out is not repeated.
// 84: same-order partial trip manifests and delivery records.
// 83: bind sale-unit and batch allocations to a specific commercial order line.
// 82: per-form Inventory entry grants and access revision.
// 81: courier booking and handoff metadata on existing delivery records.
// 80: connected forms, sales draft links and sync-safe template history IDs.
// 79: preserve exact semi-built batch identity when a bulk package enters finishing.
// 78: trace semi-built packages finished into fully built stock without BOM reissue,
//     and preserve each serialized unit's received cost for that conversion.
// 77: exact batch/location stock, sales allocations, verified counts and return provenance.
// 76: form versions/revisions, archive state, deduction audit and personal views.
// 75: track fully built and semi-built stock separately per item/location and tag job orders.
// 74: keep a commercial CKD line with a frozen physical-component manifest.
// 73: remember an item's preferred storage location even when it has no stock.
// 72: optional five-level inventory location hierarchy.
// 71: link job-order component-shortage purchase drafts so retries and partial receipts
//     create only remaining procurement demand.
// 70: bind JSON idempotency keys to the original request payload.
// 69: freeze job-order QC/QA checklists when the parts kit is released.
// 68: rejected-return disposition and reinspection.
// 67: slip-linked sales returns and the shipped unit-cost snapshot.
// 66: recoverable file bytes for all tenant upload modules.
// 65: durable message attachment bytes.
// 64: checklist notes and linked personal scheduler tasks.
// 63: document studio recovery, linked layouts, built-in defaults and configurable grid gaps.
export const SCHEMA_VERSION = 89; // 20: employees.late_exempt; 21: attendance_records.min_hours_decision;
// 22: HR Payroll Slip template gains Half/Undertime Days, Undertime Day Pay, Night
// Differential, itemized Other Deductions rows
// 23: HR Payroll Slip template drops the always-on "Cash Advance" deduction row (a cash
// advance is now just an itemized Other Deductions line)
// 24: attendance_records.form_record_ids (JSON array) — a day can link multiple HR request forms
// 25: attendance_records.lunch_out / lunch_in — the day's lunch-break bracket, split from the
// raw punches on reconcile; display-only (payroll still uses PayrollPolicy.lunch_break_minutes)
// 26: QC disposition + repair/rework — job_order_units.disposition, qc_records.disposition,
// new repair_part_requests table (production asks the warehouse for add/replace parts)
// 27: first-class production batches — production_batches table, job_order_units.batch_id,
// qc_records.batch_id (batch-level QC sign-off for non-serialized job orders)
// 28: production teams + scheduling — production_teams / production_team_members tables,
// job_orders.team_id / planned_start / due_date / priority / work_center
// 29: sale-order release/pick — orders.released_at / released_by, order_items.released_qty,
// job_order_units 'reserved' status (a unit earmarked for a SO before stock-out on confirm)
// 30: doc_templates.copies_per_record / records_per_page — opt-in N-up print tiling (multiple
// copies of a record, multiple records per page) for any form's linked template, generalizing
// the layout hr-payroll-print.js already hand-built for HR Payroll Slip. That module is
// untouched (still its own bespoke 2x2); this only drives the generic printRecordsViaTemplate()
// path other forms use.
// 31: production_team_members now references employees, not users — a production crew is
// made up of HR employees, most of whom have no login account at all.
// 32: doc_templates.tile_fill ('blank' | 'repeat') — how N-up tiling (SCHEMA_VERSION 30) fills
// grid cells once there are fewer printed records than cells: 'blank' (default, unchanged —
// right for HR Payroll Slip-style batches where each cell is a specific person) or 'repeat'
// (cycle back through the printed records so a single design fills its whole grid — a 1x2 /
// 2x2 / 3x3 / etc. repeat of one design, "Records per page" and "Copies per record" now read
// as Grid Columns / Grid Rows in the template editor).
// 33: bug_reports / bug_report_attachments — in-app bug reporting (sidebar button), steps to
// reproduce + up to 5 screenshots; reviewed/resolved from the Admin section (users.manage).
// 34: employee_rate_history — versioned per-employee daily_rate (same pattern as
// payroll_tables), so a mid-cutoff raise pays each day at the rate that actually applied.
// Logged automatically from the Edit Employee form; see src/employee-rate-history.ts.
// 35: doc_templates.repeat_count / tile_continuous — decouples "how many copies of each
// record" from the Print Grid's physical rows x columns shape (SCHEMA_VERSION 30/32).
// tile_continuous=0 (default, every existing template): unchanged — copies_per_record IS
// the repeat count, one clean page-block of records_per_page records at a time.
// tile_continuous=1: copies_per_record x records_per_page is a fixed page capacity;
// repeat_count copies of every record flatten into one stream poured continuously across as
// many such pages as needed (a record's own repeat run can end up split across a page
// boundary — see print-tiling.js's module comment). Only the generic printRecordsViaTemplate()
// path (print-tiling.js) consults these; HR Payroll Slip keeps its own bespoke 2x2 layout.
// 36: field_punches -- a separate out/in log for staff on field work (deliveries, site visits),
// logged from the kiosk's new "Field Work" tab. Deliberately its own table, untouched by
// classify()/applyPunchToAttendance, so a mid-day field trip never skews payroll hours or the
// lunch-bracket split. See src/field.ts.
// 37: attendance_records.half_day_override ('am'/'pm'/null) -- HR manually crediting a day as
// a half day with no linked Half Day Request backing it, for when the raw punch times don't
// happen to match the automatic "possible half day" heuristic. See hr-payroll-compute.ts.
// 38: punch_photos -- one photo per punch, captured from the kiosk's camera at the moment of
// the punch (attendance or field work). Re-punching an already-photographed slot (a
// click-to-correct fix, an OT re-punch of Out) replaces the photo rather than accumulating.
// Retention (max age / max total size) is a per-tenant, owner-only setting on the platform.db
// tenants row (src/platform.ts), enforced lazily in src/punch-photos.ts.
// 39: employees.ot_exempt (never paid OT, same convention as late_exempt) and
// employees.withholding_tax_override (a fixed peso amount replacing the computed BIR
// withholding formula for this employee) -- both now editable from the Edit Employee form
// alongside the existing deduct_sss/deduct_philhealth/deduct_pagibig/deduct_withholding_tax
// switches (previously Accounting-screen-only).
// 40: qc_checklists.stage (1 = QA, 2 = QC) -- a checklist now belongs to one stage as a
// whole instead of tagging each item with its own stage. inventory_items.qc_checklist_id
// (one checklist for the whole product) splits into qc_checklist_qa_id / qc_checklist_qc_id
// (one per stage), so a 2-step product can run a different checklist at each pass. Existing
// checklists/links are migrated below rather than dropped.
// 41: employees.sss_override / philhealth_override / pagibig_override -- the same fixed-amount
// override withholding_tax_override already had, now for the three contribution funds too.
// 42: inspection stage order flipped -- stage 1 (first pass) is now QC (performance/technical
// check), stage 2 (final pass) is now QA (appearance check); was QA-then-QC. Stage numbers and
// pass order are unchanged, only which label attaches to which stage. inventory_items'
// qc_checklist_qa_id / qc_checklist_qc_id columns are swapped in place (data stays with its
// stage, only the column names trade places) so each name still matches what it holds.
// 43: asset_issuances / asset_issuance_items -- company property (laptops, tools, uniforms,
// IDs, …) issued to an employee, as a header (one printable "Asset Issuance Form", numbered
// AI-00001) + line items so one form can cover several assets at once. Each line tracks its
// own status (issued/returned/lost/damaged) and return date/condition independently, since
// items issued together don't necessarily come back together. Standalone register, not linked
// to Inventory stock -- see the "Asset Issuance Form" doc_template and the Assets section on
// the Edit Employee modal (public/js/modules/hr/hr-employees.js).
// 44: messages gain reply_to_id / edited_at / deleted_at / deleted_by (chat-style reply,
// edit, and sender-only soft "unsend" -- see src/core/messages.routes.ts); new
// message_reactions (one emoji reaction per user per message) and link_previews (cached
// OG-tag fetch results, keyed by URL) tables.
// 45: job_orders.accepted_by / accepted_at / accept_notes -- the production lead's explicit
// sign-off that the released parts kit arrived. Recording output (/progress, /units) now
// requires it (job-orders.routes.ts needsAcceptance); older job orders that already have
// output recorded are exempt, so no backfill is needed.
// 46: phone time-in location lock (src/modules/hr/clock-geofence.ts) -- employees.clock_anywhere
// (field staff may punch from anywhere, without the QR) and time_punches.lat / lng / accuracy_m /
// distance_m / geo_site (where each phone punch came from, for HR review). The policy itself is
// the clock_geofence setting; off by default, so existing installs punch exactly as before.
// 48: durable document drafts/versions, shared company library, comments, working rooms and presence.
// 47: kiosk_devices -- office PCs an HR manager approved to run the time-in kiosk. With the
// kiosk lock on (default when internet-facing), the kiosk endpoints refuse any other browser.
// 48: sale-order releasing -- orders.warehouse_accepted_by / warehouse_accepted_at (the warehouse
// takes on an approved SO before picking; /release requires it) + release_slips /
// release_slip_items (numbered record of what physically left, snapshotting lines + unit
// serials; issuing one confirms the SO, which is when stock goes out). Older approved/released
// SOs are backfilled as accepted so in-flight picks aren't blocked.
// 49: job_orders.approved_by / approved_at / approve_notes -- a production.approve holder signs
// off a draft before the warehouse may release its parts (job-orders.routes.ts POST /:id/approve).
// No backfill: drafts already in the queue simply need approving; released ones are past it.
// 50: job-order parts release, warehouse side + the line lead's floor tools --
// job_orders.warehouse_accepted_by/_at + prepared_by/_at (warehouse takes on an approved draft,
// then picks the kit; several can be picked together), job_order_components.qty_picked,
// parts_release_slips / parts_release_slip_items (numbered record of the kit handed to
// production; issuing one IS the release, when stock is deducted), job_orders.paused_by/_at +
// pause_reason, and production_issues (issue reports per job order or per unit, editable while
// open). No backfill: drafts in the queue go through accept + prepare; released ones are past it.
// 51: time_punch_holds -- a phone punch is now two steps (scan the QR, then take a selfie); the
// scan parks a hold stamped with the server's time, and the selfie turns it into the real
// time_punches row AT that scan time, so the extra step never makes anyone late
// (src/modules/hr/clock.routes.ts POST /punch/scan + /punch/selfie).
// 52: employees.birth_date (YYYY-MM-DD) / civil_status -- now on the record, so an approved
// information-change request for either is applied directly (src/modules/hr/info-change.ts)
// instead of leaving HR to update it by hand. No backfill: both start NULL.
// 53: employees.status gains 'suspended' -- still employed (stays on rosters and payroll) but
// barred from clocking in and from production staffing. SQLite can't alter a CHECK in place, so
// the table is rebuilt from its own stored CREATE statement with just that constraint widened.
// 54: the insert-only "BIR 2316" template gains a Date of Birth row (employees.birth_date, v52),
// added by surgical string insert after the TIN row -- same approach as the v16 payroll-slip patch.
// 55: session + device tracking (src/shared/auth.ts, src/shared/device.ts). sessions gain sid
// (public id; the token never leaves the server's hands again), device_id / ip / user_agent at
// sign-in, last_seen_at / last_ip, shared + idle_minutes (borrowed-phone sign-in), and
// ended_at / end_reason -- a sign-out now ENDS the row instead of deleting it, so the account's
// sign-in history survives (swept after SESSION_HISTORY_DAYS). activity_log gains device_id +
// device (label); push_subscriptions gains device_id (dropped on sign-out from that device);
// time_punches gains device_id / device_flag / device_user_id (punch from a borrowed phone or
// from a device another employee usually uses).
// 56: data repair, no columns -- employee_rate_history rows at ₱0 that precede every real rate
// take the employee's first real rate. A ₱0 rate is "not set yet": an employee created without
// a rate and given one later had every cutoff day before that edit's effective date (default:
// today) still paying ₱0. See employee-rate-history.ts fillUnsetRate().
// 57: employees.always_whole_day -- any day with both a time-in and a time-out pays the full
// daily basic: no half day, late, undertime or Undertime Day (hr-payroll-compute.ts).
// 58: employees.contribution_basis ('actual' | 'fixed') -- SSS / Pag-IBIG on the month's actual
// pay (the law's default) or, by written agreement, on the employee's fixed monthly rate
// (computeEmployeeStatutory in hr.routes.ts; docs/PH-PAYROLL-COMPLIANCE.md §1).
// 59: data, no columns -- pay split from HR records: every role / per-account grant holding
//     hr.view (hr.manage) also gets payroll.view (payroll.manage), once, so no one loses access
// 60: data, no columns -- production screens split from inventory.view: every role / per-account
//     grant holding inventory.view also gets production.view, once
// 61: data, no columns -- purchasing split from orders.*: orders.view grants purchasing.view and
//     orders.create / orders.edit grant purchasing.manage, once

// 62: users temporary_password_expires_at / password_change_required for owner recovery.

/** The connection for `slug`, opening + creating/migrating its schema on first use. */
export function getDb(slug: string = DEFAULT_TENANT): DatabaseSync {
  const existing = registry.get(slug);
  if (existing) return existing;
  const conn = openConnection(slug);
  // Snapshot an existing DB before this release's schema changes touch it (before
  // createSchema too — it can add tables). If the snapshot fails we refuse to open the DB
  // rather than migrate without a way back. See src/shared/backup.ts.
  try {
    const snap = preMigrationSnapshot(conn, slug, SCHEMA_VERSION);
    if (snap) console.log(`[backup] "${slug}" is being upgraded to schema v${SCHEMA_VERSION}; snapshot saved to ${snap}`);
  } catch (e) {
    conn.close();
    throw new Error(
      `Refusing to migrate "${slug}" to schema v${SCHEMA_VERSION}: pre-migration backup failed (${(e as Error).message}). ` +
      'Fix the backup location (BACKUP_DIR) or free disk space, then restart. ' +
      'BACKUP_BEFORE_MIGRATE=off skips this check (not recommended).'
    );
  }
  registry.set(slug, conn);
  // Run schema setup with this connection active so the db.exec / getSetting calls
  // inside createSchema/migrate/seed resolve to it via activeDb().
  tenantStore.run({ db: conn, slug }, () => {
    createSchema();
    if ((getSetting<number>('schema_version') ?? 0) < SCHEMA_VERSION) {
      migrate();
      setSetting('schema_version', SCHEMA_VERSION);
    }
    hashLegacySessionTokens(conn);
    createStudioSchema(conn);
    createFormTemplateSchema(conn);
    createFormHistorySchema(conn);
    createDocumentDefaultsSchema(conn);
    ensureUploadDir();
    const previousForms=new Set((conn.prepare('SELECT id FROM form_definitions').all() as Array<{id:number}>).map(f=>f.id));
    seed();
    initializeDocumentDefaults(conn);
    if(!getSetting('payroll_print_grid_initialized')){conn.exec("UPDATE doc_templates SET copies_per_record=2,records_per_page=2 WHERE name='HR Payroll Slip' AND copies_per_record=1 AND records_per_page=1 AND tile_continuous=0 AND repeat_count=1");setSetting('payroll_print_grid_initialized',true);}
    const linksInitialized=!!getSetting('form_template_links_initialized');
    const newForms=(conn.prepare('SELECT id FROM form_definitions').all() as Array<{id:number}>).some(f=>!previousForms.has(f.id));
    if (!linksInitialized || newForms) {
      const slip = conn.prepare("SELECT id FROM doc_templates WHERE name='HR Payroll Slip' ORDER BY id LIMIT 1").get() as {id:number}|undefined;
      const payroll=conn.prepare("SELECT id FROM form_definitions WHERE slug='hr_payroll' AND template_id IS NULL").get() as {id:number}|undefined;
      if (slip && payroll && (!linksInitialized||!previousForms.has(payroll.id)))conn.prepare('UPDATE form_definitions SET template_id=? WHERE id=?').run(slip.id,payroll.id);
      const forms=conn.prepare('SELECT id,name,fields FROM form_definitions WHERE template_id IS NULL').all() as Array<{id:number;name:string;fields:string}>;
      for(const form of forms){
        if(linksInitialized&&previousForms.has(form.id))continue;
        const tpl=conn.prepare("INSERT INTO doc_templates(name,type,body) VALUES(?,'generic',?)").run(form.name+' Template',memoTemplateBody(form.name,JSON.parse(form.fields)));
        conn.prepare('UPDATE form_definitions SET template_id=? WHERE id=?').run(tpl.lastInsertRowid,form.id);
      }
      conn.exec('INSERT OR IGNORE INTO form_template_links SELECT id,template_id FROM form_definitions WHERE template_id IS NOT NULL');
      setSetting('form_template_links_initialized',true);
    }
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
    createStudioSchema(activeDb());
    createFormTemplateSchema(activeDb());
    createFormHistorySchema(activeDb());
    createDocumentDefaultsSchema(activeDb());
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
    const conn = activeDb();
    // src/sync/ wraps statements (ID allocation, node write guard); a no-op unless installed.
    if (prop === 'prepare' && syncHooks.prepare) {
      const hook = syncHooks.prepare;
      return (sql: string) => hook(conn, sql, conn.prepare(sql));
    }
    const real = conn as unknown as Record<string | symbol, unknown>;
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

/** Close every open tenant connection and forget it (a later call reopens on demand). For the
    test harness: Windows can't delete a database file that's still open, so tests/helpers.ts
    cleanup() closes first — otherwise each test file leaves its %TEMP%\vds-test-* folder behind. */
export function closeAllConnections(): void {
  for (const conn of registry.values()) {
    try { conn.close(); } catch { /* already closed */ }
  }
  registry.clear();
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

    -- The workspace's roles: named permission bundles (src/shared/roles.ts). users.role holds a
    -- key from here. Seeded once from permissions.ts BUILTIN_ROLES; 'admin' always resolves to
    -- every permission whatever its row says.
    CREATE TABLE IF NOT EXISTS roles (
      key         TEXT PRIMARY KEY,
      label       TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      permissions TEXT NOT NULL DEFAULT '[]',
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
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
      request_hash TEXT,
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
      source      TEXT NOT NULL,     -- 'phone' | 'kiosk' | 'remote' (exempt staff, no QR)
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_punch_emp_date ON time_punches(employee_id, work_date);

    -- Field-work out/in log, separate from time_punches -- a mid-day field trip (delivery,
    -- site visit, errand) must never skew payroll hours or the lunch-bracket classification
    -- that classify()/applyPunchToAttendance derive from time_punches. Logged from the
    -- kiosk's "Field Work" tab. See src/field.ts.
    CREATE TABLE IF NOT EXISTS field_punches (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      ts          TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      work_date   TEXT NOT NULL,
      kind        TEXT NOT NULL,     -- 'out' | 'in'
      source      TEXT NOT NULL,     -- 'kiosk'
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_field_punch_emp_date ON field_punches(employee_id, work_date);

    -- One photo per punch (attendance time_punches.id, or field field_punches.id), captured
    -- from the kiosk's camera at the moment of the punch. Re-punching a slot that already has
    -- one (a click-to-correct fix, or an OT re-punch of Out) replaces it in place -- see
    -- src/punch-photos.ts -- so this stays one row per punch, not an ever-growing log. Files
    -- live under uploadDir()/kiosk-punches; retention (max age / max total size) is a
    -- per-tenant, owner-only setting (src/platform.ts), enforced lazily on each save.
    CREATE TABLE IF NOT EXISTS punch_photos (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      punch_kind  TEXT NOT NULL,     -- 'attendance' | 'field'
      punch_id    INTEGER NOT NULL,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      file_name   TEXT NOT NULL,
      file_size   INTEGER NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(punch_kind, punch_id)
    );
    CREATE INDEX IF NOT EXISTS idx_punch_photo_created ON punch_photos(created_at);

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
      parent_id   INTEGER REFERENCES locations(id) ON DELETE RESTRICT,
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
      preferred_location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
      notes         TEXT,
      attributes    TEXT,
      image_path    TEXT,
      is_finished_product INTEGER NOT NULL DEFAULT 0,
      qc_checklist_qa_id INTEGER REFERENCES qc_checklists(id) ON DELETE SET NULL,
      qc_checklist_qc_id INTEGER REFERENCES qc_checklists(id) ON DELETE SET NULL,
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

    -- A data-changing AI tool call waiting for the person to confirm it (ai.routes.ts): the
    -- assistant never changes data on its own, so text it reads can't make it act.
    CREATE TABLE IF NOT EXISTS ai_pending_actions (
      id          TEXT PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tool        TEXT NOT NULL,
      args        TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed','cancelled')),
      result      TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      decided_at  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ai_pending_actions_user ON ai_pending_actions(user_id, created_at);

    -- Two-step sign-in (src/core/mfa.ts). secret: the authenticator-app secret, encrypted with
    -- the server key (shared/secrets.ts); enabled_at NULL while being set up; last_step: the
    -- last 30-second step accepted, so a code can't be used twice.
    CREATE TABLE IF NOT EXISTS user_mfa (
      user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      secret     TEXT NOT NULL,
      enabled_at TEXT,
      last_step  INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- One-time recovery codes (SHA-256 of each; shown to the person once).
    CREATE TABLE IF NOT EXISTS user_mfa_recovery (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL,
      used_at   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_user_mfa_recovery_user ON user_mfa_recovery(user_id);
    -- "Password accepted, now the code": a short-lived challenge from POST /auth/login.
    CREATE TABLE IF NOT EXISTS mfa_challenges (
      token_hash TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      shared     INTEGER NOT NULL DEFAULT 0,
      attempts   INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT NOT NULL
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

    -- Durable sales → procurement planning links; drafts are never stock or fulfilment.
    CREATE TABLE IF NOT EXISTS sale_shortfall_purchases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      purchase_order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_shortfall_purchase_source ON sale_shortfall_purchases(source_order_id);

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
      qc_checklist_qc_snapshot TEXT,
      qc_checklist_qa_snapshot TEXT,
      team_id            INTEGER REFERENCES production_teams(id) ON DELETE SET NULL,
      planned_start      TEXT,
      due_date           TEXT,
      priority           INTEGER NOT NULL DEFAULT 0,
      work_center        TEXT,
      notes              TEXT,
      created_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
      released_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
      released_at        TEXT,
      approved_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
      approved_at        TEXT,
      approve_notes      TEXT,
      accepted_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
      accepted_at        TEXT,
      accept_notes       TEXT,
      closed_at          TEXT,
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Durable manufacturing → procurement planning links. A draft PO is pending supply,
    -- never component stock; receipts at the job's source location close the shortage.
    CREATE TABLE IF NOT EXISTS job_shortfall_purchases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_order_id INTEGER NOT NULL REFERENCES job_orders(id) ON DELETE CASCADE,
      purchase_order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_job_shortfall_purchase_job ON job_shortfall_purchases(job_order_id);

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

    -- Production teams: a named crew a job order is assigned to, with a member roster.
    CREATE TABLE IF NOT EXISTS production_teams (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      notes      TEXT,
      is_active  INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS production_team_members (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id     INTEGER NOT NULL REFERENCES production_teams(id) ON DELETE CASCADE,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      role        TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(team_id, employee_id)
    );

    -- A production batch / lot: a named group of units off one job order. For a
    -- non-serialized job order (qc_stages = 0) each /progress entry creates one; for a
    -- serialized job order a batch is opt-in and its units carry batch_id. status:
    -- open (in production / QC) | released | closed.
    -- status: open (QC-stage: still has pending/rework units; non-serialized: hasn't had its
    -- optional batch-level QA sign-off) | released (free-form manual label, unrelated to
    -- job_orders.status) | closed (every unit inspected / batch-level sign-off passed —
    -- production.routes.ts POST /batches/:id/inspect, maybeCloseBatches). This is a QUALITY
    -- sign-off flag, independent of whether the batch has been received — see
    -- production_receipts below; receivable/received is computed from qty vs.
    -- SUM(production_receipt_items.quantity), not from this column.
    CREATE TABLE IF NOT EXISTS production_batches (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      number          TEXT NOT NULL UNIQUE,
      job_order_id    INTEGER REFERENCES job_orders(id) ON DELETE SET NULL,
      product_item_id INTEGER REFERENCES inventory_items(id) ON DELETE SET NULL,
      qty             INTEGER NOT NULL DEFAULT 0,
      identifier      TEXT,
      status          TEXT NOT NULL DEFAULT 'open',
      notes           TEXT,
      created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Products In: the Purchasing "Goods Receipt" pattern mirrored for production output.
    -- A job order's finished output (serialized units once they reach job_order_units.status
    -- = 'passed', or a whole non-serialized batch while production_batches.status = 'open')
    -- sits "receivable" until this posts it into stock at a chosen location — see
    -- job-orders.routes.ts POST /:id/products-in. One receipt can cover several units and/or
    -- one batch; the location is picked at receiving time (this is also where a "warehouse
    -- transfer" away from the job order's default output_location_id happens, if needed).
    CREATE TABLE IF NOT EXISTS production_receipts (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      number        TEXT NOT NULL UNIQUE,               -- PI-00001
      job_order_id  INTEGER NOT NULL REFERENCES job_orders(id) ON DELETE CASCADE,
      location_id   INTEGER REFERENCES locations(id) ON DELETE SET NULL,
      received_date TEXT,
      notes         TEXT,
      received_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS production_receipt_items (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_id INTEGER NOT NULL REFERENCES production_receipts(id) ON DELETE CASCADE,
      unit_id    INTEGER REFERENCES job_order_units(id) ON DELETE SET NULL,      -- serialized
      batch_id   INTEGER REFERENCES production_batches(id) ON DELETE SET NULL,  -- non-serialized
      quantity   REAL NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS production_batch_stock (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL REFERENCES production_batches(id),
      location_id INTEGER NOT NULL REFERENCES locations(id),
      quantity REAL NOT NULL DEFAULT 0,
      received REAL NOT NULL DEFAULT 0,
      UNIQUE(batch_id,location_id)
    );
    CREATE TABLE IF NOT EXISTS production_batch_allocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL REFERENCES production_batches(id),
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      order_item_id INTEGER REFERENCES order_items(id) ON DELETE SET NULL,
      item_id INTEGER NOT NULL REFERENCES inventory_items(id),
      location_id INTEGER NOT NULL REFERENCES locations(id),
      quantity REAL NOT NULL CHECK(quantity > 0),
      state TEXT NOT NULL CHECK(state IN ('reserved','shipped')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS production_batch_counts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL REFERENCES production_batches(id),
      location_id INTEGER NOT NULL REFERENCES locations(id),
      before_quantity REAL NOT NULL,
      counted_quantity REAL NOT NULL,
      reason TEXT NOT NULL,
      counted_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS production_batch_return_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      return_id INTEGER NOT NULL UNIQUE REFERENCES sales_returns(id),
      batch_id INTEGER NOT NULL REFERENCES production_batches(id)
    );
    CREATE INDEX IF NOT EXISTS idx_batch_stock_location ON production_batch_stock(location_id,batch_id);
    CREATE INDEX IF NOT EXISTS idx_batch_allocations_stock ON production_batch_allocations(batch_id,location_id,state);
    CREATE INDEX IF NOT EXISTS idx_batch_allocations_order ON production_batch_allocations(order_id,item_id,state);

    -- Phase C: one row per physical unit produced by a job order, plus its QA/QC log.
    -- status: pending | in_stock | failed | scrapped | sold | rework. order_id ties a
    -- sold / relocated unit to the sales order that consumed or moved it. disposition
    -- (set on a fail): scrap | dispose | recycle | repair — 'repair' sends it to rework.
    CREATE TABLE IF NOT EXISTS job_order_units (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      job_order_id    INTEGER NOT NULL REFERENCES job_orders(id) ON DELETE CASCADE,
      product_item_id INTEGER REFERENCES inventory_items(id) ON DELETE SET NULL,
      identifier      TEXT,
      status          TEXT NOT NULL DEFAULT 'pending',
      stage           INTEGER NOT NULL DEFAULT 0,
      location_id     INTEGER REFERENCES locations(id) ON DELETE SET NULL,
      order_id        INTEGER REFERENCES orders(id) ON DELETE SET NULL,
      order_item_id   INTEGER REFERENCES order_items(id) ON DELETE SET NULL,
      direct_sold_at  TEXT,
      batch_id        INTEGER REFERENCES production_batches(id) ON DELETE SET NULL,
      disposition     TEXT,
      remarks         TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS qc_records (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      job_order_id INTEGER NOT NULL REFERENCES job_orders(id) ON DELETE CASCADE,
      unit_id      INTEGER REFERENCES job_order_units(id) ON DELETE CASCADE,
      batch_id     INTEGER REFERENCES production_batches(id) ON DELETE CASCADE,
      stage        INTEGER NOT NULL,
      result       TEXT NOT NULL,
      -- On a fail: scrap | dispose | recycle | repair (mirrors job_order_units.disposition).
      disposition  TEXT,
      remarks      TEXT,
      -- JSON snapshot of the checklist the inspector filled: [{label, ok, note}].
      checklist    TEXT,
      inspector_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- A repair (rework) unit's parts requests to the warehouse. kind: add (missing part)
    -- | replace (swap a fitted part — the removed one is booked into its damage twin).
    -- status: requested -> accepted (stock moved) | rejected | cancelled. Nothing moves
    -- until the warehouse accepts.
    CREATE TABLE IF NOT EXISTS repair_part_requests (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      number            TEXT NOT NULL UNIQUE,
      unit_id           INTEGER NOT NULL REFERENCES job_order_units(id) ON DELETE CASCADE,
      job_order_id      INTEGER REFERENCES job_orders(id) ON DELETE SET NULL,
      kind              TEXT NOT NULL DEFAULT 'replace',
      component_item_id INTEGER REFERENCES inventory_items(id) ON DELETE SET NULL,
      component_name    TEXT NOT NULL,
      quantity          INTEGER NOT NULL DEFAULT 1,
      fault             TEXT,
      return_to_damage  INTEGER NOT NULL DEFAULT 1,
      from_location_id  INTEGER REFERENCES locations(id) ON DELETE SET NULL,
      status            TEXT NOT NULL DEFAULT 'requested',
      requested_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
      decided_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
      warehouse_remarks TEXT,
      notes             TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
      decided_at        TEXT
    );

    -- Named QC/QA checklist templates. Each checklist belongs to one stage as a whole
    -- (stage: 1 = QC / first pass, 2 = QA / final pass) rather than tagging items
    -- individually. A finished product points at one checklist per stage via
    -- inventory_items.qc_checklist_qc_id / qc_checklist_qa_id; the is_default row for
    -- that stage covers products with none attached. The items column is JSON:
    -- [{label, required}].
    CREATE TABLE IF NOT EXISTS qc_checklists (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      items      TEXT NOT NULL DEFAULT '[]',
      stage      INTEGER NOT NULL DEFAULT 1,
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
    CREATE TABLE IF NOT EXISTS inventory_variant_stock (
      item_id INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
      build_mode TEXT NOT NULL CHECK (build_mode IN ('assembled', 'semi_built')),
      quantity REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (item_id, location_id, build_mode)
    );

    -- A location's stock went below zero because an offline stock-out (a sync command,
    -- docs/OFFLINE-FIRST.md decision D1) was accepted beyond recorded stock: the goods
    -- physically left, so the records were behind. Each row is a count-or-correct task for a
    -- supervisor; resolving it records what was done and moves no stock by itself.
    CREATE TABLE IF NOT EXISTS stock_discrepancies (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id                INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      location_id            INTEGER REFERENCES locations(id) ON DELETE SET NULL,
      transaction_id         INTEGER REFERENCES inventory_transactions(id) ON DELETE SET NULL,
      change                 INTEGER NOT NULL,
      location_balance_after INTEGER NOT NULL,
      reason                 TEXT,
      created_by             INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at             TEXT NOT NULL DEFAULT (datetime('now')),
      status                 TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
      resolution_note        TEXT,
      resolved_by            INTEGER REFERENCES users(id) ON DELETE SET NULL,
      resolved_at            TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_stock_discrepancies_status ON stock_discrepancies(status, item_id);

    CREATE TABLE IF NOT EXISTS direct_sale_stockout_reviews (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id       INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      item_id        INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      evidence_hash  TEXT NOT NULL,
      note           TEXT NOT NULL,
      reviewed_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reviewed_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_direct_sale_stockout_review_case ON direct_sale_stockout_reviews(order_id,item_id,id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_direct_sale_stockout_review_evidence ON direct_sale_stockout_reviews(order_id,item_id,evidence_hash);

    CREATE TABLE IF NOT EXISTS stock_counts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
      build_mode TEXT NOT NULL CHECK(build_mode IN ('assembled','semi_built')),
      book_quantity REAL NOT NULL,
      book_serial_ids TEXT NOT NULL,
      book_batches TEXT NOT NULL,
      counted_untracked REAL NOT NULL,
      counted_serial_ids TEXT NOT NULL,
      counted_batches TEXT NOT NULL,
      note TEXT NOT NULL,
      source_kind TEXT NOT NULL CHECK(source_kind IN ('manual','discrepancy','direct_sale')),
      source_id INTEGER,
      source_evidence_hash TEXT,
      source_closed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      source_closed_at TEXT,
      source_close_note TEXT,
      status TEXT NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted','approved','applied','rejected')),
      counted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      counted_at TEXT NOT NULL DEFAULT (datetime('now')),
      reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reviewed_at TEXT,
      review_note TEXT,
      transaction_id INTEGER REFERENCES inventory_transactions(id) ON DELETE SET NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_stock_counts_status ON stock_counts(status, counted_at, id);
    CREATE TABLE IF NOT EXISTS stock_count_movements (
      count_id INTEGER NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE,
      transaction_id INTEGER NOT NULL REFERENCES inventory_transactions(id) ON DELETE RESTRICT,
      batch_id INTEGER REFERENCES production_batches(id) ON DELETE SET NULL,
      PRIMARY KEY(count_id,transaction_id)
    );

    -- Offline sync home sites (docs/OFFLINE-FIRST.md §16): which site host decides a location's
    -- records while the internet is down. A location with no row — and company-wide records —
    -- belong to the main site (setting 'sync_main_host'); with none set, only the cloud decides.
    CREATE TABLE IF NOT EXISTS location_sites (
      location_id  INTEGER PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
      host_node_no INTEGER NOT NULL
    );
    -- A site host's decision on its own site's records that the cloud kept although its own
    -- check would now fail, because data changed elsewhere meanwhile (decision D6). A task for an
    -- admin to look at; resolving it changes nothing by itself.
    CREATE TABLE IF NOT EXISTS site_decision_clashes (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      host_node_no  INTEGER,
      route         TEXT NOT NULL,
      summary       TEXT NOT NULL,
      actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
      resolution_note TEXT,
      resolved_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      resolved_at   TEXT
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

    -- Identified employee reports have a case lifecycle separate from personal messages and
    -- from identity-free anonymous reports. Only reporter, selected recipient and assignee read.
    CREATE TABLE IF NOT EXISTS identified_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      number TEXT UNIQUE,
      reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      category TEXT NOT NULL,
      subject TEXT NOT NULL,
      description TEXT NOT NULL,
      incident_date TEXT,
      incident_time TEXT,
      location TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_identified_reports_reporter ON identified_reports(reporter_id, id);
    CREATE INDEX IF NOT EXISTS idx_identified_reports_recipient ON identified_reports(recipient_id, status);
    CREATE INDEX IF NOT EXISTS idx_identified_reports_assignee ON identified_reports(assignee_id, status);
    CREATE TABLE IF NOT EXISTS identified_report_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id INTEGER NOT NULL REFERENCES identified_reports(id) ON DELETE CASCADE,
      actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      kind TEXT NOT NULL,
      body TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_identified_report_events_report ON identified_report_events(report_id, id);
    CREATE TABLE IF NOT EXISTS identified_report_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id INTEGER NOT NULL REFERENCES identified_reports(id) ON DELETE CASCADE,
      stored_name TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL
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
      data          BLOB,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_message_attachments_message ON message_attachments(message_id);

    -- Recoverable bytes for files owned by the other tenant modules. The filename is
    -- relative to this tenant's uploadDir; deleted files are removed from this table.
    CREATE TABLE IF NOT EXISTS durable_uploads (
      name       TEXT PRIMARY KEY,
      data       BLOB NOT NULL,
      size_bytes INTEGER NOT NULL,
      saved_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- One emoji reaction per user per message (SCHEMA_VERSION 44). Re-reacting with the
    -- same emoji toggles it off; a different emoji replaces it (see UNIQUE below).
    CREATE TABLE IF NOT EXISTS message_reactions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      emoji      TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(message_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_message_reactions_message ON message_reactions(message_id);

    -- Cached Open Graph metadata for a link preview card, keyed by URL (SCHEMA_VERSION 44)
    -- so the same link shared repeatedly isn't refetched on every render. failed marks a
    -- URL that couldn't be fetched/parsed (blocked, timed out, not HTML, ...).
    CREATE TABLE IF NOT EXISTS link_previews (
      url         TEXT PRIMARY KEY,
      title       TEXT,
      description TEXT,
      image_url   TEXT,
      site_name   TEXT,
      fetched_at  TEXT NOT NULL,
      failed      INTEGER NOT NULL DEFAULT 0
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

    -- Every Mark Paid / Unmark Paid of a payslip (hr.routes.ts). A payslip with any row here was
    -- paid at some point, so it is part of the payroll record and can no longer be deleted
    -- (form-builder.routes.ts) — only corrected. No FK: the history must outlive the record.
    CREATE TABLE IF NOT EXISTS payslip_paid_history (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      record_id  INTEGER NOT NULL,
      action     TEXT NOT NULL CHECK (action IN ('paid','unpaid')),
      by_user_id INTEGER,
      at         TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_payslip_paid_history_record ON payslip_paid_history(record_id);

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
                      CHECK (status IN ('probationary','regular','suspended','resigned','terminated')),
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

    -- Company property issued to an employee -- header (SCHEMA_VERSION 43). One row per
    -- printed/signed "Asset Issuance Form"; number is human-readable (AI-00001).
    CREATE TABLE IF NOT EXISTS asset_issuances (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      number      TEXT NOT NULL UNIQUE,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      issued_date TEXT NOT NULL,
      issued_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      notes       TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- One asset per line -- each returned/lost/damaged independently of its siblings on the
    -- same issuance, since a batch of gear issued together doesn't necessarily come back together.
    CREATE TABLE IF NOT EXISTS asset_issuance_items (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      issuance_id         INTEGER NOT NULL REFERENCES asset_issuances(id) ON DELETE CASCADE,
      asset_name          TEXT NOT NULL,
      category            TEXT,
      asset_tag           TEXT,   -- serial / property number, if any
      quantity            INTEGER NOT NULL DEFAULT 1,
      condition_on_issue  TEXT,
      status              TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','returned','lost','damaged')),
      returned_date       TEXT,
      condition_on_return TEXT,
      return_notes        TEXT,
      sort                INTEGER NOT NULL DEFAULT 0
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

    -- Same versioned-table pattern as payroll_tables above, but per employee: one row per
    -- (employee_id, effective_from), the latest whose effective_from is on or before a given
    -- work_date wins. Lets a mid-cutoff raise (e.g. ₱600/day through Jun 8, ₱650/day from Jun 9)
    -- pay each day at the rate that actually applied, instead of one flat rate for the whole
    -- cutoff. daily_rate is always the resolved, payroll-ready value (monthly ÷ divisor already
    -- applied), same convention as employees.daily_rate — see effectiveDailyRate() in
    -- hr.routes.ts. See src/employee-rate-history.ts.
    CREATE TABLE IF NOT EXISTS employee_rate_history (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id    INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      effective_from TEXT NOT NULL,
      rate_type      TEXT NOT NULL CHECK (rate_type IN ('daily','monthly')),
      daily_rate     REAL NOT NULL,
      monthly_rate   REAL,
      note           TEXT,
      created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(employee_id, effective_from)
    );
    CREATE INDEX IF NOT EXISTS idx_rate_history_employee ON employee_rate_history(employee_id, effective_from);

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
      lunch_out   TEXT,   -- start of the unpaid lunch break; display-only, split from punches on reconcile
      lunch_in    TEXT,   -- back from lunch; display-only (payroll uses PayrollPolicy.lunch_break_minutes)
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
    CREATE INDEX IF NOT EXISTS idx_rpr_unit ON repair_part_requests(unit_id);
    CREATE INDEX IF NOT EXISTS idx_rpr_status ON repair_part_requests(status);
    CREATE INDEX IF NOT EXISTS idx_batch_job_order ON production_batches(job_order_id);
    CREATE INDEX IF NOT EXISTS idx_prod_receipts_job_order ON production_receipts(job_order_id);
    CREATE INDEX IF NOT EXISTS idx_prod_receipt_items_receipt ON production_receipt_items(receipt_id);
    CREATE INDEX IF NOT EXISTS idx_prod_receipt_items_unit ON production_receipt_items(unit_id);
    CREATE INDEX IF NOT EXISTS idx_prod_receipt_items_batch ON production_receipt_items(batch_id);
    CREATE INDEX IF NOT EXISTS idx_ptm_team ON production_team_members(team_id);
    -- NOTE: indexes on job_order_units.batch_id / qc_records.batch_id / job_orders.team_id
    -- / job_orders.due_date are created in migrate(), right after the ALTER TABLE that adds
    -- each column — an existing DB reaches createSchema() before those columns exist.
    CREATE INDEX IF NOT EXISTS idx_employees_dept ON employees(department_id);
    CREATE INDEX IF NOT EXISTS idx_attendance_period ON attendance_records(period_id);
    CREATE INDEX IF NOT EXISTS idx_attendance_employee ON attendance_records(employee_id);
    CREATE INDEX IF NOT EXISTS idx_employee_documents_employee ON employee_documents(employee_id);
    CREATE INDEX IF NOT EXISTS idx_asset_issuances_employee ON asset_issuances(employee_id);
    CREATE INDEX IF NOT EXISTS idx_asset_issuance_items_issuance ON asset_issuance_items(issuance_id);
    CREATE INDEX IF NOT EXISTS idx_asset_issuance_items_status ON asset_issuance_items(status);

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

    -- Confidential (anonymous) reporting — src/core/confidential-reports.ts. Deliberately NO
    -- reporter column of any kind (user, IP, device), and dates only, never times. Tickets are
    -- single-use submission tokens (hash only, no user column); access_hash is the SHA-256 of
    -- the one-time code the reporter follows up with. Created here (not migrate()) so it needs
    -- no SCHEMA_VERSION bump.
    CREATE TABLE IF NOT EXISTS anonymous_report_tickets (
      token_hash TEXT PRIMARY KEY,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS anonymous_reports (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      number        TEXT NOT NULL UNIQUE,
      category      TEXT NOT NULL,
      subject       TEXT,
      description   TEXT NOT NULL,
      incident_date TEXT,
      location      TEXT,
      status        TEXT NOT NULL DEFAULT 'new'
                      CHECK (status IN ('new','triaged','investigating','resolved','closed')),
      access_hash   TEXT NOT NULL,
      created_on    TEXT NOT NULL,
      updated_on    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_anonymous_reports_status ON anonymous_reports(status, id);
    -- A report filed on an installed PC gets a provisional number there (derived from its sync
    -- command, never from the PC); the cloud keeps it here as a permanent alias of the real one,
    -- so the reporter's follow-ups keep working with either (docs/OFFLINE-FIRST.md §25).
    CREATE TABLE IF NOT EXISTS anonymous_report_aliases (
      alias     TEXT PRIMARY KEY,
      report_id INTEGER NOT NULL REFERENCES anonymous_reports(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS anonymous_report_messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id  INTEGER NOT NULL REFERENCES anonymous_reports(id) ON DELETE CASCADE,
      author     TEXT NOT NULL CHECK (author IN ('reporter','handler')),
      handler_id INTEGER REFERENCES users(id) ON DELETE SET NULL,  -- staff only; NULL for the reporter
      body       TEXT NOT NULL,
      created_on TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_anonymous_report_messages ON anonymous_report_messages(report_id, id);
    -- Photos on an anonymous report (message_id NULL = sent with the report itself). Stored as
    -- BLOBs, not files under UPLOAD_DIR, so there's no filename and no file-system timestamp to
    -- date the submission; bytes are metadata-stripped on the way in (shared/image-metadata.ts).
    -- No original filename column on purpose (phone names like IMG_20260928_143012 carry a time).
    CREATE TABLE IF NOT EXISTS anonymous_report_attachments (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id  INTEGER NOT NULL REFERENCES anonymous_reports(id) ON DELETE CASCADE,
      message_id INTEGER REFERENCES anonymous_report_messages(id) ON DELETE CASCADE,
      mime_type  TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      data       BLOB NOT NULL,
      created_on TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_anonymous_report_attachments ON anonymous_report_attachments(report_id, id);
    -- Highest photo id a case handler has loaded, per report. The reporter may remove a photo
    -- only while its id is above this (i.e. no handler has seen it yet). No date/time kept.
    CREATE TABLE IF NOT EXISTS anonymous_report_handler_seen (
      report_id     INTEGER PRIMARY KEY REFERENCES anonymous_reports(id) ON DELETE CASCADE,
      last_photo_id INTEGER NOT NULL
    );

    -- Structured repair / rectification order behind a QC or QA 'repair' result (mobile V2,
    -- Figma 69:323 / 72:322): defect category, responsible station, priority. The instruction
    -- is the record's remarks. One row per qc_records row. createSchema, no version bump.
    CREATE TABLE IF NOT EXISTS qc_repair_details (
      qc_record_id INTEGER PRIMARY KEY REFERENCES qc_records(id) ON DELETE CASCADE,
      category     TEXT,
      station      TEXT,
      priority     TEXT
    );

    -- Sale-order warehouse-out rules (mobile Releasing, Figma 78:*; modules/inventory/release-auth.ts).
    -- createSchema, no version bump.
    -- Who may receive an order's goods: issued by Sales, presented as a token at handoff. Only the
    -- last 4 of the recipient's ID reference is stored. A new one revokes the previous.
    CREATE TABLE IF NOT EXISTS release_authorizations (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id        INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      mode            TEXT NOT NULL CHECK (mode IN ('pickup', 'delivery')),
      recipient_name  TEXT NOT NULL,
      id_last4        TEXT,
      token           TEXT NOT NULL,
      valid_until     TEXT NOT NULL,
      handoff_area    TEXT,
      partial_allowed INTEGER NOT NULL DEFAULT 0,
      notes           TEXT,
      issued_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
      issued_at       TEXT NOT NULL DEFAULT (datetime('now')),
      revoked_at      TEXT,
      revoked_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
      revoke_reason   TEXT,
      used_slip_id    INTEGER REFERENCES release_slips(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_release_authorizations_order ON release_authorizations(order_id, id);
    -- What must leave with each unit of a finished product (charger, keys, documents…).
    CREATE TABLE IF NOT EXISTS product_package_items (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id  INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      label    TEXT NOT NULL,
      required INTEGER NOT NULL DEFAULT 1,
      sort     INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_product_package_items ON product_package_items(item_id, sort);
    -- The handoff facts of a release slip: authorization used, recipient, confirmed package
    -- (JSON [{item_id,label,ok}]), seal tag, recipient acknowledgement, a partial release's backorder.
    CREATE TABLE IF NOT EXISTS release_slip_details (
      slip_id            INTEGER PRIMARY KEY REFERENCES release_slips(id) ON DELETE CASCADE,
      authorization_id   INTEGER REFERENCES release_authorizations(id) ON DELETE SET NULL,
      mode               TEXT,
      recipient_name     TEXT,
      handoff_area       TEXT,
      seal_tag           TEXT,
      package            TEXT,
      acknowledged       INTEGER NOT NULL DEFAULT 0,
      backorder_order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL
    );
    -- Problems the releaser raises for Sales (wrong unit, missing package item, identity, a
    -- partial-release request). Records only; Sales resolves them on the sale order.
    CREATE TABLE IF NOT EXISTS release_reports (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id        INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      kind            TEXT NOT NULL CHECK (kind IN ('authorization', 'identity', 'unit_mismatch', 'package_missing', 'partial_request', 'other')),
      description     TEXT NOT NULL,
      unit_identifier TEXT,
      status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
      resolution      TEXT,
      reported_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      resolved_at     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_release_reports_order ON release_reports(order_id, status);
    -- Supervisor override of the release token (the recipient can't present it): requested by the
    -- releaser or made directly by a supervisor (inventory.adjust), always with a reason. An
    -- approved one stands in for the token on that authorization's slip, once.
    CREATE TABLE IF NOT EXISTS release_token_overrides (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id         INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      authorization_id INTEGER NOT NULL REFERENCES release_authorizations(id) ON DELETE CASCADE,
      status           TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'approved', 'declined', 'used')),
      reason           TEXT NOT NULL,
      requested_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      requested_at     TEXT NOT NULL DEFAULT (datetime('now')),
      decided_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
      decided_at       TEXT,
      decision_note    TEXT,
      used_slip_id     INTEGER REFERENCES release_slips(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_release_token_overrides ON release_token_overrides(authorization_id, id);

    -- Repair-parts requests (mobile Parts clerk, Figma 83:*; production.routes.ts). createSchema,
    -- no version bump. A formal revision of a request's part or quantity: proposed by the parts
    -- clerk, approved by the requester or a supervisor (never the proposer). While one is pending
    -- the request can't be issued.
    CREATE TABLE IF NOT EXISTS repair_revisions (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id        INTEGER NOT NULL REFERENCES repair_part_requests(id) ON DELETE CASCADE,
      proposed_item_id  INTEGER REFERENCES inventory_items(id) ON DELETE SET NULL,
      proposed_name     TEXT NOT NULL,
      proposed_quantity INTEGER NOT NULL,
      reason            TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
      proposed_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
      decided_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
      decision_note     TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      decided_at        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_repair_revisions_request ON repair_revisions(request_id, status);
    -- Audit trail of a request beyond accept/reject: shortage escalations, revisions, notes.
    CREATE TABLE IF NOT EXISTS repair_request_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER NOT NULL REFERENCES repair_part_requests(id) ON DELETE CASCADE,
      kind       TEXT NOT NULL,
      details    TEXT,
      actor_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_repair_request_events ON repair_request_events(request_id, id);
    -- Stock an open repair-parts request holds at one approved source until it is issued, rejected
    -- or cancelled (modules/manufacturing/stock-holds.ts). None while the request is a shortage.
    CREATE TABLE IF NOT EXISTS repair_part_holds (
      request_id  INTEGER PRIMARY KEY REFERENCES repair_part_requests(id) ON DELETE CASCADE,
      item_id     INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      quantity    REAL NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_repair_part_holds_item ON repair_part_holds(item_id, location_id);
    -- Evidence photos (attachments kind 'qc_unit') behind a failing / held QC-QA result; each photo
    -- backs one record only. createSchema, no version bump.
    CREATE TABLE IF NOT EXISTS qc_evidence (
      attachment_id INTEGER PRIMARY KEY REFERENCES attachments(id) ON DELETE CASCADE,
      qc_record_id  INTEGER NOT NULL REFERENCES qc_records(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_qc_evidence_record ON qc_evidence(qc_record_id);
    -- Each person's notification history (shared/push.ts notifyUser; core/notifications.routes.ts):
    -- written once, where the authority runs, whether or not the person has push set up. url = a
    -- phone route to the record; link = JSON {route, params} for the desktop when it has a screen.
    CREATE TABLE IF NOT EXISTS notifications (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title      TEXT NOT NULL,
      body       TEXT,
      url        TEXT,
      link       TEXT,
      tag        TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      read_at    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, id);
    -- Optional room per location, in units of stock (the sum of inventory_stock there). Ready-to-sell
    -- posting (manufacturing/rts.ts) refuses what wouldn't fit. No row = no limit. createSchema.
    CREATE TABLE IF NOT EXISTS location_capacities (
      location_id INTEGER PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
      max_units   REAL NOT NULL,
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Job-order line decisions (pause / resume / close early) — append-only audit history with
    -- actor and reason; job_orders.pause_* only hold the CURRENT hold. createSchema, no bump.
    CREATE TABLE IF NOT EXISTS job_order_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      job_order_id INTEGER NOT NULL REFERENCES job_orders(id) ON DELETE CASCADE,
      action       TEXT NOT NULL CHECK (action IN ('pause','resume','close_early')),
      reason       TEXT,
      actor_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_job_order_events ON job_order_events(job_order_id, id);

    -- Employee self-service profile (src/modules/hr/employee-profile.ts): preferred name and
    -- personal contact details the employee edits themselves, kept apart from the HR-owned
    -- employees row (legal name, position, pay…). verified_at is cleared whenever a contact
    -- field changes and set again by HR (hr.manage). One history row per changed field.
    CREATE TABLE IF NOT EXISTS employee_profiles (
      employee_id                INTEGER PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
      preferred_name             TEXT,
      mobile_phone               TEXT,
      personal_email             TEXT,
      home_address               TEXT,
      emergency_contact_name     TEXT,
      emergency_contact_relation TEXT,
      emergency_contact_phone    TEXT,
      updated_at                 TEXT,
      updated_by                 INTEGER REFERENCES users(id) ON DELETE SET NULL,
      verified_at                TEXT,
      verified_by                INTEGER REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS employee_profile_changes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      field       TEXT NOT NULL,
      old_value   TEXT,
      new_value   TEXT,
      changed_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      source      TEXT NOT NULL DEFAULT 'self',   -- 'self' | 'hr_verify' | 'info_change' (approved request)
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_employee_profile_changes ON employee_profile_changes(employee_id, id);

    -- In-app bug reports: any signed-in user can file one (title + steps to reproduce +
    -- up to 5 screenshots); users.manage reviews/resolves them. See
    -- src/routes/bug-reports.routes.ts.
    CREATE TABLE IF NOT EXISTS bug_reports (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      title              TEXT NOT NULL,
      steps_to_reproduce TEXT NOT NULL,
      description        TEXT,
      page_context       TEXT,
      status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
      reported_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
      resolved_at        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_bug_reports_status ON bug_reports(status, id);

    CREATE TABLE IF NOT EXISTS bug_report_attachments (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      bug_report_id INTEGER NOT NULL REFERENCES bug_reports(id) ON DELETE CASCADE,
      stored_name   TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type     TEXT,
      size_bytes    INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_bug_report_attachments_report ON bug_report_attachments(bug_report_id);

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
      delivery_mode  TEXT NOT NULL DEFAULT 'own' CHECK (delivery_mode IN ('own','courier')),
      courier_name   TEXT,
      tracking_number TEXT,
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
  const formCols = new Set((db.prepare('PRAGMA table_info(form_definitions)').all() as {name:string}[]).map(c=>c.name));
  for (const [name, type] of Object.entries({entry_access:"TEXT NOT NULL DEFAULT '{\"roles\":[],\"users\":[]}'",access_revision:'INTEGER NOT NULL DEFAULT 1',version:'INTEGER NOT NULL DEFAULT 1',updated_by:'INTEGER REFERENCES users(id) ON DELETE SET NULL',version_reason:'TEXT',archived_at:'TEXT',archived_by:'INTEGER REFERENCES users(id) ON DELETE SET NULL',archive_reason:'TEXT'})) {
    if (!formCols.has(name)) db.exec(`ALTER TABLE form_definitions ADD COLUMN ${name} ${type}`);
  }
  const recordCols = new Set((db.prepare('PRAGMA table_info(form_records)').all() as {name:string}[]).map(c=>c.name));
  if (!recordCols.has('definition_version')) db.exec('ALTER TABLE form_records ADD COLUMN definition_version INTEGER');
  if (!recordCols.has('revision')) db.exec('ALTER TABLE form_records ADD COLUMN revision INTEGER NOT NULL DEFAULT 1');

  // 73: item placement preference is separate from stock held at any one location.
  const preferredLocCols = db.prepare('PRAGMA table_info(inventory_items)').all() as { name: string }[];
  if (!preferredLocCols.some((c) => c.name === 'preferred_location_id')) db.exec('ALTER TABLE inventory_items ADD COLUMN preferred_location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL');
  // 72: optional location hierarchy; existing locations remain top-level.
  const hierarchyCols = db.prepare('PRAGMA table_info(locations)').all() as { name: string }[];
  if (!hierarchyCols.some((c) => c.name === 'parent_id')) db.exec('ALTER TABLE locations ADD COLUMN parent_id INTEGER REFERENCES locations(id) ON DELETE RESTRICT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_locations_parent ON locations(parent_id)');
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

  // v64: checklist notes and a durable, one-to-one scheduler link.
  const noteCols = db.prepare('PRAGMA table_info(notes)').all() as { name: string }[];
  if (!noteCols.some(c => c.name === 'checklist')) db.exec("ALTER TABLE notes ADD COLUMN checklist TEXT NOT NULL DEFAULT '[]'");
  // ---- Tasks: scheduling + reminders ----
  const taskCols = db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
  if (!taskCols.some((c) => c.name === 'notes')) db.exec('ALTER TABLE tasks ADD COLUMN notes TEXT');
  if (!taskCols.some((c) => c.name === 'remind_at')) db.exec('ALTER TABLE tasks ADD COLUMN remind_at TEXT');
  if (!taskCols.some((c) => c.name === 'remind_sent')) db.exec('ALTER TABLE tasks ADD COLUMN remind_sent INTEGER NOT NULL DEFAULT 0');
  if (!taskCols.some(c => c.name === 'note_id')) db.exec('ALTER TABLE tasks ADD COLUMN note_id INTEGER REFERENCES notes(id) ON DELETE SET NULL');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_note ON tasks(note_id) WHERE note_id IS NOT NULL');

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

  // (SCHEMA_VERSION 30) Opt-in N-up print tiling — see the version-history comment above.
  // Both default to 1 (today's plain one-record-per-page behavior) for every existing template.
  if (!tplCols.some((c) => c.name === 'copies_per_record')) {
    db.exec('ALTER TABLE doc_templates ADD COLUMN copies_per_record INTEGER NOT NULL DEFAULT 1');
  }
  if (!tplCols.some((c) => c.name === 'records_per_page')) {
    db.exec('ALTER TABLE doc_templates ADD COLUMN records_per_page INTEGER NOT NULL DEFAULT 1');
  }

  // (SCHEMA_VERSION 32) See the version-history comment above.
  if (!tplCols.some((c) => c.name === 'tile_fill')) {
    db.exec("ALTER TABLE doc_templates ADD COLUMN tile_fill TEXT NOT NULL DEFAULT 'blank' CHECK (tile_fill IN ('blank','repeat'))");
  }

  // (SCHEMA_VERSION 35) See the version-history comment above. Defaults (1 / 0) reproduce
  // every existing template's current output exactly — continuous mode is opt-in.
  for (const column of ['grid_gap_x_mm','grid_gap_y_mm']) {
    if (!tplCols.some(c => c.name === column)) db.exec(`ALTER TABLE doc_templates ADD COLUMN ${column} REAL NOT NULL DEFAULT 6`);
  }
  if (!tplCols.some((c) => c.name === 'repeat_count')) {
    db.exec('ALTER TABLE doc_templates ADD COLUMN repeat_count INTEGER NOT NULL DEFAULT 1');
  }
  if (!tplCols.some((c) => c.name === 'tile_continuous')) {
    db.exec('ALTER TABLE doc_templates ADD COLUMN tile_continuous INTEGER NOT NULL DEFAULT 0');
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
                        CHECK (status IN ('probationary','regular','suspended','resigned','terminated')),
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
  // (SCHEMA_VERSION 24) A day can now link MORE THAN ONE OT/Half Day/Leave/Undertime/Offset
  // form (e.g. a Half Day AM + an Overtime for the afternoon). Stored as a JSON array of
  // form_records ids; the legacy single form_record_id column is kept and mirrored to the
  // first entry so anything still reading it (CSV export's LEFT JOIN, older code paths) keeps
  // working. Backfilled from the existing single link so nothing already linked is lost.
  if (!arCols.some((c) => c.name === 'form_record_ids')) {
    db.exec('ALTER TABLE attendance_records ADD COLUMN form_record_ids TEXT');
    db.exec(
      `UPDATE attendance_records SET form_record_ids = json_array(form_record_id)
       WHERE form_record_id IS NOT NULL AND form_record_ids IS NULL`
    );
  }
  // (SCHEMA_VERSION 25) The day's lunch-break bracket — split from the raw time_punches on
  // reconcile (importPunchesForPeriod), or hand-typed in the Daily Time grid. Purely for the
  // record / CSV: payroll still subtracts the structural PayrollPolicy.lunch_break_minutes, it
  // never reads these. No backfill — older rows stay null until re-reconciled or edited.
  if (!arCols.some((c) => c.name === 'lunch_out')) {
    db.exec('ALTER TABLE attendance_records ADD COLUMN lunch_out TEXT');
  }
  if (!arCols.some((c) => c.name === 'lunch_in')) {
    db.exec('ALTER TABLE attendance_records ADD COLUMN lunch_in TEXT');
  }
  // (SCHEMA_VERSION 37) HR manually crediting this day as a half day (AM or PM) with no linked
  // Half Day Request behind it — null = no override (default). Distinct from the automatic
  // "possible half day" heuristic (unlinkedHalfDaySession in hr-payroll-compute.ts), which only
  // fires when the raw punch times happen to structurally resemble one of the shift's own AM/PM
  // half windows; this lets HR force the same 0.5-day credit on a day that doesn't. Ignored
  // whenever a real halfday_request IS linked — that always takes precedence. Surfaced
  // separately on the payslip detail (DayBreakdown.half_day_manual) so a reader can tell "HR
  // called this one" apart from either an actual filed request or the auto-detected kind.
  if (!arCols.some((c) => c.name === 'half_day_override')) {
    db.exec('ALTER TABLE attendance_records ADD COLUMN half_day_override TEXT');
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
  // (SCHEMA_VERSION 39) Per-employee "exempt from overtime pay" — for salaried staff (e.g. a
  // supervisor) never entitled to OT regardless of hours worked past their shift. Same
  // "flag-only, never touch the underlying figure" convention as late_exempt: ot_hours still
  // computes and shows on the payslip detail, only the peso overtime_pay is zeroed. See
  // hr-payroll-compute.ts's computeAttendanceForEmployee.
  if (!empCols3.some((c) => c.name === 'ot_exempt')) {
    db.exec('ALTER TABLE employees ADD COLUMN ot_exempt INTEGER NOT NULL DEFAULT 0');
  }
  // (SCHEMA_VERSION 39) A fixed withholding-tax amount for this employee, replacing the
  // computed BIR withholding formula (src/ph-statutory.ts's withholdingTax) every cutoff —
  // e.g. a BIR-registered special/negotiated rate. null (default) = use the normal computed
  // amount. Only takes effect when deduct_withholding_tax is also on — see
  // computeEmployeeStatutory in hr.routes.ts; exempting the employee always wins over an
  // override amount, it doesn't get silently re-applied by clearing the exempt flag.
  if (!empCols3.some((c) => c.name === 'withholding_tax_override')) {
    db.exec('ALTER TABLE employees ADD COLUMN withholding_tax_override REAL');
  }
  // (SCHEMA_VERSION 41) Same fixed-amount override, now for the three contribution funds too —
  // replaces the computed employee-side SSS/PhilHealth/Pag-IBIG contribution with a flat peso
  // figure for this employee (e.g. a negotiated arrangement), still divided across cutoffs the
  // same way the computed amount is. null (default) = use the normal computed amount. Only
  // takes effect while the matching deduct_* switch is also on; the employer-side contribution
  // (remitted regardless of any employee-side arrangement) is never affected by these. See
  // computeEmployeeStatutory in hr.routes.ts.
  for (const col of ['sss_override', 'philhealth_override', 'pagibig_override']) {
    if (!empCols3.some((c) => c.name === col)) {
      db.exec(`ALTER TABLE employees ADD COLUMN ${col} REAL`);
    }
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
  // (SCHEMA_VERSION 40) A checklist now belongs to one stage as a whole (qc_checklists.stage:
  // 1 = QA, 2 = QC) instead of tagging items individually, and a product can point at a
  // QA checklist and a QC checklist independently. Split any pre-40 checklist whose items
  // mixed QA- and QC-tagged checks into two stage-specific checklists first, so existing
  // checks survive the split instead of half of them silently vanishing from one stage.
  const qclCols = db.prepare('PRAGMA table_info(qc_checklists)').all() as { name: string }[];
  if (!qclCols.some((c) => c.name === 'stage')) {
    db.exec('ALTER TABLE qc_checklists ADD COLUMN stage INTEGER NOT NULL DEFAULT 1');
    const legacyChecklists = db.prepare('SELECT id, name, items, is_default, created_by FROM qc_checklists').all() as
      { id: number; name: string; items: string; is_default: number; created_by: number | null }[];
    for (const row of legacyChecklists) {
      let items: { label: string; required?: boolean; stage?: number }[] = [];
      try { items = JSON.parse(row.items || '[]'); } catch { items = []; }
      const strip = (it: { label: string; required?: boolean }) => ({ label: it.label, required: !!it.required });
      const qaItems = items.filter((it) => !it.stage || it.stage === 0 || it.stage === 1).map(strip);
      const qcItems = items.filter((it) => !it.stage || it.stage === 0 || it.stage === 2).map(strip);
      if (qaItems.length && qcItems.length && JSON.stringify(qaItems) !== JSON.stringify(qcItems)) {
        db.prepare('UPDATE qc_checklists SET stage = 1, items = ? WHERE id = ?').run(JSON.stringify(qaItems), row.id);
        db.prepare(
          'INSERT INTO qc_checklists (name, items, stage, is_default, created_by) VALUES (?, ?, 2, ?, ?)'
        ).run(row.name + ' (QC)', JSON.stringify(qcItems), row.is_default, row.created_by);
      } else if (qcItems.length && !qaItems.length) {
        db.prepare('UPDATE qc_checklists SET stage = 2, items = ? WHERE id = ?').run(JSON.stringify(qcItems), row.id);
      } else {
        db.prepare('UPDATE qc_checklists SET stage = 1, items = ? WHERE id = ?').run(JSON.stringify(qaItems), row.id);
      }
    }
  }
  // inventory_items.qc_checklist_id (one checklist for the whole product) becomes the QA
  // slot; qc_checklist_qc_id is new. A fresh install's CREATE TABLE already has both.
  let iiCols = db.prepare('PRAGMA table_info(inventory_items)').all() as { name: string }[];
  if (iiCols.some((c) => c.name === 'qc_checklist_id') && !iiCols.some((c) => c.name === 'qc_checklist_qa_id')) {
    db.exec('ALTER TABLE inventory_items RENAME COLUMN qc_checklist_id TO qc_checklist_qa_id');
    iiCols = db.prepare('PRAGMA table_info(inventory_items)').all() as { name: string }[];
  }
  if (!iiCols.some((c) => c.name === 'qc_checklist_qa_id')) {
    db.exec('ALTER TABLE inventory_items ADD COLUMN qc_checklist_qa_id INTEGER REFERENCES qc_checklists(id) ON DELETE SET NULL');
    iiCols = db.prepare('PRAGMA table_info(inventory_items)').all() as { name: string }[];
  }
  if (!iiCols.some((c) => c.name === 'qc_checklist_qc_id')) {
    db.exec('ALTER TABLE inventory_items ADD COLUMN qc_checklist_qc_id INTEGER REFERENCES qc_checklists(id) ON DELETE SET NULL');
  }
  // (SCHEMA_VERSION 42) Stage order flipped: stage 1 (first pass) is now QC, stage 2 (final
  // pass) is now QA -- was QA-then-QC. Swap the two column NAMES (not the stage each one
  // feeds) so qc_checklist_qa_id keeps meaning "the QA checklist" and qc_checklist_qc_id keeps
  // meaning "the QC checklist"; the data itself stays put, still attached to its original
  // stage. A settings flag guards this since, unlike an ADD COLUMN, a rename isn't detectable
  // by column presence alone.
  if (!getSetting<boolean>('qc_stage_labels_swapped_v42')) {
    db.exec('ALTER TABLE inventory_items RENAME COLUMN qc_checklist_qa_id TO qc_checklist_tmp_id');
    db.exec('ALTER TABLE inventory_items RENAME COLUMN qc_checklist_qc_id TO qc_checklist_qa_id');
    db.exec('ALTER TABLE inventory_items RENAME COLUMN qc_checklist_tmp_id TO qc_checklist_qc_id');
    setSetting('qc_stage_labels_swapped_v42', true);
  }
  // Serialized-unit lifecycle: link a sold / relocated finished unit to its sales order.
  const jouCols = db.prepare('PRAGMA table_info(job_order_units)').all() as { name: string }[];
  if (!jouCols.some((c) => c.name === 'order_id')) {
    db.exec('ALTER TABLE job_order_units ADD COLUMN order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL');
  }

  // (SCHEMA_VERSION 26) QC disposition on a fail + the repair/rework loop.
  // repair_part_requests table itself comes from createSchema().
  if (!jouCols.some((c) => c.name === 'disposition')) {
    db.exec('ALTER TABLE job_order_units ADD COLUMN disposition TEXT');
  }
  if (!qcCols.some((c) => c.name === 'disposition')) {
    db.exec('ALTER TABLE qc_records ADD COLUMN disposition TEXT');
  }

  // (SCHEMA_VERSION 27) First-class production batches. production_batches table
  // itself comes from createSchema().
  if (!jouCols.some((c) => c.name === 'batch_id')) {
    db.exec('ALTER TABLE job_order_units ADD COLUMN batch_id INTEGER REFERENCES production_batches(id) ON DELETE SET NULL');
  }
  if (!qcCols.some((c) => c.name === 'batch_id')) {
    db.exec('ALTER TABLE qc_records ADD COLUMN batch_id INTEGER REFERENCES production_batches(id) ON DELETE CASCADE');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_jou_batch ON job_order_units(batch_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_qc_batch ON qc_records(batch_id)');

  // (SCHEMA_VERSION 28) Production teams + scheduling. production_teams /
  // production_team_members tables come from createSchema().
  const joCols2 = db.prepare('PRAGMA table_info(job_orders)').all() as { name: string }[];
  if (!joCols2.some((c) => c.name === 'team_id')) {
    db.exec('ALTER TABLE job_orders ADD COLUMN team_id INTEGER REFERENCES production_teams(id) ON DELETE SET NULL');
  }
  if (!joCols2.some((c) => c.name === 'planned_start')) db.exec('ALTER TABLE job_orders ADD COLUMN planned_start TEXT');
  if (!joCols2.some((c) => c.name === 'due_date')) db.exec('ALTER TABLE job_orders ADD COLUMN due_date TEXT');
  if (!joCols2.some((c) => c.name === 'priority')) db.exec('ALTER TABLE job_orders ADD COLUMN priority INTEGER NOT NULL DEFAULT 0');
  if (!joCols2.some((c) => c.name === 'work_center')) db.exec('ALTER TABLE job_orders ADD COLUMN work_center TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_job_orders_team ON job_orders(team_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_job_orders_due ON job_orders(due_date)');

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

  // (SCHEMA_VERSION 29) Sale-order release: who released the goods from the warehouse and
  // when, plus a per-line released quantity for non-serialized lines. Serialized finished
  // units earmarked for a SO carry job_order_units.status = 'reserved' (physical stock is
  // only drawn down when the order reaches a confirmed/completed status).
  if (!orderCols2.some((c) => c.name === 'released_at')) {
    db.exec('ALTER TABLE orders ADD COLUMN released_at TEXT');
  }
  if (!orderCols2.some((c) => c.name === 'released_by')) {
    db.exec('ALTER TABLE orders ADD COLUMN released_by INTEGER REFERENCES users(id) ON DELETE SET NULL');
  }
  if (!oiCols.some((c) => c.name === 'released_qty')) {
    db.exec('ALTER TABLE order_items ADD COLUMN released_qty REAL NOT NULL DEFAULT 0');
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
    // (SCHEMA_VERSION 22) Half Days/Undertime Days (PayrollPolicy.whole_day_min_minutes),
    // Undertime Day Pay, Night Differential, and itemized Other Deductions — same surgical,
    // admin-customization-preserving touch-up as the two checks above.
    if (!body.includes('{{days_half}}') && body.includes('<span class="l">Days Absent:</span><span class="v">{{days_absent}}</span></div>')) {
      body = body.replace(
        '<span class="l">Days Absent:</span><span class="v">{{days_absent}}</span></div>',
        '<span class="l">Days Absent:</span><span class="v">{{days_absent}}</span></div>\n  <div class="slip-row"><span class="l">Half Days:</span><span class="v">{{days_half}}</span></div>\n  <div class="slip-row"><span class="l">Undertime Days:</span><span class="v">{{days_undertime}}</span></div>'
      );
      touched = true;
    }
    if (!body.includes('{{undertime_day_pay}}') && body.includes('<span>Undertime</span><span>{{undertime_pay}}</span></div>')) {
      body = body.replace(
        '<span>Undertime</span><span>{{undertime_pay}}</span></div>',
        '<span>Undertime</span><span>{{undertime_pay}}</span></div>\n      <div class="slip-line"><span>Undertime Day Pay</span><span>{{undertime_day_pay}}</span></div>'
      );
      touched = true;
    }
    if (!body.includes('{{night_diff_pay}}') && body.includes('<span>Rest Day OT</span><span>{{rest_day_ot}}</span></div>')) {
      body = body.replace(
        '<span>Rest Day OT</span><span>{{rest_day_ot}}</span></div>',
        '<span>Rest Day OT</span><span>{{rest_day_ot}}</span></div>\n      <div class="slip-line"><span>Night Differential</span><span>{{night_diff_pay}}</span></div>'
      );
      touched = true;
    }
    if (!body.includes('{{#other_deductions}}') && body.includes('<span>Cash Advance</span><span>{{cash_advance}}</span></div>')) {
      body = body.replace(
        '<span>Cash Advance</span><span>{{cash_advance}}</span></div>',
        '<span>Cash Advance</span><span>{{cash_advance}}</span></div>\n      {{#other_deductions}}<div class="slip-line"><span>{{label}}</span><span>{{amount}}</span></div>{{/other_deductions}}'
      );
      touched = true;
    }
    // (SCHEMA_VERSION 23) The dedicated always-on "Cash Advance" deduction row is gone — a cash
    // advance is now just one of the itemized Other Deductions lines (see the payroll detail
    // view's "Other Deductions" editor / hr.routes.ts recomputeDeductionsFor), so an all-zero
    // row no longer clutters every slip. Any legacy non-zero top-level cash_advance still shows,
    // folded into the itemized list by hr-payroll-print.js's buildSlipContext. Drop just that
    // element (with its own leading newline+indent from the seed), leaving surrounding markup —
    // and the {{#other_deductions}} loop the SCHEMA_VERSION 22 step above just added — intact.
    if (body.includes('<span>Cash Advance</span><span>{{cash_advance}}</span></div>')) {
      body = body
        .replace('\n      <div class="slip-line"><span>Cash Advance</span><span>{{cash_advance}}</span></div>', '')
        .replace(/\s*<div[^>]*><span>Cash Advance<\/span><span>\{\{cash_advance\}\}<\/span><\/div>/, '');
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

  // (SCHEMA_VERSION 31) Production team members are tracked by HR employee, not login
  // account — most floor workers have no system account at all. Rebuild the table (SQLite
  // can't change a column's FK target in place); a pre-existing row only carries across if
  // its user has a linked employee record (employees.user_id) — anything else has nothing
  // to migrate to and is dropped.
  const ptmCols = db.prepare('PRAGMA table_info(production_team_members)').all() as { name: string }[];
  if (ptmCols.length && !ptmCols.some((c) => c.name === 'employee_id')) {
    db.exec('PRAGMA foreign_keys = OFF;');
    db.exec(`
      BEGIN;
      CREATE TABLE production_team_members_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        team_id     INTEGER NOT NULL REFERENCES production_teams(id) ON DELETE CASCADE,
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        role        TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(team_id, employee_id)
      );
      INSERT INTO production_team_members_new (id, team_id, employee_id, role, created_at)
        SELECT m.id, m.team_id, e.id, m.role, m.created_at
        FROM production_team_members m JOIN employees e ON e.user_id = m.user_id;
      DROP TABLE production_team_members;
      ALTER TABLE production_team_members_new RENAME TO production_team_members;
      CREATE INDEX IF NOT EXISTS idx_ptm_team ON production_team_members(team_id);
      COMMIT;
    `);
    db.exec('PRAGMA foreign_keys = ON;');
  }

  // (SCHEMA_VERSION 44) Chat-style reply / edit / sender-only soft "unsend" on messages.
  // message_reactions / link_previews themselves come from createSchema().
  const msgCols = db.prepare('PRAGMA table_info(messages)').all() as { name: string }[];
  if (!msgCols.some((c) => c.name === 'reply_to_id')) {
    db.exec('ALTER TABLE messages ADD COLUMN reply_to_id INTEGER REFERENCES messages(id) ON DELETE SET NULL');
  }
  if (!msgCols.some((c) => c.name === 'edited_at')) {
    db.exec('ALTER TABLE messages ADD COLUMN edited_at TEXT');
  }
  if (!msgCols.some((c) => c.name === 'deleted_at')) {
    db.exec('ALTER TABLE messages ADD COLUMN deleted_at TEXT');
  }
  if (!msgCols.some((c) => c.name === 'deleted_by')) {
    db.exec('ALTER TABLE messages ADD COLUMN deleted_by INTEGER REFERENCES users(id) ON DELETE SET NULL');
  }

  // (SCHEMA_VERSION 65) Keep attachment bytes with the message so a replaced app
  // filesystem cannot silently break photos that still appear in a conversation.
  const attachmentCols = db.prepare('PRAGMA table_info(message_attachments)').all() as { name: string }[];
  if (!attachmentCols.some((c) => c.name === 'data')) {
    db.exec('ALTER TABLE message_attachments ADD COLUMN data BLOB');
  }

  // (SCHEMA_VERSION 45) Production lead accepts a released job order's parts kit.
  const joAccCols = db.prepare('PRAGMA table_info(job_orders)').all() as { name: string }[];
  if (!joAccCols.some((c) => c.name === 'accepted_by')) {
    db.exec('ALTER TABLE job_orders ADD COLUMN accepted_by INTEGER REFERENCES users(id) ON DELETE SET NULL');
  }
  if (!joAccCols.some((c) => c.name === 'accepted_at')) {
    db.exec('ALTER TABLE job_orders ADD COLUMN accepted_at TEXT');
  }
  if (!joAccCols.some((c) => c.name === 'accept_notes')) {
    db.exec('ALTER TABLE job_orders ADD COLUMN accept_notes TEXT');
  }

  // (SCHEMA_VERSION 46) Phone time-in location lock: the per-employee exemption, and where each
  // phone punch came from. Kiosk punches leave the location columns NULL (the kiosk is on-site).
  const empGeoCols = db.prepare('PRAGMA table_info(employees)').all() as { name: string }[];
  if (!empGeoCols.some((c) => c.name === 'clock_anywhere')) {
    db.exec('ALTER TABLE employees ADD COLUMN clock_anywhere INTEGER NOT NULL DEFAULT 0');
  }
  const punchGeoCols = db.prepare('PRAGMA table_info(time_punches)').all() as { name: string }[];
  for (const [col, decl] of [['lat', 'REAL'], ['lng', 'REAL'], ['accuracy_m', 'REAL'], ['distance_m', 'REAL'], ['geo_site', 'TEXT']]) {
    if (!punchGeoCols.some((c) => c.name === col)) db.exec(`ALTER TABLE time_punches ADD COLUMN ${col} ${decl}`);
  }

  // (SCHEMA_VERSION 62) Temporary owner recovery passwords require replacement.
  const recoveryUserCols = db.prepare('PRAGMA table_info(users)').all() as { name: string }[];
  if (!recoveryUserCols.some((c) => c.name === 'password_change_required')) {
    db.exec('ALTER TABLE users ADD COLUMN password_change_required INTEGER NOT NULL DEFAULT 0');
  }
  if (!recoveryUserCols.some((c) => c.name === 'temporary_password_expires_at')) {
    db.exec('ALTER TABLE users ADD COLUMN temporary_password_expires_at TEXT');
  }

  // (SCHEMA_VERSION 47) Approved time-in kiosk devices (src/modules/hr/kiosk-devices.ts). Only a
  // SHA-256 of each device's token is kept; revoking sets revoked_at rather than deleting, so the
  // list of who approved what stays on record.
  db.exec(`
    CREATE TABLE IF NOT EXISTS kiosk_devices (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT NOT NULL,
      token_hash   TEXT NOT NULL UNIQUE,
      created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT,
      revoked_at   TEXT
    )
  `);

  // (SCHEMA_VERSION 48) Sale-order releasing: the warehouse accepts an approved SO before
  // picking, and a release slip records what physically left (and is when stock goes out).
  const ordRelCols = db.prepare('PRAGMA table_info(orders)').all() as { name: string }[];
  if (!ordRelCols.some((c) => c.name === 'warehouse_accepted_by')) {
    db.exec('ALTER TABLE orders ADD COLUMN warehouse_accepted_by INTEGER REFERENCES users(id) ON DELETE SET NULL');
  }
  if (!ordRelCols.some((c) => c.name === 'warehouse_accepted_at')) {
    db.exec('ALTER TABLE orders ADD COLUMN warehouse_accepted_at TEXT');
    // SOs already mid-release predate the acceptance step — don't block their picking.
    db.exec(`UPDATE orders SET warehouse_accepted_at = COALESCE(released_at, updated_at, datetime('now')),
               warehouse_accepted_by = released_by
             WHERE type = 'sale' AND LOWER(status) IN ('approved', 'released')`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS release_slips (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      number         TEXT NOT NULL UNIQUE,
      order_id       INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      released_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      released_at    TEXT NOT NULL DEFAULT (datetime('now')),
      collected_by   TEXT,
      vehicle_plate  TEXT,
      notes          TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_release_slips_order ON release_slips(order_id);
    CREATE TABLE IF NOT EXISTS release_slip_items (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      slip_id          INTEGER NOT NULL REFERENCES release_slips(id) ON DELETE CASCADE,
      order_item_id    INTEGER,
      item_id          INTEGER,
      name             TEXT NOT NULL,
      sku              TEXT,
      unit             TEXT,
      quantity         REAL NOT NULL,
      unit_identifiers TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_release_slip_items_slip ON release_slip_items(slip_id);
  `);

  // v67: a return is a physical receiving/inspection record. Credit notes remain a
  // separate accounting decision; neither a receipt nor a rejected item changes stock.
  const slipItemCols = db.prepare('PRAGMA table_info(release_slip_items)').all() as { name: string }[];
  if (!slipItemCols.some((c) => c.name === 'unit_cost')) db.exec('ALTER TABLE release_slip_items ADD COLUMN unit_cost REAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sales_returns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      number TEXT NOT NULL UNIQUE,
      slip_id INTEGER NOT NULL REFERENCES release_slips(id) ON DELETE RESTRICT,
      slip_item_id INTEGER NOT NULL REFERENCES release_slip_items(id) ON DELETE RESTRICT,
      item_id INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
      quantity REAL NOT NULL CHECK (quantity > 0),
      unit_id INTEGER REFERENCES job_order_units(id) ON DELETE RESTRICT,
      unit_cost REAL,
      status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','restocked','rejected')),
      reason TEXT NOT NULL,
      condition_note TEXT,
      location_id INTEGER REFERENCES locations(id) ON DELETE RESTRICT,
      credit_note_id INTEGER UNIQUE REFERENCES credit_notes(id) ON DELETE RESTRICT,
      received_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      received_at TEXT NOT NULL DEFAULT (datetime('now')),
      inspected_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      inspected_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sales_returns_slip_item ON sales_returns(slip_item_id);
    CREATE INDEX IF NOT EXISTS idx_sales_returns_slip ON sales_returns(slip_id);
    CREATE TABLE IF NOT EXISTS sales_return_credit_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      return_id INTEGER NOT NULL REFERENCES sales_returns(id) ON DELETE RESTRICT,
      credit_note_id INTEGER NOT NULL REFERENCES credit_notes(id) ON DELETE RESTRICT,
      linked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      linked_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(return_id, credit_note_id)
    );
  `);

  // v68: rejected customer goods stay outside sellable stock while they are repaired,
  // salvaged, or disposed. This lifecycle is separate from the original job-order receipt.
  db.exec(`
    CREATE TABLE IF NOT EXISTS sales_return_dispositions (
      return_id INTEGER PRIMARY KEY REFERENCES sales_returns(id) ON DELETE RESTRICT,
      state TEXT NOT NULL CHECK (state IN ('repair','awaiting_inspection','completed','salvaged','disposed')),
      decision_note TEXT NOT NULL,
      repair_note TEXT,
      location_id INTEGER REFERENCES locations(id) ON DELETE RESTRICT,
      decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      decided_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS sales_return_disposition_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      return_id INTEGER NOT NULL REFERENCES sales_returns(id) ON DELETE RESTRICT,
      action TEXT NOT NULL,
      note TEXT NOT NULL,
      actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sales_return_disposition_events_return
      ON sales_return_disposition_events(return_id, id);
  `);
  const repairReturnCols = db.prepare('PRAGMA table_info(repair_part_requests)').all() as { name: string }[];
  if (!repairReturnCols.some((c) => c.name === 'sales_return_id')) {
    db.exec('ALTER TABLE repair_part_requests ADD COLUMN sales_return_id INTEGER REFERENCES sales_returns(id) ON DELETE RESTRICT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_repair_part_requests_sales_return ON repair_part_requests(sales_return_id)');

  // (SCHEMA_VERSION 49) Job-order approval before the warehouse releases parts.
  const joApvCols = db.prepare('PRAGMA table_info(job_orders)').all() as { name: string }[];
  for (const [col, decl] of [
    ['approved_by', 'INTEGER REFERENCES users(id) ON DELETE SET NULL'], ['approved_at', 'TEXT'], ['approve_notes', 'TEXT'],
  ]) {
    if (!joApvCols.some((c) => c.name === col)) db.exec(`ALTER TABLE job_orders ADD COLUMN ${col} ${decl}`);
  }

  // (SCHEMA_VERSION 50) Job-order parts release (warehouse accept → prepare → slip), pause
  // reason, and production issue reports.
  const joWhCols = db.prepare('PRAGMA table_info(job_orders)').all() as { name: string }[];
  for (const [col, decl] of [
    ['warehouse_accepted_by', 'INTEGER REFERENCES users(id) ON DELETE SET NULL'], ['warehouse_accepted_at', 'TEXT'],
    ['prepared_by', 'INTEGER REFERENCES users(id) ON DELETE SET NULL'], ['prepared_at', 'TEXT'],
    ['paused_by', 'INTEGER REFERENCES users(id) ON DELETE SET NULL'], ['paused_at', 'TEXT'], ['pause_reason', 'TEXT'],
  ]) {
    if (!joWhCols.some((c) => c.name === col)) db.exec(`ALTER TABLE job_orders ADD COLUMN ${col} ${decl}`);
  }
  const jocPickCols = db.prepare('PRAGMA table_info(job_order_components)').all() as { name: string }[];
  if (!jocPickCols.some((c) => c.name === 'qty_picked')) {
    db.exec('ALTER TABLE job_order_components ADD COLUMN qty_picked INTEGER NOT NULL DEFAULT 0');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS parts_release_slips (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      number        TEXT NOT NULL UNIQUE,
      job_order_id  INTEGER NOT NULL UNIQUE REFERENCES job_orders(id) ON DELETE CASCADE,
      released_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      released_at   TEXT NOT NULL DEFAULT (datetime('now')),
      received_by   TEXT,
      notes         TEXT
    );
    CREATE TABLE IF NOT EXISTS parts_release_slip_items (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      slip_id           INTEGER NOT NULL REFERENCES parts_release_slips(id) ON DELETE CASCADE,
      component_item_id INTEGER,
      name              TEXT NOT NULL,
      sku               TEXT,
      unit              TEXT,
      quantity          REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_parts_release_slip_items_slip ON parts_release_slip_items(slip_id);
    CREATE TABLE IF NOT EXISTS production_issues (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      job_order_id  INTEGER NOT NULL REFERENCES job_orders(id) ON DELETE CASCADE,
      unit_id       INTEGER REFERENCES job_order_units(id) ON DELETE SET NULL,
      category      TEXT NOT NULL,
      severity      TEXT NOT NULL DEFAULT 'normal' CHECK (severity IN ('low','normal','high','critical')),
      description   TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
      resolution    TEXT,
      reported_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      resolved_at   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_production_issues_jo ON production_issues(job_order_id);
    CREATE INDEX IF NOT EXISTS idx_production_issues_unit ON production_issues(unit_id);
  `);

  // (SCHEMA_VERSION 51) Phone punch holds: the QR scan (step 1) waits here for the selfie
  // (step 2), which records the punch at scanned_at. Short-lived; used or expired rows are deleted.
  db.exec(`
    CREATE TABLE IF NOT EXISTS time_punch_holds (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      scanned_at  TEXT NOT NULL,     -- office-local 'YYYY-MM-DD HH:MM:SS' -- becomes the punch's ts
      scanned_ms  INTEGER NOT NULL,  -- epoch ms of the same moment, for expiry
      source      TEXT NOT NULL,     -- 'phone' (QR) | 'remote' (clock_anywhere, no QR)
      lat         REAL,
      lng         REAL,
      accuracy_m  REAL,
      distance_m  REAL,
      geo_site    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_punch_holds_emp ON time_punch_holds(employee_id);
  `);

  // (SCHEMA_VERSION 52) Birth date + civil status on the employee record.
  const empPersonalCols = db.prepare('PRAGMA table_info(employees)').all() as { name: string }[];
  if (!empPersonalCols.some((c) => c.name === 'birth_date')) db.exec('ALTER TABLE employees ADD COLUMN birth_date TEXT');
  if (!empPersonalCols.some((c) => c.name === 'civil_status')) db.exec('ALTER TABLE employees ADD COLUMN civil_status TEXT');

  // (SCHEMA_VERSION 53) 'suspended' employee status. Rebuilt from the table's own stored CREATE
  // statement (every column added by ALTER over the years is already in it) with only the status
  // CHECK widened, so no column list is repeated here to drift. Indexes are re-created from
  // their stored SQL; employees has no triggers or views. Foreign keys OFF for the same reason as
  // the older employees rebuild above.
  const empTableSql = (db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='employees'"
  ).get() as { sql: string } | undefined)?.sql ?? '';
  // No status CHECK at all (a very old hand-shaped table) already accepts 'suspended' — no rebuild.
  const statusCheck = /CHECK\s*\(\s*status\s+IN\s*\(([^)]*)\)\s*\)/;
  if (statusCheck.test(empTableSql) && !empTableSql.includes("'suspended'")) {
    const createNew = empTableSql
      .replace(/^CREATE TABLE\s+"?employees"?\s*\(/, 'CREATE TABLE employees_new (')
      .replace(statusCheck, (_m, list: string) => `CHECK (status IN (${list.replace("'regular'", "'regular','suspended'")}))`);
    if (!createNew.startsWith('CREATE TABLE employees_new (') || !createNew.includes("'suspended'")) {
      throw new Error('Cannot add the suspended employee status: unexpected employees table definition.');
    }
    const indexSql = (db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='employees' AND sql IS NOT NULL"
    ).all() as { sql: string }[]).map((r) => r.sql);
    db.exec('PRAGMA foreign_keys = OFF;');
    try {
      db.exec('BEGIN;');
      db.exec(createNew);
      db.exec('INSERT INTO employees_new SELECT * FROM employees;');
      db.exec('DROP TABLE employees;');
      db.exec('ALTER TABLE employees_new RENAME TO employees;');
      for (const sql of indexSql) db.exec(sql);
      db.exec('COMMIT;');
    } catch (e) {
      db.exec('ROLLBACK;');
      throw e;
    } finally {
      db.exec('PRAGMA foreign_keys = ON;');
    }
  }

  // (SCHEMA_VERSION 54) Date of Birth row on the insert-only "BIR 2316" template. Inserted after
  // the untouched default TIN row only; a template edited so that row is gone is left alone.
  // (A fresh install has no template yet here — seed() inserts the new body.)
  const tpl2316 = db.prepare("SELECT id, body FROM doc_templates WHERE name = 'BIR 2316'").get() as
    { id: number; body: string } | undefined;
  const tinRow = '<span class="v">{{employee.tin_no}}</span></div>';
  if (tpl2316 && !tpl2316.body.includes('employee.birth_date') && tpl2316.body.includes(tinRow)) {
    db.prepare("UPDATE doc_templates SET body = ?, updated_at = datetime('now') WHERE id = ?").run(
      tpl2316.body.replace(tinRow, tinRow +
        '\n  <div class="row"><span class="l">Date of Birth (MM/DD/YYYY)</span><span class="v">{{employee.birth_date_mdy}}</span></div>'),
      tpl2316.id
    );
  }

  // (SCHEMA_VERSION 55) Session + device tracking. Existing sessions get a random sid and stay
  // valid; their device/IP columns stay NULL until they sign in again.
  const sessCols = db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
  const addSessCol = (name: string, ddl: string) => {
    if (!sessCols.some((c) => c.name === name)) db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${ddl}`);
  };
  addSessCol('sid', 'TEXT');
  addSessCol('device_id', 'TEXT');
  addSessCol('ip', 'TEXT');
  addSessCol('user_agent', 'TEXT');
  addSessCol('last_seen_at', 'TEXT');
  addSessCol('last_ip', 'TEXT');
  addSessCol('shared', 'INTEGER NOT NULL DEFAULT 0');
  addSessCol('idle_minutes', 'INTEGER');
  addSessCol('ended_at', 'TEXT');
  addSessCol('end_reason', 'TEXT');
  db.exec("UPDATE sessions SET sid = lower(hex(randomblob(8))) WHERE sid IS NULL");
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_sid ON sessions(sid)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_device ON sessions(device_id)');

  const actCols = db.prepare('PRAGMA table_info(activity_log)').all() as { name: string }[];
  if (!actCols.some((c) => c.name === 'device_id')) db.exec('ALTER TABLE activity_log ADD COLUMN device_id TEXT');
  if (!actCols.some((c) => c.name === 'device')) db.exec('ALTER TABLE activity_log ADD COLUMN device TEXT');

  const pushCols = db.prepare('PRAGMA table_info(push_subscriptions)').all() as { name: string }[];
  if (!pushCols.some((c) => c.name === 'device_id')) db.exec('ALTER TABLE push_subscriptions ADD COLUMN device_id TEXT');

  const punchDevCols = db.prepare('PRAGMA table_info(time_punches)').all() as { name: string }[];
  if (!punchDevCols.some((c) => c.name === 'device_id')) db.exec('ALTER TABLE time_punches ADD COLUMN device_id TEXT');
  if (!punchDevCols.some((c) => c.name === 'device_flag')) db.exec('ALTER TABLE time_punches ADD COLUMN device_flag TEXT');
  if (!punchDevCols.some((c) => c.name === 'device_user_id')) {
    db.exec('ALTER TABLE time_punches ADD COLUMN device_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
  }

  // (SCHEMA_VERSION 56) ₱0 rate-history rows ahead of an employee's first real rate take that
  // rate — from their first non-zero history row, else (rate set by CSV import, which never
  // logged history before) their current employees.daily_rate. Idempotent.
  const unsetRate = db.prepare(
    `SELECT DISTINCT h.employee_id FROM employee_rate_history h
      WHERE h.daily_rate = 0
        AND NOT EXISTS (SELECT 1 FROM employee_rate_history p
                         WHERE p.employee_id = h.employee_id AND p.daily_rate > 0 AND p.effective_from < h.effective_from)`
  ).all() as { employee_id: number }[];
  for (const { employee_id } of unsetRate) {
    const first = (db.prepare(
      `SELECT rate_type, daily_rate, monthly_rate FROM employee_rate_history
        WHERE employee_id = ? AND daily_rate > 0 ORDER BY effective_from LIMIT 1`
    ).get(employee_id) ?? db.prepare(
      'SELECT rate_type, daily_rate, monthly_rate FROM employees WHERE id = ? AND daily_rate > 0'
    ).get(employee_id)) as { rate_type: string; daily_rate: number; monthly_rate: number | null } | undefined;
    if (!first) continue;
    db.prepare(
      `UPDATE employee_rate_history SET rate_type = ?, daily_rate = ?, monthly_rate = ?
        WHERE employee_id = ? AND daily_rate = 0
          AND NOT EXISTS (SELECT 1 FROM employee_rate_history p
                           WHERE p.employee_id = employee_rate_history.employee_id
                             AND p.daily_rate > 0 AND p.effective_from < employee_rate_history.effective_from)`
    ).run(first.rate_type, first.daily_rate, first.monthly_rate, employee_id);
  }

  // (SCHEMA_VERSION 57) Per-employee "always a whole day": a day with both a time-in and a
  // time-out pays the full daily basic whatever the times. Default 0 (ordinary rules).
  const empWholeDayCols = db.prepare('PRAGMA table_info(employees)').all() as { name: string }[];
  if (!empWholeDayCols.some((c) => c.name === 'always_whole_day')) {
    db.exec('ALTER TABLE employees ADD COLUMN always_whole_day INTEGER NOT NULL DEFAULT 0');
  }

  // (SCHEMA_VERSION 58) Which pay SSS / Pag-IBIG are computed on: 'actual' (default — the
  // month's actual remuneration, RA 11199 / RA 9679) or 'fixed' (the employee's fixed monthly
  // rate, chosen in Accounting → Statutory Deductions once the employee agrees in writing).
  if (!empWholeDayCols.some((c) => c.name === 'contribution_basis')) {
    db.exec("ALTER TABLE employees ADD COLUMN contribution_basis TEXT NOT NULL DEFAULT 'actual'");
  }

  // (SCHEMA_VERSION 59) Pay became its own permissions (payroll.view / payroll.manage,
  // modules/payroll/pay-access.ts). Whoever could see / manage HR before keeps seeing / running
  // payroll: roles holding hr.view / hr.manage, and per-account grants of them. Once only (flag),
  // so an admin who later takes pay away from a role doesn't get it handed back on an upgrade.
  if (!getSetting<boolean>('migrated_payroll_permission_split')) {
    // The AI search index stored every form record (payslips included) under forms.view; drop
    // those chunks and mark it stale so the next search rebuilds them with modules/ai/rag.ts's
    // per-form ACL (payroll.view for payslips).
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'doc_chunks'").get()) {
      db.exec("DELETE FROM doc_chunks WHERE source_type = 'form_record'");
    }
    db.prepare("DELETE FROM settings WHERE key = 'rag_indexed_at'").run();
  }
  grantOnce('migrated_payroll_permission_split', [['hr.view', 'payroll.view'], ['hr.manage', 'payroll.manage']]);

  // (SCHEMA_VERSION 60) The production screens got their own read permission (production.view);
  // they used to share inventory.view. Same once-only grant as the pay split above.
  grantOnce('migrated_production_view_split', [['inventory.view', 'production.view']]);

  // (SCHEMA_VERSION 61) Purchase orders, goods receipts and vendor bills got their own pair
  // (purchasing.view / purchasing.manage — inventory/order-access.ts); they used orders.*.
  grantOnce('migrated_purchasing_split', [
    ['orders.view', 'purchasing.view'], ['orders.create', 'purchasing.manage'], ['orders.edit', 'purchasing.manage'],
  ]);

  // (SCHEMA_VERSION 66) Preserve surviving older uploads before the next filesystem
  // replacement. Only files still referenced by a record enter the durable store.
  if ((getSetting<number>('schema_version') ?? 0) < 66) {
    const slug = tenantStore.getStore()?.slug ?? DEFAULT_TENANT;
    const tenantPart = slug === DEFAULT_TENANT ? '' : slug;
    const roots = [backupDir(), mirrorDir()].filter((root): root is string => !!root);
    const source = (name: string): string | null => {
      if (!name || path.basename(name) !== name || name.startsWith('.')) return null;
      const primary = path.join(uploadDir(), name);
      if (fs.existsSync(primary)) return primary;
      for (const root of roots) {
        const candidate = path.join(root, 'uploads', tenantPart, name);
        if (fs.existsSync(candidate)) return candidate;
      }
      return null;
    };
    const keep = db.prepare('INSERT OR IGNORE INTO durable_uploads (name, data, size_bytes) VALUES (?, ?, ?)');
    for (const [table, column, prefix] of [
      ['forms', 'stored_name', ''], ['employee_documents', 'stored_name', ''],
      ['attachments', 'image_path', ''], ['inventory_items', 'image_path', ''],
      ['bug_report_attachments', 'stored_name', ''], ['punch_photos', 'file_name', 'kiosk-punches/'],
    ]) {
      for (const row of db.prepare(`SELECT ${column} AS name FROM ${table} WHERE ${column} IS NOT NULL`).all() as Array<{ name: string }>) {
        if (!row.name || path.basename(row.name) !== row.name || row.name.startsWith('.')) continue;
        const fileName = `${prefix}${row.name}`;
        const rootName = prefix ? row.name : fileName;
        const file = prefix ? [path.join(uploadDir(), prefix, rootName), ...roots.map((root) => path.join(root, 'uploads', tenantPart, prefix, rootName))].find((p) => fs.existsSync(p)) : source(rootName);
        if (file) { const bytes = fs.readFileSync(file); keep.run(fileName, bytes, bytes.length); }
      }
    }
    for (const row of db.prepare('SELECT id, stored_name FROM message_attachments WHERE data IS NULL').all() as Array<{ id: number; stored_name: string }>) {
      const file = source(row.stored_name);
      if (file) db.prepare('UPDATE message_attachments SET data = ? WHERE id = ?').run(fs.readFileSync(file), row.id);
    }
    const aiDirs = [uploadDir(), ...roots.map((root) => path.join(root, 'uploads', tenantPart))];
    for (const name of new Set(aiDirs.filter((dir) => fs.existsSync(dir)).flatMap((dir) => fs.readdirSync(dir)))) {
      if (!/^ai-report-[A-Za-z0-9-]+\.(html|docx)$/.test(name)) continue;
      const file = source(name);
      if (file) { const bytes = fs.readFileSync(file); keep.run(name, bytes, bytes.length); }
    }
    // Pending offline commands can still reference blobs created before this upgrade.
    const blobDirs = aiDirs.map((dir) => path.join(dir, '.sync-blobs'));
    for (const name of new Set(blobDirs.filter((dir) => fs.existsSync(dir)).flatMap((dir) => fs.readdirSync(dir)))) {
      if (!/^[0-9a-f]{64}$/.test(name)) continue;
      const file = blobDirs.map((dir) => path.join(dir, name)).find((candidate) => fs.existsSync(candidate));
      if (file) { const bytes = fs.readFileSync(file); keep.run(`.sync-blobs/${name}`, bytes, bytes.length); }
    }
  }
  // (SCHEMA_VERSION 69) New releases snapshot the exact QC and QA requirements. Older
  // released jobs have no reliable historical checklist version, so their null snapshots
  // keep the previous live-resolution behavior until completed.
  const joChecklistCols = db.prepare('PRAGMA table_info(job_orders)').all() as Array<{ name: string }>;
  for (const col of ['qc_checklist_qc_snapshot', 'qc_checklist_qa_snapshot']) {
    if (!joChecklistCols.some((c) => c.name === col)) db.exec(`ALTER TABLE job_orders ADD COLUMN ${col} TEXT`);
  }
  const idemCols = db.prepare('PRAGMA table_info(idempotency_keys)').all() as Array<{ name: string }>;
  if (!idemCols.some((c) => c.name === 'request_hash')) db.exec('ALTER TABLE idempotency_keys ADD COLUMN request_hash TEXT');
  // 74: one sale SKU can ship as a built unit or as its frozen CKD component list.
  const saleLineCols = db.prepare('PRAGMA table_info(order_items)').all() as Array<{ name: string }>;
  if (!saleLineCols.some((c) => c.name === 'fulfillment_mode'))
    db.exec("ALTER TABLE order_items ADD COLUMN fulfillment_mode TEXT NOT NULL DEFAULT 'assembled'");
  if (!saleLineCols.some((c) => c.name === 'parent_order_item_id'))
    db.exec('ALTER TABLE order_items ADD COLUMN parent_order_item_id INTEGER REFERENCES order_items(id) ON DELETE CASCADE');
  db.exec('CREATE INDEX IF NOT EXISTS idx_order_items_parent ON order_items(parent_order_item_id)');
  const saleUnitCols = db.prepare('PRAGMA table_info(job_order_units)').all() as Array<{ name: string }>;
  if (!saleUnitCols.some((c) => c.name === 'order_item_id')) db.exec('ALTER TABLE job_order_units ADD COLUMN order_item_id INTEGER REFERENCES order_items(id) ON DELETE SET NULL');
  if (!saleUnitCols.some((c) => c.name === 'direct_sold_at')) db.exec('ALTER TABLE job_order_units ADD COLUMN direct_sold_at TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_sale_unit_line ON job_order_units(order_item_id,status)');
  db.exec(`UPDATE job_order_units AS u SET order_item_id = (
    SELECT oi.id FROM order_items oi WHERE oi.order_id = u.order_id AND oi.item_id = u.product_item_id
      AND oi.fulfillment_mode NOT IN ('ckd', 'ckd_component') LIMIT 1)
    WHERE u.order_item_id IS NULL AND u.order_id IS NOT NULL AND u.status IN ('reserved', 'sold')
      AND (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = u.order_id AND oi.item_id = u.product_item_id
        AND oi.fulfillment_mode NOT IN ('ckd', 'ckd_component')) = 1`);
  const saleBatchCols = db.prepare('PRAGMA table_info(production_batch_allocations)').all() as Array<{ name: string }>;
  if (!saleBatchCols.some((c) => c.name === 'order_item_id')) db.exec('ALTER TABLE production_batch_allocations ADD COLUMN order_item_id INTEGER REFERENCES order_items(id) ON DELETE SET NULL');
  db.exec('CREATE INDEX IF NOT EXISTS idx_sale_batch_line ON production_batch_allocations(order_item_id,state)');
  db.exec(`UPDATE production_batch_allocations AS a SET order_item_id = (
    SELECT oi.id FROM order_items oi WHERE oi.order_id = a.order_id AND oi.item_id = a.item_id
      AND oi.fulfillment_mode != 'ckd' LIMIT 1)
    WHERE a.order_item_id IS NULL
      AND (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = a.order_id AND oi.item_id = a.item_id
        AND oi.fulfillment_mode != 'ckd') = 1`);
  const deliveryCols = db.prepare('PRAGMA table_info(deliveries)').all() as Array<{ name: string }>;
  if (!deliveryCols.some((c) => c.name === 'delivery_mode')) db.exec("ALTER TABLE deliveries ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'own'");
  if (!deliveryCols.some((c) => c.name === 'courier_name')) db.exec('ALTER TABLE deliveries ADD COLUMN courier_name TEXT');
  if (!deliveryCols.some((c) => c.name === 'tracking_number')) db.exec('ALTER TABLE deliveries ADD COLUMN tracking_number TEXT');
  // 75: keep fully and semi-built stock distinct while retaining one commercial SKU.
  const buildCols = db.prepare('PRAGMA table_info(job_orders)').all() as Array<{ name: string }>;
  if (!buildCols.some((c) => c.name === 'build_mode'))
    db.exec("ALTER TABLE job_orders ADD COLUMN build_mode TEXT NOT NULL DEFAULT 'assembled'");
  db.exec(`CREATE TABLE IF NOT EXISTS inventory_variant_stock (
    item_id INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
    location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
    build_mode TEXT NOT NULL CHECK (build_mode IN ('assembled', 'semi_built')),
    quantity REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (item_id, location_id, build_mode))`);
  if (!getSetting<boolean>('variant_stock_seeded')) {
    db.exec(`INSERT OR IGNORE INTO inventory_variant_stock (item_id, location_id, build_mode, quantity)
      SELECT item_id, location_id, 'assembled', quantity FROM inventory_stock`);
    setSetting('variant_stock_seeded', true);
  }
  // A semi-built package contains the whole kit. Finishing it changes the build
  // state of that physical unit; it must never issue the BOM components again.
  db.exec(`CREATE TABLE IF NOT EXISTS semi_build_conversions (
    job_order_id INTEGER PRIMARY KEY REFERENCES job_orders(id) ON DELETE CASCADE,
    source_unit_id INTEGER REFERENCES job_order_units(id) ON DELETE RESTRICT,
    source_batch_id INTEGER REFERENCES production_batches(id) ON DELETE RESTRICT,
    source_cost REAL NOT NULL DEFAULT 0,
    finishing_cost REAL NOT NULL DEFAULT 0,
    cancel_reason TEXT,
    cancelled_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    cancelled_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const conversionCols = db.prepare('PRAGMA table_info(semi_build_conversions)').all() as Array<{ name: string }>;
  if (!conversionCols.some((c) => c.name === 'source_batch_id')) db.exec('ALTER TABLE semi_build_conversions ADD COLUMN source_batch_id INTEGER REFERENCES production_batches(id) ON DELETE RESTRICT');
  if (!conversionCols.some((c) => c.name === 'cancel_reason')) db.exec('ALTER TABLE semi_build_conversions ADD COLUMN cancel_reason TEXT');
  if (!conversionCols.some((c) => c.name === 'cancelled_by')) db.exec('ALTER TABLE semi_build_conversions ADD COLUMN cancelled_by INTEGER REFERENCES users(id) ON DELETE SET NULL');
  if (!conversionCols.some((c) => c.name === 'cancelled_at')) db.exec('ALTER TABLE semi_build_conversions ADD COLUMN cancelled_at TEXT');
  const unitConversionCols = db.prepare('PRAGMA table_info(job_order_units)').all() as Array<{ name: string }>;
  if (!unitConversionCols.some((c) => c.name === 'conversion_source_unit_id'))
    db.exec('ALTER TABLE job_order_units ADD COLUMN conversion_source_unit_id INTEGER REFERENCES job_order_units(id) ON DELETE RESTRICT');
  if (!unitConversionCols.some((c) => c.name === 'received_unit_cost'))
    db.exec('ALTER TABLE job_order_units ADD COLUMN received_unit_cost REAL');
  db.exec('CREATE INDEX IF NOT EXISTS idx_unit_conversion_source ON job_order_units(conversion_source_unit_id) WHERE conversion_source_unit_id IS NOT NULL');
  // v84: immutable per-trip manifests; the commercial order and reserved remainder stay put.
  const tripLineCols = db.prepare('PRAGMA table_info(order_items)').all() as Array<{name:string}>;
  for (const col of ['dispatched_qty','dispatched_bulk_qty','cancelled_qty'])
    if (!tripLineCols.some(c=>c.name===col)) db.exec(`ALTER TABLE order_items ADD COLUMN ${col} REAL NOT NULL DEFAULT 0`);
  const tripDeliveryCols = db.prepare('PRAGMA table_info(deliveries)').all() as Array<{name:string}>;
  if (!tripDeliveryCols.some(c=>c.name==='release_slip_id')) db.exec('ALTER TABLE deliveries ADD COLUMN release_slip_id INTEGER REFERENCES release_slips(id) ON DELETE RESTRICT');
  const tripBatchCols = db.prepare('PRAGMA table_info(production_batch_allocations)').all() as Array<{name:string}>;
  if (!tripBatchCols.some(c=>c.name==='release_slip_id')) db.exec('ALTER TABLE production_batch_allocations ADD COLUMN release_slip_id INTEGER REFERENCES release_slips(id) ON DELETE RESTRICT');
  db.exec(`CREATE TABLE IF NOT EXISTS release_slip_units (
    slip_item_id INTEGER NOT NULL REFERENCES release_slip_items(id) ON DELETE CASCADE,
    unit_id INTEGER NOT NULL REFERENCES job_order_units(id) ON DELETE RESTRICT,
    PRIMARY KEY(slip_item_id,unit_id));
    CREATE INDEX IF NOT EXISTS idx_release_slip_units_unit ON release_slip_units(unit_id);
    CREATE TABLE IF NOT EXISTS order_remainder_cancellations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES orders(id),
    reason TEXT NOT NULL, cancelled_by INTEGER REFERENCES users(id), cancelled_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_delivery_slip ON deliveries(release_slip_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_active_trip ON deliveries(release_slip_id)
      WHERE release_slip_id IS NOT NULL AND status NOT IN ('failed','cancelled');`);
  if (!getSetting('trip_manifest_backfilled_v84')) {
    db.exec(`UPDATE order_items SET dispatched_qty=COALESCE((SELECT SUM(li.quantity) FROM release_slip_items li WHERE li.order_item_id=order_items.id),
      CASE WHEN EXISTS(SELECT 1 FROM orders o WHERE o.id=order_items.order_id AND o.fulfilled_at IS NOT NULL) THEN quantity ELSE 0 END);
      UPDATE order_items SET dispatched_bulk_qty=MIN(released_qty,dispatched_qty);
      UPDATE production_batch_allocations SET release_slip_id=(SELECT id FROM release_slips s WHERE s.order_id=production_batch_allocations.order_id)
        WHERE state='shipped' AND (SELECT COUNT(*) FROM release_slips s WHERE s.order_id=production_batch_allocations.order_id)=1;
      INSERT OR IGNORE INTO release_slip_units(slip_item_id,unit_id) SELECT li.id,u.id FROM release_slip_items li
        JOIN job_order_units u ON u.order_item_id=li.order_item_id AND u.status='sold'
        WHERE (SELECT COUNT(*) FROM release_slips s JOIN release_slip_items x ON x.slip_id=s.id WHERE x.order_item_id=li.order_item_id)=1;
      UPDATE deliveries SET release_slip_id=(SELECT id FROM release_slips s WHERE s.order_id=deliveries.order_id)
        WHERE (SELECT COUNT(*) FROM release_slips s WHERE s.order_id=deliveries.order_id)=1
        AND (SELECT COUNT(*) FROM deliveries d WHERE d.order_id=deliveries.order_id)=1;`);
    setSetting('trip_manifest_backfilled_v84',true);
  }
  // The v84 trip backfill identifies already-shipped serials. A sold serial on an
  // unfulfilled sale without a slip-unit link was deducted by the older direct
  // Sell action, including when an earlier partial trip exists on the same order.
  db.exec(`UPDATE job_order_units AS u SET direct_sold_at=COALESCE(u.updated_at,u.created_at)
    WHERE u.direct_sold_at IS NULL AND u.status='sold' AND u.order_id IS NOT NULL
      AND EXISTS(SELECT 1 FROM orders o WHERE o.id=u.order_id AND o.type='sale' AND o.fulfilled_at IS NULL)
      AND (NOT EXISTS(SELECT 1 FROM release_slips s WHERE s.order_id=u.order_id)
        OR COALESCE(u.updated_at,u.created_at)>(SELECT MAX(s.released_at) FROM release_slips s WHERE s.order_id=u.order_id))
      AND NOT EXISTS(SELECT 1 FROM release_slip_units su WHERE su.unit_id=u.id)`);
  // v86: a serial may return once per separate sale shipment, rather than once forever.
  const returnsSql=queryOne<{sql:string}>("SELECT sql FROM sqlite_master WHERE type='table' AND name='sales_returns'")!.sql;
  if(/unit_id INTEGER UNIQUE/.test(returnsSql)){
    const cols=(db.prepare('PRAGMA table_info(sales_returns)').all() as {name:string}[]).map(c=>'"'+c.name+'"').join(',');
    db.exec('PRAGMA foreign_keys=OFF');
    try{
      db.exec('BEGIN');
      db.exec(returnsSql.replace(/CREATE TABLE(?: IF NOT EXISTS)? ["`\[]?sales_returns["`\]]?/i, 'CREATE TABLE sales_returns_v86').replace('unit_id INTEGER UNIQUE','unit_id INTEGER'));
      db.exec(`INSERT INTO sales_returns_v86(${cols}) SELECT ${cols} FROM sales_returns; DROP TABLE sales_returns; ALTER TABLE sales_returns_v86 RENAME TO sales_returns;`);
      db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}finally{db.exec('PRAGMA foreign_keys=ON');}
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sales_returns_slip_item ON sales_returns(slip_item_id);
    CREATE INDEX IF NOT EXISTS idx_sales_returns_slip ON sales_returns(slip_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_return_serial_shipment ON sales_returns(slip_id,unit_id) WHERE unit_id IS NOT NULL;`);

  // v87: keep audit reviews separate from stock corrections.
  db.exec(`CREATE TABLE IF NOT EXISTS direct_sale_stockout_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    item_id INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
    evidence_hash TEXT NOT NULL, note TEXT NOT NULL,
    reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE INDEX IF NOT EXISTS idx_direct_sale_stockout_review_case ON direct_sale_stockout_reviews(order_id,item_id,id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_direct_sale_stockout_review_evidence ON direct_sale_stockout_reviews(order_id,item_id,evidence_hash)`);

  // v88: a count records a book snapshot and physical evidence before a separate approval.
  db.exec(`CREATE TABLE IF NOT EXISTS stock_counts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
    location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
    build_mode TEXT NOT NULL CHECK(build_mode IN ('assembled','semi_built')),
    book_quantity REAL NOT NULL, book_serial_ids TEXT NOT NULL, book_batches TEXT NOT NULL,
    counted_untracked REAL NOT NULL, counted_serial_ids TEXT NOT NULL, counted_batches TEXT NOT NULL,
    note TEXT NOT NULL, source_kind TEXT NOT NULL CHECK(source_kind IN ('manual','discrepancy','direct_sale')),
    source_id INTEGER, status TEXT NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted','approved','applied','rejected')),
    counted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    counted_at TEXT NOT NULL DEFAULT (datetime('now')),
    reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at TEXT, review_note TEXT,
    transaction_id INTEGER REFERENCES inventory_transactions(id) ON DELETE SET NULL,
    completed_at TEXT);
    CREATE INDEX IF NOT EXISTS idx_stock_counts_status ON stock_counts(status,counted_at,id)`);
  db.exec(`CREATE TABLE IF NOT EXISTS stock_count_movements (
    count_id INTEGER NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE,
    transaction_id INTEGER NOT NULL REFERENCES inventory_transactions(id) ON DELETE RESTRICT,
    batch_id INTEGER REFERENCES production_batches(id) ON DELETE SET NULL,
    PRIMARY KEY(count_id,transaction_id))`);

  // v89: bind source closure to the observed audit evidence and the applied count.
  const countCols = new Set((db.prepare('PRAGMA table_info(stock_counts)').all() as {name:string}[]).map(c=>c.name));
  for(const [name,type] of [
    ['source_evidence_hash','TEXT'],
    ['source_closed_by','INTEGER REFERENCES users(id) ON DELETE SET NULL'],
    ['source_closed_at','TEXT'],
    ['source_close_note','TEXT'],
  ] as const) if(!countCols.has(name)) db.exec(`ALTER TABLE stock_counts ADD COLUMN ${name} ${type}`);

}

/** One-time permission split: every role and per-account grant holding `from` also gets `to`.
    Flagged in settings so an admin who later removes `to` doesn't get it back on an upgrade. */
function grantOnce(flag: string, pairs: Array<[string, string]>): void {
  if (getSetting<boolean>(flag)) return;
  for (const r of db.prepare('SELECT key, permissions FROM roles').all() as Array<{ key: string; permissions: string }>) {
    let perms: string[] = [];
    try { perms = JSON.parse(r.permissions); } catch { continue; }
    const next = [...perms];
    for (const [from, to] of pairs) if (perms.includes(from) && !next.includes(to)) next.push(to);
    if (next.length !== perms.length) db.prepare('UPDATE roles SET permissions = ? WHERE key = ?').run(JSON.stringify(next), r.key);
  }
  for (const u of db.prepare("SELECT id, permission_overrides FROM users WHERE permission_overrides != '{}'").all() as Array<{ id: number; permission_overrides: string }>) {
    let ov: Record<string, boolean> = {};
    try { ov = JSON.parse(u.permission_overrides); } catch { continue; }
    let changed = false;
    for (const [from, to] of pairs) if (ov[from] === true && ov[to] === undefined) { ov[to] = true; changed = true; }
    if (changed) db.prepare('UPDATE users SET permission_overrides = ? WHERE id = ?').run(JSON.stringify(ov), u.id);
  }
  setSetting(flag, true);
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
  const synced = syncHooks.nextSequence?.(key, prefix, pad); // provisional / replayed numbers
  if (synced !== undefined) return synced;
  const next = (getSetting<number>(key) || 0) + 1;
  setSetting(key, next);
  return `${prefix}-${String(next).padStart(pad, '0')}`;
}

/** Record numbers are unique across forms, even when administrators reuse a prefix.
 * Start with the shared prefix series and skip legacy numbers without renumbering history. */
export function nextFormRecordNumber(prefix:string):string {
  let number:string;
  do {number=nextSequence('form_record_seq_'+prefix,prefix);}while(queryOne('SELECT 1 FROM form_records WHERE number=?',number));
  return number;
}

/** Roles: the built-in bundles the first time (empty table), so a tenant can then edit or delete
    them freely without seeing them come back. Always ensures the fixed 'admin' row, and a row for
    any role key an existing account holds (so no account is left on a role nobody can see). */
function seedRoles(): void {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO roles (key, label, description, permissions, sort_order) VALUES (?, ?, ?, ?, ?)');
  const count = (db.prepare('SELECT COUNT(*) AS c FROM roles').get() as { c: number }).c;
  const seeds = count === 0 ? BUILTIN_ROLES : BUILTIN_ROLES.filter((r) => r.key === ADMIN_ROLE);
  seeds.forEach((r) => insert.run(r.key, r.label, r.description, JSON.stringify(r.permissions), BUILTIN_ROLES.indexOf(r)));
  const orphans = db.prepare(
    'SELECT DISTINCT role FROM users WHERE role NOT IN (SELECT key FROM roles)').all() as Array<{ role: string }>;
  for (const { role } of orphans) {
    insert.run(role, role.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()), '', JSON.stringify(roleDefaults(role)), 100);
  }
}

function seed(): void {
  seedRoles();
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
    const password = process.env.ADMIN_PASSWORD || (process.env.NODE_ENV === 'test' ? process.env.VDS_TEST_ADMIN_PASSWORD : undefined);
    if (!password) throw new Error('ADMIN_PASSWORD is required before creating the default admin account');
    const hash = bcrypt.hashSync(password, 10);
    // The configured first-boot password must be replaced at first sign-in (shared/auth.ts).
    // Tests use a separate fixture variable. Provisioning clears the flag when the operator
    // sets the owner's own password (platform/provisioning.ts).
    db.prepare(
      `INSERT INTO users (username, full_name, password_hash, role, department_id, password_change_required)
       VALUES (?, ?, ?, 'admin', ?, ?)`
    ).run('admin', 'System Administrator', hash, adminDept ? adminDept.id : null, process.env.NODE_ENV === 'test' ? 0 : 1);

    if (!process.env.DB_PATH) {
      console.log('========================================================');
      console.log('  Default admin account created:');
      console.log('     username: admin');
      console.log('  Use the configured ADMIN_PASSWORD and change it at first sign-in.');
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
      // Half Days / Undertime Days (PayrollPolicy.whole_day_min_minutes), Undertime Day Pay,
      // Night Differential, and Other Deductions Total — added alongside the Time Keeping
      // minimum-work-time / max-OT / night-diff / other-deductions feature.
      const insertAfter = (afterKey: string, field: { key: string; label: string; type: string; required: boolean; options: unknown[]; default: string }) => {
        if (fields.some((f) => f.key === field.key)) return;
        const at = fields.findIndex((f) => f.key === afterKey);
        fields.splice(at >= 0 ? at + 1 : fields.length, 0, field);
        touched = true;
      };
      insertAfter('days_absent', { key: 'days_half', label: 'Half Days', type: 'number', required: false, options: [], default: '' });
      insertAfter('days_half', { key: 'days_undertime', label: 'Undertime Days', type: 'number', required: false, options: [], default: '' });
      insertAfter('undertime_pay', { key: 'undertime_day_pay', label: 'Undertime Day Pay', type: 'number', required: false, options: [], default: '' });
      insertAfter('rest_day_ot', { key: 'night_diff_pay', label: 'Night Differential', type: 'number', required: false, options: [], default: '' });
      insertAfter('cash_advance', { key: 'other_deductions_total', label: 'Other Deductions', type: 'number', required: false, options: [], default: '' });
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
    numField('days_half', 'Half Days'),
    numField('days_undertime', 'Undertime Days'),
    numField('ot_hours', 'OT Hours'),
    numField('ot_rate_hour', 'OT Rate/Hour'),
    numField('basic_salary', 'Basic Salary'),
    numField('overtime_pay', 'Overtime Pay'),
    numField('undertime_pay', 'Undertime Pay'),
    numField('undertime_day_pay', 'Undertime Day Pay'),
    numField('holiday_pay', 'Holiday Pay'),
    numField('special_holiday_30', 'Special Holiday 30%'),
    numField('rest_day_ot', 'Rest Day OT'),
    numField('night_diff_pay', 'Night Differential'),
    numField('total_earnings', 'Total Earnings'),
    numField('sss', 'SSS'),
    numField('philhealth', 'PhilHealth'),
    numField('pagibig', 'Pag-IBIG'),
    numField('withholding_tax', 'Withholding Tax'),
    numField('cash_advance', 'Cash Advance'),
    numField('other_deductions_total', 'Other Deductions'),
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
        // Read directly by the compute engine as a per-day override of PayrollPolicy.max_ot_hours
        // — leave blank for a routine request (policy cap applies as usual); filled in by
        // whoever approves it when the cap needs to flex for that one day (e.g. policy caps OT
        // at 2h/day but the boss okayed 4h today), this day's OT is capped at THIS number
        // instead. Doesn't lower the cap if set below policy.max_ot_hours — only ever raises it.
        { key: 'approved_hours', label: 'Approved OT Hours (overrides the daily OT cap for this day only — leave blank to use the policy max)', type: 'number', required: false, options: [], default: '' },
        // Read by the compute engine: ticked, time before the shift start counts as OT too when
        // the time-in was 1 h+ early (EARLY_OT_MIN_MINUTES), sharing the day's OT cap with
        // after-shift OT. The Daily Time grid only offers it on such a day.
        { key: 'early_ot', label: 'Early OT — count the time before the shift start (timed in 1 hour or more early)', type: 'checkbox', required: false, options: [], default: '' },
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
        // new_time_in is optional — when filled in alongside new_time_out, the compute engine
        // judges the ENTIRE day (late, undertime, OT) against this shifted window instead of
        // the original shift, e.g. an 8-5 shift offset to 10-7: no late deduction for the 10am
        // arrival, and the 5-7pm stretch isn't OT since it's still within the same 8-hour day,
        // just shifted later. Left blank, only the time-out shifts (old behavior, backward
        // compatible with records filed before this field existed): the arrival is still judged
        // against the original shift start, only the end-of-day undertime/OT threshold moves.
        { key: 'new_time_in', label: 'New Time In (optional — leave blank to shift only the time-out)', type: 'time', required: false, options: [], default: '' },
        // new_time_out is read directly by the compute engine as this day's shifted expected
        // end time (arrived late, agreed to leave later instead of a deduction).
        { key: 'new_time_out', label: 'New Time Out', type: 'time', required: true, options: [], default: '' },
        area('reason', 'Reason', true),
      ],
    },
    {
      // Authorizes a shifted lunch/break window for one specific day — e.g. an approved 1:00-
      // 2:00 lunch instead of the shift's own structural midday slot (see lunchWindow in
      // hr-payroll-compute.ts). Read directly by the compute engine's lunch-lateness check
      // (PayrollPolicy.count_lunch_late_as_late) so a lunch taken later than the structural
      // window, but returned from on time for ITS OWN length, isn't flagged as a late return.
      name: 'Lunch/Break Offset Request', slug: 'lunch_offset_form', prefix: 'LOF', icon: 'history',
      fields: [
        { ...employeeField },
        dateField('work_date', 'Date'),
        { key: 'new_lunch_out', label: 'Approved Lunch/Break Start', type: 'time', required: true, options: [], default: '' },
        // Optional — left blank, the compute engine defaults the approved return to new_lunch_out
        // + PayrollPolicy.lunch_break_minutes (the company's normal lunch duration, just shifted
        // later). Only needed when the approved break is a different LENGTH too, not just later.
        { key: 'new_lunch_in', label: 'Approved Return (optional — leave blank for the normal lunch length)', type: 'time', required: false, options: [], default: '' },
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
    {
      // Not a formal leave/OT/undertime form and never checked by hasForm() in
      // hr-payroll-compute.ts — purely documentation for an unplanned absence/lateness the
      // employee couldn't file a real request for (sick and messaged the group chat, an
      // accident on the way to work, etc.), reported informally by chat or a call to a
      // supervisor. The day is still judged as a plain absence/late unless a real Leave/
      // Undertime/Half Day form is also linked — this just records that it WAS reported, not a
      // no-call-no-show.
      name: 'Reported (Chat/Verbal)', slug: 'reported_absence', prefix: 'RPT', icon: 'messages',
      fields: [
        { ...employeeField },
        dateField('work_date', 'Date'),
        area('reason', 'What was reported', true),
      ],
    },
    {
      // Authorizes working a rest day. With PayrollPolicy.require_rest_day_form on, the rest-day
      // premium is paid only when an APPROVED one is linked to that day (hr-payroll-compute.ts);
      // off, it is the paper trail. See src/modules/hr/rest-day.ts.
      name: 'Rest Day Work Request', slug: 'rest_day_work_request', prefix: 'RDW', icon: 'calendar',
      fields: [
        { ...employeeField },
        dateField('work_date', 'Rest Day to Work'),
        area('reason', 'Reason', true),
      ],
    },
    {
      // Moves a rest day. Once APPROVED and linked to either date on the Daily Time grid,
      // original_rest_day counts as a working day and new_rest_day as the rest day, for payroll
      // and the grid alike (restDaySwapsFor in src/modules/hr/rest-day.ts). HR's per-day Rest Day
      // dropdown still overrides it.
      name: 'Change of Rest Day', slug: 'rest_day_change', prefix: 'RDC', icon: 'calendar',
      fields: [
        { ...employeeField },
        dateField('original_rest_day', 'Rest Day Being Worked'),
        dateField('new_rest_day', 'New Rest Day'),
        area('reason', 'Reason', true),
      ],
    },
    {
      name: 'Schedule Change Request', slug: 'schedule_change', prefix: 'SCH', icon: 'calendar',
      fields: [
        { ...employeeField },
        dateField('work_date', 'Published work date'),
        { key: 'requested_shift_id', label: 'Requested shift', type: 'select', required: true, options: [], default: '' },
        area('reason', 'Reason', true),
      ],
    },
    {
      // Correction to an authoritative HR field (legal name, gov IDs, …) — applied only when an
      // hr.manage approver approves it (src/modules/hr/info-change.ts). Options must match
      // INFO_CHANGE_FIELDS there (pinned by tests/info-change.test.ts). Keys avoid position/
      // department, which the mobile form auto-fills from the signed-in employee.
      name: 'Employee Information Change', slug: 'information_change', prefix: 'IC', icon: 'user',
      fields: [
        { ...employeeField },
        { key: 'field', label: 'Information to change', type: 'select', required: true, default: '',
          options: ['Legal name', 'SSS number', 'PhilHealth number', 'Pag-IBIG number', 'TIN', 'Birth date', 'Civil status', 'Other official record'] },
        { key: 'requested_value', label: 'Correct value', type: 'text', required: true, options: [], default: '' },
        area('reason', 'Reason / supporting document', true),
      ],
    },
  ];
  for (const f of FORMS) {
    const existing = db.prepare('SELECT id, fields FROM form_definitions WHERE slug = ?').get(f.slug) as
      { id: number; fields: string } | undefined;
    if (!existing) {
      db.prepare(
        `INSERT INTO form_definitions (name, slug, number_prefix, icon, fields, scope)
         VALUES (?, ?, ?, ?, ?, 'hr')`
      ).run(f.name, f.slug, f.prefix, f.icon, JSON.stringify(f.fields));
      continue;
    }
    // Touch up an install that already had offset_form seeded (or hand-created) before
    // new_time_in existed — same self-correcting pattern as seedHrPayrollForm below.
    if (f.slug === 'offset_form') {
      try {
        const fields = JSON.parse(existing.fields) as { key: string }[];
        if (!fields.some((fl) => fl.key === 'new_time_in')) {
          const at = fields.findIndex((fl) => fl.key === 'new_time_out');
          const newTimeIn = (f.fields as { key: string }[]).find((fl) => fl.key === 'new_time_in');
          if (newTimeIn) {
            fields.splice(at >= 0 ? at : fields.length, 0, newTimeIn);
            db.prepare('UPDATE form_definitions SET fields = ? WHERE id = ?').run(JSON.stringify(fields), existing.id);
          }
        }
      } catch { /* leave as-is if the stored fields are somehow unparseable */ }
    }
    // Same self-correcting touch-up for an install that already had overtime_request seeded
    // before approved_hours (the per-day OT-cap override) or early_ot (Early OT) existed.
    if (f.slug === 'overtime_request') {
      try {
        const fields = JSON.parse(existing.fields) as { key: string }[];
        const missing = (f.fields as { key: string }[])
          .filter((fl) => (fl.key === 'approved_hours' || fl.key === 'early_ot') && !fields.some((x) => x.key === fl.key));
        if (missing.length) {
          fields.push(...missing);
          db.prepare('UPDATE form_definitions SET fields = ? WHERE id = ?').run(JSON.stringify(fields), existing.id);
        }
      } catch { /* leave as-is if the stored fields are somehow unparseable */ }
    }
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
export function memoTemplateBody(title: string, fields: Array<{ key: string; label: string; type?:string;source?:string;format?:string;currency?:string }>): string {
  const escape=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
  const rows=fields.map(field=>printFormField(field,{row:'mm-row',label:'mm-l',value:'mm-v'})).join('\n');
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
  <h2>${escape(title.toUpperCase())}</h2>
  <div class="mm-row"><span class="mm-l">Reference No.</span><span class="mm-v">{{number}}</span></div>
  <div class="mm-row"><span class="mm-l">Date Issued</span><span class="mm-v">{{today}}</span></div>
${rows}
  <div class="sig">
    <div>Issued by</div>
    <div>Received by</div>
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
    const number = nextFormRecordNumber('HOL');
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
  if(!hasType('sale'))insert.run('Sale Order','sale',orderTemplateBody('SALES ORDER'));
  if(!hasType('job'))insert.run('Job Order','job',orderTemplateBody('JOB ORDER'));
  if(!hasType('purchase'))insert.run('Purchase Request','purchase',orderTemplateBody('PURCHASE REQUEST'));
  if (!db.prepare('SELECT id FROM doc_templates WHERE name = ?').get('HR Payroll Slip') && !db.prepare("SELECT t.id FROM form_definitions f JOIN doc_templates t ON t.id=f.template_id WHERE f.slug='hr_payroll'").get()) {
    insert.run('HR Payroll Slip', 'generic', payrollSlipTemplateBody());
  }
  if (!db.prepare('SELECT id FROM doc_templates WHERE name = ?').get('Employee ID Card') && !db.prepare("SELECT t.id FROM document_defaults d JOIN doc_templates t ON t.id=d.template_id WHERE d.key='employee_id'").get()) {
    insert.run('Employee ID Card', 'generic', employeeIdTemplateBody());
  }
  if (!db.prepare('SELECT id FROM doc_templates WHERE name = ?').get('BIR 2316') && !db.prepare("SELECT t.id FROM document_defaults d JOIN doc_templates t ON t.id=d.template_id WHERE d.key='bir_2316'").get()) {
    insert.run('BIR 2316', 'generic', bir2316TemplateBody());
  }
  if (!db.prepare('SELECT id FROM doc_templates WHERE name = ?').get('Asset Issuance Form') && !db.prepare("SELECT t.id FROM document_defaults d JOIN doc_templates t ON t.id=d.template_id WHERE d.key='asset_issuance'").get()) {
    insert.run('Asset Issuance Form', 'generic', assetIssuanceTemplateBody());
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
  <div class="row"><span class="l">Date of Birth (MM/DD/YYYY)</span><span class="v">{{employee.birth_date_mdy}}</span></div>
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

/** Default printable Asset Issuance Form — company property handed to one employee, with a
    line per asset and a signature block for both sides to acknowledge. Rendered against
    {company, employee, issuance: {number, issued_date, notes, issued_by_name}, items, today} —
    see printAssetIssuance() in hr-employees.js. */
function assetIssuanceTemplateBody(): string {
  return `<style>
  .aif { font-family: Arial, sans-serif; font-size: 11px; color: #111; max-width: 720px; margin: 0 auto; }
  .aif h2 { text-align: center; font-size: 15px; margin: 0 0 2px; letter-spacing: .04em; }
  .aif .sub { text-align: center; font-size: 10px; color: #555; margin-bottom: 14px; }
  .aif .kv { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 18px; margin-bottom: 14px; }
  .aif .kv .row { display: flex; justify-content: space-between; border-bottom: 1px dotted #ccc; padding: 2px 0; }
  .aif .kv .l { color: #555; }
  .aif .kv .v { font-weight: 600; }
  .aif table { width: 100%; border-collapse: collapse; margin-top: 4px; }
  .aif th, .aif td { border: 1px solid #ccc; padding: 5px 6px; font-size: 10.5px; text-align: left; }
  .aif th { background: #eef4fb; text-transform: uppercase; font-size: 9.5px; letter-spacing: .03em; }
  .aif .notes { margin-top: 14px; font-size: 10.5px; color: #333; }
  .aif .ack { margin-top: 18px; font-size: 10px; color: #444; line-height: 1.5; }
  .aif .sig { display: flex; justify-content: space-between; margin-top: 30px; font-size: 10px; color: #444; }
  .aif .sig div { width: 46%; border-top: 1px solid #666; padding-top: 3px; text-align: center; }
</style>
<div class="aif">
  <h2>ASSET ISSUANCE FORM</h2>
  <div class="sub">{{company.name}} &nbsp;&middot;&nbsp; Form {{issuance.number}} &nbsp;&middot;&nbsp; Issued {{issuance.issued_date}}</div>

  <div class="kv">
    <div class="row"><span class="l">Employee</span><span class="v">{{employee.name}}</span></div>
    <div class="row"><span class="l">Employee No.</span><span class="v">{{employee.employee_no}}</span></div>
    <div class="row"><span class="l">Department</span><span class="v">{{employee.department}}</span></div>
    <div class="row"><span class="l">Position</span><span class="v">{{employee.position}}</span></div>
  </div>

  <table>
    <thead><tr><th style="width:26px">#</th><th>Asset</th><th>Category</th><th>Tag / Serial</th><th style="width:50px">Qty</th><th>Condition</th></tr></thead>
    <tbody>
      {{#items}}
      <tr><td>{{index}}</td><td>{{asset_name}}</td><td>{{category}}</td><td>{{asset_tag}}</td><td>{{quantity}}</td><td>{{condition_on_issue}}</td></tr>
      {{/items}}
    </tbody>
  </table>

  {{#if issuance.notes}}<div class="notes"><strong>Notes:</strong> {{issuance.notes}}</div>{{/if}}

  <p class="ack">I acknowledge receipt of the item(s) listed above, in the condition stated, for use in
    connection with my work at {{company.name}}. I agree to take reasonable care of them and to return
    them, in serviceable condition (normal wear excepted), upon request or upon separation from the
    company.</p>

  <div class="sig">
    <div>{{employee.name}}<br/><span style="font-size:9px">Employee signature over printed name</span></div>
    <div>{{issuance.issued_by_name}}<br/><span style="font-size:9px">Issued by</span></div>
  </div>
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
  <div class="slip-row"><span class="l">Half Days:</span><span class="v">{{days_half}}</span></div>
  <div class="slip-row"><span class="l">Undertime Days:</span><span class="v">{{days_undertime}}</span></div>
  <div class="slip-row"><span class="l">OT Hours:</span><span class="v">{{ot_hours}}</span></div>
  <div class="slip-row"><span class="l">OT Rate/Hour:</span><span class="v">{{ot_rate_hour}}</span></div>
  <div class="slip-cols">
    <div class="slip-col">
      <h4>EARNINGS</h4>
      <div class="slip-line"><span>Basic Salary</span><span>{{basic_salary}}</span></div>
      <div class="slip-line"><span>Overtime Pay</span><span>{{overtime_pay}}</span></div>
      <div class="slip-line"><span>Undertime</span><span>{{undertime_pay}}</span></div>
      <div class="slip-line"><span>Undertime Day Pay</span><span>{{undertime_day_pay}}</span></div>
      <div class="slip-line"><span>Holiday Pay</span><span>{{holiday_pay}}</span></div>
      <div class="slip-line"><span>Special Holiday 30%</span><span>{{special_holiday_30}}</span></div>
      <div class="slip-line"><span>Rest Day OT</span><span>{{rest_day_ot}}</span></div>
      <div class="slip-line"><span>Night Differential</span><span>{{night_diff_pay}}</span></div>
      <div class="slip-total"><span>Total Earnings</span><span>{{total_earnings}}</span></div>
    </div>
    <div class="slip-col">
      <h4>DEDUCTIONS</h4>
      <div class="slip-line"><span>SSS</span><span>{{sss}}</span></div>
      <div class="slip-line"><span>PhilHealth</span><span>{{philhealth}}</span></div>
      <div class="slip-line"><span>Pag-IBIG</span><span>{{pagibig}}</span></div>
      <div class="slip-line"><span>Withholding Tax</span><span>{{withholding_tax}}</span></div>
      {{#other_deductions}}<div class="slip-line"><span>{{label}}</span><span>{{amount}}</span></div>{{/other_deductions}}
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

/** How long the app-wide activity_log (the audit trail) is kept: 5 years by default, the span
    PH payroll and accounting records are kept for. Rows older than this are swept on the
    housekeeping timer; nothing in the app can delete them sooner. ACTIVITY_LOG_RETENTION_DAYS
    overrides it (never below 31). ~60 MB per busy company-year at current volumes. */
export const ACTIVITY_LOG_RETENTION_DAYS = Math.max(31, Number(process.env.ACTIVITY_LOG_RETENTION_DAYS) || 1827);

/** How long an ended or expired session row is kept as sign-in history (account "Where
    you're signed in" / admin view). Live sessions are never swept. */
export const SESSION_HISTORY_DAYS = 90;

export function cleanupSessions(): void {
  // Runs on a timer, outside any request — sweep every open tenant connection.
  for (const slug of registry.keys()) {
    withTenant(slug, () => {
      // Expired-but-never-ended rows are stamped so history shows how they finished.
      db.prepare(
        "UPDATE sessions SET ended_at = expires_at, end_reason = 'expired' WHERE ended_at IS NULL AND expires_at < datetime('now')"
      ).run();
      db.prepare(
        `UPDATE sessions SET ended_at = datetime('now'), end_reason = 'idle'
         WHERE ended_at IS NULL AND idle_minutes IS NOT NULL
           AND COALESCE(last_seen_at, created_at) < datetime('now', '-' || idle_minutes || ' minutes')`
      ).run();
      db.prepare(
        `DELETE FROM sessions WHERE ended_at IS NOT NULL AND ended_at < datetime('now', '-${SESSION_HISTORY_DAYS} days')`
      ).run();
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

/** What is stored for a bearer token (sessions, platform_sessions): its SHA-256, prefixed so a
 *  stored value can never be mistaken for — or presented as — a raw token. A copy of the
 *  database then holds no usable sign-in. */
export const TOKEN_DIGEST_PREFIX = 'h1:';
export function tokenDigest(token: string): string {
  return TOKEN_DIGEST_PREFIX + crypto.createHash('sha256').update(token).digest('hex');
}

/** One-time, idempotent: sessions stored before tokens were hashed get their digest, so
 *  everyone stays signed in across the upgrade. Rows already prefixed are skipped. */
export function hashLegacySessionTokens(conn: DatabaseSync, table = 'sessions'): number {
  const rows = conn.prepare(`SELECT rowid AS r, token FROM ${table} WHERE token NOT LIKE '${TOKEN_DIGEST_PREFIX}%'`).all() as Array<{ r: number; token: string }>;
  if (!rows.length) return 0;
  const update = conn.prepare(`UPDATE ${table} SET token = ? WHERE rowid = ?`);
  conn.exec('BEGIN');
  try {
    for (const row of rows) update.run(tokenDigest(row.token), row.r);
    conn.exec('COMMIT');
  } catch (e) {
    conn.exec('ROLLBACK');
    throw e;
  }
  return rows.length;
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
