/** item-form-config catalog sanity: unique keys, valid tabs, core keys map to real
    inventory_items columns, and choice fields declare options. Loaded into a sandbox
    via `new Function` (browser classic script + CommonJS guard, like nav-config.js). */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

type Field = {
  key: string; label: string; tab: string; section: string; type: string;
  options?: string[]; source?: string; core?: boolean; visible: boolean; required: boolean; help?: string;
};
type Tab = { id: string; label: string };

function loadCatalog(): {
  ITEM_FORM_TABS: Tab[]; ITEM_FORM_SECTIONS: Tab[]; ITEM_CORE_KEYS: string[]; ITEM_FORM_DEFAULTS: Field[];
} {
  const file = path.join(import.meta.dirname, '../public/js/item-form-config.js');
  const src = fs.readFileSync(file, 'utf8');
  const mod: { exports: Record<string, unknown> } = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', src)(mod, mod.exports);
  return mod.exports as never;
}

// The columns that actually exist on inventory_items (src/db.ts).
const REAL_COLUMNS = ['name', 'sku', 'category', 'department_id', 'supplier_id', 'quantity', 'unit', 'min_quantity', 'unit_cost', 'location', 'notes'];

const { ITEM_FORM_TABS, ITEM_FORM_SECTIONS, ITEM_CORE_KEYS, ITEM_FORM_DEFAULTS } = loadCatalog();

describe('item-form-config catalog', () => {
  it('has the 7 ECOUNT tabs', () => {
    expect(ITEM_FORM_TABS.map((t) => t.id)).toEqual(
      ['default', 'info', 'qty', 'price', 'cost', 'additional', 'management']
    );
  });

  it('field keys are unique', () => {
    const keys = ITEM_FORM_DEFAULTS.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every field has a known tab and required/visible booleans', () => {
    const tabIds = new Set(ITEM_FORM_TABS.map((t) => t.id));
    for (const f of ITEM_FORM_DEFAULTS) {
      expect(f.key, 'field needs a key').toBeTruthy();
      expect(f.label, `field ${f.key} needs a label`).toBeTruthy();
      expect(tabIds.has(f.tab), `field ${f.key} has unknown tab "${f.tab}"`).toBe(true);
      expect(typeof f.visible).toBe('boolean');
      expect(typeof f.required).toBe('boolean');
    }
  });

  it('core fields map to real inventory_items columns', () => {
    for (const f of ITEM_FORM_DEFAULTS) {
      if (f.core) {
        expect(REAL_COLUMNS, `core field "${f.key}" is not a real column`).toContain(f.key);
        expect(ITEM_CORE_KEYS).toContain(f.key);
      } else {
        expect(REAL_COLUMNS, `non-core field "${f.key}" collides with a column`).not.toContain(f.key);
      }
    }
  });

  it('all real columns are represented as core fields', () => {
    const coreKeys = ITEM_FORM_DEFAULTS.filter((f) => f.core).map((f) => f.key).sort();
    expect(coreKeys).toEqual([...REAL_COLUMNS].sort());
  });

  it('every field has help text (for the tooltip)', () => {
    for (const f of ITEM_FORM_DEFAULTS) {
      expect(typeof f.help === 'string' && f.help.trim().length > 0, `field "${f.key}" needs help text`).toBe(true);
    }
  });

  it('radio/select fields declare a non-empty options list', () => {
    for (const f of ITEM_FORM_DEFAULTS) {
      if (f.type === 'radio' || f.type === 'select') {
        expect(Array.isArray(f.options) && f.options.length > 0, `field ${f.key} needs options`).toBe(true);
      }
    }
  });

  it('combobox fields declare a source', () => {
    for (const f of ITEM_FORM_DEFAULTS) {
      if (f.type === 'combobox') {
        expect(typeof f.source === 'string' && f.source.length > 0, `field ${f.key} needs a source`).toBe(true);
      }
    }
  });

  // The form ships trimmed to what the app actually uses; everything else stays in
  // the catalog but hidden, to be re-enabled per-field when its ERP module lands.
  it('only the essential + optional fields are visible by default', () => {
    const visible = ITEM_FORM_DEFAULTS.filter((f) => f.visible).map((f) => f.key).sort();
    expect(visible).toEqual(
      [
        // essentials
        'category', 'department_id', 'supplier_id', 'name', 'notes', 'quantity',
        'min_quantity', 'unit_cost', 'location', 'sku', 'spec', 'unit',
        // optional reference set
        'currency', 'barcode', 'image', 'manufacturer', 'model_no', 'purchase_price',
        'sale_price',
      ].sort()
    );
  });

  it('every visible field still sits on a real tab', () => {
    const tabIds = new Set(ITEM_FORM_TABS.map((t) => t.id));
    for (const f of ITEM_FORM_DEFAULTS.filter((x) => x.visible)) {
      expect(tabIds.has(f.tab), `visible field ${f.key} on unknown tab`).toBe(true);
    }
  });

  // `section` groups fields under headings in the admin Option panel (capability groups).
  it('section ids are unique', () => {
    const ids = ITEM_FORM_SECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of ITEM_FORM_SECTIONS) expect(s.label, `section ${s.id} needs a label`).toBeTruthy();
  });

  it('every field has a section that exists in ITEM_FORM_SECTIONS', () => {
    const sectionIds = new Set(ITEM_FORM_SECTIONS.map((s) => s.id));
    for (const f of ITEM_FORM_DEFAULTS) {
      expect(sectionIds.has(f.section), `field ${f.key} has unknown section "${f.section}"`).toBe(true);
    }
  });

  it('no section is defined but unused', () => {
    const used = new Set(ITEM_FORM_DEFAULTS.map((f) => f.section));
    for (const s of ITEM_FORM_SECTIONS) {
      expect(used.has(s.id), `section "${s.id}" is declared but no field uses it`).toBe(true);
    }
  });
});
