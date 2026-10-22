/** QuickBooks Online: OAuth connect (mocked), push order → Invoice / Bill, links, RBAC.
    NODE_ENV=test → every Intuit call is intercepted by src/quickbooks.ts's __qboMock. */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';

let ctx: TestContext;
let token: string;
let qbo: typeof import('../src/modules/quickbooks/quickbooks');
let dbmod: typeof import('../src/shared/db');
const authHdr = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  ctx = await setupApp();
  token = await login(ctx.api);
  qbo = await import('../src/modules/quickbooks/quickbooks');
  dbmod = await import('../src/shared/db');
});
afterAll(() => cleanup(ctx));

async function connect(): Promise<void> {
  const c = await ctx.api.get('/api/quickbooks/connect').set(authHdr());
  expect(c.status).toBe(200);
  expect(c.body.url).toContain('appcenter.intuit.com');
  const state = new URL(c.body.url).searchParams.get('state')!;
  const cb = await ctx.api.get(`/api/quickbooks/callback?code=abc&realmId=99999&state=${encodeURIComponent(state)}`);
  expect(cb.status).toBe(200);
  expect(cb.text).toMatch(/Connected to QuickBooks/i);
}

describe('status + OAuth', () => {
  it('requires users.manage', async () => {
    const wh = await createEmployee(ctx.api, token, { role: 'warehouse' });
    expect((await ctx.api.get('/api/quickbooks/status').set('Authorization', `Bearer ${wh.token}`)).status).toBe(403);
  });

  it('starts disconnected, connects via the callback, then disconnects', async () => {
    let s = await ctx.api.get('/api/quickbooks/status').set(authHdr());
    expect(s.body).toMatchObject({ configured: true, connected: false });

    await connect();

    s = await ctx.api.get('/api/quickbooks/status').set(authHdr());
    expect(s.body).toMatchObject({ connected: true, company_name: 'Test Co (QBO)', realm_id: '99999' });

    // A stale/replayed callback nonce is rejected.
    const stale = await ctx.api.get('/api/quickbooks/callback?code=x&realmId=1&state=default.deadbeef');
    expect(stale.status).toBe(400);

    await ctx.api.post('/api/quickbooks/disconnect').set(authHdr());
    s = await ctx.api.get('/api/quickbooks/status').set(authHdr());
    expect(s.body.connected).toBe(false);
  });
});

describe('push order', () => {
  beforeAll(async () => { await connect(); qbo.__qboMock.reset(); });

  it('pushes a sale order as an Invoice, and a re-push updates it', async () => {
    const o = await ctx.api.post('/api/orders').set(authHdr()).send({
      type: 'sale', status: 'approved', customer_name: 'Acme Corp',
      items: [{ name: 'Widget', quantity: 3, unit_price: 100 }],
    });
    const id = o.body.id;

    const p1 = await ctx.api.post(`/api/quickbooks/push/order/${id}`).set(authHdr());
    expect(p1.status).toBe(200);
    expect(p1.body).toMatchObject({ qbo_type: 'Invoice', updated: false });
    expect(p1.body.qbo_id).toBeTruthy();
    // it looked up / created a customer and posted an invoice
    const paths = qbo.__qboMock.calls.map((c) => c.path);
    expect(paths.some((p) => p.startsWith('customer'))).toBe(true);
    expect(paths.some((p) => p === 'invoice')).toBe(true);

    const p2 = await ctx.api.post(`/api/quickbooks/push/order/${id}`).set(authHdr());
    expect(p2.body.updated).toBe(true);
    const lastInvoiceCall = [...qbo.__qboMock.calls].reverse().find((c) => c.path === 'invoice')!;
    expect(lastInvoiceCall.body).toHaveProperty('Id');
    expect(lastInvoiceCall.body).toHaveProperty('SyncToken');

    const link = await ctx.api.get(`/api/quickbooks/order/${id}/link`).set(authHdr());
    expect(link.body.qbo_type).toBe('Invoice');
  });

  it('pushes a purchase request as a Bill (Vendor)', async () => {
    qbo.__qboMock.reset();
    const o = await ctx.api.post('/api/orders').set(authHdr()).send({
      type: 'purchase', status: 'approved', customer_name: 'Steel Supplier',
      items: [{ name: 'Steel Plate', quantity: 10, unit_price: 500 }],
    });
    const p = await ctx.api.post(`/api/quickbooks/push/order/${o.body.id}`).set(authHdr());
    expect(p.body.qbo_type).toBe('Bill');
    expect(qbo.__qboMock.calls.some((c) => c.path.startsWith('vendor'))).toBe(true);
    expect(qbo.__qboMock.calls.some((c) => c.path === 'bill')).toBe(true);
  });

  it('409s when not connected', async () => {
    await ctx.api.post('/api/quickbooks/disconnect').set(authHdr());
    const o = await ctx.api.post('/api/orders').set(authHdr())
      .send({ type: 'sale', status: 'approved', customer_name: 'X', items: [{ name: 'Item', quantity: 1, unit_price: 1 }] });
    expect(o.body.id).toBeTruthy();
    const p = await ctx.api.post(`/api/quickbooks/push/order/${o.body.id}`).set(authHdr());
    expect(p.status).toBe(409);
  });
});


