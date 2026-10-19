import { afterEach, beforeEach, it, expect, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
let dom: JSDOM;
let w: any;
beforeEach(() => {
  vi.useFakeTimers();
  dom = new JSDOM('<html><head></head><body><input id="draft"></body></html>', { runScripts: 'outside-only', url: 'https://localhost/' });
  w = dom.window;
  w.Date = Date;
  w.eval(fs.readFileSync('public/js/lib/slow-loading.js', 'utf8'));
});
afterEach(() => { dom.window.close(); vi.useRealTimers(); });
const panel = () => w.document.querySelector('.app-slow-notice');
it('shows after ten seconds of startup and disappears when startup completes', () => {
  vi.advanceTimersByTime(9999); expect(panel()).toBeNull();
  vi.advanceTimersByTime(1); expect(panel().hidden).toBe(false);
  w.SlowLoading.ready(); expect(panel().hidden).toBe(true);
});
it('tracks concurrent reads and hides when the slow one finishes', () => {
  w.SlowLoading.ready();
  const slow = w.SlowLoading.request('GET', '/inventory');
  vi.advanceTimersByTime(10000); expect(panel().hidden).toBe(false);
  const fast = w.SlowLoading.request('GET', '/tenant');
  slow(); expect(panel().hidden).toBe(true);
  fast(); slow(); expect(panel().hidden).toBe(true);
});
it('keeps waiting quietly until the next loading episode', () => {
  w.SlowLoading.ready(); const done = w.SlowLoading.request('GET', '/orders');
  vi.advanceTimersByTime(10000); panel().querySelector('[data-wait]').click();
  vi.advanceTimersByTime(20000); expect(panel().hidden).toBe(true);
  done(); const next = w.SlowLoading.request('GET', '/inventory');
  vi.advanceTimersByTime(10000); expect(panel().hidden).toBe(false); next();
});
it('ignores background polls and writes do not trigger a slow-page notice', () => {
  w.SlowLoading.ready();
  w.SlowLoading.request('GET', '/messages/unread-count');
  w.SlowLoading.request('GET', '/notifications/unread-count');
  w.SlowLoading.request('GET', '/custom-poll', { background: true });
  const save = w.SlowLoading.request('POST', '/messages');
  vi.advanceTimersByTime(20000); expect(panel()).toBeNull(); save();
});
it('blocks reload while a save or upload is pending', () => {
  w.SlowLoading.ready(); const read = w.SlowLoading.request('GET', '/orders');
  const save = w.SlowLoading.request('POST', '/messages');
  vi.advanceTimersByTime(10000);
  expect(panel().querySelector('[data-retry]').disabled).toBe(true);
  expect(panel().textContent).toContain('save or upload');
  save(); expect(panel().querySelector('[data-retry]').disabled).toBe(false); read();
});
it('guards edited fields and does not refresh when the user cancels', () => {
  w.SlowLoading.ready(); const read = w.SlowLoading.request('GET', '/orders');
  const input = w.document.querySelector('input'); input.value = 'Draft';
  input.dispatchEvent(new w.Event('input', { bubbles: true }));
  w.confirm = vi.fn(() => false);
  vi.advanceTimersByTime(10000); panel().querySelector('[data-retry]').click();
  expect(w.confirm).toHaveBeenCalledWith(expect.stringContaining('Unsaved changes'));
  expect(input.value).toBe('Draft'); expect(panel().hidden).toBe(false); read();
});
it('discards stale page watches on navigation without clearing an active write', () => {
  w.SlowLoading.ready(); const old = w.SlowLoading.request('GET', '/old-page');
  const save = w.SlowLoading.request('POST', '/messages');
  vi.advanceTimersByTime(5000); w.SlowLoading.navigation();
  const current = w.SlowLoading.request('GET', '/current-page');
  vi.advanceTimersByTime(5000); expect(panel()).toBeNull(); old();
  vi.advanceTimersByTime(5000); expect(panel().querySelector('[data-retry]').disabled).toBe(true);
  save(); current(); expect(panel().hidden).toBe(true);
});
it('cleans up a failed API read without leaving a stale warning', async () => {
  w.SlowLoading.ready();
  let rejectRead: (error: Error) => void = () => {};
  w.fetch = vi.fn(() => new Promise((_resolve, reject) => { rejectRead = reject; }));
  w.eval(fs.readFileSync('public/js/api.js', 'utf8') + ';window.API=API;');
  const pending = w.API.get('/inventory');
  vi.advanceTimersByTime(10000); expect(panel().hidden).toBe(false);
  rejectRead(new Error('Connection lost'));
  await expect(pending).rejects.toThrow('Network unavailable');
  expect(panel().hidden).toBe(true);
});
