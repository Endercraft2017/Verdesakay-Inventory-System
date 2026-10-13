import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const source = (file: string) => fs.readFileSync(path.join(import.meta.dirname, '..', 'public/js', file), 'utf8');
function setup() {
  const dom = new JSDOM('<body><main id="view"></main><button class="tree-leaf" data-route="production-overview"></button><button class="tree-leaf" data-route="finished-products"></button></body>', { runScripts: 'outside-only', url: 'http://localhost' });
  const w = dom.window;
  const frames: FrameRequestCallback[] = [];
  w.requestAnimationFrame = fn => { frames.push(fn); return frames.length; };
  w.eval(`window.navigations = []; window.toasts = []; window.views = {};
    window.App = { register: (name, fn) => window.views[name] = fn,
      navigate: (route, filter) => window.navigations.push({ route, filter }),
      currentLocation: () => ({ route: 'templates' }) };
    window.UI = { esc: s => s == null ? '' : String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
      icon: () => '', toast: (...args) => window.toasts.push(args) };`);
  w.eval(source('guide-data.js'));
  w.eval(source('help.js'));
  w.eval(source('guide-tour.js'));
  w.eval(source('modules/manufacturing/sop.js'));
  const flushFrames = () => {
    while (frames.length) frames.splice(0).forEach(fn => fn(0));
  };
  return { dom, w, flushFrames };
}

const click = (w: JSDOM['window'], selector: string) => {
  const button = w.document.querySelector<HTMLButtonElement>(selector);
  expect(button, selector).not.toBeNull();
  button!.click();
};

describe('Guide Center', () => {
  it('lists and opens every workflow and screen/tool guide using its own content', () => {
    const { dom, w } = setup();
    w.views.sop(w.document.querySelector('#view'), {});
    for (const topic of w.Help.topics) {
      click(w, `[data-id="help:${topic.id}"]`);
      expect(w.document.querySelector('.guide-main h3')?.textContent).toBe(topic.title);
      const expected = w.document.createElement('div');
      expected.innerHTML = topic.html;
      expect(w.document.querySelector('.help-content')?.innerHTML).toBe(expected.innerHTML);
      expect(w.document.querySelector('#guide-tour-start')).toBeNull();
    }
    for (const pipeline of w.GUIDE.pipelines) {
      click(w, `[data-id="${pipeline.id}"]`);
      expect(w.document.querySelector('.guide-main h3')?.textContent).toBe(pipeline.title);
      expect(w.document.querySelectorAll('.guide-step')).toHaveLength(pipeline.steps.length);
    }
    dom.window.close();
  });

  it('deep-links to Site Map, searches guides, and keeps selected content intact', () => {
    const { dom, w } = setup();
    w.views.sop(w.document.querySelector('#view'), { helpTopic: 'site-map' });
    expect(w.document.querySelector('.guide-main h3')?.textContent).toBe('Site Map');
    const input = w.document.querySelector<HTMLInputElement>('#guide-search')!;
    input.value = 'templates';
    input.dispatchEvent(new w.Event('input'));
    expect(w.document.querySelector<HTMLButtonElement>('[data-id="help:templates"]')?.hidden).toBe(false);
    expect(w.document.querySelector<HTMLButtonElement>('[data-id="production"]')?.hidden).toBe(true);
    expect(w.document.querySelector('.guide-main h3')?.textContent).toBe('Site Map');
    dom.window.close();
  });
});

