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

  it('shows off permissions and clears combined filters without changing grants', async () => {
    const { root, on } = await picker();
    on.add('orders.view');
    root.querySelector('[data-pp-show="off"]').click();
    expect(root.querySelector('[data-pp-key="orders.view"]')).toBeNull();
    root.querySelector('[data-pp-details]').click();
    expect(root.classList.contains('pp-show-details')).toBe(true);
    search('no such permission');
    root.querySelector('[data-pp-clear]').click();
    expect(root.querySelectorAll('[data-pp-key]').length).toBe(ALL_PERMISSIONS.length);
    expect([...on]).toEqual(['orders.view']);
    expect(w.document.activeElement).toBe(root.querySelector('[data-pp-q]'));
  });

  it('reviews and undoes role draft changes against the saved bundle', async () => {
    const role = { key: 'csr', label: 'CSR', permissions: ['mobile.access', 'orders.view'], user_count: 2 };
    w.API.get = async () => ({ permissions: [...ALL_PERMISSIONS], roles: [role] });
    await w.AccessEditor.editRole(role);
    w.document.querySelector('[data-pp-key="orders.create"]').click();
    w.document.querySelector('[data-pp-key="orders.view"]').click();
    w.document.querySelector('[data-pp-show="changed"]').click();
    expect(w.document.querySelectorAll('[data-pp-key]').length).toBe(2);
    expect(w.document.querySelector('[data-pp-summary]').textContent).toContain('1 added · 1 removed in this draft');
    expect(w.document.querySelector('.pp-tag.added').textContent).toBe('Added to role');
    w.document.querySelector('[data-pp-reset="orders.create"]').click();
    w.document.querySelector('[data-pp-reset="orders.view"]').click();
    expect(w.document.querySelectorAll('[data-pp-key]').length).toBe(0);
    expect(w.document.querySelector('[data-pp-list]').textContent).toContain('No permission changes');
  });
});

describe('shared role chooser', () => {
  async function chooser(disabled = false) {
    const roles = [
      { key: 'employee', label: 'Employee', description: 'Phone and messages', permissions: ['mobile.access'] },
      { key: 'custom_shipping', label: 'Shipping specialist', description: 'Customer handoff', permissions: ['orders.release'] },
      { key: 'admin', label: 'Administrator', fixed: true, permissions: [...ALL_PERMISSIONS] },
    ];
    w.API.get = async () => ({ permissions: [...ALL_PERMISSIONS], roles });
    const catalog = await w.AccessEditor.getCatalog(true);
    // The server's assignable options, not the full catalog, determine available choices.
    w.document.querySelector('#picker').innerHTML = `<select id="role" ${disabled ? 'disabled' : ''}><option value="employee">Employee</option><option value="custom_shipping">Shipping specialist</option></select><div id="preview"></div>`;
    const select = w.document.querySelector('#role');
    const control = w.AccessEditor.enhanceRoleSelect(select, catalog, w.document.querySelector('#preview'));
    return { select, control, trigger: w.document.querySelector('.role-picker-trigger'), query: w.document.querySelector('[data-role-query]') };
  }
  it('finds custom roles by their permissions, selects the exact key, and previews the grant', async () => {
    const { select, trigger, query } = await chooser();
    let changes = 0; select.addEventListener('change', () => changes++);
    trigger.click(); query.value = 'release sale'; query.dispatchEvent(new w.Event('input'));
    expect(w.document.querySelectorAll('[data-role-choice]').length).toBe(1);
    expect(w.document.querySelector('[data-role-choice="admin"]')).toBeNull();
    w.document.querySelector('[data-role-choice="custom_shipping"]').click();
    expect(select.value).toBe('custom_shipping');
    expect(changes).toBe(1);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(w.document.activeElement).toBe(trigger);
    expect(w.document.querySelector('#preview').textContent).toContain('Release sale orders');
    expect(w.document.querySelector('#preview').textContent).not.toContain('Approve sales');
  });
  it('keeps the selected role when search is dismissed and respects disabled assignments', async () => {
    const { select, trigger, query, control } = await chooser();
    let inputs = 0, changes = 0;
    w.document.querySelector('#picker').addEventListener('input', () => inputs++);
    select.addEventListener('change', () => changes++);
    trigger.click(); query.value = 'unknown'; query.dispatchEvent(new w.Event('input', { bubbles: true }));
    expect(w.document.querySelector('.role-picker-empty').textContent).toContain('No matching');
    w.document.querySelector('[data-role-clear]').click();
    expect(w.document.querySelectorAll('[data-role-choice]').length).toBe(2);
    w.document.querySelector('[data-role-choice="employee"]').click();
    expect(changes).toBe(0);
    expect(inputs).toBe(0);
    trigger.click();
    query.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(select.value).toBe('employee');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    select.disabled = true; control.refresh();
    expect(trigger.disabled).toBe(true);
    trigger.click(); expect(w.document.querySelector('.role-picker-panel').hidden).toBe(true);
  });
});
