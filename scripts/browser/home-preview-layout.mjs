// Real records + controlled fixture dates. Only presentation-failure/empty cases mock queue reads.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {expect} from 'playwright/test';
import AxeBuilder from '@axe-core/playwright';

export async function runHomePreviewLayout(env) {
  const {api,sql,open,check,users,jo,units,repair,kit,bulk,batch,location,part,makeJob,mismatch,dbFile,out,report,databaseSnapshot}=env;
  function dates(statements) {
    const seed=new DatabaseSync(dbFile);
    try { seed.exec('BEGIN'); for(const [query,...values] of statements)seed.prepare(query).run(...values);seed.exec('COMMIT'); }
    finally { seed.close(); }
  }
  // Intentionally make modification dates newer and priorities disagree with oldest-first ordering.
  dates([
    ['UPDATE job_orders SET approved_at=?,created_at=?,updated_at=? WHERE id=?','2026-01-03 01:00:00','2025-12-01 01:00:00','2026-10-25 01:00:00',kit.id],
    ['UPDATE repair_part_requests SET created_at=?,updated_at=? WHERE id=?','2026-01-01 01:00:00','2026-10-25 01:00:00',repair.id],
    ['UPDATE job_order_units SET created_at=?,updated_at=? WHERE id=?','2026-01-04 01:00:00','2026-10-25 01:00:00',units[0].id],
    ["UPDATE qc_records SET created_at=? WHERE unit_id=? AND result='fail'",'2026-01-06 01:00:00',units[1].id],
    ["UPDATE qc_records SET created_at=? WHERE unit_id=? AND result='hold'",'2026-01-07 01:00:00',units[4].id],
    ["UPDATE qc_records SET created_at=? WHERE unit_id=? AND result='pass'",'2026-01-02 01:00:00',units[2].id],
    ['UPDATE production_batches SET created_at=?,updated_at=? WHERE id=?','2026-01-05 01:00:00','2026-10-25 01:00:00',batch.id],
    ['UPDATE production_issues SET created_at=? WHERE id=?','2026-01-08 01:00:00',mismatch.id],
  ]);
  const group=(page,key)=>page.locator('[data-home-work="'+key+'"]');
  async function ready(page) { await page.waitForFunction(()=>document.querySelectorAll('[data-home-work-count]').length && [...document.querySelectorAll('[data-home-work-count]')].every(e=>!e.textContent.includes('Loading'))); }
  const order=page=>page.locator('[data-home-work]').evaluateAll(es=>es.map(e=>e.dataset.homeWork));
  const expanded=(page,key)=>group(page,key).locator('.v2-home-work-desk').evaluate(el=>el.open);
  async function refresh(page) { await page.locator('[data-home-work-refresh]').click();await ready(page); }
  const stock=()=>sql('SELECT item_id,location_id,quantity FROM inventory_stock ORDER BY item_id,location_id');
  report.oracles.push({fixtureDates:sql('SELECT id,created_at,updated_at FROM repair_part_requests WHERE id=?',repair.id),expectedInitialOrder:['parts','rts','kits','qc','qa','holds'],rtsBatchDate:sql('SELECT created_at FROM production_batches WHERE id=?',batch.id)[0]});

  await check('Active categories and their previews use the oldest outstanding record, independent of modified dates',async()=>{
    const before=databaseSnapshot(),{page}=await open(users.all);await ready(page);
    assert.deepEqual(await order(page),['parts','rts','kits','qc','qa','holds']);
    assert.equal(await page.locator('[data-home-work] .v2-home-work-desk:not([hidden])').count(),6);
    assert.deepEqual(await page.locator('[data-home-work] .v2-home-work-desk').evaluateAll(es=>es.map(e=>e.open)),Array(6).fill(true));assert(await page.locator('[data-home-work]').evaluateAll(es=>es.every(e=>e.querySelectorAll('[data-attention]').length<=1)));
    assert.match(await group(page,'parts').locator('[data-home-work-age]').innerText(),/Jan 1.*2026/);
    const expectedLocal=await page.evaluate(()=>new Date('2026-01-01T01:00:00Z').toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit',year:'numeric'}));
    assert((await group(page,'parts').innerText()).includes(expectedLocal));
    assert((await group(page,'rts').locator('[data-attention]').first().innerText()).includes('AUDIT-UNIT-2'));
    assert.equal((await api('GET','/rts/queue',undefined,users.rts.token)).batches.find(b=>b.id===batch.id).created_at,'2026-01-05 01:00:00');
    assert.deepEqual(databaseSnapshot(),before);await page.screenshot({path:out+'/oldest-first-active.png',fullPage:true});
  });
  await check('Manual keyboard collapse survives an unchanged refresh; a changed kit reopens automatically',async()=>{
    const {page}=await open(users.all);await ready(page);const summary=group(page,'kits').locator('summary');
    await summary.focus();await summary.press('Enter');await expect(group(page,'kits').locator('details')).not.toHaveAttribute('open','');
    await refresh(page);assert.equal(await expanded(page,'kits'),false);
    await api('POST','/job-orders/warehouse-accept',{job_order_ids:[kit.id]});await refresh(page);
    assert.equal(await expanded(page,'kits'),true);assert((await group(page,'kits').innerText()).includes('Kit preparation'));
    assert.deepEqual(await order(page),['parts','rts','kits','qc','qa','holds']);
  });
  await check('Another employee finishes the oldest request; automatic refresh collapses it and advances the next category',async()=>{
    const {page}=await open(users.all);await ready(page);await group(page,'qc').locator('summary').focus();
    const before=stock(),other=await api('POST','/users',{username:'home_layout_other',full_name:'Other parts clerk',password:'fixture-password',role:'parts_clerk'});
    const token=(await api('POST','/auth/login',{username:'home_layout_other',password:'fixture-password'},'')).token;
    await page.clock.install();await page.reload();await ready(page);await group(page,'qc').locator('summary').focus();await api('POST','/production/repairs/'+repair.id+'/reject',{warehouse_remarks:'Resolved by other employee'},token);
    await page.clock.fastForward(30100);await expect(group(page,'parts').locator('[data-home-work-count]')).toHaveText('0 requests');await ready(page);
    assert.equal((await order(page))[0],'rts');assert.equal((await order(page)).at(-1),'parts');assert.equal(await expanded(page,'parts'),false);
    assert.equal(await group(page,'parts').locator('[data-home-work-count]').textContent(),'0 requests');
    assert.equal(sql('SELECT decided_by FROM repair_part_requests WHERE id=?',repair.id)[0].decided_by,other.id);
    assert.equal(await page.evaluate(()=>document.activeElement.closest('[data-home-work]')?.dataset.homeWork),'qc');
    assert.deepEqual(stock(),before);await page.screenshot({path:out+'/oldest-completed-next-first.png',fullPage:true});
  });
  await check('Partial batch receipt preserves age; receiving the oldest serial advances other categories and holds stay visible',async()=>{
    const {page}=await open(users.all);await ready(page);
    await api('POST','/job-orders/'+bulk.id+'/products-in',{batch_id:batch.id,quantity:2,location_id:location});await refresh(page);
    assert.equal(await group(page,'rts').locator('[data-home-work-count]').innerText(),'1 unit · 1 batch (5 pcs)');
    assert.equal((await order(page))[0],'rts');assert.equal(sql('SELECT created_at FROM production_batches WHERE id=?',batch.id)[0].created_at,'2026-01-05 01:00:00');
    await api('POST','/job-orders/'+jo.id+'/products-in',{unit_ids:[units[2].id],location_id:location});await refresh(page);
    assert.deepEqual(await order(page),['kits','qc','qa','rts','holds','parts']);
    assert((await group(page,'rts').locator('[data-attention]').first().innerText()).includes(batch.number));
    await api('POST','/job-orders/'+bulk.id+'/products-in',{batch_id:batch.id,quantity:5,location_id:location});await refresh(page);
    assert.deepEqual(await order(page),['kits','qc','qa','holds','rts','parts']);assert.equal(await expanded(page,'rts'),true);
    assert.match(await group(page,'rts').locator('summary').innerText(),/1 on hold/);
    await group(page,'rts').getByRole('button',{name:'1 unit on hold · View RTS issues',exact:true}).click();await page.waitForURL(u=>u.hash.includes('tab=issues'));
  });
  await check('One compact all-clear summary retains direct access to every authorized clear queue',async()=>{
    if(sql('SELECT status FROM repair_part_requests WHERE id=?',repair.id)[0].status==='requested')await api('POST','/production/repairs/'+repair.id+'/reject',{warehouse_remarks:'Empty disclosure fixture'});
    const {page:empty}=await open(users.parts);await ready(empty);
    await expect(empty.locator('[data-home-work-empty]')).toBeVisible();await expect(empty.locator('[data-home-work-other-label]')).toHaveText('View all 1 queue');
    await empty.locator('[data-home-work-other]>summary').press('Enter');await expect(group(empty,'parts').locator('[data-home-work-clear]')).toBeVisible();
    await group(empty,'parts').locator('[data-home-work-clear]').click();await empty.waitForURL(u=>u.hash.split('?')[0]==='#/repairs');
    const {page}=await open(users.all,'home',async c=>{
      await c.route('**/api/job-orders?stage=awaiting_release',r=>r.fulfill({json:[]}));await c.route('**/api/production/repairs?status=requested',r=>r.fulfill({json:[]}));
      await c.route('**/api/qc/queue?role=*',r=>r.fulfill({json:{units:[]}}));await c.route('**/api/qc/holds',r=>r.fulfill({json:[]}));await c.route('**/api/rts/queue',r=>r.fulfill({json:{units:[],batches:[]}}));
    });await ready(page);
    await expect(page.locator('[data-home-work-empty]')).toBeVisible();await expect(page.locator('[data-home-work-checked]')).toHaveText('All 6 queues checked');
    assert.equal(await page.locator('[data-home-work-list] [data-home-work]').count(),0);assert.equal(await page.locator('[data-home-work-other]').evaluate(e=>e.open),false);
    const compact=await page.locator('.v2-home-work').evaluate(el=>el.getBoundingClientRect().height);
    await page.locator('[data-home-work-other]>summary').press('Enter');assert.equal(await page.locator('[data-home-work-clear]:visible').count(),6);
    const full=await page.locator('.v2-home-work').evaluate(el=>el.getBoundingClientRect().height);
    report.oracles.push({layoutFixture:'Mocked empty queue reads; no stock writes',previousCollapsedHeight:421,compactHeight:compact,expandedHeight:full});assert(compact<200);assert(compact<full*.5);
    for(const theme of ['light','dark']){
      await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
      for(const size of [{width:390,height:844},{width:375,height:667},{width:844,height:390}]){await page.setViewportSize(size);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert(await group(page,'kits').locator('[data-home-work-clear]').evaluate(el=>el.getBoundingClientRect().height>=44));}
      await page.setViewportSize({width:390,height:844});
      const a11y=await new AxeBuilder({page}).include('.v2-home-work').withRules(['color-contrast','button-name','aria-valid-attr-value','summary-name']).analyze();fs.writeFileSync(out+'/disclosures-a11y-'+theme+'.json',JSON.stringify(a11y,null,2));assert.deepEqual(a11y.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})),[]);
      await page.locator('[data-home-work-other]>summary').click();await page.screenshot({path:out+'/compact-empty-'+theme+'.png',fullPage:true});await page.locator('[data-home-work-other]>summary').click();
    }
    await page.emulateMedia({reducedMotion:'reduce'});await page.locator('[data-home-work-other]>summary').press('Space');assert.equal(await page.locator('[data-home-work-other]').evaluate(e=>e.open),false);
  });
  await check('Failed and delayed categories cannot hide work or appear as empty categories',async()=>{
    let release;const held=new Promise(r=>release=r);
    const {page}=await open(users.all,'home',async c=>{
      await c.route('**/api/qc/queue?role=qc',async r=>{await held;await r.fulfill({status:503,json:{error:'Slow failed queue'}}).catch(()=>{});});
      await c.route('**/api/qc/queue?role=qa',r=>r.fulfill({status:503,json:{error:'Unavailable'}}));
    });
    try{
      await expect(group(page,'rts').locator('[data-home-work-count]')).toHaveText('0 units');
      await expect(group(page,'qa').locator('[data-home-work-count]')).toHaveText('Unknown');assert.equal(await expanded(page,'qa'),true);
      assert.equal(await group(page,'qc').locator('[data-home-work-count]').innerText(),'Loading…');
      release();await ready(page);const rows=await order(page);assert(rows.indexOf('qa')<rows.indexOf('parts'));assert(rows.indexOf('kits')<rows.indexOf('qa'));
      await page.screenshot({path:out+'/unavailable-kept-visible.png',fullPage:true});
    }finally{release();}
  });
  await check('Missing age sorts after known pending ages and is labelled rather than invented',async()=>{
    const {page}=await open(users.all,'home',async c=>c.route('**/api/job-orders?stage=awaiting_release',async r=>{const response=await r.fetch(),rows=await response.json();await r.fulfill({json:rows.map(({created_at,updated_at,approved_at,...row})=>row)});}));
    await ready(page);assert.equal(await expanded(page,'kits'),true);assert.equal(await group(page,'kits').locator('[data-home-work-age]').innerText(),'Oldest date unavailable');
    assert((await order(page)).indexOf('kits')>(await order(page)).indexOf('rts'));
  });
  await check('Returning Home reorders completed work and still exposes only the authorized categories',async()=>{
    const request=await api('POST','/production/units/'+units[1].id+'/repairs',{kind:'add',component_item_id:part.id,quantity:1,notes:'Old pending return fixture'});
    dates([['UPDATE repair_part_requests SET created_at=? WHERE id=?','2025-01-01 00:00:00',request.id]]);
    const {page}=await open(users.all);await ready(page);assert.equal((await order(page))[0],'parts');
    await page.evaluate(()=>MApp.go('work'));await page.locator('.v2-work-heading').waitFor();
    await api('POST','/production/repairs/'+request.id+'/reject',{warehouse_remarks:'Finished away from Home'});
    await page.evaluate(()=>MApp.go('home'));await ready(page);assert.equal((await order(page))[0],'kits');assert.equal(await expanded(page,'parts'),false);
    const narrow=await open(users.qc);await ready(narrow.page);assert.deepEqual(await order(narrow.page),['qc']);
    assert.equal(await narrow.page.locator('[data-home-work] [data-attention=parts]').count(),0);
  });
  await check('All-clear waits for every authorized read and never includes failed or loading queues',async()=>{
    let release;const held=new Promise(r=>release=r);
    const {page,c}=await open(users.all,'home',async c=>{
      await c.route('**/api/job-orders?stage=awaiting_release',r=>r.fulfill({json:[]}));await c.route('**/api/production/repairs?status=requested',r=>r.fulfill({json:[]}));
      await c.route('**/api/qc/queue?role=qa',r=>r.fulfill({json:{units:[]}}));await c.route('**/api/qc/holds',r=>r.fulfill({json:[]}));await c.route('**/api/rts/queue',r=>r.fulfill({json:{units:[],batches:[]}}));
      await c.route('**/api/qc/queue?role=qc',async r=>{await held;await r.fulfill({status:503,json:{error:'Cannot check QC'}}).catch(()=>{});});
    });
    try{
      await expect(page.locator('[data-home-work-other-label]')).toHaveText('Other queues · 5 clear');await expect(page.locator('[data-home-work-empty]')).toBeHidden();
      release();await ready(page);await expect(group(page,'qc').locator('[data-home-work-count]')).toHaveText('Unknown');await expect(page.locator('[data-home-work-empty]')).toBeHidden();
      await page.screenshot({path:out+'/unknown-is-not-clear.png',fullPage:true});
      await c.unroute('**/api/qc/queue?role=qc');await c.route('**/api/qc/queue?role=qc',r=>r.fulfill({json:{units:[]}}));await refresh(page);
      await expect(page.locator('[data-home-work-empty]')).toBeVisible();await expect(page.locator('[data-home-work-other-label]')).toHaveText('View all 6 queues');
    }finally{release();}
  });
  await check('New work leaves the shared clear menu and opens its active category on the next poll',async()=>{
    const before=stock(),{page}=await open(users.parts);await ready(page);await page.clock.install();await page.reload();await ready(page);
    await page.locator('[data-home-work-other]>summary').click();await group(page,'parts').locator('[data-home-work-clear]').focus();
    const request=await api('POST','/production/units/'+units[1].id+'/repairs',{kind:'add',component_item_id:part.id,quantity:1,notes:'New work while Home is clear'});
    await page.clock.fastForward(30100);await expect(group(page,'parts').locator('[data-home-work-count]')).toHaveText('1 request');await ready(page);
    await expect(group(page,'parts').locator('[data-attention]')).toBeVisible();await expect(page.locator('[data-home-work-empty]')).toBeHidden();await expect(page.locator('[data-home-work-other]')).toBeHidden();
    assert.equal(await expanded(page,'parts'),true);assert.equal(await page.evaluate(()=>!!document.activeElement.closest('[hidden]')),false);assert.deepEqual(stock(),before);
    await api('POST','/production/repairs/'+request.id+'/reject',{warehouse_remarks:'Clear new-work fixture'});
  });
  await check('Revoking access removes a clear queue even while its shared menu is open',async()=>{
    await api('POST','/roles',{key:'compact_revoke',label:'Disposable parts desk',permissions:['mobile.access','production.repairs']});
    const person=await api('POST','/users',{username:'compact_revoke',password:'fixture-password',full_name:'Disposable clear desk',role:'compact_revoke'}),token=(await api('POST','/auth/login',{username:'compact_revoke',password:'fixture-password'},'')).token;
    const {page}=await open({...person,token});await ready(page);await page.locator('[data-home-work-other]>summary').click();await expect(group(page,'parts').locator('[data-home-work-clear]')).toBeVisible();
    await api('PUT','/users/'+person.id+'/permissions',{overrides:{'production.repairs':false}});await page.locator('[data-home-work-refresh]').click();
    await page.waitForFunction(()=>!document.querySelector('.v2-home-work'));await api('GET','/production/repairs?status=requested',undefined,token,403);
  });

}
