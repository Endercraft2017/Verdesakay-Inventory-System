import {test,expect} from '@playwright/test';

test('public inquiry retries a lost committed response, rejects changed details and then replays the original without duplication',async({browser})=>{
  const context=await browser.newContext({baseURL:'http://localhost:4173'}),page=await context.newPage();
  try{
    await page.goto('/contact');const form=page.locator('#contact-form');
    await form.getByLabel('Your name').fill('Synthetic receipt contact');await form.getByLabel('Company',{exact:true}).fill('Browser inquiry receipt');
    await form.getByRole('textbox',{name:'Email',exact:true}).fill('receipt-inquiry@example.test');await form.locator('#c-message').fill('Original private inquiry');
    let lost=false,key:string|undefined;
    await page.route('**/site/inquiry',async route=>{
      const current=route.request().headers()['idempotency-key'];
      if(!lost){key=current;const committed=await route.fetch();expect(committed.status()).toBe(201);lost=true;await route.abort('failed');}
      else{expect(current).toBe(key);await route.continue();}
    });
    await form.locator('#contact-submit').click();await expect(form.getByRole('alert')).not.toBeEmpty();await expect(form.locator('#contact-submit')).toBeEnabled();
    expect(key).toMatch(/^[a-f0-9-]{36}$/);await form.locator('#c-message').fill('Changed after uncertain send');
    const conflict=page.waitForResponse(r=>r.url().endsWith('/site/inquiry')&&r.request().method()==='POST');await form.locator('#contact-submit').click();expect((await conflict).status()).toBe(409);
    await expect(form.locator('#c-message')).toHaveValue('Changed after uncertain send');await expect(page.locator('#contact-done')).not.toBeVisible();
    await form.locator('#c-message').fill('Original private inquiry');
    const retried=page.waitForResponse(r=>r.url().endsWith('/site/inquiry')&&r.request().method()==='POST');await form.locator('#contact-submit').click();const replay=await retried;
    expect(replay.status()).toBe(201);expect(replay.headers()['idempotency-replayed']).toBe('true');expect(await replay.json()).toEqual({ok:true});await expect(page.locator('#contact-done')).toBeVisible();
    const login=await context.request.post('/_platform/api/login',{headers:{'X-Requested-With':'VDS','X-Session-Mode':'cookie'},data:{username:'browser-operator',password:'Synthetic browser operator password'}});expect(login.status()).toBe(200);
    const response=await context.request.get('/_platform/api/inquiries');const inquiries=(await response.json()).inquiries.filter((row:{email:string})=>row.email==='receipt-inquiry@example.test');expect(inquiries).toHaveLength(1);expect(inquiries[0].message).toBe('Original private inquiry');
    const status=await context.request.get('/_platform/api/mail');const events=(await status.json()).outbox.filter((row:{kind:string;source_id:number})=>row.kind==='inquiry'&&row.source_id===inquiries[0].id);expect(events).toHaveLength(1);
  }finally{await context.close();}
});


test('contact form refuses null or HTML success responses and keeps its retry key until a real acknowledgement',async({browser})=>{
  const context=await browser.newContext({baseURL:'http://localhost:4173'}),page=await context.newPage();
  try{
    await page.goto('/contact');const form=page.locator('#contact-form');await form.getByLabel('Your name').fill('Synthetic malformed acknowledgement');await form.getByLabel('Company',{exact:true}).fill('Browser acknowledgement guard');
    await form.getByRole('textbox',{name:'Email',exact:true}).fill('ack-guard@example.test');await form.locator('#c-message').fill('Preserve this inquiry draft');
    let attempts=0,key:string|undefined;
    await page.route('**/site/inquiry',async route=>{
      const current=route.request().headers()['idempotency-key'];if(!key)key=current;else expect(current).toBe(key);attempts++;
      if(attempts===1)return route.fulfill({status:201,contentType:'application/json',body:'null'});
      if(attempts===2)return route.fulfill({status:200,contentType:'text/html',body:'<html>Proxy fallback</html>'});
      return route.continue();
    });
    for(let i=0;i<2;i++){
      await form.locator('#contact-submit').click();await expect(form.getByRole('alert')).toHaveText('Message delivery is unconfirmed. Retry this form on the same page.');
      await expect(form.locator('#contact-submit')).toBeEnabled();await expect(form.locator('#c-message')).toHaveValue('Preserve this inquiry draft');await expect(page.locator('#contact-done')).not.toBeVisible();
    }
    await form.locator('#contact-submit').click();await expect(page.locator('#contact-done')).toBeVisible();expect(attempts).toBe(3);
  }finally{await context.close();}
});


test('contact deadline releases a hanging committed send and retries with the same key',async({browser})=>{
  const context=await browser.newContext({baseURL:'http://localhost:4173'}),page=await context.newPage();let release:(()=>void)|undefined;
  try{
    await page.clock.install();await page.goto('/contact');const form=page.locator('#contact-form');
    await form.getByLabel('Your name').fill('Synthetic deadline contact');await form.getByLabel('Company',{exact:true}).fill('Browser inquiry deadline');
    await form.getByRole('textbox',{name:'Email',exact:true}).fill('deadline-inquiry@example.test');await form.locator('#c-message').fill('Original deadline inquiry');
    let attempts=0,key:string|undefined,committed!:()=>void;const saved=new Promise<void>(resolve=>{committed=resolve;});
    await page.route('**/site/inquiry',async route=>{
      attempts++;const current=route.request().headers()['idempotency-key'];
      if(attempts===1){key=current;const response=await route.fetch();expect(response.status()).toBe(201);committed();await new Promise<void>(resolve=>{release=resolve;});try{await route.abort('failed');}catch{}return;}
      expect(current).toBe(key);await route.continue();
    });
    await form.locator('#contact-submit').click();await saved;await expect(form.locator('#contact-submit')).toBeDisabled();
    await page.clock.fastForward(20001);
    await expect(form.getByRole('alert')).toHaveText('Message delivery is unconfirmed. Retry this form on the same page.');await expect(form.locator('#contact-submit')).toBeEnabled();
    release?.();await expect(form.locator('#c-message')).toHaveValue('Original deadline inquiry');
    const response=page.waitForResponse(r=>r.url().endsWith('/site/inquiry')&&r.request().method()==='POST');await form.locator('#contact-submit').click();const replay=await response;
    expect(replay.status()).toBe(201);expect(replay.headers()['idempotency-replayed']).toBe('true');await expect(page.locator('#contact-done')).toBeVisible();expect(attempts).toBe(2);
  }finally{release?.();await context.close();}
});
