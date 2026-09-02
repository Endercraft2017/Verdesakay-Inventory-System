/** Operational dashboards — GET /api/analytics/overview. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';

let ctx: TestContext;
let token: string;
const authHdr = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  ctx = await setupApp();
  token = await login(ctx.api);
});
afterAll(() => cleanup(ctx));

const defaultLocId = async () =>
  (await ctx.api.get('/api/locations').set(authHdr())).body.find((l: { is_default: number }) => l.is_default === 1).id as number;

describe('analytics overview', () => {
  it('reports inventory stock value from item costs', async () => {
    // 10 units @ standard_cost 25 = 250 of value
    await ctx.api.post('/api/inventory').set(authHdr())
      .send({ name: 'Val Widget', quantity: 10, attributes: { standard_cost: 25 } });

    const r = await ctx.api.get('/api/analytics/overview').set(authHdr());
    expect(r.status).toBe(200);
    expect(r.body.inventory).toBeTruthy();
    expect(r.body.inventory.stock_value).toBeGreaterThanOrEqual(250);
    expect(r.body.inventory.items).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(r.body.inventory.top_value_items)).toBe(true);
  });

  it('surfaces purchasing / AP figures', async () => {
    const loc = await defaultLocId();
    const item = (await ctx.api.post('/api/inventory').set(authHdr())
      .send({ name: 'AP Bolt', quantity: 0 })).body.id as number;
    const po = await ctx.api.post('/api/orders').set(authHdr())
      .send({ type: 'purchase', items: [{ item_id: item, name: 'AP Bolt', quantity: 100, unit_price: 4 }] });
    const oi = (await ctx.api.get(`/api/orders/${po.body.id}`).set(authHdr())).body.items[0].id;

    await ctx.api.post(`/api/purchasing/orders/${po.body.id}/receipts`).set(authHdr())
      .send({ location_id: loc, lines: [{ order_item_id: oi, item_id: item, name: 'AP Bolt', quantity: 100 }] });
    const bill = await ctx.api.post(`/api/purchasing/orders/${po.body.id}/bills`).set(authHdr())
      .send({ due_date: '2000-01-01', lines: [{ order_item_id: oi, item_id: item, name: 'AP Bolt', quantity: 100, unit_price: 4 }] });
    await ctx.api.post(`/api/purchasing/bills/${bill.body.id}/approve`).set(authHdr()).send({});

    const r = await ctx.api.get('/api/analytics/overview').set(authHdr());
    expect(r.body.purchasing).toBeTruthy();
    expect(r.body.purchasing.open_pos).toBeGreaterThanOrEqual(1);
    // one approved bill, past due → shows in the 60+ bucket and the total
    expect(r.body.purchasing.ap_aging.total).toBeGreaterThanOrEqual(400);
    expect(r.body.purchasing.ap_aging.d60_plus).toBeGreaterThanOrEqual(400);
  });

  it('counts open sale orders', async () => {
    const item = (await ctx.api.post('/api/inventory').set(authHdr())
      .send({ name: 'Sold Thing', quantity: 5 })).body.id as number;
    await ctx.api.post('/api/orders').set(authHdr())
      .send({ type: 'sale', status: 'open', items: [{ item_id: item, name: 'Sold Thing', quantity: 2, unit_price: 50 }] });

    const r = await ctx.api.get('/api/analytics/overview').set(authHdr());
    expect(r.body.sales.open_orders).toBeGreaterThanOrEqual(1);
    expect(r.body.sales.open_value).toBeGreaterThanOrEqual(100);
    expect(Array.isArray(r.body.sales.weekly)).toBe(true);
  });

  it('includes a production section with status counts', async () => {
    const r = await ctx.api.get('/api/analytics/overview').set(authHdr());
    expect(r.body.production).toBeTruthy();
    expect(typeof r.body.production.by_status).toBe('object');
    expect(r.body.production.last_30).toHaveProperty('scrap_rate_pct');
  });

  it('omits sections the caller has no permission for', async () => {
    const mk = await createEmployee(ctx.api, token, { role: 'marketing', username: 'rep_mkt' });
    const r = await ctx.api.get('/api/analytics/overview').set('Authorization', `Bearer ${mk.token}`);
    expect(r.status).toBe(200);
    expect(r.body.inventory).toBeUndefined();
    expect(r.body.purchasing).toBeUndefined();
    expect(r.body.payroll).toBeUndefined();
    expect(r.body.generated_at).toBeTruthy();
  });

  it('gives HR the payroll section', async () => {
    const hr = await createEmployee(ctx.api, token, { role: 'hr', username: 'rep_hr' });
    const r = await ctx.api.get('/api/analytics/overview').set('Authorization', `Bearer ${hr.token}`);
    expect(r.body.payroll).toBeTruthy();
    expect(Array.isArray(r.body.payroll.periods)).toBe(true);
    expect(r.body.inventory).toBeUndefined();
  });

  it('payroll.incomplete_timekeeping counts employees with exactly one of time_in/time_out set, in a cutoff covering today (item 7)', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const emp = await ctx.api.post('/api/hr/employees').set(authHdr())
      .send({ employee_no: 'TEST-INCOMPLETE', name: 'Incomplete Test Employee', daily_rate: 500 });
    const period = await ctx.api.post('/api/hr/periods').set(authHdr())
      .send({ label: 'Incomplete Cutoff', start_date: today, end_date: today });
    await ctx.api.post(`/api/hr/periods/${period.body.id}/employees`).set(authHdr()).send({ employee_id: emp.body.id });

    const before = await ctx.api.get('/api/analytics/overview').set(authHdr());
    const beforeCount = before.body.payroll.incomplete_timekeeping;

    // Only time_in set — incomplete.
    await ctx.api.put(`/api/hr/periods/${period.body.id}/attendance`).set(authHdr()).send({
      employee_id: emp.body.id,
      days: [{ work_date: today, time_in: '08:00', time_out: '', notes: '' }],
    });
    const after = await ctx.api.get('/api/analytics/overview').set(authHdr());
    expect(after.body.payroll.incomplete_timekeeping).toBe(beforeCount + 1);

    // Filling in time_out clears it.
    await ctx.api.put(`/api/hr/periods/${period.body.id}/attendance`).set(authHdr()).send({
      employee_id: emp.body.id,
      days: [{ work_date: today, time_in: '08:00', time_out: '17:00', notes: '' }],
    });
    const filled = await ctx.api.get('/api/analytics/overview').set(authHdr());
    expect(filled.body.payroll.incomplete_timekeeping).toBe(beforeCount);
  });

  it('payroll.incomplete_timekeeping still counts an incomplete day in an already-ended cutoff', async () => {
    // A cutoff that ended well before today (but within 120 days) — the Home count must not
    // silently drop these the way the old "cutoff covers today" filter did.
    const pastStart = new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10);
    const pastEnd = new Date(Date.now() - 38 * 86400000).toISOString().slice(0, 10);
    const emp = await ctx.api.post('/api/hr/employees').set(authHdr())
      .send({ employee_no: 'TEST-INCOMPLETE-PAST', name: 'Past Cutoff Employee', daily_rate: 500 });
    const period = await ctx.api.post('/api/hr/periods').set(authHdr())
      .send({ label: 'Ended Cutoff', start_date: pastStart, end_date: pastEnd });
    await ctx.api.post(`/api/hr/periods/${period.body.id}/employees`).set(authHdr()).send({ employee_id: emp.body.id });

    const before = (await ctx.api.get('/api/analytics/overview').set(authHdr())).body.payroll.incomplete_timekeeping;
    await ctx.api.put(`/api/hr/periods/${period.body.id}/attendance`).set(authHdr()).send({
      employee_id: emp.body.id,
      days: [{ work_date: pastStart, time_in: '08:00', time_out: '', notes: '' }],
    });
    const after = (await ctx.api.get('/api/analytics/overview').set(authHdr())).body.payroll.incomplete_timekeeping;
    expect(after).toBe(before + 1);

    // And it shows up in the drill-down endpoint with the employee's account info.
    const list = await ctx.api.get('/api/hr/timekeeping/incomplete').set(authHdr());
    expect(list.body.some((r: { employee_id: number }) => r.employee_id === emp.body.id)).toBe(true);
  });
});
