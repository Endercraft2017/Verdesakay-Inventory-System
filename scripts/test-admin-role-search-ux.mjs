// Real admin view/CSS with sample role and account APIs; no live writes.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const read=p=>fs.readFileSync(new URL('../public/'+p,import.meta.url),'utf8');
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
try {
 const page=await browser.newPage({viewport:{width:1475,height:740}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://roles.example/**',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><html data-theme="dark"><main id="view" class="main" data-route="admin"></main></html>'}));await page.goto('https://roles.example/');
 await page.addStyleTag({content:read('css/styles.css')+'\n'+read('css/visual-refresh.css')});
 await page.addScriptTag({content:`
 window.routes={};window.sample={edits:[],roles:[{key:'admin',label:'Administrator',description:'All workspace access',summary:'Every permission',user_count:1,fixed:true,staff:false},{key:'warehouse',label:'Warehouse staff',description:'Receiving and stock counts',summary:'Inventory · Receiving · Transfers',user_count:8,staff:true},{key:'payroll',label:'Payroll reviewer',description:'Reviews staff payroll',summary:'HR · Payslips',user_count:2,staff:false}],users:[{id:1,full_name:'Sample Admin',username:'sample',role:'admin',active:true}]};
 window.App={register:(name,fn)=>routes[name]=fn,hasPermission:()=>true,getDepartments:()=>[],navigate:async(name,filter)=>routes[name](document.getElementById('view'),filter)};
 window.API={get:async()=>structuredClone(sample.users)};
 window.UI={esc:s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),icon:()=>'<span class="ic" aria-hidden="true">＋</span>',toast:()=>{},emptyState:o=>'<p>'+o.title+'</p>'};
 window.AccessEditor={getCatalog:async()=>({roles:sample.roles}),roleLabel:k=>k,roleSummary:(catalog,key)=>catalog.roles.find(r=>r.key===key).summary,editRole:(r,opts)=>{sample.edits.push({key:r?.key||null,copy:opts?.copyFrom?.key||null});window.lastRoleOptions=opts}};
 `});
 await page.addScriptTag({content:read('js/modules/core/admin.js')});await page.evaluate(()=>App.navigate('admin',{tab:'roles'}));
 const search=page.getByRole('searchbox',{name:'Search roles'}),rows=page.locator('tr[data-role]');
 assert.equal(await rows.count(),3);assert.equal(await search.isVisible(),true);assert.equal(await page.locator('#user-search-box').isVisible(),false);assert.equal(await page.locator('#add-role').isVisible(),true);
 const intro=await page.locator('.admin-roles-intro').boundingBox(),help=await page.locator('.admin-roles-intro>p').first().boundingBox();assert.ok(help.x-intro.x>=19);assert.ok(help.y-intro.y>=17);
 assert.equal(await page.getByRole('columnheader',{name:'HR can assign'}).evaluate(el=>getComputedStyle(el).whiteSpace),'nowrap');
 for(const [q,key] of [['  WAREHOUSE  ','warehouse'],['stock counts','warehouse'],['Payslips','payroll'],['Every permission','admin']]){await search.fill(q);assert.equal(await rows.count(),1);assert.equal(await rows.first().getAttribute('data-role'),key)}
 await search.fill('no-matching-role');assert.equal(await rows.count(),0);await page.getByText('Showing 0 of 3 roles',{exact:true}).waitFor();await page.locator('[data-clear-role-search]').click();assert.equal(await rows.count(),3);assert.equal(await search.inputValue(),'');assert.equal(await search.evaluate(e=>e===document.activeElement),true);
 await search.fill('Warehouse');await page.locator('[data-role-edit=warehouse]').click();assert.deepEqual(await page.evaluate(()=>sample.edits.at(-1)),{key:'warehouse',copy:null});
 await page.evaluate(async()=>{sample.roles[1].label='Warehouse operations';await lastRoleOptions.onSaved()});assert.equal(await search.inputValue(),'Warehouse');assert.equal(await rows.count(),1);await page.getByText('Warehouse operations',{exact:true}).waitFor();
 await page.locator('[data-role-copy=warehouse]').click();assert.deepEqual(await page.evaluate(()=>sample.edits.at(-1)),{key:null,copy:'warehouse'});await search.fill('Administrator');assert.equal(await page.locator('[data-role-edit=admin]').count(),0);assert.equal(await page.locator('[data-role-del=admin]').count(),0);
 await search.fill('');if(process.env.ROLES_SCREENSHOT)await page.screenshot({path:process.env.ROLES_SCREENSHOT});
 await page.setViewportSize({width:720,height:760});assert.ok(await page.locator('.admin-roles-scroll').evaluate(e=>e.scrollWidth>e.clientWidth));assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.evaluate(()=>document.documentElement.setAttribute('data-theme','light'));await search.fill('Receiving');assert.equal(await rows.count(),1);
 await page.evaluate(()=>App.navigate('admin'));assert.equal(await search.isVisible(),false);assert.equal(await page.locator('#user-search-box').isVisible(),true);await page.locator('#user-search').fill('Sample');await page.locator('tr[data-open="1"]').waitFor();assert.deepEqual(errors,[]);
 console.log('PASS: Roles padding/header layout; scoped narrow-screen scrolling; role name/key/description/coverage search; case/whitespace normalization; result count and clear/focus; filtered role edit/copy/reload; fixed-role controls preserved; accounts search isolated; light/dark rendering; no runtime errors.');
}finally{await browser.close()}
