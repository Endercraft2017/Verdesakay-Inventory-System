/// <reference lib="dom" />
import {test,expect} from '@playwright/test';
for(const kind of ['original','reused'])test(`payslip ${kind} employee cannot retrieve ambiguous legacy pay`,async({page,playwright})=>{
 const setup=await playwright.request.newContext({baseURL:'http://127.0.0.1:4173'});
 const admin=await(await setup.post('/api/auth/login',{data:{username:'admin',password:'admin123-test-only'}})).json();
 const defs=await(await setup.get('/api/form-definitions',{headers:{Authorization:`Bearer ${admin.token}`}})).json();
 const form=defs.find((r:any)=>r.slug==='hr_payroll');
 const records=await(await setup.get(`/api/form-definitions/${form.id}/records`,{headers:{Authorization:`Bearer ${admin.token}`}})).json();
 const legacy=records.find((r:any)=>r.number==='DISC-BROWSER-LEGACY').id;
 const stamped=records.find((r:any)=>r.number==='DISC-BROWSER-STAMP').id;
 const textStamp=records.find((r:any)=>r.number==='DISC-BROWSER-TEXT').id;await setup.dispose();
 await page.goto('/?view=desktop');await page.locator('#login-username').fill('payslip-'+kind);await page.locator('#login-password').fill('payslip-browser-test-only');await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page.locator('#app-screen')).toBeVisible();
 const result=await page.evaluate(async({legacy,stamped,textStamp})=>{
  const api=(window as any).API;
  const list=await api.get('/me/payslips');
  const statuses=[];for(const suffix of ['pdf','timekeeping'])statuses.push((await fetch(`/api/me/payslips/${legacy}/${suffix}`)).status);
  const textStatus=(await fetch(`/api/me/payslips/${textStamp}/pdf`)).status;
  return {textStatus,ids:list.map((r:any)=>r.id),statuses,stampedStatus:(await fetch(`/api/me/payslips/${stamped}/pdf`)).status};
 },{legacy,stamped,textStamp});
 expect(result.textStatus).toBe(kind==='original'?200:404);expect(result.ids).not.toContain(legacy);expect(result.statuses).toEqual([404,404]);expect(result.stampedStatus).toBe(kind==='original'?200:404);
 if(kind==='original')expect(result.ids).toContain(stamped);else expect(result.ids).not.toContain(stamped);
});
