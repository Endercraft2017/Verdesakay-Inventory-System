/** Suppliers registry: CRUD, search, item_count, RBAC, and FK-set-null on delete. */
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

async function createSupplier(body: Record<string, unknown>) {
  return ctx.api.post('/api/suppliers').set(authHdr()).send(body);
}

describe('suppliers', () => {
  it('creates, lists, and reads back a supplier', async () => {
    const res = await createSupplier({
      name: 'Acme Trading', contact_person: 'Jo Cruz', phone: '0917-000-1111', email: 'jo@acme.test',
      address: '12 Market St', notes: 'Net 30',
    });
    expect(res.status).toBe(201);
    const id = res.body.id;

    const list = await ctx.api.get('/api/suppliers').set(authHdr());
    const found = list.body.find((s: { id: number }) => s.id === id);
    expect(found.name).toBe('Acme Trading');
    expect(found.item_count).toBe(0);

    const detail = await ctx.api.get(`/api/suppliers/${id}`).set(authHdr());
    expect(detail.body.email).toBe('jo@acme.test');
    expect(detail.body.items).toEqual([]);
  });

  it('requires a name', async () => {
    const res = await createSupplier({ contact_person: 'No Name' });
    expect(res.status).toBe(400);
  });

  it('searches by name / contact / email', async () => {
    await createSupplier({ name: 'Bright Bulbs Inc', email: 'sales@brightbulbs.test' });
    const byName = await ctx.api.get('/api/suppliers?q=bright').set(authHdr());
    expect(byName.body.some((s: { name: string }) => s.name === 'Bright Bulbs Inc')).toBe(true);
    const byEmail = await ctx.api.get('/api/suppliers?q=brightbulbs.test').set(authHdr());
    expect(byEmail.body.some((s: { name: string }) => s.name === 'Bright Bulbs Inc')).toBe(true);
  });

  it('updates a supplier', async () => {
    const { body } = await createSupplier({ name: 'Old Co', phone: '111' });
    const upd = await ctx.api.put(`/api/suppliers/${body.id}`).set(authHdr()).send({ name: 'New Co', phone: '222' });
    expect(upd.status).toBe(200);
    const detail = await ctx.api.get(`/api/suppliers/${body.id}`).set(authHdr());
    expect(detail.body.name).toBe('New Co');
    expect(detail.body.phone).toBe('222');
  });

  it('counts linked items and lists them, and clears the link when the supplier is deleted', async () => {
    const sup = await createSupplier({ name: 'Linked Supplier' });
    const item = await ctx.api.post('/api/inventory').set(authHdr())
      .send({ name: 'Linked Item', quantity: 5, supplier_id: sup.body.id });
    expect(item.status).toBe(201);

    const detail = await ctx.api.get(`/api/suppliers/${sup.body.id}`).set(authHdr());
    expect(detail.body.item_count).toBe(1);
    expect(detail.body.items[0].name).toBe('Linked Item');

    const del = await ctx.api.delete(`/api/suppliers/${sup.body.id}`).set(authHdr());
    expect(del.status).toBe(200);

    const after = await ctx.api.get(`/api/inventory/${item.body.id}`).set(authHdr());
    expect(after.status).toBe(200);
    expect(after.body.supplier_id).toBeNull();
  });

  it('404s on missing supplier', async () => {
    expect((await ctx.api.get('/api/suppliers/999999').set(authHdr())).status).toBe(404);
    expect((await ctx.api.put('/api/suppliers/999999').set(authHdr()).send({ name: 'x' })).status).toBe(404);
    expect((await ctx.api.delete('/api/suppliers/999999').set(authHdr())).status).toBe(404);
  });

  it('blocks a role without inventory write permission from creating', async () => {
    // 'hr' role has no inventory.* permissions
    const hr = await createEmployee(ctx.api, token, { role: 'hr', username: 'sup_hr_user' });
    const res = await ctx.api.post('/api/suppliers').set('Authorization', `Bearer ${hr.token}`).send({ name: 'Nope' });
    expect(res.status).toBe(403);
  });
});
