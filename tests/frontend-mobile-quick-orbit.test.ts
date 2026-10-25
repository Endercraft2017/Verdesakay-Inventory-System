import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
const source=(file:string)=>fs.readFileSync(new URL('../public/'+file,import.meta.url),'utf8');
const windows:any[]=[];afterEach(()=>windows.splice(0).forEach(w=>w.close()));
const pause=()=>new Promise(r=>setTimeout(r,25));
async function boot(){
  const dom=new JSDOM('<div id="m-app"><button id="background">Background action</button><input id="input"></div>',{url:'https://example.test/m#/home',runScripts:'outside-only',pretendToBeVisual:true}),w:any=dom.window;windows.push(w);
  const permissions=['messages.send','production.inspect_qc'],routes=new Set(['requests','report-problem','qc']);w.MApp={can:(p:string)=>permissions.includes(p),canOpen:(p:string)=>routes.has(p),go:vi.fn()};
  w.eval(source('js/lib/photo-viewer.js'));w.eval(source('mobile/lib/quick-orbit.js'));await pause();
  const orbit=w.document.querySelector('.v2-orbit'),handle=orbit.querySelector('.v2-orbit-handle');
  orbit.getBoundingClientRect=()=>({left:parseFloat(orbit.style.left)||300,top:parseFloat(orbit.style.top)||500,width:56,height:56});
  return {w,orbit,handle,permissions,routes,open:()=>handle.click()};
}
it('keeps universal and authorized role actions in the existing order',async()=>{const b=await boot();expect([...b.orbit.querySelectorAll('[data-route]')].map((e:any)=>e.dataset.route)).toEqual(['requests','report-problem','qc']);expect(b.orbit.querySelector('.v2-orbit-menu').hidden).toBe(true);});
it('opens one modal layer, expands the handle and protects the background',async()=>{const b=await boot();b.handle.focus();b.open();await pause();expect(b.w.document.querySelectorAll('.v2-orbit-overlay')).toHaveLength(1);expect(b.handle.getAttribute('aria-expanded')).toBe('true');expect(b.w.document.querySelector('#m-app').inert).toBe(true);expect(b.w.document.body.style.overflow).toBe('hidden');expect(b.w.document.activeElement.classList.contains('v2-orbit-action')).toBe(true);});
it('Escape closes the fan, restores focus and unlocks the page',async()=>{const b=await boot();b.handle.focus();b.open();b.w.document.dispatchEvent(new b.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));expect(b.w.document.querySelector('.v2-orbit-overlay')).toBeNull();expect(b.handle.getAttribute('aria-expanded')).toBe('false');expect(b.w.document.activeElement).toBe(b.handle);expect(b.w.document.querySelector('#m-app').inert).toBe(false);expect(b.w.document.body.style.overflow).toBe('');});
it('outside press and the close circle dismiss without navigation',async()=>{const b=await boot();b.open();b.w.document.querySelector('.v2-orbit-backdrop').click();expect(b.w.MApp.go).not.toHaveBeenCalled();b.open();b.handle.click();expect(b.w.document.querySelector('.v2-orbit-overlay')).toBeNull();});
it('keeps keyboard focus in the open fan and supports arrow traversal',async()=>{const b=await boot();b.open();const first=b.orbit.querySelector('.v2-orbit-action');b.w.document.querySelector('.v2-orbit-overlay').dispatchEvent(new b.w.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));expect(b.w.document.activeElement).toBe(b.orbit.querySelectorAll('.v2-orbit-action')[1]);b.handle.focus();b.w.document.dispatchEvent(new b.w.KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));expect(b.w.document.activeElement).toBe(b.w.document.querySelector('.v2-orbit-edit'));b.w.document.dispatchEvent(new b.w.KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true}));expect(b.w.document.activeElement).toBe(b.handle);});
it('routes one authorized action with its original parameters',async()=>{const b=await boot();b.open();const action=b.orbit.querySelector('[data-action="qc"]');action.click();action.click();expect(b.w.MApp.go).toHaveBeenCalledTimes(1);expect(b.w.MApp.go).toHaveBeenCalledWith('qc',{role:'qc'});expect(b.w.document.querySelector('.v2-orbit-overlay')).toBeNull();});
it('rechecks permissions before using an already rendered action',async()=>{const b=await boot();b.open();b.permissions.splice(b.permissions.indexOf('production.inspect_qc'),1);b.orbit.querySelector('[data-action="qc"]').click();expect(b.w.MApp.go).not.toHaveBeenCalled();expect(b.orbit.querySelector('[data-action="qc"]')).toBeNull();});
function pointer(b:any,type:string,x:number,y:number,id=1){const e=new b.w.Event(type,{bubbles:true});Object.assign(e,{pointerId:id,clientX:x,clientY:y,button:0,isPrimary:true});b.handle.dispatchEvent(e);}
it('dragging saves the edge position and does not open the menu',async()=>{const b=await boot();pointer(b,'pointerdown',320,520);pointer(b,'pointermove',30,250);pointer(b,'pointerup',30,250);b.handle.dispatchEvent(new b.w.MouseEvent('click',{detail:1,bubbles:true}));expect(b.w.document.querySelector('.v2-orbit-overlay')).toBeNull();const saved=JSON.parse(b.w.localStorage.getItem('vds_m_orbit_v2'));expect(saved.x).toBeGreaterThan(0);expect(saved.x).toBeLessThan(.5);expect(saved.y).toBeGreaterThan(0);});
it('a cancelled pointer cannot leave the handle stuck dragging',async()=>{const b=await boot();pointer(b,'pointerdown',320,520);pointer(b,'pointermove',50,200);pointer(b,'pointercancel',50,200);expect(b.orbit.classList.contains('is-dragging')).toBe(false);b.handle.click();expect(b.w.document.querySelector('.v2-orbit-overlay')).not.toBeNull();});
it('allows keyboard repositioning without opening the menu',async()=>{const b=await boot();b.handle.dispatchEvent(new b.w.KeyboardEvent('keydown',{key:'ArrowLeft',altKey:true,bubbles:true}));expect(parseFloat(b.orbit.style.left)).toBe(8);expect(b.w.localStorage.getItem('vds_m_orbit_v2')).not.toBeNull();expect(b.handle.getAttribute('aria-expanded')).toBe('false');});
it('closes on route changes and refreshes the authorized actions',async()=>{const b=await boot();b.open();b.permissions.splice(b.permissions.indexOf('production.inspect_qc'),1);b.w.dispatchEvent(new b.w.HashChangeEvent('hashchange'));expect(b.w.document.querySelector('.v2-orbit-overlay')).toBeNull();expect(b.orbit.querySelector('[data-route="qc"]')).toBeNull();expect(b.handle.getAttribute('aria-expanded')).toBe('false');});
it('does not leave a backdrop or focus lock on sign out or entering an editor',async()=>{const b=await boot();b.open();b.w.document.querySelector('#m-app').classList.add('hidden');await pause();expect(b.orbit.hidden).toBe(true);expect(b.w.document.querySelector('.v2-orbit-overlay')).toBeNull();expect(b.w.document.body.style.overflow).toBe('');b.w.document.querySelector('#m-app').classList.remove('hidden');await pause();b.open();b.w.document.body.classList.add('personal-editor-open');await pause();expect(b.orbit.hidden).toBe(true);expect(b.w.document.querySelector('.v2-orbit-overlay')).toBeNull();});
it('hides while typing and returns when the field loses focus',async()=>{const b=await boot();b.w.document.querySelector('#input').focus();expect(b.orbit.hidden).toBe(true);b.w.document.querySelector('#input').blur();await pause();expect(b.orbit.hidden).toBe(false);});
async function personal(b:any,shortcuts:any=['qc']){
 let me={id:12,permissions:b.permissions},token='first';
 b.w.MApp.getMe=()=>me;b.w.API={base:()=>'/workspace-a',getToken:()=>token,isSharedSession:()=>false,get:vi.fn(async()=>({shortcuts})),put:vi.fn(async(_p:any,body:any)=>body)};
 b.permissions.push('production.inspect_qa');b.w.mQuickOrbit.refresh();await pause();
 return {setAccount:(id:number)=>{me={id,permissions:b.permissions};token='account-'+id;b.w.mQuickOrbit.refresh();}};
}
function editor(b:any){b.open();b.w.document.querySelector('.v2-orbit-edit').click();return b.w.document.querySelector('.v2-orbit-settings');}
function submit(b:any,layer:any){layer.querySelector('form').dispatchEvent(new b.w.Event('submit',{bubbles:true,cancelable:true}));}
it('loads two saved work choices and distinguishes QC from QA on their shared route',async()=>{
 const b=await boot();await personal(b,['qc','qa']);expect([...b.orbit.querySelectorAll('[data-action]')].map((e:any)=>e.dataset.action)).toEqual(['request','report','qc','qa']);
 b.open();b.orbit.querySelector('[data-action="qa"]').click();expect(b.w.MApp.go).toHaveBeenLastCalledWith('qc',{role:'qa'});
 b.open();b.orbit.querySelector('[data-action="qc"]').click();expect(b.w.MApp.go).toHaveBeenLastCalledWith('qc',{role:'qc'});
});
it('hides revoked saved choices without replacing them with an unrelated desk',async()=>{
 const b=await boot();await personal(b,['qa']);b.permissions.splice(b.permissions.indexOf('production.inspect_qa'),1);b.w.mQuickOrbit.refresh();expect(b.orbit.querySelectorAll('[data-action]')).toHaveLength(2);
});
it('offers three distinct choice slots, preserves common actions and saves once on repeated submit',async()=>{
 const b=await boot();await personal(b);let resolve:any;b.w.API.put=vi.fn(()=>new Promise(r=>resolve=r));const layer=editor(b);
 const first=layer.querySelector('#orbit-first'),second=layer.querySelector('#orbit-second');expect(layer.querySelectorAll('select')).toHaveLength(3);expect([...first.options].map((o:any)=>o.value)).toEqual(['qc','qa']);
 expect([...second.options].find((o:any)=>o.value==='qc').disabled).toBe(true);second.value='qa';submit(b,layer);submit(b,layer);expect(b.w.API.put).toHaveBeenCalledTimes(1);expect(b.w.API.put.mock.calls[0][1]).toEqual({shortcuts:['qc','qa']});resolve({shortcuts:['qc','qa']});await pause();expect(b.w.document.querySelector('.v2-orbit-settings')).toBeNull();expect(b.orbit.querySelectorAll('[data-action]')).toHaveLength(4);
});
it('keeps the editor open for an actionable save failure and permits retry',async()=>{
 const b=await boot();await personal(b);b.w.API.put=vi.fn().mockRejectedValueOnce(new Error('Network unavailable')).mockResolvedValue({shortcuts:['qc']});const layer=editor(b);submit(b,layer);await pause();expect(layer.querySelector('[role="status"]').textContent).toBe('Network unavailable');expect(layer.querySelector('[type="submit"]').disabled).toBe(false);submit(b,layer);await pause();expect(layer.isConnected).toBe(false);
});
it('does not apply a late read or save to another signed-in account',async()=>{
 const b=await boot();const p=await personal(b);let resolve:any;b.w.API.put=vi.fn(()=>new Promise(r=>resolve=r));const layer=editor(b);layer.querySelector('#orbit-second').value='qa';submit(b,layer);
 b.w.API.get=vi.fn(async()=>({shortcuts:['qc']}));p.setAccount(27);resolve({shortcuts:['qc','qa']});await pause();expect([...b.orbit.querySelectorAll('[data-action]')].map((e:any)=>e.dataset.action)).toEqual(['request','report','qc']);
 const reads:any[]=[];b.w.API.get=vi.fn(()=>new Promise(r=>reads.push(r)));p.setAccount(28);await pause();p.setAccount(29);await pause();reads[0]({shortcuts:['qa']});reads[1]({shortcuts:['qc']});await pause();expect(b.w.localStorage.getItem('vds_m_work_shortcuts:'+JSON.stringify(['/workspace-a',28,false]))).toBeNull();
});
it('uses session storage for borrowed-phone shortcut choices',async()=>{
 const b=await boot();await personal(b);b.w.API.isSharedSession=()=>true;b.w.mQuickOrbit.refresh();await pause();const key='vds_m_work_shortcuts:'+JSON.stringify(['/workspace-a',12,true]);expect(b.w.sessionStorage.getItem(key)).toBe('["qc"]');expect(b.w.localStorage.getItem(key)).toBeNull();
});

