/** public/js/api.js 401 handling: a rejected sign-in must show the server's message
    ("Invalid username or password"), not "Session expired", while a 401 on any other
    endpoint still clears the token and sends the user back to the login screen. */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

type ApiClient = { post: (p: string, b?: unknown) => Promise<unknown>; get: (p: string) => Promise<unknown> };

function loadApi(): ApiClient {
  const src = fs.readFileSync(path.join(import.meta.dirname, '../public/js/api.js'), 'utf8');
  // eslint-disable-next-line no-new-func
  return new Function(`${src}\nreturn API;`)() as ApiClient;
}

function reply401(error: string) {
  return vi.fn(async () => new Response(JSON.stringify({ error }), {
    status: 401, headers: { 'Content-Type': 'application/json' },
  }));
}

describe('api.js 401 handling', () => {
  const showLogin = vi.fn();
  beforeEach(() => {
    localStorage.clear();
    showLogin.mockReset();
    (window as unknown as { App: unknown }).App = { showLogin };
  });

  it('a wrong password on sign-in shows the server message and keeps the login screen as-is', async () => {
    localStorage.setItem('vds_token', 'stale');
    vi.stubGlobal('fetch', reply401('Invalid username or password'));
    const API = loadApi();
    await expect(API.post('/auth/login', { username: 'admin', password: 'x' }))
      .rejects.toThrow('Invalid username or password');
    expect(showLogin).not.toHaveBeenCalled();
  });

  it('a 401 on any other endpoint is still an expired session', async () => {
    localStorage.setItem('vds_token', 'stale');
    vi.stubGlobal('fetch', reply401('Not authenticated'));
    const API = loadApi();
    await expect(API.get('/auth/me')).rejects.toThrow('Session expired. Please sign in again.');
    expect(showLogin).toHaveBeenCalledOnce();
    expect(localStorage.getItem('vds_token')).toBeNull();
  });
});

/** API.peek: the last response of a GET made with { remember: true }, so a screen can draw it
    while the fresh copy loads (hr-employees.js). Memory only; any change or sign-out empties it. */
