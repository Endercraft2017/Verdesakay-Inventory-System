import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';

const server=spawn(process.execPath,['--import','tsx','scripts/browser/editor-ux-server.ts'],{stdio:['ignore','pipe','pipe']});
let browser;
try{
  const port=await new Promise((resolve,reject)=>{
    server.stdout.on('data',data=>{const m=String(data).match(/EDITOR_UX_PORT=(\d+)/);if(m)resolve(m[1]);});
    server.on('exit',code=>reject(new Error('Disposable server exited: '+code)));
  });
  const base=`http://127.0.0.1:${port}`;
  const run=async(method,path,token,data,expected=200)=>{
    const response=await fetch(base+'/api'+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),
      'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});
    const value=await response.json();assert.equal(response.status,expected,`${path}: ${JSON.stringify(value)}`);return value;
  };
  const admin=(await run('POST','/auth/login',null,{username:'admin',password:'admin123'})).token;
  await run('POST','/users',admin,{username:'counter-browser',full_name:'Counter Browser',password:'testpass123',role:'warehouse'},201);
  const counter=(await run('POST','/auth/login',null,{username:'counter-browser',password:'testpass123'})).token;
  const item=await run('POST','/inventory',admin,{name:'Count browser bolts',quantity:5},201);
  const locations=await run('GET','/locations',admin);
  const location=locations.find(l=>l.is_default)||locations[0];
  browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
  const errors=[];
  const wide=await browser.newContext({viewport:{width:1440,height:900},serviceWorkers:'block'});
  await wide.addInitScript(token=>localStorage.setItem('vds_token',token),counter);
  const page=await wide.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/app');
  await page.waitForFunction(()=>typeof App!=='undefined'&&App.getMe());
  await page.evaluate(()=>App.navigate('stock-counts'));
  await page.getByRole('button',{name:'New count'}).click();
  await page.locator('#pc-search').fill('Count browser bolts');
  await page.locator('#pc-item option[value="'+item.id+'"]').waitFor({state:'attached'});
  await page.locator('#pc-item').selectOption(String(item.id));
  await page.locator('#pc-location').selectOption(String(location.id));
  await page.getByRole('button',{name:'Load stock to count'}).click();
  await page.locator('#pc-untracked').fill('3');
  await page.locator('#pc-note').fill('Physically counted the bolts on the exact shelf');
  const attemptKeys=[];
  page.on('request',request=>{
    if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/inventory/stock-counts')
      attemptKeys.push(request.headers()['idempotency-key']);
  });
  await page.route('**/api/inventory/stock-counts',async route=>{
    if(route.request().method()!=='POST'){await route.continue();return;}
    const response=await route.fetch();assert.equal(response.status(),201);
    await route.abort('failed');
  },{times:1});
  await page.getByRole('button',{name:'Submit for independent review'}).click();
  await page.getByText('Confirmation unknown. Retry the exact saved count',{exact:false}).waitFor();
  assert.equal((await run('GET','/inventory/'+item.id,admin)).quantity,5);
  await page.getByRole('button',{name:'Retry same count'}).click();
  await page.locator('#modal-root .modal-overlay').waitFor({state:'detached'});
  await page.locator('#pc-list').getByText('Count browser bolts').waitFor();
  assert.equal(attemptKeys.length,2);
  assert.equal(attemptKeys[0],attemptKeys[1]);
  assert.equal((await run('GET','/inventory/stock-counts?status=all',admin)).filter(c=>c.item_id===item.id).length,1);
  assert.equal((await run('GET','/inventory/'+item.id,admin)).quantity,5);
  console.log('Desktop 1440px: committed count lost its response; retry kept the same key and one observation, with no stock change');
  await wide.close();

  const narrow=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
  await narrow.addInitScript(token=>localStorage.setItem('vds_token',token),admin);
  const phone=await narrow.newPage();phone.on('pageerror',e=>errors.push(e.message));
  await phone.goto(base+'/app');
  await phone.waitForFunction(()=>typeof App!=='undefined'&&App.getMe());
  await phone.evaluate(()=>App.navigate('stock-counts'));
  await phone.getByRole('button',{name:'Review',exact:true}).click();
  await phone.locator('#pc-action-note').fill('I checked the shelf and independently approved this count');
  await phone.getByRole('button',{name:'Approve',exact:true}).click();
  await phone.getByRole('button',{name:'Review',exact:true}).click();
  await phone.getByRole('button',{name:'Apply safe correction'}).click();
  await phone.getByRole('button',{name:'All',exact:true}).click();
  await phone.getByText('Count browser bolts').waitFor();
  assert.equal((await run('GET','/inventory/'+item.id,admin)).quantity,3);
  const staleItem=await run('POST','/inventory',admin,{name:'Stale review browser bolts',quantity:4},201);
  const staleContext=await run('GET',`/inventory/stock-counts/context?item_id=${staleItem.id}&location_id=${location.id}&build_mode=assembled`,counter);
  const staleCount=await run('POST','/inventory/stock-counts',counter,{
    item_id:staleItem.id,location_id:location.id,build_mode:'assembled',expected_quantity:staleContext.book_quantity,
    expected_serial_ids:[],expected_batches:[],counted_untracked:3,counted_serial_codes:[],counted_batches:[],
    note:'Counted the exact shelf before a new receipt',
  },201);
  await run('POST',`/inventory/${staleItem.id}/adjust`,admin,{change:1,location_id:location.id,reason:'New receipt before review'});
  await phone.evaluate(()=>App.navigate('stock-counts'));
  await phone.getByRole('button',{name:'Review',exact:true}).first().click();
  await phone.locator('#pc-action-note').fill('Checked the old snapshot against the new receipt');
  await phone.getByRole('button',{name:'Approve',exact:true}).click();
  await phone.locator('#pc-action-error').getByText(/changed|stale/i).waitFor();
  assert.equal((await run('GET',`/inventory/stock-counts/${staleCount.id}`,admin)).status,'submitted');
  assert.equal((await run('GET',`/inventory/${staleItem.id}`,admin)).quantity,5);
  assert.equal(errors.length,0,errors.join('\n'));
  console.log('Desktop 390px: independent approval and exact-once correction; stale review cannot approve or move stock');
  await narrow.close();
}finally{await browser?.close();server.kill('SIGTERM');}
