/** Desktop warehouse pick: a counted partial kit stays partial, then can be completed. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const root = path.join(import.meta.dirname, '..', 'public');
const windows: JSDOM[] = [];
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
afterEach(() => { windows.splice(0).forEach((dom) => dom.window.close()); });

describe('job-order kit picking on desktop', () => {
  it('saves a partial count, then lets the warehouse complete and review the kit', async () => {
    const dom = new JSDOM('<div id="view"></div><div id="modal-root"></div><div id="toasts"></div>',
      { runScripts: 'outside-only', url: 'http://localhost/' });
    windows.push(dom);
    const win = dom.window;
    const doc = win.document;
    const jo = {
      id: 1, number: 'MO-001', status: 'draft', product_name: 'Pump', qty_ordered: 2,
      qty_done: 0, qty_scrapped: 0, remaining: 2, qc_stages: 0,
      approved_at: '2026-10-13', warehouse_accepted_at: '2026-10-13', prepared_at: null as string | null,
      source_location_name: 'Main Warehouse', components: [{
        component_item_id: 5, component_name: 'Rotor', qty_per_unit: 2, qty_planned: 4,
        qty_picked: 0, qty_consumed: 0, component_on_hand: 10,
      }],
    };
    const api = {
      get: vi.fn(async (url: string): Promise<unknown> => {
        if (url.startsWith('/job-orders?')) return [jo];
        if (url === '/job-orders/1') return jo;
        if (url === '/job-orders/1/availability') return { source_location_name: 'Main Warehouse', lines: [{
          component_item_id: 5, component_name: 'Rotor', need: 4, have: 10,
          held_elsewhere: 3, available: 7, picked: jo.components[0]!.qty_picked,
        }] };
        if (url === '/finished-products' || url === '/locations' || url === '/inventory'
          || url.startsWith('/production/teams') || url.startsWith('/production/batches')
          || url.endsWith('/events')) return [];
        throw new Error('Unexpected GET: ' + url);
      }),
      post: vi.fn(async (url: string, body: { job_orders: Array<{ lines: Array<{ qty_picked: number }> }> }) => {
        if (url !== '/job-orders/prepare') throw new Error('Unexpected POST: ' + url);
        jo.components[0]!.qty_picked = body.job_orders[0]!.lines[0]!.qty_picked;
        if (jo.components[0]!.qty_picked === 4) jo.prepared_at = '2026-10-13';
        return { ok: true };
      }),
    };
    let route!: (view: Element, filter: Record<string, unknown>) => Promise<void>;
    Object.assign(win, { API: api, App: {
      hasPermission: (permission: string) => permission === 'production.kit_release',
      isAdmin: () => false,
      register: (_: string, fn: typeof route) => { route = fn; },
    }, ProductionSteps: { jobOrderStep: () => ({ cls: 'open', label: 'Preparing kit' }) } });
    win.eval(fs.readFileSync(path.join(root, 'js/ui.js'), 'utf8') + '\n'
      + fs.readFileSync(path.join(root, 'js/modules/manufacturing/job-orders.js'), 'utf8'));
    await route(doc.querySelector('#view')!, {});
    (doc.querySelector('tr[data-open="1"]') as HTMLElement).click();
    await tick();
    (doc.querySelector('[data-do="_prepare"]') as HTMLElement).click();
    await tick();
    const pick = doc.querySelector('[data-pick="5"]') as HTMLInputElement;
    expect(pick.value).toBe('0');
    expect(doc.querySelector('#modal-root')?.textContent).toContain('Free for this kit');
    pick.value = '2';
    (doc.querySelector('#modal-root .modal-overlay:last-child [data-confirm]') as HTMLElement).click();
    await tick(); await tick();
    expect(api.post).toHaveBeenCalledWith('/job-orders/prepare', {
      job_orders: [{ id: 1, lines: [{ component_item_id: 5, qty_picked: 2 }] }],
    });
    expect(jo.prepared_at).toBeNull();
    (doc.querySelector('[data-do="_prepare"]') as HTMLElement).click();
    await tick();
    (doc.querySelector('[data-pick="5"]') as HTMLInputElement).value = '4';
    (doc.querySelector('#modal-root .modal-overlay:last-child [data-confirm]') as HTMLElement).click();
    await tick(); await tick();
    expect(jo.prepared_at).toBeTruthy();
    expect(doc.querySelector('[data-do="_release"]')).not.toBeNull();
    expect(doc.querySelector('[data-do="_prepare"]')?.textContent).toContain('Review / adjust');
  });
});
