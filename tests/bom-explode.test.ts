/** Multi-level BOM explosion / cost roll-up / where-used (pure, fake resolvers). */
import { describe, it, expect } from 'vitest';
import {
  explode, rollupCost, whereUsed,
  type BomResolvers, type BomNodeItem,
} from '../src/modules/manufacturing/bom-explode';

/**
 * Fixture tree:
 *   10 Bicycle (FP)
 *     ├─ 2× 20 Wheel (sub-assembly, FP)
 *     │    ├─ 1× 30 Rim        @ 100
 *     │    └─ 32× 31 Spoke     @ 2
 *     ├─ 1× 40 Frame           @ 500
 *     └─ 2× 31 Spoke           @ 2   (also used directly on the bike)
 */
const ITEMS: Record<number, BomNodeItem> = {
  10: { id: 10, name: 'Bicycle', sku: 'BIKE', unit: 'ea', is_finished_product: 1, unit_cost: 0 },
  20: { id: 20, name: 'Wheel', sku: 'WHL', unit: 'ea', is_finished_product: 1, unit_cost: 0 },
  30: { id: 30, name: 'Rim', sku: 'RIM', unit: 'ea', is_finished_product: 0, unit_cost: 100 },
  31: { id: 31, name: 'Spoke', sku: 'SPK', unit: 'ea', is_finished_product: 0, unit_cost: 2 },
  40: { id: 40, name: 'Frame', sku: 'FRM', unit: 'ea', is_finished_product: 0, unit_cost: 500 },
};
const BOM: Record<number, { component_item_id: number; quantity: number }[]> = {
  10: [
    { component_item_id: 20, quantity: 2 },
    { component_item_id: 40, quantity: 1 },
    { component_item_id: 31, quantity: 2 },
  ],
  20: [
    { component_item_id: 30, quantity: 1 },
    { component_item_id: 31, quantity: 32 },
  ],
};

const resolvers = (bom = BOM): BomResolvers => ({
  children: (id) => bom[id] ?? [],
  item: (id) => ITEMS[id] ?? null,
  parents: (cid) =>
    Object.entries(bom)
      .filter(([, rows]) => rows.some((r) => r.component_item_id === cid))
      .map(([pid]) => ({ product_item_id: Number(pid) })),
});

describe('explode', () => {
  it('resolves sub-assemblies down to raw materials and aggregates', () => {
    const r = explode(10, 1, resolvers());
    const byName = Object.fromEntries(r.materials.map((m) => [m.name, m]));
    // Spoke: 2 wheels × 32 + 2 direct = 66
    expect(byName.Spoke!.total_qty).toBe(66);
    // Rim: 2 wheels × 1 = 2
    expect(byName.Rim!.total_qty).toBe(2);
    expect(byName.Frame!.total_qty).toBe(1);
    expect(r.materials.map((m) => m.name)).toEqual(['Frame', 'Rim', 'Spoke']); // sorted
    expect(r.had_cycle).toBe(false);
  });

  it('scales by build quantity and reports sub-assemblies', () => {
    const r = explode(10, 10, resolvers());
    expect(r.materials.find((m) => m.name === 'Spoke')!.total_qty).toBe(660);
    expect(r.subassemblies).toEqual([{ item_id: 20, name: 'Wheel', total_qty: 20 }]);
  });

  it('sums material cost across the whole tree', () => {
    // per bike: Frame 500 + Rim 2×100 + Spoke 66×2 = 500 + 200 + 132 = 832
    expect(explode(10, 1, resolvers()).material_cost).toBe(832);
    expect(explode(10, 3, resolvers()).material_cost).toBe(2496);
  });

  it('detects a cycle instead of recursing forever', () => {
    const cyclic = { 1: [{ component_item_id: 2, quantity: 1 }], 2: [{ component_item_id: 1, quantity: 1 }] };
    const its: Record<number, BomNodeItem> = {
      1: { id: 1, name: 'A', sku: null, unit: null, is_finished_product: 1, unit_cost: 0 },
      2: { id: 2, name: 'B', sku: null, unit: null, is_finished_product: 1, unit_cost: 0 },
    };
    const r = explode(1, 1, {
      children: (id) => (cyclic as Record<number, { component_item_id: number; quantity: number }[]>)[id] ?? [],
      item: (id) => its[id] ?? null,
      parents: () => [],
    });
    expect(r.had_cycle).toBe(true);
  });

  it('ignores dangling component ids', () => {
    const r = explode(10, 1, resolvers({ 10: [{ component_item_id: 999, quantity: 5 }] }));
    expect(r.materials).toEqual([]);
    expect(r.material_cost).toBe(0);
  });
});

describe('rollupCost', () => {
  it('rolls sub-assembly cost up from its own components', () => {
    const r = rollupCost(10, resolvers());
    const wheel = r.lines.find((l) => l.item_id === 20)!;
    // wheel = Rim 100 + 32 × Spoke 2 = 164
    expect(wheel.unit_cost).toBe(164);
    expect(wheel.is_subassembly).toBe(true);
    expect(wheel.extended).toBe(328); // 2 wheels
    // bike unit cost = 328 + Frame 500 + 2×Spoke 2 = 832
    expect(r.unit_material_cost).toBe(832);
  });

  it('treats a plain component as its own unit cost', () => {
    const r = rollupCost(20, resolvers());
    expect(r.unit_material_cost).toBe(164);
    expect(r.lines.every((l) => !l.is_subassembly)).toBe(true);
  });
});

describe('whereUsed', () => {
  it('finds direct and indirect parents', () => {
    const u = whereUsed(31, resolvers()); // Spoke: direct on Bicycle, direct on Wheel, indirect on Bicycle via Wheel
    const byId = Object.fromEntries(u.map((e) => [e.product_id, e.indirect]));
    expect(byId[20]).toBe(false); // direct in Wheel
    expect(byId[10]).toBe(false); // direct in Bicycle wins over the indirect path
  });

  it('marks a purely indirect parent', () => {
    const u = whereUsed(30, resolvers()); // Rim: only in Wheel, which is in Bicycle
    const byId = Object.fromEntries(u.map((e) => [e.product_id, e.indirect]));
    expect(byId[20]).toBe(false);
    expect(byId[10]).toBe(true);
  });

  it('returns nothing for an unused item', () => {
    expect(whereUsed(40, resolvers({ 10: [] }))).toEqual([]);
  });
});
