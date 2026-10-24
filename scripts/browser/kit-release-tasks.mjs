// Real API / SQLite / browser oracles for the mobile kit workspace. All data is disposable.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { AxeBuilder } from '@axe-core/playwright';

export async function runKitReleaseTasks({api,sql,open,check,users,purchasing,receiving,location,out,report}) {
  const rootA=await api('POST','/locations',{name:'Kit A',type:'warehouse'}),rootB=await api('POST','/locations',{name:'Kit B',type:'warehouse'});
  const source=await api('POST','/locations',{name:'Shelf 01',type:'warehouse',parent_id:rootA.id}),other=await api('POST','/locations',{name:'Shelf 01',type:'warehouse',parent_id:rootB.id});
  const brake=await api('POST','/inventory',{name:'Kit brake set',quantity:1,location_id:source.id});
  const fairing=await api('POST','/inventory',{name:'Kit fairing set',quantity:1,location_id:source.id});
  const product=await api('POST','/inventory',{name:'Kit UX product',quantity:0});
  await api('PUT','/finished-products/'+product.id,{components:[{component_item_id:brake.id,quantity:2},{component_item_id:fairing.id,quantity:1}]});
  const job=await api('POST','/job-orders',{product_item_id:product.id,qty_ordered:1,source_location_id:source.id,output_location_id:location,qc_stages:2});
  await api('POST','/job-orders/'+job.id+'/approve');
  const route='kit-release?id='+job.id;
  const stock=(item,loc=source.id)=>Number(sql('SELECT COALESCE(SUM(quantity),0) AS n FROM inventory_stock WHERE item_id=? AND location_id=?',item,loc)[0].n);
  const current=()=>api('GET','/job-orders/'+job.id,undefined,users.kits.token);
  const availability=()=>api('GET','/job-orders/'+job.id+'/availability',undefined,users.kits.token);
  const picks=()=>sql('SELECT component_item_id,qty_picked FROM job_order_components WHERE job_order_id=? ORDER BY component_item_id',job.id);
  const input=(page,item=brake)=>page.locator('[data-pick="'+item.id+'"]');
  const plus=(page,item=brake)=>page.getByRole('button',{name:'Increase picked '+(item===brake?'Kit brake set':'Kit fairing set'),exact:true});
  async function workspace(page){await page.locator('#kr-save-pick').waitFor();}
  async function savedCount(page,item,value){await page.waitForFunction(({id,value})=>document.querySelector('[data-pick-help="'+id+'"]')?.textContent.startsWith('Saved '+value+' of ')&&!document.querySelector('#kr-pick-status')?.textContent.includes('Unsaved'),{id:item.id,value});}
  async function refresh(page){await page.locator('#kr-refresh').click();await workspace(page);}
  async function count(page,item,value){await input(page,item).fill(String(value));}
  async function purchase(){return api('POST','/job-orders/'+job.id+'/purchase-shortfall',{},purchasing.token);}
  async function receive(po,loc){const order=await api('GET','/orders/'+po.id);return api('POST','/purchasing/orders/'+po.id+'/receipts',{location_id:loc,lines:order.items.map(l=>({order_item_id:l.id,item_id:l.item_id,name:l.name,quantity:l.quantity}))},receiving.token);}
  let po;
  report.kitFixture={job,brake,fairing,source,other};
  await check('Kit shortage reads expose counters and exact shelf, without accepting, purchasing or moving stock',async()=>{
    const {page}=await open(users.kits,route);await page.locator('#kr-accept').waitFor();
    assert.equal(await input(page).isDisabled(),true);assert.equal(await input(page).getAttribute('max'),'1');
    const text=await page.locator('#m-view').innerText();assert(text.includes('Kit A / Shelf 01'));assert(text.includes('Waiting for parts'));assert(text.includes('No outstanding linked purchase supply'));
    assert.equal((await current()).warehouse_accepted_at,null);assert.equal(stock(brake.id),1);assert.equal(stock(fairing.id),1);
    assert.equal(await page.locator('[data-pick-change]').count(),4);assert.equal(await page.getByRole('button',{name:/buy|purchase|receive/i}).count(),0);
    await api('POST','/job-orders/'+job.id+'/purchase-shortfall',{},users.kits.token,403);
    await api('POST','/purchasing/orders/1/receipts',{location_id:source.id,lines:[{name:'No authority',item_id:brake.id,quantity:1}]},users.kits.token,403);
  });
  await check('Clerk saves per-component partial counts; reservations reduce another kit free stock without stock-out',async()=>{
    const {page}=await open(users.kits,route);await page.locator('#kr-accept').click();await workspace(page);
    await plus(page).tap();await plus(page,fairing).tap();assert.equal(await plus(page).isDisabled(),true);
    assert(picks().every(l=>l.qty_picked===0));assert((await page.locator('#kr-pick-status').innerText()).includes('Unsaved counts'));
    await page.locator('#kr-save-pick').tap();await savedCount(page,brake,1);await savedCount(page,fairing,1);assert.deepEqual(picks().map(l=>l.qty_picked),[1,1]);
    assert.equal((await current()).prepared_at,null);assert.equal(stock(brake.id),1);assert.equal(stock(fairing.id),1);assert.equal(await page.locator('#kr-save-pick').isDisabled(),true);
    const otherJob=await api('POST','/job-orders',{product_item_id:product.id,qty_ordered:1,source_location_id:source.id});await api('POST','/job-orders/'+otherJob.id+'/approve');
    const av=await api('GET','/job-orders/'+otherJob.id+'/availability');assert.equal(av.lines.find(l=>l.component_item_id===brake.id).available,0);
    await page.screenshot({path:out+'/kit-partial-saved.png',fullPage:true});
  });
  await check('Saved partial counts survive reload; zero, fractional, negative and over-stock edits cannot invent picks',async()=>{
    const {page}=await open(users.kits,route);await workspace(page);assert.equal(await input(page).inputValue(),'1');await page.reload();await workspace(page);assert.equal(await input(page).inputValue(),'1');
    for(const value of ['','-1','1.5','2']){await count(page,brake,value);assert.equal(await page.locator('#kr-save-pick').isDisabled(),true);assert.equal(await input(page).getAttribute('aria-invalid'),'true');}
    assert.deepEqual(picks().map(l=>l.qty_picked),[1,1]);await count(page,brake,0);assert.equal(await page.locator('#kr-save-pick').isDisabled(),false);
    await page.locator('#kr-save-pick').click();await savedCount(page,brake,0);assert.equal(picks()[0].qty_picked,0);assert.equal(stock(brake.id),1);
    await plus(page).click();await page.locator('#kr-save-pick').click();await savedCount(page,brake,1);assert.equal(picks()[0].qty_picked,1);
  });
  await check('Outstanding PO appears read-only; repeat planning does not buy twice or enable final release',async()=>{
    const created=await purchase();assert.equal(created.created.length,1);po=created.created[0];assert.equal((await purchase()).created.length,0);
    const av=await availability();assert.equal(av.purchase_requirements[0].pending_purchase,1);assert.equal(av.releasable,false);
    const {page}=await open(users.kits,route);await workspace(page);assert((await page.locator('#m-view').innerText()).includes(po.number));assert((await page.locator('#m-view').innerText()).includes('1 still to receive'));assert.equal(stock(brake.id),1);
    await page.goto(page.url().replace(/#.*$/,'#/'+route+'&step=confirm'));await page.locator('#kr-report').waitFor();assert.equal(await page.locator('#kr-confirm').count(),0);assert((await page.locator('#m-view').innerText()).includes(po.number));
    await api('POST','/job-orders/'+job.id+'/release',{},users.kits.token,409);
    await page.locator('#kr-retry').click();await workspace(page);assert.equal(await input(page).inputValue(),'1');
    await page.screenshot({path:out+'/kit-outstanding-po.png',fullPage:true});
  });
  await check('A receipt at the identically named shelf in another warehouse does not fill this kit',async()=>{
    await receive(po,other.id);assert.equal(stock(brake.id),1);assert.equal(stock(brake.id,other.id),1);
    const av=await availability();assert.equal(av.shortfalls[0].short,1);assert.equal(av.releasable,false);
    const {page}=await open(users.kits,route);await workspace(page);const text=await page.locator('#m-view').innerText();assert(text.includes('Waiting for parts'));assert(text.includes('No outstanding linked purchase supply'));assert.equal(await input(page).getAttribute('max'),'1');assert.equal(picks()[0].qty_picked,1);
  });
  await check('Receiving at the exact source resolves stock shortage but does not complete the physical picks',async()=>{
    const created=await purchase();assert.equal(created.created.length,1);await receive(created.created[0],source.id);
    assert.equal(stock(brake.id),2);assert.equal(picks()[0].qty_picked,1);assert.equal((await current()).prepared_at,null);
    const {page}=await open(users.kits,route);await workspace(page);assert.equal(await input(page).inputValue(),'1');assert.equal(await input(page).getAttribute('max'),'2');assert.equal(await plus(page).isDisabled(),false);
    const text=await page.locator('#m-view').innerText();assert(text.includes('Picking incomplete'));assert(!text.includes('Waiting for parts'));assert.equal(await page.locator('#kr-confirm').count(),0);
    await api('POST','/job-orders/'+job.id+'/release',{},users.kits.token,409);
  });
  await check('Complete save opens the exact release review directly; editing can save a partial correction',async()=>{
    const {page}=await open(users.kits,route);await workspace(page);await plus(page).tap();assert((await page.locator('#kr-save-pick').innerText()).includes('Save counts & review release'));
    await page.locator('#kr-save-pick').tap();await page.locator('#kr-confirm').waitFor();assert.equal(await page.locator('#kr-ack').count(),0);assert.equal(stock(brake.id),2);
    let text=await page.locator('#m-view').innerText();assert(text.includes('Release 2'));assert(text.includes('Kit A / Shelf 01'));assert(text.includes('On hand 2 → 0'));
    await page.locator('#kr-back').click();await workspace(page);await count(page,brake,1);await page.locator('#kr-save-pick').click();await savedCount(page,brake,1);assert.equal((await current()).prepared_at,null);
    await count(page,brake,2);await page.locator('#kr-save-pick').click();await page.locator('#kr-confirm').waitFor();assert.equal(stock(brake.id),2);
    await page.screenshot({path:out+'/kit-final-review.png',fullPage:true});
  });
  await check('Fresh stock loss blocks an already-open confirmation; restoring it permits one authoritative slip',async()=>{
    const {page}=await open(users.kits,route+'&step=confirm');await page.locator('#kr-confirm').waitFor();
    await api('POST','/inventory/'+brake.id+'/adjust',{change:-1,location_id:source.id,reason:'Disposable kit stock-change fixture'});
    await page.locator('#kr-confirm').click();await page.locator('#kr-report').waitFor();assert.equal(await page.locator('#kr-confirm').count(),0);assert.equal((await current()).parts_slip_number,null);
    await api('POST','/inventory/'+brake.id+'/adjust',{change:1,location_id:source.id,reason:'Restore disposable kit stock-change fixture'});
    await page.locator('#kr-retry').click();await workspace(page);assert.equal(await page.locator('#kr-save-pick').innerText(),'Review release');await page.locator('#kr-save-pick').click();await page.locator('#kr-confirm').waitFor();
    await page.locator('#kr-confirm').tap();await page.locator('#kr-queue').waitFor();assert((await page.locator('#m-view').innerText()).includes('Parts released successfully'));
    const jo=await current();assert(jo.parts_slip_number);assert.equal(stock(brake.id),0);assert.equal(stock(fairing.id),0);
    assert.equal(sql('SELECT COUNT(*) AS n FROM parts_release_slips WHERE job_order_id=?',job.id)[0].n,1);
  });
  await check('Sale-linked shortage names the sale supply owner rather than offering duplicate job purchasing',async()=>{
    const sale=await api('POST','/orders',{type:'sale',status:'open',customer_name:'Kit UX sale',items:[{item_id:product.id,name:'Kit UX product',quantity:1,unit_price:100}]});
    const linked=await api('POST','/job-orders',{product_item_id:product.id,qty_ordered:1,order_id:sale.id,source_location_id:source.id});await api('POST','/job-orders/'+linked.id+'/approve');
    const {page}=await open(users.kits,'kit-release?id='+linked.id);await page.locator('#kr-accept').waitFor();
    const text=await page.locator('#m-view').innerText();assert(text.includes('Sales owns the supply plan'));assert(text.includes(sale.number));
    const refused=await api('POST','/job-orders/'+linked.id+'/purchase-shortfall',{},purchasing.token,409);assert.equal(refused.code,'sale_supply_owner');
    assert.equal(await page.getByRole('button',{name:/buy|purchase/i}).count(),0);
  });
  await check('A lost complete-pick response retains the original key after reload and never auto-releases',async()=>{
    const part=await api('POST','/inventory',{name:'Kit recovery component',quantity:5}),item=await api('POST','/inventory',{name:'Kit recovery product',quantity:0});
    await api('PUT','/finished-products/'+item.id,{components:[{component_item_id:part.id,quantity:2}]});
    const j=await api('POST','/job-orders',{product_item_id:item.id,qty_ordered:1});await api('POST','/job-orders/'+j.id+'/approve');await api('POST','/job-orders/warehouse-accept',{job_order_ids:[j.id]},users.kits.token);
    const calls=[];let once=true;
    const {page,c}=await open(users.kits,'kit-release?id='+j.id,async c=>{
      c.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/api/job-orders/prepare'))calls.push({key:r.headers()['idempotency-key'],body:r.postData()});});
      await c.route('**/api/job-orders/prepare',async route=>{if(!once)return route.continue();once=false;await route.fetch();await route.abort();});
    });
    await workspace(page);await input(page,part).fill('2');await page.locator('#kr-save-pick').click();await page.locator('#kr-retry-action').waitFor();
    assert.equal(await page.locator('#kr-confirm').count(),0);assert.equal(sql('SELECT qty_picked FROM job_order_components WHERE job_order_id=?',j.id)[0].qty_picked,2);
    await page.reload();await page.locator('#kr-retry-action').waitFor();await c.unroute('**/api/job-orders/prepare');await page.locator('#kr-retry-action').click();await page.getByText('Confirmed by site authority.',{exact:false}).waitFor();
    assert.equal(calls.length,2);assert(calls[0].key);assert.deepEqual(calls[1],calls[0]);
    await page.locator('#kr-review').click();await workspace(page);assert.equal(await input(page,part).inputValue(),'2');assert.equal(await page.locator('#kr-save-pick').innerText(),'Review release');
    assert.equal((await api('GET','/job-orders/'+j.id)).parts_slip_number,null);assert.equal(Number(sql('SELECT quantity FROM inventory_items WHERE id=?',part.id)[0].quantity),5);
  });
  await check('A delayed kit-detail failure cannot replace Home after leaving the workspace',async()=>{
    let release,started,finished;const held=new Promise(r=>release=r),seen=new Promise(r=>started=r),done=new Promise(r=>finished=r);
    const {page}=await open(users.kits,route,async c=>c.route('**/api/job-orders/'+job.id,async route=>{started();await held;await route.fulfill({status:503,json:{error:'Delayed kit detail unavailable'}}).catch(()=>{});finished();}));
    try{await seen;await page.evaluate(()=>MApp.go('home'));await page.locator('.v2-home').waitFor();release();await done;await page.waitForTimeout(100);assert.equal(await page.locator('#m-title').innerText(),'Today');assert.equal(await page.locator('#m-view .rk-error').count(),0);}finally{release();}
  });
  await check('Kit counter keyboard, mobile sizes and targeted accessibility checks remain usable',async()=>{
    // Independent new job with complete stock; the completed fixture must stay immutable.
    const part=await api('POST','/inventory',{name:'Kit accessible component',quantity:5}),item=await api('POST','/inventory',{name:'Kit accessible product',quantity:0});
    await api('PUT','/finished-products/'+item.id,{components:[{component_item_id:part.id,quantity:2}]});
    const j=await api('POST','/job-orders',{product_item_id:item.id,qty_ordered:1});await api('POST','/job-orders/'+j.id+'/approve');await api('POST','/job-orders/warehouse-accept',{job_order_ids:[j.id]},users.kits.token);
    const {page}=await open(users.kits,'kit-release?id='+j.id);await workspace(page);const field=input(page,part);await field.press('ArrowUp');assert.equal(await field.inputValue(),'1');await field.press('ArrowDown');assert.equal(await field.inputValue(),'0');
    const scans=[];
    for(const width of [360,390])for(const theme of ['light','dark']){
      await page.setViewportSize({width,height:844});await page.evaluate(t=>{document.documentElement.dataset.theme=t;localStorage.setItem('vds_theme',t);},theme);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      const b=await page.locator('[data-pick-change="1"]').boundingBox();assert(b.width>=44&&b.height>=44);
      const result=await new AxeBuilder({page}).include('#m-view').withRules(['color-contrast','label','button-name']).analyze();scans.push({width,theme,violations:result.violations,incomplete:result.incomplete});assert.deepEqual(result.violations,[]);
      await page.screenshot({path:out+'/kit-counter-'+width+'-'+theme+'.png',fullPage:true});
    }
    fs.writeFileSync(out+'/kit-counter-a11y.json',JSON.stringify(scans,null,2));
  });
}