describe('walkthrough behavior', () => {
  it('renders every step, follows its route and filter, and provides readable phone destinations', () => {
    const { dom, w, flushFrames } = setup();
    for (const pipeline of w.GUIDE.pipelines) {
      pipeline.steps.forEach((step: any, i: number) => {
        w.navigations.length = 0;
        w.GuideTour.start(pipeline.id, i);
        flushFrames();
        expect(w.document.querySelector('.guide-coach h4')?.textContent).toBe(step.title);
        expect(w.document.querySelector('.guide-coach-count')?.textContent).toBe(`Step ${i + 1} of ${pipeline.steps.length}`);
        expect(w.document.querySelector<HTMLButtonElement>('[data-act="back"]')?.disabled).toBe(i === 0);
        expect(w.document.querySelector('[data-act="next"]')?.textContent?.trim()).toBe(i === pipeline.steps.length - 1 ? 'Finish' : 'Next');
        if (step.to?.route) expect(w.navigations).toEqual([{ route: step.to.route, filter: step.to.filter }]);
        else expect(w.navigations).toEqual([]);
        if (step.to?.external) expect(w.document.querySelector('.guide-coach-ext')?.textContent).toContain(step.to.external);
        w.GuideTour.close();
      });
    }
    dom.window.close();
  });

  it('closing the last step preserves resume progress; Finish alone completes it', () => {
    const { dom, w } = setup();
    const p = w.GUIDE.byId.sales;
    w.GuideTour.start(p.id, p.steps.length - 1);
    click(w, '[data-act="close"]');
    expect(w.toasts).toHaveLength(0);
    expect(w.GuideTour.savedStep(p.id)).toBe(p.steps.length - 1);
    w.GuideTour.resume(p.id);
    click(w, '[data-act="next"]');
    expect(w.toasts).toEqual([['Walkthrough complete — Sales orders', 'success']]);
    expect(w.localStorage.getItem('vds_guide_step_sales')).toBeNull();
    dom.window.close();
  });

  it('ignores arrows inside fields and Escape preserves progress', () => {
    const { dom, w } = setup();
    w.GuideTour.start('inventory', 2);
    const input = w.document.createElement('input');
    w.document.body.appendChild(input);
    input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(w.GuideTour.savedStep('inventory')).toBe(2);
    w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(w.GuideTour.savedStep('inventory')).toBe(2);
    expect(w.toasts).toHaveLength(0);
    dom.window.close();
  });

  it('does not leave a stale spotlight when steps change before animation frames run', () => {
    const { dom, w, flushFrames } = setup();
    w.GuideTour.start('production', 0);
    click(w, '[data-act="next"]');
    flushFrames();
    expect(w.document.querySelectorAll('.guide-spot')).toHaveLength(1);
    expect(w.document.querySelector('.guide-spot')?.getAttribute('data-route')).toBe('finished-products');
    w.GuideTour.close();
    flushFrames();
    expect(w.document.querySelectorAll('.guide-spot')).toHaveLength(0);
    dom.window.close();
  });

  it('highlights Purchase Orders rather than the first leaf sharing the orders route', () => {
    const { dom, w, flushFrames } = setup();
    w.document.body.insertAdjacentHTML('beforeend', '<button class="tree-leaf" data-route="orders">Sale Orders</button><button class="tree-leaf active" data-route="orders">Purchase Orders</button>');
    w.GuideTour.start('purchasing', 0);
    flushFrames();
    expect(w.document.querySelector('.guide-spot')?.textContent).toBe('Purchase Orders');
    w.GuideTour.close();
    dom.window.close();
  });

  it('preserves the selected record for adjacent steps on the same route', () => {
    const { dom, w } = setup();
    w.App.currentLocation = () => ({ route: 'orders', filter: { type: 'sale', id: '42' } });
    w.document.body.insertAdjacentHTML('beforeend', '<div class="modal-overlay"><input id="unsaved" value="Draft text"></div>');
    w.GuideTour.start('sales', 1);
    expect(w.navigations).toEqual([]);
    expect(w.document.querySelector<HTMLInputElement>('#unsaved')?.value).toBe('Draft text');
    w.GuideTour.close();
    dom.window.close();
  });

  it('waits for the current dialog to close before automatically switching screens', async () => {
    const { dom, w } = setup();
    w.App.currentLocation = () => ({ route: 'templates' });
    w.document.body.insertAdjacentHTML('beforeend', '<div class="modal-overlay"><input id="unsaved" value="Draft text"></div>');
    w.GuideTour.start('production', 0);
    expect(w.navigations).toEqual([]);
    expect(w.document.querySelector('[data-screen-note]')?.textContent).toContain('Finish or close');
    expect(w.document.querySelector<HTMLInputElement>('#unsaved')?.value).toBe('Draft text');
    w.document.querySelector('.modal-overlay')!.remove();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(w.navigations).toEqual([{ route: 'production-overview', filter: undefined }]);
    w.GuideTour.close();
    dom.window.close();
  });

  it('normalizes invalid and fractional starting steps and reports navigation failures', () => {
    const { dom, w } = setup();
    w.GuideTour.start('production', 1.5);
    expect(w.GuideTour.savedStep('production')).toBe(1);
    w.GuideTour.start('production', Infinity);
    expect(w.GuideTour.savedStep('production')).toBe(0);
    w.App.navigate = () => { throw new Error('Screen unavailable'); };
    w.GuideTour.start('production', 0);
    expect(w.toasts).toEqual([['Screen unavailable', 'error']]);
    w.GuideTour.close();
    dom.window.close();
  });
});

describe('template company-profile permission', () => {
  it.each([
    { edit: false, company: true, save: true },
    { edit: true, company: false, save: false },
  ])('allows company changes from templates.company independently of templates.edit: $company', async ({ edit, company, save }) => {
    const { dom, w } = setup();
    w.App.hasPermission = (permission: string) => permission === 'templates.edit' ? edit : permission === 'templates.company' && company;
    w.API = { get: async (route: string) => route === '/templates/company' ? { name: 'Example' } : [] };
    w.UI.emptyState = () => '';
    w.UI.modal = (options: any) => { w.companyOptions = options; };
    w.eval(source('modules/core/templates.js'));
    await w.views.templates(w.document.querySelector('#view'));
    click(w, '#tpl-company');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(w.companyOptions.confirmText).toBe(save ? 'Save' : null);
    dom.window.close();
  });
});
