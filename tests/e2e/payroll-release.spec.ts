/// <reference lib="dom" />
import {test,expect,type Page} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
async function login(page:Page,username='admin',password='admin123-test-only'){
 await page.goto('/?view=desktop');await page.locator('#login-username').fill(username);await page.locator('#login-password').fill(password);await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page.locator('#app-screen')).toBeVisible();
}
async function open(page:Page,number:string){await login(page);await page.evaluate(number=>(window as any).App.navigate('form-records',{slug:'hr_payroll',q:number}),number);await expect(page.getByRole('button',{name:'Mark payslip '+number+' as paid',exact:true})).toBeVisible();}
test('a source conflict blocks marking paid and preserves its draft state',async({page})=>{
 const number='REL-BROWSER-BLOCK-0';await open(page,number);const button=page.getByRole('button',{name:'Mark payslip '+number+' as paid',exact:true});const response=page.waitForResponse(r=>r.url().endsWith('/mark-paid')&&r.request().method()==='POST');await button.click();expect((await response).status()).toBe(409);const dialog=page.getByRole('dialog',{name:'Payroll review required'});await expect(dialog.getByRole('alert')).toContainText('Payroll source needs review');await expect(page.getByRole('button',{name:'Email payslip '+number,exact:true})).toBeDisabled();expect((await new AxeBuilder({page}).include('[role="dialog"]').analyze()).violations).toEqual([]);await page.screenshot({path:'work/payroll-release-hold.png'});await dialog.getByRole('button',{name:'Close',exact:true}).click();await expect(dialog).toBeHidden();await expect(button).toBeVisible();
});
test('a valid draft cannot be emailed and valid payment enables the email action',async({page})=>{
 const number='REL-BROWSER-GOOD-0';await open(page,number);await expect(page.getByRole('button',{name:'Email payslip '+number,exact:true})).toBeDisabled();
 await page.getByRole('button',{name:'Mark payslip '+number+' as paid',exact:true}).click();await expect(page.getByRole('button',{name:'Unmark payslip '+number+' as paid',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Email payslip '+number,exact:true})).toBeEnabled();
});
test('an employee cannot retrieve previously paid duplicate records by list or guessed PDF/timekeeping URL',async({page,playwright})=>{
 const setup=await playwright.request.newContext({baseURL:'http://127.0.0.1:4173'});let ids:number[]=[];
 try{const a=await(await setup.post('/api/auth/login',{data:{username:'admin',password:'admin123-test-only'}})).json(),headers={Authorization:`Bearer ${a.token}`};const forms=await(await setup.get('/api/form-definitions',{headers})).json(),form=forms.find((x:any)=>x.slug==='hr_payroll'),rows=await(await setup.get(`/api/form-definitions/${form.id}/records`,{headers})).json();ids=rows.filter((x:any)=>x.number.startsWith('REL-BROWSER-BLOCK-')).map((x:any)=>x.id);}finally{await setup.dispose();}
 expect(ids).toHaveLength(2);await login(page,'release-browser','Synthetic release browser password');
 const result=await page.evaluate(async ids=>{const rows=await(window as any).API.get('/me/payslips'),statuses=[];for(const id of ids)for(const suffix of ['pdf','timekeeping'])statuses.push((await fetch(`/api/me/payslips/${id}/${suffix}`)).status);return {ids:rows.map((x:any)=>x.id),statuses};},ids);
 expect(result.ids.filter((id:number)=>ids.includes(id))).toEqual([]);expect(result.statuses).toEqual([404,404,404,404]);
});
