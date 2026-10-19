import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

async function setup(permissions: string[], forms: unknown[], filter = {}) {
  const dom = new JSDOM('<main></main>', { runScripts: 'outside-only', url: 'http://localhost' });
  const w = dom.window;
  w.eval(`window.routes = {}; window.App = {
    register: (name, handler) => routes[name] = handler,
    hasPermission: p => ${JSON.stringify(permissions)}.includes(p),
    replaceFilters: (route, filter) => window.savedFilters = { route, filter },
    navigate: (route, filter) => window.destination = { route, filter }
  }; window.API = { get: async () => (${JSON.stringify(forms)}) };
  window.UI = { esc: s => String(s), icon: () => '', emptyState: s => s.title + ' ' + s.hint + (s.action || '') };`);
  for (const file of ['lib/data-forms.js', 'lib/form-print.js', 'lib/form-connections.js', 'lib/form-math.js', 'lib/form-items.js', 'modules/core/form-records.js']) {
    w.eval(fs.readFileSync(path.join(import.meta.dirname, '../public/js', file), 'utf8'));
  }
  await (w as any).routes['form-records'](w.document.querySelector('main'), filter);
  return dom;
}
const form = (id: number, scope: string | null, name: string) => ({ id, scope, name, slug: name.toLowerCase(), fields: [], record_count: 0, number_prefix: 'FM' });