describe('api.js remembered GETs', () => {
  type Peekable = ApiClient & {
    get: (p: string, o?: { remember?: boolean; rememberScope?: string; rememberValid?: (data: any) => boolean }) => Promise<unknown>;
    peek: (p: string, o?: {scope?:string;maxAge?:number}) => unknown; clearToken: () => void;
    setToken: (t:string) => void;
  };
  let n = 0;
  beforeEach(() => {
    localStorage.clear();
    n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ n: ++n }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })));
  });

  it('keeps only opted-in GETs, and forgets them after any change or on sign-out', async () => {
    const API = loadApi() as Peekable;
    await API.get('/hr/employees?');
    expect(API.peek('/hr/employees?')).toBeNull();

    await API.get('/hr/employees?', { remember: true });
    expect(API.peek('/hr/employees?')).toEqual({ n: 2 });
    expect(Object.keys(localStorage)).toEqual(['vds_device_id']); // the response is never stored

    await API.post('/hr/employees', { name: 'x' });
    expect(API.peek('/hr/employees?')).toBeNull();

    await API.get('/hr/employees?', { remember: true });
    API.clearToken();
    expect(API.peek('/hr/employees?')).toBeNull();
  });

  it('isolates permission scopes and expires overview snapshots without storing them on disk',async()=>{
    const API=loadApi() as Peekable,clock=vi.spyOn(Date,'now');
    try{clock.mockReturnValue(1000);await API.get('/queue',{remember:true,rememberScope:'grants-a'});
      expect(API.peek('/queue',{scope:'grants-b',maxAge:60000})).toBeNull();expect(API.peek('/queue',{scope:'grants-a',maxAge:60000})).toEqual({n:1});
      clock.mockReturnValue(61001);expect(API.peek('/queue',{scope:'grants-a',maxAge:60000})).toBeNull();expect(Object.keys(localStorage)).toEqual(['vds_device_id']);
    }finally{clock.mockRestore();}
  });

  it('does not remember a malformed response over the last validated snapshot',async()=>{
    const API=loadApi() as Peekable;await API.get('/queue',{remember:true,rememberValid:d=>d.n===1});await API.get('/queue',{remember:true,rememberValid:d=>d.n===1});expect(API.peek('/queue')).toEqual({n:1});
  });

  it('rejects remembered data after a server or session change',async()=>{
    const API=loadApi() as Peekable;API.setToken('first');await API.get('/queue',{remember:true});API.setToken('second');expect(API.peek('/queue')).toBeNull();
    await API.get('/queue',{remember:true});const previous=(window as any).VDS_BASE_PATH;
    try{(window as any).VDS_BASE_PATH='/another-tenant';expect(API.peek('/queue')).toBeNull();}finally{(window as any).VDS_BASE_PATH=previous;}
  });

  it('does not repopulate a snapshot with a GET that finishes after a write',async()=>{
    const API=loadApi() as Peekable;let finish!:(r:Response)=>void;
    vi.stubGlobal('fetch',vi.fn((_url,init)=>init.method==='GET'?new Promise<Response>(r=>finish=r):Promise.resolve(new Response('{}',{headers:{'Content-Type':'application/json'}}))));
    const old=API.get('/queue',{remember:true});await API.post('/action',{});finish(new Response('{"n":1}',{headers:{'Content-Type':'application/json'}}));await old;expect(API.peek('/queue')).toBeNull();
  });

  it('keeps a late response from a previous sign-in out of the new account cache',async()=>{
    const API=loadApi() as Peekable;API.setToken('first');let finish!:(r:Response)=>void;vi.stubGlobal('fetch',vi.fn(()=>new Promise<Response>(r=>finish=r)));
    const old=API.get('/queue',{remember:true});API.setToken('second');finish(new Response('{"private":true}',{headers:{'Content-Type':'application/json'}}));await old;expect(API.peek('/queue')).toBeNull();
  });

  it('clears overview snapshots when the server denies current access',async()=>{
    const API=loadApi() as Peekable;await API.get('/queue',{remember:true});vi.stubGlobal('fetch',vi.fn(async()=>new Response('{"error":"Access revoked"}',{status:403,headers:{'Content-Type':'application/json'}})));
    await expect(API.get('/queue')).rejects.toThrow('Access revoked');expect(API.peek('/queue')).toBeNull();
  });

  it('does not discard a permitted queue for an unrelated denied endpoint',async()=>{
    const API=loadApi() as Peekable;await API.get('/queue',{remember:true});vi.stubGlobal('fetch',vi.fn(async()=>new Response('{"error":"No Inbox access"}',{status:403,headers:{'Content-Type':'application/json'}})));
    await expect(API.get('/messages/unread-count')).rejects.toThrow('No Inbox access');expect(API.peek('/queue')).toEqual({n:1});
  });

  it('does not revive a denied queue with an older in-flight success',async()=>{
    const API=loadApi() as Peekable;let finish!:(r:Response)=>void,calls=0;
    vi.stubGlobal('fetch',vi.fn(()=>++calls===1?new Promise<Response>(r=>finish=r):Promise.resolve(new Response('{"error":"Access revoked"}',{status:403,headers:{'Content-Type':'application/json'}}))));
    const old=API.get('/queue',{remember:true});await expect(API.get('/queue')).rejects.toThrow('Access revoked');finish(new Response('{"n":1}',{headers:{'Content-Type':'application/json'}}));await old;expect(API.peek('/queue')).toBeNull();
  });

  it('does not let an old account write completion clear a new account preview',async()=>{
    const API=loadApi() as Peekable;API.setToken('first');let finish!:(r:Response)=>void;
    vi.stubGlobal('fetch',vi.fn((_url,init)=>init.method==='POST'?new Promise<Response>(r=>finish=r):Promise.resolve(new Response('{"n":2}',{headers:{'Content-Type':'application/json'}}))));
    const old=API.post('/action',{});API.setToken('second');await API.get('/queue',{remember:true});finish(new Response('{}',{headers:{'Content-Type':'application/json'}}));await old;expect(API.peek('/queue')).toEqual({n:2});
  });
});

describe('api.js cancellable capture fetches', () => {
  it('passes an opted-in signal to upload and makes no retry when it is aborted', async () => {
    localStorage.clear();
    const fetcher = vi.fn((_url: unknown, init: any) => new Promise((_resolve, reject) => { init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }); }));
    vi.stubGlobal('fetch', fetcher);
    const API = loadApi() as ApiClient & { upload: (p: string, b: FormData, opts: { signal: AbortSignal }) => Promise<unknown> };
    const controller = new AbortController(), body = new FormData(); body.append('slot', 'out');
    const result = API.upload('/hr/clock/punch/selfie', body, { signal: controller.signal }); controller.abort();
    await expect(result).rejects.toMatchObject({ offline: true });
    expect(fetcher).toHaveBeenCalledOnce(); expect(fetcher.mock.calls[0]?.[1].signal).toBe(controller.signal); expect(fetcher.mock.calls[0]?.[1].body).toBe(body);
  });
});
