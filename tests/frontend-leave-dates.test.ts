import { it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
const source = fs.readFileSync(new URL('../public/js/leave-dates.js', import.meta.url), 'utf8');
it('adds inclusive ranges and separate cross-month dates without including gaps, and removes dates', async () => {
  const dom = new JSDOM('<main></main>', { runScripts: 'outside-only' }), w = dom.window as any;
  w.eval(source); const host = w.document.querySelector('main'); host.innerHTML = w.LeaveDates.markup();
  const previews: any[] = [];
  const picker = w.LeaveDates.mount(host, { preview: async (data: any) => { previews.push(data); return { days: 4, remaining: 8, warnings: ['Weekend dates do not consume leave'] }; } });
  host.querySelector('[data-leave-from]').value = '2026-09-03'; host.querySelector('[data-leave-to]').value = '2026-09-06'; host.querySelector('[data-leave-range]').click();
  for (const date of ['2026-09-08','2026-10-03','2026-10-05']) { host.querySelector('[data-leave-single]').value = date; host.querySelector('[data-leave-add]').click(); }
  await picker.ready();
  expect(picker.value().leave_dates).toBe('2026-09-03,2026-09-04,2026-09-05,2026-09-06,2026-09-08,2026-10-03,2026-10-05');
  expect(host.textContent).toContain('Weekend dates do not consume leave');
  host.querySelector('[data-leave-remove="2026-09-05"]').click();
  expect(picker.value().leave_dates).not.toContain('2026-09-05');
  host.querySelector('[data-leave-from]').value = '2026-10-06'; host.querySelector('[data-leave-to]').value = '2026-10-01'; host.querySelector('[data-leave-range]').click();
  expect(host.querySelector('[data-leave-error]').textContent).toContain('in order');
  expect(previews.length).toBeGreaterThan(0); dom.window.close();
});
it('restores a reviewed draft and rejects ranges longer than 366 days', () => {
  const dom = new JSDOM('<main></main>', { runScripts: 'outside-only' }), w = dom.window as any;
  w.eval(source); const host = w.document.querySelector('main'); host.innerHTML = w.LeaveDates.markup();
  const picker = w.LeaveDates.mount(host, { data: { leave_dates: '2026-09-04,2026-10-05' } });
  expect(picker.value().leave_dates).toBe('2026-09-04,2026-10-05');
  host.querySelector('[data-leave-from]').value = '2025-01-01'; host.querySelector('[data-leave-to]').value = '2027-01-01'; host.querySelector('[data-leave-range]').click();
  expect(host.querySelector('[data-leave-error]').textContent).toContain('366');
  expect(picker.value().leave_dates).toBe('2026-09-04,2026-10-05'); dom.window.close();
});
