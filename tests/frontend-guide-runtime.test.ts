import { it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
const flush=async()=>{for(let i=0;i<6;i++)await new Promise(r=>setTimeout(r,0));};
async function boot() {
  const dom=new JSDOM('<div id="view" class="main" data-route="dashboard"><div class="topbar"><h2>Home</h2></div><input id="menu-search"></div><div id="modal-root"></div><div id="drawer-root"></div><div id="toasts"></div>',{runScripts:'outside-only',url:'https://localhost/sandbox/'});const w=dom.window as any;await flush();
  const routes:Record<string,any>={},navigations:any[]=[];let userId=1;
  w.VDS_BASE_PATH='/sandbox';w.App={register:(r:string,fn:any)=>routes[r]=fn,currentLocation:()=>({route:'dashboard'}),getMe:()=>({id:userId}),hasModule:(m:string)=>['hr','home'].includes(m),canAccessRoute:(r:string)=>['dashboard','hr-requests','sop'].includes(r),navigate:(...args:any[])=>navigations.push(args)};
  w.NAV=[{id:'home',label:'Home',subtabs:[{label:'Overview',tree:[{label:'Dashboard',route:'dashboard'},{label:'Guide Center',route:'sop'},{label:'My HR',route:'hr-requests',filter:{tab:'requests'}},{label:'Forbidden',route:'admin'}]}]}];
  w.requestAnimationFrame=(cb:any)=>{cb(0);return 1;};w.HTMLElement.prototype.getBoundingClientRect=()=>({left:50,top:100,right:250,bottom:140,width:200,height:40});
  w.eval(['ui.js','guide-data.js','guide-tour.js','guide-instructions.js','guide-center.js','modules/manufacturing/sop.js'].map(s=>fs.readFileSync(path.join(import.meta.dirname,'../public/js',s),'utf8')).join('\n;\n')+'\nwindow.__UI=UI;');await flush();
  return {dom,w,routes,navigations,setUser:(id:number)=>userId=id};
}
it('filters catalog by access and supports search, empty results, recovery and module filters',async()=>{
  const {dom,w,routes}=await boot();const catalog=w.GuideCenter.catalog();expect(catalog.some((p:any)=>p.title==='Forbidden')).toBe(false);expect(catalog.some((p:any)=>p.id==='production')).toBe(false);expect(catalog.some((p:any)=>p.id==='file-request')).toBe(true);
  const feature=catalog.find((p:any)=>p.kind==='feature'&&p.route==='hr-requests');expect(feature.id).toContain('\"tab\"');
  const view=w.document.querySelector('#view');routes.sop(view,{});await flush();[...view.querySelectorAll('.guide-nav-item')].find((b:any)=>b.dataset.id===feature.id).click();expect(view.querySelector('.guide-hero h3').textContent).toBe('My HR');const search=w.document.querySelector('#guide-search');search.value='does-not-exist';search.dispatchEvent(new w.Event('input'));expect(view.textContent).toContain('No matching guides');search.value='';search.dispatchEvent(new w.Event('input'));expect(w.document.querySelector('.guide-hero')).not.toBeNull();
  w.document.querySelector('#guide-module').value='hr';w.document.querySelector('#guide-module').dispatchEvent(new w.Event('change'));expect([...w.document.querySelectorAll('.guide-nav-item:not([hidden])')].every((b:any)=>catalog.find((p:any)=>p.id===b.dataset.id).module==='hr')).toBe(true);dom.window.close();
});
it('opens contextual modal guides without discarding draft values or navigating, and Escape closes only coaching',async()=>{
  const {dom,w,navigations}=await boot();w.__UI.modal({title:'Draft form',bodyHTML:'<label for="draft-name">Name</label><input id="draft-name">',confirmText:'Save',onConfirm:()=>false});await flush();const draft=w.document.querySelector('.modal-overlay');draft.querySelector('input').value='Unsaved draft';draft.querySelector('input').dispatchEvent(new w.Event('input',{bubbles:true}));
  draft.querySelector('[data-guide-open]').click();await flush();expect(w.document.querySelector('#guide-context-start')).toBeNull();expect(w.document.querySelector('#draft-name').value).toBe('Unsaved draft');expect(navigations).toEqual([]);expect(w.document.querySelector('.guide-coach')).not.toBeNull();
  w.document.querySelector('#draft-name').dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));expect(w.document.querySelector('.guide-coach')).toBeNull();expect(w.document.querySelector('#draft-name').value).toBe('Unsaved draft');dom.window.close();
});
it('does not auto-navigate, waits for asynchronous controls, preserves progress on exit, and isolates users',async()=>{
  const {dom,w,navigations,setUser}=await boot();const guide={id:'test-tour',title:'Test',steps:[{title:'Open',body:'Open the screen',to:{route:'dashboard'},spot:'#later'},{title:'Next',body:'Continue'}]};
  w.GuideTour.start(guide);expect(navigations).toEqual([]);expect(w.document.querySelector('.guide-focus-ring').hidden).toBe(true);const target=w.document.createElement('button');target.id='later';w.document.querySelector('#view').append(target);await flush();expect(w.document.querySelector('.guide-focus-ring').hidden).toBe(false);
  w.document.querySelector('[data-act="open"]').click();expect(navigations).toEqual([['dashboard',undefined]]);w.document.querySelector('[data-act="next"]').click();w.document.querySelector('[data-act="close"]').click();expect(w.GuideTour.savedStep('test-tour')).toBe(1);setUser(2);expect(w.GuideTour.savedStep('test-tour')).toBe(0);setUser(1);w.GuideTour.start(guide,1);w.document.querySelector('[data-act="next"]').click();expect(w.GuideTour.savedStep('test-tour')).toBe(0);dom.window.close();
});
it('does not steal arrows from inputs and advances only after the expected dialog appears',async()=>{
  const {dom,w}=await boot();const button=w.document.createElement('button');button.id='open-dialog';w.document.querySelector('#view').append(button);
  w.GuideTour.start({id:'auto-step',title:'Open form',steps:[{title:'Open',body:'Choose the control',spot:'#open-dialog',advanceOn:'click',nextSpot:'#new-input'},{title:'Enter details',body:'Fill the form',spot:'#new-input'}]});
  button.click();await flush();expect(w.document.querySelector('.guide-coach-count').textContent).toBe('1 / 2');const input=w.document.createElement('input');input.id='new-input';w.document.querySelector('#view').append(input);await flush();expect(w.document.querySelector('.guide-coach-count').textContent).toBe('2 / 2');input.dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true,cancelable:true}));expect(w.document.querySelector('.guide-coach-count').textContent).toBe('2 / 2');dom.window.close();
});
it('Alt+Shift+G opens contextual guides and exposes only supported shortcut tips',async()=>{
  const {dom,w}=await boot();w.document.dispatchEvent(new w.KeyboardEvent('keydown',{code:'KeyG',key:'G',altKey:true,shiftKey:true,bubbles:true,cancelable:true}));expect(w.document.querySelector('.guide-coach')).not.toBeNull();expect(w.document.querySelector('#guide-context-start')).toBeNull();expect(w.GuideCenter.shortcutHTML(w.document.querySelector('#view'))).toContain('Alt + Shift + G');dom.window.close();
});
it('keeps contextual suggestions specific to the current form type and limits their number',async()=>{
  const {dom,w}=await boot();
  w.App.canAccessRoute=()=>true;w.App.hasModule=()=>true;
  w.NAV.push({id:'hr',label:'HR',subtabs:[{label:'Payroll',requiredModule:'hr',tree:[{label:'Payroll',route:'form-records',filter:{slug:'hr_payroll'}},{label:'Leave',route:'form-records',filter:{slug:'hr_leave'}}]}]});
  w.App.currentLocation=()=>({route:'form-records',filter:{slug:'hr_payroll'}});
  w.GuideCenter.open();
  const results=w.document.querySelector('#guide-context-results');
  expect(results.textContent).toContain('Payroll');expect(results.textContent).not.toContain('Production');expect(results.textContent).not.toContain('Sales orders');expect(results.textContent).not.toContain('Leave');
  expect(results.querySelectorAll('[data-guide-id]').length).toBeLessThanOrEqual(4);
  const search=w.document.querySelector('#guide-context-search');search.value='production';search.dispatchEvent(new w.Event('input'));
  expect(results.textContent).toContain('No related guides match');search.value='';search.dispatchEvent(new w.Event('input'));expect(results.textContent).toContain('Payroll');
  expect(w.document.querySelector('#guide-center-open')).not.toBeNull();
  const items=w.GuideCenter.catalog();expect(w.GuideCenter.suggestions(items,{route:'form-builder'}).some((p:any)=>p.id==='build-form')).toBe(true);
  expect(w.GuideCenter.suggestions(items,{route:'hr-approvals'}).some((p:any)=>p.id==='review-requests')).toBe(true);
  const root=w.document.createElement('div');root.innerHTML='<input id="note-title">';expect(w.GuideCenter.suggestions(items,{route:'form-records',filter:{slug:'hr_payroll'}},root).map((p:any)=>p.id)).toEqual(['notes-scheduler']);
  dom.window.close();
});
it('starts payroll coaching directly and replaces an on-screen feature reference with real control steps',async()=>{
  const {dom,w,navigations}=await boot();w.App.currentLocation=()=>({route:'form-records',filter:{slug:'hr_payroll'}});
  const view=w.document.querySelector('#view');view.innerHTML='<div class="topbar"><h2>HR Payroll</h2></div><input id="fr-search"><select id="fr-status"></select><select id="fr-period"></select><button id="fr-print-summary">Print Summary</button><button id="fr-download-csv">Download Excel</button>';await flush();
  view.querySelector('[data-guide-open]').click();
  expect(navigations).toEqual([]);expect(w.document.querySelector('#guide-context-results')).toBeNull();expect(w.document.querySelector('.guide-coach-body').textContent).toContain('Find an employee');expect(w.document.querySelector('.guide-coach-count').textContent).toBe('1 / 5');expect(w.document.querySelector('[data-act="open"]')).toBeNull();
  w.GuideTour.start({id:'feature:payroll',kind:'feature',route:'form-records',filter:{slug:'hr_payroll'},steps:[{title:'Open Payroll',body:'Open the guide again'}]});
  expect(w.document.querySelector('.guide-coach-body').textContent).not.toContain('Open the guide again');expect(w.document.querySelector('.guide-coach-body').textContent).toContain('Find an employee');expect(navigations).toEqual([]);dom.window.close();
});
it('highlights and numbers every payroll step without changing the page or submitting actions',async()=>{
  const {dom,w,navigations}=await boot();w.App.currentLocation=()=>({route:'form-records',filter:{slug:'hr_payroll'}});
  const view=w.document.querySelector('#view');view.innerHTML='<div class="topbar"><h2>HR Payroll</h2></div><input id="fr-search"><select id="fr-status"></select><select id="fr-period"></select><div id="fr-table"></div><button id="fr-print-summary">Print Summary</button><button id="fr-download-csv">Download Excel</button>';
  const guide=w.GuideCenter.contextual(view);expect(guide.steps).toHaveLength(6);w.GuideCenter.start({root:view});
  for(let i=0;i<guide.steps.length;i++){const ring=w.document.querySelector('.guide-focus-ring');expect(ring.hidden).toBe(false);expect(ring.dataset.step).toBe(String(i+1));expect(ring.style.width).toBe('210px');if(i+1<guide.steps.length)w.document.querySelector('[data-act="next"]').click();}
  expect(navigations).toEqual([]);dom.window.close();
});
it('explains employee actions and icon-only numbering settings with concrete instructions',async()=>{
  const {dom,w}=await boot();w.App.currentLocation=()=>({route:'hr-employees'});const view=w.document.querySelector('#view');view.innerHTML='<h2>Employees</h2><input id="emp-search"><select id="emp-dept-filter"></select><select id="emp-status-filter"></select><div id="emp-table"></div><button id="emp-new">New Employee</button><button id="emp-import">Import</button><button id="emp-no-settings" aria-label="Employee numbering format"></button>';
  const guide=w.GuideCenter.contextual(view);const gear=guide.steps.find((s:any)=>s.target.id==='emp-no-settings');expect(gear.title).toBe('Set the employee numbering format');expect(gear.body).toContain('prefix');expect(gear.body).toContain('zero-padding');expect(gear.body).toContain('Save');expect(guide.steps.find((s:any)=>s.target.id==='emp-import').body).toContain('employee_no');expect(guide.steps.every((s:any)=>s.title && !s.body.includes('Use this control when'))).toBe(true);dom.window.close();
});
it('gives concrete instructions across module controls and personal tools without circular help',async()=>{
  const {dom,w}=await boot();const view=w.document.querySelector('#view');w.App.currentLocation=()=>({route:'inventory'});
  view.innerHTML='<h2>Inventory</h2><input id="inv-search"><button id="inv-import">Import</button><button id="inv-reorder">Reorder PO</button><button id="inv-labels">Labels</button><button id="inv-add" hidden>New item</button>';
  let guide=w.GuideCenter.contextual(view);expect(guide.steps.find((s:any)=>s.target.id==='inv-import').body).toContain('matched by SKU');expect(guide.steps.find((s:any)=>s.target.id==='inv-labels').body).toContain('print sheet');expect(guide.steps.some((s:any)=>s.target.id==='inv-add')).toBe(false);
  view.innerHTML='<h2>Approvals</h2><input id="ap-search"><button id="ap-authorities">Department approvers</button>';w.App.currentLocation=()=>({route:'hr-approvals'});guide=w.GuideCenter.contextual(view);expect(guide.steps.find((s:any)=>s.target.id==='ap-authorities').body).toContain('HR can step in');
  w.__UI.modal({title:'Email',bodyHTML:'<input id="em-to"><input id="em-subj"><textarea id="em-body"></textarea>',confirmText:'Send'});const root=w.document.querySelector('.modal-overlay');guide=w.GuideCenter.contextual(root);expect(guide.steps.find((s:any)=>s.target.id==='em-to').body).toContain('recipient');expect(guide.steps.at(-1).title).toBe('Send');expect(guide.steps.at(-1).body).toContain('press Send');expect(w.GuideCenter.catalog().filter((p:any)=>p.id.startsWith('tool:')).every((p:any)=>!p.steps.some((s:any)=>s.body.includes('Use the Guide button')))).toBe(true);
  const doc=w.GUIDE.byId['document-editing'];expect(doc.steps[0].to.route).toBe('templates');expect(doc.steps[1].spot).toBe('.doc-surface');dom.window.close();
});
it('uses a custom field label and description, preserving entered values and excluding hidden fields',async()=>{
  const {dom,w}=await boot();w.__UI.modal({title:'Custom request',bodyHTML:'<div><label>Reason *</label><textarea data-f="reason" aria-describedby="reason-help"></textarea><p id="reason-help">Explain why you need the requested dates.</p></div><div hidden><label>Hidden flag</label><input data-f="hidden_flag"></div>',confirmText:'Submit request'});
  const root=w.document.querySelector('.modal-overlay');root.querySelector('textarea').value='Personal details';const guide=w.GuideCenter.contextual(root);expect(guide.steps[0].title).toBe('Reason');expect(guide.steps[0].body).toContain('Explain why');expect(guide.steps.some((s:any)=>s.title==='Hidden flag')).toBe(false);expect(JSON.stringify(guide.steps.map((s:any)=>({title:s.title,body:s.body})))).not.toContain('Personal details');expect(root.querySelector('textarea').value).toBe('Personal details');dom.window.close();
});
it('hands a feature walkthrough to its actual controls only after explicit navigation and screen loading',async()=>{
  const {dom,w,navigations}=await boot();w.App.canAccessRoute=()=>true;w.GuideTour.start({id:'feature:approval',kind:'feature',title:'Approvals',route:'hr-approvals',steps:[{title:'Open approvals',to:{route:'hr-approvals'},body:'Review pending requests.'}]});expect(navigations).toEqual([]);w.document.querySelector('[data-act="open"]').click();expect(navigations).toEqual([['hr-approvals',undefined]]);
  w.App.currentLocation=()=>({route:'hr-approvals'});const view=w.document.querySelector('#view');view.dataset.route='hr-approvals';view.innerHTML='<h2>Approvals</h2><p>Loading…</p>';await flush();expect(w.document.querySelector('.guide-coach h4').textContent).toBe('Open approvals');view.innerHTML='<h2>Approvals</h2><input id="ap-search"><div id="ap-list"></div>';await flush();expect(w.document.querySelector('.guide-coach h4').textContent).toBe('Find a request');expect(w.document.querySelector('[data-act="open"]')).toBeNull();expect(w.document.querySelector('.guide-focus-ring').hidden).toBe(false);dom.window.close();
});
it('switches contextual guide depth without navigation or changing the underlying inputs',async()=>{
  const {dom,w,navigations}=await boot();const root=w.document.querySelector('#view');root.innerHTML='<h2>Example</h2><input aria-label="First"><input aria-label="Second"><input aria-label="Third"><input aria-label="Fourth"><input aria-label="Fifth">';root.querySelector('input').value='Draft';w.GuideCenter.start({root});let select=w.document.querySelector('[data-act=depth]');select.value='brief';select.dispatchEvent(new w.Event('change'));expect(w.document.querySelector('.guide-coach-count').textContent).toBe('1 / 3');select=w.document.querySelector('[data-act=depth]');select.value='detailed';select.dispatchEvent(new w.Event('change'));expect(w.document.querySelector('.guide-coach-count').textContent).toBe('1 / 5');expect(root.querySelector('input').value).toBe('Draft');expect(navigations).toEqual([]);dom.window.close();
});

