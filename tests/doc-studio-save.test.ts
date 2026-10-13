import { it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
const source=fs.readFileSync(new URL('../public/js/doc-studio.js',import.meta.url),'utf8');
const copy=<T,>(value:T):T=>JSON.parse(JSON.stringify(value));
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};

it('does not treat its own newer room write as a conflicting edit during Save',async()=>{
 const dom=new JSDOM('<div id="editor"><div class="doc-fs-bar-actions"></div><div id="surface"></div></div>',{url:'https://studio.test',runScripts:'outside-only'});const w=dom.window as any;
 let local={body:'<p>Original</p>'},server=copy(local),version=0,roomReads=0,heartbeat:()=>void=()=>{};
 let resolveSaveRead!:(room:unknown)=>void;
 const delayedSaveRead=new Promise(resolve=>{resolveSaveRead=resolve;});
 const room=()=>({snapshot:copy(server),version,saved_revision:'r1',room_saved_revision:'r1'});
 w.setInterval=(callback:()=>void)=>{heartbeat=callback;return 1;};w.clearInterval=()=>{};
 w.API={get:vi.fn(async(url:string)=>{if(url.endsWith('/library'))return [];if(url.endsWith('/draft'))return null;roomReads++;if(roomReads===2)return delayedSaveRead;return room();}),put:vi.fn(async(_url:string,input:any)=>{server=copy(input.snapshot);return {snapshot:copy(server),version:++version,saved_revision:'r1'};}),post:vi.fn(async()=>[]),del:vi.fn(async()=>({}))};w.eval(source);
 const shared=w.DocStudio.mount(w.document.querySelector('#editor'),{documentKey:'template:1',getSavedRevision:()=> 'r1'},{surface:w.document.querySelector('#surface'),snapshot:()=>copy(local),dirty:()=>true,markBlocks:()=>{},apply:(value:any)=>{local=copy(value);},render:()=>{},safeUrl:()=>true});
 try{
  await shared.ready;local={body:'<p>First edit</p>'};
  const saving=shared.prepareSave().then(()=>({ok:true}), (error:Error)=>({error:error.message}));await flush();const stale=room();
  heartbeat();await flush();
  // A serialized Save may still own the delayed read; a racing implementation has
  // already sent the same client's edit in a background tick.
  local={body:'<p>First edit plus another edit</p>'};resolveSaveRead(stale);await flush();
  expect(await saving).toEqual({ok:true});expect(local.body).toContain('another edit');
  expect(shared.version).toBeGreaterThan(1);
 }finally{shared.close();dom.window.close();}
});

function session(body='<p>Original</p>'){
 const dom=new JSDOM('<div id="editor"><div class="doc-fs-bar-actions"></div><div id="surface"></div></div>',{url:'https://studio.test',runScripts:'outside-only'});const w=dom.window as any;
 let local={body},server=copy(local),version=0,composing=false,heartbeat:()=>void=()=>{};
 let putHook:((input:any)=>Promise<any>)|null=null;
 const room=()=>({snapshot:copy(server),version,saved_revision:'r1',room_saved_revision:'r1'});
 w.setInterval=(callback:()=>void)=>{heartbeat=callback;return 1;};w.clearInterval=()=>{};
 w.API={get:vi.fn(async(url:string)=>url.endsWith('/library')?[]:url.endsWith('/draft')?null:room()),put:vi.fn(async(_url:string,input:any)=>{if(putHook)return putHook(input);server=copy(input.snapshot);return {snapshot:copy(server),version:++version,saved_revision:'r1'};}),post:vi.fn(async()=>[]),del:vi.fn(async()=>({}))};w.eval(source);
 const shared=w.DocStudio.mount(w.document.querySelector('#editor'),{documentKey:'template:1',getSavedRevision:()=> 'r1'},{surface:w.document.querySelector('#surface'),snapshot:()=>copy(local),dirty:()=>true,isComposing:()=>composing,markBlocks:()=>{},apply:(value:any)=>{local=copy(value);},render:()=>{},safeUrl:()=>true});
 return {shared,api:w.API,room,heartbeat:()=>heartbeat(),setLocal:(body:string)=>{local={body};},getLocal:()=>local,remote:(body:string)=>{server={body};version++;},compose:(value:boolean)=>{composing=value;},setPut:(hook:((input:any)=>Promise<any>)|null)=>{putHook=hook;},dispose:()=>{shared.close();dom.window.close();}};
}

it('retains real conflicts from a different editor and preserves the local draft',async()=>{
 const s=session();try{await s.shared.ready;s.setLocal('<p>My edit</p>');s.remote('<p>Other editor edit</p>');await expect(s.shared.prepareSave()).rejects.toThrow('Resolve overlapping edits');expect(s.getLocal().body).toContain('My edit');expect(s.api.put).toHaveBeenCalledTimes(1);}finally{s.dispose();}
});

it('keeps background writes paused during publication and preserves edits made while saving',async()=>{
 const s=session();try{await s.shared.ready;s.setLocal('<p>Published edit</p>');await s.shared.prepareSave();const puts=s.api.put.mock.calls.length;s.setLocal('<p>Published edit with newer typing</p>');s.heartbeat();await flush();expect(s.api.put).toHaveBeenCalledTimes(puts);s.remote('<p>Published edit</p>');expect(await s.shared.saved(false)).toBe(false);expect(s.getLocal().body).toContain('newer typing');s.heartbeat();await flush();expect(s.api.put).toHaveBeenCalledTimes(puts+1);}finally{s.dispose();}
});

it('acknowledges its own in-flight write after composition ends without replacing composing text',async()=>{
 const s=session();let resolvePut!:(value:any)=>void;try{
  await s.shared.ready;s.setLocal('<p>First edit</p>');s.setPut(input=>new Promise(resolve=>{s.remote(input.snapshot.body);resolvePut=resolve;}));s.heartbeat();await flush();
  s.compose(true);s.setLocal('<p>First edit with composing text</p>');resolvePut({snapshot:s.room().snapshot,version:s.room().version,saved_revision:'r1'});await flush();expect(s.getLocal().body).toContain('composing text');
  s.setPut(null);s.compose(false);await s.shared.prepareSave();expect(s.getLocal().body).toContain('composing text');
 }finally{s.dispose();}
});

it('reconciles independent peer blocks after a deferred composing response',async()=>{
 const body=(a:string,b:string)=>`<!--doc-sync:a--><p>${a}</p><!--doc-sync:b--><p>${b}</p>`;
 const s=session(body('A','B'));let resolvePut!:(value:any)=>void;try{
  await s.shared.ready;s.setLocal(body('My edit','B'));s.setPut(()=>new Promise(resolve=>{s.remote(body('My edit','Peer edit'));resolvePut=resolve;}));s.heartbeat();await flush();
  s.compose(true);s.setLocal(body('My edit with composing text','B'));resolvePut({snapshot:s.room().snapshot,version:s.room().version,saved_revision:'r1'});await flush();expect(s.getLocal().body).not.toContain('Peer edit');
  s.setPut(null);s.compose(false);await s.shared.prepareSave();expect(s.getLocal().body).toContain('composing text');expect(s.getLocal().body).toContain('Peer edit');
 }finally{s.dispose();}
});
