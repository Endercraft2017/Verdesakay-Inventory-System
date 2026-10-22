import {it,expect} from 'vitest';
import {JSDOM} from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
const flush=async()=>{for(let i=0;i<8;i++)await new Promise(r=>setTimeout(r,0));};
async function boot(api:any){
  const dom=new JSDOM('<button id="m-guide-start">Guide</button><div id="m-title"></div><div id="m-view"></div><div id="m-toasts"></div>',{runScripts:'outside-only',url:'https://localhost/sandbox/m#/work'}),w=dom.window as any;await flush();
  const routes:any={},navigations:any[]=[];let loc={name:'work',params:{}};const view=w.document.querySelector('#m-view');
  w.API=api;w.confirm=()=>true;w.VDS_BASE_PATH='/sandbox';w.MApp={route:(n:string,f:any)=>routes[n]=f,setTitle:(t:string)=>w.document.querySelector('#m-title').textContent=t,getMe:()=>({id:1,role:'employee'}),can:()=>false,canOpen:()=>false,hasModule:()=>true,canApprove:()=>false,refreshAccess:async()=>{},currentLocation:()=>loc,go:(n:string,p:any={})=>{if(w.mPersonalDraft&&!w.mPersonalDraft.allow('#/'+n))return;navigations.push([n,p]);loc={name:n,params:p};w.location.hash='#/'+n;view.dataset.route=n;if(routes[n])routes[n](view,p);},render:()=>{view.dataset.route=loc.name;if(routes[loc.name])routes[loc.name](view,loc.params);}};
  w.requestAnimationFrame=(f:any)=>{f();return 1;};w.HTMLElement.prototype.getBoundingClientRect=()=>({left:30,top:100,right:230,bottom:140,width:200,height:40});
  for(const file of ['mobile/lib/dom.js','js/lib/photo-viewer.js','js/personal-ux.js','mobile/lib/personal.js','js/guide-data.js','js/guide-search.js','mobile/lib/guides.js','js/guide-tour.js','mobile/modules/core/tasks.js','mobile/modules/core/notes.js','mobile/modules/core/guides.js','mobile/modules/hr/work.js'])w.eval(fs.readFileSync(path.join(import.meta.dirname,'../public',file),'utf8'));
  await flush();return {dom,w,view,navigations,routes,go:async(n:string,p:any={})=>{w.MApp.go(n,p);await flush();}};
}
it('Work reads shared tasks and opens the selected task and linked note',async()=>{
  const calls:string[]=[];const note={id:8,title:'Payroll',body:'Context',checklist:[{id:'a',text:'Review',done:false}],scheduled_task:{id:12,due_date:'2026-11-03 09:00'}};const task={id:12,title:'Payroll',note_id:8,due_date:'2026-11-03 09:00',notes:'Context'};
  const {dom,w,view,navigations,go}=await boot({get:async(p:string)=>{calls.push(p);return p==='/notes'?[note]:[task];}});await go('work');expect(calls).toContain('/tasks');expect(calls).not.toContain('/personal/tasks');view.querySelector('.v2-work-list button').click();await flush();expect(navigations.at(-1)).toEqual(['tasks',{id:12}]);expect(view.querySelector('[data-title]').readOnly).toBe(true);view.querySelector('[data-open-note]').click();await flush();expect(navigations.at(-1)).toEqual(['notes',{id:8}]);expect(view.querySelector('#m-note-items [data-text]').value).toBe('Review');dom.window.close();
});
it('creates a checklist-only note, retries a failed schedule without a duplicate, and highlights without saving',async()=>{
  const calls:any[]=[];let fail=true;const api={get:async()=>[],post:async(p:string,b:any)=>{calls.push(['POST',p,b]);if(p.endsWith('/schedule')&&fail){fail=false;throw Error('Network issue');}return {id:p==='/notes'?8:12};},put:async(p:string,b:any)=>{calls.push(['PUT',p,b]);return {ok:true};}};
  const {dom,w,view,go}=await boot(api);await go('notes',{new:1});view.querySelector('#m-note-title').value='Review payroll';view.querySelector('#m-note-item').value='Inspect attendance';view.querySelector('#m-note-item').dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));expect(view.querySelectorAll('[data-text]')).toHaveLength(1);
  w.document.querySelector('#m-guide-start').click();expect(w.document.querySelector('.guide-focus-ring').hidden).toBe(false);expect(calls).toHaveLength(0);expect(view.querySelector('#m-note-title').value).toBe('Review payroll');w.GuideTour.close();view.querySelector('#m-note-scheduled').checked=true;view.querySelector('#m-note-scheduled').dispatchEvent(new w.Event('change'));view.querySelector('#m-note-due').value='2026-11-03T09:00';view.querySelector('#m-note-remind').value='2026-11-03T08:30';view.querySelector('form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await flush();expect(view.querySelector('#m-note-error').textContent).toContain('Note saved');expect(calls[0][2].checklist[0].text).toBe('Inspect attendance');expect(calls[1][2].remind_at).toMatch(/Z$/);view.querySelector('form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await flush();expect(calls.filter(c=>c[0]==='POST'&&c[1]==='/notes')).toHaveLength(1);expect(calls.some(c=>c[0]==='PUT'&&c[1]==='/notes/8')).toBe(true);dom.window.close();
});
it('updates checklist completion and removes a schedule while preserving the note',async()=>{
  const calls:any[]=[];const note={id:8,title:'Payroll',body:'',checklist:[{id:'a',text:'Review',done:false}],scheduled_task:{id:12,due_date:'2026-11-03 09:00'}};
  const {dom,w,view,go}=await boot({get:async()=>[note],put:async(p:string,b:any)=>{calls.push(['PUT',p,b]);return {};},del:async(p:string)=>{calls.push(['DELETE',p]);return {};}});await go('notes',{id:8});view.querySelector('[data-check]').checked=true;view.querySelector('[data-check]').dispatchEvent(new w.Event('change'));view.querySelector('#m-note-scheduled').checked=false;view.querySelector('#m-note-scheduled').dispatchEvent(new w.Event('change'));view.querySelector('form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await flush();expect(calls[0][2].checklist[0].done).toBe(true);expect(calls[1]).toEqual(['DELETE','/tasks/12']);expect(calls.some(c=>c[0]==='DELETE'&&c[1]==='/notes/8')).toBe(false);dom.window.close();
});
it('protects unsaved notes and task schedules and does not mutate a linked note through task editing',async()=>{
  const calls:any[]=[];const task={id:12,title:'Linked note',note_id:8,notes:'[ ] Checklist',due_date:'2026-11-03 09:00'};
  const {dom,w,view,go}=await boot({get:async()=>[task],put:async(p:string,b:any)=>{calls.push([p,b]);return {};}});await go('tasks',{id:12});view.querySelector('[data-due]').value='2026-11-04T10:00';w.confirm=()=>false;w.MApp.go('work');expect(view.querySelector('[data-due]').value).toBe('2026-11-04T10:00');expect(w.document.querySelector('[role=dialog]').getAttribute('aria-label')).toBe('Discard task changes?');w.document.querySelector('[data-keep]').click();view.querySelector('form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await flush();expect(calls[0][1]).toMatchObject({due_date:'2026-11-04 10:00'});expect(calls[0][1].title).toBeUndefined();expect(calls[0][1].notes).toBeUndefined();w.confirm=()=>true;await go('notes',{new:1});view.querySelector('#m-note-body').value='Unsaved';w.confirm=()=>false;w.MApp.go('work');expect(view.querySelector('#m-note-body').value).toBe('Unsaved');expect(w.document.querySelector('[role=dialog]').getAttribute('aria-label')).toBe('Discard note changes?');w.document.querySelector('[data-keep]').click();dom.window.close();
});
it('does not overwrite another screen when an earlier note fetch finishes late',async()=>{
  let resolve:any;const {dom,w,view,go}=await boot({get:()=>new Promise(r=>resolve=r)});await go('notes');w.mPersonalDraft.clear();view.innerHTML='<p>Another screen</p>';resolve([{id:1,title:'Old note',body:'Old'}]);await flush();expect(view.textContent).toBe('Another screen');dom.window.close();
});
it('offers a searchable shared phone guide library without navigating from search or losing a draft',async()=>{
  const {dom,w,view,navigations,go}=await boot({get:async()=>[]});await go('guides');const search=view.querySelector('#m-guide-search');search.value='checklist';search.dispatchEvent(new w.Event('input'));expect(view.textContent).toContain('Turn a note');search.value='no-such-guide';search.dispatchEvent(new w.Event('input'));expect(view.textContent).toContain('No matching guides');search.value='';search.dispatchEvent(new w.Event('input'));const count=navigations.length;expect(view.querySelectorAll('details').length).toBeGreaterThan(5);expect(navigations).toHaveLength(count);view.querySelector('[data-open-notes]').click();await flush();expect(navigations.at(-1)[0]).toBe('notes');dom.window.close();
});
it('offers relative reminders, visible dirty/saving status, and a brief guide without writes',async()=>{
  const calls:any[]=[];let complete:any;const {dom,w,view,go}=await boot({get:async()=>[],post:(p:string,b:any)=>{calls.push([p,b]);return new Promise(r=>complete=r);}});await go('notes',{new:1});expect(view.querySelector('[data-save-status]').textContent).toBe('Not saved yet');view.querySelector('#m-note-body').value='Remember this';view.querySelector('#m-note-body').dispatchEvent(new w.Event('input',{bubbles:true}));expect(view.querySelector('[data-save-status]').textContent).toBe('Unsaved changes');expect(view.querySelector('.personal-editor-actions #m-note-save')).not.toBeNull();
  view.querySelector('#m-note-scheduled').checked=true;view.querySelector('#m-note-scheduled').dispatchEvent(new w.Event('change'));const due=view.querySelector('#m-note-due');due.value='2026-11-04T10:00';due.dispatchEvent(new w.Event('input',{bubbles:true}));const preset=view.querySelector('.personal-reminder-choice select');preset.value='30';preset.dispatchEvent(new w.Event('change',{bubbles:true}));expect(view.querySelector('#m-note-remind').value).toBe('2026-11-04T09:30');due.value='2026-11-05T11:00';due.dispatchEvent(new w.Event('input',{bubbles:true}));expect(view.querySelector('#m-note-remind').value).toBe('2026-11-05T10:30');
  w.document.querySelector('#m-guide-start').click();const depth=w.document.querySelector('[data-act=depth]');depth.value='brief';depth.dispatchEvent(new w.Event('change'));expect(w.document.querySelector('.guide-coach-count').textContent).toBe('1 / 3');expect(calls).toHaveLength(0);expect(view.querySelector('#m-note-body').value).toBe('Remember this');w.GuideTour.close();view.querySelector('form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));expect(view.querySelector('[data-save-status]').textContent).toBe('Saving…');complete({id:11});await flush();complete({id:20});await flush();dom.window.close();
});
it('saves checklist ticks immediately from phone cards and shows due/reminder previews',async()=>{
  let note:any={id:8,title:'Review payroll',body:'',checklist:[{id:'a',text:'Review attendance',done:false}],scheduled_task:{id:12,due_date:'2026-11-05 10:00',remind_at:'2026-11-05T01:00:00.000Z'}};const calls:any[]=[];
  const {dom,w,view,go}=await boot({get:async()=>[note],put:async(p:string,b:any)=>{calls.push([p,b]);note={...note,...b};return {};}});await go('notes');expect(view.textContent).toContain('Due');expect(view.textContent).toContain('Reminder');const input=view.querySelector('[data-preview]');input.checked=true;input.dispatchEvent(new w.Event('change'));await flush();expect(calls[0][0]).toBe('/notes/8');expect(calls[0][1].checklist[0].done).toBe(true);expect(view.querySelector('[data-preview]').checked).toBe(true);dom.window.close();
});
it('explains unscheduling and keeps the task when removal is declined',async()=>{
  const calls:any[]=[];const note={id:8,title:'Payroll',body:'Context',checklist:[],scheduled_task:{id:12,due_date:'2026-11-03 09:00'}};
  const {dom,w,view,go}=await boot({get:async()=>[note],put:async(...args:any[])=>calls.push(args),del:async(...args:any[])=>calls.push(args)});await go('notes',{id:8});view.querySelector('#m-note-scheduled').checked=false;view.querySelector('#m-note-scheduled').dispatchEvent(new w.Event('change'));expect(view.querySelector('[data-unschedule-note]').textContent).toContain('note and checklist stay');w.confirm=()=>false;view.querySelector('form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await flush();expect(calls).toHaveLength(0);expect(view.querySelector('[data-delete]').closest('details')).not.toBeNull();dom.window.close();
});
it('preserves date-only deadlines in the editor without silently writing a new schedule',async()=>{
  const calls:any[]=[];const {dom,w,view,go}=await boot({get:async()=>[{id:1,title:'All-day task',due_date:'2026-11-05'}],put:async(...a:any[])=>calls.push(a)});await go('tasks',{id:1});expect(view.querySelector('[data-due]').value).toBe('2026-11-05T09:00');expect(calls).toHaveLength(0);view.querySelector('[data-title]').value='Updated title';view.querySelector('form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await flush();expect(calls[0][1].due_date).toBe('2026-11-05');dom.window.close();
});

it('shows current workflow handoffs and conditional recovery branches in the phone guide library',async()=>{
 const {dom,w,view,go}=await boot({get:async()=>[]});
 await go('guides');
 const section=view.querySelector('#m-guide-section');section.value='pipelines';section.dispatchEvent(new w.Event('change'));
 expect(view.querySelectorAll('.m-guide-reference').length).toBe(w.GUIDE.pipelines.filter((p:any)=>p.pipeline).length);
 const search=view.querySelector('#m-guide-search');search.value='rejected on inspection';search.dispatchEvent(new w.Event('input'));
 // Search the stage and handoff, not just the compact guide title.
 search.value='customer return';search.dispatchEvent(new w.Event('input'));
 expect(view.textContent).toContain('Result / handoff:');
 expect(view.textContent).toContain('Rejected on inspection?');
 expect(view.querySelector('.m-pipeline-path')).not.toBeNull();
 dom.window.close();
});

it('Work guide explains only displayed account tasks and distinguishes receipts from release stock effects',async()=>{
 const {dom,w,view,go,navigations}=await boot({get:async()=>[]});
 w.MApp.can=(p:string)=>['inventory.receive','orders.release','production.receive','orders.direct_sale'].includes(p);
 w.MApp.canOpen=(r:string)=>['receive','so','allocate','receiving'].includes(r);
 w.mRtsRecovery={count:()=>0};
 await go('work');
 const visible=[...view.querySelectorAll('[data-work-guide]')].map((e:any)=>e.dataset.workGuideTitle);
 const steps=w.MobileGuide.steps(view);
 expect(steps.slice(1).map((s:any)=>s.title)).toEqual(visible);
 const pr=steps.find((s:any)=>s.title==='Receive supplier delivery');expect(pr.body).toContain('supplier');expect(pr.body).toContain('vendor bill');
 const rts=steps.find((s:any)=>s.title==='RTS recording');expect(rts.body).toContain('final-passed');expect(rts.body).toContain('separate from Receive supplier delivery');
 expect(steps.find((s:any)=>s.title==='Release orders').body).toContain('Picking holds stock');
 expect(steps.find((s:any)=>s.title==='Allocate units').body).toContain('removes stock immediately');
 expect(steps.some((s:any)=>s.title==='QC technical inspection')).toBe(false);
 const before=navigations.length;
 w.MobileGuide.start();
 expect(w.document.querySelector('[data-act=depth]')).toBeNull();
 for(const step of steps){expect(w.document.querySelector('.guide-coach h4').textContent).toBe(step.title);w.document.querySelector('[data-act=next]').click();}
 expect(navigations).toHaveLength(before);
 dom.window.close();
});

it('Work guide separates permission-specific queues that share a route and refreshes after access removal',async()=>{
 const {dom,w,view,go}=await boot({get:async(p:string)=>p.startsWith('/qc/queue')?{units:[]}:[]});
 let grants=new Set(['production.inspect_qc']);
 w.MApp.can=(p:string)=>grants.has(p);w.MApp.canOpen=(r:string)=>r==='qc';
 await go('work');
 let steps=w.MobileGuide.steps(view);
 expect(steps.some((s:any)=>s.title==='QC technical inspection')).toBe(true);
 expect(steps.some((s:any)=>s.title==='QA appearance inspection')).toBe(false);
 expect(steps.some((s:any)=>s.title==='QA holds')).toBe(false);
 w.MobileGuide.start();
 grants=new Set(['production.qa_review']);w.mProductionDrafts={listActions:async()=>[]};
 w.MApp.render();await flush();
 expect(w.document.querySelector('.guide-coach')).toBeNull();
 steps=w.MobileGuide.steps(view);
 expect(steps.some((s:any)=>s.title==='QC technical inspection')).toBe(false);
 expect(steps.find((s:any)=>s.title==='QA holds').body).toContain('QA-review authority');
 dom.window.close();
});

it('a personal-only account gets its own task and tools explained without warehouse queues',async()=>{
 const {dom,w,view,go}=await boot({get:async()=>[{id:92,title:'<Review customer email>',done:false}]});
 await go('work');
 const steps=w.MobileGuide.steps(view);
 expect(steps.some((s:any)=>s.title==='Receive supplier delivery')).toBe(false);
 expect(steps.some((s:any)=>s.title==='Release orders')).toBe(false);
 const personal=steps.find((s:any)=>s.title==='<Review customer email>');expect(personal.body).toContain('personal task');
 w.MobileGuide.start();w.document.querySelector('[data-act=next]').click();
 expect(w.document.querySelector('.guide-coach h4').textContent).toBe('<Review customer email>');
 expect(w.document.querySelector('.guide-coach h4 review')).toBeNull();
 expect(steps.some((s:any)=>s.title==='Notes / checklists')).toBe(true);
 dom.window.close();
});

it('jumps directly to a visible Work explanation and highlights stock effects without opening the task',async()=>{
 const {dom,w,view,go,navigations}=await boot({get:async()=>[]});
 w.MApp.can=(p:string)=>['inventory.receive','orders.release','orders.direct_sale'].includes(p);w.MApp.canOpen=(r:string)=>['receive','so','allocate'].includes(r);
 await go('work');const before=navigations.length;
 const steps=w.MobileGuide.steps(view);w.MobileGuide.start();
 let select=w.document.querySelector('[data-act=jump]');
 expect([...select.options].map((o:any)=>o.textContent)).toEqual(steps.map((s:any,i:number)=>`${i+1}. ${s.title}`));
 const release=steps.findIndex((s:any)=>s.title==='Release orders');
 select.value=String(release);select.dispatchEvent(new w.Event('change'));
 expect(w.document.querySelector('.guide-coach h4').textContent).toBe('Release orders');
 expect(w.document.querySelector('.work-guide-effect').textContent).toContain('Picking reserves');
 w.document.querySelector('[data-act=next]').click();
 expect(w.document.querySelector('.guide-coach h4').textContent).toBe(steps[release+1].title);
 select=w.document.querySelector('[data-act=jump]');const allocate=steps.findIndex((s:any)=>s.title==='Allocate units');
 select.value=String(allocate);select.dispatchEvent(new w.Event('change'));
 expect(w.document.querySelector('.work-guide-effect').textContent).toContain('deducts units immediately');
 expect(navigations).toHaveLength(before);
 dom.window.close();
});

it('explains physical identity before QC and the legacy-intake/sticker gates before RTS',async()=>{
 const {dom,w,view,go}=await boot({get:async()=>[]});
 await go('qc');view.innerHTML='<button data-jo="1">LI group</button><input id="qc-identity" type="checkbox"><button id="qc-start">Start</button>';
 let steps=w.MobileGuide.steps(view);
 expect(steps.find((s:any)=>s.title==='Match the physical unit first').body).toContain('not required before Products In');
 await go('receiving');view.innerHTML='<button id="rts-legacy">Enter pre-system unit</button><input data-legacy-identifier><input data-legacy-cost><button id="legacy-submit">Send to QC</button><button id="rts-print-labels">Print</button><div data-label-verification>Scan</div><button id="rts-post">Post</button>';
 steps=w.MobileGuide.steps(view);
 expect(steps.find((s:any)=>s.title==='Enter or resume a pre-system unit').body).toContain('both QC and QA');
 expect(steps.find((s:any)=>s.title==='Scan each attached sticker').body).toContain('Camera-scan');
 expect(steps.find((s:any)=>s.title==='Confirm RTS stock-in').body).toContain('Only confirmed Products In adds stock');
 dom.window.close();
});

it('clarifies a mobile task description and opens the selected authored workflow without performing work',async()=>{
 const {dom,w,view,go,navigations}=await boot({get:async()=>[]});await go('guides');const before=navigations.length;
 view.querySelector('[data-intent-input]').value='receive goods';view.querySelector('[data-intent-form]').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
 expect(view.querySelectorAll('[data-intent-choice]')).toHaveLength(3);
 view.querySelector('[data-intent-choice="0"]').click();expect(view.querySelector('.guide-retrieval-source').textContent).toContain('Purchasing');
 view.querySelector('[data-intent-select]').click();
 expect(view.querySelector('[data-guide-id="purchase-to-pay"]').open).toBe(true);
 expect(navigations).toHaveLength(before);dom.window.close();
});
