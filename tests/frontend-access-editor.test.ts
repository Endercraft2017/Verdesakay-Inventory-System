import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import { ALL_PERMISSIONS } from '../src/shared/permissions';

let dom: JSDOM, w: any;
beforeEach(() => {
  dom = new JSDOM('<div id="picker"></div><div id="drawer-root"></div>', { runScripts: 'outside-only', url: 'https://localhost/', pretendToBeVisual: true });
  w = dom.window;
  w.eval(fs.readFileSync(new URL('../public/js/ui.js', import.meta.url), 'utf8') + ';window.UI=UI;');
  w.eval(fs.readFileSync(new URL('../public/js/lib/access-editor.js', import.meta.url), 'utf8'));
  w.API = { get: async () => ({ permissions: [...ALL_PERMISSIONS], roles: [] }) };
});
afterEach(() => dom.window.close());

async function picker(options: any = {}) {
  const on = new Set<string>();
  const root = w.document.querySelector('#picker');
  const catalog = await w.AccessEditor.getCatalog();
  w.AccessEditor.renderPicker(root, { catalog, isOn: (k: string) => on.has(k), onToggle: (k: string, value: boolean) => value ? on.add(k) : on.delete(k), ...options });
  return { root, on };
}
function search(value: string) {
  const input = w.document.querySelector('[data-pp-q]'); input.value = value;
  input.dispatchEvent(new w.Event('input', { bubbles: true }));
}

describe('shared account and role permission picker', () => {
  it('places every server permission in exactly one work area with an explanation', async () => {
    const catalog = await w.AccessEditor.getCatalog();
    const items = catalog.groups.flatMap((g: any) => g.items);
    expect(items.map((i: any) => i.key).sort()).toEqual([...ALL_PERMISSIONS].sort());
    expect(items.every((i: any) => i.desc?.length > 10)).toBe(true);
    const area = (key: string) => catalog.groups.find((g: any) => g.items.some((i: any) => i.key === key)).id;
    expect(area('orders.approve')).toBe(area('orders.create'));
    expect(area('payroll.approve')).toBe('payroll');
    expect(area('hr.timekeeping.manage')).toBe('timekeeping');
    expect(area('production.inspect_qa')).toBe('quality');
    expect(catalog.groups.some((g: any) => g.id === 'specific-duties')).toBe(false);
    w.API.get = async () => ({ permissions: [...ALL_PERMISSIONS, 'future.read'], roles: [] });
    const future = await w.AccessEditor.getCatalog(true);
    expect(future.groups.at(-1).items[0].key).toBe('future.read');
  });

  it('filters by area and explanation, and bulk changes only visible unlocked permissions', async () => {
    const { root, on } = await picker({ lockReason: (k: string) => k === 'orders.authorize' ? 'Locked for this editor' : null });
    const area = root.querySelector('[data-pp-group]'); area.value = 'orders'; area.dispatchEvent(new w.Event('change'));
    expect(root.querySelectorAll('.pp-group').length).toBe(1);
    search('authorization');
    const shown = [...root.querySelectorAll('[data-pp-key]')].map((x: any) => x.dataset.ppKey);
    expect(shown).toContain('orders.configure');
    root.querySelector('[data-on="1"]').click();
    expect([...on].sort()).toEqual(shown.filter(k => k !== 'orders.authorize').sort());
    expect(on.has('orders.create')).toBe(false);
    expect(root.querySelector('[data-pp-key="orders.authorize"]').disabled).toBe(true);
  });

  it('keeps keyboard focus after toggling and exposes filter state', async () => {
    const { root, on } = await picker();
    const checkbox = root.querySelector('[data-pp-key="inventory.receive"]');
    checkbox.focus(); checkbox.click();
    expect(on.has('inventory.receive')).toBe(true);
    expect(w.document.activeElement.dataset.ppKey).toBe('inventory.receive');
    expect(w.document.activeElement.getAttribute('aria-description')).toContain('purchase receipts');
    root.querySelector('[data-pp-show="on"]').click();
    expect(root.querySelectorAll('[data-pp-key]').length).toBe(1);
    expect(root.querySelector('[data-pp-show="on"]').getAttribute('aria-pressed')).toBe('true');
  });

  it('shows permission explanations on hover, focus and tap; Escape dismisses help', async () => {
    const { root } = await picker();
    const button = root.querySelector('[data-pp-key="production.record"]').closest('.pp-row').querySelector('.help-icon');
    button.dispatchEvent(new w.MouseEvent('mouseover', { bubbles: true }));
    expect(w.document.querySelector('[role="tooltip"]').textContent).toContain('assigned to you or your crew');
    button.dispatchEvent(new w.MouseEvent('mouseout', { bubbles: true }));
    expect(w.document.querySelector('[role="tooltip"]')).toBeNull();
    button.focus();
    expect(button.getAttribute('aria-describedby')).toBe(w.document.querySelector('[role="tooltip"]').id);
    button.click(); expect(button.getAttribute('aria-expanded')).toBe('true');
    button.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(w.document.querySelector('[role="tooltip"]')).toBeNull();
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });
});
