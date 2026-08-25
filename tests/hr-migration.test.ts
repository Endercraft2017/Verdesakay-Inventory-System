/** Regression test for the `employees` rebuild migration in src/db.ts migrate(): upgrading
    a pre-existing DB (old `active` flag, no `status`/`employee_no`) must not violate the
    `attendance_records.employee_id` foreign key that references it — DROP TABLE employees
    while a child row still points at it requires foreign_keys to be OFF for that rebuild. */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

describe('employees migration', () => {
  it('upgrades an old-shape employees table (active flag) with a referencing attendance row, without violating FK constraints', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-migrate-'));
    const dbPath = path.join(tmpDir, 'old.db');

    // Seed a DB with the OLD employees shape + a real attendance_records reference to it,
    // mimicking a database created before this migration existed.
    const raw = new DatabaseSync(dbPath);
    raw.exec('PRAGMA foreign_keys = ON;');
    raw.exec(`
      CREATE TABLE employees (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        department_id INTEGER,
        position TEXT,
        daily_rate REAL NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE attendance_periods (
        id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL,
        start_date TEXT NOT NULL, end_date TEXT NOT NULL,
        created_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE attendance_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        period_id INTEGER NOT NULL REFERENCES attendance_periods(id) ON DELETE CASCADE,
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
        work_date TEXT NOT NULL, time_in TEXT, time_out TEXT, notes TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(period_id, employee_id, work_date)
      );
    `);
    raw.prepare("INSERT INTO employees (id, name, active) VALUES (1, 'Old Shape Employee', 1)").run();
    raw.prepare("INSERT INTO employees (id, name, active) VALUES (2, 'Inactive Employee', 0)").run();
    raw.prepare("INSERT INTO attendance_periods (id, label, start_date, end_date) VALUES (1, 'Old Period', '2026-01-01', '2026-01-01')").run();
    raw.prepare("INSERT INTO attendance_records (period_id, employee_id, work_date) VALUES (1, 1, '2026-01-01')").run();
    raw.close();

    const tmpUploads = path.join(tmpDir, 'uploads');
    process.env.DB_PATH = dbPath;
    process.env.UPLOAD_DIR = tmpUploads;
    delete process.env.ADMIN_PASSWORD;

    const db = await import('../src/db');
    expect(() => db.init()).not.toThrow();

    const active = db.queryOne<{ employee_no: string; status: string; name: string }>(
      'SELECT employee_no, status, name FROM employees WHERE id = 1'
    );
    expect(active?.employee_no).toBe('EMP-00001');
    expect(active?.status).toBe('regular'); // backfilled from active = 1
    expect(active?.name).toBe('Old Shape Employee');

    const inactive = db.queryOne<{ status: string }>('SELECT status FROM employees WHERE id = 2');
    expect(inactive?.status).toBe('terminated'); // backfilled from active = 0

    // The FK reference from attendance_records survived the rebuild intact.
    const attendance = db.queryOne<{ employee_id: number }>('SELECT employee_id FROM attendance_records WHERE id = 1');
    expect(attendance?.employee_id).toBe(1);

    // The employee_no counter must be advanced past the backfilled numbers, or the next
    // employee created via the API would collide with EMP-00002 (UNIQUE constraint failure).
    expect(db.getSetting<number>('employee_seq')).toBe(2);

    // Best-effort cleanup: the DatabaseSync connection opened by src/db may still hold the
    // file open (e.g. WAL mode on Windows), same as tests/helpers.ts's cleanup().
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
});
