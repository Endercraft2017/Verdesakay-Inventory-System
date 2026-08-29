/**
 * Multi-level BOM: recursive explosion to raw materials, standard-cost roll-up, and
 * where-used. Pure — the caller supplies DB-backed resolvers (same pattern as
 * hr-payroll-compute.ts), so this is independently unit-testable.
 *
 * A component that is itself `is_finished_product` with its own BOM is a sub-assembly
 * and gets expanded; anything else is a leaf (raw material / bought-in part).
 */

export interface BomNodeItem {
  id: number;
  name: string;
  sku: string | null;
  unit: string | null;
  is_finished_product: number;
  /** Standard/purchase unit cost; 0 if unknown. */
  unit_cost: number;
}

export interface BomChild {
  component_item_id: number;
  quantity: number;
}

export interface BomResolvers {
  /** Direct BOM lines of `productId`. */
  children(productId: number): BomChild[];
  /** Item master row, or null if the id is dangling. */
  item(id: number): BomNodeItem | null;
  /** BOMs that reference `componentId` directly (for where-used). */
  parents(componentId: number): { product_item_id: number }[];
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const round4 = (n: number): number => Math.round((n + Number.EPSILON) * 10000) / 10000;

/* ---------------------------------------------------------------- explode --- */

export interface ExplodedLine {
  item_id: number;
  name: string;
  sku: string | null;
  unit: string | null;
  /** Total quantity needed to build `qty` of the top product. */
  total_qty: number;
  unit_cost: number;
  line_cost: number;
  /** Nesting depth of the deepest place this leaf appears. */
  depth: number;
}

export interface ExplodeResult {
  product_id: number;
  qty: number;
  /** Leaf materials, aggregated across the whole tree, sorted by name. */
  materials: ExplodedLine[];
  material_cost: number;
  /** true if a sub-assembly referenced itself (explosion was cut at that point). */
  had_cycle: boolean;
  /** Sub-assemblies encountered (id → total build qty), for a "make vs buy" view. */
  subassemblies: { item_id: number; name: string; total_qty: number }[];
}

export function explode(productId: number, qty: number, r: BomResolvers): ExplodeResult {
  const leaves = new Map<number, { line: ExplodedLine }>();
  const subs = new Map<number, { name: string; qty: number }>();
  let hadCycle = false;

  const walk = (pid: number, multiplier: number, depth: number, seen: Set<number>): void => {
    if (seen.has(pid)) { hadCycle = true; return; }
    const nextSeen = new Set(seen).add(pid);
    for (const c of r.children(pid)) {
      const it = r.item(c.component_item_id);
      if (!it) continue;
      const need = round4(Number(c.quantity) * multiplier);
      const childBom = it.is_finished_product ? r.children(it.id) : [];
      if (it.is_finished_product && childBom.length) {
        const s = subs.get(it.id) ?? { name: it.name, qty: 0 };
        s.qty = round4(s.qty + need);
        subs.set(it.id, s);
        walk(it.id, need, depth + 1, nextSeen);
      } else {
        const existing = leaves.get(it.id);
        if (existing) {
          existing.line.total_qty = round4(existing.line.total_qty + need);
          existing.line.line_cost = round2(existing.line.total_qty * existing.line.unit_cost);
          existing.line.depth = Math.max(existing.line.depth, depth);
        } else {
          leaves.set(it.id, {
            line: {
              item_id: it.id, name: it.name, sku: it.sku, unit: it.unit,
              total_qty: need, unit_cost: round4(it.unit_cost || 0),
              line_cost: round2(need * (it.unit_cost || 0)), depth,
            },
          });
        }
      }
    }
  };

  walk(productId, Math.max(1, Number(qty) || 1), 1, new Set());

  const materials = [...leaves.values()].map((v) => v.line)
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    product_id: productId,
    qty: Math.max(1, Number(qty) || 1),
    materials,
    material_cost: round2(materials.reduce((s, m) => s + m.line_cost, 0)),
    had_cycle: hadCycle,
    subassemblies: [...subs.entries()].map(([item_id, s]) => ({ item_id, name: s.name, total_qty: s.qty }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/* ------------------------------------------------------------ cost roll-up --- */

export interface CostLevel {
  item_id: number;
  name: string;
  qty_per_parent: number;
  unit_cost: number;      // fully-loaded (rolled up for sub-assemblies)
  extended: number;       // qty_per_parent * unit_cost
  is_subassembly: boolean;
}

export interface CostRollup {
  product_id: number;
  /** Fully-loaded material cost to make one unit. */
  unit_material_cost: number;
  /** Direct children with their extended cost. */
  lines: CostLevel[];
  had_cycle: boolean;
}

export function rollupCost(productId: number, r: BomResolvers): CostRollup {
  let hadCycle = false;

  const unitCostOf = (pid: number, seen: Set<number>): number => {
    if (seen.has(pid)) { hadCycle = true; return 0; }
    const it = r.item(pid);
    if (!it) return 0;
    const bom = it.is_finished_product ? r.children(pid) : [];
    if (!bom.length) return round4(it.unit_cost || 0);
    const nextSeen = new Set(seen).add(pid);
    let total = 0;
    for (const c of bom) total += Number(c.quantity) * unitCostOf(c.component_item_id, nextSeen);
    return round4(total);
  };

  const lines: CostLevel[] = r.children(productId).map((c) => {
    const it = r.item(c.component_item_id);
    const sub = !!it?.is_finished_product && r.children(c.component_item_id).length > 0;
    const uc = it ? unitCostOf(it.id, new Set([productId])) : 0;
    return {
      item_id: c.component_item_id,
      name: it?.name ?? `#${c.component_item_id}`,
      qty_per_parent: Number(c.quantity),
      unit_cost: round4(uc),
      extended: round2(Number(c.quantity) * uc),
      is_subassembly: sub,
    };
  });

  return {
    product_id: productId,
    unit_material_cost: round2(lines.reduce((s, l) => s + l.extended, 0)),
    lines,
    had_cycle: hadCycle,
  };
}

/* ------------------------------------------------------------- where-used --- */

export interface WhereUsedEntry {
  product_id: number;
  /** true = the component appears via a sub-assembly, not directly. */
  indirect: boolean;
}

export function whereUsed(componentId: number, r: BomResolvers): WhereUsedEntry[] {
  const out = new Map<number, boolean>(); // product_id → indirect
  const visit = (id: number, indirect: boolean, seen: Set<number>): void => {
    if (seen.has(id)) return;
    const nextSeen = new Set(seen).add(id);
    for (const p of r.parents(id)) {
      const prev = out.get(p.product_item_id);
      // a direct hit (indirect=false) always wins over an indirect one
      if (prev === undefined || (prev === true && !indirect)) out.set(p.product_item_id, indirect);
      visit(p.product_item_id, true, nextSeen);
    }
  };
  visit(componentId, false, new Set());
  return [...out.entries()].map(([product_id, indirect]) => ({ product_id, indirect }));
}
