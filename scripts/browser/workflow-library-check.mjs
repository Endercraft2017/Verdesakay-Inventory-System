import assert from 'node:assert/strict';
import {expect} from 'playwright/test';

async function library(f){await f.evaluate(()=>MApp.go('guides'));await expect(f.locator('.m-guide-library')).toBeVisible();}
async function modal(f,id){await f.locator('[data-guide-id="'+id+'"]').click();await expect(f.locator('.m-workflow-dialog[open]')).toBeVisible();}
async function scan(f,axe,root){await f.addScriptTag({content:axe.source});const result=await f.evaluate(async root=>axe.run(document.querySelector(root),{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa','wcag22aa']}}),root);assert.deepEqual(result.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})),[]);}

export async function verifyWorkflowLibrary({page,frame,scenario,ready,out,axe}){
  await scenario('administrator');let f=frame();await library(f);const samples=[];
  const groups=await f.locator('.m-guide-group h2').allTextContents();assert.deepEqual(groups,['Production','HR','Sales','Inventory','Purchasing','Accounting','My work']);
  assert.equal(await f.locator('[data-guide-id]').count(),await f.evaluate(()=>MobileWorkflow.items().length));assert.equal(await f.locator('#m-guide-results details').count(),0);
  const layout=await page.locator('.layout').getAttribute('style'),phone=await page.locator('.phone').getAttribute('style');
  try{for(const theme of ['dark','light']){
    await page.locator('#theme').selectOption(theme);await ready();f=frame();await library(f);
    for(const width of [320,390,560]){
      await page.locator('.layout').evaluate((el,width)=>el.style.gridTemplateColumns=`minmax(0,1fr) ${width+2}px`,width);await page.locator('.phone').evaluate((el,width)=>el.style.width=(width+2)+'px',width);
      const geometry=await f.locator('.m-guide-grid').first().evaluate(el=>{const a=el.children[0].getBoundingClientRect(),b=el.children[1].getBoundingClientRect();return {a:{x:a.x,y:a.y,w:a.width},b:{x:b.x,y:b.y,w:b.width},overflow:document.documentElement.scrollWidth>innerWidth,bg:getComputedStyle(el.children[0]).backgroundColor};});
      assert(Math.abs(geometry.a.w-geometry.b.w)<1&&Math.abs(geometry.a.y-geometry.b.y)<1&&geometry.b.x>geometry.a.x);assert(!geometry.overflow);assert(!['rgb(26, 34, 51)','rgb(26, 34, 52)'].includes(geometry.bg));samples.push({theme,width,...geometry});
      await page.locator('.phone').screenshot({path:out+'/workflow-library-'+theme+'-'+width+'.png'});
    }
    await scan(f,axe,'.m-guide-library');await modal(f,'production');const d=f.locator('.m-workflow-dialog');
    assert.equal(await d.locator('[data-workflow-step]').count(),await f.evaluate(()=>GUIDE.byId.production.steps.length));
    assert(await d.evaluate(d=>d.contains(document.activeElement)));
    for(let i=0;i<22;i++){await page.keyboard.press('Tab');assert(await d.evaluate(d=>d.contains(document.activeElement)),'Native modal contains keyboard focus');}
    await scan(f,axe,'.m-workflow-dialog');await page.locator('.phone').screenshot({path:out+'/workflow-modal-'+theme+'.png'});
    await page.keyboard.press('Escape');await expect(d).toHaveCount(0);await expect(f.locator('[data-guide-id=production]')).toBeFocused();
  }}finally{await page.locator('.layout').evaluate((el,s)=>s===null?el.removeAttribute('style'):el.setAttribute('style',s),layout);await page.locator('.phone').evaluate((el,s)=>s===null?el.removeAttribute('style'):el.setAttribute('style',s),phone);}
  await scenario('sales');return samples;
}

export async function verifyWorkflowDestinations({page,frame,scenario,ready,out}){
  await scenario('administrator');let f=frame();await library(f);
  const before=await f.locator('#m-guide-results').boundingBox();await modal(f,'sales');const after=await f.locator('#m-guide-results').boundingBox();assert.equal(before.height,after.height,'Modal does not expand the catalog');assert.equal(before.width,after.width);
  await f.locator('[data-workflow-step="0"]').click();await expect(f.locator('#m-view')).toHaveAttribute('data-route','sales');await expect(f.locator('[data-sales-list]')).toBeVisible();await expect(f.locator('.guide-compact')).toHaveCount(0);
  await library(f);await modal(f,'payroll');await expect(f.locator('[data-workflow-start]')).toBeDisabled();const hash=f.url();await f.locator('[data-workflow-step="0"]').click();await expect(f.locator('[data-scratch-web-handoff]')).toBeVisible();assert.equal(f.url(),hash);await f.getByRole('button',{name:'Back to workflow'}).click();await f.locator('.m-workflow-close').click();
  await expect(f.locator('.m-workflow-dialog')).toHaveCount(0);await f.locator('#m-guide-search').fill('receive goods');await expect(f.locator('[data-workflow-query]')).toHaveCount(3);await f.locator('[data-workflow-query="0"]').click();await expect(f.locator('[data-guide-id="purchase-to-pay"]')).toBeVisible();
  await scenario('basic');f=frame();await library(f);await modal(f,'production');await expect(f.locator('[data-workflow-start]')).toBeDisabled();const prior=f.url();await f.locator('[data-workflow-step="3"]').click();await expect(f.locator('.m-workflow-step-feedback:not([hidden])')).toContainText('access');assert.equal(f.url(),prior);
  await page.locator('.phone').screenshot({path:out+'/workflow-access-reference.png'});await scenario('sales');return {directStep:'sales',webOnly:'payroll',denied:'production',clarificationChoices:3};
}

export async function verifyWorkflowGuidance({page,frame,scenario,ready,out,axe}){
  const evidence=[],originalPhone=await page.locator('.phone').getAttribute('style'),originalLayout=await page.locator('.layout').getAttribute('style');
  for(const motion of ['no-preference','reduce']){
    await page.emulateMedia({reducedMotion:motion});const theme=motion==='reduce'?'dark':'light',width=motion==='reduce'?320:390;await page.locator('#theme').selectOption(theme);await ready();await scenario('basic');await page.locator('.phone').evaluate((el,width)=>el.style.width=(width+2)+'px',width);await page.locator('.layout').evaluate((el,width)=>el.style.gridTemplateColumns=`minmax(0,1fr) ${width+2}px`,width);const f=frame();await library(f);
    await f.evaluate(()=>{window.__workflowMotion=[];const animate=Element.prototype.animate;Element.prototype.animate=function(keyframes,options){if(this.matches('.m-workflow-dialog'))window.__workflowMotion.push(options.duration);return animate.call(this,keyframes,options);};});await modal(f,'notes-scheduler');
    await f.locator('[data-workflow-start]').click();await expect(f.locator('#m-note-new')).toBeVisible();const bar=f.locator('.guide-compact');await expect(bar).toBeVisible();await expect(f.locator('.guide-focus-ring')).toBeVisible();
    await expect(bar.getByRole('button',{name:'Previous guide step'})).toBeDisabled();assert.equal(await f.evaluate(()=>getComputedStyle(document.querySelector('.guide-focus-ring')).boxShadow),'none');
    await bar.getByRole('button',{name:'Next guide step'}).focus();await bar.getByRole('button',{name:'Next guide step'}).press('Enter');await expect(f.locator('#m-note-editor')).toBeVisible();await expect(bar.locator('strong')).toHaveText('Create a note or checklist');await expect(bar.getByRole('button',{name:'Next guide step'})).toBeFocused();
    await f.locator('#m-note-title').fill('Keep my unsaved guide example');await f.locator('#m-note-body').fill('A guide is optional.');await bar.getByRole('button',{name:'Next guide step'}).click();await expect(bar.locator('strong')).toHaveText('Schedule the note');await expect(f.locator('#m-note-scheduled')).not.toBeChecked();
    const geometry=await f.locator('#m-note-scheduled').evaluate(el=>{const a=el.getBoundingClientRect(),r=document.querySelector('.guide-focus-ring').getBoundingClientRect(),b=document.querySelector('.guide-compact').getBoundingClientRect(),footer=document.querySelector('.personal-editor-actions').getBoundingClientRect();return {target:{x:a.x,y:a.y,w:a.width,h:a.height},ring:{x:r.x,y:r.y,w:r.width,h:r.height},footerOverlap:Math.max(0,Math.min(footer.right,b.right)-Math.max(footer.left,b.left))*Math.max(0,Math.min(footer.bottom,b.bottom)-Math.max(footer.top,b.top)),overlap:Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left))*Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top))};});
    assert(Math.abs(geometry.ring.x-geometry.target.x+5)<1);assert.equal(geometry.overlap,0);assert.equal(geometry.footerOverlap,0,'Guidance must leave Save and Cancel accessible');await page.locator('.phone').screenshot({path:out+'/workflow-guidance-'+motion+'.png'});await scan(f,axe,'.guide-compact');
    await f.locator('#m-note-scheduled').check();await expect(f.locator('#m-note-due')).toBeVisible();await bar.getByRole('button',{name:'Next guide step'}).click();await expect(bar.locator('strong')).toHaveText('Keep progress in sync');await expect(f.locator('#m-note-title')).toHaveValue('Keep my unsaved guide example');
    await bar.getByRole('button',{name:'Previous guide step'}).click();await bar.getByRole('button',{name:'Previous guide step'}).click();await expect(bar.locator('strong')).toHaveText('Create a note or checklist');await bar.getByRole('button',{name:'Previous guide step'}).click();
    const discard=f.getByRole('dialog',{name:'Discard note changes?'});await expect(discard).toBeVisible();await expect(bar).toBeHidden();await discard.locator('[data-keep]').click();await expect(bar).toBeVisible();await expect(bar.locator('strong')).toHaveText('Create a note or checklist');await expect(f.locator('#m-note-title')).toHaveValue('Keep my unsaved guide example');
    await f.locator('#m-note-title').focus();const current=f.url();await page.keyboard.press('ArrowRight');assert.equal(f.url(),current);await expect(bar.locator('strong')).toHaveText('Create a note or checklist');await page.keyboard.press('Escape');await expect(bar).toHaveCount(0);await expect(f.locator('#m-note-title')).toHaveValue('Keep my unsaved guide example');
    await f.evaluate(()=>MobileWorkflow.start(GUIDE.byId['notes-scheduler'],1));await expect(bar).toBeVisible();await bar.getByRole('button',{name:'Previous guide step'}).click();await expect(discard).toBeVisible();await discard.locator('[data-confirm]').click();await expect(f.locator('#m-note-list')).toBeVisible();await expect(bar).toBeVisible();await expect(bar.locator('strong')).toHaveText('Open Notes');await bar.getByRole('button',{name:'Close guidance'}).click();await expect(bar).toHaveCount(0);
    const writes=await page.evaluate(()=>__scratchEvidence.filter(e=>e.method&&e.method!=='GET'));assert.deepEqual(writes,[]);const animations=await f.evaluate(()=>__workflowMotion);assert.deepEqual(animations,motion==='reduce'?[]:[180,100]);evidence.push({motion,theme,width,geometry,animations,draftRetained:true,writes:0});
  }
  await page.locator('.phone').evaluate((el,s)=>s===null?el.removeAttribute('style'):el.setAttribute('style',s),originalPhone);await page.locator('.layout').evaluate((el,s)=>s===null?el.removeAttribute('style'):el.setAttribute('style',s),originalLayout);await page.emulateMedia({reducedMotion:'no-preference'});await scenario('sales');return evidence;
}

