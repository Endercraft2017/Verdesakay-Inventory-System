/// <reference lib="dom" />
import {test,expect} from '@playwright/test';
test('accounting browser receives bounded tax identity and renders the seeded certificate',async({page,playwright})=>{
 const setup=await playwright.request.newContext({baseURL:'http://127.0.0.1:4173'});
 const admin=await (await setup.post('/api/auth/login',{data:{username:'admin',password:'admin123-test-only'}})).json();
 const employees=await (await setup.get('/api/hr/employees',{headers:{Authorization:`Bearer ${admin.token}`}})).json();
 const employeeId=employees.find((e:any)=>e.employee_no==='TAX-PRIVACY-BROWSER').id;
 await setup.dispose();
 await page.goto('/?view=desktop');
 await page.locator('#login-username').fill('tax-privacy-accountant');
 await page.locator('#login-password').fill('tax-privacy-browser-test-only');
 await page.getByRole('button',{name:'Sign in',exact:true}).click();
 await expect(page.locator('#app-screen')).toBeVisible();
 const result=await page.evaluate(async(id)=>{
  const api=(window as any).API;
  const detail=await api.get(`/accounting/bir-2316/${id}?year=2025`);
  const template=await api.get('/templates/defaults/bir_2316');
  const html=(window as any).renderTemplate(template.body,{employee:detail.employee,company:detail.company,year:detail.year,f:{}});
  const hrStatus=(await fetch('/api/hr/employees')).status;
  return {detail,html,hrStatus};
 },employeeId);
 expect(result.hrStatus).toBe(403);
 expect(Object.keys(result.detail.employee).sort()).toEqual(['id','employee_no','name','position','tin_no','birth_date','birth_date_mdy','sss_no','philhealth_no','pagibig_no','department_name'].sort());
 expect(result.html).toContain('Synthetic Browser Tax Employee');expect(result.html).toContain('SYNTHETIC-TAX-TIN');expect(result.html).toContain('03/07/1991');
 expect(JSON.stringify(result.detail)).not.toContain('private-browser-photo.jpg');
});
