/** A partial desktop upload keeps confirmed units out of the retry path. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const root = path.join(import.meta.dirname, '..', 'public');
const windows: JSDOM[] = [];
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
afterEach(() => { windows.splice(0).forEach((dom) => dom.window.close()); });

describe('desktop production recording', () => {
  it('retries only the interrupted unit with its original key after a partial upload', async () => {
    const dom = new JSDOM('<div id="view"></div><div id="modal-root"></div><div id="toasts"></div>',
      { runScripts: 'outside-only', url: 'http://localhost/' });
    windows.push(dom);
    const win = dom.window;
    const doc = win.document;
    const jo = {
      id: 1, number: 'MO-001', status: 'released', product_name: 'Pump', qty_ordered: 3,
      qty_done: 0, qty_scrapped: 0, remaining: 3, qc_stages: 1, accepted_at: '2026-10-14',
      units_summary: { pending: 0, passed: 0, in_stock: 0, rework: 0, hold: 0 }, components: [],
    };
    let attempts = 0;
    const api = {
      get: vi.fn(async (url: string): Promise<unknown> => {
        if (url.startsWith('/job-orders?')) return [jo];
        if (url === '/job-orders/1') return jo;
        if (url === '/finished-products' || url === '/locations' || url === '/inventory'
          || url === '/job-orders/1/units' || url === '/job-orders/1/qc'
          || url.startsWith('/production/teams') || url.startsWith('/production/batches')
          || url.startsWith('/production/repairs') || url.startsWith('/production-issues')
          || url.endsWith('/events')) return [];
        throw new Error('Unexpected GET: ' + url);
      }),
      upload: vi.fn(async (_url: string, _body: FormData, _opts: { idempotencyKey: string }) => {
        attempts++;
        if (attempts === 2) { const err = new Error('Network unavailable'); throw err; }
        return { id: attempts, job_order: jo };
      }),
    };
    let route!: (view: Element, filter: Record<string, unknown>) => Promise<void>;
    Object.assign(win, { API: api, App: {
      hasPermission: (permission: string) => permission === 'production.record',
      register: (_: string, fn: typeof route) => { route = fn; },
    }, ProductionSteps: { jobOrderStep: () => ({ cls: 'open', label: 'Recording' }) } });
    win.eval(fs.readFileSync(path.join(root, 'js/ui.js'), 'utf8') + '\n'
      + fs.readFileSync(path.join(root, 'js/modules/manufacturing/job-orders.js'), 'utf8'));
    await route(doc.querySelector('#view')!, {});
    (doc.querySelector('tr[data-open="1"]') as HTMLElement).click();
    await tick();
    const count = doc.querySelector('#jo-unit-count') as HTMLInputElement;
    count.value = '2'; count.dispatchEvent(new win.Event('input'));
    const rows = [...doc.querySelectorAll('[data-unit-row]')];
    rows.forEach((row, index) => {
      (row.querySelector('.jo-unit-ident') as HTMLInputElement).value = `SERIAL-${index + 1}`;
      Object.defineProperty(row.querySelector('.jo-unit-photo'), 'files', {
        configurable: true, value: [new win.File(['photo'], `unit-${index + 1}.png`, { type: 'image/png' })],
      });
    });
    (doc.querySelector('#jo-units-submit') as HTMLElement).click();
    await tick(); await tick();
    expect(api.upload).toHaveBeenCalledTimes(2);
    expect(rows[0]!.getAttribute('data-saved')).toBe('true');
    expect(doc.querySelector('#jo-unit-progress')?.textContent).toContain('1 of 2 confirmed');
    const retryKey = api.upload.mock.calls[1]![2].idempotencyKey;
    (doc.querySelector('#jo-units-submit') as HTMLElement).click();
    await tick(); await tick();
    expect(api.upload).toHaveBeenCalledTimes(3);
    expect(api.upload.mock.calls[2]![2].idempotencyKey).toBe(retryKey);
  });
});