describe('Data Forms section workflow', () => {
  it('lists form metadata in sortable columns', async () => {
    const dom = await setup(['forms.manage.hr'], [
      { ...form(1, 'hr', 'Leave'), record_count: 3, fields: [{ key: 'reason' }] },
      { ...form(2, 'hr', 'Overtime'), record_count: 12, fields: [{ key: 'hours' }, { key: 'reason' }] },
    ], { scope: 'hr' });
    const w = dom.window;
    expect([...w.document.querySelectorAll('.form-explorer th')].map(th => th.textContent?.trim())).toEqual(['Form name ↑', 'Records', 'Fields', 'Number format', 'Updated', 'Favorite']);
    expect([...w.document.querySelectorAll('.form-explorer tbody .form-card-name')].map(cell => cell.textContent)).toEqual(['Leave', 'Overtime']);
    w.document.querySelector<HTMLElement>('[data-form-sort="records"]')!.click();
    expect([...w.document.querySelectorAll('.form-explorer tbody .form-card-name')].map(cell => cell.textContent)).toEqual(['Leave', 'Overtime']);
    w.document.querySelector<HTMLElement>('[data-form-sort="records"]')!.click();
    expect([...w.document.querySelectorAll('.form-explorer tbody .form-card-name')].map(cell => cell.textContent)).toEqual(['Overtime', 'Leave']);
    dom.window.close();
  });

  it('shows accessible sections, searches forms and preserves the section on open', async () => {
    const dom = await setup(['forms.manage.inventory'], [form(1, 'inventory', 'Stock'), form(2, 'hr', 'Leave'), form(3, null, 'General')], { scope: 'inventory' });
    const w = dom.window;
    expect(w.document.querySelectorAll('.form-card')).toHaveLength(1);
    expect(w.document.body.textContent).not.toContain('Leave');
    const input = w.document.querySelector<HTMLInputElement>('#fr-index-search')!;
    input.value = 'missing'; input.dispatchEvent(new w.Event('input'));
    expect(w.document.body.textContent).toContain('No matching forms');
    input.value = 'stock'; input.dispatchEvent(new w.Event('input'));
    w.document.querySelector<HTMLElement>('.form-card')!.click();
    expect((w as any).destination).toEqual({ route: 'form-records', filter: { form_id: '1', scope: 'inventory', index_q: 'stock' } });
    dom.window.close();
  });

  it('opens the current section builder when that section is empty', async () => {
    const dom = await setup(['forms.manage.hr', 'forms.manage.inventory'], [], { scope: 'inventory' });
    dom.window.document.querySelector<HTMLElement>('#fr-goto-builder')!.click();
    expect((dom.window as any).destination).toEqual({ route: 'form-builder', filter: { scope: 'inventory' } });
    dom.window.close();
  });

  it('filters the combined index by section and keeps General admin-managed', async () => {
    const dom = await setup(['hr', 'inventory', 'admin', 'accounting'].map(s => 'forms.manage.' + s), [form(1, 'inventory', 'Stock'), form(2, 'hr', 'Leave'), form(3, null, 'General')]);
    expect(dom.window.document.querySelectorAll('.form-card')).toHaveLength(3);
    const select = dom.window.document.querySelector<HTMLSelectElement>('#fr-index-scope')!;
    select.value = 'general'; select.dispatchEvent(new dom.window.Event('change'));
    expect(dom.window.document.querySelectorAll('.form-card')).toHaveLength(1);
    expect(dom.window.document.querySelector('.form-card-name')?.textContent).toBe('General');
    dom.window.close();
  });

  it('restores index search and section filters and persists changes', async () => {
    const dom = await setup(['forms.manage.hr', 'forms.manage.inventory'], [form(1, 'inventory', 'Stock'), form(2, 'hr', 'Leave')], { scope: 'inventory', q: 'Stock' });
    const w = dom.window;
    expect(w.document.querySelector<HTMLInputElement>('#fr-index-search')!.value).toBe('Stock');
    expect(w.document.querySelector<HTMLSelectElement>('#fr-index-scope')!.value).toBe('inventory');
    const input = w.document.querySelector<HTMLInputElement>('#fr-index-search')!;
    input.value = ''; input.dispatchEvent(new w.Event('input'));
    const section = w.document.querySelector<HTMLSelectElement>('#fr-index-scope')!;
    section.value = 'hr'; section.dispatchEvent(new w.Event('change'));
    expect((w as any).savedFilters).toEqual({ route: 'form-records', filter: { scope: 'hr' } });
    expect(w.document.querySelector('.form-card-name')?.textContent).toBe('Leave');
    w.document.querySelector<HTMLElement>('#fr-goto-builder')!.click();
    expect((w as any).destination).toEqual({ route: 'form-builder', filter: { scope: 'hr' } });
    dom.window.close();
  });


  it('lets payroll readers browse the HR hub without granting the form builder', async () => {
    const payroll = { ...form(1, 'hr', 'Payroll'), slug: 'hr_payroll' };
    const dom = await setup(['payroll.view'], [payroll, form(2, 'hr', 'Leave')], { scope: 'hr' });
    expect(dom.window.document.querySelectorAll('.form-card')).toHaveLength(1);
    expect(dom.window.document.querySelector('.form-card-name')?.textContent).toBe('Payroll');
    expect(dom.window.document.querySelector('#fr-goto-builder')).toBeNull();
    expect(dom.window.document.querySelector<HTMLSelectElement>('#fr-index-scope')!.value).toBe('hr');
    dom.window.document.querySelector<HTMLElement>('.form-card')!.click();
    expect((dom.window as any).destination.filter).toMatchObject({ form_id: '1', slug: 'hr_payroll', scope: 'hr' });
    dom.window.close();
  });

  it('hides the builder for a payroll-only section even when another section is manageable', async () => {
    const dom = await setup(['payroll.view', 'forms.manage.inventory'], [form(1, 'hr', 'Payroll')]);
    const select = dom.window.document.querySelector<HTMLSelectElement>('#fr-index-scope')!;
    select.value = 'hr'; select.dispatchEvent(new dom.window.Event('change'));
    expect(dom.window.document.querySelector<HTMLButtonElement>('#fr-goto-builder')!.hidden).toBe(true);
    select.value = 'inventory'; select.dispatchEvent(new dom.window.Event('change'));
    expect(dom.window.document.querySelector<HTMLButtonElement>('#fr-goto-builder')!.hidden).toBe(false);
    dom.window.close();
  });

  it('offers a retry that retains the requested section and query when loading fails', async () => {
    const dom = await setup(['forms.manage.inventory'], []);
    const w = dom.window as any;
    w.API.get = async () => { throw new Error('Network down'); };
    await w.routes['form-records'](w.document.querySelector('main'), { scope: 'inventory', q: 'Stock' });
    expect(w.document.body.textContent).toContain('Could not load forms');
    w.document.querySelector('#fr-index-retry').click();
    expect(w.destination).toEqual({ route: 'form-records', filter: { scope: 'inventory', q: 'Stock' } });
    dom.window.close();
  });

  it('rejects a section URL the user cannot manage', async () => {
    const dom = await setup(['forms.manage.inventory'], [], { scope: 'hr' });
    expect(dom.window.document.body.textContent).toContain('You do not have access');
    expect(dom.window.document.querySelector('#fr-goto-builder')).toBeNull();
    dom.window.close();
  });
});