describe('approved-document exports', () => {
  beforeAll(async () => { await connect(); });

  it('rejects draft exports before making any QuickBooks request, including direct helper calls', async () => {
    const sale = await ctx.api.post('/api/orders').set(authHdr()).send({type:'sale',items:[{name:'Draft service',quantity:1,unit_price:10}]});
    qbo.__qboMock.reset();
    const r = await ctx.api.post(`/api/quickbooks/push/order/${sale.body.id}`).set(authHdr());
    expect(r.status).toBe(409);
    const record = dbmod.queryOne<any>('SELECT * FROM orders WHERE id=?',sale.body.id)!;
    await expect(qbo.pushOrder(record,[])).rejects.toMatchObject({status:409});
    expect(qbo.__qboMock.calls).toEqual([]);
  });

  it('keeps preparation roles out of exports and lets existing approvers export their document type', async () => {
    const csr = await createEmployee(ctx.api,token,{role:'csr'}), buyer = await createEmployee(ctx.api,token,{role:'buyer'});
    const supervisor = await createEmployee(ctx.api,token,{role:'csr_supervisor'}), approver = await createEmployee(ctx.api,token,{role:'purchase_approver'});
    const sale = await ctx.api.post('/api/orders').set(authHdr()).send({type:'sale',status:'approved',items:[{name:'Approved service',quantity:1,unit_price:10}]});
    const po = await ctx.api.post('/api/orders').set(authHdr()).send({type:'purchase',status:'approved',items:[{name:'Approved material',quantity:1,unit_price:10}]});
    const H=(t:string)=>({Authorization:'Bearer '+t});
    qbo.__qboMock.reset();
    expect((await ctx.api.post(`/api/quickbooks/push/order/${sale.body.id}`).set(H(csr.token))).status).toBe(403);
    expect((await ctx.api.post(`/api/quickbooks/push/order/${po.body.id}`).set(H(buyer.token))).status).toBe(403);
    expect((await ctx.api.post(`/api/quickbooks/push/order/${po.body.id}`).set(H(supervisor.token))).status).toBe(403);
    expect((await ctx.api.post(`/api/quickbooks/push/order/${sale.body.id}`).set(H(approver.token))).status).toBe(403);
    expect(qbo.__qboMock.calls).toEqual([]);
    expect((await ctx.api.get('/api/quickbooks/status').set(H(approver.token))).body).toEqual({connected:true});
    expect((await ctx.api.get('/api/quickbooks/connect').set(H(approver.token))).status).toBe(403);
    expect((await ctx.api.post(`/api/quickbooks/push/order/${sale.body.id}`).set(H(supervisor.token))).body.qbo_type).toBe('Invoice');
    expect((await ctx.api.post(`/api/quickbooks/push/order/${po.body.id}`).set(H(approver.token))).body.qbo_type).toBe('Bill');
  });

  it('auto-push applies approval state and actor authority too', async () => {
    const supervisor = await createEmployee(ctx.api,token,{role:'csr_supervisor'}), buyer = await createEmployee(ctx.api,token,{role:'buyer'});
    const H=(t:string)=>({Authorization:'Bearer '+t});
    await ctx.api.put('/api/quickbooks/auto-push').set(authHdr()).send({enabled:true});
    try {
      qbo.__qboMock.reset();
      const draft=await ctx.api.post('/api/orders').set(H(supervisor.token)).send({type:'sale',items:[{name:'Auto draft',quantity:1,unit_price:10}]});expect(draft.status).toBe(201);
      const po=await ctx.api.post('/api/orders').set(H(buyer.token)).send({type:'purchase',status:'approved',items:[{name:'Buyer preparation',quantity:1,unit_price:10}]});expect(po.status).toBe(201);
      expect(qbo.__qboMock.calls).toEqual([]);
      expect((await ctx.api.post(`/api/orders/${draft.body.id}/status`).set(H(supervisor.token)).send({status:'approved'})).status).toBe(200);
      await vi.waitFor(()=>expect(qbo.__qboMock.calls.some(c=>c.path==='invoice')).toBe(true));
      expect(qbo.__qboMock.calls.some(c=>c.path==='bill')).toBe(false);
    } finally { await ctx.api.put('/api/quickbooks/auto-push').set(authHdr()).send({enabled:false}); }
  });
});
