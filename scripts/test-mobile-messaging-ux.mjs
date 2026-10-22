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
 await page.evaluate(()=>sample.fail['/messages/conversations']=1);await go('inbox');
 await page.locator('#m-inbox-search').fill('Alex');await page.locator('[data-filter=unread]').click();
 assert.match(await page.locator('#m-inbox-list').innerText(),/Loading/);
 await page.locator('#m-inbox-retry').waitFor();await page.locator('#m-inbox-search').fill('Alex Sample');assert.equal(await page.locator('#m-inbox-retry').count(),1);
 await page.locator('#m-inbox-retry').click();await page.locator('.m-inbox-row').waitFor();assert.equal(await page.locator('#m-inbox-search').inputValue(),'Alex Sample');assert.equal(await page.locator('[data-filter=unread]').getAttribute('aria-selected'),'true');
 await page.evaluate(()=>sample.fail['/users']=1);await page.locator('#m-inbox-new').click();await page.locator('[data-recipient-search]').fill('Finance');
 await page.getByRole('button',{name:'Try again',exact:true}).click();await page.locator('[data-to] option[value="3"]').waitFor({state:'attached'});assert.equal(await page.locator('[data-to] option').count(),2);
 await page.locator('[data-to]').selectOption('3');await page.locator('[data-start]').click();await page.locator('.m-chat-heading h1').filter({hasText:'Sam Sample'}).waitFor();
 // A late initial response from Alex must never replace Sam's thread.
 await go('inbox',{thread:2,name:'Alex Sample'});await page.locator('.m-chat-heading h1').filter({hasText:'Alex Sample'}).waitFor();await go('inbox',{thread:3,name:'Sam Sample'});await page.locator('.m-chat-row[data-id="200"]').waitFor();assert.equal(await page.locator('.m-chat-row[data-id="50"]').count(),0);
 await go('inbox',{thread:2,name:'Alex Sample'});await page.locator('.m-chat-row[data-id="50"]').waitFor();
 await page.locator('#m-chat-load-older button').evaluate(b=>{b.click();b.click();b.dispatchEvent(new MouseEvent('click'));});
 await go('inbox',{thread:3,name:'Sam Sample'});await page.locator('.m-chat-row[data-id="200"]').waitFor();await page.waitForTimeout(750);assert.equal(await page.locator('.m-chat-row[data-id="0"]').count(),0);assert.equal(await page.evaluate(()=>sample.calls.filter(c=>c.path.includes('before=')).length),1);
 await go('inbox',{thread:2,name:'Alex Sample'});await page.locator('.m-chat-row[data-id="50"]').waitFor();await page.locator('#m-chat-input').fill('Separate unsent draft');
 async function edit(){await page.locator('.m-chat-row[data-id="50"]').evaluate(row=>{row.dispatchEvent(new TouchEvent('touchstart',{touches:[new Touch({identifier:1,target:row,clientX:100,clientY:100})]}));});await page.getByRole('button',{name:'Edit',exact:true}).waitFor();await page.locator('.m-chat-row[data-id="50"]').evaluate(row=>{row.dispatchEvent(new TouchEvent('touchstart',{touches:[new Touch({identifier:2,target:row,clientX:100,clientY:100})]}));});await page.waitForTimeout(550);assert.equal(await page.locator('.m-chat-sheet').count(),1);await page.getByRole('button',{name:'Edit',exact:true}).click();}
 await edit();await page.locator('#m-chat-input').fill('Edited once');await page.locator('#m-chat-send').evaluate(b=>{b.click();b.click();b.dispatchEvent(new MouseEvent('click'));});
 await go('directory');await page.locator('[data-chat-leave]').getByText('A message is still being sent.',{exact:true}).waitFor();
 await page.locator('[data-chat-feedback]').filter({hasText:'Message updated.'}).waitFor();assert.equal(await page.locator('#m-chat-input').inputValue(),'Separate unsent draft');assert.equal(await page.evaluate(()=>sample.calls.filter(c=>c.method==='patch').length),1);await page.locator('[data-stay]').click();
 await page.evaluate(()=>sample.fail['/messages/50']=1);await edit();await page.locator('#m-chat-input').fill('Retain failed edit');await page.locator('#m-chat-send').click();await page.locator('[data-chat-feedback]').filter({hasText:'Sample network unavailable'}).waitFor();assert.equal(await page.locator('#m-chat-input').inputValue(),'Retain failed edit');assert.equal(await page.locator('#m-chat-send').isEnabled(),true);await page.locator('#m-chat-send').click();await page.locator('[data-chat-feedback]').filter({hasText:'Message updated.'}).waitFor();assert.equal(await page.locator('#m-chat-input').inputValue(),'Separate unsent draft');
 await page.locator('#m-chat-input').fill('Text and files kept');
 const file=i=>({name:'sample-'+i+'.txt',mimeType:'text/plain',buffer:Buffer.from('Sample attachment')});
 await page.locator('#m-chat-file').setInputFiles([file(1),file(2)]);assert.equal(await page.locator('.m-chat-file-chip').count(),2);
 await page.locator('#m-chat-file').setInputFiles(Array.from({length:11},(_,i)=>file(i+3)));assert.equal(await page.locator('.m-chat-file-chip').count(),2);assert.match(await page.locator('[data-chat-feedback]').innerText(),/Extra files were not added/);
 await go('directory');await page.locator('[data-discard]').waitFor();assert.equal(await page.locator('.m-chat-file-chip').count(),2);await page.locator('[data-stay]').click();
 await page.evaluate(()=>sample.fail['/messages']=1);await page.locator('#m-chat-send').evaluate(b=>{b.click();b.dispatchEvent(new MouseEvent('click'));});await page.locator('[data-chat-feedback]').filter({hasText:'Check the conversation'}).waitFor();assert.equal(await page.locator('.m-chat-file-chip').count(),2);assert.equal(await page.locator('#m-chat-input').inputValue(),'Text and files kept');assert.equal(await page.evaluate(()=>sample.calls.filter(c=>c.method==='upload').length),1);
 await page.locator('#m-chat-send').click();await page.locator('[data-chat-feedback]').filter({hasText:'Message sent.'}).waitFor();assert.equal(await page.locator('.m-chat-file-chip').count(),0);
 // Explicit discard navigates once; text draft remains for the original recipient.
 await page.locator('#m-chat-input').fill('Return to this draft');await page.locator('#m-chat-file').setInputFiles(file(8));await page.evaluate(()=>sample.fail['/users']=1);await go('directory');await page.locator('[data-discard]').click();await page.locator('#m-dir-q').waitFor();await page.locator('#m-dir-q').fill('Operations');assert.match(await page.locator('#m-dir-list').innerText(),/Loading/);await page.getByRole('button',{name:'Try again',exact:true}).click();await page.getByRole('button',{name:'Message Alex Sample',exact:true}).waitFor();assert.equal(await page.locator('#m-dir-q').inputValue(),'Operations');await page.getByRole('button',{name:'Message Alex Sample',exact:true}).focus();await page.keyboard.press('Enter');await page.locator('#m-chat-input').waitFor();assert.equal(await page.locator('#m-chat-input').inputValue(),'Return to this draft');
 await page.evaluate(()=>handlers['message:new']({id:999,body:'Sample live message',sender_id:2,recipient_id:1,attachments:[],created_at:'2026-10-19 03:00:00'}));await page.evaluate(()=>handlers['message:new']({id:999,body:'Sample live message',sender_id:2,recipient_id:1,attachments:[],created_at:'2026-10-19 03:00:00'}));assert.equal(await page.locator('.m-chat-row[data-id="999"]').count(),1);
 await page.evaluate(()=>document.documentElement.setAttribute('data-theme','dark'));assert.deepEqual(errors,[]);
 console.log('PASS: loading/error/search/filter retry; recipient filtering; late initial/history isolation; one edit request; pending navigation guard; edit failure retry; file count/retention/upload retry; explicit discard; preserved text draft; keyboard directory; duplicate realtime delivery; no runtime errors.');
}finally{await browser.close()}
