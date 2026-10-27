import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import { setImmediate as nextTick } from 'node:timers/promises';
import { JSDOM } from 'jsdom';

const root = path.resolve(import.meta.dirname, '..');
const site = path.join(root, 'website');
const fixtureDir = path.join(root, 'tests/fixtures/website-marketing');
const reportDir = path.join(root, 'work/website-marketing');
fs.mkdirSync(reportDir,{recursive:true});
const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8');
const marketing = fs.readFileSync(path.join(site, 'marketing.js'), 'utf8');
const app = fs.readFileSync(path.join(site, 'app.js'), 'utf8');
const results = [];
const flush = async () => { for (let i=0;i<5;i++) await nextTick(); };
async function test(name, run) {
  try { await run(); results.push({name, status:'PASS'}); }
  catch (error) { results.push({name, status:'FAIL', error:error.stack}); }
}
async function fixture(query='', responder=async () => ({status:201,body:{ok:true}})) {
  const dom = new JSDOM(html,{url:'https://otom.afkcube.com/contact'+query,runScripts:'outside-only',pretendToBeVisual:true});
  const w = dom.window, d=w.document;
  let uuid=0; const calls=[], timers=[];
  Object.defineProperty(w.crypto,'randomUUID',{value:()=> '00000000-0000-4000-8000-'+String(++uuid).padStart(12,'0')});
  w.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};
  const nativeSetTimeout=w.setTimeout.bind(w);
  w.setTimeout=(fn,ms,...args)=>{if(ms===20000){const id={fn:()=>fn(...args)};timers.push(id);return id;} return nativeSetTimeout(fn,ms,...args);};
  const nativeClearTimeout=w.clearTimeout.bind(w);
  w.clearTimeout=id=>{if(typeof id!=='object')nativeClearTimeout(id);};
  w.fetch=async (url,options={})=>{
    if(url==='/site/config')return {ok:true,json:async()=>({signups_open:false,modules:['hr','inventory','accounting','mobile','ai','email','quickbooks'],module_deps:{},contact:{},pricing:null})};
    if(url!=='/site/inquiry')throw new Error('Unexpected external or application request '+url);
    const request={url,body:options.body,key:options.headers['Idempotency-Key'],signal:options.signal};calls.push(request);
    const reply=await responder(request,calls.length);
    return {ok:reply.status>=200&&reply.status<300,status:reply.status,json:async()=>{if(reply.malformed)throw new Error('bad JSON');return reply.body;}};
  };
  w.eval(marketing);w.eval(app);await flush();
  const el=id=>d.getElementById(id);
  const change=(id,value)=>{el(id).value=value;el(id).dispatchEvent(new w.Event('change',{bubbles:true}));};
  const fields=()=>{el('c-name').value='Demo Referral';el('c-company').value='DEMO Company';el('c-email').value='demo@example.test';el('c-message').value='A fictional inquiry for local verification.';};
  const submit=async()=>{el('contact-form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await flush();};
  return {w,d,el,change,fields,submit,calls,timers,close:()=>dom.window.close()};
}
async function withFixture(query,responder,run){const f=await fixture(query,responder);try{await run(f);}finally{f.close();}}

await test('Original dialog and form IDs remain available',async()=>{await withFixture('',undefined,async f=>{for(const id of JSON.parse(fs.readFileSync(path.join(fixtureDir,'original_ids.json'))))assert.ok(f.el(id),id);});});
await test('Login MFA and signup submit implementation remains byte-identical',async()=>{const old=JSON.parse(fs.readFileSync(path.join(fixtureDir,'original-handler-hashes.json')));const sections={'login and MFA':app.slice(app.indexOf('  var loginForm ='),app.indexOf("  document.getElementById('company').addEventListener")),'signup submit':app.slice(app.indexOf("  document.getElementById('signup-form').addEventListener"),app.indexOf("  /* The owner's direct contact details"))};for(const [name,section] of Object.entries(sections))assert.equal(createHash('sha256').update(section).digest('hex'),old[name],name);});
await test('All four URL intents initialize before contact deep-link opener',async()=>{
  for(const intent of ['otom-walkthrough','custom-workflow','managed-operations','referral-partnership'])await withFixture('?intent='+intent,undefined,async f=>{assert.equal(f.el('c-intent').value,intent);assert.equal(f.w.AFKInquiry.intent(),intent);assert.equal(f.el('contact-dialog').open,true);});
});
await test('Missing and invalid intent use safe walkthrough default',async()=>{for(const q of ['', '?intent=%3Cscript%3E','?intent=unknown'])await withFixture(q,undefined,async f=>{assert.equal(f.w.AFKInquiry.intent(),'otom-walkthrough');assert.equal(f.d.querySelectorAll('script:not([src])').length,0);});});
await test('Manual intent override wins over URL and individual selection is explicit',async()=>{await withFixture('?intent=custom-workflow',undefined,async f=>{f.change('c-intent','referral-partnership');assert.equal(f.w.AFKInquiry.intent(),'referral-partnership');assert.equal(f.w.AFKInquiry.individual(),false);f.el('c-individual').checked=true;f.el('c-individual').dispatchEvent(new f.w.Event('change'));assert.equal(f.w.AFKInquiry.company(),'Individual referral partner (no company)');assert.equal(f.el('c-company').disabled,true);});});
await test('Walkthrough CTA overrides partner URL before first dispatch',async()=>{await withFixture('?intent=referral-partnership',undefined,async f=>{f.el('contact-dialog').close();f.d.querySelector('[data-open="contact"][data-intent="otom-walkthrough"]').click();assert.equal(f.w.AFKInquiry.intent(),'otom-walkthrough');assert.equal(f.el('contact-dialog').open,true);assert.match(f.el('contact-title').textContent,/OTOM walkthrough/);});});
await test('Individual partner submits schema-compatible optional fields and disclosed category',async()=>{await withFixture('?intent=referral-partnership',undefined,async f=>{f.fields();f.el('c-company').value='';f.el('c-individual').checked=true;f.el('c-individual').dispatchEvent(new f.w.Event('change'));await f.submit();assert.equal(f.calls.length,1);const b=JSON.parse(f.calls[0].body);assert.equal(b.company,'Individual referral partner (no company)');assert.equal(b.employees,'');assert.deepEqual(b.modules,[]);assert.match(b.message,/referral-partnership/);assert.match(b.message,/individual/);assert.deepEqual(Object.keys(b).sort(),['name','company','email','phone','employees','modules','message','website'].sort());});});
await test('Organisation partner uses actual company and buyer return restores required field',async()=>{await withFixture('?intent=referral-partnership',undefined,async f=>{f.fields();f.el('c-individual').checked=true;f.el('c-individual').dispatchEvent(new f.w.Event('change'));f.change('c-intent','otom-walkthrough');assert.equal(f.el('c-company').required,true);assert.equal(f.el('c-company').disabled,false);assert.equal(f.el('c-company').value,'DEMO Company');f.change('c-intent','referral-partnership');f.el('c-individual').checked=false;f.el('c-individual').dispatchEvent(new f.w.Event('change'));await f.submit();assert.equal(JSON.parse(f.calls[0].body).company,'DEMO Company');});});
await test('Partner question state survives async module config population',async()=>{await withFixture('?intent=referral-partnership',undefined,async f=>{assert.equal(f.el('c-modules-fieldset').disabled,true);assert.equal(f.el('c-employees').disabled,true);assert.equal(f.el('contact-modules').querySelectorAll('input').length,7);});});
await test('Required name and email prevent dispatch',async()=>{await withFixture('',undefined,async f=>{f.fields();f.el('c-name').value='';await f.submit();assert.equal(f.calls.length,0);f.fields();f.el('c-email').value='invalid';await f.submit();assert.equal(f.calls.length,0);});});
await test('Buyer blank company rejected without invented entity',async()=>{await withFixture('',undefined,async f=>{f.fields();f.el('c-company').value='';await f.submit();assert.equal(f.calls.length,0);});});
await test('Allowed immutable attribution is included without unsupported top-level fields',async()=>{await withFixture('?utm_source=afkcube&utm_campaign=first-test&ref=partner-07&source_page=partners',undefined,async f=>{f.fields();await f.submit();const b=JSON.parse(f.calls[0].body);for(const token of ['afkcube','first-test','partner-07','partners'])assert.ok(b.message.includes(token),token);assert.ok(b.message.length<=2000);});});
await test('Untrusted source values dropped and text never executed',async()=>{await withFixture('?utm_source=%3Cimg%20onerror%3Dalert(1)%3E&ref='+ 'a'.repeat(41)+'&source_page=evil',undefined,async f=>{f.fields();await f.submit();const m=JSON.parse(f.calls[0].body).message;assert.ok(!m.includes('<img'));assert.ok(!m.includes('a'.repeat(41)));assert.ok(!m.includes('evil'));});});
await test('First-page source remains immutable if later URL changes',async()=>{await withFixture('?utm_source=original&ref=first',undefined,async f=>{f.w.history.replaceState({},'', '/contact?utm_source=later&ref=last');f.fields();await f.submit();const message=JSON.parse(f.calls[0].body).message;assert.match(message,/original/);assert.match(message,/first/);assert.ok(!message.includes('later'));assert.ok(!message.includes('last'));});});
await test('Composed message bound rejects overlong message without truncation',async()=>{await withFixture('',undefined,async f=>{f.fields();f.el('c-message').value='z'.repeat(2200);await f.submit();assert.equal(f.calls.length,0);assert.equal(f.el('c-message').value.length,2200);assert.ok(f.el('contact-form').querySelector('.error').textContent);});});
await test('Concurrent double submit dispatches once',async()=>{let release;await withFixture('',()=>new Promise(r=>{release=r;}),async f=>{f.fields();await f.submit();await f.submit();assert.equal(f.calls.length,1);release({status:201,body:{ok:true}});await flush();});});
for(const failure of ['network','server','misleading200','malformed'])await test('Unconfirmed '+failure+' retry uses identical serialized body and key despite attempted edits',async()=>{
  await withFixture('?intent=referral-partnership&utm_source=first',async(_,n)=>{if(n===1){if(failure==='network')throw new TypeError('offline');return failure==='server'?{status:500,body:{error:'server failure'}}:failure==='malformed'?{status:201,malformed:true}:{status:200,body:{ok:true}};}return {status:201,body:{ok:true}};},async f=>{
    f.fields();await f.submit();assert.equal(f.calls.length,1);assert.ok(!f.el('contact-form').classList.contains('hidden'));assert.equal(f.el('c-message').disabled,true);
    const first=f.calls[0];f.el('c-message').value='attempted different text';f.change('c-intent','custom-workflow');await f.submit();assert.equal(f.calls.length,2);assert.equal(f.calls[1].body,first.body);assert.equal(f.calls[1].key,first.key);assert.equal(f.el('contact-done').classList.contains('hidden'),false);
  });
});
await test('Timeout preserves uncertainty and exact retry',async()=>{await withFixture('',async(req,n)=>{if(n===1)return new Promise((resolve,reject)=>{req.signal.addEventListener('abort',()=>reject(new Error('aborted')));});return {status:201,body:{ok:true}};},async f=>{f.fields();await f.submit();assert.equal(f.calls.length,1);f.timers[0].fn();await flush();await f.submit();assert.equal(f.calls.length,2);assert.equal(f.calls[0].body,f.calls[1].body);assert.equal(f.calls[0].key,f.calls[1].key);});});
await test('Confirmed acknowledgement enables explicit new inquiry with fresh key',async()=>{await withFixture('',undefined,async f=>{f.fields();await f.submit();const key=f.calls[0].key;assert.equal(f.el('contact-done').classList.contains('hidden'),false);f.el('contact-new').click();await flush();assert.equal(f.el('contact-form').classList.contains('hidden'),false);assert.equal(f.el('c-message').disabled,false);f.fields();await f.submit();assert.notEqual(f.calls[1].key,key);});});
await test('Customer login controls and closed signup gate preserved',async()=>{await withFixture('',undefined,async f=>{assert.ok(f.el('login-form'));assert.ok(f.el('login-mfa'));assert.equal(f.el('signup-submit').disabled,true);for(const el of f.d.querySelectorAll('.signup-only'))assert.ok(el.classList.contains('hidden'));});});
await test('Readiness-safe metadata and static usable product proof',async()=>{const d=new JSDOM(html).window.document;assert.match(d.title,/In development/i);assert.match(d.querySelector('meta[name=description]').content,/active development/i);assert.ok(!d.querySelector('script[type="application/ld+json"]'));assert.ok(d.querySelectorAll('img').length>=2);assert.match(d.body.textContent,/fictional local demonstration data/i);assert.match(d.body.textContent,/Accounting/);assert.match(d.body.textContent,/WIP|work in progress/i);});
await test('User-selected proof panels render immediately and reduced motion skips animation',async()=>{await withFixture('',undefined,async f=>{const animations=[];for(const panel of f.d.querySelectorAll('[data-proof]'))panel.animate=(...args)=>animations.push(args);f.w.matchMedia=()=>({matches:true});f.d.querySelector('[data-screen="mobile"]').click();assert.equal(f.el('proof-mobile').hidden,false);assert.equal(f.el('proof-roster').hidden,true);assert.equal(animations.length,0);f.w.matchMedia=()=>({matches:false});f.d.querySelector('[data-screen="missing"]').click();assert.equal(f.el('proof-missing').hidden,false);assert.equal(animations.length,1);});});
await test('No-JavaScript markup retains all genuine proof screens',async()=>{const d=new JSDOM(html).window.document;for(const panel of d.querySelectorAll('[data-proof]')){assert.equal(panel.hidden,false);assert.ok(panel.querySelector('img[src]'));}assert.equal(d.querySelectorAll('[data-proof]').length,3);});
await test('Captured representative payloads retained for independent backend-schema check',async()=>{
  const payloads=[];
  for(const item of [{name:'individual-partner',query:'?intent=referral-partnership&utm_source=afkcube&source_page=partners&ref=demo-partner',individual:true},{name:'organisation-partner',query:'?intent=referral-partnership&utm_source=afkcube&source_page=partners'},{name:'buyer',query:'?intent=custom-workflow&utm_source=afkcube&source_page=custom-software'},{name:'adversarial-query',query:'?intent=%3Cscript%3E&utm_source=%3Cimg%3E&ref='+ 'q'.repeat(41)+'&source_page=evil'}])await withFixture(item.query,undefined,async f=>{f.fields();if(item.individual){f.el('c-company').value='';f.el('c-individual').checked=true;f.el('c-individual').dispatchEvent(new f.w.Event('change'));}await f.submit();assert.equal(f.calls.length,1);payloads.push({name:item.name,serialized_body:f.calls[0].body,payload:JSON.parse(f.calls[0].body),synthetic_key:f.calls[0].key});});
  fs.writeFileSync(path.join(reportDir,'captured-payloads.json'),JSON.stringify({generated_at:new Date().toISOString(),context:'Fictional local jsdom fetch-recorder captures. No external request. Pending independent real declaration/schema validation; not evidence of actual backend persistence or inquiry delivery.',payloads},null,2)+'\n');
});

const report={checked_at:new Date().toISOString(),scope:'Actual revised static HTML and marketing/app JavaScript in jsdom with an isolated fetch recorder. No real server, host, inbox, live product workflow, signup or payment was exercised.',passed:results.filter(x=>x.status==='PASS').length,failed:results.filter(x=>x.status==='FAIL').length,results};
fs.writeFileSync(path.join(reportDir,'verification.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
if(report.failed)process.exitCode=1;
