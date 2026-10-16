import { test,expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { stepUpPassword,stepUpSessionToken,stepUpRecoveryCode,stepUpCookie } from './step-up-fixture';

test('stale admin changes require accessible password + factor confirmation and preserve cancelled work',async({page})=>{
  await page.context().addCookies([{name:stepUpCookie,value:stepUpSessionToken,domain:'127.0.0.1',path:'/',httpOnly:true,secure:false,sameSite:'Strict'}]);
  await page.addInitScript(()=>localStorage.setItem('vds_browser_session','1'));
  await page.setViewportSize({width:390,height:844});await page.goto('/?view=desktop');
  await expect(page.getByRole('button',{name:'My Account',exact:true})).toBeVisible();
  const body={username:'stepup.created',full_name:'Verified browser creation',password:'Synthetic new account passphrase',role:'warehouse'};
  function create(){return page.evaluate(async(data)=>{try{return {result:await (window as any).API.post('/users',data)};}catch(error){return {error:(error as Error).message};}},body);}
  const cancelled=create();const dialog=page.getByRole('dialog',{name:'Confirm account change'});await expect(dialog).toBeVisible();
  await expect(page.getByLabel('Current password',{exact:true})).toBeFocused();
  const bounds=await dialog.boundingBox();expect(bounds!.x).toBeGreaterThanOrEqual(0);expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(390);
  for (const name of ['Verify and continue','Cancel']) expect((await page.getByRole('button',{name,exact:true}).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  const scan=await new AxeBuilder({page}).include('dialog').withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze();expect(scan.violations).toEqual([]);
  await page.screenshot({path:'work/step-up-dialog.png'});
  await page.keyboard.press('Escape');expect((await cancelled).error).toContain('cancelled');
  const users=await (await page.request.get('/api/users')).json();expect(users.some((u:any)=>u.username===body.username)).toBe(false);
  const confirmed=create();await expect(dialog).toBeVisible();
  await page.getByLabel('Current password',{exact:true}).fill('wrong password');
  await page.getByLabel('Authenticator or one-use recovery code').fill(stepUpRecoveryCode);
  await page.getByRole('button',{name:'Verify and continue'}).click();await expect(dialog.getByRole('alert')).toContainText('incorrect');
  await page.getByLabel('Current password',{exact:true}).fill(stepUpPassword);
  await page.getByLabel('Authenticator or one-use recovery code').fill(stepUpRecoveryCode);
  await page.getByRole('button',{name:'Verify and continue'}).click();
  const result=await confirmed;expect(result.error).toBeUndefined();expect(result.result.id).toBeTruthy();await expect(dialog).not.toBeVisible();
  const replay=await page.request.post('/api/auth/step-up',{headers:{'X-Requested-With':'VDS','X-Session-Mode':'cookie'},data:{password:stepUpPassword,code:stepUpRecoveryCode}});
  expect(replay.status()).toBe(403);
});
