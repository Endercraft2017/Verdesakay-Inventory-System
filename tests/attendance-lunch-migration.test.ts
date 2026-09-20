/** Regression test for the SCHEMA_VERSION 25 migration in src/db.ts: attendance_records gains
    `lunch_out` / `lunch_in` columns (the day's lunch-break bracket, split from the raw punches
    on reconcile — display-only, payroll still uses PayrollPolicy.lunch_break_minutes). There is
    no backfill: existing rows must be left exactly as they were, just with the new null columns.
    Same "simulate a DB one version behind, run init(), assert the columns" shape as
    tests/attendance-multiform-migration.test.ts. */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

describe('attendance_records.lunch_out / lunch_in migration (SCHEMA_VERSION 25)', () => {
  it('adds both columns and leaves existing rows untouched', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-lunch-migrate-'));
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
        form_record_id INTEGER, form_record_ids TEXT,
        holiday_type TEXT, rest_day TEXT, min_hours_decision TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(period_id, employee_id, work_date)
      );
    `);
    raw.prepare("INSERT INTO attendance_periods (id, label, start_date, end_date) VALUES (1, 'P', '2026-08-01', '2026-08-15')").run();
    raw.prepare("INSERT INTO attendance_records (id, period_id, employee_id, work_date, time_in, time_out) VALUES (1, 1, 1, '2026-08-03', '08:00', '17:00')").run();
    raw.prepare("INSERT INTO settings (key, value) VALUES ('schema_version', '24')").run();
    raw.close();

    process.env.DB_PATH = dbPath;
    process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
    delete process.env.ADMIN_PASSWORD;

    const db = await import('../src/db');
    expect(db.SCHEMA_VERSION).toBeGreaterThan(24); // the fix itself: version must have been bumped
    expect(() => db.init()).not.toThrow();

    const cols = (db.queryAll as <T>(sql: string) => T[])<{ name: string }>("PRAGMA table_info(attendance_records)").map((c) => c.name);
    expect(cols).toContain('lunch_out');
    expect(cols).toContain('lunch_in');

    // Existing row: original times intact, new columns default to null (no backfill).
    const row = db.queryOne<{ time_in: string; time_out: string; lunch_out: string | null; lunch_in: string | null }>(
      'SELECT time_in, time_out, lunch_out, lunch_in FROM attendance_records WHERE id = 1'
    )!;
    expect(row.time_in).toBe('08:00');
    expect(row.time_out).toBe('17:00');
    expect(row.lunch_out).toBeNull();
    expect(row.lunch_in).toBeNull();

    expect(db.getSetting<number>('schema_version')).toBe(db.SCHEMA_VERSION);

    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
});
