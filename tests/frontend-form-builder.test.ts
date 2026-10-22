import { describe, it, expect, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
async function setup(scope = 'hr') {
  const dom = new JSDOM('<main></main><div id="modal-root"></div><div id="toasts"></div>', { runScripts: 'outside-only', url: 'http://localhost' });
  const w = dom.window;
  w.eval(`window.calls=[];window.routes={};window.App={hasPermission:()=>true,register:(name,handler)=>routes[name]=handler,navigate:()=>{}};window.API={get:async()=>[],post:async(url,body)=>{calls.push({url,body});return {id:77}},put:async(url,body)=>{calls.push({url,body});return {id:88}}};`);
  const files = ['ui.js', 'lib/data-forms.js', 'lib/form-print.js', 'lib/form-connections.js', 'lib/form-math.js', 'lib/form-items.js', 'lib/form-validation.js', 'modules/core/form-builder.js'];
  w.eval(files.map(file => fs.readFileSync(path.join(import.meta.dirname, '../public/js', file), 'utf8')).join('\n') + '\nwindow.testUI=UI;');
  await (w as any).routes['form-builder'](w.document.querySelector('main'), { scope });
  await vi.waitFor(() => expect(w.document.querySelector('#fb-new-form')).not.toBeNull());
  return dom;
}
describe('tabbed form setup', () => {
  it('preserves fields across tabs, previews changes, orders fields, and creates a starter print template', async () => {
    const dom = await setup(); const w = dom.window; const doc = w.document;
    const click = (selector: string) => doc.querySelector<HTMLElement>(selector)!.click();
    const fill = (selector: string, value: string) => { const input = doc.querySelector<HTMLInputElement>(selector)!; input.value = value; input.dispatchEvent(new w.Event('input', { bubbles: true })); };
    click('#fb-new-form'); fill('[data-f=name]', 'Equipment request'); click('[data-setup-tab=fields]'); click('#fb-add-field');
    fill('[data-fi="0"] [data-k=key]', 'reason'); fill('[data-fi="0"] [data-k=label]', 'Reason');
    click('#fb-add-field'); fill('[data-fi="1"] [data-k=key]', 'item'); fill('[data-fi="1"] [data-k=label]', 'Item');
    expect(doc.querySelector('#fb-live-preview')!.textContent).toContain('Reason');
    click('[data-move-field="1"][data-direction="-1"]');
    expect(doc.querySelector<HTMLInputElement>('[data-fi="0"] [data-k=key]')!.value).toBe('item');
    click('[data-setup-tab=printing]'); click('[data-f=create_template]'); click('.modal [data-confirm]');
    await vi.waitFor(() => expect((w as any).calls).toHaveLength(2));
    expect((w as any).calls[0].body.fields.map((field: any) => field.key)).toEqual(['item', 'reason']);
    expect((w as any).calls[1].url).toBe('/form-definitions/77/template-body');
    await vi.waitFor(() => expect(doc.querySelector('.modal-overlay')).toBeNull());
    dom.window.close();
  });

  it('lists all missing field details and opens the correct tab from an error link', async () => {
    const dom = await setup(); const w = dom.window; const doc = w.document;
    doc.querySelector<HTMLElement>('#fb-new-form')!.click();
    const name = doc.querySelector<HTMLInputElement>('[data-f=name]')!;
    name.value = 'Preserved draft'; name.dispatchEvent(new w.Event('input', { bubbles: true }));
    doc.querySelector<HTMLElement>('[data-setup-tab=fields]')!.click();
    doc.querySelector<HTMLElement>('#fb-add-field')!.click();
    for (const key of ['key', 'label']) { const input = doc.querySelector<HTMLInputElement>(`[data-k=${key}]`)!; input.value = ''; input.dispatchEvent(new w.Event('input', { bubbles: true })); }
    doc.querySelector<HTMLElement>('[data-setup-tab=printing]')!.click();
    doc.querySelector<HTMLElement>('.modal [data-confirm]')!.click();
    await vi.waitFor(() => expect(doc.querySelectorAll('[data-validation-error]')).toHaveLength(2));
    expect((w as any).calls).toHaveLength(0);
    doc.querySelector<HTMLElement>('[data-modal-error] button')!.click();
    expect(doc.querySelector('[data-setup-tab=fields]')!.getAttribute('aria-selected')).toBe('true');
    expect(doc.activeElement).toBe(doc.querySelector('[data-k=key]'));
    expect(name.value).toBe('Preserved draft');
    w.confirm = () => true; doc.querySelector<HTMLElement>('.modal [data-close]')!.click(); dom.window.close();
  });


  it('shows a save failure after client validation passes and keeps the draft open', async () => {
    const dom = await setup(); const w = dom.window; const doc = w.document;
    (w as any).API.post = async () => { throw new Error('Network down'); };
    doc.querySelector<HTMLElement>('#fb-new-form')!.click();
    const name = doc.querySelector<HTMLInputElement>('[data-f=name]')!;
    name.value = 'Retry this draft'; name.dispatchEvent(new w.Event('input', { bubbles: true }));
    doc.querySelector<HTMLElement>('.modal [data-confirm]')!.click();
    await vi.waitFor(() => expect(doc.querySelector('[data-modal-error]')!.textContent).toBe('Network down'));
    const error = doc.querySelector<HTMLElement>('[data-modal-error]')!;
    expect(error.hidden).toBe(false); expect(error.classList.contains('hidden')).toBe(false);
    expect(name.value).toBe('Retry this draft');
    w.confirm = () => true; doc.querySelector<HTMLElement>('.modal [data-close]')!.click(); dom.window.close();
  });

  it('limits HR starters to HR and keeps General forms manageable by authorized users', async () => {
    const inventory = await setup('inventory');
    expect(inventory.window.document.querySelector('#fb-quick-add')).toBeNull(); inventory.window.close();
    const general = await setup('general'); const w = general.window;
    w.document.querySelector<HTMLElement>('#fb-new-form')!.click();
    const name = w.document.querySelector<HTMLInputElement>('[data-f=name]')!;
    name.value = 'General request'; name.dispatchEvent(new w.Event('input', { bubbles: true }));
    w.document.querySelector<HTMLElement>('.modal [data-confirm]')!.click();
    await vi.waitFor(() => expect((w as any).calls.length).toBe(1));
    expect((w as any).calls[0].body.scope).toBeNull();
    await vi.waitFor(() => expect(w.document.querySelector('.modal-overlay')).toBeNull());
    general.window.close();
  });
});
