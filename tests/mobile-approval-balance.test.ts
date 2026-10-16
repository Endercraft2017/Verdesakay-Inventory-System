import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

afterEach(() => vi.useRealTimers());

it('keeps an over-balance leave in focus and retries only after the mobile approver confirms', async () => {
  vi.useFakeTimers();
  const dom = new JSDOM('<div id="view"></div>', { runScripts: 'outside-only', url: 'https://localhost/m#/approvals' });
  const w = dom.window as any;
  const routes: Record<string, (view: HTMLElement) => void> = {};
  const posts: Array<Record<string, unknown>> = [];
  let confirm = false;
  w.confirm = () => confirm;
  w.mEsc = (value: unknown) => String(value ?? '');
  w.mEl = (html: string) => { const node = w.document.createElement('template'); node.innerHTML = html.trim(); return node.content.firstElementChild; };
  w.mToast = () => {};
  w.MApp = { route: (name: string, draw: (view: HTMLElement) => void) => { routes[name] = draw; }, setTitle: () => {}, refreshInboxBadge: () => {} };
  w.API = {
    get: async () => ({ requests: [
      { id: 2, form_name: 'Offset Form', number: 'OFS-2', employee_name: 'Ana', created_at: '2026-10-13', data: { reason: 'Shift change' } },
      { id: 1, form_name: 'Leave Request', number: 'LV-1', employee_name: 'Ana', created_at: '2026-10-13', data: { reason: 'Family trip' } },
    ], time_corrections: [] }),
    post: async (_path: string, body: Record<string, unknown>) => {
      posts.push(body);
      if (!body.override_balance) throw new Error('Requested 1 day(s), only 0 remaining. Approve anyway to override.');
      return { status: 'approved' };
    },
  };
  w.eval(fs.readFileSync(path.join(import.meta.dirname, '../public/mobile/modules/hr/approvals.js'), 'utf8'));
  const view = w.document.getElementById('view') as HTMLElement;
  routes.approvals!(view);
  await vi.waitFor(() => expect(view.querySelector('.m-appr-card')).not.toBeNull());
  (view.querySelector('[data-next]') as HTMLButtonElement).click();
  expect(view.querySelector('.m-appr-type')?.textContent).toBe('Leave Request');

  (view.querySelector('.ok') as HTMLButtonElement).click();
  await vi.advanceTimersByTimeAsync(4200);
  expect(posts).toHaveLength(1);
  expect(view.querySelector('.m-appr-type')?.textContent).toBe('Leave Request');

  confirm = true;
  (view.querySelector('.ok') as HTMLButtonElement).click();
  await vi.advanceTimersByTimeAsync(4200);
  expect(posts).toHaveLength(3);
  expect(posts[2]).toMatchObject({ decision: 'approved', override_balance: true });
  expect(view.textContent).not.toContain('Leave Request');
  dom.window.close();
});
