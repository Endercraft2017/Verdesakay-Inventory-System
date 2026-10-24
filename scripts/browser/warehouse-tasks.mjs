import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';

// Counts actual trusted pointer-up events, not a guessed count of helper calls.
// Text-entry taps count once; keystrokes and external printer/file-picker actions do not.
export async function runWarehouseTasks(env) {
  const {api,sql,open,check:checkAll,users,kit,repair,part,product:batchProduct,bulk,batch,location,png,out,report}=env;
  const check=(name,fn)=>!process.env.WAREHOUSE_UX_TASK_FILTER||name.includes(process.env.WAREHOUSE_UX_TASK_FILTER)?checkAll(name,fn):Promise.resolve();
  const releaseUser=await (async()=>{
    await api('POST','/roles',{key:'tap_release',label:'Releasing task fixture',permissions:['mobile.access','orders.release']});
    const u=await api('POST','/users',{username:'tap_release',password:'fixture-password',full_name:'Release task fixture',role:'tap_release'});
    return {...u,token:(await api('POST','/auth/login',{username:'tap_release',password:'fixture-password'},'')).token};
  })();
  const product=await api('POST','/inventory',{name:'Task finished unit',quantity:0});
  await api('PUT','/finished-products/'+product.id,{components:[{component_item_id:part.id,quantity:1}]});
  // Two required checks per inspection, one group; do not measure an empty checklist.
  for(const stage of [1,2]){
    const checklist=await api('POST','/qc/checklists',{name:stage===1?'Technical checks':'Appearance checks',stage,
      items:[{label:stage===1?'Chassis secure':'Fairings aligned',required:true},{label:stage===1?'Brakes operate':'Finish intact',required:true}]});
    await api('PATCH','/finished-products/'+product.id+'/checklist',{stage,checklist_id:checklist.id});
  }
  const job=await api('POST','/job-orders',{product_item_id:product.id,qty_ordered:1,qc_stages:2});
  await api('POST','/job-orders/'+job.id+'/approve');await api('POST','/job-orders/warehouse-accept',{job_order_ids:[job.id]});await api('POST','/job-orders/prepare',{job_orders:[{id:job.id}]});await api('POST','/job-orders/'+job.id+'/release');await api('POST','/job-orders/'+job.id+'/accept',{});
  const fd=new FormData();
  fd.append('identifier','TAP-UNIT-ONE');fd.append('image',new Blob([png],{type:'image/png'}),'unit.png');
  const unit=await api('POST','/job-orders/'+job.id+'/units',fd);
  const ledgers=[];report.taskLedgers=ledgers;
  const stock=id=>Number(sql('SELECT COALESCE(SUM(quantity),0) AS n FROM inventory_stock WHERE item_id=?',id)[0].n);
  async function start(who,title,queueLabel){
    const entry={title,taps:[],fields:[],external:[],screens:[],occlusions:[],checks:[]};ledgers.push(entry);
    const {page,c}=await open(who,'home',async c=>{
      if(process.env.WAREHOUSE_UX_TASK_SNAPSHOT)await c.route('**/mobile/**',route=>{
        const file=process.env.WAREHOUSE_UX_TASK_SNAPSHOT+'/public'+new URL(route.request().url()).pathname;
        if(!fs.existsSync(file)||!fs.statSync(file).isFile())return route.continue();
        report.taskSnapshot=process.env.WAREHOUSE_UX_TASK_SNAPSHOT;
        report.taskSnapshotHashes=report.taskSnapshotHashes||{};
        report.taskSnapshotHashes[file]=createHash('sha256').update(fs.readFileSync(file)).digest('hex');
        return route.fulfill({path:file,contentType:file.endsWith('.css')?'text/css':'text/javascript'});
      });
      await c.addInitScript(()=>{
        window.__taskTaps=[];
        document.addEventListener('pointerup',e=>{
          if(!e.isTrusted)return;
          const el=e.target.closest('button,input,textarea,select,label,canvas')||e.target;
          window.__taskTaps.push({hash:location.hash,tag:el.tagName,id:el.id,label:el.getAttribute('aria-label')||el.textContent?.trim().slice(0,100)||el.getAttribute('placeholder')||'',type:el.tagName==='CANVAS'?'stroke':'tap'});
        },true);
      });
    });
    let seq=0;
    async function snapshot(label){
      const file=title.toLowerCase().replaceAll(/[^a-z0-9]+/g,'-')+'-'+String(++seq).padStart(2,'0')+'.png';
      await page.screenshot({path:out+'/'+file,fullPage:true});entry.screens.push({label,hash:new URL(page.url()).hash,file});
    }
    async function tap(selector,label){
      const target=typeof selector==='string'?page.locator(selector):selector;
      await target.waitFor();
      await target.scrollIntoViewIfNeeded();
      if(process.env.WAREHOUSE_UX_AUDIT_STEPS==='1'){
        const node=await page.locator('#m-view').getAttribute('data-figma-node');
        entry.stepA11y=entry.stepA11y||[];
        if(node&&await page.locator('#m-view .rk-page').count()&&!entry.stepA11y.some(a=>a.node===node)){
          const checked=await new AxeBuilder({page}).include('#m-view').withRules(['color-contrast','label','button-name']).analyze();
          entry.stepA11y.push({node,hash:new URL(page.url()).hash,violations:checked.violations,incomplete:checked.incomplete.map(a=>({id:a.id,nodes:a.nodes.map(n=>n.target)}))});
        }
      }
      const covered=await target.evaluate(el=>{
        const r=el.getBoundingClientRect();
        return [0.15,0.5,0.85].filter(f=>{
          const hit=document.elementFromPoint(r.x+r.width*f,r.y+r.height*.5);
          return !hit||!el.contains(hit);
        }).map(f=>({fraction:f,x:r.x+r.width*f,y:r.y+r.height*.5}));
      });
      if(covered.length)entry.occlusions.push({label,hash:new URL(page.url()).hash,covered});
      await target.tap();
    }
    async function fill(selector,value,label){
      await tap(selector,label);await page.locator(selector).fill(String(value));
      entry.fields.push({label,characters:String(value).length});
    }
    async function finish(result){
      await snapshot('Completed result');
      entry.taps=await page.evaluate(()=>window.__taskTaps);
      entry.tapCount=entry.taps.filter(t=>t.type==='tap').length;
      entry.strokeCount=entry.taps.filter(t=>t.type==='stroke').length;
      entry.result=result;
      console.log('TAPS '+title+': '+entry.tapCount+' + '+entry.strokeCount+' signature stroke(s)');
      fs.writeFileSync(out+'/task-ledgers.json',JSON.stringify(ledgers,null,2));
      if(process.env.WAREHOUSE_UX_REQUIRE_A11Y==='1')assert.equal((entry.a11y||[]).concat(entry.stepA11y||[]).reduce((n,a)=>n+a.violations.length,0),0,'Targeted accessibility failures');
    }
    async function audit(label){
      await snapshot(label);
      entry.a11y=entry.a11y||[];
      for(const width of [360,390])for(const theme of ['light','dark']){
        await page.setViewportSize({width,height:844});
        await page.evaluate(theme=>document.documentElement.setAttribute('data-theme',theme),theme);
        const result=await new AxeBuilder({page}).include('#m-view').withRules(['color-contrast','label','button-name']).analyze();
        entry.a11y.push({label,width,theme,violations:result.violations,incomplete:result.incomplete.map(x=>({id:x.id,nodes:x.nodes.map(n=>n.target)}))});
        await page.screenshot({path:out+'/'+entry.title.toLowerCase().replaceAll(/[^a-z0-9]+/g,'-')+'-'+width+'-'+theme+'.png',fullPage:true});
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'Horizontal overflow');
      }
      await page.setViewportSize({width:390,height:844});await page.evaluate(()=>document.documentElement.setAttribute('data-theme','light'));
      const overlays=await page.locator('#m-view .rk-actions button').evaluateAll(buttons=>buttons.flatMap(button=>{
        const r=button.getBoundingClientRect(),hits=[];
        for(const x of [.15,.5,.85])for(const y of [.15,.5,.85]){
          const px=r.x+r.width*x,py=r.y+r.height*y;
          if(py<70||py>innerHeight-100)continue;
          const hit=document.elementFromPoint(px,py);
          if(hit?.closest('.v2-orbit'))hits.push({x:px,y:py});
        }
        return hits.length?[{label:button.textContent,points:hits}]:[];
      }));
      entry.overlayChecks=entry.overlayChecks||[];entry.overlayChecks.push({label,overlays});
    }
    await tap('#m-tabbar [data-tab=work]','Work tab');
    await page.locator('.v2-work-heading').waitFor();
    await tap(page.locator('.v2-work-row').filter({has:page.locator('b').filter({hasText:new RegExp('^'+queueLabel+'$')})}).first(),'Open '+queueLabel);
    await page.locator('#m-view .rk-page').waitFor();
    return {page,c,entry,tap,fill,finish,snapshot,audit};
  }
  async function selectRow(t,selector,tab){
    await t.page.locator('#m-view [data-tab]').first().waitFor();
    // Original queues may be on a genuinely empty initial status. Count changing it.
    if(!await t.page.locator(selector).count())await t.tap('#m-view [data-tab="'+tab+'"]','Find the pending status');
    await t.tap(selector,'Open record');
  }
  async function syntheticCamera(page,code,image){
    // Real scanner overlay and ZXing decode; only the camera image source is synthetic.
    await page.evaluate(async({code,image})=>{
      window.BarcodeDetector=undefined;
      window.__taskCode=code;window.__taskImage=image||mProductionPrint.qrDataUrl(code);
      navigator.mediaDevices.getUserMedia=async()=>{
        const img=new Image();img.src=window.__taskImage;await img.decode();
        const canvas=document.createElement('canvas');canvas.width=640;canvas.height=480;
        const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,640,480);ctx.imageSmoothingEnabled=false;ctx.drawImage(img,160,80,320,320);
        return canvas.captureStream(10);
      };
    },{code,image});
  }
  async function scanSticker(t,code,button='[data-verify-label]'){
    await syntheticCamera(t.page,code);
    await t.tap(button,'Scan attached QR sticker');
    await t.page.locator('.m-scan').waitFor({state:'hidden',timeout:15000});
    assert((await t.page.locator('[data-scan-status]').innerText()).includes('1 of 1'));
    t.entry.checks.push('Real ZXing decoded synthetic '+code);
  }
  async function print(t,code){
    const opened=t.page.waitForEvent('popup');
    await t.tap('#rts-print-labels','Open printable QR label');
    const popup=await opened;await popup.locator('img').first().waitFor();
    const source=await popup.locator('img[src^="data:image"]').first().getAttribute('src');
    const decoded=await t.page.evaluate(async src=>(await new ZXing.BrowserMultiFormatReader().decodeFromImageUrl(src)).getText(),source);
    assert.equal(decoded,code);
    await popup.screenshot({path:out+'/'+code.replaceAll(':','-')+'-label.png'});
    await popup.close();t.entry.external.push('Printer dialog, attaching the sticker and closing its browser preview are outside the app tap count.');
    await syntheticCamera(t.page,code,source);
  }
  await check('Complete task: kit acceptance, counted picks and released parts slip',async()=>{
    const before=stock(part.id),t=await start(users.kits,'Kit release','Kit releases');
    await selectRow(t,'[data-id="'+kit.id+'"]','preparing');
    await t.tap('#kr-accept','Accept kit for picking');
    await t.page.locator('#kr-review,#kr-save-pick').first().waitFor();
    if(await t.page.locator('#kr-review').count())await t.tap('#kr-review','Continue after confirmed acceptance');
    await t.fill('[data-pick="'+part.id+'"]',1,'Count picked component');
    await t.tap('#kr-save-pick','Save picked counts');
    await t.page.locator('#kr-review,#kr-go,#kr-confirm').first().waitFor();
    if(await t.page.locator('#kr-review').count())await t.tap('#kr-review','Continue after confirmed picks');
    if(await t.page.locator('#kr-go').count())await t.tap('#kr-go','Review kit release');
    await t.audit('Kit final confirmation');
    if(await t.page.locator('#kr-ack').count())await t.tap('#kr-ack','Acknowledge complete physical kit');
    await t.tap('#kr-confirm','Confirm component stock-out');
    await t.page.locator('#kr-review,#kr-queue').first().waitFor();
    if(await t.page.locator('#kr-review').count())await t.tap('#kr-review','Open the confirmed release result');
    await t.page.getByText(/Parts released successfully/i).first().waitFor();
    const current=await api('GET','/job-orders/'+kit.id,undefined,users.kits.token);
    assert.equal(current.status,'released');assert(current.parts_slip_number);assert.equal(stock(part.id),before-1);
    await t.finish({job:kit.id,status:current.status,partsSlip:current.parts_slip_number,stockDelta:-1});
  });
  await check('Complete task: issue the exact requested repair part',async()=>{
    const before=stock(part.id),t=await start(users.parts,'Parts issue','Parts requests');
    await selectRow(t,'[data-req="'+repair.id+'"]','pending');
    for(let i=0;i<6;i++){
      await t.page.waitForFunction(()=>{
        const step=new URLSearchParams(location.hash.split('?')[1]).get('step')||'request';
        const node=document.querySelector('#m-view')?.getAttribute('data-figma-node');
        const nodes={request:['83:68'],context:['83:68','83:109'],source:['83:158'],pick:['83:206'],review:['83:247','83:295'],confirm:['83:295']};
        return nodes[step]?.includes(node)&&!!document.querySelector('#rp-go,#rp-post');
      });
      const active=await t.page.locator('#rp-go,#rp-post').first().getAttribute('id');
      if(active==='rp-post')break;
      const url=t.page.url();await t.tap('#rp-go','Continue reviewed request');
      await t.page.waitForURL(u=>u.href!==url);
    }
    await t.tap('#rp-ok','Verify the exact picked part');
    await t.audit('Parts final confirmation');
    await t.tap('#rp-post','Confirm parts stock-out');
    await t.page.getByText('Repair part issued',{exact:true}).waitFor();
    assert.equal(sql('SELECT status FROM repair_part_requests WHERE id=?',repair.id)[0].status,'accepted');assert.equal(stock(part.id),before-1);
    await t.finish({request:repair.id,status:'accepted',stockDelta:-1,scan:'No SKU on this fixture; name/count fallback'});
  });
  for(const [who,role]of [[users.qc,'qc'],[users.qa,'qa']]){
    await check('Complete task: '+role.toUpperCase()+' with two required checklist checks',async()=>{
      const before=stock(product.id),t=await start(who,role.toUpperCase()+' pass',role==='qc'?'QC technical inspection':'QA appearance inspection');
      await selectRow(t,'[data-jo="'+job.id+'"]','ready');
      await t.tap('[data-unit="'+unit.id+'"]','Select physical unit');
      await t.tap('#qc-identity','Confirm physical identity');
      await t.tap('#qc-start','Start inspection');
      for(let i=0;i<2;i++){
        if(!await t.page.locator('[data-set=pass]').count())await t.tap('[data-i="'+i+'"]','Open checklist item');
        await t.tap('[data-set=pass]','Record checked item as Pass');
      }
      await t.tap('#qc-next','Review inspection');
      await t.tap('[data-d=pass]','Choose pass disposition');
      await t.audit(role.toUpperCase()+' final confirmation');
      await t.tap('#qc-confirm','Confirm inspection result');
      await t.page.locator('#wf-review').waitFor();
      const rows=sql('SELECT result,stage FROM qc_records WHERE unit_id=? AND stage=?',unit.id,role==='qc'?1:2);
      assert.equal(rows.length,1);assert.equal(rows[0].result,'pass');assert.equal(stock(product.id),before);
      await t.finish({unit:unit.id,inspection:role,result:'pass',requiredChecks:2,stockDelta:0});
    });
  }
  await check('Complete task: RTS serialized receipt with printable and scanned QR',async()=>{
    const before=stock(product.id),t=await start(users.rts,'RTS unit receipt','RTS recording');
    await selectRow(t,'[data-jo="'+job.id+'"]','ready');
    await t.tap('[data-unit="'+unit.id+'"]','Select unit');
    await t.tap('#rts-go','Verify finished identity');
    await t.tap('#rts-go','Use finished-goods location');
    await t.page.locator('#rts-rev,#rts-check').first().waitFor();
    if(await t.page.locator('#rts-rev').count())await t.tap('#rts-rev','Review selected unit');
    await t.tap('#rts-check','Check duplicates before confirmation');
    await print(t,'VDS:UNIT:'+unit.id);
    await scanSticker(t,'VDS:UNIT:'+unit.id);
    await t.tap('#rts-ok','Confirm unit and location');
    await t.audit('Unit receipt confirmation');
    await t.tap('#rts-post','Confirm finished stock-in');
    await t.page.getByText('Ready to sell',{exact:true}).first().waitFor();
    assert.equal(sql('SELECT status FROM job_order_units WHERE id=?',unit.id)[0].status,'in_stock');assert.equal(stock(product.id),before+1);
    await t.finish({unit:unit.id,status:'in_stock',stockDelta:1});
  });
  await check('Complete task: RTS batch receipt with printable and scanned QR',async()=>{
    const before=stock(batchProduct.id),t=await start(users.rts,'RTS batch receipt','RTS recording');
    await selectRow(t,'[data-jo="'+bulk.id+'"]','ready');
    await t.tap('[data-batch="'+batch.id+'"]','Select batch');
    await print(t,'VDS:BATCH:'+batch.id);
    await scanSticker(t,'VDS:BATCH:'+batch.id);
    await t.tap('#rts-ok','Acknowledge counted batch and location');
    await t.audit('Batch receipt confirmation');
    await t.tap('#rts-post','Confirm seven-piece stock-in');
    await t.page.getByText('Ready to sell',{exact:true}).first().waitFor();
    assert.equal(stock(batchProduct.id),before+7);
    assert.equal(sql('SELECT SUM(quantity) AS n FROM production_receipt_items WHERE batch_id=?',batch.id)[0].n,10);
    await t.finish({batch:batch.id,received:7,remaining:0,stockDelta:7});
  });
  await check('Complete task: authorized serialized warehouse-out with package, token and evidence',async()=>{
    await api('PUT','/finished-products/'+product.id+'/package',{items:[{label:'Keys and charger',required:true}]});
    const sale=await api('POST','/orders',{type:'sale',status:'approved',customer_name:'Task fixture recipient',items:[{item_id:product.id,name:'Finished unit',quantity:1,unit_price:100}]});
    const auth=await api('POST','/release-slips/orders/'+sale.id+'/authorizations',{mode:'pickup',recipient_name:'Task fixture recipient',valid_hours:8});
    const before=stock(product.id),t=await start(releaseUser,'Warehouse out','Release orders');
    await selectRow(t,'[data-order="'+sale.id+'"]','accept');
    await t.tap('#rel-go','Accept warehouse order');
    async function continueConfirmed(label){
      await t.page.locator('#rel-review-current,.rk-identify').first().waitFor();
      if(await t.page.locator('#rel-review-current').count()){
        await t.tap('#rel-review-current',label);
        await t.page.waitForURL(u=>!u.hash.includes('step=recovery'));
        await t.tap('#rel-go','Begin stock verification');
        await t.page.locator('.rk-identify').waitFor();
      }
    }
    await continueConfirmed('Review accepted order');
    await syntheticCamera(t.page,'VDS:UNIT:'+unit.id);
    await t.tap('.rk-identify','Find stock using attached QR');
    await t.page.locator('#rel-ok').waitFor();
    await scanSticker(t,'VDS:UNIT:'+unit.id);
    await t.tap('#rel-ok','Allocate verified unit');
    await continueConfirmed('Review allocated order');
    await t.tap('#rel-go','Review package');
    await t.tap('[data-p="0"]','Verify package item');
    await t.tap('#rel-go','Continue to handoff');
    await t.fill('[data-token]',auth.token,'Enter recipient-presented token');
    await t.tap('[data-verify]','Verify token');
    await t.page.locator('[data-token]').waitFor({state:'hidden'});
    await t.tap('#rel-go','Continue to handoff proof');
    const chooser=t.page.waitForEvent('filechooser');await t.tap('[data-cap]','Capture required handoff photo');
    await (await chooser).setFiles({name:'handoff.png',mimeType:'image/png',buffer:png});await t.page.locator('[data-thumbs] img').waitFor();
    t.entry.external.push('Supplying the handoff image simulates the camera/file-picker result; external camera shutter and picker taps are not measured.');
    const canvas=t.page.locator('[data-sign] canvas');await canvas.scrollIntoViewIfNeeded();const box=await canvas.boundingBox();
    await t.page.mouse.move(box.x+20,box.y+25);await t.page.mouse.down();await t.page.mouse.move(box.x+100,box.y+50,{steps:8});await t.page.mouse.up();
    await t.tap('#rel-go','Review handoff evidence');
    await t.page.waitForURL(u=>new URLSearchParams(u.hash.split('?')[1]).get('step')==='review');
    await t.tap('#rel-go','Continue to final confirmation');
    await t.page.locator('#rel-ok').waitFor();
    await t.tap('#rel-ok','Acknowledge physical handoff');
    await t.audit('Warehouse-out final confirmation');
    await t.tap('#rel-post','Confirm warehouse-out');
    await t.page.locator('#rel-review-current,#handoff-review,#rel-back').first().waitFor();
    const slips=sql('SELECT id FROM release_slips WHERE order_id=?',sale.id);
    assert.equal(slips.length,1);assert.equal(stock(product.id),before-1);
    assert.equal(sql('SELECT status FROM job_order_units WHERE id=?',unit.id)[0].status,'sold');
    await t.finish({order:sale.id,slip:slips[0].id,unit:unit.id,stockDelta:-1,packageItems:1,photoCount:1,signature:true});
  });
}
