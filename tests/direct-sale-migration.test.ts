import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

describe('existing direct-unit sale upgrade', () => {
  it('credits unslipped sold units while leaving fulfilled sales unmarked', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-direct-sale-upgrade-'));
    process.env.DB_PATH = path.join(dir, 'data.db');
    process.env.BACKUP_DIR = path.join(dir, 'backups');
    process.env.UPLOAD_DIR = path.join(dir, 'uploads');
    let db = await import('../src/shared/db');
    try {
      db.init();
      db.db.exec(`
        INSERT INTO inventory_items (id,name,quantity,is_finished_product) VALUES (1001,'Existing unit',0,1);
        INSERT INTO orders (id,type,number,status) VALUES (1001,'sale','SO-DIRECT-OLD','approved');
        INSERT INTO orders (id,type,number,status,fulfilled_at) VALUES (1002,'sale','SO-SLIPPED-OLD','confirmed',datetime('now'));
        INSERT INTO orders (id,type,number,status) VALUES (1003,'sale','SO-PARTIAL-OLD','approved');
        INSERT INTO order_items (id,order_id,item_id,name,quantity) VALUES (1001,1001,1001,'Existing unit',1);
        INSERT INTO order_items (id,order_id,item_id,name,quantity) VALUES (1002,1002,1001,'Existing unit',1);
        INSERT INTO order_items (id,order_id,item_id,name,quantity,dispatched_qty) VALUES (1003,1003,1001,'Existing unit',2,1);
        INSERT INTO job_orders (id,number,product_item_id,product_name,qty_ordered) VALUES (1001,'JO-DIRECT-OLD',1001,'Existing unit',4);
        INSERT INTO job_order_units (id,job_order_id,product_item_id,status,order_id,order_item_id)
          VALUES (1001,1001,1001,'sold',1001,1001),(1002,1001,1001,'sold',1002,1002),
            (1003,1001,1001,'sold',1003,1003),(1004,1001,1001,'sold',1003,1003);
        INSERT INTO release_slips (id,number,order_id,released_at) VALUES (1003,'RS-PARTIAL-OLD',1003,datetime('now','-1 day'));
        INSERT INTO release_slip_items (id,slip_id,order_item_id,item_id,name,quantity)
          VALUES (1003,1003,1003,1001,'Existing unit',1);
        INSERT INTO release_slip_units (slip_item_id,unit_id) VALUES (1003,1004);
      `);
      db.db.exec('ALTER TABLE job_order_units DROP COLUMN direct_sold_at');
      db.setSetting('schema_version', 84);
      db.closeAllConnections();
      vi.resetModules();
      db = await import('../src/shared/db');
      db.init();
      expect(db.queryOne<{ direct_sold_at: string | null }>('SELECT direct_sold_at FROM job_order_units WHERE id = 1001')?.direct_sold_at).toBeTruthy();
      expect(db.queryOne<{ direct_sold_at: string | null }>('SELECT direct_sold_at FROM job_order_units WHERE id = 1002')?.direct_sold_at).toBeNull();
      expect(db.queryOne<{ direct_sold_at: string | null }>('SELECT direct_sold_at FROM job_order_units WHERE id = 1003')?.direct_sold_at).toBeTruthy();
      expect(db.queryOne<{ direct_sold_at: string | null }>('SELECT direct_sold_at FROM job_order_units WHERE id = 1004')?.direct_sold_at).toBeNull();
      expect(db.getSetting<number>('schema_version')).toBe(db.SCHEMA_VERSION);
    } finally {
      db.closeAllConnections();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
