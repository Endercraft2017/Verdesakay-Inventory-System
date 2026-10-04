/** SCHEMA_VERSION 56: an employee created at ₱0 and given a rate later had a ₱0 rate-history row
    at their start date, so every cutoff day before the new rate's effective date still paid ₱0.
    Upgrading a v55 DB gives those leading ₱0 rows the first real rate, and leaves a deliberate ₱0
    after a real rate alone. Own file because src/shared/db reads DB_PATH once, at import. */
import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

describe('employee_rate_history unset-rate repair', () => {
  it('fills leading ₱0 rows from the first real rate (or the current rate) on upgrade to v56', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-unsetrate-'));
    process.env.DB_PATH = path.join(tmpDir, 'data.db');
    process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
    process.env.BACKUP_DIR = path.join(tmpDir, 'backups');
    delete process.env.ADMIN_PASSWORD;

    // A current-schema DB holding the broken v55 state, then marked as v55.
    let db = await import('../src/shared/db');
    db.init();
    const emp = (no: string, rate: number) =>
      Number(db.run("INSERT INTO employees (employee_no, name, daily_rate, start_date) VALUES (?, ?, ?, '2020-01-01')", no, no, rate).lastInsertRowid);
    const hist = (id: number, from: string, rate: number) =>
      db.run("INSERT INTO employee_rate_history (employee_id, effective_from, rate_type, daily_rate) VALUES (?, ?, 'daily', ?)", id, from, rate);
    const edited = emp('EDITED', 700); // ₱0 start row, then a real rate from the edit's date
    hist(edited, '2020-01-01', 0); hist(edited, '2026-10-04', 700);
    const imported = emp('IMPORTED', 650); // rate set by CSV import: history never logged it
    hist(imported, '2020-01-01', 0);
    const unpaid = emp('UNPAID', 0); // still no rate at all
    hist(unpaid, '2020-01-01', 0);
    const later = emp('LATERZERO', 0); // real rate, then a deliberate ₱0 — kept
    hist(later, '2020-01-01', 500); hist(later, '2026-01-01', 0);
    db.setSetting('schema_version', 55);
    db.db.close();

    vi.resetModules();
    db = await import('../src/shared/db');
    db.init();
    const rates = (id: number) => db.queryAll<{ effective_from: string; daily_rate: number }>(
      'SELECT effective_from, daily_rate FROM employee_rate_history WHERE employee_id = ? ORDER BY effective_from', id
    ).map((r) => [r.effective_from, r.daily_rate]);

    expect(rates(edited)).toEqual([['2020-01-01', 700], ['2026-10-04', 700]]);
    expect(rates(imported)).toEqual([['2020-01-01', 650]]);
    expect(rates(unpaid)).toEqual([['2020-01-01', 0]]);
    expect(rates(later)).toEqual([['2020-01-01', 500], ['2026-01-01', 0]]);
    expect(db.getSetting<number>('schema_version')).toBe(db.SCHEMA_VERSION);

    db.db.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
});