it('places Guide in a custom page header without a separate spacer row',async()=>{
 const {dom,w}=await boot();const view=w.document.querySelector('#view');view.innerHTML='<section><header data-page-header><h2>Library</h2><div data-page-actions><button>Create template</button></div></header></section>';await flush();expect(view.querySelector('.guide-screen-anchor')).toBeNull();expect(view.querySelector('[data-page-actions] [data-guide-open]')).not.toBeNull();dom.window.close();
});

it('does not duplicate an editor toolbar guide',async()=>{
 const {dom,w}=await boot();const editor=w.document.createElement('div');editor.className='doc-fs';editor.innerHTML='<header class="doc-fs-bar"><button data-help>Guide</button></header>';w.document.body.append(editor);await flush();expect(editor.querySelector('[data-guide-open]')).toBeNull();expect(editor.querySelectorAll('[data-help]').length).toBe(1);dom.window.close();
});

it('shows cross-module pipelines with prerequisites, handoffs and access-aware screen links', async () => {
  const {dom,w,routes,navigations}=await boot();
  const view=w.document.querySelector('#view');
  w.App.canAccessRoute=(r:string)=>r==='hr-timekeeping' || r==='sop';
  routes.sop(view,{section:'pipelines'});
  const buttons=[...view.querySelectorAll('.guide-nav-item:not([hidden])')];
  expect(buttons.length).toBeGreaterThan(0);
  expect(buttons.every((b:any)=>w.GUIDE.byId[b.dataset.id]?.pipeline)).toBe(true);
  expect(view.querySelector('[data-guide-section="pipelines"]').getAttribute('aria-pressed')).toBe('true');
  for(const guide of w.GUIDE.pipelines.filter((p:any)=>p.pipeline)) {
    expect(guide.steps.every((s:any)=>s.before && s.result && s.role && s.module)).toBe(true);
  }
  expect(view.querySelectorAll('.pipeline-roadmap a').length).toBeGreaterThan(0);
  expect(view.textContent).toContain('Before you start:');
  expect(view.textContent).toContain('Result / handoff:');
  expect(navigations).toEqual([]);
  view.querySelector('[data-guide-section="all"]').click();
  expect(view.querySelector('[data-guide-section="all"]').getAttribute('aria-pressed')).toBe('true');
  dom.window.close();
});

it('renders direction arrows and conditional sales branches without running business actions', async () => {
  const {dom,w,routes,navigations}=await boot();
  w.App.hasModule=()=>true;w.App.canAccessRoute=()=>true;
  const view=w.document.querySelector('#view');
  routes.sop(view,{topic:'sales-to-cash'});
  expect(view.querySelectorAll('.workflow-stop')).toHaveLength(11);
  expect(view.querySelectorAll('.workflow-connector')).toHaveLength(10);
  expect(view.querySelectorAll('.workflow-branch')).toHaveLength(3);
  expect(view.querySelector('.workflow-terminal')?.textContent).toContain('START');
  expect(view.querySelector('.workflow-finish')?.textContent).toContain('FINISH');
  expect(view.textContent).toContain('Already in stock?');
  expect(view.textContent).toContain('Inspection failed?');
  expect(view.querySelector('.workflow-branch button').dataset.pipelineStep).toBe('8');
  expect(navigations).toEqual([]);
  dom.window.close();
});
