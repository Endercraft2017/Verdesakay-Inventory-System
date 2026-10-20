/** Exercise Help using the real classic-script globals and real modal/drawer code.
 * A top-level const App does not automatically become window.App. Mocking App as a
 * window property in content-only tests concealed that browser integration failure. */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

function setup() {
  const root = path.join(import.meta.dirname, '..', 'public');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const sources = [...html.matchAll(/<script src="(\/js\/[^"]+)"><\/script>/g)].map(m => m[1]!);
  const dom = new JSDOM(html, { url: 'http://localhost', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as any;
  w.eval(sources.map(s => fs.readFileSync(path.join(root, s.slice(1)), 'utf8')).join('\n;\n') + ';window.__realUI = UI;window.__realAPI = API;');
  return { dom, w };
}

describe('Help with real script globals and UI', () => {
  it.each([
    ['inventory', undefined, 'Inventory — items & stock'],
    ['purchase-requests', undefined, 'Internal Purchase Requests'],
    ['templates', undefined, 'Document Templates'],
    ['orders', { type: 'sale' }, 'Sale Orders'],
    ['orders', { type: 'purchase' }, 'Purchase Orders'],
    ['orders', { type: 'job' }, 'Job Order documents'],
    ['form-records', { slug: 'hr_payroll' }, 'Payroll records'],
  ])('opens the appropriate guide for %s %j', (route, filter, title) => {
    const { dom, w } = setup();
    w.App.currentLocation = () => ({ route, filter });
    w.Help.open();
    expect(w.document.querySelector('.help-content h4')?.textContent).toBe(title);
    dom.window.close();
  });

  it('switches an explicit topic in an existing Help drawer without toggling it shut', () => {
    const { dom, w } = setup();
    w.Help.open('templates');
    w.document.querySelector('.drawer')!.classList.add('open');
    w.Help.open('site-map');
    expect(w.document.querySelectorAll('.drawer')).toHaveLength(1);
    expect(w.document.querySelector('.help-content h4')?.textContent).toBe('Site Map');
    dom.window.close();
  });

  it('opening a modal guide uses its explicit topic and preserves unsaved inputs', () => {
    const { dom, w } = setup();
    w.App.currentLocation = () => ({ route: 'templates' });
    w.submitted = false;
    w.__realUI.modal({ title: 'New item', helpTopic: 'new-item',
      bodyHTML: '<input id="draft-name" value="Unsaved item" />', confirmText: 'Create item',
      onConfirm: () => { w.submitted = true; } });
    w.document.querySelector<HTMLButtonElement>('[data-modal-help]')!.click();
    expect(w.document.querySelector('.help-content h4')?.textContent).toBe('New / Edit item');
    expect(w.document.querySelector<HTMLInputElement>('#draft-name')!.value).toBe('Unsaved item');
    expect(w.submitted).toBe(false);
    dom.window.close();
  });

  it('knows the selected form when a shared route uses form_id rather than slug', () => {
    const { dom, w } = setup();
    w.Help.rememberForm({ id: 42, slug: 'hr_payroll', scope: 'hr' });
    w.Help.rememberForm({ id: 43, slug: 'leave_request', scope: 'hr' });
    expect(w.Help.forLocation('form-records', { form_id: '42' }).id).toBe('payroll-records');
    expect(w.Help.forLocation('form-records', { form_id: '43' }).id).toBe('hr-forms');
    expect(w.Help.forLocation('form-records', { form_id: '999' }).id).toBe('data-forms');
    dom.window.close();
  });
});

describe('guide feedback', () => {
  it('requires actionable negative feedback and captures the topic and original screen', async () => {
    const { dom, w } = setup();
    const sent: any[] = [];
    w.__realAPI.upload = async (url: string, body: FormData) => w.__send(url, body);
    w.__send = (url: string, body: FormData) => sent.push({ url, fields: Object.fromEntries(body.entries()) });
    w.App.currentLocation = () => ({ route: 'inventory', label: 'Low Stock' });
    w.Help.open('low-stock');
    w.document.querySelector<HTMLButtonElement>('[data-guide-feedback="no"]')!.click();
    const modal = w.document.querySelector('.modal-overlay')!;
    modal.querySelector<HTMLButtonElement>('[data-confirm]')!.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(sent).toHaveLength(0);
    expect(modal.querySelector('[data-modal-error]')?.textContent).toContain('describe what needs improvement');
    modal.querySelector<HTMLTextAreaElement>('textarea')!.value = 'Explain the target multiplier.';
    w.App.currentLocation = () => ({ route: 'templates', label: 'Templates' });
    modal.querySelector<HTMLButtonElement>('[data-confirm]')!.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(sent[0]).toEqual({ url: '/bug-reports', fields: {
      title: 'Guide feedback: Low Stock',
      steps_to_reproduce: 'Read guide: Low Stock (low-stock).\nRating: Needs improvement.',
      description: 'Explain the target multiplier.',
      page_context: 'Low Stock | Guide: low-stock',
    } });
    expect(w.document.querySelector('.modal-overlay')).toBeNull();
    dom.window.close();
  });

  it('keeps feedback and an underlying unsaved form after a failed submission', async () => {
    const { dom, w } = setup();
    w.__realAPI.upload = async () => { throw new Error("Network unavailable"); };
    w.__realUI.modal({ title: 'Draft', bodyHTML: '<input id="unsaved" value="Keep me" />' });
    w.Help.open('new-item');
    w.document.querySelector<HTMLButtonElement>('[data-guide-feedback="yes"]')!.click();
    const modal = [...w.document.querySelectorAll('.modal-overlay')].at(-1)!;
    modal.querySelector<HTMLButtonElement>('[data-confirm]')!.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(modal.querySelector('[data-modal-error]')?.textContent).toBe('Network unavailable');
    expect(modal.querySelector<HTMLButtonElement>('[data-confirm]')!.disabled).toBe(false);
    expect(w.document.querySelector<HTMLInputElement>('#unsaved')!.value).toBe('Keep me');
    dom.window.close();
  });
});
