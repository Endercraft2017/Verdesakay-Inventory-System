import { test, expect } from '@playwright/test';

test('website inquiry retains its draft after durable enqueue fails and saves one source/alert after correction',async({browser})=>{
  const context=await browser.newContext({baseURL:'http://localhost:4173'});const page=await context.newPage();
  try{
    await page.goto('/contact');const form=page.locator('#contact-form');
    await form.getByLabel('Your name').fill('Synthetic browser contact');await form.getByLabel('Company',{exact:true}).fill('Browser inquiry failure');
    await form.getByRole('textbox',{name:'Email',exact:true}).fill('inquiry-browser@example.test');await form.locator('#c-message').fill('Synthetic private browser draft');
    const failed=page.waitForResponse(r=>r.url().endsWith('/site/inquiry')&&r.request().method()==='POST');
    await form.locator('#contact-submit').click();const response=await failed;expect(response.status()).toBe(500);
    expect(await response.json()).toEqual({error:'Internal server error',request_id:response.headers()['x-request-id']});
    await expect(form.getByRole('alert')).toHaveText('Internal server error');await expect(form.locator('#c-message')).toHaveValue('Synthetic private browser draft');
    await expect(form.locator('#contact-submit')).toBeEnabled();await form.locator('#c-company').fill('Browser inquiry corrected');
    const succeeded=page.waitForResponse(r=>r.url().endsWith('/site/inquiry')&&r.request().method()==='POST');await form.locator('#contact-submit').click();
    expect((await succeeded).status()).toBe(201);await expect(page.locator('#contact-done')).toBeVisible();
    const login=await context.request.post('/_platform/api/login',{headers:{'X-Requested-With':'VDS','X-Session-Mode':'cookie'},data:{username:'browser-operator',password:'Synthetic browser operator password'}});expect(login.status()).toBe(200);
    const records=await context.request.get('/_platform/api/inquiries');expect(records.status()).toBe(200);
    const rows=(await records.json()).inquiries.filter((r:{email:string})=>r.email==='inquiry-browser@example.test');
    expect(rows).toHaveLength(1);expect(rows[0].company).toBe('Browser inquiry corrected');
    const status=await context.request.get('/_platform/api/mail');const outbox=(await status.json()).outbox.filter((r:{kind:string;source_id:number})=>r.kind==='inquiry'&&r.source_id===rows[0].id);
    expect(outbox).toHaveLength(1);expect(outbox[0].state).toBe('pending');expect(outbox[0].body).toBeUndefined();
    await page.goto('/_platform/');await expect(page.locator('#app')).toBeVisible();await page.locator('#mail-btn').click();
    await expect(page.locator('#m-outbox')).toContainText('Website inquiry #'+rows[0].id);
    await expect(page.locator('#m-outbox')).not.toContainText('Synthetic private browser draft');
  }finally{await context.close();}
});
