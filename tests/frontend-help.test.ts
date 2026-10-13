import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const source = (file: string) => fs.readFileSync(path.join(import.meta.dirname, '..', 'public/js', file), 'utf8');
function setup(route = 'templates', filter?: Record<string, string>) {
  const dom = new JSDOM('<body><div id="drawer"></div></body>', { runScripts: 'outside-only', url: 'http://localhost' });
  const win = dom.window;
  win.eval(source('guide-data.js'));
  win.eval(`window.App = { currentLocation: () => (${JSON.stringify({ route, filter })}), navigate: (route, filter) => window.destination = { route, filter } };
    window.UI = { esc: s => String(s), icon: () => '', drawer: () => {
      const el = document.querySelector('#drawer');
      el.innerHTML = '<div class="drawer-body"></div>';
      return { el, close() {} };
    } }; window.GuideTour = { start: id => window.started = id };`);
  win.eval(source('help.js'));
  return dom;
}

describe('screen help assignment', () => {
  it('covers every registered route exactly once with a valid topic', () => {
    const dom = setup();
    dom.window.eval(source('nav-config.js') + ';window.routes = ROUTE_NAMES;');
    const topics = dom.window.Help.topics as { id: string; routes: string[]; html: string }[];
    expect(new Set(topics.map(t => t.id)).size).toBe(topics.length);
    for (const route of dom.window.routes) {
      expect(topics.filter(t => t.routes.includes(route)), route).toHaveLength(1);
    }
    dom.window.close();
  });

  it('Site Map guide describes navigation even when Templates is open', () => {
    const dom = setup();
    dom.window.Help.open('site-map');
    expect(dom.window.document.querySelector('.help-content')?.textContent).toContain('Click a screen name');
    expect(dom.window.document.body.textContent).not.toContain('Templates control');
    expect(dom.window.document.querySelector('#help-walk')).toBeNull();
    dom.window.close();
  });

  it('switching topics selects the chosen workflow rather than the background route', () => {
    const dom = setup('job-orders');
    dom.window.Help.open('timekeeping');
    dom.window.document.querySelector<HTMLButtonElement>('#help-walk')?.click();
    expect(dom.window.started).toBe('payroll');
    const picker = dom.window.document.querySelector<HTMLSelectElement>('#help-pick')!;
    picker.value = 'templates';
    picker.dispatchEvent(new dom.window.Event('change'));
    expect(dom.window.document.querySelector('#help-walk')).toBeNull();
    dom.window.close();
  });

  it('shared Data Forms route selects Payroll, HR notices or general forms from its filter', () => {
    const dom = setup('form-records', { slug: 'hr_payroll' });
    dom.window.Help.open();
    expect(dom.window.document.querySelector('.help-content h4')?.textContent).toBe('Payroll records');
    dom.window.document.querySelector<HTMLButtonElement>('#help-open-guide')?.click();
    expect(dom.window.destination).toEqual({ route: 'sop', filter: { helpTopic: 'payroll-records' } });
    expect(dom.window.Help.forLocation('form-records', { scope: 'hr' }).id).toBe('hr-forms');
    expect(dom.window.Help.forLocation('form-records', {}).id).toBe('data-forms');
    dom.window.close();
  });

  it('an unknown topic falls back to navigation help rather than unrelated content', () => {
    const dom = setup();
    dom.window.Help.open('missing-topic');
    expect(dom.window.document.querySelector('.help-content h4')?.textContent).toBe('Getting around');
    dom.window.close();
  });

  it('purchase orders launch purchasing and document job orders do not launch sales', () => {
    const dom = setup('orders', { type: 'purchase' });
    dom.window.Help.open();
    dom.window.document.querySelector<HTMLButtonElement>('#help-walk')?.click();
    expect(dom.window.started).toBe('purchasing');
    dom.window.App.currentLocation = () => ({ route: 'orders', filter: { type: 'job' } });
    dom.window.Help.open();
    expect(dom.window.document.querySelector('#help-walk')).toBeNull();
    dom.window.close();
  });
});

describe('guide reference integrity', () => {
  it('all explicit modal help topics and workflow references resolve', () => {
    const dom = setup();
    const ids = new Set(dom.window.Help.topics.map((t: any) => t.id));
    const root = path.join(import.meta.dirname, '..', 'public/js');
    for (const file of fs.readdirSync(root, { recursive: true }) as string[]) {
      if (!file.endsWith('.js')) continue;
      const text = fs.readFileSync(path.join(root, file), 'utf8');
      for (const match of text.matchAll(/(?:helpTopic\s*:\s*|Help\.open\(\s*)['"]([^'"]+)['"]/g)) {
        expect(ids.has(match[1]), `${file}: unknown help topic ${match[1]}`).toBe(true);
      }
    }
    for (const topic of dom.window.Help.topics) {
      if (topic.workflow) expect(dom.window.GUIDE.byId[topic.workflow], topic.id).toBeTruthy();
    }
    dom.window.close();
  });
});
