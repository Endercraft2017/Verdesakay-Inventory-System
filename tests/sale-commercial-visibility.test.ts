import { describe, expect, it } from 'vitest';
import { redactSaleCommercial } from '../src/shared/cost-visibility';
import type { AuthUser } from '../src/shared/types';
const user = (permissions: AuthUser['permissions']) => ({ permissions });
describe('operational sale visibility', () => {
  it('removes nested sale money while preserving stock, trips and quantity totals', () => {
    const source = { order: { type: 'sale', total: 123, tax_percent: 12, notes: 'Keep delivery instructions', items: [{ quantity: 4, unit_price: 30, line_total: 120 }] }, qty_total: 4, total_qty: 4, trips: [{ number: 'OUT-1' }], margin_percent: 20 };
    expect(redactSaleCommercial(source, user(['orders.view','inventory.adjust']), '/api/release-slips/orders/1/context')).toEqual({order:{type:'sale',notes:'Keep delivery instructions',items:[{quantity:4}]},qty_total:4,total_qty:4,trips:[{number:'OUT-1'}]});
    expect(source.order.total).toBe(123);
  });
  it('keeps commercial data for an explicit sales editor and leaves unrelated APIs alone', () => {
    const source={total:100,items:[{unit_price:100}]};
    expect(redactSaleCommercial(source,user(['orders.edit']),'/api/orders/1')).toBe(source);
    expect(redactSaleCommercial(source,user(['orders.view']),'/api/purchasing/requests')).toBe(source);
    expect(redactSaleCommercial(source,user(['purchasing.view','inventory.costs']),'/api/purchasing/orders/1')).toBe(source);
  });
  it('does not equate cost visibility or physical release to commercial authority', () => {
    for(const permission of ['inventory.costs','orders.release'] as const)expect(redactSaleCommercial({total:123,quantity:2},user([permission]),'/api/customers/1')).toEqual({quantity:2});
  });
});
