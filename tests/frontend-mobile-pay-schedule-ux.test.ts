import { afterEach, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
const root = path.join(import.meta.dirname, '../public'),
  doms: JSDOM[] = [];
afterEach(() => doms.splice(0).forEach((d) => d.window.close()));
const tick = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
function deferred() {
  let resolve: any, reject: any;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
function boot(route = 'payslips') {
  const dom = new JSDOM('<div id="app"><button id="outside">Outside</button><main id="view"></main></div>', {
    runScripts: 'outside-only',
    url: 'https://localhost/m/#/' + route,
  });
  doms.push(dom);
  const w = dom.window as any,
    view = w.document.querySelector('main'),
    routes: any = {},
    calls: any[] = [],
    navigations: any[] = [];
  let account = 1,
    token = 'sample-session-one';
  const realDate = w.Date;
  w.Date = class extends realDate {
    constructor(...args: any[]) {
      super(...(args.length ? args : ['2026-10-22T06:00:00Z']));
    }
    static now() {
      return new realDate('2026-10-22T06:00:00Z').getTime();
    }
  };
  const rows: any[] = [
    {
      id: 11,
      period: 'Oct 1–15',
      finalized: true,
      download_url: '/me/payslips/11/pdf',
      data: { net_pay: 12000, basic_pay: 12000, days_worked: 11, ot_hours: 3 },
    },
    { id: 12, period: 'Oct 16–31', finalized: false, data: { basic_pay: 5000, total_deductions: 100 } },
  ];
  const roster = {
    days: [
      {
        work_date: '2026-10-23',
        is_working_day: true,
        shift_name: 'Day',
        start_time: '08:00',
        end_time: '17:00',
      },
      {
        work_date: '2026-10-24',
        is_working_day: false,
        shift_name: 'Day',
        start_time: '08:00',
        end_time: '17:00',
      },
      { work_date: '2026-10-26', is_working_day: true, time_in: '08:07', time_out: '17:32' },
      {
        work_date: '2026-10-27',
        is_working_day: true,
        shift_name: 'Night',
        start_time: '22:00',
        end_time: '06:00',
      },
    ],
  };
  const time: any = {
    finalized: true,
    source: 'saved_calculation',
    days: [{ work_date: '2026-10-14', time_in: '08:00', time_out: '17:00', late_minutes: 2 }],
  };
  const api: any = {
    get: async (p: string) =>
      p === '/me/payslips'
        ? structuredClone(rows)
        : p === '/me/schedule'
          ? structuredClone(roster)
          : p === '/me/unrecorded-ot'
            ? [
                { period_label: 'Oct 1–15', work_date: '2026-10-14', ot_minutes: 60 },
                { period_label: 'Other', work_date: '2026-09-01', ot_minutes: 600 },
              ]
            : structuredClone(time),
    download: async () => {},
  };
  w.API = {
    base: () => '',
    getToken: () => token,
    isSharedSession: () => false,
    get: (p: string, o: any) => {
      calls.push(['get', p, o]);
      return api.get(p, o);
    },
    download: (...a: any[]) => {
      calls.push(['download', ...a]);
      return api.download(...a);
    },
  };
  w.MApp = {
    route: (n: string, f: any) => (routes[n] = f),
    getMe: () => ({ id: account, employee: { id: account } }),
    setTitle() {},
    go: (n: string, p: any) => {
      navigations.push([n, p]);
      w.location.hash = '#/' + n;
      view.innerHTML = '<h1>Other screen</h1>';
    },
  };
  for (const f of ['mobile/lib/dom.js', 'mobile/modules/hr/schedule.js', 'mobile/modules/hr/payslips.js'])
    w.eval(fs.readFileSync(path.join(root, f), 'utf8'));
  const render = () => routes[route](view),
    click = (q: string) => {
      const e = w.document.querySelector(q);
      expect(e, q).not.toBeNull();
      e.click();
    };
  const count = (p: string) => calls.filter((c) => c[0] === 'get' && c[1] === p).length;
  const open = async (id = 11) => {
    render();
    await tick();
    click('[data-slip-id="' + id + '"]');
    await tick();
  };
  return {
    w,
    view,
    api,
    calls,
    rows,
    roster,
    time,
    render,
    click,
    count,
    open,
    navigations,
    changeAccount: () => {
      account++;
      token = 'sample-session-' + account;
    },
    reenter: () => {
      w.location.hash = '#/' + route;
      render();
    },
  };
}
it('distinguishes unpublished, non-working and missing planned shift times without treating punches as a shift', async () => {
  const b = boot('schedule');
  b.render();
  await tick();
  b.click('#scheduleWeek [data-date="2026-10-25"]');
  expect(b.view.getAttribute('data-figma-node')).toBe('46:606');
  expect(b.view.textContent).toContain('Schedule not published');
  expect(b.view.textContent).not.toContain('Rest day');
  b.click('#scheduleWeek [data-date="2026-10-24"]');
  expect(b.view.querySelector('.m-schedule-detail').textContent).toContain('Non-working day');
  expect(b.view.querySelector('.m-schedule-detail').textContent).not.toContain('8:00 AM');
  b.click('#scheduleUpcoming [data-date="2026-10-26"]');
  expect(b.view.textContent).toContain('Shift time unavailable');
  expect(b.view.textContent).toContain('Recorded punches');
  expect(b.view.querySelector('.m-schedule-shift').textContent).not.toContain('8:07');
});
it('rebuilds Upcoming, preserves full-date keyboard focus and marks overnight times', async () => {
  const b = boot('schedule');
  b.render();
  await tick();
  b.click('#scheduleWeek [data-date="2026-10-23"]');
  expect(b.w.document.activeElement.dataset.date).toBe('2026-10-23');
  expect(b.w.document.activeElement.getAttribute('aria-label')).toContain('2026');
  expect(b.view.querySelector('#scheduleUpcoming [data-date="2026-10-23"]')).toBeNull();
  b.click('#scheduleNext');
  b.click('#scheduleWeek [data-date="2026-10-27"]');
  expect(b.view.querySelector('.m-schedule-detail').textContent).toContain('next day');
});
it('uses only the exact eligible selected date for a schedule request', async () => {
  const b = boot('schedule');
  b.render();
  await tick();
  const initial = b.view.querySelector('#scheduleRequest');
  initial.dispatchEvent(new b.w.MouseEvent('click'));
  expect(b.navigations).toHaveLength(0);
  b.click('#scheduleWeek [data-date="2026-10-24"]');
  expect(b.view.querySelector('#scheduleRequest').disabled).toBe(true);
  b.click('#scheduleWeek [data-date="2026-10-23"]');
  b.click('#scheduleRequest');
  expect(b.navigations).toEqual([['requests', { type: 'schedule_change', date: '2026-10-23' }]]);
});
it('shares roster reads across rerenders and retains cached dates on failure with a real Retry', async () => {
  const b = boot('schedule'),
    d = deferred();
  b.api.get = () => d.promise;
  b.render();
  b.render();
  await tick();
  expect(b.count('/me/schedule')).toBe(1);
  d.resolve(b.roster);
  await tick();
  b.api.get = async () => {
    throw Error('Offline');
  };
  b.click('#scheduleRefresh');
  b.click('#scheduleRefresh');
  await tick();
  expect(b.count('/me/schedule')).toBe(2);
  expect(b.view.textContent).toContain('Last loaded dates');
  expect(b.view.querySelector('#scheduleRequest').disabled).toBe(true);
  b.api.get = async () => b.roster;
  b.click('#scheduleRefresh');
  await tick();
  expect(b.view.querySelector('[role=alert]')).toBeNull();
});
it('recovers an initial roster error without navigating to the same hash', async () => {
  const b = boot('schedule');
  b.api.get = async () => {
    throw Error('Offline');
  };
  b.render();
  await tick();
  expect(b.view.textContent).toContain('Retry schedule');
  b.api.get = async () => b.roster;
  b.click('#scheduleRefresh');
  await tick();
  expect(b.count('/me/schedule')).toBe(2);
  expect(b.view.textContent).toContain('Upcoming');
  expect(b.navigations).toHaveLength(0);
});
it('drops late roster results on navigation and isolates a different sign-in', async () => {
  const b = boot('schedule'),
    d = deferred();
  b.api.get = () => d.promise;
  b.render();
  await tick();
  b.w.MApp.go('home');
  await tick();
  b.changeAccount();
  b.api.get = async () => ({ days: [] });
  b.reenter();
  await tick();
  d.resolve(b.roster);
  await tick();
  expect(b.view.textContent).not.toContain('Night');
  expect(b.view.querySelector('#scheduleRequest').disabled).toBe(true);
});
it('shares payslip reads, preserves rows on refresh failure and restores originating row focus', async () => {
  const b = boot(),
    d = deferred();
  b.api.get = (p: string) => (p === '/me/payslips' ? d.promise : Promise.resolve([]));
  b.render();
  b.render();
  await tick();
  expect(b.count('/me/payslips')).toBe(1);
  d.resolve(b.rows);
  await tick();
  b.api.get = async () => {
    throw Error('Offline');
  };
  b.click('#m-pay-refresh');
  b.click('#m-pay-refresh');
  await tick();
  expect(b.count('/me/payslips')).toBe(2);
  expect(b.view.querySelectorAll('[data-slip-id]')).toHaveLength(2);
  expect(b.view.textContent).toContain('last loaded list');
  b.click('[data-slip-id="11"]');
  b.click('.m-payslip-back');
  expect(b.w.document.activeElement.dataset.slipId).toBe('11');
});
it.each([undefined, null, '', true, 'not a number'])(
  'does not invent net pay from absent/invalid supplied amount %s',
  async (net) => {
    const b = boot();
    b.rows[1].data.net_pay = net;
    await b.open(12);
    expect(b.view.querySelector('.m-payslip-net-card strong').textContent).toBe('Unavailable');
    expect(b.view.querySelector('#m-pay-download')).toBeNull();
    expect(b.view.querySelector('.is-draft')).not.toBeNull();
  },
);
it('keeps zero net pay valid and counts plain, hiding bookkeeping and duplicate net lines', async () => {
  const b = boot();
  b.rows[0].data.net_pay = 0;
  b.rows[0].data._calculation_snapshot = 'private';
  await b.open();
  expect(b.view.getAttribute('data-figma-node')).toBe('46:924');
  expect(b.view.querySelector('.m-payslip-net-card strong').textContent).toContain('0.00');
  expect(b.view.querySelector('.m-payslip-lines').textContent).not.toContain('Net Pay');
  expect(b.view.querySelector('.m-payslip-lines').textContent).not.toContain('Calculation');
  expect(
    (Array.from(b.view.querySelectorAll('.m-payslip-lines div')) as any[]).find((e: any) =>
      e.textContent.includes('Days Worked'),
    )?.textContent,
  ).toBe('Days Worked11');
});
it.each([
  { finalized: false, download_url: '/pdf' },
  { finalized: 'true', download_url: '/pdf' },
  { finalized: true, download_url: '   ' },
])('keeps download fail-closed for %j', async (record) => {
  const b = boot();
  Object.assign(b.rows[0], record);
  await b.open();
  expect(b.view.querySelector('#m-pay-download')).toBeNull();
});
it('retries overtime independently, matches one period and refuses missing-period attribution', async () => {
  const b = boot();
  const original = b.api.get;
  b.api.get = (p: string) => (p === '/me/unrecorded-ot' ? Promise.reject(Error('OT offline')) : original(p));
  await b.open();
  expect(b.view.textContent).toContain('Overtime could not be checked');
  expect(b.view.textContent).toContain('12,000.00');
  b.api.get = original;
  b.click('#m-pay-ot-retry');
  await tick();
  expect(b.view.querySelector('.m-payslip-ot').textContent).toContain('1 hour(s)');
  expect(b.view.querySelector('.m-payslip-ot').textContent).not.toContain('11 hour');
  delete b.rows[0].period;
  b.render();
  await tick();
  b.click('#m-pay-refresh');
  await tick();
  b.click('[data-slip-id="11"]');
  expect(b.view.textContent).toContain('Overtime could not be matched');
  expect(b.view.querySelector('[data-ot-date]')).toBeNull();
});
it('refreshes detail from the authoritative list and removes Paid download access when revoked', async () => {
  const b = boot();
  await b.open();
  b.rows[0].finalized = false;
  b.rows[0].download_url = null;
  b.click('#m-pay-refresh');
  await tick();
  expect(b.view.querySelector('#m-pay-download')).toBeNull();
  expect(b.view.querySelector('.is-draft')).not.toBeNull();
  b.rows.splice(0, 1);
  b.click('#m-pay-refresh');
  await tick();
  expect(b.view.textContent).toContain('not in your latest list');
  expect(b.view.textContent).not.toContain('12,000.00');
});
it('guards PDF preparations, retains errors and enables retries and repeat downloads', async () => {
  const b = boot(),
    d = deferred();
  await b.open();
  b.api.download = () => d.promise;
  b.click('#m-pay-download');
  b.view.querySelector('#m-pay-download').dispatchEvent(new b.w.MouseEvent('click'));
  await tick();
  expect(b.calls.filter((c) => c[0] === 'download')).toHaveLength(1);
  d.reject(Error('Offline'));
  await tick();
  expect(b.view.querySelector('[role=alert]').textContent).toContain('PDF could not be prepared');
  b.api.download = async () => {};
  b.click('#m-pay-download');
  await tick();
  expect(b.view.querySelector('#m-pay-download').disabled).toBe(false);
  expect(b.view.querySelector('#m-pay-download').textContent).toContain('again');
});
it('cancels PDF delivery ownership on departure and suppresses a late success', async () => {
  const b = boot(),
    d = deferred();
  await b.open();
  b.api.download = () => d.promise;
  b.click('#m-pay-download');
  await tick();
  const opts = b.calls.find((c) => c[0] === 'download')[3];
  expect(opts.isCurrent()).toBe(true);
  b.w.MApp.go('home');
  await tick();
  expect(opts.signal.aborted).toBe(true);
  expect(opts.isCurrent()).toBe(false);
  d.resolve();
  await tick();
  expect(b.view.textContent).toBe('Other screen');
});
it('keeps one timekeeping modal/read, traps keys and restores focus after asynchronous background rendering', async () => {
  const b = boot(),
    d = deferred();
  await b.open();
  const original = b.api.get;
  b.api.get = (p: string) => (p.endsWith('/timekeeping') ? d.promise : original(p));
  const old = b.view.querySelector('#m-pay-time');
  old.click();
  old.dispatchEvent(new b.w.MouseEvent('click'));
  await tick();
  expect(b.w.document.querySelectorAll('[role=dialog]')).toHaveLength(1);
  expect(b.count('/me/payslips/11/timekeeping')).toBe(1);
  b.w.document.dispatchEvent(
    new b.w.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
  );
  expect(b.w.document.querySelector('[role=dialog]').contains(b.w.document.activeElement)).toBe(true);
  d.resolve(b.time);
  await tick();
  b.w.document.dispatchEvent(new b.w.KeyboardEvent('keydown', { key: 'Escape' }));
  expect(b.w.document.activeElement.id).toBe('m-pay-time');
  expect(b.w.document.querySelector('#app').inert).toBeFalsy();
});
it('has in-modal Retry and preserves current/saved/legacy notices and empty-cutoff states', async () => {
  const b = boot();
  await b.open();
  const original = b.api.get;
  b.api.get = (p: string) =>
    p.endsWith('/timekeeping') ? Promise.reject(Error('Read failed')) : original(p);
  b.click('#m-pay-time');
  await tick();
  expect(b.w.document.querySelector('[role=dialog] [role=alert]')).not.toBeNull();
  b.time.source = 'attendance_record';
  b.time.notice = 'Older record: later corrections may differ.';
  b.time.days = [];
  b.api.get = original;
  b.click('#m-pay-time-retry');
  await tick();
  expect(b.w.document.querySelector('[role=dialog]').textContent).toContain('Current recorded punches');
  expect(b.w.document.querySelector('[role=dialog]').textContent).toContain('later corrections');
  expect(b.w.document.querySelector('[role=dialog]').textContent).toContain('No timekeeping rows');
});
it('closes a pending modal on same-hash rerender/account change and ignores the earlier response', async () => {
  const b = boot(),
    d = deferred();
  await b.open();
  const original = b.api.get;
  b.api.get = (p: string) => (p.endsWith('/timekeeping') ? d.promise : original(p));
  b.click('#m-pay-time');
  await tick();
  b.changeAccount();
  b.rows.splice(0);
  b.render();
  await tick();
  expect(b.w.document.querySelector('[role=dialog]')).toBeNull();
  d.resolve({ ...b.time, notice: 'OLD ACCOUNT' });
  await tick();
  expect(b.view.textContent).not.toContain('OLD ACCOUNT');
  expect(b.view.textContent).not.toContain('12,000.00');
  expect(b.view.textContent).toContain('No payslips');
});
it('clears inaccessible cached rows after a permission error rather than retaining sensitive figures', async () => {
  const b = boot();
  await b.open();
  b.api.get = async () => {
    throw Object.assign(Error('Not available'), { status: 403 });
  };
  b.click('#m-pay-refresh');
  await tick();
  expect(b.view.textContent).not.toContain('12,000.00');
  expect(b.view.querySelector('#m-pay-download')).toBeNull();
});
it('bounds a stuck roster read and releases Retry without accepting its late result', async () => {
  const b = boot('schedule'),
    d = deferred(),
    timers: Function[] = [];
  const native = b.w.setTimeout;
  b.w.setTimeout = (fn: Function, ms: number) => (ms === 20000 ? (timers.push(fn), 999) : native(fn, ms));
  b.api.get = () => d.promise;
  b.render();
  await tick();
  timers[0]!();
  await tick();
  expect(b.view.textContent).toContain('timed out');
  expect(b.view.querySelector('#scheduleRefresh').disabled).toBe(false);
  b.api.get = async () => ({ days: [] });
  b.click('#scheduleRefresh');
  await tick();
  d.resolve(b.roster);
  await tick();
  expect(b.view.textContent).not.toContain('Night');
});
it('times out a stuck PDF, aborts its delivery and permits an explicit retry', async () => {
  const b = boot(),
    d = deferred(),
    timers: Function[] = [];
  const native = b.w.setTimeout;
  b.w.setTimeout = (fn: Function, ms: number) => (ms === 60000 ? (timers.push(fn), 999) : native(fn, ms));
  await b.open();
  b.api.download = () => d.promise;
  b.click('#m-pay-download');
  await tick();
  const opts = b.calls.find((c) => c[0] === 'download')[3];
  timers[0]!();
  await tick();
  expect(opts.signal.aborted).toBe(true);
  expect(b.view.textContent).toContain('preparation timed out');
  b.api.download = async () => {};
  b.click('#m-pay-download');
  await tick();
  d.resolve();
  await tick();
  expect(b.view.querySelector('#m-pay-download').textContent).toContain('again');
});
it('closes a modal on a same-account same-hash forced route render', async () => {
  const b = boot();
  await b.open();
  b.click('#m-pay-time');
  await tick();
  b.render();
  await tick();
  expect(b.w.document.querySelector('[role=dialog]')).toBeNull();
  expect(b.w.document.querySelector('#app').inert).toBeFalsy();
});
it('clears an earlier employee modal when its response finishes after an identity change without a rerender', async () => {
  const b = boot(),
    d = deferred();
  await b.open();
  const original = b.api.get;
  b.api.get = (p: string) => (p.endsWith('/timekeeping') ? d.promise : original(p));
  b.click('#m-pay-time');
  await tick();
  b.changeAccount();
  d.resolve(b.time);
  await tick();
  expect(b.w.document.querySelector('[role=dialog]')).toBeNull();
  expect(b.view.textContent).toBe('');
});
