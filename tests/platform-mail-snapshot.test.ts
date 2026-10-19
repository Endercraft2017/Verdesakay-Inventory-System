import { DatabaseSync, type StatementSync } from 'node:sqlite';
import nodemailer from 'nodemailer';
import { beforeAll, beforeEach, afterEach, afterAll, expect, it, vi } from 'vitest';
import { setupApp, cleanup, type TestContext } from './helpers';
let ctx: TestContext, mail: typeof import('../src/platform/platform-mail'), platform: typeof import('../src/platform/platform'), token: string;
const oldSettings={transport:'smtp' as const,from_email:'alerts@example.test',alert_to:'owner@example.test',smtp_host:'old.example.test',smtp_user:'old-user'};
const secretRow=()=>platform.platformDb().prepare("SELECT value FROM platform_mail WHERE key='secret'").get()!.value;
beforeAll(async()=>{
  process.env.PLATFORM_CONSOLE='true';ctx=await setupApp();mail=await import('../src/platform/platform-mail');platform=await import('../src/platform/platform');
  (await import('../src/platform/platform-users')).upsertPlatformUser('snapshot-operator','Synthetic snapshot operator password');
  token=(await ctx.api.post('/_platform/api/login').send({username:'snapshot-operator',password:'Synthetic snapshot operator password'})).body.token;
});
beforeEach(()=>mail.savePlatformMail(oldSettings,'synthetic-old-password'));
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
afterAll(()=>{delete process.env.PLATFORM_CONSOLE;cleanup(ctx);});

it('does not combine a concurrent configuration generations host and password',async()=>{
  const d=platform.platformDb();
  mail.savePlatformMail({smtp_host:'new.example.test',smtp_user:'new-user'},'synthetic-new-password');
  const newRows=d.prepare("SELECT key,value FROM platform_mail WHERE key IN ('settings','secret')").all() as Array<{key:string;value:string}>;
  mail.savePlatformMail(oldSettings,'synthetic-old-password');const stamp=mail.platformMailBinding().stamp;
  const writer=new DatabaseSync(process.env.PLATFORM_DB_PATH!);let changed=false;
  const original=d.prepare.bind(d);
  vi.spyOn(d,'prepare').mockImplementation((sql:string)=>{
    const statement=original(sql);
    if(!sql.includes("WHERE key IN ('settings','secret','_key')"))return statement;
    return {all:()=>{
      const rows=statement.all();
      if(!changed){changed=true;writer.exec('BEGIN IMMEDIATE');try{
        for(const row of newRows)writer.prepare('UPDATE platform_mail SET value=? WHERE key=?').run(row.value,row.key);
        writer.exec('COMMIT');
      }catch(error){writer.exec('ROLLBACK');throw error;}}
      return rows;
    }} as unknown as StatementSync;
  });
  vi.stubEnv('NODE_ENV','production');
  const send=vi.spyOn(nodemailer,'createTransport').mockReturnValue({sendMail:vi.fn(async()=>({accepted:['owner@example.test'],rejected:[]})),close:vi.fn()} as unknown as ReturnType<typeof nodemailer.createTransport>);
  try{
    expect(await mail.deliverPlatformMail({to:['owner@example.test'],subject:'Synthetic',text:'Synthetic'},stamp)).toMatchObject({outcome:'accepted'});
    expect(changed).toBe(true);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({host:'old.example.test',auth:{user:'old-user',pass:'synthetic-old-password'}}));
    expect(mail.getPlatformMail().smtp_host).toBe('new.example.test');
  }finally{writer.close();}
});
it('rolls settings and encrypted credentials back together when the credential write fails',()=>{
  const before=mail.getPlatformMail(),encoded=secretRow(),d=platform.platformDb();
  d.exec("CREATE TRIGGER snapshot_secret_failure BEFORE INSERT ON platform_mail WHEN NEW.key='secret' BEGIN SELECT RAISE(ABORT,'synthetic secret write failure'); END");
  try{expect(()=>mail.savePlatformMail({smtp_host:'different.example.test'},'synthetic-replacement')).toThrow('synthetic secret write failure');}
  finally{d.exec('DROP TRIGGER snapshot_secret_failure');}
  expect(mail.getPlatformMail()).toEqual(before);expect(secretRow()).toBe(encoded);
});
it('rolls a console configuration/credential change back if its audit fails',async()=>{
  const before=mail.getPlatformMail(),encoded=secretRow(),d=platform.platformDb();
  d.exec("CREATE TRIGGER snapshot_audit_failure BEFORE INSERT ON provisioning_log WHEN NEW.action='platform-mail-settings' BEGIN SELECT RAISE(ABORT,'synthetic-private-mail-audit'); END");
  try{
    const response=await ctx.api.put('/_platform/api/mail').set('Authorization','Bearer '+token).send({smtp_host:'different.example.test',secret:'synthetic-replacement'});
    expect(response.status).toBe(500);expect(response.body).toEqual({error:'Internal server error',request_id:response.headers['x-request-id']});
  }finally{d.exec('DROP TRIGGER snapshot_audit_failure');}
  expect(mail.getPlatformMail()).toEqual(before);expect(secretRow()).toBe(encoded);
});
