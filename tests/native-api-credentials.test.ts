// @vitest-environment jsdom
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createNativeCredentials } from '../mobile-app/native-credentials.mjs';
const source=fs.readFileSync(path.join(import.meta.dirname,'../public/js/api.js'),'utf8');
const w=window as any;
let client:any, saved:Map<string,unknown>, secure:any, fetchMock:ReturnType<typeof vi.fn>;
const reply=(body:unknown)=>new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
beforeEach(async()=>{
  localStorage.clear(); sessionStorage.clear(); localStorage.setItem('vds_api_base','https://company.example.test');
  w.VDS_NATIVE=true; saved=new Map();
  secure={setSynchronize:async()=>{},setDefaultKeychainAccess:async()=>{},get:async(k:string)=>saved.get(k)||null,set:async(k:string,v:unknown)=>{saved.set(k,v);},remove:async(k:string)=>saved.delete(k)};
  w.VdsNativeCredentials=createNativeCredentials({secure,available:()=>true,storage:localStorage,tabStorage:sessionStorage,server:()=>localStorage.getItem('vds_api_base')||'',purgeQueue:async()=>{},deviceOnlyAccess:1});
  await w.VdsNativeCredentials.ready;
  fetchMock=vi.fn(async()=>reply({ok:true})); vi.stubGlobal('fetch',fetchMock);
  client=new Function(source+'\nreturn API;')();
});
afterEach(()=>{delete w.VDS_NATIVE;delete w.VdsNativeCredentials;vi.unstubAllGlobals();});
it('persists issued sessions only through the vault and uses memory for request headers',async()=>{
  fetchMock.mockResolvedValueOnce(reply({token:'new-native-token'}));
  const login=await client.post('/auth/login',{username:'user',password:'synthetic passphrase'});
  await client.setToken(login.token);
  expect(client.getToken()).toBe('new-native-token');
  expect(localStorage.getItem('vds_token')).toBeNull();expect(sessionStorage.getItem('vds_token')).toBeNull();
  await client.get('/auth/me');
  expect((fetchMock.mock.calls[1] as any)[1].headers.Authorization).toBe('Bearer new-native-token');
  await client.clearToken(); expect(client.getToken()).toBeNull();expect(saved.size).toBe(0);
});
it('missing native bridge prevents even password submission instead of falling back',async()=>{
  delete w.VdsNativeCredentials;
  await expect(client.post('/auth/login',{password:'do not transmit'})).rejects.toThrow('Secure sign-in storage');
  expect(fetchMock).not.toHaveBeenCalled();
});
it('refuses plaintext HTTP before sending credentials',async()=>{
  localStorage.setItem('vds_api_base','http://company.example.test');
  await expect(client.post('/auth/login',{password:'do not transmit'})).rejects.toThrow('HTTPS');
  expect(fetchMock).not.toHaveBeenCalled();
});
it('failed persistence revokes the issued session against its original server',async()=>{
  fetchMock.mockResolvedValueOnce(reply({token:'cannot-save-token'}));
  secure.set=async()=>{throw new Error('OS failure');};
  const login=await client.post('/auth/login',{});
  await expect(client.setToken(login.token)).rejects.toThrow('Secure sign-in storage');
  expect(client.getToken()).toBeNull();
  expect((fetchMock.mock.calls[1] as any)[0]).toBe('https://company.example.test/api/auth/logout');
});
it('changing servers while login is in flight cannot bind or disclose its result to the new company',async()=>{
  let finish!:(r:Response)=>void;
  fetchMock.mockImplementationOnce(()=>new Promise<Response>(resolve=>{finish=resolve;}));
  const login=client.post('/auth/login',{});
  await new Promise(resolve=>setTimeout(resolve,0));
  localStorage.setItem('vds_api_base','https://other.example.test'); finish(reply({token:'original-company-token'}));
  await expect(login).rejects.toThrow('changed');
  expect(client.getToken()).toBeNull(); expect(saved.size).toBe(0);
  expect(fetchMock.mock.calls.map(c=>c[0])).toEqual(['https://company.example.test/api/auth/login','https://company.example.test/api/auth/logout']);
});
it('logout cancels an in-flight login before its response can reopen the session',async()=>{
  let finish!:(r:Response)=>void;
  fetchMock.mockImplementationOnce(()=>new Promise<Response>(resolve=>{finish=resolve;}));
  const login=client.post('/auth/login',{}); await new Promise(resolve=>setTimeout(resolve,0));
  await client.clearToken(); finish(reply({token:'late-token'}));
  await expect(login).rejects.toThrow('changed'); expect(client.getToken()).toBeNull(); expect(saved.size).toBe(0);
});
it('queued requests cannot cross a company-server boundary',async()=>{
  localStorage.setItem('vds_api_base','https://other.example.test');
  await expect(client.post('/inventory/1/adjust',{qty:1},{expectedServer:'https://company.example.test',expectedUserId:1})).rejects.toThrow('different company');
  expect(fetchMock).not.toHaveBeenCalled();
});
