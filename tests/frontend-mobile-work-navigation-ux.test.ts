import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
const read=(p:string)=>fs.readFileSync(new URL('../public/'+p,import.meta.url),'utf8');
const tick=async()=>{for(let i=0;i<35;i++)await Promise.resolve();};
const defer=()=>{let resolve!:(v:any)=>void,reject!:(v:any)=>void;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
let dom:JSDOM,w:any,view:HTMLElement,routes:any,get:any,navigate:any,token:string,me:any;
const release=(rows:any[]=[{id:11,number:'SO-11',customer_name:'Fictional customer',status:'pending'}])=>({to_accept:rows,releasing:[]});
const users=[{id:1,full_name:'Self',active:1},{id:2,full_name:'Fictional Ana',department_name:'HR',role:'hr_staff',active:1},{id:3,full_name:'Fictional Ben',department_name:'Warehouse',role:'warehouse'},{id:4,full_name:'Inactive',active:0}];
const task={id:21,title:'Private task',done:false};
async function boot(route='work',params:any={},personal=false){
 dom=new JSDOM('<div id="m-app"><button id="m-guide-start">Guide</button><span id="m-title"></span><main id="m-view"></main></div><div id="m-toasts"></div>',{runScripts:'outside-only',url:'https://review.example/m/#/'+route,pretendToBeVisual:true});w=dom.window;token='one';me={id:1,role:'employee',permissions:personal?['mobile.access']:['mobile.access','orders.release'],modules:null};routes={};navigate=vi.fn();
 get=vi.fn(async(p:string)=>p==='/release-slips/queue'?release():p.startsWith('/notifications')?{items:[]}:p==='/tasks'?[task]:p==='/users'?users:[]);
 w.API={post:vi.fn(async()=>({ok:true})),get:(...args:any[])=>get(...args),base:()=>'',getToken:()=>token,isSharedSession:()=>false};
 w.MApp={route:(n:string,f:any)=>routes[n]=f,setTitle:(s:string)=>w.document.querySelector('#m-title').textContent=s,getMe:()=>me,can:(p:string)=>me.permissions.includes(p),canOpen:()=>true,canApprove:()=>false,refreshAccess:vi.fn(async()=>true),go:navigate,currentLocation:()=>({name:route,params})};
 w.requestAnimationFrame=()=>0;w.mCompose=vi.fn();
 for(const file of ['mobile/lib/dom.js','mobile/lib/read-scope.js','mobile/lib/role-ui.js','mobile/modules/hr/work.js','mobile/modules/hr/directory.js','mobile/modules/core/notifications.js','mobile/lib/guides.js','js/guide-tour.js'])w.eval(read(file));
 view=w.document.querySelector('main');routes[route](view,params);await tick();
}
function click(s:string){const el=w.document.querySelector(s);expect(el,s).not.toBeNull();el.focus();el.click();return el;}
function text(){return view.textContent||'';}
function badge(){return [...view.querySelectorAll('[data-work-tools] .v2-work-row')].find((e:any)=>e.querySelector('b')?.textContent==='Release orders')?.querySelector('[data-count]')?.textContent;}
function search(value:string){const el=view.querySelector('#m-dir-q') as HTMLInputElement;el.value=value;el.dispatchEvent(new w.Event('input',{bubbles:true}));}
beforeEach(()=>vi.useFakeTimers());
afterEach(()=>{w?.GuideTour?.close();dom?.window.close();vi.useRealTimers();});

it('keeps unchecked and checked-empty queues compact until actual work or an error arrives',async()=>{
 await boot();let read=defer();get.mockImplementation((p:string)=>p==='/release-slips/queue'?read.promise:Promise.resolve(p==='/tasks'?[]:p.startsWith('/notifications')?{items:[]}:[]));
 routes.work(view,{});await tick();expect(view.querySelector('[data-work-attention] [data-work-desk]')).toBeNull();expect(view.querySelector('[data-work-freshness]')?.textContent).toBe('Checking current work…');expect(view.querySelector('[data-work-empty]')?.hasAttribute('hidden')).toBe(true);
 read.resolve(release([]));await tick();expect(view.querySelector('[data-work-attention] [data-work-desk]')).toBeNull();expect(view.querySelector('[data-work-empty]')?.hasAttribute('hidden')).toBe(false);
 read=defer();click('[data-attention-refresh]');await tick();expect(view.querySelector('[data-work-attention] [data-work-desk]')).toBeNull();expect(view.querySelector('[data-work-empty]')?.hasAttribute('hidden')).toBe(true);
 read.resolve(release());await tick();expect(view.querySelector('[data-work-desk=release]')?.textContent).toContain('SO-11');
});

it('shares the same queue read for records and badges, updates both, and rejects repeated Refresh',async()=>{
 await boot();expect(get.mock.calls.filter((c:any)=>c[0]==='/release-slips/queue')).toHaveLength(1);expect(badge()).toBe('1');
 const slow=defer();get.mockImplementation((p:string)=>p==='/release-slips/queue'?slow.promise:Promise.resolve(p.startsWith('/notifications')?{items:[]}:[]));
 const old=click('[data-attention-refresh]');old.click();old.dispatchEvent(new w.MouseEvent('click'));await tick();expect(get.mock.calls.filter((c:any)=>c[0]==='/release-slips/queue')).toHaveLength(2);expect(badge()).toBe('…');
 slow.resolve(release([]));await tick();expect(badge()).toBe('');expect(text()).not.toContain('SO-11');
});
it('loads each desk independently and keeps known records through an ordinary refresh failure',async()=>{
 await boot();const slow=defer();get.mockImplementation((p:string)=>p==='/release-slips/queue'?slow.promise:Promise.resolve(p==='/tasks'?[{...task,title:'New task'}]:{items:[]}));click('[data-attention-refresh]');await tick();expect(text()).toContain('New task');expect(text()).toContain('SO-11');expect(badge()).toBe('…');
 slow.reject(new Error('Server unavailable'));await tick();expect(text()).toContain('Last loaded · Not refreshed');expect(text()).toContain('SO-11');expect(badge()).toBe('!');
});
it('bounds stuck Work reads and does not convert unknown into a clear count',async()=>{
 await boot();get.mockImplementation(()=>new Promise(()=>{}));click('[data-attention-refresh]');await tick();await vi.advanceTimersByTimeAsync(12000);expect(text()).toContain('timed out');expect(badge()).toBe('!');expect((view.querySelector('[data-attention-refresh]') as HTMLButtonElement).disabled).toBe(false);
});
it('rejects malformed successful queues and permits recovery on Refresh',async()=>{
 await boot();get.mockResolvedValue({to_accept:[],releasing:'invalid'});click('[data-attention-refresh]');await tick();expect(badge()).toBe('!');expect(text()).toContain('SO-11');get.mockImplementation(async(p:string)=>p==='/release-slips/queue'?release([]):p.startsWith('/notifications')?{items:[]}:[]);click('[data-attention-refresh]');await tick();expect(badge()).toBe('');
});
it('keeps the 30-second poll single-flight and stops it when the owning screen leaves',async()=>{
 await boot();const count=get.mock.calls.length;await vi.advanceTimersByTimeAsync(30000);expect(get.mock.calls.length).toBeGreaterThan(count);const after=get.mock.calls.length;view.replaceChildren();await tick();await vi.advanceTimersByTimeAsync(60000);expect(get.mock.calls).toHaveLength(after);
});
it('clears affected cached records on a permission refusal',async()=>{
 await boot();get.mockRejectedValue(Object.assign(new Error('Access refused'),{status:403}));click('[data-attention-refresh]');await tick();expect(text()).not.toContain('SO-11');expect(text()).not.toContain('Private task');expect(badge()).toBe('!');
});
it('cancels pending reads and removes private content after an account change',async()=>{
 await boot();const slow=defer();get.mockImplementation(()=>slow.promise);click('[data-attention-refresh]');await tick();const opts=get.mock.calls.at(-1)[1];token='two';me={...me,id:2};w.dispatchEvent(new w.Event('storage'));await tick();expect(opts.signal.aborted).toBe(true);expect(text()).not.toContain('SO-11');slow.resolve(release());await tick();expect(text()).not.toContain('SO-11');expect(opts.isCurrent()).toBe(false);
});
it('suppresses late results and detached controls after route replacement',async()=>{
 await boot();const old=view.querySelector('[data-attention="release"]') as HTMLButtonElement;const slow=defer();get.mockImplementation(()=>slow.promise);click('[data-attention-refresh]');view.innerHTML='<h1>Another route</h1>';old.click();slow.resolve(release());await tick();expect(text()).toBe('Another route');expect(navigate).not.toHaveBeenCalled();
});
it('preserves personal-only direct task navigation and Guide explanations',async()=>{
 await boot('work',{},true);expect(text().match(/Private task/g)).toHaveLength(1);const steps=w.MobileGuide.steps(view);expect(steps.find((s:any)=>s.title==='Private task').body).toContain('personal task');click('[data-attention="personal"]');expect(navigate).toHaveBeenCalledWith('tasks',{id:21});
});
it('preserves local draft semantics in queue counts instead of copying the server attention count',async()=>{
 await boot('work',{},true);me={...me,permissions:['mobile.access','production.approve','production.qa_review']};w.mProductionDrafts={approvalCount:()=>3,listActions:async()=>[{id:99}]};get.mockImplementation(async(p:string)=>p==='/job-orders?stage=awaiting_approval'?[{id:10,number:'JO-10'}]:p==='/qc/holds'?[{id:20}]:p.startsWith('/notifications')?{items:[]}:[]);routes.work(view,{});await tick();const titles=[...view.querySelectorAll('[data-work-tools] .v2-work-row')];expect(titles.find((e:any)=>e.querySelector('b')?.textContent==='Awaiting production approval')?.querySelector('[data-count]')?.textContent).toBe('3');expect(titles.find((e:any)=>e.querySelector('b')?.textContent==='QA holds')?.querySelector('[data-count]')?.textContent).toBe('2');
});

it('collapses checked empty desks without hiding unknown queues or declaring them clear',async()=>{
 await boot();get.mockImplementation(async(p:string)=>p==='/release-slips/queue'?release([]):p.startsWith('/notifications')?{items:[]}:[]);click('[data-attention-refresh]');await tick();expect(view.querySelector('[data-work-empty]')?.hasAttribute('hidden')).toBe(false);expect(view.querySelector('[data-work-attention] [data-work-desk]')).toBeNull();expect(view.querySelector('[data-work-clear]')).toBeNull();expect(view.querySelector('.work-status-key')).toBeNull();expect(text()).not.toContain('Dot = nothing waiting');expect(text()).not.toContain('Numbers = pending items');expect(view.querySelector('[data-work-tools]')?.hasAttribute('open')).toBe(false);
 get.mockImplementation(async(p:string)=>{if(p==='/release-slips/queue')throw new Error('Unavailable');return p.startsWith('/notifications')?{items:[]}:[];});click('[data-attention-refresh]');await tick();expect(view.querySelector('[data-work-empty]')?.hasAttribute('hidden')).toBe(true);expect(view.querySelector('[data-work-attention] [data-work-desk=release]')?.textContent).toContain('Check needed');
});
it('previews two oldest records and keeps the full queue count independent of preview length',async()=>{
 await boot();get.mockImplementation(async(p:string)=>p==='/release-slips/queue'?release([{id:3,number:'SO-new',created_at:'2026-03-01 00:00:00'},{id:1,number:'SO-old',created_at:'2026-01-01 00:00:00'},{id:2,number:'SO-middle',created_at:'2026-02-01 00:00:00'}]):p.startsWith('/notifications')?{items:[]}:[]);click('[data-attention-refresh]');await tick();expect([...view.querySelectorAll('[data-work-desk=release] [data-work-record]')].map((e:any)=>e.dataset.workRecord)).toEqual(['record:1','record:2']);expect(view.querySelector('[data-work-desk=release] .work-desk-heading')?.textContent).toContain('3 orders');click('[data-work-desk=release] .work-view-all');expect(navigate).toHaveBeenCalledWith('so',{});
});
it('keeps individual notice records in Notifications and marks read only on an explicit open',async()=>{
 await boot();const items=[{id:1,title:'Same title',url:'#/so?id=11',body:'First record'},{id:2,title:'Same title',url:'#/so?id=11',body:'First record again'},{id:3,title:'Same title',url:'#/so?id=12',body:'Different record'}];get.mockImplementation(async(p:string)=>p==='/notifications'?{items}:[]);await routes.notifications(view,{});await tick();expect(view.querySelectorAll('[data-nid]')).toHaveLength(3);expect(w.API.post).not.toHaveBeenCalled();click('[data-nid="1"]');await tick();expect(w.API.post.mock.calls.map((a:any)=>a[0])).toEqual(['/notifications/1/read']);expect(navigate).toHaveBeenCalledWith('work',{notice:'#/so?id=11'});
});
it('retains unread notification state and offers a fallback when saving a read fails',async()=>{
 await boot();get.mockImplementation(async(p:string)=>p==='/notifications'?{items:[{id:1,title:'Update',url:'#/so?id=11'}]}:[]);await routes.notifications(view,{});await tick();w.API.post.mockRejectedValue(new Error('Read save failed'));click('[data-nid="1"]');await tick();expect(navigate).not.toHaveBeenCalled();expect(view.querySelector('[data-nid="1"]')?.classList.contains('unread')).toBe(true);expect(view.querySelector('[data-read-error]')?.textContent).toContain('open without marking read');click('[data-read-error] button');expect(navigate).toHaveBeenCalledWith('work',{notice:'#/so?id=11'});
});
it('shows distinct notices with repeated titles without requiring a second Work disclosure',async()=>{
 await boot();get.mockImplementation(async(p:string)=>p==='/notifications'?{items:Array.from({length:5},(_,i)=>({id:i+1,title:'Repeated title',url:'#/notifications'}))}:[]);await routes.notifications(view,{});await tick();expect(view.querySelectorAll('[data-nid]')).toHaveLength(5);expect(w.API.post).not.toHaveBeenCalled();expect(view.querySelector('[data-work-updates]')).toBeNull();
});
it('shows sales follow-up as live work and leaves notification history out of task counts',async()=>{
 await boot('work',{},true);me.permissions=['mobile.access','orders.view','orders.edit'];let orders=[{id:1,number:'SO-A',status:'open'},{id:2,number:'SO-B',status:'open'}];get.mockImplementation(async(p:string)=>p==='/orders?type=sale'?orders:[]);routes.work(view,{});await tick();expect(view.querySelector('[data-work-desk=csr] .work-indicator.pending')?.textContent).toBe('2');expect(view.querySelector('[data-work-updates]')).toBeNull();expect(view.querySelector('[data-work-empty]')?.hasAttribute('hidden')).toBe(true);orders=[];click('[data-attention-refresh]');await tick();expect(view.querySelector('[data-work-empty]')?.textContent).toBe('No pending work in your checked areas.');expect(view.querySelector('[data-work-empty]')?.hasAttribute('hidden')).toBe(false);
});
it('uses checked zero counts for green dots, distinguishes failed checks, and gives lookup tools no task badge',async()=>{
 await boot();me.permissions.push('inventory.view');get.mockImplementation(async(p:string)=>p==='/release-slips/queue'?release([]):p.startsWith('/notifications')?{items:[]}:[]);routes.work(view,{});await tick();
 const releaseRow=view.querySelector('[data-work-tools] [data-work-route=so]')!;expect(releaseRow.querySelector('[data-count]')?.getAttribute('data-state')).toBe('empty');expect(releaseRow.querySelector('.work-indicator.empty')?.getAttribute('aria-label')).toBe('No pending work');expect(view.querySelector('[data-work-route=item] .work-indicator')).toBeNull();
 for(const word of ['CLEAR','GO','OPEN'])expect([...view.querySelectorAll('[data-count]')].some(e=>e.textContent===word)).toBe(false);expect(text()).not.toContain('My authorized queues');expect(text()).not.toContain('Inventory tools');expect(view.querySelector('[data-work-clear]')).toBeNull();expect(view.querySelector('.work-status-key')).toBeNull();expect(text()).not.toContain('Dot = nothing waiting');expect(text()).not.toContain('Numbers = pending items');
 get.mockImplementation(async(p:string)=>{if(p==='/release-slips/queue')throw new Error('Check failed');return p.startsWith('/notifications')?{items:[]}:[];});view.querySelector<HTMLElement>('[data-attention-refresh]')!.click();await tick();expect(releaseRow.querySelector('.work-indicator.empty')).toBeNull();expect(releaseRow.querySelector('.work-indicator.unknown')?.getAttribute('aria-label')).toBe('Could not check current work');
});
it('counts a held RTS serial and its saved attempt once, without inventing an extra recovery entry',async()=>{
 await boot();me.permissions=['mobile.access','production.receive'];
 w.mProductionDrafts={listActions:vi.fn(async(_kind:string,namespace:string)=>namespace==='rts-unit'?[{record:{operation:{entries:[{state:'unknown',payload:{unit_ids:[8]}}]}}}]:[])};
 w.eval(read('mobile/modules/manufacturing/rts-recovery.js'));
 get.mockImplementation(async(p:string)=>p==='/rts/queue'?{units:[{id:8,identifier:'RTS-held',hold:{id:1}}],batches:[]}:p.startsWith('/notifications')?{items:[]}:[]);
 routes.work(view,{});await tick();
 expect(view.querySelector('[data-work-tools] [data-work-route=receiving] [data-count]')?.textContent).toBe('1');
 expect(view.querySelector('[data-work-recovery] [data-work-route=receiving]')).toBeNull();
 expect(view.querySelector('[data-work-desk=rts] .work-held')?.textContent).toContain('1 unit on hold');
 w.mProductionDrafts.listActions.mockResolvedValue([]);
 expect(await w.mRtsRecovery.count({units:[{id:8,hold:{id:1}}],batches:[]})).toBe(0);
 expect(await w.mRtsRecovery.count({units:[{id:8,hold:{id:1}}],batches:[]},{includeHeld:true})).toBe(1);
});
it('a malformed RTS success stays unknown and does not invent a saved-work count',async()=>{
 await boot();me.permissions=['mobile.access','production.receive'];w.mProductionDrafts={listActions:async()=>[]};w.eval(read('mobile/modules/manufacturing/rts-recovery.js'));
 get.mockImplementation(async(p:string)=>p==='/rts/queue'?{units:[],batches:[{id:9,remaining_qty:0}]}:p.startsWith('/notifications')?{items:[]}:[]);routes.work(view,{});await tick();
 expect(view.querySelector('[data-work-tools] [data-work-route=receiving] [data-count]')?.getAttribute('data-state')).toBe('unknown');expect(view.querySelector('[data-work-recovery] [data-work-route=receiving]')).toBeNull();expect(text()).toContain('batch quantities could not be verified');
});
it('does not fetch or mutate notification history while refreshing live Work tasks',async()=>{
 await boot();get.mockClear();get.mockImplementation(async(p:string)=>{if(p.startsWith('/notifications'))throw Error('Unavailable notice service');return p==='/release-slips/queue'?release():[];});click('[data-attention-refresh]');await tick();expect(text()).toContain('SO-11');expect(get.mock.calls.some((call:any)=>call[0].startsWith('/notifications'))).toBe(false);expect(view.querySelector('.work-update-badge')).toBeNull();expect(w.API.post).not.toHaveBeenCalled();
});
it('never presents failed notification history as all caught up',async()=>{
 await boot();get.mockImplementation(async(p:string)=>{if(p==='/notifications')throw Error('Offline');return [];});await routes.notifications(view,{});await tick();expect(text()).toContain('Some updates couldn’t be loaded');expect(text()).not.toContain('You’re all caught up');expect(text()).toContain('Retry missing updates');
});
it('keeps saved handoff recovery visible even after its sale leaves the live release queue',async()=>{
 await boot();w.mProductionDrafts={listActions:vi.fn(async(kind:string)=>kind==='release-handoff'?[{id:90,record:{operation:{number:'SO-saved',state:'unknown'}}}]:[])};get.mockImplementation(async(p:string)=>p==='/release-slips/queue'?release([]):p.startsWith('/notifications')?{items:[]}:[]);click('[data-attention-refresh]');await tick();expect(view.querySelector('[data-work-recovery]')?.textContent).toContain('SO-saved');expect(view.querySelector('[data-work-empty]')?.hasAttribute('hidden')).toBe(true);view.querySelector<HTMLElement>('[data-work-recovery] button')!.focus();view.querySelector<HTMLElement>('[data-attention-refresh]')!.click();await tick();expect(w.document.activeElement.textContent).toContain('SO-saved');click('[data-work-recovery] button');expect(navigate).toHaveBeenCalledWith('so',{id:90,step:'proof'});
});
it.each(['unit','batch'])('routes an RTS %s notice through the existing identity-checked detail',async kind=>{
 await boot();me.permissions.push('production.receive');get.mockImplementation(async(p:string)=>p==='/rts/queue'?{units:[{id:8,identifier:'SERIAL-8'}],batches:[{id:8,number:'BATCH-8',remaining_qty:3}]}:p.startsWith('/notifications')?{items:[]}:[]);routes.work(view,{notice:'#/receiving?'+kind+'=8'});await tick();expect(text()).toContain(kind==='unit'?'SERIAL-8':'BATCH-8');click('#work-open-action');await tick();expect(navigate).toHaveBeenCalledWith('receiving',kind==='unit'?{unit:8}:{batch:8});
});

it('shows the checked detail, allows one Open verification and opens the exact fresh record',async()=>{
 await boot('work',{task:'release',record:'record:11'});expect(text()).toContain('Latest record checked');const slow=defer();w.MApp.refreshAccess.mockImplementation(()=>slow.promise);const old=click('#work-open-action');old.click();await tick();expect(w.MApp.refreshAccess).toHaveBeenCalledTimes(1);expect(w.MApp.refreshAccess).toHaveBeenCalledWith({required:true});expect(text()).toContain('Checking access…');slow.resolve(true);await tick();expect(navigate).toHaveBeenCalledWith('so',{id:11});
});
it('keeps detail identity with an inline verification error and recovers through Retry',async()=>{
 await boot('work',{task:'release',record:'record:11'});w.MApp.refreshAccess.mockRejectedValue(new Error('Connection failed'));click('#work-open-action');await tick();expect(text()).toContain('SO-11');expect(text()).toContain('Nothing was opened');expect(navigate).not.toHaveBeenCalled();expect(w.document.activeElement.id).toBe('work-check-error');click('[data-work-retry]');await tick();expect(text()).toContain('Latest record checked');expect((view.querySelector('#work-open-action') as HTMLButtonElement).disabled).toBe(false);
});
it.each(['moved','revoked'])('removes the workflow action after a fresh %s response',async kind=>{
 await boot('work',{task:'release',record:'record:11'});if(kind==='moved')get.mockResolvedValue(release([]));else w.MApp.refreshAccess.mockImplementation(async()=>{me.permissions=['mobile.access'];return true;});click('#work-open-action');await tick();expect(view.querySelector('#work-open-action')).toBeNull();expect(text()).not.toContain('SO-11');expect(navigate).not.toHaveBeenCalled();
});
it('times out a non-production detail check with a usable Retry and Back',async()=>{
 await boot('work',{task:'release',record:'record:11'});get.mockImplementation(()=>new Promise(()=>{}));click('#work-open-action');await tick();await vi.advanceTimersByTimeAsync(12000);expect(text()).toContain('timed out');expect(view.querySelector('[data-work-retry]')).not.toBeNull();expect(view.querySelector('[data-work-back]')).not.toBeNull();
});
it('does not open a workflow when an old verification finishes under a different sign-in',async()=>{
 await boot('work',{task:'release',record:'record:11'});const slow=defer();w.MApp.refreshAccess.mockImplementation(()=>slow.promise);click('#work-open-action');token='two';me.id=2;slow.resolve(true);await tick();expect(navigate).not.toHaveBeenCalled();expect(text()).not.toContain('SO-11');
});

it('filters self/inactive accounts but keeps ordinary staff payloads that omit active',async()=>{
 await boot('directory');expect(text()).toContain('2 colleagues');expect(text()).not.toContain('Inactive');expect(view.querySelectorAll('.m-directory-person')).toHaveLength(2);expect(text()).toContain('HR Staff');
});
it('searches the readable role and keeps query/results during failed Refresh, then retries and clears',async()=>{
 await boot('directory');search('HR staff');expect(text()).toContain('Fictional Ana');expect(text()).not.toContain('Fictional Ben');get.mockRejectedValue(new Error('Network unavailable'));click('[data-directory-refresh]');await tick();expect((view.querySelector('#m-dir-q') as HTMLInputElement).value).toBe('HR staff');expect(text()).toContain('Fictional Ana');expect(text()).toContain('last loaded colleagues');get.mockResolvedValue(users);click('[data-directory-retry]');await tick();expect(text()).toContain('Directory checked just now');click('[data-directory-clear]');expect(text()).toContain('2 colleagues');expect(w.document.activeElement.id).toBe('m-dir-q');
});
it('distinguishes no matches, an empty directory and an initial read failure',async()=>{
 await boot('directory');search('missing');expect(text()).toContain('No colleagues match');get.mockResolvedValue([]);click('[data-directory-clear]');click('[data-directory-refresh]');await tick();expect(text()).toContain('No other active colleagues');
});
it('shares directory reads, bounds timeouts and retains last-loaded colleagues',async()=>{
 await boot('directory');get.mockImplementation(()=>new Promise(()=>{}));const old=click('[data-directory-refresh]');old.click();await tick();expect(get).toHaveBeenCalledTimes(2);await vi.advanceTimersByTimeAsync(12000);expect(text()).toContain('timed out');expect(text()).toContain('Fictional Ana');
});
it('opens one existing conversation for repeated taps and re-enables navigation if opening fails',async()=>{
 await boot('directory');const slow=defer();w.mCompose.mockImplementation(()=>slow.promise);const old=click('.m-directory-person');old.click();await tick();expect(w.mCompose).toHaveBeenCalledTimes(1);slow.reject(new Error('Opening failed'));await tick();expect(text()).toContain('Opening failed');expect((view.querySelector('.m-directory-person') as HTMLButtonElement).disabled).toBe(false);
});
it('clears directory records on access refusal and ignores detached person controls',async()=>{
 await boot('directory');const old=view.querySelector('.m-directory-person') as HTMLButtonElement;get.mockRejectedValue(Object.assign(new Error('Access refused'),{status:403}));click('[data-directory-refresh]');await tick();old.click();expect(text()).not.toContain('Fictional Ana');expect(w.mCompose).not.toHaveBeenCalled();
});
it.each(['work','directory'])('guards an old %s read 401 before it can clear the new token',async route=>{
 await boot(route);const slow=defer();w.fetch=()=>slow.promise;w.eval(read('js/api.js'));w.API.setToken('fictional-old-token');routes[route](view,{});await tick();w.API.setToken('fictional-new-token');me.id=2;view.textContent='New screen';slow.resolve({status:401,ok:false,headers:{get:()=> 'application/json'},json:async()=>({error:'Old session expired'})});await tick();expect(w.API.getToken()).toBe('fictional-new-token');expect(text()).toBe('New screen');
});
it('keeps the Work guide modeless, supports jump/minimize/Escape and restores focus',async()=>{
 await boot();click('#m-guide-start');w.MobileGuide.start();const picker=w.document.querySelector('[data-act=jump]');expect(picker).not.toBeNull();expect(w.document.querySelector('.guide-coach-body').tabIndex).toBe(0);picker.value=String(w.MobileGuide.steps(view).findIndex((s:any)=>s.title==='Release orders'));picker.dispatchEvent(new w.Event('change'));expect(w.document.querySelector('.guide-coach').getAttribute('aria-modal')).toBeNull();expect(w.document.querySelector('.guide-coach-text').textContent).toContain('Stock effect');click('[data-act=minimize]');expect(w.document.querySelector('[data-act=minimize]').getAttribute('aria-expanded')).toBe('false');w.document.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));expect(w.document.querySelector('.guide-coach')).toBeNull();expect(w.document.activeElement.id).toBe('m-guide-start');
});
it.each(['hidden','account','departure'])('closes the Work guide on %s and prevents detached steps from affecting another guide',async kind=>{
 await boot('work',{},true);w.MobileGuide.start();const old=w.document.querySelector('[data-act=next]');if(kind==='hidden')w.document.querySelector('#m-app').classList.add('hidden');if(kind==='account'){token='two';me.id=2;w.dispatchEvent(new w.Event('storage'));}if(kind==='departure')w.dispatchEvent(new w.Event('pagehide'));await tick();expect(w.document.querySelector('.guide-coach')).toBeNull();old.click();expect(w.document.querySelector('.guide-coach')).toBeNull();
});
