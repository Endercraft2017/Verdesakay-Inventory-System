/** Regression test for the SCHEMA_VERSION 24 migration in src/db.ts: attendance_records gains
    a `form_record_ids` JSON-array column (a day can link more than one HR request form), and
    existing rows that had a single `form_record_id` are backfilled into it so nothing already
    linked is lost. Same "simulate a DB one version behind, run init(), assert the column +
    backfill" shape as tests/late-exempt-migration.test.ts and tests/offset-form-migration.test.ts. */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

describe('attendance_records.form_record_ids migration (SCHEMA_VERSION 24)', () => {
  it('adds the column and backfills it from the legacy single form_record_id', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-multiform-migrate-'));
    const dbPath = path.join(tmpDir, 'old.db');

    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE attendance_periods (
        id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL,
        start_date TEXT NOT NULL, end_date TEXT NOT NULL,
        created_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE attendance_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        period_id INTEGER NOT NULL,
        employee_id INTEGER NOT NULL,
        work_date TEXT NOT NULL,
        time_in TEXT, time_out TEXT, notes TEXT,
        shift_id INTEGER,
        form_record_id INTEGER,
        holiday_type TEXT, rest_day TEXT, min_hours_decision TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(period_id, employee_id, work_date)
      );
    `);
    raw.prepare("INSERT INTO attendance_periods (id, label, start_date, end_date) VALUES (1, 'P', '2026-08-01', '2026-08-15')").run();
    raw.prepare("INSERT INTO attendance_records (id, period_id, employee_id, work_date, form_record_id) VALUES (1, 1, 1, '2026-08-03', 42)").run();
    raw.prepare("INSERT INTO attendance_records (id, period_id, employee_id, work_date, form_record_id) VALUES (2, 1, 1, '2026-08-04', NULL)").run();
    raw.prepare("INSERT INTO settings (key, value) VALUES ('schema_version', '23')").run();
    raw.close();

    process.env.DB_PATH = dbPath;
    process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
    delete process.env.ADMIN_PASSWORD;

    const db = await import('../src/shared/db');
    expect(db.SCHEMA_VERSION).toBeGreaterThan(23); // the fix itself: version must have been bumped
    expect(() => db.init()).not.toThrow();

    const cols = (db.queryAll as <T>(sql: string) => T[])<{ name: string }>("PRAGMA table_info(attendance_records)").map((c) => c.name);
    expect(cols).toContain('form_record_ids');

    const linked = db.queryOne<{ form_record_ids: string }>('SELECT form_record_ids FROM attendance_records WHERE id = 1');
    expect(JSON.parse(linked!.form_record_ids)).toEqual([42]); // backfilled from form_record_id

    const unlinked = db.queryOne<{ form_record_ids: string | null }>('SELECT form_record_ids FROM attendance_records WHERE id = 2');
    expect(unlinked!.form_record_ids).toBeNull(); // nothing to backfill -> stays null

    expect(db.getSetting<number>('schema_version')).toBe(db.SCHEMA_VERSION);

    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
});
