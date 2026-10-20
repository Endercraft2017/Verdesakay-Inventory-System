import {beforeAll, afterAll, afterEach, it, expect} from 'vitest';
import {setupApp, cleanup, login, createEmployee, type TestContext} from './helpers';
let ctx: TestContext, token: string, accountant:string, clerk:string, db: typeof import('../src/shared/db'), form: number, employee: number, seq=0;
const hdr=()=>({Authorization:`Bearer ${token}`});
beforeAll(async()=>{
 ctx=await setupApp(); token=await login(ctx.api); db=await import('../src/shared/db');
 accountant=(await createEmployee(ctx.api,token,{role:'accounting'})).token;
 clerk=(await createEmployee(ctx.api,token,{role:'csr'})).token;
 employee=Number(db.run("INSERT INTO employees(employee_no,name,daily_rate) VALUES('RECON-EMP','Synthetic Reconciliation',600)").lastInsertRowid);
 form=db.queryOne<{id:number}>("SELECT id FROM form_definitions WHERE slug='hr_payroll'")!.id;
 expect((await ctx.api.post('/api/accounting/ledger/setup').set(hdr()).send({fiscal_year_start:'2026-01-01'})).status).toBe(201);
});
afterAll(()=>cleanup(ctx));
afterEach(()=>{
 db.run('DELETE FROM form_records WHERE form_def_id=?',form);
 db.run("DELETE FROM attendance_periods WHERE label LIKE 'RECON-%'");
});
function cutoff(){const label='RECON-'+(++seq);const id=Number(db.run("INSERT INTO attendance_periods(label,start_date,end_date) VALUES(?,'2026-07-01','2026-07-15')",label).lastInsertRowid);db.run("INSERT INTO attendance_records(period_id,employee_id,work_date) VALUES(?,?,'2026-07-01')",id,employee);return {id,label};}
function slip(p:{id:number;label:string}, extra:Record<string,unknown>={}, status='draft'){
 return Number(db.run('INSERT INTO form_records(form_def_id,number,data,status,period,created_by) VALUES(?,?,?,?,?,1)',form,'RECON-SLIP-'+(++seq),JSON.stringify({employee_id:employee,employee_name:'Synthetic Reconciliation',cutoff_id:p.id,payroll_period:p.label,pay_date:'2026-07-15',basic_salary:1000,total_earnings:1000,net_pay:1000,...extra}),status,p.label).lastInsertRowid);
}
const post=(p:{id:number;label:string})=>ctx.api.post(`/api/hr/periods/${p.id}/post-payroll-gl`).set(hdr()).send({payroll_period:p.label});
const rows=(p:{id:number})=>db.queryAll('SELECT * FROM journal_entries WHERE source_type=\'payroll_run\' AND source_id=? ORDER BY id',p.id);
it('refuses duplicate employee/cutoff payroll before regeneration changes anything',async()=>{
 const p=cutoff(); slip(p);slip(p,{},'paid'); const before=db.queryAll('SELECT * FROM form_records WHERE period=?',p.label);
 const r=await ctx.api.post(`/api/hr/periods/${p.id}/generate-payslips`).set(hdr()).send({payroll_period:p.label});
 expect(r.status).toBe(409);expect(db.queryAll('SELECT * FROM form_records WHERE period=?',p.label)).toEqual(before);
 expect((await post(p)).status).toBe(409);expect(rows(p)).toHaveLength(0);
});
it('preserves the prior journal when replacement fails balance validation',async()=>{
 const p=cutoff(); const id=slip(p);expect((await post(p)).status).toBe(201);const before=rows(p);
 const d=JSON.parse(db.queryOne<{data:string}>('SELECT data FROM form_records WHERE id=?',id)!.data);db.run('UPDATE form_records SET data=? WHERE id=?',JSON.stringify({...d,net_pay:999}),id);
 expect((await post(p)).status).toBe(400);expect(rows(p)).toEqual(before);
});
it('rolls reversal and replacement back together on a replacement database failure',async()=>{
 const p=cutoff();slip(p);expect((await post(p)).status).toBe(201);const before=rows(p);
 db.run(`CREATE TRIGGER recon_fail_replace BEFORE INSERT ON journal_entries WHEN NEW.source_type='payroll_run' AND NEW.source_id=${p.id} AND NEW.reverses_id IS NULL BEGIN SELECT RAISE(ABORT,'private synthetic write failure'); END`);
 try{const r=await post(p);expect(r.status).toBe(400);expect(r.text).not.toContain('private synthetic write failure');expect(rows(p)).toEqual(before);}finally{db.run('DROP TRIGGER recon_fail_replace');}
});
it('refuses posting a different cutoff by supplying its label',async()=>{
 const a=cutoff(),b=cutoff();slip(b);const r=await ctx.api.post(`/api/hr/periods/${a.id}/post-payroll-gl`).set(hdr()).send({payroll_period:b.label});
 expect(r.status).toBe(409);expect(rows(a)).toHaveLength(0);expect(rows(b)).toHaveLength(0);
});
it('does not create a second live journal when the original period is closed',async()=>{
 const p=cutoff();slip(p);expect((await post(p)).status).toBe(201);const before=rows(p);
 db.run("INSERT INTO accounting_periods(name,start_date,end_date,status) VALUES('RECON CLOSED','2026-07-01','2026-07-31','closed')");
 try{expect((await post(p)).status).toBe(400);expect(rows(p)).toEqual(before);}finally{db.run("DELETE FROM accounting_periods WHERE name='RECON CLOSED'");}
});
it('shows read-only reconciliation and treats paid marks separately from bank confirmation',async()=>{
 const p=cutoff();slip(p);const r=await ctx.api.get(`/api/hr/periods/${p.id}/payroll-reconciliation`).set(hdr());
 expect(r.status).toBe(200);expect(r.headers['cache-control']).toContain('no-store');expect(r.body.source).toMatchObject({record_count:1,draft_count:1,paid_count:0,net_pay_total:1000});expect(r.body.payment_verification).toBe('not_linked');
 expect(r.body.ledger.state).toBe('missing');expect((await post(p)).status).toBe(201);
 const after=await ctx.api.get(`/api/hr/periods/${p.id}/payroll-reconciliation`).set(hdr());expect(after.body.ledger.state).toBe('matches');
});
it('blocks duplicate sources in tax/agency reports even when their pay dates cross years',async()=>{
 const p=cutoff();slip(p,{pay_date:'2030-07-15'});slip(p,{cutoff_id:String(p.id),pay_date:'2031-07-15'});
 for(const path of ['/api/accounting/bir-2316?year=2030','/api/accounting/bir-1601c?year=2031','/api/accounting/bir-alphalist?year=2030','/api/accounting/contribution-schedule?month=2026-07&format=csv','/api/hr/thirteenth-month?year=2031'])expect((await ctx.api.get(path).set(hdr())).status).toBe(409);
});
it('recognizes uniquely recorded custom aliases and refuses a stamped/legacy duplicate pair',async()=>{
 const p=cutoff();const a=slip(p),b=slip(p,{cutoff_id:null});
 db.run("UPDATE form_records SET period='RECON CUSTOM ALIAS' WHERE id IN (?,?)",a,b);
 const r=await ctx.api.get(`/api/hr/periods/${p.id}/payroll-reconciliation`).set(hdr());
 expect(r.body.issues).toContain('duplicate_employee_cutoff');expect((await post(p)).status).toBe(409);
});
it('keeps valid stamped cutoffs separate even when they share a custom display label',async()=>{
 const a=cutoff(),b=cutoff(),one=slip(a),two=slip(b);
 db.run("UPDATE form_records SET period='RECON SHARED DISPLAY' WHERE id IN (?,?)",one,two);
 for(const p of [a,b]){
  const r=await ctx.api.post(`/api/hr/periods/${p.id}/post-payroll-gl`).set(hdr()).send({payroll_period:'RECON SHARED DISPLAY'});
  expect(r.status).toBe(201);
  const comparison=await ctx.api.get(`/api/hr/periods/${p.id}/payroll-reconciliation`).set(hdr());expect(comparison.body.source.record_count).toBe(1);expect(comparison.body.source.net_pay_total).toBe(1000);
 }
});
it('blocks earlier duplicate payroll instead of silently using the newest statutory amounts',async()=>{
 const p=cutoff();slip(p);slip(p);
 const later=cutoff();db.run("UPDATE attendance_periods SET start_date='2026-07-16',end_date='2026-07-31' WHERE id=?",later.id);
 expect((await ctx.api.post(`/api/hr/periods/${later.id}/generate-payslips`).set(hdr()).send({payroll_period:later.label})).status).toBe(409);
 expect(db.queryAll('SELECT * FROM form_records WHERE period=?',later.label)).toHaveLength(0);
 db.run('DELETE FROM form_records WHERE form_def_id=?',form);
 slip({id:p.id,label:'RECON LEGACY UNLINKED'},{cutoff_id:null,pay_date:'2026-07-05'});
 const legacy=await ctx.api.post(`/api/hr/periods/${later.id}/generate-payslips`).set(hdr()).send({payroll_period:later.label});
 expect(legacy.status).toBe(409);expect(legacy.body.error).toContain('unlinked monthly payroll');
});
it('preserves the old journal when the original date is closed but the replacement date is open',async()=>{
 const p=cutoff(),id=slip(p);expect((await post(p)).status).toBe(201);const before=rows(p);
 const d=JSON.parse(db.queryOne<{data:string}>('SELECT data FROM form_records WHERE id=?',id)!.data);db.run('UPDATE form_records SET data=? WHERE id=?',JSON.stringify({...d,pay_date:'2026-08-15'}),id);
 db.run("INSERT INTO accounting_periods(name,start_date,end_date,status) VALUES('RECON OLD CLOSED','2026-07-01','2026-07-31','closed')");
 try{expect((await post(p)).status).toBe(400);expect(rows(p)).toEqual(before);}finally{db.run("DELETE FROM accounting_periods WHERE name='RECON OLD CLOSED'");}
});
it('refuses a closed reversal date and rolls back reversal write failures',async()=>{
 const p=cutoff();slip(p);expect((await post(p)).status).toBe(201);const before=rows(p);
 const today=(await import('../src/shared/sync-context')).now().toISOString().slice(0,10);
 db.run("INSERT INTO accounting_periods(name,start_date,end_date,status) VALUES('RECON TODAY CLOSED',?,?,'closed')",today,today);
 try{expect((await post(p)).status).toBe(400);expect(rows(p)).toEqual(before);}finally{db.run("DELETE FROM accounting_periods WHERE name='RECON TODAY CLOSED'");}
 db.run(`CREATE TRIGGER recon_fail_reverse BEFORE INSERT ON journal_entries WHEN NEW.source_id=${p.id} AND NEW.reverses_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'private reversal failure'); END`);
 try{const r=await post(p);expect(r.status).toBe(400);expect(r.text).not.toContain('private reversal failure');expect(rows(p)).toEqual(before);}finally{db.run('DROP TRIGGER recon_fail_reverse');}
});
it('rolls back partially written replacement lines and sequence allocation',async()=>{
 const p=cutoff();slip(p);expect((await post(p)).status).toBe(201);const before=rows(p);
 const lines=db.queryAll('SELECT * FROM journal_lines WHERE entry_id IN(SELECT id FROM journal_entries WHERE source_type=\'payroll_run\' AND source_id=?) ORDER BY id',p.id);
 const counters=db.queryAll("SELECT * FROM settings WHERE key LIKE '%je_number%'");
 db.run(`CREATE TRIGGER recon_fail_line BEFORE INSERT ON journal_lines WHEN NEW.sort=1 AND EXISTS(SELECT 1 FROM journal_entries e WHERE e.id=NEW.entry_id AND e.source_type='payroll_run' AND e.source_id=${p.id} AND e.reverses_id IS NULL) BEGIN SELECT RAISE(ABORT,'private line failure'); END`);
 try{expect((await post(p)).status).toBe(400);expect(rows(p)).toEqual(before);expect(db.queryAll('SELECT * FROM journal_lines WHERE entry_id IN(SELECT id FROM journal_entries WHERE source_type=\'payroll_run\' AND source_id=?) ORDER BY id',p.id)).toEqual(lines);expect(db.queryAll("SELECT * FROM settings WHERE key LIKE '%je_number%'")).toEqual(counters);}finally{db.run('DROP TRIGGER recon_fail_line');}
});
it('never treats a reversal as the next live original journal',async()=>{
 const p=cutoff();slip(p);expect((await post(p)).status).toBe(201);
 const {unpostSource,postedEntryForSource}=await import('../src/modules/accounting/accounting-autopost');
 expect(unpostSource('payroll_run',p.id,1).entry).toBeTruthy();expect(postedEntryForSource('payroll_run',p.id)).toBeUndefined();
 const before=rows(p);expect(unpostSource('payroll_run',p.id,1).skipped).toBe('already_posted');expect(rows(p)).toEqual(before);
 expect((await post(p)).status).toBe(201);expect(rows(p)).toHaveLength(3);
});
it('detects account/date differences even when the journal still balances',async()=>{
 const p=cutoff();slip(p);expect((await post(p)).status).toBe(201);
 const entry=(rows(p)[0] as any).id;
 db.run("UPDATE journal_entries SET entry_date='2026-07-16' WHERE id=?",entry);
 expect((await ctx.api.get(`/api/hr/periods/${p.id}/payroll-reconciliation`).set(hdr())).body.ledger.state).toBe('differs');
 db.run("UPDATE journal_entries SET entry_date='2026-07-15' WHERE id=?",entry);
 const other=db.queryOne<{id:number}>('SELECT id FROM accounts WHERE id NOT IN(SELECT account_id FROM journal_lines WHERE entry_id=?) LIMIT 1',entry)!.id;
 db.run('UPDATE journal_lines SET account_id=? WHERE entry_id=? AND debit>0',other,entry);
 const r=await ctx.api.get(`/api/hr/periods/${p.id}/payroll-reconciliation`).set(hdr());expect(r.body.ledger.state).toBe('differs');expect(r.body.ledger.actual_debit).toBe(r.body.ledger.actual_credit);
});
it('holds multiple live original journals without choosing one to reverse',async()=>{
 const p=cutoff();slip(p);expect((await post(p)).status).toBe(201);
 db.run("INSERT INTO journal_entries(number,book,entry_date,status,source_type,source_id) VALUES('RECON-DUP-JE','payroll','2026-07-15','posted','payroll_run',?)",p.id);
 const before=rows(p);expect((await post(p)).status).toBe(409);expect(rows(p)).toEqual(before);
 const r=await ctx.api.get(`/api/hr/periods/${p.id}/payroll-reconciliation`).set(hdr());expect(r.body.ledger.state).toBe('multiple_live_journals');expect(r.body.ledger.can_post).toBe(false);
});
it('reports invalid amounts and dates without altering the prior journal or inventing zero totals',async()=>{
 const p=cutoff(),id=slip(p);expect((await post(p)).status).toBe(201);const before=rows(p);
 const d=JSON.parse(db.queryOne<{data:string}>('SELECT data FROM form_records WHERE id=?',id)!.data);
 for(const extra of [{net_pay:'Infinity'},{net_pay:{}},{pay_date:'2026-02-30'},{cutoff_id:'01'}]){
  db.run('UPDATE form_records SET data=? WHERE id=?',JSON.stringify({...d,...extra}),id);
  expect((await post(p)).status).toBe(409);expect(rows(p)).toEqual(before);
  const r=await ctx.api.get(`/api/hr/periods/${p.id}/payroll-reconciliation`).set(hdr());expect(r.body.source.net_pay_total).toBeNull();expect(r.body.ledger.state).toBe('blocked');
 }
});
it('refuses to replace an invalid prior journal and shows unavailable comparison totals',async()=>{
 const p=cutoff();slip(p);expect((await post(p)).status).toBe(201);
 db.run('UPDATE journal_lines SET debit=debit+1 WHERE debit>0 AND entry_id IN(SELECT id FROM journal_entries WHERE source_type=\'payroll_run\' AND source_id=?)',p.id);
 const before=rows(p);expect((await post(p)).status).toBe(409);expect(rows(p)).toEqual(before);
 const r=await ctx.api.get(`/api/hr/periods/${p.id}/payroll-reconciliation`).set(hdr());expect(r.body.ledger.state).toBe('invalid_journal');expect(r.body.ledger.actual_debit).toBeNull();expect(r.body.ledger.can_post).toBe(false);
});
it('keeps reconciliation permission boundaries and projections without changing source or ledger data',async()=>{
 const p=cutoff();slip(p);const before=db.queryAll('SELECT * FROM form_records WHERE form_def_id=?',form),journal=rows(p);
 const url=`/api/accounting/payroll-reconciliation/${p.id}`;
 expect((await ctx.api.get(url)).status).toBe(401);expect((await ctx.api.get(url).set('Authorization',`Bearer ${clerk}`)).status).toBe(403);
 expect((await ctx.api.get(`/api/hr/periods/${p.id}/payroll-reconciliation`).set('Authorization',`Bearer ${accountant}`)).status).toBe(403);
 const r=await ctx.api.get(url).set('Authorization',`Bearer ${accountant}`);expect(r.status).toBe(200);expect(r.headers['cache-control']).toContain('no-store');
 expect(Object.keys(r.body).sort()).toEqual(['cutoff','issues','record_ids','issue_record_count','source','ledger','payment_verification','note'].sort());expect(r.text).not.toContain('Synthetic Reconciliation');expect(r.body).not.toHaveProperty('employee');expect(r.body).not.toHaveProperty('data');
 expect(db.queryAll('SELECT * FROM form_records WHERE form_def_id=?',form)).toEqual(before);expect(rows(p)).toEqual(journal);
 expect((await ctx.api.get('/api/hr/periods/999999/payroll-reconciliation').set(hdr())).status).toBe(404);
});
it('holds mixed dates and unsupported statuses, and distinguishes an empty cutoff from a disabled ledger',async()=>{
 const p=cutoff();let r=await ctx.api.get(`/api/hr/periods/${p.id}/payroll-reconciliation`).set(hdr());expect(r.body.ledger.state).toBe('empty');
 slip(p);const other=Number(db.run('INSERT INTO employees(employee_no,name) VALUES(?,?)','RECON-MIX-'+(++seq),'Another Synthetic Employee').lastInsertRowid);
 const second=slip(p,{employee_id:other,pay_date:'2026-07-16'});
 expect((await post(p)).status).toBe(409);r=await ctx.api.get(`/api/hr/periods/${p.id}/payroll-reconciliation`).set(hdr());expect(r.body.issues).toContain('mixed_pay_dates');expect(r.body.source.net_pay_total).toBeNull();
 db.run("UPDATE form_records SET status='cancelled' WHERE id=?",second);expect((await post(p)).status).toBe(409);
 const setting=db.getSetting('accounting_ledger');db.setSetting('accounting_ledger',{enabled:false});
 try{expect((await post(p)).status).toBe(400);}finally{db.setSetting('accounting_ledger',setting);}
});
it('rolls back a rate change if a targeted cutoff has duplicate payroll',async()=>{
 const p=cutoff();slip(p);slip(p);
 const before=db.queryOne('SELECT * FROM employees WHERE id=?',employee),history=db.queryAll('SELECT * FROM employee_rate_history WHERE employee_id=?',employee);
 const r=await ctx.api.post(`/api/hr/employees/${employee}/rate-change`).set(hdr()).send({rate_type:'daily',daily_rate:700,effective_date:'2026-07-01'});
 expect(r.status).toBe(409);expect(db.queryOne('SELECT * FROM employees WHERE id=?',employee)).toEqual(before);expect(db.queryAll('SELECT * FROM employee_rate_history WHERE employee_id=?',employee)).toEqual(history);
});
it('keeps numeric, text and invalid cutoff stamps immutable through the ordinary editor',async()=>{
 const p=cutoff(),other=cutoff();
 for(const stamp of [p.id,String(p.id),'01']){
  const id=slip(p,{cutoff_id:stamp});
  const r=await ctx.api.put(`/api/form-records/${id}`).set(hdr()).send({data:{employee_name:'Synthetic Reconciliation',cutoff_id:other.id,payroll_period:p.label,basic_salary:1000,total_earnings:1000,net_pay:1000}});
  expect(r.status).toBe(200);expect(JSON.parse(db.queryOne<{data:string}>('SELECT data FROM form_records WHERE id=?',id)!.data).cutoff_id).toBe(stamp);
 }
});
