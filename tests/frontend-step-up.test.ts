// @vitest-environment jsdom
import { beforeEach,afterEach,it,expect,vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
const source=fs.readFileSync(path.join(import.meta.dirname,'../public/js/api.js'),'utf8');
const w=window as any;
const response=(status:number,body:unknown)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
let client:any,fetchMock:ReturnType<typeof vi.fn>;
beforeEach(()=>{
  localStorage.clear();sessionStorage.clear();w.VDS_COOKIE_AUTH=true;delete w.VDS_NATIVE;delete w.VDS_BASE_PATH;
  fetchMock=vi.fn(async()=>response(403,{error:'Verify first',step_up_required:true,mfa_required:true}));vi.stubGlobal('fetch',fetchMock);
  w.AuthStepUp={verify:vi.fn(async()=>{}),cancel:vi.fn()};client=new Function(source+'\nreturn API;')();
});
afterEach(()=>{delete w.AuthStepUp;delete w.VDS_COOKIE_AUTH;delete w.VDS_BASE_PATH;vi.unstubAllGlobals();});
it('retries the exact denied mutation once after successful confirmation',async()=>{
  fetchMock.mockResolvedValueOnce(response(403,{step_up_required:true,mfa_required:true})).mockResolvedValueOnce(response(201,{id:12}));
  const body={username:'confirmed',password:'synthetic passphrase',role:'warehouse'};
  expect(await client.post('/users',body)).toEqual({id:12});expect(w.AuthStepUp.verify).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledTimes(2);expect((fetchMock.mock.calls[0] as any)[1].body).toBe((fetchMock.mock.calls[1] as any)[1].body);
});
it('cancellation cannot retry or apply the denied action',async()=>{
  w.AuthStepUp.verify.mockRejectedValue(new Error('Verification cancelled'));
  await expect(client.post('/users',{username:'cancelled'})).rejects.toThrow('cancelled');expect(fetchMock).toHaveBeenCalledTimes(1);
});
it('a sign-in change during confirmation cannot replay the old action under a new identity',async()=>{
  let finish!:()=>void;w.AuthStepUp.verify.mockImplementation(()=>new Promise<void>(resolve=>{finish=resolve;}));
  const pending=client.post('/users',{username:'original'});await vi.waitFor(()=>expect(w.AuthStepUp.verify).toHaveBeenCalled());
  client.clearToken();finish();await expect(pending).rejects.toThrow('changed');expect(fetchMock).toHaveBeenCalledTimes(1);
});
it('a company change during confirmation cannot replay the old action against another company',async()=>{
  let finish!:()=>void;w.AuthStepUp.verify.mockImplementation(()=>new Promise<void>(resolve=>{finish=resolve;}));
  const pending=client.post('/users',{username:'original'});await vi.waitFor(()=>expect(w.AuthStepUp.verify).toHaveBeenCalled());
  w.VDS_BASE_PATH='/other-company';finish();await expect(pending).rejects.toThrow('changed');expect(fetchMock).toHaveBeenCalledTimes(1);
});
it('a repeated denial does not cause an endless confirmation loop',async()=>{
  await expect(client.post('/users',{})).rejects.toThrow('Verify first');expect(fetchMock).toHaveBeenCalledTimes(2);expect(w.AuthStepUp.verify).toHaveBeenCalledTimes(1);
});
