import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

describe('existing delivery database upgrade', () => {
  it('adds courier fields without changing a pending own-driver booking', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-courier-upgrade-'));
    process.env.DB_PATH = path.join(dir, 'data.db');
    process.env.BACKUP_DIR = path.join(dir, 'backups');
    process.env.UPLOAD_DIR = path.join(dir, 'uploads');
    let db = await import('../src/shared/db');
    try {
      db.init();
      db.db.exec('DROP TABLE deliveries');
      db.db.exec(`CREATE TABLE deliveries (
        id INTEGER PRIMARY KEY AUTOINCREMENT, number TEXT NOT NULL UNIQUE, order_id INTEGER,
        customer_name TEXT, address TEXT, contact_phone TEXT, scheduled_date TEXT,
        assigned_to INTEGER, status TEXT NOT NULL DEFAULT 'pending', notes TEXT,
        pod_recipient TEXT, pod_signature_attachment_id INTEGER, pod_lat REAL, pod_lng REAL,
        pod_note TEXT, delivered_at TEXT, delivered_by INTEGER, created_by INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      ); INSERT INTO deliveries (number,customer_name) VALUES ('DEL-OLD','Existing customer')`);
      db.setSetting('schema_version', 80);
      db.closeAllConnections();
      vi.resetModules();
      db = await import('../src/shared/db');
      db.init();
      expect(db.queryOne<{ delivery_mode: string; courier_name: string | null; tracking_number: string | null }>(
        "SELECT delivery_mode,courier_name,tracking_number FROM deliveries WHERE number='DEL-OLD'"))
        .toEqual({ delivery_mode: 'own', courier_name: null, tracking_number: null });
      expect(db.getSetting<number>('schema_version')).toBe(db.SCHEMA_VERSION);
    } finally {
      db.closeAllConnections();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
