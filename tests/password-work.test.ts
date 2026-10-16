import { it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { withPasswordWork, passwordWorkState, PasswordWorkBusyError } from '../src/shared/password-work';
import { hashPassword, verifyPassword, verifyPasswordForLogin } from '../src/shared/password-hash';
it('runs real scrypt asynchronously without weakening its format or blocking the event loop',async()=>{
  const password=randomUUID(),hash=hashPassword(password),work=verifyPasswordForLogin(password,hash);
  expect(await Promise.race([work.then(()=> 'password'),new Promise(resolve=>setImmediate(()=>resolve('event loop')))])).toBe('event loop');
  expect(await work).toEqual({valid:true});expect(await verifyPasswordForLogin(password+'x',hash)).toEqual({valid:false});
  expect(passwordWorkState()).toEqual({active:0,queued:0});
});
it('upgrades only verified legacy credentials and preserves installed-host compatibility',async()=>{
  const password=randomUUID(),legacy=bcrypt.hashSync(password,4);
  expect(await verifyPasswordForLogin('wrong',legacy)).toEqual({valid:false});
  const checked=await verifyPasswordForLogin(password,legacy);
  expect(checked.valid).toBe(true);expect(checked.upgradedHash).toMatch(/^scrypt\$v1\$/);expect(verifyPassword(password,checked.upgradedHash!)).toBe(true);
  expect(await verifyPasswordForLogin(password,legacy,false)).toEqual({valid:true});
  const long='🔐'.repeat(25);expect(await verifyPasswordForLogin(long,bcrypt.hashSync(long,4))).toEqual({valid:false});
  expect(await verifyPasswordForLogin(password,'scrypt$broken')).toEqual({valid:false});
});
it('bounds work to one active and eight waiting jobs with FIFO progress',async()=>{
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),order:number[]=[];
  const first=withPasswordWork(async()=>{await gate;order.push(0);return 0;});
  const waiting=Array.from({length:8},(_,i)=>withPasswordWork(async()=>{order.push(i+1);return i+1;}));
  try {expect(passwordWorkState()).toEqual({active:1,queued:8});await expect(withPasswordWork(async()=>99)).rejects.toBeInstanceOf(PasswordWorkBusyError);}
  finally {release();await Promise.all([first,...waiting]);}
  expect(order).toEqual([0,1,2,3,4,5,6,7,8]);expect(passwordWorkState()).toEqual({active:0,queued:0});
});
it('expires queued work instead of keeping an authentication backlog',async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),first=withPasswordWork(()=>gate),queued=withPasswordWork(async()=>true);
  const expired=expect(queued).rejects.toBeInstanceOf(PasswordWorkBusyError);
  try {await vi.advanceTimersByTimeAsync(10_001);await expired;expect(passwordWorkState()).toEqual({active:1,queued:0});}
  finally {release();await first;vi.useRealTimers();}
});
it('releases capacity after a failed job',async()=>{
  const first=withPasswordWork(async()=>{throw new Error('synthetic failure');}),next=withPasswordWork(async()=> 'next');
  await expect(first).rejects.toThrow('synthetic failure');expect(await next).toBe('next');expect(passwordWorkState()).toEqual({active:0,queued:0});
});
