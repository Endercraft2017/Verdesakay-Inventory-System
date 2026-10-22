/** New supply links and repeat protection must survive site command replay/rebase. */
import { beforeAll, afterAll, expect, it } from 'vitest';
import { setupSiteTrio, type SiteTrio } from './sync-helpers';
import { cleanup } from './helpers';
let T: SiteTrio, bay: number, product: number, part: number;
async function ok(p: Promise<import('supertest').Response>, status = 200) {
  const r = await p; expect(r.status, JSON.stringify(r.body)).toBe(status); return r;
}
beforeAll(async () => {
  T = await setupSiteTrio(async ({ api, cloudHdr }) => {
    const h = cloudHdr();
    bay = (await ok(api.post('/api/locations').set(h).send({ name: 'Supply site', type: 'warehouse' }), 201)).body.id;
    product = (await ok(api.post('/api/inventory').set(h).send({ name: 'Site built product' }), 201)).body.id;
    part = (await ok(api.post('/api/inventory').set(h).send({ name: 'Site purchased part' }), 201)).body.id;
    await ok(api.put(`/api/finished-products/${product}`).set(h).send({ components: [{ component_item_id: part, quantity: 2 }] }));
    const seed = (await ok(api.post('/api/orders').set(h).send({ type: 'sale', location_id: bay, items: [{ item_id: product, name: 'Site built product', quantity: 1 }] }), 201)).body.id;
    await ok(api.post(`/api/orders/${seed}/produce-shortfall`).set(h).send({}));
    await ok(api.post(`/api/orders/${seed}/purchase-shortfall`).set(h).send({})); // starts MO and PR series for leases
  });
  await ok(T.ctx.api.put('/api/sync/sites').set(T.cloudHdr()).send({ locations: [{ location_id: bay, host_node_no: T.hostNo }] }));
  await T.hostRound(); await T.lanRound();
});
afterAll(() => { T.close(); cleanup(T.ctx); });
it('keeps one production draft and one linked purchase across an outage, retries and cloud replay', async () => {
  T.cutOff('host');
  const api = T.ctx.api, h = T.hostHdr();
  const id = (await ok(api.post('/api/orders').set(h).send({ type: 'sale', location_id: bay, items: [{ item_id: product, name: 'Site built product', quantity: 3 }] }), 201)).body.id;
  const review = (await ok(api.get(`/api/orders/${id}/availability`).set(h))).body;
  const production = (await ok(api.post(`/api/orders/${id}/produce-shortfall`).set(h).send({ expected_revision: review.revision }))).body;
  const purchases = (await ok(api.post(`/api/orders/${id}/purchase-shortfall`).set(h).send({ expected_revision: review.revision }))).body;
  expect(production.created).toHaveLength(1); expect(purchases.created).toHaveLength(1);
  expect((await ok(api.post(`/api/orders/${id}/produce-shortfall`).set(h).send({}))).body.created).toEqual([]);
  expect((await ok(api.post(`/api/orders/${id}/purchase-shortfall`).set(h).send({}))).body.created).toEqual([]);
  T.reconnect('host');
  const round = await T.hostRound(); expect(round.pushed.filter((p) => p.state !== 'confirmed')).toEqual([]);
  await T.lanRound();
  const po = purchases.created[0]; const jo = production.created[0];
  for (const conn of [T.hostDb(), T.cloudDb(), T.lanDb()]) {
    expect(conn.prepare('SELECT purchase_order_id FROM sale_shortfall_purchases WHERE source_order_id = ?').all(id)).toEqual([{ purchase_order_id: po.id }]);
    expect(conn.prepare('SELECT id, number FROM job_orders WHERE order_id = ?').all(id)).toEqual([{ id: jo.job_order_id, number: expect.stringMatching(/^MO-\d{5}$/) }]);
  }
  const final = (await ok(api.get(`/api/orders/${id}/availability`).set(T.cloudHdr()))).body;
  expect(final.purchase_requirements[0]).toMatchObject({ shortage: 6, pending_purchase: 6, to_purchase: 0 });
  expect(final.lines[0].shortfall).toBe(3); // Planned supply isn't stock at any node.
});
