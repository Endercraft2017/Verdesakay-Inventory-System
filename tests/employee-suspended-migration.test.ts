/** SCHEMA_VERSION 53: an existing DB whose employees.status CHECK predates 'suspended' is
    rebuilt from its own stored CREATE statement — columns, rows, indexes and the
    attendance_records foreign key all survive, and 'suspended' becomes a valid status. Own file
    because src/shared/db reads DB_PATH once, at import. */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

describe('employees suspended-status migration', () => {
  it('widens the status CHECK on a pre-v53 employees table without losing data', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-suspended-'));
    const dbPath = path.join(tmpDir, 'old.db');

    // Already has status/employee_no (so the older active-flag rebuild is skipped), but the
    // pre-53 CHECK, an extra ALTER-added column, a custom index and a referencing child row.
    const raw = new DatabaseSync(dbPath);
    raw.exec('PRAGMA foreign_keys = ON;');
    raw.exec(`
      CREATE TABLE employees (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_no   TEXT UNIQUE,
        name          TEXT NOT NULL,
        department_id INTEGER,
        position      TEXT,
        daily_rate    REAL NOT NULL DEFAULT 0,
        status        TEXT NOT NULL DEFAULT 'probationary'
                        CHECK (status IN ('probationary','regular','resigned','terminated')),
        start_date    TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
      ALTER TABLE employees ADD COLUMN nickname TEXT;
      CREATE INDEX idx_employees_nickname ON employees(nickname);
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
    raw.prepare("INSERT INTO employees (id, employee_no, name, status, nickname) VALUES (7, 'EMP-00007', 'Kept Employee', 'regular', 'Kep')").run();
    raw.prepare("INSERT INTO attendance_periods (id, label, start_date, end_date) VALUES (1, 'P', '2026-01-01', '2026-01-01')").run();
    raw.prepare("INSERT INTO attendance_records (period_id, employee_id, work_date) VALUES (1, 7, '2026-01-01')").run();
    raw.close();

    process.env.DB_PATH = dbPath;
    process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
    process.env.BACKUP_DIR = path.join(tmpDir, 'backups');
    delete process.env.ADMIN_PASSWORD;

    const db = await import('../src/shared/db');
    expect(() => db.init()).not.toThrow();

    const row = db.queryOne<{ name: string; nickname: string; status: string }>(
      'SELECT name, nickname, status FROM employees WHERE id = 7'
    );
    expect(row).toMatchObject({ name: 'Kept Employee', nickname: 'Kep', status: 'regular' });

    db.run("UPDATE employees SET status = 'suspended' WHERE id = 7");
    expect(db.queryOne<{ status: string }>('SELECT status FROM employees WHERE id = 7')?.status).toBe('suspended');
    expect(() => db.run("UPDATE employees SET status = 'on_vacation' WHERE id = 7")).toThrow();

    const indexes = db.queryAll<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'employees'"
    ).map((r) => r.name);
    expect(indexes).toContain('idx_employees_nickname');
    expect(db.queryOne<{ employee_id: number }>('SELECT employee_id FROM attendance_records WHERE id = 1')?.employee_id).toBe(7);
    expect(db.queryAll('PRAGMA foreign_key_check')).toEqual([]);

    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
});
