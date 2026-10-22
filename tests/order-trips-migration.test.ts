import {it,expect,vi} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
it('backfills only unambiguous legacy trip links and preserves commercial quantities on restart',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vds-trip-upgrade-'));
 process.env.DB_PATH=path.join(dir,'data.db');process.env.BACKUP_DIR=path.join(dir,'backups');process.env.UPLOAD_DIR=path.join(dir,'uploads');
 let db=await import('../src/shared/db');
 try{
  db.init();
  for(const n of [1,2]){
   db.run("INSERT INTO orders(id,type,number,status,fulfilled_at) VALUES(?,'sale',?,'confirmed',datetime('now'))",n,'SO-LEGACY-'+n);
   db.run("INSERT INTO order_items(id,order_id,name,quantity,unit_price,line_total,released_qty) VALUES(?,?,'Legacy',5,10,50,5)",n,n);
   db.run("INSERT INTO release_slips(id,order_id,number,collected_by) VALUES(?,?,?,'Collector')",n,n,'RS-LEGACY-'+n);
   db.run("INSERT INTO release_slip_items(slip_id,order_item_id,name,quantity) VALUES(?,?,'Legacy',5)",n,n);
   db.run("INSERT INTO deliveries(number,order_id) VALUES(?,?)",'DEL-LEGACY-'+n,n);
  }
  db.run("INSERT INTO deliveries(number,order_id) VALUES('DEL-AMBIGUOUS',2)");
  db.db.exec(`DROP INDEX idx_delivery_active_trip; DROP INDEX idx_delivery_slip;
    ALTER TABLE deliveries DROP COLUMN release_slip_id;
    ALTER TABLE production_batch_allocations DROP COLUMN release_slip_id;
    ALTER TABLE order_items DROP COLUMN dispatched_qty;
    ALTER TABLE order_items DROP COLUMN dispatched_bulk_qty;
    ALTER TABLE order_items DROP COLUMN cancelled_qty;
    DROP TABLE release_slip_units; DROP TABLE order_remainder_cancellations;`);
  db.run("DELETE FROM settings WHERE key='trip_manifest_backfilled_v84'");db.setSetting('schema_version',83);
  db.closeAllConnections();vi.resetModules();db=await import('../src/shared/db');db.init();
  expect(db.queryAll('SELECT quantity,dispatched_qty,dispatched_bulk_qty,cancelled_qty FROM order_items ORDER BY id')).toEqual([
   {quantity:5,dispatched_qty:5,dispatched_bulk_qty:5,cancelled_qty:0},{quantity:5,dispatched_qty:5,dispatched_bulk_qty:5,cancelled_qty:0}]);
  expect(db.queryAll('SELECT release_slip_id FROM deliveries ORDER BY id')).toEqual([{release_slip_id:1},{release_slip_id:null},{release_slip_id:null}]);
  db.run('UPDATE order_items SET cancelled_qty=1 WHERE id=1');
  db.closeAllConnections();vi.resetModules();db=await import('../src/shared/db');db.init();
  expect(db.queryOne<{cancelled_qty:number}>('SELECT cancelled_qty FROM order_items WHERE id=1')!.cancelled_qty).toBe(1);
  expect(db.getSetting('schema_version')).toBe(db.SCHEMA_VERSION);
 }finally{db.closeAllConnections();fs.rmSync(dir,{recursive:true,force:true});}
});
