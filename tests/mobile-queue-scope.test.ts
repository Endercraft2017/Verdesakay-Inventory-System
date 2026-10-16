/// <reference lib="dom" />
import { it, expect, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { IDBFactory } from 'fake-indexeddb';
import fs from 'node:fs';
const queue=fs.readFileSync(new URL('../public/mobile/lib/queue.js',import.meta.url),'utf8');
const worker=fs.readFileSync(new URL('../public/mobile/sw.js',import.meta.url),'utf8');
async function open(idb:IDBFactory,name='vds_mobile') {
  return new Promise<IDBDatabase>((resolve,reject)=>{
    const r=idb.open(name,2);
    r.onupgradeneeded=()=>{if(!r.result.objectStoreNames.contains('ops'))r.result.createObjectStore('ops',{keyPath:'key'});if(!r.result.objectStoreNames.contains('meta'))r.result.createObjectStore('meta',{keyPath:'k'});};
    r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
  });
}
async function read(db:IDBDatabase,store:string,key:string) { return new Promise<any>((resolve,reject)=>{const r=db.transaction(store).objectStore(store).get(key);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);}); }
async function put(db:IDBDatabase,store:string,value:unknown) { return new Promise<void>((resolve,reject)=>{const t=db.transaction(store,'readwrite');t.objectStore(store).put(value);t.oncomplete=()=>resolve();t.onerror=()=>reject(t.error);}); }
it('foreground replay binds account and original server; legacy operations remain untouched',async()=>{
  const dom=new JSDOM('',{runScripts:'outside-only',url:'https://company.example.test/m'}),w=dom.window as any;
  const idb=new IDBFactory();let scope='https://company.example.test';const post=vi.fn(async()=>({ok:true}));
  w.indexedDB=idb;Object.defineProperty(w.navigator,'onLine',{value:false});
  w.API={serverScope:()=>scope,post,deviceId:()=>null,cookieAuth:()=>false};w.eval(queue);
  try {
    await w.mQueue.setToken('browser-fixture',{id:7});
    await w.mQueue.enqueue({key:'company-a-work',path:'/inventory/1/adjust',body:{quantity:1}});
    await w.mQueue._put({key:'legacy-work',user_id:7,path:'/inventory/1/adjust',body:{quantity:2}});
    expect(await w.mQueue.count()).toBe(1);expect(await w.mQueue.foreignCount()).toBe(1);
    scope='https://other.example.test';await w.mQueue.setToken('other-fixture',{id:7});
    expect(await w.mQueue.count()).toBe(0);await w.mQueue.flush();expect(post).not.toHaveBeenCalled();
    scope='https://company.example.test';await w.mQueue.setToken('original-fixture',{id:7});await w.mQueue.flush();
    expect(post).toHaveBeenCalledExactlyOnceWith('/inventory/1/adjust',{quantity:1},{idempotencyKey:'company-a-work',expectedUserId:7,expectedServer:scope});
    const all=await w.mQueue._every();expect(all.map((x:any)=>x.key)).toEqual(['legacy-work']);
  } finally {dom.window.close();}
});
it('native queue removes the bearer mirror while preserving business operations',async()=>{
  const dom=new JSDOM('',{runScripts:'outside-only',url:'https://localhost/m'}),w=dom.window as any;
  const idb=new IDBFactory();w.indexedDB=idb;Object.defineProperty(w.navigator,'onLine',{value:false});
  w.API={serverScope:()=> 'https://company.example.test',post:vi.fn(),deviceId:()=>null,cookieAuth:()=>false};w.eval(queue);
  try {
    await w.mQueue.setToken('old-browser-token',{id:1});
    await w.mQueue.enqueue({key:'preserved-work',path:'/notes',body:{title:'Saved'}});
    w.VDS_NATIVE=true;await w.mQueue.setToken('must-not-persist',{id:1});
    const db=await open(idb);
    expect(await read(db,'meta','token')).toBeUndefined();
    expect((await read(db,'ops','preserved-work')).server).toBe('https://company.example.test');db.close();
  } finally {dom.window.close();}
});
it('service-worker replay uses cookie CSRF and actor headers, rejects other-server and unbound work',async()=>{
  const idb=new IDBFactory();const db=await open(idb,'vds_mobile/company');
  const origin='https://example.test',scope=origin+'/company';
  await put(db,'meta',{k:'token',v:null,cookie_auth:true,user_id:7,server:scope,device_id:'fixture-device'});
  for (const op of [
    {key:'valid',user_id:7,server:scope}, {key:'other-account',user_id:8,server:scope},
    {key:'other-server',user_id:7,server:'https://other.test'}, {key:'unbound',user_id:7},
  ]) await put(db,'ops',{...op,path:'/notes',method:'POST',body:{title:'Saved'}});
  const fetch=vi.fn(async()=>new Response('{}',{status:200,headers:{'Content-Type':'application/json'}}));
  const self={location:{origin},addEventListener:()=>{},clients:{matchAll:async()=>[]}};
  const replay=new Function('self','indexedDB','fetch',"var TENANT_BASE='/company';\n"+worker+'\nreturn replayQueue;')(self,idb,fetch);
  await replay();expect(fetch).toHaveBeenCalledTimes(1);
  const [url,init]=fetch.mock.calls[0] as unknown as [string,RequestInit];expect(url).toBe('/company/api/notes');
  expect(init.credentials).toBe('same-origin');
  expect(init.headers).toMatchObject({'X-Requested-With':'VDS','X-Session-Mode':'cookie','X-Queue-Actor':'7','X-Client':'mobile'});
  expect((init.headers as Record<string,string>).Authorization).toBeUndefined();
  expect(await read(db,'ops','valid')).toBeUndefined();expect(await read(db,'ops','unbound')).toBeTruthy();
  expect(await read(db,'ops','other-account')).toBeTruthy();expect(await read(db,'ops','other-server')).toBeTruthy();db.close();
});
it('a worker with metadata for a different server performs no replay',async()=>{
  const idb=new IDBFactory();const db=await open(idb);
  await put(db,'meta',{k:'token',v:'old-token',user_id:7,server:'https://other.test'});
  await put(db,'ops',{key:'kept',user_id:7,server:'https://other.test',path:'/notes',body:{}});
  const fetch=vi.fn();const self={location:{origin:'https://example.test'},addEventListener:()=>{},clients:{matchAll:async()=>[]}};
  await new Function('self','indexedDB','fetch',worker+'\nreturn replayQueue;')(self,idb,fetch)();
  expect(fetch).not.toHaveBeenCalled();expect(await read(db,'ops','kept')).toBeTruthy();db.close();
});
it('queue UI does not claim all work is synced when quarantined actions remain or storage fails',async()=>{
  const dom=new JSDOM('<main id="view"></main>',{runScripts:'outside-only',url:'https://company.example.test/m#queue'}),w=dom.window as any;
  let render!:(view:HTMLElement)=>void;
  w.MApp={route:(_name:string,fn:typeof render)=>{render=fn;},setTitle:()=>{}};
  w.mQueue={all:async()=>[],foreignCount:async()=>1,onChange:()=>()=>{}};
  w.mEl=(html:string)=>{const div=w.document.createElement('div');div.innerHTML=html;return div.firstChild;};
  w.eval(fs.readFileSync(new URL('../public/mobile/modules/inventory/queue-view.js',import.meta.url),'utf8'));
  try {
    const view=w.document.getElementById('view');render(view);await new Promise(resolve=>setTimeout(resolve,0));
    expect(view.textContent).toContain('administrator review');expect(view.textContent).not.toContain('Everything is synced');
    w.mQueue.all=async()=>{throw new Error('private database details');};render(view);await new Promise(resolve=>setTimeout(resolve,0));
    expect(view.textContent).toContain('status is unknown');expect(view.textContent).not.toContain('private database');
  } finally {dom.window.close();}
});
