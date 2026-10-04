/** An install whose overtime_request form was seeded before Early OT existed gets the
    `early_ot` checkbox appended on the next start (src/shared/db.ts seedHrRequestForms touch-up),
    without disturbing its other fields — so HR's Daily Time grid can save the tick on it. */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

describe('overtime_request early_ot touch-up', () => {
  it('appends early_ot to an existing Overtime Request definition that lacks it', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-early-ot-'));
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
    const f = (key: string, type = 'text') => ({ key, label: key, type, required: false, options: [], default: '' });
    raw.prepare(`INSERT INTO form_definitions (name, slug, number_prefix, icon, fields)
      VALUES ('Overtime Request', 'overtime_request', 'OT', 'history', ?)`)
      .run(JSON.stringify([f('employee_name', 'employee'), f('work_date', 'date'), f('hours_estimate', 'number'), f('reason', 'textarea'), f('approved_hours', 'number')]));
    raw.close();

    process.env.DB_PATH = dbPath;
    process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
    process.env.BACKUP_DIR = path.join(tmpDir, 'backups');
    delete process.env.ADMIN_PASSWORD;

    const db = await import('../src/shared/db');
    expect(() => db.init()).not.toThrow();
    const form = db.queryOne<{ fields: string }>("SELECT fields FROM form_definitions WHERE slug = 'overtime_request'")!;
    const fields = JSON.parse(form.fields) as { key: string; type: string }[];
    expect(fields.map((x) => x.key)).toEqual(['employee_name', 'work_date', 'hours_estimate', 'reason', 'approved_hours', 'early_ot']);
    expect(fields.find((x) => x.key === 'early_ot')!.type).toBe('checkbox');

    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
});
