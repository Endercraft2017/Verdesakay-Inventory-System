import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const source = fs.readFileSync(new URL('../public/mobile/modules/hr/approvals.js', import.meta.url), 'utf8');
const domSource = fs.readFileSync(new URL('../public/mobile/lib/dom.js', import.meta.url), 'utf8');
const balance = 'Requested 3 day(s), only 1 remaining. Approve anyway to override.';
const request = (id = 1) => ({ id, slug: 'leave_request', form_name: 'Leave Request', number: `LV-${id}`, employee_name: `Person ${id}`, created_at: '2026-10-22', display_data: { Reason: 'Family appointment', Days: 3 } });
const inbox = (requests: any[] = [request(), request(2)], extra: any = {}) => ({ can_approve: true, requests, time_corrections: [], history: [], ...extra });
const deferred = () => { let resolve!: (v: any) => void, reject!: (e: any) => void; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
let dom: JSDOM, w: any, view: HTMLElement, draw: () => void, get: any, post: any, token: string;
function click(selector: string) { const el = w.document.querySelector(selector); expect(el, selector).not.toBeNull(); el.focus(); el.click(); }
function text() { return w.document.body.textContent || ''; }
function note(value: string) { click('#m-appr-note-toggle'); const el = view.querySelector('textarea') as HTMLTextAreaElement; el.value = value; el.dispatchEvent(new w.Event('input', { bubbles: true })); }
async function decide(selector = '#m-appr-approve') { click(selector); await vi.advanceTimersByTimeAsync(4200); await flush(); }
async function mount(data = inbox()) {
  dom = new JSDOM('<main id="view"></main><footer>Navigation</footer>', { runScripts: 'outside-only', url: 'https://localhost/m#/approvals' }); w = dom.window;
  token = 'one'; get = vi.fn(async () => data); post = vi.fn(async () => ({ ok: true, status: 'approved' }));
  const routes: any = {};
  w.MApp = { route: (n: string, f: any) => routes[n] = f, getMe: () => ({ id: token }), setTitle() {}, refreshInboxBadge: vi.fn() };
  w.API = { getToken: () => token, base: () => '', get: (...args: any[]) => get(...args), post: (...args: any[]) => post(...args), syncLocal: (r: any) => r.__syncCommand };
  w.eval(domSource); w.eval(source); view = w.document.querySelector('#view'); draw = () => routes.approvals(view); draw(); await flush();
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => { dom?.window.close(); vi.useRealTimers(); });

describe('mobile approval decision ownership and recovery', () => {
  it('retains optional per-item notes through navigation and Undo without sending', async () => {
    await mount(); note('Checked roster'); click('[data-next]'); click('[data-prev]');
    expect((view.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Checked roster');
    click('#m-appr-approve'); expect(text()).toContain('Person 1'); expect((view.querySelector('[data-next]') as HTMLButtonElement).disabled).toBe(true);
    click('#m-appr-undo-action'); await vi.advanceTimersByTimeAsync(5000); expect(post).not.toHaveBeenCalled();
    expect((view.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Checked roster');
  });
  it('sends once with the captured item and note; detached buttons cannot decide the next item', async () => {
    await mount(); note('For the first item'); const old = view.querySelector('#m-appr-approve') as HTMLButtonElement;
    const wait = deferred(); post.mockImplementation(() => wait.promise); old.click(); old.click();
    await vi.advanceTimersByTimeAsync(4200); expect(post).toHaveBeenCalledTimes(1); expect(text()).toContain('Person 1');
    expect(post.mock.calls[0][0]).toContain('/requests/1/decide'); expect(post.mock.calls[0][1]).toEqual({ decision: 'approved', note: 'For the first item' });
    wait.resolve({ status: 'approved' }); await flush(); expect(text()).toContain('Continue review'); click('#m-appr-continue');
    old.click(); await vi.advanceTimersByTimeAsync(5000); expect(post).toHaveBeenCalledTimes(1); expect(text()).toContain('Person 2');
  });
  it('same-route rendering neither flushes Undo early nor duplicates an active POST', async () => {
    await mount(); click('#m-appr-approve'); draw(); await flush(); expect(post).not.toHaveBeenCalled();
    const wait = deferred(); post.mockImplementation(() => wait.promise); await vi.advanceTimersByTimeAsync(4200); draw(); await flush();
    expect(post).toHaveBeenCalledTimes(1); expect(text()).toContain('Sending approval'); wait.resolve({ status: 'approved' }); await flush(); expect(text()).toContain('Continue review');
  });
  it.each(['hashchange', 'pagehide', 'beforeunload'])('cancels an unsent decision on %s', async event => {
    await mount(); note('Keep this'); click('#m-appr-approve');
    if (event === 'hashchange') w.location.hash = '#/home'; w.dispatchEvent(new w.Event(event));
    await vi.advanceTimersByTimeAsync(5000); expect(post).not.toHaveBeenCalled();
  });
  it('clears private notes and cancels Undo after an account change', async () => {
    await mount(); note('Private note'); click('#m-appr-approve'); token = 'two'; w.dispatchEvent(new w.Event('storage'));
    await vi.advanceTimersByTimeAsync(5000); expect(post).not.toHaveBeenCalled(); expect(text()).not.toContain('Private note');
    get.mockResolvedValue(inbox([],{ can_approve: false })); draw(); await flush(); expect(text()).toContain('No approval access');
  });
  it('ignores a late balance response after account change', async () => {
    await mount(); const wait = deferred(); post.mockImplementation(() => wait.promise); await decide(); token = 'two';
    wait.reject(Object.assign(new Error(balance), { status: 400 })); await flush(); expect(w.document.querySelector('[role=dialog]')).toBeNull(); expect(text()).not.toContain('Person 1');
  });
  it('leaving during sending requires a status check when returning', async () => {
    await mount(); const wait = deferred(); post.mockImplementation(() => wait.promise); await decide();
    w.dispatchEvent(new w.Event('pagehide')); draw(); await flush(); wait.resolve({ status: 'approved' }); await flush();
    expect(text()).toContain('Check latest status'); expect((view.querySelector('#m-appr-approve') as HTMLButtonElement).disabled).toBe(true);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('offers Retry after an initial load failure and distinguishes missing authority from an empty queue', async () => {
    await mount(); get.mockRejectedValue(new Error('Load failed')); w.dispatchEvent(new w.Event('pagehide')); draw(); await flush();
    expect(text()).toContain('Retry latest approvals'); get.mockResolvedValue(inbox([],{can_approve:false})); click('#m-appr-retry'); await flush();
    expect(text()).toContain('No approval access'); expect(text()).not.toContain('All caught up');
  });
  it('cancels Undo when the app is hidden for sign-in', async () => {
    await mount(); click('#m-appr-approve'); view.hidden = true; await flush(); await vi.advanceTimersByTimeAsync(5000); expect(post).not.toHaveBeenCalled();
  });
  it('keeps unknown results blocked when the response has no recorded status', async () => {
    await mount(); post.mockResolvedValue({ok:true}); await decide(); expect(text()).toContain('did not confirm a recorded decision'); expect(text()).toContain('Check latest status');
  });
  it('does not overwrite another route with a stale read', async () => {
    await mount(); const wait = deferred(); get.mockImplementation(() => wait.promise); click('#m-appr-refresh');
    w.location.hash = '#/home'; view.textContent = 'Home'; await flush(); wait.resolve(inbox()); await flush(); expect(view.textContent).toBe('Home');
  });
  it('retains the current item and note on failed refresh and gates decisions across navigation', async () => {
    await mount(); note('Check me'); get.mockRejectedValue(new Error('Network unavailable')); click('#m-appr-refresh'); await flush();
    expect(text()).toContain('Network unavailable'); expect((view.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Check me');
    click('[data-next]'); expect((view.querySelector('#m-appr-approve') as HTMLButtonElement).disabled).toBe(true);
    get.mockResolvedValue(inbox()); click('#m-appr-retry'); await flush(); expect((view.querySelector('#m-appr-approve') as HTMLButtonElement).disabled).toBe(false);
  });
  it.each([401,403])('clears sensitive content on a %s read refusal', async status => {
    await mount(); note('Private note'); get.mockRejectedValue(Object.assign(new Error('Access refused'), { status })); click('#m-appr-refresh'); await flush();
    expect(text()).not.toContain('Person 1'); expect(text()).not.toContain('Private note'); expect(text()).toContain('Access refused');
  });
  it.each(['network','server','timeout'])('treats a %s failure as unconfirmed and never automatically resends', async kind => {
    await mount(); if (kind === 'timeout') post.mockImplementation(() => new Promise(() => {})); else post.mockRejectedValue(Object.assign(new Error('Unavailable'), kind === 'server' ? {status:503} : {offline:true}));
    await decide(); if (kind === 'timeout') await vi.advanceTimersByTimeAsync(60000);
    expect(text()).toContain('may have been recorded'); expect(text()).toContain('Check latest status');
    expect((view.querySelector('#m-appr-approve') as HTMLButtonElement).disabled).toBe(true); expect(post).toHaveBeenCalledTimes(1);
  });
  it('checks history by both kind and id; missing items remain unconfirmed', async () => {
    await mount(); post.mockRejectedValue(new Error('Lost response')); await decide();
    get.mockResolvedValue(inbox([], { history:[{id:1,kind:'correction',status:'approved'}] })); click('#m-appr-check'); await flush();
    expect(text()).toContain('Completion is not confirmed'); expect(text()).not.toContain('Latest status: Approved');
    get.mockRejectedValue(new Error('Check failed')); click('#m-appr-check'); await flush(); expect(text()).toContain('Check failed'); expect(text()).toContain('Person 1');
    get.mockResolvedValue(inbox([], { history:[{id:1,kind:'request',status:'rejected',decision_note:'Already reviewed'}] })); click('#m-appr-check'); await flush();
    expect(text()).toContain('Latest status: Rejected'); expect(post).toHaveBeenCalledTimes(1);
  });
  it('permits an explicit new review after fresh pending; exact uncertain body reuses its idempotency key', async () => {
    await mount(); note('Same note'); post.mockRejectedValue(new Error('Lost response')); await decide();
    const key = post.mock.calls[0][2].idempotencyKey; get.mockResolvedValue(inbox()); click('#m-appr-check'); await flush();
    expect(text()).toContain('still lists this item as pending'); post.mockResolvedValue({status:'approved'}); await decide();
    expect(post.mock.calls[1][2].idempotencyKey).toBe(key);
  });
  it('uses a new key when the body changes after an uncertain attempt', async () => {
    await mount(); post.mockRejectedValue(new Error('Lost response')); await decide(); const key = post.mock.calls[0][2].idempotencyKey;
    click('#m-appr-check'); await flush(); post.mockResolvedValue({status:'rejected'}); await decide('#m-appr-reject'); expect(post.mock.calls[1][2].idempotencyKey).not.toBe(key);
  });
  it('retains the authoritative payroll lock message and requires a fresh read', async () => {
    await mount(); post.mockRejectedValue(Object.assign(new Error('Payroll cutoff is locked'),{status:423})); await decide();
    expect(text()).toContain('Payroll cutoff is locked'); expect(text()).not.toContain('Check latest status'); expect((view.querySelector('#m-appr-approve') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('mobile approval dialogs and truthful receipts', () => {
  it('uses an app-owned balance dialog with default-safe focus, cancellation and a distinct override key', async () => {
    await mount(); note('Reviewed with employee'); post.mockRejectedValueOnce(Object.assign(new Error(balance),{status:400})); await decide();
    expect(text()).toContain(balance); expect(w.document.activeElement.id).toBe('m-appr-dialog-close'); expect(w.document.querySelector('footer').inert).toBe(true);
    w.document.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true})); expect(w.document.querySelector('[role=dialog]')).toBeNull(); expect(post).toHaveBeenCalledTimes(1); expect(text()).toContain('remains pending');
    post.mockRejectedValueOnce(Object.assign(new Error(balance),{status:400})); await decide();
    const override = w.document.querySelector('#m-appr-override'); override.click(); override.click(); await flush();
    expect(post).toHaveBeenCalledTimes(3); expect(post.mock.calls[2][1]).toEqual({decision:'approved',note:'Reviewed with employee',override_balance:true});
    expect(post.mock.calls[2][2].idempotencyKey).not.toBe(post.mock.calls[1][2].idempotencyKey); expect(w.document.querySelector('footer').inert).not.toBe(true);
    expect(text()).toContain('Continue review');
  });
  it('keeps a balance refusal reviewable after same-route rendering without an implicit override', async () => {
    await mount(); post.mockRejectedValue(Object.assign(new Error(balance),{status:400})); await decide(); draw(); await flush();
    expect(w.document.querySelector('[role=dialog]')).toBeNull(); click('#m-appr-balance'); expect(text()).toContain(balance); expect(post).toHaveBeenCalledTimes(1);
  });
  it('retains all warnings with request identity and restores keyboard focus when reopened', async () => {
    await mount(); post.mockResolvedValue({status:'approved',warnings:['First warning','Second warning']}); await decide();
    expect(text()).toContain('First warning'); expect(text()).toContain('Second warning'); expect(w.document.querySelector('[role=dialog]').textContent).toContain('LV-1');
    w.document.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Tab',bubbles:true})); expect(w.document.activeElement.id).toBe('m-appr-dialog-close');
    click('#m-appr-dialog-close'); click('#m-appr-continue'); click('[data-last]'); expect(w.document.querySelector('[role=dialog]').textContent).toContain('Person 1');
    click('#m-appr-dialog-close'); expect(w.document.activeElement.hasAttribute('data-last')).toBe(true);
  });
  it.each([
    [{status:'approved',__syncCommand:'pc-1'},'Saved on site PC · Approved','Awaiting cloud confirmation'],
    [{status:'rejected',clash:true,applied:false},'Existing decision kept: Rejected','did not replace'],
  ])('uses the actual status and local-save metadata (%j)', async (response, heading, fact) => {
    await mount(); post.mockResolvedValue(response); await decide(); expect(text()).toContain(heading); expect(text()).toContain(fact); expect(text()).not.toContain('No matching cutoff');
  });
  it('distinguishes an approved correction that was not applied from a clash', async () => {
    const correction = {id:1,employee_name:'Person T',work_date:'2026-10-20',requested_in:'08:00',reason:'Missed scan'};
    await mount(inbox([],{time_corrections:[correction]})); post.mockResolvedValue({status:'approved',applied:false}); await decide();
    expect(text()).toContain('Approved · time not applied yet'); expect(text()).toContain('No matching cutoff');
  });
  it('preserves the server explanation for an unapplied information change', async () => {
    await mount(inbox([{...request(),slug:'information_change'}])); post.mockResolvedValue({status:'approved',applied:false,applied_note:'The field is no longer supported.'}); await decide();
    expect(text()).toContain('employee record not changed'); expect(text()).toContain('The field is no longer supported.');
  });
  it('does not guess correction application from a history status alone', async () => {
    await mount(inbox([],{time_corrections:[{id:1,employee_name:'Person T',work_date:'2026-10-20'}]})); post.mockRejectedValue(new Error('Lost')); await decide();
    get.mockResolvedValue(inbox([],{history:[{id:1,kind:'correction',status:'approved'}]})); click('#m-appr-check'); await flush();
    expect(text()).toContain('Latest status: Approved'); expect(text()).not.toContain('applied to timekeeping'); expect(text()).not.toContain('No matching cutoff');
  });
});
