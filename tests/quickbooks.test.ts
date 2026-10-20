/** QuickBooks Online: OAuth connect (mocked), push order → Invoice / Bill, links, RBAC.
    NODE_ENV=test → every Intuit call is intercepted by src/quickbooks.ts's __qboMock. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
  it('requires administration or order-export permission', async () => {
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
      type: 'sale', customer_name: 'Acme Corp',
      items: [{ name: 'Widget', quantity: 3, unit_price: 100 }],
    });
    const id = o.body.id;

    const p1 = await ctx.api.post(`/api/quickbooks/push/order/${id}`).set(authHdr()).send({connection_id:dbmod.getSetting('qbo_connection_id'),order_stamp:(await ctx.api.get(`/api/quickbooks/order/${id}/preview`).set(authHdr())).body.order_stamp});
    expect(p1.status).toBe(200);
    expect(p1.body).toMatchObject({ qbo_type: 'Invoice', updated: false });
    expect(p1.body.qbo_id).toBeTruthy();
    // it looked up / created a customer and posted an invoice
    const paths = qbo.__qboMock.calls.map((c) => c.path);
    expect(paths.some((p) => p.startsWith('customer'))).toBe(true);
    expect(paths.some((p) => p === 'invoice')).toBe(true);

    const p2 = await ctx.api.post(`/api/quickbooks/push/order/${id}`).set(authHdr()).send({connection_id:dbmod.getSetting('qbo_connection_id'),order_stamp:(await ctx.api.get(`/api/quickbooks/order/${id}/preview`).set(authHdr())).body.order_stamp});
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
      type: 'purchase', customer_name: 'Steel Supplier',
      items: [{ name: 'Steel Plate', quantity: 10, unit_price: 500 }],
    });
    const p = await ctx.api.post(`/api/quickbooks/push/order/${o.body.id}`).set(authHdr()).send({connection_id:dbmod.getSetting('qbo_connection_id'),order_stamp:(await ctx.api.get(`/api/quickbooks/order/${o.body.id}/preview`).set(authHdr())).body.order_stamp});
    expect(p.body.qbo_type).toBe('Bill');
    expect(qbo.__qboMock.calls.some((c) => c.path.startsWith('vendor'))).toBe(true);
    expect(qbo.__qboMock.calls.some((c) => c.path === 'bill')).toBe(true);
  });

  it('409s when not connected', async () => {
    await ctx.api.post('/api/quickbooks/disconnect').set(authHdr());
    const o = await ctx.api.post('/api/orders').set(authHdr())
      .send({ type: 'sale', customer_name: 'X', items: [{ name: 'Item', quantity: 1, unit_price: 1 }] });
    expect(o.body.id).toBeTruthy();
    const p = await ctx.api.post(`/api/quickbooks/push/order/${o.body.id}`).set(authHdr()).send({connection_id:dbmod.getSetting('qbo_connection_id'),order_stamp:'0'.repeat(64)});
    expect(p.status).toBe(409);
  });
});

it('rejects callback HTML injection and unknown workspace state without creating a database', async () => {
  const payload = '<img src=x onerror=alert(1)>';
  const error = await ctx.api.get('/api/quickbooks/callback').query({ error: payload });
  expect(error.status).toBe(400);
  expect(error.text).not.toContain(payload);
  const bad = await ctx.api.get('/api/quickbooks/callback').query({ state: 'never-created.' + 'a'.repeat(32), code: 'x', realmId: '1' });
  expect(bad.status).toBe(400);
  const fs = await import('node:fs');
  const path = await import('node:path');
  expect(fs.existsSync(path.join(process.env.DATA_DIR!, 'never-created.db'))).toBe(false);
});

it('rejects a pending callback after the initiating session is revoked',async()=>{
  const start=await ctx.api.get('/api/quickbooks/connect').set(authHdr());expect(start.status).toBe(200);
  const state=new URL(start.body.url).searchParams.get('state')!;
  const auth=await import('../src/shared/auth');auth.destroySession(token);
  const response=await ctx.api.get('/api/quickbooks/callback').query({code:'abc',realmId:'99999',state});
  expect(response.status).toBe(400);expect(qbo.getQboStatus().connected).toBe(false);
  token=await login(ctx.api);
});

it('disconnect cancels pending authorization and a newer connect supersedes old state',async()=>{
  const first=await ctx.api.get('/api/quickbooks/connect').set(authHdr());
  const second=await ctx.api.get('/api/quickbooks/connect').set(authHdr());
  const state1=new URL(first.body.url).searchParams.get('state')!;
  const state2=new URL(second.body.url).searchParams.get('state')!;
  expect((await ctx.api.get('/api/quickbooks/callback').query({code:'abc',realmId:'1',state:state1})).status).toBe(400);
  expect(dbmod.getSetting<{nonce:string}>('qbo_oauth_state')!.nonce).toBe(state2.split('.')[1]);
  expect((await ctx.api.post('/api/quickbooks/disconnect').set(authHdr())).status).toBe(200);
  expect((await ctx.api.get('/api/quickbooks/callback').query({code:'abc',realmId:'1',state:state2})).status).toBe(400);
  expect(qbo.getQboStatus().connected).toBe(false);
});

it('does not save exchanged credentials after authorization changes during the await',async()=>{
  let allowed=true;
  const pending=qbo.completeConnect('abc','99999',()=>allowed);allowed=false;
  await expect(pending).rejects.toMatchObject({status:403});
  expect(qbo.getQboStatus().connected).toBe(false);
});

it('rejects a pending connection after the initiating account permissions change',async()=>{
  const start=await ctx.api.get('/api/quickbooks/connect').set(authHdr());expect(start.status).toBe(200);
  const state=new URL(start.body.url).searchParams.get('state')!;
  const original=dbmod.queryOne<{permission_overrides:string}>('SELECT permission_overrides FROM users WHERE id=1')!.permission_overrides;
  try {
    dbmod.run('UPDATE users SET permission_overrides=? WHERE id=1',JSON.stringify({'inventory.view':false}));
    expect((await ctx.api.get('/api/quickbooks/callback').query({code:'abc',realmId:'99999',state})).status).toBe(400);
    expect(qbo.getQboStatus().connected).toBe(false);
  } finally {dbmod.run('UPDATE users SET permission_overrides=? WHERE id=1',original);}
});