it('replaces the message shortcut with a third permitted work action and keeps legacy selections',async()=>{
 const b=await boot();b.permissions.push('production.repairs');b.routes.add('repairs');await personal(b,['qc','qa','repairs']);
 expect([...b.orbit.querySelectorAll('[data-action]')].map((e:any)=>e.dataset.action)).toEqual(['request','report','qc','qa','repairs']);
 expect(b.orbit.querySelector('[data-route="inbox"]')).toBeNull();const layer=editor(b);expect(layer.querySelector('#orbit-third').value).toBe('repairs');submit(b,layer);await pause();expect(b.w.API.put.mock.calls[0][1]).toEqual({shortcuts:['qc','qa','repairs']});
});
it('disables duplicates across all three slots and rejects forged duplicate selections',async()=>{
 const b=await boot();b.permissions.push('production.repairs');b.routes.add('repairs');await personal(b,['qc','qa','repairs']);const layer=editor(b);
 for(const select of layer.querySelectorAll('select'))for(const other of layer.querySelectorAll('select'))if(select!==other)expect([...select.options].find((o:any)=>o.value===other.value).disabled).toBe(true);
 layer.querySelector('#orbit-third').value='qc';submit(b,layer);expect(b.w.API.put).not.toHaveBeenCalled();expect(layer.querySelector('[role="status"]').textContent).toContain('different work shortcuts');
});
it('recommends at most three permitted desks and gives employees with none only common actions',async()=>{
 const b=await boot();b.permissions.push('production.inspect_qa','production.repairs','production.receive');b.routes.add('repairs');b.routes.add('receiving');b.w.mQuickOrbit.refresh();expect(b.orbit.querySelectorAll('[data-action]')).toHaveLength(5);expect(b.orbit.querySelector('[data-action="message"]')).toBeNull();
 b.permissions.splice(0);b.w.mQuickOrbit.refresh();expect([...b.orbit.querySelectorAll('[data-action]')].map((e:any)=>e.dataset.action)).toEqual(['request','report']);
});
