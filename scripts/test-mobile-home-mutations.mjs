import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';
const root='work/home-preview-verification/mutations';fs.mkdirSync(root,{recursive:true});
const challenges=[['ambiguous-count','Database, API and visible IDs agree'],['hide-blocked','Blocked inspection is labelled'],['couple-queues','A slow QC queue'],['hide-on-summary-failure','Employee-summary failure'],['late-rts-paint','Late RTS read failure']];
const summary=[];
for(const [mutation,target]of challenges){
 const out=path.join(root,mutation);const result=spawnSync(process.execPath,['scripts/test-mobile-home-audit.mjs'],{env:{...process.env,HOME_AUDIT_OUTPUT:out,HOME_AUDIT_MUTATION:mutation,HOME_AUDIT_ONLY:target},encoding:'utf8',timeout:90000});
 fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'run.log'),(result.stdout||'')+(result.stderr||''));
 let report;try{report=JSON.parse(fs.readFileSync(path.join(out,'report.json'),'utf8'));}catch{}
 const caught=result.status===1&&!report?.fatal&&report?.mutationApplied?.length>0&&report.failures.length===1&&report.failures[0].name.includes(target)&&report.errors.length===0;
 summary.push({mutation,target,caught,exitStatus:result.status,fatal:report?.fatal,applied:report?.mutationApplied,failures:report?.failures,artifacts:report?.cases?.flatMap(c=>c.artifacts)});
 console.log((caught?'CAUGHT ':'UNEXPECTED ')+mutation);if(!caught){console.error(result.stdout,result.stderr);process.exitCode=1;}
}
fs.writeFileSync(path.join(root,'summary.json'),JSON.stringify(summary,null,2));
