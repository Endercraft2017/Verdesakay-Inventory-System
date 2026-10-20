import { chromium } from 'playwright';
import fs from 'node:fs';
const browser = await chromium.launch({headless:true,args:['--no-sandbox']});
const page = await browser.newPage();
await page.setContent('<div id="view"></div>');
await page.addStyleTag({content:fs.readFileSync('public/css/styles.css','utf8')});
await page.evaluate(() => {
 window.late = false;
 window.App = {register:(_,fn)=>window.render=fn,hasPermission:()=>true,currentLocation:()=>({route:'hr-kiosk'})};
 window.UI = {icon:()=>'',esc:s=>String(s)};
 window.qrcode = ()=>({addData(){},make(){},createDataURL(){return ''}});
 const date = new Date(); const today = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
 window.API = {get:async path=>path.includes('kiosk-devices')?{lock_active:false}:path.endsWith('/code')?{code:'123',seconds_left:60}:path.includes('clock/recent')?[
 {id:2,name:'Sample Employee',ts:today+' 17:00',kind:'out',segment:'afternoon_out',photo_id:window.late?12:null},
 {id:1,name:'Sample Employee',ts:today+' 08:04',kind:'in',segment:'morning_in',photo_id:11}]:[],blobUrl:async()=>URL.createObjectURL(new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="teal"/></svg>'],{type:'image/svg+xml'}))};
});
await page.addScriptTag({content:fs.readFileSync('public/js/modules/hr/hr-kiosk.js','utf8')});
await page.evaluate(()=>window.render(document.querySelector('#view')));
await page.waitForFunction(()=>document.querySelector('[data-punch-photo="11"]')?.hidden===false);
await page.evaluate(()=>window.late=true);
await page.waitForFunction(()=>document.querySelector('[data-punch-photo="12"]')?.hidden===false);
for(const width of [325,260]) {
 await page.addStyleTag({content:`.kiosk-side{width:${width}px;min-width:0;max-width:${width}px}`});
 const fits=await page.locator('.kr-label').evaluateAll(labels=>labels.every(el=>el.scrollWidth<=el.clientWidth && el.getBoundingClientRect().right<=el.parentElement.getBoundingClientRect().right));
 if(!fits)throw new Error('Label overflow at '+width);
}
if(await page.locator('.kr-slot.in [data-punch-photo="11"]').count()!==1 || await page.locator('.kr-slot.out [data-punch-photo="12"]').count()!==1)throw new Error('Wrong photo slot');
await page.evaluate(()=>document.querySelector('#view').innerHTML='');
await browser.close();
console.log('PASS: correct punch photos, late upload refresh, labels fit at 325px and 260px.');
