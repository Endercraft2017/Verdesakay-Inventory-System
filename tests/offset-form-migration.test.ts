/** Regression-style coverage for the offset_form "New Time In" touch-up: an install that
    already had offset_form seeded (or hand-created) before the field existed only ever had
    `new_time_out`. src/db.ts's seedHrRequestForms() now backfills `new_time_in` onto an
    existing offset_form row that's missing it, inserted right before new_time_out, same
    "touch up an existing install" pattern already used for seedHrPayrollForm()/no_work_memo.
    Without this, an existing install would never get the field even after upgrading and
    restarting — a full 8-5 -> 10-7 offset would stay impossible to file on that install. */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

describe('offset_form migration', () => {
  it('backfills new_time_in onto an existing offset_form definition that only has new_time_out', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-offset-migrate-'));
    const dbPath = path.join(tmpDir, 'old.db');

    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE form_definitions (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        name          TEXT NOT NULL,
        slug          TEXT NOT NULL UNIQUE,
        number_prefix TEXT NOT NULL DEFAULT 'FM',
        icon          TEXT NOT NULL DEFAULT 'file',
        fields        TEXT NOT NULL DEFAULT '[]',
        created_by    INTEGER,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at    TEXT
      );
    `);
    raw.prepare(`INSERT INTO form_definitions (name, slug, number_prefix, icon, fields)
      VALUES ('Offset Form', 'offset_form', 'OFS', 'history', ?)`)
      .run(JSON.stringify([
        { key: 'employee_name', label: 'Employee', type: 'employee', required: true, options: [], default: '' },
        { key: 'work_date', label: 'Date', type: 'date', required: true, options: [], default: '' },
        { key: 'new_time_out', label: 'New Time Out', type: 'time', required: true, options: [], default: '' },
        { key: 'reason', label: 'Reason', type: 'textarea', required: true, options: [], default: '' },
      ]));
    raw.close();

    const tmpUploads = path.join(tmpDir, 'uploads');
    process.env.DB_PATH = dbPath;
    process.env.UPLOAD_DIR = tmpUploads;
    delete process.env.ADMIN_PASSWORD;

    const db = await import('../src/shared/db');
    expect(() => db.init()).not.toThrow();

    const form = db.queryOne<{ id: number; fields: string }>(
      "SELECT id, fields FROM form_definitions WHERE slug = 'offset_form'"
    );
    expect(form).toBeDefined();
    const fields = JSON.parse(form!.fields) as { key: string }[];
    const keys = fields.map((f) => f.key);
    expect(keys).toContain('new_time_in');
    // Inserted right before new_time_out, not appended to the end or reordering anything else.
    expect(keys.indexOf('new_time_in')).toBe(keys.indexOf('new_time_out') - 1);
    expect(keys).toEqual(['employee_name', 'work_date', 'new_time_in', 'new_time_out', 'reason']);

    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
});
