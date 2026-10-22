/// <reference lib="dom" />
import {test,expect,type Page} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import fs from 'node:fs';
const XLSX=new Function('module','require',fs.readFileSync('public/js/vendor/xlsx-style.min.js','utf8')+';return XLSX;')(undefined,undefined);
async function open(page:Page,number:string){
 await page.goto('/?view=desktop');await page.locator('#login-username').fill('admin');await page.locator('#login-password').fill('admin123-test-only');await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page.locator('#app-screen')).toBeVisible();
 await page.evaluate(number=>(window as any).App.navigate('form-records',{slug:'hr_payroll',q:number}),number);await expect(page.getByRole('button',{name:'Print payslip '+number,exact:true})).toBeVisible();
}
async function changeMoney(page:Page,number:string,net:number){
 await page.evaluate(async({number,net})=>{const api=(window as any).API,forms=await api.get('/form-definitions'),form=forms.find((f:any)=>f.slug==='hr_payroll'),rows=await api.get(`/form-definitions/${form.id}/records`),r=rows.find((r:any)=>r.number===number);await api.put(`/form-records/${r.id}`,{data:{...r.data,net_pay:net},expected_revision:r.revision});},{number,net});
}
test('row/header/selected print, summary and Excel hold duplicates outside the visible selection',async({page})=>{
 const number='REL-BROWSER-BLOCK-0';await open(page,number);let downloads=0;page.on('download',()=>downloads++);
 for(const action of [()=>page.getByRole('button',{name:'Print payslip '+number,exact:true}).click(),()=>page.locator('#fr-print-slips').click(),()=>page.locator('#fr-print-summary').click(),()=>page.locator('#fr-download-csv').click()]){
  const response=page.waitForResponse(r=>r.url().includes('/hr/payroll/copy?'));await action();expect((await response).status()).toBe(409);const hold=page.getByRole('dialog',{name:'Payroll review required',exact:true});await expect(hold).toContainText('duplicate payslips');await hold.getByRole('button',{name:'Close',exact:true}).click();
 }
 await page.locator('[data-row-check]').check();await page.locator('#fr-bulk-print').click();const hold=page.getByRole('dialog',{name:'Payroll review required',exact:true});await expect(hold).toContainText('duplicate payslips');expect(downloads).toBe(0);await expect(page.locator('#payslip-preview-frame')).toHaveCount(0);
});
test('Excel reloads saved values instead of the older visible list and contains the draft notice',async({page})=>{
 const number='COPY-BROWSER-DRAFT';await open(page,number);await changeMoney(page,number,1234);
 const download=page.waitForEvent('download');await page.locator('#fr-download-csv').click();const result=await download,file=await result.path();expect(file).toBeTruthy();expect(result.suggestedFilename()).toMatch(/\.xlsx$/);
 const wb=XLSX.read(fs.readFileSync(file!),{type:'buffer'}),cells=Object.values(wb.Sheets[wb.SheetNames[0]]) as any[];expect(cells.some(c=>typeof c?.v==='string'&&c.v.includes('DRAFT — NOT FINAL'))).toBe(true);expect(cells.some(c=>c?.v===1234)).toBe(true);expect(cells.some(c=>c?.f)).toBe(false);
});
test('draft preview is labeled, accessible and blocks printing after the saved source changes',async({page})=>{
 const number='COPY-BROWSER-STALE';await open(page,number);await page.getByRole('button',{name:'Print payslip '+number,exact:true}).click();const dialog=page.getByRole('dialog',{name:'Payslip Preview',exact:true});await expect(dialog).toContainText('DRAFT — NOT FINAL');await expect(page.frameLocator('#payslip-preview-frame').getByText('DRAFT — NOT FINAL',{exact:true}).first()).toBeVisible();
 const scan=await new AxeBuilder({page}).include('[role="dialog"]').analyze();fs.writeFileSync('work/payroll-copy-axe.json',JSON.stringify(scan,null,2)+'\n');expect(scan.violations).toEqual([]);
 for(const theme of ['light','dark'])for(const width of [1440,1024,768,390]){
  await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await page.setViewportSize({width,height:1000});await expect.poll(()=>page.locator('#payslip-preview-frame').evaluate((frame:any)=>[...frame.contentDocument.querySelectorAll('.tiled-cell-inner')].every((inner:any)=>inner.getBoundingClientRect().right<=inner.parentElement.getBoundingClientRect().right+1))).toBe(true);await expect(dialog.getByRole('button',{name:'Print…',exact:true})).toBeInViewport();await expect(dialog.getByRole('button',{name:'Close',exact:true})).toBeInViewport();await page.screenshot({path:`work/payroll-copy-${theme}-${width}.png`});
 }
 await page.setViewportSize({width:1440,height:1000});await page.evaluate(()=>document.documentElement.dataset.theme='light');await page.screenshot({path:'work/payroll-copy-draft.png'});
 await changeMoney(page,number,2222);let prints=0;await page.exposeFunction('copyPrinted',()=>prints++);await page.locator('#payslip-preview-frame').evaluate((frame:any)=>{frame.contentWindow.print=()=>{(window as any).copyPrinted();};});
 await dialog.getByRole('button',{name:'Print…',exact:true}).click();await expect(dialog.getByRole('alert')).toContainText('Saved payroll changed');await expect(dialog.getByRole('button',{name:'Print…',exact:true})).toBeDisabled();await expect(page.locator('#payslip-preview-frame')).toHaveAttribute('srcdoc','');expect(prints).toBe(0);await page.screenshot({path:'work/payroll-copy-stale.png'});await page.keyboard.press('Escape');await expect(dialog).toBeHidden();await expect(page.getByRole('button',{name:'Print payslip '+number,exact:true})).toBeFocused();
});
test('summary rechecks an unchanged Paid copy before calling the browser print action',async({page})=>{
 await open(page,'COPY-BROWSER-PAID');await page.locator('#fr-print-summary').click();const dialog=page.getByRole('dialog',{name:'Payroll Summary Preview',exact:true});await expect(dialog).toContainText('PAID RECORD COPY');await expect(page.frameLocator('#payroll-summary-frame').getByText('PAID RECORD COPY — payment evidence is separate.')).toBeVisible();
 let prints=0;await page.exposeFunction('copyPrinted',()=>prints++);await page.locator('#payroll-summary-frame').evaluate((frame:any)=>{frame.contentWindow.print=()=>{(window as any).copyPrinted();};});const response=page.waitForResponse(r=>r.url().includes('/hr/payroll/copy?')&&r.url().includes('&expected='));await dialog.getByRole('button',{name:'Print…',exact:true}).click();expect((await response).status()).toBe(200);await expect.poll(()=>prints).toBe(1);await expect(dialog.getByRole('button',{name:'Print…',exact:true})).toBeEnabled();
});
test('unsaved deduction changes stay open and cannot be issued by the detail Print action',async({page})=>{
 const number='COPY-BROWSER-EDIT';await open(page,number);await page.locator('tr[data-id]').click();const dialog=page.getByRole('dialog',{name:'Payslip — Synthetic Copy EDIT',exact:true});await dialog.locator('.pd-adjustments').evaluate(el=>el.setAttribute('open',''));await dialog.locator('#pd-change-reason').fill('Synthetic unsaved reason');let copies=0;page.on('request',r=>{if(r.url().includes('/hr/payroll/copy?'))copies++;});
 await dialog.locator('#pd-print').click();await expect(page.locator('.toast').filter({hasText:'Save Deductions before printing'})).toBeVisible();await expect(dialog).toBeVisible();await expect(dialog.locator('#pd-change-reason')).toHaveValue('Synthetic unsaved reason');expect(copies).toBe(0);
});
test('a delayed copy response cannot reopen private payroll after leaving the view',async({page})=>{
 await open(page,'COPY-BROWSER-CONTEXT');let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>{release=r;}),pending=new Promise<void>(r=>{started=r;});
 await page.route('**/hr/payroll/copy?*',async route=>{const response=await route.fetch();started();await gate;await route.fulfill({response});});
 await page.locator('#fr-print-summary').click();await pending;await page.evaluate(()=>(window as any).App.navigate('home'));await expect(page.locator('#fr-print-summary')).toHaveCount(0);const response=page.waitForResponse(r=>r.url().includes('/hr/payroll/copy?'));release();await response;await page.evaluate(()=>new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r()))));await expect(page.getByRole('dialog',{name:'Payroll Summary Preview',exact:true})).toHaveCount(0);
});

