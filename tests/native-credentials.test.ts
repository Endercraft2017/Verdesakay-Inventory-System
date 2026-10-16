/// <reference lib="dom" />
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createNativeCredentials, purgeNativeQueueToken } from '../mobile-app/native-credentials.mjs';
class Storage {
  values = new Map<string,string>();
  getItem(k:string) { return this.values.get(k) ?? null; }
  setItem(k:string,v:string) { this.values.set(k,String(v)); }
  removeItem(k:string) { this.values.delete(k); }
}
function fixture(options: { storage?:Storage; saved?:Map<string,any>; state?:Partial<{base:string;available:boolean;purged:number}>; secure?:Partial<import('../mobile-app/native-credentials.mjs').NativeSecureStore> } = {}) {
  const storage = options.storage || new Storage(), tabStorage = new Storage(), saved = options.saved || new Map<string,any>();
  const state = { base:'https://company.example.test', available:true, purged:0, ...options.state };
  const secure = {
    async setSynchronize(value:boolean) { assert.equal(value,false); },
    async setDefaultKeychainAccess(value:number) { assert.equal(value,1); },
    async get(k:string) { return structuredClone(saved.get(k) ?? null); },
    async set(k:string,v:any) { saved.set(k,structuredClone(v)); },
    async remove(k:string) { return saved.delete(k); },
    ...options.secure
  };
  const open = () => createNativeCredentials({ secure, available:()=>state.available, storage, tabStorage,
    server:()=>state.base, purgeQueue:async()=>{ state.purged++; }, deviceOnlyAccess:1 });
  return { storage, tabStorage, saved, state, secure, open };
}

test('legacy unbound bearer is removed; only a fresh sign-in may populate the vault', async () => {
  const f=fixture(); f.storage.setItem('vds_token','legacy-token');
  const a=f.open(); await a.ready;
  assert.equal(a.getToken(),null);
  assert.equal(f.saved.size,0);
  await a.set('fresh-bound-token');
  assert.equal(f.storage.getItem('vds_token'),null);
  assert.equal(f.tabStorage.getItem('vds_token'),null);
  assert.equal(f.saved.get('otom-session-v1').server,f.state.base);
  assert.equal(f.state.purged,2);
  const b=f.open(); await b.ready; assert.equal(b.getToken(),'fresh-bound-token');
});
test('shared sign-in is memory-only and cannot resume on restart', async () => {
  const f=fixture(); const a=f.open(); await a.ready;
  await a.set('borrowed-token',{shared:true});
  assert.equal(a.getToken(),'borrowed-token'); assert.equal(a.isShared(),true);
  assert.equal(f.saved.size,0);
  const b=f.open(); await b.ready; assert.equal(b.getToken(),null);
});
test('legacy borrowed session is cleared and never becomes persistent', async () => {
  const f=fixture(); f.tabStorage.setItem('vds_token','borrowed-legacy');
  const a=f.open(); await a.ready;
  assert.equal(a.getToken(),null); assert.equal(a.isShared(),false);
  assert.equal(f.saved.size,0); assert.equal(f.tabStorage.getItem('vds_token'),null);
});
test('absent native plugin never falls back to web storage', async () => {
  const f=fixture({state:{available:false}}); f.storage.setItem('vds_token','legacy-token');
  const a=f.open(); await assert.rejects(a.ready,/Secure sign-in storage/);
  assert.equal(a.getToken(),null); assert.equal(f.storage.getItem('vds_token'),null); assert.equal(f.saved.size,0);
});
test('failed OS write never publishes or stores a plaintext bearer', async () => {
  const f=fixture({secure:{async set(){throw new Error('OS failure');}}}); const a=f.open(); await a.ready;
  await assert.rejects(a.set('new-token'),/Secure sign-in storage/);
  assert.equal(a.getToken(),null); assert.equal(f.storage.getItem('vds_token'),null);
  assert.equal(f.storage.getItem('otom-native-signed-out'),'1');
});
test('failed deletion cannot resurrect a signed-out credential on restart', async () => {
  const f=fixture(); const a=f.open(); await a.ready; await a.set('existing-token');
  const remove=f.secure.remove; f.secure.remove=async()=>{throw new Error('locked');};
  const removal=a.clear(); assert.equal(a.getToken(),null); await assert.rejects(removal);
  assert.equal(f.saved.size,1);
  f.secure.remove=remove;
  const b=f.open(); await b.ready;
  assert.equal(b.getToken(),null); assert.equal(f.saved.size,0);
});
test('server changes cannot send an old company credential', async () => {
  const f=fixture(); const a=f.open(); await a.ready; await a.set('company-a-token');
  f.state.base='https://other-company.example.test'; assert.equal(a.getToken(),null);
  const b=f.open(); await b.ready; assert.equal(b.getToken(),null); assert.equal(f.saved.size,0);
});
test('plaintext HTTP cannot receive a native bearer', async () => {
  const f=fixture({state:{base:'http://company.example.test'}}); const a=f.open(); await a.ready;
  await assert.rejects(a.set('unsafe-token'));
  assert.equal(a.getToken(),null); assert.equal(f.saved.size,0);
});
test('logout cancels a pending sign-in write before it can publish a credential', async () => {
  const f=fixture(); const a=f.open(); await a.ready;
  let release!:()=>void, started!:()=>void;
  const waiting = new Promise<void>(resolve=>{started=resolve;});
  const original=f.secure.set;
  f.secure.set=async(...args)=>{started(); await new Promise<void>(resolve=>{release=resolve;}); return original(...args);};
  const setting=a.set('pending-token'); await waiting;
  const clearing=a.clear(); release();
  await assert.rejects(setting); await clearing;
  assert.equal(a.getToken(),null); assert.equal(f.saved.size,0);
});
test('queue-token migration preserves queued business records', async () => {
  const idb=new IDBFactory();
  const db=await new Promise<IDBDatabase>((resolve,reject)=>{
    const request=idb.open('vds_mobile',2);
    request.onupgradeneeded=()=>{request.result.createObjectStore('ops',{keyPath:'key'});request.result.createObjectStore('meta',{keyPath:'k'});};
    request.onerror=()=>reject(request.error); request.onsuccess=()=>resolve(request.result);
  });
  await new Promise((resolve,reject)=>{
    const tx=db.transaction(['ops','meta'],'readwrite');
    tx.objectStore('ops').put({key:'pending-work',user_id:1,body:{quantity:3}});
    tx.objectStore('meta').put({k:'token',v:'old-plaintext-token'});
    tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
  });
  db.close(); await purgeNativeQueueToken(idb);
  const check=await new Promise<IDBDatabase>(resolve=>{const r=idb.open('vds_mobile');r.onsuccess=()=>resolve(r.result);});
  async function read(store:string,key:string) { return new Promise(resolve=>{const r=check.transaction(store).objectStore(store).get(key);r.onsuccess=()=>resolve(r.result);}); }
  assert.equal(await read('meta','token'),undefined);
  assert.deepEqual(await read('ops','pending-work'),{key:'pending-work',user_id:1,body:{quantity:3}});
  check.close();
});
