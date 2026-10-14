/** A database already upgraded to the upload-recovery v66 must still receive the
 * sales-return migrations introduced after that version was published. */
import { describe, expect, it } from 'vitest';
import { cleanup, setupApp } from './helpers';

describe('schema v66 to v68 upgrade', () => {
  it('adds return tables without losing the v66 durable-upload table', async () => {
    const ctx = await setupApp();
    try {
      const db = await import('../src/shared/db');
      db.db.exec(`
        DROP TABLE sales_return_disposition_events;
        DROP TABLE sales_return_dispositions;
        DROP TABLE sales_return_credit_links;
        DROP TABLE sales_returns;
      `);
      db.setSetting('schema_version', 66);
      db.closeAllConnections();

      db.init();

      expect(db.getSetting<number>('schema_version')).toBe(68);
      for (const name of [
        'durable_uploads',
        'sales_returns',
        'sales_return_credit_links',
        'sales_return_dispositions',
        'sales_return_disposition_events',
      ]) {
        expect(db.queryOne("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", name)).toBeTruthy();
      }
    } finally {
      cleanup(ctx);
    }
  });
});
