/** Exact non-serialized production-lot stock. Receipts establish provenance; reservations
 * do not move stock. Legacy receipts are deliberately not guessed into remaining lots. */
import { queryAll, queryOne, run } from '../../shared/db';
export function batchBalances(batchId: number) {
    return queryAll<{
        location_id: number;
        location_name: string;
        on_hand: number;
        received: number;
        reserved: number;
        available: number;
    }>(`SELECT s.location_id, l.name AS location_name, s.quantity AS on_hand, s.received,
      COALESCE((SELECT SUM(a.quantity) FROM production_batch_allocations a WHERE a.batch_id=s.batch_id
        AND a.location_id=s.location_id AND a.state='reserved'),0) AS reserved,
      MAX(0,s.quantity-COALESCE((SELECT SUM(a.quantity) FROM production_batch_allocations a WHERE a.batch_id=s.batch_id
        AND a.location_id=s.location_id AND a.state='reserved'),0)) AS available
     FROM production_batch_stock s JOIN locations l ON l.id=s.location_id WHERE s.batch_id=? ORDER BY l.name`, batchId);
}
export function receiveBatch(batchId: number, location: number, quantity: number) {
    run(`INSERT INTO production_batch_stock(batch_id,location_id,quantity,received) VALUES(?,?,?,?)
    ON CONFLICT(batch_id,location_id) DO UPDATE SET quantity=quantity+excluded.quantity,received=received+excluded.received`, batchId, location, quantity, quantity);
}
export function restoreBatchStock(batchId: number, location: number, quantity: number) {
    run(`INSERT INTO production_batch_stock(batch_id,location_id,quantity,received) VALUES(?,?,?,0)
    ON CONFLICT(batch_id,location_id) DO UPDATE SET quantity=quantity+excluded.quantity`, batchId, location, quantity);
}
/** Remove the exact semi-built package lot selected for finishing. */
export function consumeSemiBatchUnit(batchId: number, itemId: number, location: number) {
    const source = queryOne<{ id: number }>(`SELECT b.id FROM production_batches b
      JOIN job_orders j ON j.id=b.job_order_id
      WHERE b.id=? AND COALESCE(b.product_item_id,j.product_item_id)=? AND j.build_mode='semi_built'`, batchId, itemId);
    const balance = batchBalances(batchId).find(x => x.location_id === location);
    if (!source || !balance || balance.available < 1)
        throw Object.assign(new Error('This semi-built batch has no free unit at the source location. Rescan its QR and review stock.'), { status: 409 });
    run('UPDATE production_batch_stock SET quantity=quantity-1 WHERE batch_id=? AND location_id=?', batchId, location);
}
export function allocateBatch(batchId: number, orderId: number, itemId: number, location: number, quantity: number, orderItemId?: number) {
    const b = batchBalances(batchId).find(x => x.location_id === location);
    if (!b || quantity > b.available + 1e-9)
        throw Object.assign(new Error('This batch no longer has that quantity free at the ship-from location. Rescan and review.'), { status: 409 });
    run(`INSERT INTO production_batch_allocations(batch_id,order_id,order_item_id,item_id,location_id,quantity,state) VALUES(?,?,?,?,?,?,'reserved')`, batchId, orderId, orderItemId ?? null, itemId, location, quantity);
}
export function undoBatchAllocations(orderId: number, itemId: number, amount: number, orderItemId?: number,allocationId?:number) {
    for (const a of queryAll<{
        id: number;
        quantity: number;
    }>(`SELECT id,quantity FROM production_batch_allocations WHERE order_id=? AND item_id=? AND (? IS NULL OR order_item_id=?) AND (? IS NULL OR id=?) AND state='reserved' ORDER BY id DESC`, orderId, itemId, orderItemId ?? null, orderItemId ?? null,allocationId??null,allocationId??null)) {
        if (amount <= 1e-9)
            break;
        const take = Math.min(amount, a.quantity);
        amount -= take;
        if (take >= a.quantity - 1e-9)
            run('DELETE FROM production_batch_allocations WHERE id=?', a.id);
        else
            run('UPDATE production_batch_allocations SET quantity=quantity-? WHERE id=?', take, a.id);
    }
}
/** Ship exact reserved lots or reverse that same shipment. Caller owns the transaction. */
export function shipBatches(orderId: number, itemId: number, shipped: boolean, mode?: string): number {
    let total = 0;
    for (const a of queryAll<{
        id: number;
        batch_id: number;
        location_id: number;
        quantity: number;
    }>(`SELECT a.* FROM production_batch_allocations a JOIN production_batches pb ON pb.id=a.batch_id
      JOIN job_orders j ON j.id=pb.job_order_id WHERE a.order_id=? AND a.item_id=? AND a.state=?
      AND (? IS NULL OR j.build_mode=?)`, orderId, itemId, shipped ? 'reserved' : 'shipped', mode ?? null, mode ?? null)) {
        const b = batchBalances(a.batch_id).find(x => x.location_id === a.location_id);
        if (shipped && (!b || b.on_hand + 1e-9 < a.quantity))
            throw Object.assign(new Error('Allocated batch stock changed. Reconcile before handoff.'), { status: 409 });
        run('UPDATE production_batch_stock SET quantity=quantity+? WHERE batch_id=? AND location_id=?', shipped ? -a.quantity : a.quantity, a.batch_id, a.location_id);
        run('UPDATE production_batch_allocations SET state=? WHERE id=?', shipped ? 'shipped' : 'reserved', a.id);
        total += a.quantity;
    }
    return total;
}
/** Ordinary stock-outs use untracked stock first, then free lots FIFO. Transfers retain
 * lot identity at destination. Reserved lots can only leave through their sale. */
