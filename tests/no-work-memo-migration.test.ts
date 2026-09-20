/** Regression test for a real, live bug found in production: an install whose `no_work_memo`
    form definition was created before the `apply_no_work` action existed (so its `actions`
    column defaulted to '[]' via the ALTER TABLE backfill) silently never fed generate-payslips
    at all — buildNoWorkResolver/noWorkFormIdsWithAction (src/routes/hr.routes.ts,
    src/form-actions.ts) only pull from forms carrying that action. The bug was invisible: the
    record list and Daily Time's day-tag display both read no_work_memo records directly by
    slug, not through the action, and an UNPAID memo is numerically indistinguishable from a
    plain absence either way — only a PAID memo (or one meant to override a Regular Holiday's
    own pay) ever exposed it. src/db.ts's seedNoWorkMemoForm() now backfills the action onto an
    existing row that's missing it, same "touch up an existing install" pattern already used for
    seedHrPayrollForm(). */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

describe('no_work_memo form migration', () => {
  it('backfills the apply_no_work action onto an existing no_work_memo form definition that is missing it', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-nowork-migrate-'));
    const dbPath = path.join(tmpDir, 'old.db');

    // Seed a DB with a no_work_memo form_definitions row shaped exactly like the base
    // CREATE TABLE (no `actions` column yet) — mimicking an install that had the form seeded
    // before the apply_no_work action concept existed. The later ALTER TABLE ADD COLUMN
    // actions TEXT NOT NULL DEFAULT '[]' backfills it to an empty array, same as it did for the
    // real install this bug was found on.
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
      VALUES ('No Work Memo', 'no_work_memo', 'NW', 'alert', ?)`)
      .run(JSON.stringify([
        { key: 'date_from', label: 'Date From', type: 'date', required: true, options: [], default: '' },
        { key: 'date_to', label: 'Date To', type: 'date', required: true, options: [], default: '' },
        { key: 'reason', label: 'Reason', type: 'textarea', required: true, options: [], default: '' },
        { key: 'paid', label: 'Paid?', type: 'select', required: true, options: ['Yes', 'No'], default: 'Yes' },
      ]));
    raw.close();

    const tmpUploads = path.join(tmpDir, 'uploads');
    process.env.DB_PATH = dbPath;
    process.env.UPLOAD_DIR = tmpUploads;
    delete process.env.ADMIN_PASSWORD;

    const db = await import('../src/shared/db');
    expect(() => db.init()).not.toThrow();

    const form = db.queryOne<{ id: number; actions: string }>(
      "SELECT id, actions FROM form_definitions WHERE slug = 'no_work_memo'"
    );
    expect(form).toBeDefined();
    const actions = JSON.parse(form!.actions) as { type: string }[];
    expect(actions.some((a) => a.type === 'apply_no_work')).toBe(true);

    // Confirm noWorkFormIds() (src/form-actions.ts) — the actual function generate-payslips
    // uses — now picks this form up, not just that the raw column looks right.
    const formActions = await import('../src/core/form-actions');
    expect(formActions.noWorkFormIds()).toContain(form!.id);

    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
});
