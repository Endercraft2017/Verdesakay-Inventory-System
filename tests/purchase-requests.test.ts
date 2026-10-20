import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';

let ctx: TestContext;
let admin: string;
let requester: { id: number; token: string };
let buyer: { id: number; token: string };
let supplierManager: { id: number; token: string };
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  ctx = await setupApp();
  admin = await login(ctx.api);
  requester = await createEmployee(ctx.api, admin, { username: 'pr_employee_a', role: 'hr' });
  buyer = await createEmployee(ctx.api, admin, { username: 'pr_employee_b', role: 'hr' });
  supplierManager = await createEmployee(ctx.api, admin, { username: 'pr_csr', role: 'csr' });
});
afterAll(() => cleanup(ctx));

describe('budgeted internal purchase requests', () => {
  it('limits PR authority to designated roles independently of supplier purchasing', async () => {
    const { roleDefaults } = await import('../src/shared/permissions');
    expect(roleDefaults('admin_staff')).toContain('purchasing.approve_requests');
    expect(roleDefaults('accounting')).toContain('purchasing.approve_requests');
    expect(roleDefaults('csr')).toContain('purchasing.manage');
    expect(roleDefaults('csr')).not.toContain('purchasing.approve_requests');
    expect(roleDefaults('releasing')).not.toContain('purchasing.approve_requests');
  });

  it('approves a cash request, records receipts and change, and closes only after liquidation review', async () => {
    const made = await ctx.api.post('/api/purchasing/requests').set(auth(requester.token)).send({
      reason: 'Need tools and cleaning supplies for the workshop',
      items: [{ name: 'Wrench', quantity: 2, estimated_unit_price: 250 }, { name: 'Cleaning solution', quantity: 1, estimated_unit_price: 300 }],
    });
    expect(made.status).toBe(201);
    expect(made.body.requested_budget).toBe(800);
    const id = made.body.id;
    expect((await ctx.api.get('/api/purchasing/requests/' + id).set(auth(buyer.token))).status).toBe(404);
    expect((await ctx.api.get('/api/purchasing/requests/' + id).set(auth(supplierManager.token))).status).toBe(404);
    expect((await ctx.api.post(`/api/purchasing/requests/${id}/approve`).set(auth(supplierManager.token)).send({ approved_budget: 800, purchase_mode: 'requester_cash' })).status).toBe(403);
    expect((await ctx.api.post(`/api/purchasing/requests/${id}/approve`).set(auth(requester.token)).send({ approved_budget: 800, purchase_mode: 'requester_cash' })).status).toBe(403);
    expect((await ctx.api.post(`/api/purchasing/requests/${id}/liquidation`).set(auth(requester.token)).send({ items: [{ name: 'Wrench', quantity: 1, actual_unit_price: 100 }] })).status).toBe(403);
    const approved = await ctx.api.post(`/api/purchasing/requests/${id}/approve`).set(auth(admin)).send({ approved_budget: 800, purchase_mode: 'requester_cash' });
    expect(approved.status).toBe(200);
    expect((await ctx.api.post(`/api/purchasing/requests/${id}/close`).set(auth(admin)).send({})).status).toBe(409);
    expect((await ctx.api.post(`/api/purchasing/requests/${id}/issue-cash`).set(auth(admin)).send({ amount: 900 })).status).toBe(400);
    expect((await ctx.api.post(`/api/purchasing/requests/${id}/receipts`).set(auth(admin)).attach('file', Buffer.from('%PDF-1.4'), { filename: 'manager.pdf', contentType: 'application/pdf' })).status).toBe(403);
    const cashKey = 'pr-cash-test-0001';
    expect((await ctx.api.post(`/api/purchasing/requests/${id}/issue-cash`).set(auth(admin)).set('Idempotency-Key', cashKey).send({ amount: 800 })).status).toBe(200);
    expect((await ctx.api.post(`/api/purchasing/requests/${id}/issue-cash`).set(auth(admin)).set('Idempotency-Key', cashKey).send({ amount: 800 })).status).toBe(200);
    const actual = [{ name: 'Wrench', quantity: 2, actual_unit_price: 200 }, { name: 'Additional screws', quantity: 2, actual_unit_price: 50 }];
    expect((await ctx.api.post(`/api/purchasing/requests/${id}/liquidation`).set(auth(requester.token)).send({ items: actual })).status).toBe(400);
    const file = await ctx.api.post(`/api/purchasing/requests/${id}/receipts`).set(auth(requester.token)).set('Idempotency-Key', 'pr-file-test-0001')
      .attach('file', Buffer.from('%PDF-1.4\nreceipt'), { filename: 'shop-receipt.pdf', contentType: 'application/pdf' });
    expect(file.status).toBe(201);
    const fileRetry = await ctx.api.post(`/api/purchasing/requests/${id}/receipts`).set(auth(requester.token)).set('Idempotency-Key', 'pr-file-test-0001')
      .attach('file', Buffer.from('%PDF-1.4\nreceipt'), { filename: 'shop-receipt.pdf', contentType: 'application/pdf' });
    expect(fileRetry.body.id).toBe(file.body.id);
    expect((await ctx.api.get(`/api/purchasing/requests/${id}`).set(auth(requester.token))).body.receipts).toHaveLength(1);
    expect((await ctx.api.get(`/api/purchasing/requests/${id}/receipts/${file.body.id}`).set(auth(buyer.token))).status).toBe(404);
    expect((await ctx.api.post(`/api/purchasing/requests/${id}/liquidation`).set(auth(requester.token)).send({ items: [{ name: 'Over budget', quantity: 1, actual_unit_price: 801 }] })).status).toBe(400);
    const submitted = await ctx.api.post(`/api/purchasing/requests/${id}/liquidation`).set(auth(requester.token)).send({ items: actual });
    expect(submitted.status).toBe(200);
    expect(submitted.body.actual_total).toBe(500);
    expect((await ctx.api.post(`/api/purchasing/requests/${id}/close`).set(auth(admin)).send({ cash_returned: 0 })).status).toBe(400);
    expect((await ctx.api.post(`/api/purchasing/requests/${id}/close`).set(auth(requester.token)).send({ cash_returned: 300 })).status).toBe(403);
    expect((await ctx.api.post(`/api/purchasing/requests/${id}/close`).set(auth(admin)).send({ cash_returned: 300 })).status).toBe(200);
    const final = await ctx.api.get(`/api/purchasing/requests/${id}`).set(auth(requester.token));
    expect(final.body.status).toBe('closed');
    expect(final.body.cash_returned).toBe(300);
    expect(final.body.purchases.map((x: { name: string }) => x.name)).toContain('Additional screws');
    expect((await ctx.api.post(`/api/purchasing/requests/${id}/liquidation`).set(auth(requester.token)).send({ items: actual })).status).toBe(409);
  });

  it('assigns another buyer and returns a liquidation for correction', async () => {
    const made = await ctx.api.post('/api/purchasing/requests').set(auth(requester.token)).send({
      reason: 'New office chair', items: [{ name: 'Office chair', quantity: 1, estimated_unit_price: 3000 }],
    });
    const id = made.body.id;
    expect((await ctx.api.post(`/api/purchasing/requests/${id}/approve`).set(auth(admin)).send({ approved_budget: 3200, purchase_mode: 'assigned_buyer', buyer_id: buyer.id })).status).toBe(200);
    expect((await ctx.api.post(`/api/purchasing/requests/${id}/issue-cash`).set(auth(admin)).send({ amount: 3000 })).status).toBe(409);
    expect((await ctx.api.post(`/api/purchasing/requests/${id}/receipts`).set(auth(requester.token)).attach('file', Buffer.from('%PDF-1.4'), { filename: 'wrong.pdf', contentType: 'application/pdf' })).status).toBe(403);
    const receipt = await ctx.api.post(`/api/purchasing/requests/${id}/receipts`).set(auth(buyer.token)).attach('file', Buffer.from('%PDF-1.4'), { filename: 'chair.pdf', contentType: 'application/pdf' });
    expect(receipt.status).toBe(201);
    expect((await ctx.api.post(`/api/purchasing/requests/${id}/liquidation`).set(auth(buyer.token)).send({ items: [{ name: 'Office chair', quantity: 1, actual_unit_price: 2800 }] })).status).toBe(200);
    expect((await ctx.api.post(`/api/purchasing/requests/${id}/return-liquidation`).set(auth(admin)).send({ note: 'Upload the second receipt' })).status).toBe(200);
    expect((await ctx.api.post(`/api/purchasing/requests/${id}/liquidation`).set(auth(buyer.token)).send({ items: [{ name: 'Office chair', quantity: 1, actual_unit_price: 2800 }] })).status).toBe(200);
    expect((await ctx.api.post(`/api/purchasing/requests/${id}/close`).set(auth(admin)).send({})).status).toBe(200);
  });
});