for(const kind of ['account','company'])test('print refuses a changed '+kind+' without sending a copy request',async({page})=>{
 await open(page,'COPY-BROWSER-PAID');await page.locator('#fr-print-summary').click();const dialog=page.getByRole('dialog',{name:'Payroll Summary Preview',exact:true});await expect(dialog).toContainText('PAID RECORD COPY');let reads=0;page.on('request',r=>{if(r.url().includes('/hr/payroll/copy?'))reads++;});
 await page.evaluate(kind=>{const w=window as any;if(kind==='account')w.App.setMe({id:99999,username:'synthetic-copy-other'});else w.VDS_BASE_PATH='/synthetic-other-company';},kind);await dialog.getByRole('button',{name:'Print…',exact:true}).click();await expect(dialog.getByRole('alert')).toContainText('changed');await expect(dialog.getByRole('button',{name:'Print…',exact:true})).toBeDisabled();expect(reads).toBe(0);
});
test('cutoff bundle print uses saved record identities and the same guarded preview',async({page})=>{
 await open(page,'COPY-BROWSER-PAID');await page.evaluate(()=>(window as any).App.navigate('form-records',{slug:'hr_payroll'}));await page.locator('[data-bundle-print="COPY-BROWSER-PAID"]').click();const dialog=page.getByRole('dialog',{name:'Payslip Preview',exact:true});await expect(dialog).toContainText('PAID RECORD COPY');await expect(page.frameLocator('#payslip-preview-frame').getByText('PAID RECORD COPY — payment evidence is separate.',{exact:true}).first()).toBeVisible();
});
