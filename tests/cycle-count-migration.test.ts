import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

describe('existing physical-count database upgrade',()=>{
  it('adds planned checks without changing an earlier count',async()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vds-cycle-count-upgrade-'));
    process.env.DB_PATH=path.join(dir,'data.db');
    process.env.BACKUP_DIR=path.join(dir,'backups');
    process.env.UPLOAD_DIR=path.join(dir,'uploads');
    let db=await import('../src/shared/db');
    try{
      db.init();
      const item=Number(db.run("INSERT INTO inventory_items(name,quantity) VALUES('Previously counted item',0)").lastInsertRowid);
      const location=db.queryOne<{id:number}>('SELECT id FROM locations ORDER BY id LIMIT 1')!.id;
      const count=Number(db.run(`INSERT INTO stock_counts(item_id,location_id,build_mode,book_quantity,book_serial_ids,
        book_batches,counted_untracked,counted_serial_ids,counted_batches,note,source_kind)
        VALUES(?,?,'assembled',0,'[]','[]',0,'[]','[]','Previously checked shelf','manual')`,item,location).lastInsertRowid);
      db.db.exec('DROP INDEX idx_stock_counts_task; ALTER TABLE stock_counts DROP COLUMN task_id; DROP TABLE stock_count_tasks');
      db.setSetting('schema_version',89);
      db.closeAllConnections();
      vi.resetModules();
      db=await import('../src/shared/db');
      db.init();
      expect(db.queryOne<{id:number;task_id:number|null;note:string}>(
        'SELECT id,task_id,note FROM stock_counts WHERE id=?',count)).toEqual({id:count,task_id:null,note:'Previously checked shelf'});
      expect(db.queryOne<{name:string}>('SELECT name FROM sqlite_master WHERE type=\'table\' AND name=\'stock_count_tasks\''))
        .toEqual({name:'stock_count_tasks'});
      expect(db.getSetting<number>('schema_version')).toBe(db.SCHEMA_VERSION);
    }finally{db.closeAllConnections();fs.rmSync(dir,{recursive:true,force:true});}
  });
});
