/** Regression test for the SCHEMA_VERSION 22 "HR Payroll Slip" doc_template touch-up (src/db.ts,
    same "surgical string replace, admin customization survives" pattern as the SCHEMA_VERSION 16
    touch-up right above it in migrate()): an existing install's already-seeded template — which
    is insert-only, so a source change to payrollSlipTemplateBody() alone never reaches it — needs
    Half Days/Undertime Days, Undertime Day Pay, Night Differential, and the itemized Other
    Deductions loop patched in, or those new payslip fields would just silently never appear on
    an existing install's printed slip even after upgrading and restarting. Simulates an install
    already at schema_version 21 (one behind this fix), same shape tests/late-exempt-migration.
    test.ts and tests/offset-form-migration.test.ts use for their own "upgrading an old DB"
    scenarios. */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

// Shaped like payrollSlipTemplateBody() as of SCHEMA_VERSION 16 (has the days_absent row from
// that earlier touch-up, but none of this fix's new rows/lines yet).
const OLD_BODY = `<div class="slip">
  <div class="slip-row"><span class="l">Days Worked:</span><span class="v">{{days_worked}}</span></div>
  <div class="slip-row"><span class="l">Days Absent:</span><span class="v">{{days_absent}}</span></div>
  <div class="slip-cols">
    <div class="slip-col">
      <div class="slip-line"><span>Undertime</span><span>{{undertime_pay}}</span></div>
      <div class="slip-line"><span>Rest Day OT</span><span>{{rest_day_ot}}</span></div>
    </div>
    <div class="slip-col">
      <div class="slip-line"><span>Cash Advance</span><span>{{cash_advance}}</span></div>
      <div class="slip-line"><span>Late</span><span>{{late_absences}}</span></div>
    </div>
  </div>
</div>`;

describe('HR Payroll Slip template migration (SCHEMA_VERSION 22)', () => {
  it('patches Half Days/Undertime Days, Undertime Day Pay, Night Differential, and the Other Deductions loop into an existing install\'s template', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-slip-tpl-migrate-'));
    const dbPath = path.join(tmpDir, 'old.db');

    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE doc_templates (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL,
        type       TEXT NOT NULL DEFAULT 'generic',
        body       TEXT NOT NULL,
        created_by INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    raw.prepare("INSERT INTO doc_templates (name, body) VALUES ('HR Payroll Slip', ?)").run(OLD_BODY);
    raw.prepare("INSERT INTO settings (key, value) VALUES ('schema_version', '21')").run();
    raw.close();

    process.env.DB_PATH = dbPath;
    process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
    delete process.env.ADMIN_PASSWORD;

    const db = await import('../src/db');
    expect(db.SCHEMA_VERSION).toBeGreaterThan(21); // the fix itself: this must have been bumped
    expect(() => db.init()).not.toThrow();

    const tpl = db.queryOne<{ body: string }>("SELECT body FROM doc_templates WHERE name = 'HR Payroll Slip'");
    expect(tpl).toBeDefined();
    expect(tpl!.body).toContain('{{days_half}}');
    expect(tpl!.body).toContain('{{days_undertime}}');
    expect(tpl!.body).toContain('{{undertime_day_pay}}');
    expect(tpl!.body).toContain('{{night_diff_pay}}');
    expect(tpl!.body).toContain('{{#other_deductions}}');
    expect(tpl!.body).toContain('{{/other_deductions}}');
    // Nothing else in the admin's own body was disturbed — the two untouched rows survive verbatim.
    expect(tpl!.body).toContain('<span>Late</span><span>{{late_absences}}</span></div>');

    expect(db.getSetting<number>('schema_version')).toBe(db.SCHEMA_VERSION);

    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
});
