import {test,expect} from '@playwright/test';
import {manualPassword,manualToken} from './manual-export-fixture';
import {stepUpCookie} from './step-up-fixture';
test('manual export shows financial context, cancels safely, reauthenticates and then exports',async({page})=>{
 await page.context().addCookies([{name:stepUpCookie,value:manualToken,domain:'127.0.0.1',path:'/',httpOnly:true,secure:false,sameSite:'Strict'}]);await page.addInitScript(()=>localStorage.setItem('vds_browser_session','1'));
 await page.goto('/?view=desktop');await expect(page.getByRole('button',{name:'My Account',exact:true})).toBeVisible();await page.evaluate(()=>(window as any).App.navigate('orders',{type:'sale'}));
 const row=page.locator('tr').filter({hasText:'MANUAL-E2E-GUARDED'});const button=row.locator('[data-qbpush]');await expect(button).toBeVisible();const id=await button.getAttribute('data-qbpush');let posts=0;page.on('request',r=>{if(r.url().includes('/quickbooks/push/order/')&&r.method()==='POST')posts++;});
 await button.click();const confirmation=page.getByRole('dialog',{name:'Please confirm'});await expect(confirmation).toContainText('MANUAL-E2E-GUARDED');await expect(confirmation).toContainText('Test Co (QBO)');await expect(confirmation).toContainText('100.00');await confirmation.getByRole('button',{name:'Close dialog'}).click();await expect(button).toBeEnabled();expect(posts).toBe(0);
 await button.click();await confirmation.getByRole('button',{name:'Export to QuickBooks',exact:true}).click();const proof=page.getByRole('dialog',{name:'Confirm account change'});await expect(proof).toBeVisible();await page.keyboard.press('Escape');await expect(button).toBeEnabled();
 const before=await page.request.get('/api/quickbooks/order/'+id+'/link');expect(await before.json()).toBeNull();
 await button.click();await confirmation.getByRole('button',{name:'Export to QuickBooks',exact:true}).click();await expect(proof).toBeVisible();await proof.getByLabel('Current password',{exact:true}).fill(manualPassword);await proof.getByRole('button',{name:'Verify and continue'}).click();await expect(proof).not.toBeVisible();await expect(button).toBeEnabled();
 const after=await page.request.get('/api/quickbooks/order/'+id+'/link');expect((await after.json()).qbo_type).toBe('Invoice');await page.screenshot({path:'work/manual-export-confirmed.png'});
});

test('stale displayed destination is rejected without exporting into the current connection',async({page})=>{
 await page.goto('/');await page.locator('#login-username').fill('admin');await page.locator('#login-password').fill('admin123-test-only');await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page.locator('#app-screen')).toBeVisible();
 const stale='55555555-5555-4555-8555-555555555555';
 await page.route('**/api/quickbooks/order/*/preview',async route=>{const response=await route.fetch(),body=await response.json();await route.fulfill({response,json:{...body,connection_id:stale,company_name:'Previously reviewed company'}});});
 await page.evaluate(()=>(window as any).App.navigate('orders',{type:'sale'}));const row=page.locator('tr').filter({hasText:'MANUAL-E2E-GUARDED'}),button=row.locator('[data-qbpush]');await expect(button).toBeVisible();const id=await button.getAttribute('data-qbpush');const before=await (await page.request.get('/api/quickbooks/order/'+id+'/link')).json();
 await button.click();const dialog=page.getByRole('dialog',{name:'Please confirm'});await expect(dialog).toContainText('Previously reviewed company');const rejected=page.waitForResponse(r=>r.url().includes('/quickbooks/push/order/')&&r.request().method()==='POST');await dialog.getByRole('button',{name:'Export to QuickBooks',exact:true}).click();const response=await rejected;expect(response.status()).toBe(409);expect(response.request().postDataJSON()).toMatchObject({connection_id:stale});await expect(button).toBeEnabled();expect(await (await page.request.get('/api/quickbooks/order/'+id+'/link')).json()).toEqual(before);
});

for(const changed of ['account','company','view'])test('confirmation refuses a changed '+changed+' before sending',async({page})=>{
 await page.goto('/');await page.locator('#login-username').fill('admin');await page.locator('#login-password').fill('admin123-test-only');await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page.locator('#app-screen')).toBeVisible();await page.evaluate(()=>(window as any).App.navigate('orders',{type:'sale'}));
 const button=page.locator('tr').filter({hasText:'MANUAL-E2E-GUARDED'}).locator('[data-qbpush]');await expect(button).toBeVisible();let posts=0;page.on('request',r=>{if(r.url().includes('/quickbooks/push/order/')&&r.method()==='POST')posts++;});await button.click();const dialog=page.getByRole('dialog',{name:'Please confirm'});await expect(dialog).toBeVisible();
 await page.evaluate(async kind=>{const w=window as any;if(kind==='account')w.App.setMe({id:99999,username:'synthetic-other-actor'});if(kind==='company')w.VDS_BASE_PATH='/different-company';if(kind==='view')await w.App.navigate('inventory');},changed);
 if(changed==='view'){await expect(dialog).not.toBeVisible();expect(posts).toBe(0);return;}
 await dialog.getByRole('button',{name:'Export to QuickBooks',exact:true}).click();await expect(page.getByText('Sign-in, company or order view changed. Review the export again.',{exact:true})).toBeVisible();expect(posts).toBe(0);
});
