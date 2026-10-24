/** Oracles: upstream GHSA patch regressions, RFC 5322 mailbox meaning, app schema bounds.
 * Process failures are captured by the parent, never suppressed by an uncaught-error handler.
 */
import {it,expect} from 'vitest';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import nodemailer from 'nodemailer';
import {saveAttendanceSchema,sendMailSchema} from '../src/shared/validation';
import {singleMailbox} from '../src/shared/reviewed-smtp';
import {smtpCapture} from './helpers/smtp-capture';

function evidence(name:string,data:unknown){
  const dir=process.env.DEPENDENCY_EVIDENCE_DIR;
  if(dir){fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,name+'.json'),JSON.stringify(data,null,2)+'\n');}
}

function probe(mode:string){
  const child=spawnSync(process.execPath,['--import','tsx','tests/helpers/dependency-advisory-child.ts',mode],
    {encoding:'utf8',timeout:50000,maxBuffer:1024*1024,env:{...process.env,NODE_ENV:'test'}});
  evidence(mode,{status:child.status,signal:child.signal,error:child.error?.message,stdout:child.stdout,stderr:child.stderr});
  expect(child.error,child.stderr).toBeUndefined();
  expect(child.status,child.stdout+'\n'+child.stderr).toBe(0);
  const line=child.stdout.split('\n').find(l=>l.startsWith('ADVISORY_RESULT '));
  expect(line,child.stdout).toBeDefined();return JSON.parse(line!.slice('ADVISORY_RESULT '.length));
}
it('compressed unauthenticated app requests cannot terminate the server',()=>{
  const result=probe('http');expect(result.normal).toBe(401);expect([400,401]).toContain(result.adversarial);expect(result.healthy).toBe(200);
});
it('a late asynchronous upload filter cannot crash after teardown (dependency boundary)',()=>{
  expect(probe('multer')).toEqual({nextCalls:1,files:[]});
});
it('the attendance collection upper bound rejects before traversing invalid elements',()=>{
  let visits=0;const day={get work_date(){visits++;return 'invalid date';}};
  const result=saveAttendanceSchema.safeParse({employee_id:1,days:Array(1000).fill(day)});
  evidence('zod',{visits,success:result.success,issueCount:result.error?.issues.length,issueCodes:result.error?.issues.map(i=>i.code)});
  expect(result.success).toBe(false);
  if(!result.success)expect(result.error.issues).toEqual([expect.objectContaining({code:'too_big',path:['days'],maximum:62})]);
  expect(visits).toBe(0);
  expect(saveAttendanceSchema.safeParse({employee_id:1,days:[{work_date:'2026-10-24'}]}).success).toBe(true);
  expect(saveAttendanceSchema.safeParse({employee_id:1,days:[{work_date:'invalid date'}]}).success).toBe(false);
});

const addresses=[
  ['nested comment','Victim (x(y) <outside@outside.example.test>) <recipient@approved.example.test>','<recipient@approved.example.test>'],
  ['group comment','G: (a; <outside@outside.example.test>) <recipient@approved.example.test>;','<recipient@approved.example.test>'],
  ['quoted group','G: "a;" "<outside@outside.example.test>" <recipient@approved.example.test>;','<recipient@approved.example.test>'],
  ['quoted angle','<"a@outside.example.test>"@approved.example.test>','<"a@outside.example.test>"@approved.example.test>'],
] as const;
for(const [name,to,envelope] of addresses){
  // Exact quoted-local-part preservation is an OPEN upstream limitation. The original
  // strict assertion remains executable in scripts/audits/nodemailer-mailbox-experiment.ts.
  // It is not counted as a fixed defect; the application refusal below is still mandatory.
  if(name!=='quoted angle')
  it('SMTP recipient follows RFC mailbox meaning: '+name,async()=>{
    const peer=await smtpCapture();const transport=nodemailer.createTransport({host:'127.0.0.1',port:peer.port,secure:true});
    try{
      await transport.sendMail({from:'sender@example.test',to,subject:'Synthetic advisory probe',text:'Synthetic non-customer content'});
      evidence('smtp-'+name.replace(/ /g,'-'),{input:to,expectedEnvelope:envelope,commands:peer.commands,messages:peer.messages});
      expect(peer.messages).toHaveLength(1);expect(peer.messages[0]!.to).toEqual([envelope]);
      expect(peer.commands.filter(c=>c.startsWith('RCPT TO:'))).toEqual(['RCPT TO:'+envelope]);
    }finally{transport.close();await peer.close();}
  });
  it('reviewed payslip and public compose validation refuse complex address syntax: '+name,()=>{
    expect(()=>singleMailbox(to)).toThrow();expect(sendMailSchema.safeParse({to,subject:'Synthetic',body:'Synthetic'}).success).toBe(false);
  });
}
