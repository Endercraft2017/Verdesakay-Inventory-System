// Historical discrepancy fixtures live only in the disposable browser-audit database.
import './editor-ux-server';
import os from 'node:os';
import path from 'node:path';
if (process.env.NODE_ENV !== 'test' || !path.resolve(process.env.DB_PATH || '').startsWith(path.resolve(os.tmpdir()) + path.sep)) {
  throw new Error('Stock-count fixtures require the disposable local test server.');
}
const { run } = await import('../../src/shared/db');
const { applyStockChange } = await import('../../src/modules/inventory/inventory-stock');
for (const name of ['Linked count recovery shelf', 'Linked stale count shelf', 'Linked separately resolved shelf']) {
  const itemId = Number(run('INSERT INTO inventory_items(name) VALUES(?)', name).lastInsertRowid);
  applyStockChange({ itemId, locationId:1, change:5, reason:'Browser test fixture receipt', userId:null });
  run(`INSERT INTO stock_discrepancies(item_id,location_id,change,location_balance_after,reason)
       VALUES(?,1,-1,5,'Historical offline discrepancy fixture')`, itemId);
}
