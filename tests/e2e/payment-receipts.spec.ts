import {test,expect} from '@playwright/test';

test('payment form retries a committed report after response loss using its original key and proof',async({page})=>{
  await page.setExtraHTTPHeaders({'X-Tenant':'browser-payment'});await page.goto('/');
  await page.locator('#login-username').fill('owner');await page.locator('#login-password').fill('Synthetic payment browser password');
  await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page.locator('#app-screen')).toBeVisible();
  await page.evaluate(()=>(window as any).App.navigate('billing'));
  const row=page.locator('tr[data-open]').filter({hasText:'Browser lost-response invoice'});await row.getByRole('button',{name:'Report payment',exact:true}).click();
  const modal=page.locator('.modal-overlay');await modal.locator('[data-f="reference_no"]').fill('Synthetic browser reference');
  await modal.locator('[data-f="amount"]').fill('100');await modal.locator('[data-f="proof"]').setInputFiles({name:'proof.png',mimeType:'image/png',buffer:Buffer.from('synthetic proof')});
  let lost=false,key:string|undefined,id:number|undefined;
  await page.route('**/api/tenant/billing/invoices/*/payments',async route=>{
    const requestKey=route.request().headers()['idempotency-key'];
    if(!lost){key=requestKey;const committed=await route.fetch();expect(committed.status()).toBe(201);id=(await committed.json()).id;lost=true;await route.abort('failed');}
    else{expect(requestKey).toBe(key);await route.continue();}
  });
  await modal.getByRole('button',{name:'Send for verification'}).click();
  await expect(modal.locator('[data-modal-error]')).toContainText('Report outcome is unconfirmed');
  await expect(modal.locator('[data-f="reference_no"]')).toBeDisabled();await expect(modal.locator('[data-f="proof"]')).toBeDisabled();
  await expect(modal.getByRole('button',{name:'Send for verification'})).toBeEnabled();expect(key).toMatch(/^[a-f0-9-]{36}$/);
  const response=page.waitForResponse(r=>r.url().endsWith('/payments')&&r.request().method()==='POST');
  await modal.getByRole('button',{name:'Send for verification'}).click();const replay=await response;
  expect(replay.status()).toBe(201);expect(replay.headers()['idempotency-replayed']).toBe('true');await expect(modal).toHaveCount(0);
  await expect(row).toContainText('Being verified');
  const billing=await page.request.get('/api/tenant/billing',{headers:{'X-Tenant':'browser-payment'}});expect(billing.status()).toBe(200);
  const invoice=(await billing.json()).invoices.find((i:{id:number})=>i.id===id);expect(invoice.payments).toHaveLength(1);expect(invoice.payments[0].reference_no).toBe('Synthetic browser reference');
});
