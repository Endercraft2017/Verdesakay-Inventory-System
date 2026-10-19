// Production messaging sources against delayed sample APIs. No live account or network.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const read=p=>fs.readFileSync(new URL('../public/'+p,import.meta.url),'utf8');
const browser=await chromium.launch({...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),headless:true,args:['--no-sandbox']});
try {
 const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://messaging.example/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><main id="view"></main><div id="m-toasts"></div><div id="m-overlay-root"></div>'}));
 await page.goto('https://messaging.example/');
 await page.addStyleTag({content:[read('mobile/mobile.css'),read('mobile/mobile-v2.css')].join('\n')});
 await page.addScriptTag({content:read('mobile/lib/dom.js')});
 await page.addScriptTag({content:read('js/lib/photo-viewer.js')});
 await page.addScriptTag({content:`
 window.routes={};window.sample={calls:[],fail:{},delay:200,users:[{id:1,full_name:'Me'},{id:2,full_name:'Alex Sample',department_name:'Operations'},{id:3,full_name:'Sam Sample',department_name:'Finance'}]};
 window.handlers={};window.ChatWS={connected:false,on:(n,f)=>handlers[n]=f,off:n=>delete handlers[n],send:()=>{}};
 window.MApp={getMe:()=>({id:1,full_name:'Me'}),setTitle:()=>{},route:(n,f)=>routes[n]=f,go:(n,p={})=>{location.hash='/'+n+'?'+new URLSearchParams(p)}};
 window.draw=()=>{if(window.mChatNavigation&&!mChatNavigation.allow())return;window.mChatNavigation?.release();window.mChatViewport?.release();let hash=location.hash.slice(2),[n,q]=hash.split('?');let v=document.getElementById('view');v.innerHTML='';v.dataset.route=n;if(routes[n])routes[n](v,Object.fromEntries(new URLSearchParams(q||'')));else v.textContent='Another screen';};
 window.addEventListener('hashchange',draw);
 const msg=(id,who=2)=>({id,body:'Sample message '+id+' from '+who,mine:id===50,sender_id:id===50?1:who,recipient_id:id===50?who:1,created_at:'2026-10-19 01:00:00',attachments:[],reactions:[]});
 async function call(method,path,body){sample.calls.push({method,path,body});await new Promise(r=>setTimeout(r,path.includes('before=')?700:sample.delay));if(sample.fail[path]){sample.fail[path]--;throw Error('Sample network unavailable')}if(method==='get'){if(path==='/users')return sample.users;if(path==='/messages/conversations')return[{other_id:2,other_name:'Alex Sample',last_message:'Sample hello',unread_count:1}];if(path.includes('/messages/with/'))return path.includes('/with/2')?(path.includes('before=')?[msg(0)]:Array.from({length:50},(_,i)=>msg(50-i))):[msg(200,3)];return{}}return{edited_at:'2026-10-19 02:00:00',id:501};}
 window.API={isSharedSession:()=>false,get:p=>call('get',p),post:(p,b)=>call('post',p,b),patch:(p,b)=>call('patch',p,b),del:p=>call('del',p),upload:(p,fd,opt)=>{opt.onProgress({loaded:1,total:2});return call('upload',p,{recipient_id:fd.get('recipient_id')})}};
 `});
 await page.addScriptTag({content:read('mobile/modules/core/inbox.js')});
 await page.addScriptTag({content:read('mobile/modules/hr/directory.js')});
 const go=(route,params={})=>page.evaluate(([r,p])=>MApp.go(r,p),[route,params]);
 await page.addStyleTag({content:read('css/photo-viewer.css')+'\n#view{height:100dvh;overflow:hidden}'});
 await page.evaluate(()=>{
  const oldPost=API.post;
  sample.reaction=null;sample.reactCalls=0;sample.removeCalls=0;sample.reactionFail=false;sample.removeFail=true;
  API.post=async(path,body)=>{if(!path.endsWith('/react'))return oldPost(path,body);sample.reactCalls++;await new Promise(r=>setTimeout(r,450));if(sample.reactionFail){sample.reactionFail=false;throw Error('Sample reaction unavailable')}sample.reaction=sample.reaction===body.emoji?null:body.emoji;return{reactions:sample.reaction?[{emoji:sample.reaction,user_id:1}]:[]}};
  API.del=async()=>{sample.removeCalls++;await new Promise(r=>setTimeout(r,450));if(sample.removeFail){sample.removeFail=false;throw Error('Sample remove unavailable')}return{ok:true}};
 });
 await go('inbox',{thread:2,name:'Alex Sample'});await page.locator('.m-chat-row[data-id="50"]').waitFor();
 async function openActions(){await page.locator('.m-chat-row[data-id="50"]').focus();await page.keyboard.press('Shift+F10');await page.getByRole('dialog',{name:'Message actions',exact:true}).waitFor();}
 await openActions();assert.equal(await page.locator('.m-chat-sheet-backdrop').count(),1);
 if(process.env.OVERLAY_SCREENSHOT) await page.screenshot({path:process.env.OVERLAY_SCREENSHOT});
 const bar=await page.locator('.m-chat-reaction-popover').boundingBox(),bubble=await page.locator('.m-chat-row[data-id="50"] .m-chat-bubble').boundingBox();assert.ok(bar.y+bar.height<=bubble.y+2,'Reaction bar should sit above its message');
 const sheet=await page.locator('.m-chat-sheet').boundingBox();assert.ok(bar.y+bar.height<sheet.y,'Reaction bar must not cover message actions');assert.ok(bubble.y+bubble.height<sheet.y,'Selected message stays visible above the actions');
 // Selected message is restored on Escape; keyboard focus cannot enter the page behind the sheet.
 await page.locator('#m-chat-input').evaluate(el=>el.focus());assert.equal(await page.locator('.m-chat-sheet-backdrop').evaluate(el=>el.contains(document.activeElement)),true);
 await page.getByRole('button',{name:'React with Like',exact:true}).evaluate(b=>{b.click();b.click();b.dispatchEvent(new MouseEvent('click'));});assert.equal(await page.evaluate(()=>sample.reactCalls),1);
 await page.keyboard.press('Escape');await openActions();assert.equal(await page.getByRole('button',{name:'React with Like',exact:true}).isDisabled(),true);
 await page.getByRole('button',{name:'Remove Like',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Remove Like',exact:true}).getAttribute('aria-pressed'),'true');
 await page.getByRole('button',{name:'React with Love',exact:true}).click();await page.waitForFunction(()=>sample.reaction==='❤️');await page.locator('.m-chat-sheet-backdrop').waitFor({state:'detached'});
 assert.equal(await page.locator('.m-chat-reaction.mine').getAttribute('data-emoji'),'❤️');assert.equal(await page.locator('.m-chat-row[data-id="50"]').evaluate(el=>el===document.activeElement),true);
 await openActions();await page.getByRole('button',{name:'Remove Love',exact:true}).click();await page.locator('.m-chat-sheet-backdrop').waitFor({state:'detached'});assert.equal(await page.locator('.m-chat-reaction.mine').count(),0);
 await page.evaluate(()=>sample.reactionFail=true);await openActions();await page.getByRole('button',{name:'React with Like',exact:true}).click();await page.locator('[data-reaction-status]').filter({hasText:'Could not confirm'}).waitFor();assert.equal(await page.getByRole('button',{name:'React with Like',exact:true}).isEnabled(),true);await page.keyboard.press('Escape');
 // Removal uses the app dialog, starts on Cancel, keeps errors visible, and submits once.
 await openActions();await page.getByRole('button',{name:'Remove',exact:true}).click();let remove=page.getByRole('dialog',{name:'Remove message for everyone?',exact:true});await remove.waitFor();assert.equal(await remove.locator('[data-cancel]').evaluate(el=>el===document.activeElement),true);
 await remove.locator('[data-confirm]').evaluate(b=>{b.click();b.click();b.dispatchEvent(new MouseEvent('click'));});await page.keyboard.press('Escape');assert.equal(await remove.count(),1);await remove.locator('[data-remove-error]').filter({hasText:'Sample remove unavailable'}).waitFor();assert.equal(await page.evaluate(()=>sample.removeCalls),1);await remove.locator('[data-cancel]').click();assert.match(await page.locator('.m-chat-row[data-id="50"]').innerText(),/Sample message 50/);
 await openActions();await page.getByRole('button',{name:'Remove',exact:true}).click();await page.locator('[data-confirm]').click();await page.locator('.m-chat-row[data-id="50"] .removed').waitFor();assert.equal(await page.getByRole('dialog').count(),0);
 // Shared photo/file viewers: one active instance, retry, focus containment and URL cleanup.
 await page.evaluate(()=>{
   const opener=document.createElement('button');opener.id='viewer-opener';opener.textContent='Sample attachment';document.body.append(opener);opener.focus();
   sample.blobs=0;sample.blobFail=true;sample.revoked=[];sample.downloads=0;sample.previewFail=true;
   const revoke=URL.revokeObjectURL.bind(URL);URL.revokeObjectURL=url=>{sample.revoked.push(url);revoke(url)};
   API.blobUrl=async()=>{sample.blobs++;await new Promise(r=>setTimeout(r,250));if(sample.blobFail){sample.blobFail=false;throw Error('Sample photo unavailable')}return URL.createObjectURL(new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="#1b6b46"/></svg>'],{type:'image/svg+xml'}));};
   const oldGet=API.get;API.get=async path=>{if(!path.endsWith('/preview'))return oldGet(path);await new Promise(r=>setTimeout(r,200));if(sample.previewFail){sample.previewFail=false;throw Error('Sample preview unavailable')}return{text:'Sample file preview'}};
   API.download=async()=>{sample.downloads++;await new Promise(r=>setTimeout(r,450));throw Error('Sample download unavailable')};
   PhotoViewer.open('/sample/photo','Sample photo');PhotoViewer.open('/sample/photo','Sample photo');
 });
 assert.equal(await page.locator('.attachment-photo-viewer').count(),1);await page.getByRole('button',{name:'Retry photo',exact:true}).waitFor();assert.equal(await page.evaluate(()=>sample.blobs),1);
 await page.getByRole('button',{name:'Retry photo',exact:true}).evaluate(b=>{b.click();b.click();b.dispatchEvent(new MouseEvent('click'));});await page.locator('.attachment-photo-viewer img:not([hidden])').waitFor();assert.equal(await page.evaluate(()=>sample.blobs),2);
 await page.keyboard.press('Tab');assert.equal(await page.locator('.attachment-photo-viewer').evaluate(el=>el.contains(document.activeElement)),true);await page.keyboard.press('Escape');assert.equal(await page.locator('.attachment-photo-viewer').count(),0);assert.equal(await page.locator('#viewer-opener').evaluate(el=>el===document.activeElement),true);assert.equal(await page.evaluate(()=>sample.revoked.length),1);
 await page.evaluate(()=>{PhotoViewer.open('/sample/late','Late photo');document.querySelector('.attachment-photo-viewer [data-close]').click();});await page.waitForTimeout(300);assert.equal(await page.evaluate(()=>sample.revoked.length),2);
 await page.evaluate(()=>{AttachmentViewer.open('/sample/file','Sample.txt');AttachmentViewer.open('/sample/file','Sample.txt')});assert.equal(await page.locator('.attachment-document-viewer').count(),1);await page.getByRole('button',{name:'Retry preview',exact:true}).click();await page.locator('.attachment-document-body pre').filter({hasText:'Sample file preview'}).waitFor();
 await page.locator('[data-download]').evaluate(b=>{b.click();b.click();b.dispatchEvent(new MouseEvent('click'));});await page.waitForFunction(()=>sample.downloads===1);await page.locator('[data-close]').click();await page.evaluate(()=>AttachmentViewer.open('/sample/file','Sample.txt'));assert.equal(await page.locator('[data-download]').isDisabled(),true);await page.locator('.attachment-download-error').filter({hasText:'Sample download unavailable'}).waitFor();assert.equal(await page.locator('[data-download]').isEnabled(),true);assert.equal(await page.evaluate(()=>sample.downloads),1);await page.locator('.attachment-document-body pre').waitFor();
 await page.evaluate(()=>PhotoViewer.open('/sample/photo','Sample photo'));assert.equal(await page.locator('.attachment-document-viewer').count(),0);assert.equal(await page.locator('.attachment-photo-viewer').count(),1);await page.keyboard.press('Escape');
 assert.deepEqual(errors,[]);console.log('PASS: Messenger bar above message; one pending reaction across reopen; highlight/replace/remove; reaction errors; keyboard focus; removal cancel/failure/retry/single request; one active attachment viewer; photo/file retry; repeated download guard across reopen; late URL cleanup; no runtime errors.');
}finally{await browser.close()}
