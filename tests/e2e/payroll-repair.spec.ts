/// <reference lib="dom" />
import {test,expect,type Page} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
async function open(page:Page,number:string){
 await page.goto('/?view=desktop');await page.locator('#login-username').fill('admin');await page.locator('#login-password').fill('admin123-test-only');await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page.locator('#app-screen')).toBeVisible();
 // Search the target explicitly; other fixtures now create collapsible cutoff bundles.
 await page.evaluate(number=>(window as any).App.navigate('form-records',{slug:'hr_payroll',q:number}),number);
 const button=page.getByRole('button',{name:'Review owner of payslip '+number,exact:true});await button.click();
 const dialog=page.getByRole('dialog',{name:'Review payslip owner',exact:true});await expect(dialog).toBeVisible();return dialog;
}
async function review(page:Page,number:string){
 const dialog=await open(page,number);await dialog.locator('#pri-search').fill('DISC-BROWSER-0');await dialog.getByRole('button',{name:'Find employee',exact:true}).click();
 await expect(dialog.locator('#pri-employee option')).toHaveCount(2);await dialog.locator('#pri-employee').selectOption({index:1});
 await dialog.locator('#pri-reason').fill('Verified the original employment records');await dialog.locator('#pri-reference').fill('CASE-BROWSER-TEST');await dialog.locator('#pri-verified').check();
 await dialog.getByRole('button',{name:'Review correction',exact:true}).click();await expect(dialog.getByRole('button',{name:'Confirm identity repair',exact:true})).toBeVisible();return dialog;
}
test('reviewed repair preserves paid state and grants the identified employee access',async({page,playwright})=>{
 const dialog=await review(page,'REPAIR-BROWSER');await expect(dialog).toContainText('Synthetic Payroll New');await expect(dialog).toContainText('payslip-original');await expect(dialog).toContainText('Paid status, amounts and payment timestamps will be preserved');
 expect((await new AxeBuilder({page}).include('[role="dialog"]').analyze()).violations).toEqual([]);
 await page.screenshot({path:'work/payroll-repair-review.png'});
 await dialog.getByRole('button',{name:'Confirm identity repair',exact:true}).click();await expect(dialog).toBeHidden();
 const row=page.locator('tr').filter({hasText:'REPAIR-BROWSER'});await expect(row).toContainText('paid');
 const request=await playwright.request.newContext({baseURL:'http://127.0.0.1:4173'});
 try{const login=await(await request.post('/api/auth/login',{data:{username:'payslip-original',password:'payslip-browser-test-only'}})).json();const rows=await(await request.get('/api/me/payslips',{headers:{Authorization:`Bearer ${login.token}`}})).json();const repaired=rows.find((r:any)=>r.number==='REPAIR-BROWSER');expect(repaired.finalized).toBe(true);expect((await request.get(`/api/me/payslips/${repaired.id}/pdf`,{headers:{Authorization:`Bearer ${login.token}`}})).status()).toBe(200);}finally{await request.dispose();}
});
test('cancelling a reviewed repair sends no confirmation',async({page})=>{
 let confirms=0;page.on('request',r=>{if(r.url().endsWith('/identity/confirm'))confirms++;});const dialog=await review(page,'REPAIR-CANCEL');page.once('dialog',dialog=>dialog.accept());await dialog.getByRole('button',{name:'Cancel',exact:true}).click();await expect(dialog).toBeHidden();expect(confirms).toBe(0);
});
test('stale payroll state is refused and shows an accessible error in the review',async({page})=>{
 const dialog=await review(page,'REPAIR-STALE');
 await page.evaluate(async()=>{const api=(window as any).API;const forms=await api.get('/form-definitions');const form=forms.find((r:any)=>r.slug==='hr_payroll');const records=await api.get(`/form-definitions/${form.id}/records`);const record=records.find((r:any)=>r.number==='REPAIR-STALE');await api.post(`/hr/payroll/${record.id}/unmark-paid`,{});});
 await dialog.getByRole('button',{name:'Confirm identity repair',exact:true}).click();await expect(dialog.getByRole('alert')).toContainText('changed');await expect(dialog).toBeVisible();
});
