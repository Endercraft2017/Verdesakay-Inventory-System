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
  w.eval(['ui.js','guide-data.js','guide-tour.js','guide-center.js','modules/manufacturing/sop.js'].map(s=>fs.readFileSync(path.join(import.meta.dirname,'../public/js',s),'utf8')).join('\n;\n')+'\nwindow.__UI=UI;');await flush();
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
