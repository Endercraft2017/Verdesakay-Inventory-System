/** Production teams + job-order scheduling (team assignment, planned/due dates,
 *  priority, work centre, capacity setting, overdue flag). */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, type TestContext } from './helpers';

let ctx: TestContext;
let token: string;
const H = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  ctx = await setupApp();
  token = await login(ctx.api);
});
afterAll(() => cleanup(ctx));

const mkItem = async (name: string) =>
  (await ctx.api.post('/api/inventory').set(H()).send({ name })).body.id as number;

async function finishedProduct(prefix: string) {
  const product = await mkItem(`${prefix} Product`);
  const part = await mkItem(`${prefix} Part`);
  await ctx.api.put(`/api/finished-products/${product}`).set(H())
    .send({ components: [{ component_item_id: part, quantity: 1 }] });
  return product;
}

describe('production teams', () => {
  it('CRUD + member roster, and delete is blocked while a job order points at it', async () => {
    const t = await ctx.api.post('/api/production/teams').set(H()).send({ name: 'Line A', notes: 'day shift' });
    expect(t.status).toBe(201);
    const teamId = t.body.id;

    // an HR employee with no login account at all can still be added to a team
    const emp = (await ctx.api.post('/api/hr/employees').set(H())
      .send({ employee_no: 'WELD-1', name: 'Welder One' })).body;
    expect((await ctx.api.get('/api/production/employees').set(H())).body.some((e: { id: number }) => e.id === emp.id)).toBe(true);

    const add = await ctx.api.post(`/api/production/teams/${teamId}/members`).set(H())
      .send({ employee_id: emp.id, role: 'lead' });
    expect(add.status).toBe(201);
    expect(add.body.members.some((m: { employee_id: number; role: string }) => m.employee_id === emp.id && m.role === 'lead')).toBe(true);

    // duplicate member -> 409
    expect((await ctx.api.post(`/api/production/teams/${teamId}/members`).set(H()).send({ employee_id: emp.id })).status).toBe(409);

    const list = await ctx.api.get('/api/production/teams').set(H());
    const row = list.body.find((x: { id: number }) => x.id === teamId);
    expect(row.member_count).toBe(1);

    // assign a job order to the team, then deletion is blocked
    const product = await finishedProduct('TeamDel');
    await ctx.api.post('/api/job-orders').set(H()).send({ product_item_id: product, qty_ordered: 1, team_id: teamId });
    const del = await ctx.api.delete(`/api/production/teams/${teamId}`).set(H());
    expect(del.status).toBe(409);

    // removing the member works
    const rm = await ctx.api.delete(`/api/production/teams/${teamId}/members/${emp.id}`).set(H());
    expect(rm.status).toBe(200);
    expect(rm.body.members.length).toBe(0);
  });

  it('a job order carries its team, schedule fields, and an overdue flag; /schedule re-plans after release', async () => {
    const team = (await ctx.api.post('/api/production/teams').set(H()).send({ name: 'Line B' })).body.id;
    const product = await finishedProduct('Sched');

    const mo = await ctx.api.post('/api/job-orders').set(H()).send({
      product_item_id: product, qty_ordered: 2, team_id: team,
      planned_start: '2020-01-01', due_date: '2020-01-05', priority: 3, work_center: 'Cell 4',
    });
    expect(mo.status).toBe(201);

    const jo = (await ctx.api.get(`/api/job-orders/${mo.body.id}`).set(H())).body;
    expect(jo.team_name).toBe('Line B');
    expect(jo.due_date).toBe('2020-01-05');
    expect(jo.priority).toBe(3);
    expect(jo.work_center).toBe('Cell 4');

    // list carries team_name + computed overdue (past due date, still open)
    const list = await ctx.api.get('/api/job-orders?scheduled=1').set(H());
    const lrow = list.body.find((x: { id: number }) => x.id === mo.body.id);
    expect(lrow.team_name).toBe('Line B');
    expect(!!lrow.overdue).toBe(true);

    // re-plan after release
    await ctx.api.post(`/api/job-orders/${mo.body.id}/release`).set(H());
    await ctx.api.post(`/api/job-orders/${mo.body.id}/accept`).set(H());
    const resched = await ctx.api.put(`/api/job-orders/${mo.body.id}/schedule`).set(H())
      .send({ due_date: '2099-12-31', team_id: null, priority: 0 });
    expect(resched.status).toBe(200);
    expect(resched.body.job_order.due_date).toBe('2099-12-31');
    expect(resched.body.job_order.team_id).toBeNull();

    const list2 = await ctx.api.get('/api/job-orders?scheduled=1').set(H());
    expect(!!list2.body.find((x: { id: number }) => x.id === mo.body.id).overdue).toBe(false);
  });

  it('the advisory daily capacity setting round-trips', async () => {
    expect((await ctx.api.get('/api/production/capacity').set(H())).body.daily_capacity).toBe(0);
    const put = await ctx.api.put('/api/production/capacity').set(H()).send({ daily_capacity: 25 });
    expect(put.body.daily_capacity).toBe(25);
    expect((await ctx.api.get('/api/production/capacity').set(H())).body.daily_capacity).toBe(25);
  });

  it('rejects an unknown team on create and 400s a bad date', async () => {
    const product = await finishedProduct('BadTeam');
    expect((await ctx.api.post('/api/job-orders').set(H())
      .send({ product_item_id: product, qty_ordered: 1, team_id: 999999 })).status).toBe(400);
    expect((await ctx.api.post('/api/job-orders').set(H())
      .send({ product_item_id: product, qty_ordered: 1, due_date: '05/01/2020' })).status).toBe(400);
  });
});
