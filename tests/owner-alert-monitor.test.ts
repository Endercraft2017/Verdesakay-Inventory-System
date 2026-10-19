import {beforeAll,beforeEach,afterAll,afterEach,it,expect,vi} from 'vitest';
import {setupApp,cleanup,type TestContext} from './helpers';
let ctx:TestContext,token:string,platform:typeof import('../src/platform/platform'),monitor:typeof import('../src/platform/owner-alert-monitor'),queue:typeof import('../src/platform/owner-alert-outbox');
const now=Date.now(),table='platform_owner_outbox';
function seed(id:string,state='accepted',patch:Record<string,unknown>={},business=false){
 const t=business?'platform_business_outbox':table;const r={id,event_key:(business?'inquiry:':'signup:')+(business?'1':id),tenant_slug:business?'':'fixture',state,attempts:0,next_attempt_at:now,created_at:now,updated_at:now,claimed_at:null,error_code:null,...patch};
 platform.platformDb().prepare(`INSERT INTO ${t}(id,event_key,tenant_slug,state,attempts,next_attempt_at,created_at,updated_at,claimed_at,error_code,recipients,subject,body,configuration_stamp) VALUES(?,?,?,?,?,?,?,?,?,?, 'PRIVATE RECIPIENT','PRIVATE SUBJECT','PRIVATE BODY','PRIVATE STAMP')`).run(...Object.values(r) as any[]);
}
const get=(query='')=>ctx.api.get('/_platform/api/mail/delivery'+query).set('Authorization','Bearer '+token);
beforeAll(async()=>{
 process.env.PLATFORM_CONSOLE='true';ctx=await setupApp();platform=await import('../src/platform/platform');monitor=await import('../src/platform/owner-alert-monitor');queue=await import('../src/platform/owner-alert-outbox');
 (await import('../src/platform/platform-users')).upsertPlatformUser('monitor-operator','Synthetic monitor operator password');
 token=(await ctx.api.post('/_platform/api/login').send({username:'monitor-operator',password:'Synthetic monitor operator password'})).body.token;
});
beforeEach(()=>platform.platformDb().exec('DELETE FROM platform_owner_outbox;DELETE FROM platform_business_outbox;DELETE FROM platform_owner_alert_worker'));
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
afterAll(()=>{delete process.env.PLATFORM_CONSOLE;cleanup(ctx);});
it('counts all records across both tables even when old attention is outside recent 30',()=>{
 for(let i=0;i<65;i++)seed('recent-'+i,'accepted',{created_at:now-i});seed('old-unknown','unknown',{created_at:now-86400000});seed('old-blocked','blocked',{created_at:now-86400000},true);
 expect(queue.ownerAlertStatus()).toHaveLength(30);expect(queue.ownerAlertStatus().some(r=>r.id==='old-unknown')).toBe(false);
 const health=monitor.ownerAlertHealth();expect(health).toMatchObject({total:67,attention:2,counts:{accepted:65,unknown:1,blocked:1},worker:{state:'unobserved'},status:'attention'});
 const history=monitor.ownerAlertHistory({filter:'attention'});expect(history.rows.map(r=>r.id).sort()).toEqual(['old-blocked','old-unknown']);
});
it('reports empty unobserved rather than claiming the worker is healthy',()=>{expect(monitor.ownerAlertHealth()).toMatchObject({total:0,attention:0,status:'unobserved',worker:{state:'unobserved'}});});
it('observes due/overdue/stale/expired records without changing their durable state',()=>{
 seed('overdue','pending',{next_attempt_at:now-300001});seed('future-retry','retry',{next_attempt_at:now+600000});
 seed('stale','inflight',{claimed_at:now-120001});seed('missing-claim','inflight');seed('expired','cancelled',{error_code:'event_expired'});seed('expected-cancel','cancelled',{error_code:'configuration_changed'});
 const d=platform.platformDb(),before=d.prepare('SELECT * FROM platform_owner_outbox ORDER BY id').all();
 expect(monitor.ownerAlertHealth()).toMatchObject({total:6,due:1,attention:4,counts:{pending:1,retry:1,inflight:2,cancelled:2}});
 expect(monitor.ownerAlertHistory({filter:'queued'}).rows).toHaveLength(4);
 expect(d.prepare('SELECT * FROM platform_owner_outbox ORDER BY id').all()).toEqual(before);
});
it('flags stuck retry budget and future-created work for review',()=>{seed('budget','retry',{attempts:5,next_attempt_at:now+600000});seed('future','pending',{created_at:now+120000});expect(monitor.ownerAlertHealth().attention).toBe(2);});
it('keyset history handles equal timestamps and IDs in different queues without loss or duplicates',()=>{
 for(let i=0;i<45;i++){seed('row-'+String(i).padStart(2,'0'));seed('row-'+String(i).padStart(2,'0'),'accepted',{event_key:'inquiry:'+(i+1)},true);}
 let cursor:string|undefined;const seen:string[]=[];
 do{const page=monitor.ownerAlertHistory({limit:7,...(cursor?{cursor}:{})});seen.push(...page.rows.map(r=>r.queue+':'+r.id));cursor=page.next_cursor??undefined;}while(cursor);
 expect(seen).toHaveLength(90);expect(new Set(seen).size).toBe(90);
});
it('paginates future-dated records without producing an unusable cursor',()=>{seed('future','accepted',{created_at:now+86400000});seed('past');const first=monitor.ownerAlertHistory({limit:1});expect(first.rows[0]!.id).toBe('future');expect(monitor.ownerAlertHistory({limit:1,cursor:first.next_cursor}).rows[0]!.id).toBe('past');});
it('rejects cursor reuse under another filter',()=>{seed('one','unknown');seed('two','unknown');const page=monitor.ownerAlertHistory({filter:'attention',limit:1});expect(()=>monitor.ownerAlertHistory({filter:'all',cursor:page.next_cursor})).toThrow('Invalid delivery cursor');});
it.each([0,51,'1.5','-1','0x20','',[],{}])('rejects malformed/unbounded limit %j',async limit=>{expect(()=>monitor.ownerAlertHistory({limit})).toThrow('Delivery limit');});
it.each(['bad','===','a'.repeat(1025),Buffer.from('{}').toString('base64url'),null,[]])('rejects malformed cursor %j',cursor=>{expect(()=>monitor.ownerAlertHistory({cursor})).toThrow('Invalid delivery cursor');});
it('enforces console auth, no-store and explicit payload redaction',async()=>{
 seed('private','unknown');expect((await ctx.api.get('/_platform/api/mail/delivery')).status).toBe(401);
 const response=await get('?filter=attention');expect(response.status).toBe(200);expect(response.headers['cache-control']).toBe('no-store');
 const body=JSON.stringify(response.body);for(const secret of ['PRIVATE','recipients','subject','body','configuration_stamp','event_key','run_id'])expect(body).not.toContain(secret);
 expect(response.body.rows[0]).toMatchObject({id:'private',kind:'signup',state:'unknown'});
});
it.each(['?filter=bad','?filter[x]=bad','?limit=51','?cursor=bad','?limit=1&limit=2'])('returns authored 400 for invalid query %s',async query=>{expect((await get(query)).status).toBe(400);});
it('records idle pass, persists it across catalog reopen and detects a stale heartbeat',async()=>{
 expect(await monitor.runOwnerAlertPass()).toBe(false);expect(monitor.ownerAlertHealth()).toMatchObject({status:'clear',worker:{state:'idle'}});
 platform._resetPlatformDb();expect(monitor.ownerAlertHealth().worker.state).toBe('idle');platform.platformDb().exec('UPDATE platform_owner_alert_worker SET started_at=0,finished_at=0,last_success_at=0');expect(monitor.ownerAlertHealth().worker.state).toBe('stale');
});
it('records worker failures without storing or returning diagnostic secrets',async()=>{
 vi.spyOn(queue,'processOneOwnerAlert').mockRejectedValue(new Error('PRIVATE WORKER DIAGNOSTIC'));
 await expect(monitor.runOwnerAlertPass()).rejects.toThrow('PRIVATE WORKER');const h=monitor.ownerAlertHealth();expect(h).toMatchObject({status:'attention',worker:{state:'failed',last_success_at:null}});expect(JSON.stringify(h)).not.toContain('PRIVATE');
});
it('a previous failed pass is superseded by a successful idle pass',async()=>{const spy=vi.spyOn(queue,'processOneOwnerAlert').mockRejectedValueOnce(new Error('Synthetic'));await expect(monitor.runOwnerAlertPass()).rejects.toThrow();spy.mockRestore();await monitor.runOwnerAlertPass();expect(monitor.ownerAlertHealth().worker.state).toBe('idle');});
it('does not let an older pass overwrite a newer heartbeat',async()=>{
 let done!:(value:boolean)=>void;const gate=new Promise<boolean>(resolve=>{done=resolve;});vi.spyOn(queue,'processOneOwnerAlert').mockReturnValueOnce(gate).mockResolvedValueOnce(false);
 const first=monitor.runOwnerAlertPass();await monitor.runOwnerAlertPass();const before=platform.platformDb().prepare('SELECT * FROM platform_owner_alert_worker').get();done(true);await first;expect(platform.platformDb().prepare('SELECT * FROM platform_owner_alert_worker').get()).toEqual(before);
});
it('rejects heartbeat-start failure before attempting a send',async()=>{
 const spy=vi.spyOn(queue,'processOneOwnerAlert');const d=platform.platformDb();d.exec("CREATE TRIGGER heartbeat_fail BEFORE INSERT ON platform_owner_alert_worker BEGIN SELECT RAISE(ABORT,'Synthetic heartbeat failure'); END");
 try{await expect(monitor.runOwnerAlertPass()).rejects.toThrow('heartbeat failure');expect(spy).not.toHaveBeenCalled();}finally{d.exec('DROP TRIGGER heartbeat_fail');}
});
it('does not rewrite completed jobs if heartbeat-finish persistence fails',async()=>{
 seed('completed','accepted');const d=platform.platformDb();d.exec("CREATE TRIGGER heartbeat_end_fail BEFORE UPDATE ON platform_owner_alert_worker WHEN NEW.finished_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'Synthetic heartbeat end failure'); END");
 try{await expect(monitor.runOwnerAlertPass()).rejects.toThrow('heartbeat end failure');expect(d.prepare('SELECT state FROM platform_owner_outbox').get()!.state).toBe('accepted');expect(monitor.ownerAlertHealth().worker.state).toBe('running');}finally{d.exec('DROP TRIGGER heartbeat_end_fail');}
});
it('marks disabled, future-clock and malformed observations explicitly',async()=>{
 await monitor.runOwnerAlertPass();vi.stubEnv('DEPLOY_MODE','node');expect(monitor.ownerAlertHealth().worker.state).toBe('disabled');vi.unstubAllEnvs();
 platform.platformDb().prepare('UPDATE platform_owner_alert_worker SET started_at=?,finished_at=NULL,outcome=NULL').run(Date.now()+120000);expect(monitor.ownerAlertHealth().worker.state).toBe('clock_invalid');
 platform.platformDb().exec('UPDATE platform_owner_alert_worker SET started_at=0,finished_at=1,outcome=NULL');expect(monitor.ownerAlertHealth().worker.state).toBe('invalid');
});
it('redacts unexpected monitor failures through both read routes',async()=>{
 const d=platform.platformDb(),original=d.prepare.bind(d);vi.spyOn(d,'prepare').mockImplementation((sql:string)=>{if(sql.includes('WITH events')||sql.includes("SELECT queue,id,event_key"))throw Object.assign(new Error('PRIVATE DATABASE DETAIL'),{status:422,expose:true});return original(sql);});
 for(const url of ['/mail/delivery','/mail']){const r=await ctx.api.get('/_platform/api'+url).set('Authorization','Bearer '+token);expect(r.status).toBe(500);expect(r.body).toEqual({error:'Internal server error',request_id:r.headers['x-request-id']});}
});

