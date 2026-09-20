/** Regression test for a real bug I hit live: employees.late_exempt was added inside
    migrate() (src/db.ts), which only runs when the stored `schema_version` setting is behind
    SCHEMA_VERSION — I forgot to bump SCHEMA_VERSION when adding the column, so on an existing
    install (already at the then-current version) the ALTER TABLE never ran, even after a
    server restart. Invisible in the rest of the suite because setupApp() always builds a
    throwaway DB from scratch, where schema_version starts at 0 and migrate() always runs
    regardless of whether the constant was bumped — this test instead simulates an EXISTING
    install already sitting at schema_version 19 (one behind the fix), the same shape
    tests/hr-migration.test.ts uses for its own "upgrading an old DB" scenario. */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

describe('employees.late_exempt migration', () => {
  it('adds late_exempt to an existing install already at schema_version 19, without needing a version bump to have been forgotten again', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-lateexempt-migrate-'));
    const dbPath = path.join(tmpDir, 'old.db');

    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE employees (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_no TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        department_id INTEGER,
        position TEXT,
        daily_rate REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'probationary',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    raw.prepare("INSERT INTO employees (employee_no, name, daily_rate) VALUES ('EMP-1', 'Old Shape Employee', 800)").run();
    // Simulate an install already fully migrated as of the version BEFORE this fix.
    raw.prepare("INSERT INTO settings (key, value) VALUES ('schema_version', '19')").run();
    raw.close();

    process.env.DB_PATH = dbPath;
    process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
    delete process.env.ADMIN_PASSWORD;

    const db = await import('../src/shared/db');
    expect(db.SCHEMA_VERSION).toBeGreaterThan(19); // the fix itself: this must have been bumped
    expect(() => db.init()).not.toThrow();

    const cols = db.queryAll<{ name: string }>('PRAGMA table_info(employees)');
    expect(cols.some((c) => c.name === 'late_exempt')).toBe(true);

    const emp = db.queryOne<{ late_exempt: number }>("SELECT late_exempt FROM employees WHERE employee_no = 'EMP-1'");
    expect(emp?.late_exempt).toBe(0); // default off, existing rows unaffected

    expect(db.getSetting<number>('schema_version')).toBe(db.SCHEMA_VERSION);

    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
});
