/// <reference lib="dom" />
import {test,expect,type Page} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
async function open(page:Page,number:string){
 await page.goto('/?view=desktop');await page.locator('#login-username').fill('admin');await page.locator('#login-password').fill('admin123-test-only');await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page.locator('#app-screen')).toBeVisible();
 await page.evaluate(number=>(window as any).App.navigate('form-records',{slug:'hr_payroll',q:number}),number);
 await page.getByRole('button',{name:'Recover cutoff of payslip '+number,exact:true}).click();const dialog=page.getByRole('dialog',{name:'Recover payslip cutoff',exact:true});await expect(dialog).toBeVisible();return dialog;
}
async function review(page:Page,number:string){
 const dialog=await open(page,number);await expect(dialog.locator('#pcr-cutoff')).toHaveValue('');await dialog.locator('#pcr-cutoff').selectOption({index:1});
 await dialog.locator('#pcr-reason').fill('Verified original attendance and payroll records');await dialog.locator('#pcr-reference').fill('CASE-BROWSER-CUTOFF');await dialog.locator('#pcr-verified').check();await dialog.getByRole('button',{name:'Review cutoff recovery',exact:true}).click();await expect(dialog.getByRole('button',{name:'Confirm cutoff recovery',exact:true})).toBeVisible();return dialog;
}
async function record(page:Page,number:string){return page.evaluate(async number=>{const api=(window as any).API,forms=await api.get('/form-definitions'),form=forms.find((r:any)=>r.slug==='hr_payroll'),rows=await api.get(`/form-definitions/${form.id}/records`);return rows.find((r:any)=>r.number===number);},number);}
test('reviews the authoritative cutoff, preserves original money and creates attributed correction history',async({page})=>{
 const dialog=await review(page,'CUTOFF-BROWSER'),before=await record(page,'CUTOFF-BROWSER');expect(before.data.cutoff_id).toBe('broken');await expect(dialog).toContainText('Synthetic Cutoff Browser');await expect(dialog).toContainText('Amounts, pay date, recorded labels and calculation history stay unchanged');
 expect((await new AxeBuilder({page}).include('[role="dialog"]').analyze()).violations).toEqual([]);await page.screenshot({path:'work/payroll-cutoff-review.png'});
 await dialog.getByRole('button',{name:'Confirm cutoff recovery',exact:true}).click();await expect(dialog).toBeHidden();
 const after=await record(page,'CUTOFF-BROWSER');expect(typeof after.data.cutoff_id).toBe('number');expect(after.data).toEqual({...before.data,cutoff_id:after.data.cutoff_id});expect(after.revision).toBe(before.revision+1);expect(after.status).toBe('draft');expect(after.updated_at).toBe(before.updated_at);
 const history=await page.evaluate(async id=>await(window as any).API.get(`/form-records/${id}/revisions`),after.id);expect(history[0]).toMatchObject({source:'payroll-cutoff-recovery'});expect(JSON.parse(history[0].reason).evidence_reference).toBe('CASE-BROWSER-CUTOFF');
});
test('cancelling review sends no correction and retains the original stamp',async({page})=>{
 let confirms=0;page.on('request',r=>{if(r.url().endsWith('/cutoff-recovery/confirm'))confirms++;});const dialog=await review(page,'CUTOFF-CANCEL');page.once('dialog',d=>d.accept());await dialog.getByRole('button',{name:'Cancel',exact:true}).click();await expect(dialog).toBeHidden();expect(confirms).toBe(0);expect((await record(page,'CUTOFF-CANCEL')).data.cutoff_id).toBe('broken');
});
test('a changed payroll record is refused with an accessible error at confirmation',async({page})=>{
 const dialog=await review(page,'CUTOFF-STALE'),before=await record(page,'CUTOFF-STALE');await page.evaluate(async record=>{await(window as any).API.put(`/form-records/${record.id}`,{data:{...record.data,net_pay:900},expected_revision:record.revision});},before);
 await dialog.getByRole('button',{name:'Confirm cutoff recovery',exact:true}).click();await expect(dialog.getByRole('alert')).toContainText('changed');expect((await record(page,'CUTOFF-STALE')).data.cutoff_id).toBe('broken');await expect(dialog).toBeVisible();
});
test('leaving the payroll view discards its reviewed correction without submitting',async({page})=>{
 const dialog=await review(page,'CUTOFF-CONTEXT');let confirms=0;page.on('request',r=>{if(r.url().endsWith('/cutoff-recovery/confirm'))confirms++;});
 page.once('dialog',d=>d.accept());
 await page.evaluate(()=>(window as any).App.navigate('home'));await expect(page.getByRole('button',{name:'Recover cutoff of payslip CUTOFF-CONTEXT',exact:true})).toHaveCount(0);
 await expect(dialog).toBeHidden();
 expect(confirms).toBe(0);
});
for(const kind of ['account','company'])test('a changed '+kind+' prevents submitting the reviewed correction',async({page})=>{
 const dialog=await review(page,'CUTOFF-CONTEXT');let confirms=0;page.on('request',r=>{if(r.url().endsWith('/cutoff-recovery/confirm'))confirms++;});
 await page.evaluate(kind=>{const w=window as any;if(kind==='account')w.App.setMe({id:99999,username:'synthetic-other-operator'});else w.VDS_BASE_PATH='/different-company';},kind);
 await dialog.getByRole('button',{name:'Confirm cutoff recovery',exact:true}).click();await expect(dialog.getByRole('alert')).toContainText('changed');expect(confirms).toBe(0);
});