it('preserves this-pass acceptance when heartbeat completion fails and never sends it twice',async()=>{
 const mail=await import('../src/platform/platform-mail');
 (await import('../src/platform/provisioning')).createTenant({slug:'monitor-accepted',name:'Synthetic monitor',admin_username:'owner',admin_password:'Synthetic monitor tenant password',is_sandbox:true});
 mail.savePlatformMail({transport:'brevo',from_email:'alerts@example.test',alert_to:'owner@example.test',alert_signup:true},'synthetic-monitor-secret');
 mail._testOutbox.length=0; queue.enqueueSignupAlert('monitor-accepted','Synthetic monitor alert',['Synthetic']);
 const d=platform.platformDb();d.exec("CREATE TRIGGER heartbeat_accepted_fail BEFORE UPDATE ON platform_owner_alert_worker WHEN NEW.finished_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'Synthetic finish failure'); END");
 try{await expect(monitor.runOwnerAlertPass()).rejects.toThrow('Synthetic finish failure');expect(d.prepare('SELECT state FROM platform_owner_outbox').get()!.state).toBe('accepted');expect(mail._testOutbox).toHaveLength(1);}
 finally{d.exec('DROP TRIGGER heartbeat_accepted_fail');}
 expect(await monitor.runOwnerAlertPass()).toBe(false);expect(mail._testOutbox).toHaveLength(1);expect(monitor.ownerAlertHealth().worker.state).toBe('idle');
});
