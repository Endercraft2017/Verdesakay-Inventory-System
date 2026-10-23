/** Preserve authority-only case decisions when integrating the offline-first branch. */
import {it,expect} from 'vitest';
import {setupSyncPair} from './sync-helpers';
import {cleanup} from './helpers';

it('replicates customer history for reading, and refuses offline case changes and case-driven sales',async()=>{
  const pair=await setupSyncPair('csr-sync',21);
  try {
    const api=pair.ctx.api,cloud=pair.cloudHdr();
    const customer=await api.post('/api/customers').set(cloud).send({name:'Synthetic sync customer'});
    expect(customer.status).toBe(201);
    const body={customer_id:customer.body.id,kind:'inquiry',summary:'Synthetic sync inquiry',status:'open',owner_id:1,
      next_action:'Confirm availability',due_at:'2026-10-23T01:00:00Z',sale_order_id:null,resolution:null,request_key:crypto.randomUUID()};
    const created=await api.post('/api/customer-cases').set(cloud).send(body);expect(created.status).toBe(201);
    await pair.enrol();
    const node=pair.nodeHdr();
    expect((await api.get(`/api/customers/${customer.body.id}/history`).set(node)).body.some((e:{kind:string})=>e.kind==='case')).toBe(true);
    const read=await api.get('/api/customer-cases/'+created.body.id).set(node);expect(read.status).toBe(200);
    expect((await api.post('/api/customer-cases').set(node).send({...body,request_key:crypto.randomUUID()})).status).toBe(503);
    expect((await api.put('/api/customer-cases/'+created.body.id).set(node).send({...read.body,summary:'Offline overwrite'})).status).toBe(503);
    const sale=await api.post('/api/orders').set(node).send({type:'sale',case_id:created.body.id,case_version:1,customer_id:customer.body.id,
      status:'open',items:[{name:'Synthetic service',quantity:1,unit_price:100}]});
    expect(sale.status).toBe(503);
    expect(pair.nodeDb().prepare('SELECT count(*) AS n FROM orders').get()!.n).toBe(0);
    expect(pair.nodeDb().prepare('SELECT version FROM customer_cases WHERE id=?').get(created.body.id)!.version).toBe(1);
  } finally {cleanup(pair.ctx);}
},30000);
