import { afterEach, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
const root = path.join(import.meta.dirname, '../public');
const doms: JSDOM[] = [];
afterEach(() => doms.splice(0).forEach(d => d.window.close()));
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0)); };
function deferred() { let resolve: any, reject: any; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function boot() {
  const dom = new JSDOM('<main id="view"></main><div id="m-overlay-root"></div><div id="m-toasts"></div>', { runScripts: 'outside-only', url: 'https://localhost/m/#/clock' }); doms.push(dom);
  const w = dom.window as any, view = w.document.querySelector('main'), routes: any = {}, calls: any[] = [];
  let account = 1, token = crypto.randomUUID();
  const status: any = { slots: { in: '08:02', lunchOut: '12:00', lunchIn: '13:00', out: null }, slot_date: '2026-10-22', work_date: '2026-10-22', next_slot: 'out', clocked_in: true, punches: [], can_clock_anywhere: false, location_required: false };
  const api: any = { get: async (p: string) => p === '/hr/clock/my-status' ? structuredClone(status) : [], post: async () => ({ hold_id: 10, expires_in_s: 300 }), upload: async () => ({ at: '17:02', work_date: '2026-10-22', hours_today: 8.5, photo_id: 5 }) };
  w.API = { getToken: () => token, isSharedSession: () => false, syncLocal: (r: any) => r?.__syncCommand || null, get: (p: string, o: any) => { calls.push(['get', p, o]); return api.get(p, o); }, post: (p: string, b: any, o: any) => { calls.push(['post', p, b, o]); return api.post(p, b, o); }, upload: (p: string, b: any, o: any) => { calls.push(['upload', p, b, o]); return api.upload(p, b, o); } };
  w.MApp = { route: (n: string, f: any) => routes[n] = f, getMe: () => ({ id: account }), setTitle() {}, go: (n: string) => { if (!w.mPersonalDraft.allow('#/' + n)) return; w.location.hash = '#/' + n; view.innerHTML = '<h1>Other screen</h1>'; } };
  for (const f of ['mobile/lib/dom.js', 'js/lib/photo-viewer.js', 'mobile/lib/personal.js', 'mobile/lib/scanner.js', 'mobile/lib/selfie.js', 'mobile/modules/hr/clock.js']) w.eval(fs.readFileSync(path.join(root, f), 'utf8'));
  const realSelfie = w.mSelfie.take;
  w.mSelfie.take = () => Promise.resolve(new w.Blob(['jpeg'], { type: 'image/jpeg' }));
  const render = () => routes.clock(view);
  const click = (q: string) => { const el = w.document.querySelector(q); expect(el, q).not.toBeNull(); el.click(); };
  const scan = async () => { click('[data-slot=out]'); const f = w.document.querySelector('.m-scan-manual'); f.querySelector('input').value = 'SAMPLE-CODE'; f.dispatchEvent(new w.Event('submit', { cancelable: true })); await tick(); };
  const count = (method: string) => calls.filter(c => c[0] === method).length;
  return { w, view, api, status, calls, render, click, scan, count, realSelfie, changeAccount: () => { account++; token = crypto.randomUUID(); } };
}
it('shares pending status loads, ignores stale routes, retains slots after refresh failure and retries once', async () => {
  const b = boot(), d = deferred(); b.api.get = () => d.promise; b.render(); b.render(); await tick(); expect(b.count('get')).toBe(1); d.resolve(b.status); await tick();
  const e = deferred(); b.api.get = () => e.promise; b.click('[data-refresh-status]'); b.click('[data-refresh-status]'); await tick(); expect(b.count('get')).toBe(2); e.reject(Error('Offline')); await tick(); expect(b.view.textContent).toContain('Last loaded slots'); expect(b.view.querySelectorAll('[data-slot]')).toHaveLength(4); expect(b.view.querySelector('[data-slot=out]').disabled).toBe(true);
  b.w.MApp.go('home'); b.api.get = async () => b.status; await tick(); expect(b.view.textContent).toBe('Other screen');
});
it('keeps one scanner, returns focus and restarts the dashboard clock when it is closed', async () => {
  const b = boot(); b.render(); await tick(); const button = b.view.querySelector('[data-slot=out]'); button.click(); button.dispatchEvent(new b.w.MouseEvent('click')); expect(b.w.document.querySelectorAll('.m-scan')).toHaveLength(1); b.click('.m-scan-x'); expect(b.w.document.activeElement.dataset.slot).toBe('out'); expect(b.count('post')).toBe(0); const old = b.view.querySelector('[data-live-time]').textContent; await new Promise(r => setTimeout(r, 1100)); expect(b.view.querySelector('[data-live-time]').textContent).not.toBe(old);
});
it('does not start a native camera after Close while format discovery is pending', async () => {
  const b = boot(), d = deferred(); let cameras = 0;
  Object.defineProperty(b.w.navigator, 'mediaDevices', { value: { getUserMedia: async () => { cameras++; return {}; } } }); b.w.BarcodeDetector = class { static getSupportedFormats() { return d.promise; } };
  const control = b.w.mScanner.open({ onResult() {} }); control.close(); d.resolve(['qr_code']); await tick(); expect(cameras).toBe(0);
});
it('stops a native stream granted after Close and does not start polling or play it', async () => {
  const b = boot(), d = deferred(); let stops = 0, plays = 0, detects = 0;
  Object.defineProperty(b.w.navigator, 'mediaDevices', { value: { getUserMedia: () => d.promise } }); b.w.HTMLMediaElement.prototype.play = async () => { plays++; };
  b.w.BarcodeDetector = class { static getSupportedFormats() { return Promise.resolve(['qr_code']); } detect() { detects++; return Promise.resolve([]); } };
  const control = b.w.mScanner.open({ onResult() {} }); await tick(); control.close(); d.resolve({ getTracks: () => [{ stop: () => stops++ }] }); await tick(); expect(stops).toBe(1); expect(plays).toBe(0); expect(detects).toBe(0);
});
it('cleans up a late ZXing stream and preserves continuous manual scans and the no-manual option', async () => {
  const b = boot(), d = deferred(); let resets = 0, stops = 0; Object.defineProperty(b.w.navigator, 'mediaDevices', { value: { getUserMedia() {} } });
  b.w.ZXing = { BrowserMultiFormatReader: class { decodeFromConstraints(_c: any, video: any) { return d.promise.then(() => { video.srcObject = { getTracks: () => [{ stop: () => stops++ }] }; }); } reset() { resets++; } } };
  const first = b.w.mScanner.open({ allowManual: false, onResult() {} }); expect(b.w.document.querySelector('.m-scan-manual')).toBeNull(); first.close(); d.resolve(); await tick(); expect(resets).toBeGreaterThan(0); expect(stops).toBe(1);
  delete b.w.ZXing; const codes: string[] = []; const next = b.w.mScanner.open({ continuous: true, onResult: (s: string) => codes.push(s) }); const f = b.w.document.querySelector('.m-scan-manual'); for (const code of ['one', 'two']) { f.querySelector('input').value = code; f.dispatchEvent(new b.w.Event('submit', { cancelable: true })); } expect(codes).toEqual(['one', 'two']); expect(b.w.document.querySelectorAll('.m-scan')).toHaveLength(1); next.close();
});
it('ignores late location callbacks after navigation and never records in another account', async () => {
  const b = boot(); let gps: any; b.status.location_required = true; Object.defineProperty(b.w.navigator, 'geolocation', { value: { getCurrentPosition: (ok: any) => gps = ok } }); b.render(); await tick(); await b.scan(); b.w.MApp.go('home'); await tick(); b.changeAccount(); gps({ coords: { latitude: 14.5, longitude: 121, accuracy: 4 } }); await tick(); expect(b.count('post')).toBe(0); expect(b.count('upload')).toBe(0); expect(b.view.textContent).toBe('Other screen');
});
it('retains location errors and retries without duplicating the scan, preserving code and GPS checks', async () => {
  const b = boot(); b.status.location_required = true; let fail = true; Object.defineProperty(b.w.navigator, 'geolocation', { value: { getCurrentPosition: (ok: any, err: any) => fail ? err({ code: 1 }) : ok({ coords: { latitude: 14.5, longitude: 121, accuracy: 4 } }) } }); b.render(); await tick(); await b.scan(); expect(b.view.textContent).toContain('Location is blocked'); expect(b.count('post')).toBe(0); fail = false; b.click('[data-retry-capture]'); await tick(); expect(b.count('post')).toBe(1); expect(b.calls.find(c => c[0] === 'post')[2]).toEqual({ code: 'SAMPLE-CODE', location: { lat: 14.5, lng: 121, accuracy_m: 4 } }); expect(b.count('upload')).toBe(1);
});
it('guards upload and app navigation across rerenders, then shows the receipt before a slow overtime read', async () => {
  const b = boot(), d = deferred(), ot = deferred(); b.api.upload = () => d.promise; b.api.get = (p: string) => p === '/me/unrecorded-ot' ? ot.promise : Promise.resolve(b.status); b.render(); await tick(); await b.scan(); b.w.MApp.go('home'); expect(b.view.querySelector('[data-cancel-capture]').disabled).toBe(true); b.render(); expect(b.count('upload')).toBe(1); const e = new b.w.Event('beforeunload', { cancelable: true }); b.w.dispatchEvent(e); expect(e.defaultPrevented).toBe(true);
  d.resolve({ at: '17:02', work_date: '2026-10-22', hours_today: 8.5 }); await tick(); expect(b.view.textContent).toContain('Time out recorded'); expect(b.view.textContent).toContain('Checking unrecorded overtime'); expect(b.view.textContent).not.toContain('Recording time out…'); ot.reject(Error('OT unavailable')); await tick(); expect(b.view.textContent).toContain('Time out recorded'); expect(b.view.textContent).toContain('Retry overtime check');
});
it('keeps a timed-out or failed upload unconfirmed, performs only readonly recovery and requires a fresh status before another capture', async () => {
  const b = boot(); b.api.upload = async () => { throw Error('Network unavailable'); }; b.render(); await tick(); await b.scan(); expect(b.view.textContent).toContain('Recording was not confirmed'); expect(b.count('upload')).toBe(1); b.click('[data-back-clock]'); expect(b.view.querySelector('[data-slot=out]').disabled).toBe(true); b.click('[data-open-recovery]');
  b.api.get = async () => { throw Error('Read failed'); }; b.click('[data-check-latest]'); await tick(); expect(b.view.textContent).toContain('still unclear'); b.api.get = async () => ({ ...b.status, slots: { ...b.status.slots, out: '17:02' } }); b.click('[data-check-latest]'); b.click('[data-check-latest]'); await tick(); expect(b.view.textContent).toContain('Latest record from the server'); expect(b.view.querySelector('.m-success')).toBeNull(); expect(b.count('upload')).toBe(1); b.click('[data-back-clock]'); b.click('[data-slot=out]'); expect(b.view.textContent).toContain('Replace your time out'); expect(b.count('upload')).toBe(1);
});
it('bounds an unanswered upload, aborts its fetch and never replays its late success into another route', async () => {
  const b = boot(), d = deferred(); const original = b.w.setTimeout.bind(b.w); b.w.setTimeout = (fn: any, ms: number, ...args: any[]) => original(fn, ms === 60000 ? 25 : ms, ...args); b.api.upload = () => d.promise; b.render(); await tick(); await b.scan(); await new Promise(r => setTimeout(r, 45)); expect(b.view.textContent).toContain('Recording was not confirmed'); const upload = b.calls.find(c => c[0] === 'upload'); expect(upload[3].signal.aborted).toBe(true); b.w.MApp.go('home'); d.resolve({ at: '17:02', work_date: '2026-10-22' }); await tick(); expect(b.view.textContent).toBe('Other screen'); expect(b.count('upload')).toBe(1);
});
it('keeps server dates, shows site-PC recording honestly and exposes outside mode only when permitted', async () => {
  const b = boot(); b.status.slot_date = '2026-10-21'; b.status.work_date = '2026-10-21'; b.api.upload = async () => ({ at: '06:03', work_date: '2026-10-21', hours_today: 8, __syncCommand: crypto.randomUUID() }); b.render(); await tick(); expect(b.view.querySelector('[data-where]')).toBeNull(); expect(b.view.textContent).toContain('Open shift'); await b.scan(); expect(b.view.textContent).toContain('Time out saved on site PC'); expect(b.view.textContent).toContain('Cloud confirmation is pending'); expect(b.calls.filter(c => c[1] === '/me/unrecorded-ot')).toHaveLength(0);
});
it('keeps the recording receipt visible and retries overtime without resending a punch', async () => {
  const b = boot(); b.api.get = async (p: string) => { if (p === '/me/unrecorded-ot') throw Error('OT unavailable'); return b.status; }; b.render(); await tick(); await b.scan(); b.api.get = async () => [{ work_date: '2026-10-22', ot_minutes: 30 }]; const retry = b.view.querySelector('[data-retry-ot]'); retry.click(); retry.click(); await tick(); expect(b.view.textContent).toContain('0.5 h unrecorded overtime'); expect(b.count('upload')).toBe(1); await new Promise(r => setTimeout(r, 2600)); expect(b.view.querySelector('.m-success')).not.toBeNull();
});
it('discards an old account’s late upload and does not reveal its receipt in a new sign-in', async () => {
  const b = boot(), d = deferred(); b.api.upload = () => d.promise; b.render(); await tick(); await b.scan(); b.changeAccount(); b.render(); await tick(); d.resolve({ at: '17:02', work_date: '2026-10-22' }); await tick(); expect(b.view.querySelector('.m-success')).toBeNull(); expect(b.view.querySelector('[data-slot=out]')).not.toBeNull();
});
function camera(b: ReturnType<typeof boot>, getMedia: any) {
  Object.defineProperty(b.w.navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: getMedia } }); b.w.HTMLMediaElement.prototype.play = async () => {};
  Object.defineProperty(b.w.HTMLVideoElement.prototype, 'videoWidth', { configurable: true, get: () => 640 }); Object.defineProperty(b.w.HTMLVideoElement.prototype, 'videoHeight', { configurable: true, get: () => 480 }); b.w.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {} }); b.w.HTMLCanvasElement.prototype.toBlob = (fn: any) => fn(new b.w.Blob(['jpeg'], { type: 'image/jpeg' }));
}
it('keeps a blocked selfie in its dialog, guards Retry, announces countdown and captures once', async () => {
  const b = boot(); let requests = 0, stops = 0; camera(b, async () => { requests++; if (requests === 1) { const e = Error('blocked'); e.name = 'NotAllowedError'; throw e; } return { getTracks: () => [{ stop: () => stops++ }] }; }); const p = b.realSelfie({ auto: 2 }); await tick(); expect(b.w.document.querySelector('[role=alert]').textContent).toContain('Camera is blocked'); expect(b.w.document.querySelectorAll('.m-selfie')).toHaveLength(1); b.click('[data-camera-retry]'); b.click('[data-camera-retry]'); await tick(); expect(requests).toBe(2); expect(b.w.document.querySelector('[role=status]').textContent).toContain('Photo in 2 seconds'); b.click('[data-shoot]'); const blob = await p; expect(blob.type).toBe('image/jpeg'); expect(stops).toBe(1); expect(b.w.document.querySelector('.m-selfie')).toBeNull();
});
it('cancels a selfie with Escape and stops a late permission stream without capture', async () => {
  const b = boot(), d = deferred(); let stopped = 0; camera(b, () => d.promise); const p = b.realSelfie({ auto: 2 }).catch((e: Error) => e.message); await tick(); b.w.document.dispatchEvent(new b.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); d.resolve({ getTracks: () => [{ stop: () => stopped++ }] }); expect(await p).toBe('cancelled'); await tick(); expect(stopped).toBe(1); expect(b.w.document.querySelector('.m-selfie')).toBeNull();
});
it('discards a canvas callback after Cancel and expires a held scan before sending a photo', async () => {
  const b = boot(); let captured: any; camera(b, async () => ({ getTracks: () => [{ stop() {} }] })); b.w.HTMLCanvasElement.prototype.toBlob = (fn: any) => captured = fn; const p = b.realSelfie({ auto: 2 }).catch((e: Error) => e.message); await tick(); b.click('[data-shoot]'); // Use the visible Cancel control; the caught promise is separate.
  b.click('.m-selfie .m-scan-x'); captured(new b.w.Blob(['jpeg'])); expect(await p).toBe('cancelled');
  const expires = b.realSelfie({ auto: 2, expiresAt: Date.now() + 30 }).catch((e: any) => e.code); expect(await expires).toBe('scan-expired'); expect(b.count('upload')).toBe(0);
});
it('retains the existing non-auto selfie review and retake controls', async () => {
  const b = boot(); camera(b, async () => ({ getTracks: () => [{ stop() {} }] })); b.w.URL.createObjectURL = () => 'blob:sample'; b.w.URL.revokeObjectURL = () => {}; const p = b.realSelfie({}); await tick(); b.click('[data-shoot]'); expect(b.w.document.querySelector('[data-use]').hidden).toBe(false); b.click('[data-retake]'); expect(b.w.document.querySelector('[data-shoot]').hidden).toBe(false); b.click('[data-shoot]'); b.click('[data-use]'); expect((await p).type).toBe('image/jpeg');
});