export function consumeBatchPool(itemId: number, location: number, mode: string, amount: number, destination?: number) {
    const lots = queryAll<{
        batch_id: number;
        quantity: number;
        reserved: number;
    }>(`SELECT s.batch_id,s.quantity,
    COALESCE((SELECT SUM(a.quantity) FROM production_batch_allocations a WHERE a.batch_id=s.batch_id AND a.location_id=s.location_id AND a.state='reserved'),0) AS reserved
    FROM production_batch_stock s JOIN production_batches b ON b.id=s.batch_id JOIN job_orders j ON j.id=b.job_order_id
    WHERE COALESCE(b.product_item_id,j.product_item_id)=? AND j.build_mode=? AND s.location_id=? AND s.quantity>0 ORDER BY s.batch_id`, itemId, mode, location);
    if (!lots.length)
        return;
    const stock = queryOne<{
        quantity: number;
    }>('SELECT quantity FROM inventory_variant_stock WHERE item_id=? AND location_id=? AND build_mode=?', itemId, location, mode)?.quantity ?? 0;
    let left = Math.max(0, amount - Math.max(0, stock - lots.reduce((n, l) => n + l.quantity, 0)));
    const free = lots.reduce((n, l) => n + Math.max(0, l.quantity - l.reserved), 0);
    if (left > free + 1e-9)
        throw Object.assign(new Error('This stock includes batch quantities reserved for a sale. Undo their allocation before moving or adjusting them.'), { status: 409 });
    for (const l of lots) {
        if (left <= 1e-9)
            break;
        const take = Math.min(left, Math.max(0, l.quantity - l.reserved));
        left -= take;
        run('UPDATE production_batch_stock SET quantity=quantity-? WHERE batch_id=? AND location_id=?', take, l.batch_id, location);
        if (destination)
            run(`INSERT INTO production_batch_stock(batch_id,location_id,quantity,received) VALUES(?,?,?,0)
      ON CONFLICT(batch_id,location_id) DO UPDATE SET quantity=quantity+excluded.quantity`, l.batch_id, destination, take);
    }
}