export async function verifyWorkflowLifecycle({page,frame,scenario,ready,out}){
  await scenario('administrator');let f=frame();await library(f);await modal(f,'sales');await f.locator('[data-workflow-start]').click();await expect(f.locator('.guide-compact')).toBeVisible();await expect(f.locator('.guide-focus-ring')).toBeVisible();await f.locator('.guide-compact').getByRole('button',{name:'Next guide step'}).click();await expect(f.locator('.guide-compact strong')).toHaveText('Approve — with a stock check');
  // Existing records are removed/hidden by real queue reconciliations. A guide must not leave a ghost ring.
  await f.locator('[data-sales-list]').evaluate(el=>el.hidden=true);await expect(f.locator('.guide-focus-ring')).toBeHidden();await f.locator('[data-sales-list]').evaluate(el=>el.hidden=false);await expect(f.locator('.guide-focus-ring')).toBeVisible();
  await f.locator('#m-tabbar [data-tab=home]').click();await expect(f.locator('.guide-compact')).toHaveCount(0);await expect(f.locator('.guide-focus-ring')).toHaveCount(0);
  await page.locator('#network').selectOption('slow');await ready();f=frame();await library(f);await modal(f,'sales');await f.locator('[data-workflow-start]').click();await expect(f.locator('.guide-compact')).toBeVisible();await expect(f.locator('.guide-focus-ring')).toBeHidden();await expect(f.locator('[data-sales-list] .sales-order').first()).toBeVisible();await expect(f.locator('.guide-focus-ring')).toBeVisible();await f.locator('.guide-compact').getByRole('button',{name:'Close guidance'}).click();
  await page.locator('#network').selectOption('failed');await ready();f=frame();await library(f);await modal(f,'sales');await f.locator('[data-workflow-start]').click();await expect(f.locator('.guide-compact')).toBeVisible();await expect(f.locator('.guide-focus-ring')).toBeHidden();await expect(f.locator('.guide-locator')).toContainText('could not be loaded');await page.locator('.phone').screenshot({path:out+'/workflow-failed-target.png'});
  await f.evaluate(()=>{MApp.setMe({...MApp.getMe(),permissions:[],role:'revoked'});document.querySelector('#m-app').classList.add('access-changed');});await expect(f.locator('.guide-compact')).toHaveCount(0);await expect(f.locator('.guide-focus-ring')).toHaveCount(0);
  await page.locator('#network').selectOption('ready');await ready();await scenario('sales');return {hiddenTarget:true,tabExit:true,delayedTarget:true,failedTarget:true,revokedAccess:true};
}
