/// <reference lib="dom" />
import {test,expect,type Page} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function open(page:Page,label:string){
 await page.goto('/?view=desktop');await page.locator('#login-username').fill('admin');await page.locator('#login-password').fill('admin123-test-only');await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page.locator('#app-screen')).toBeVisible();
 await page.evaluate(async label=>{const w=window as any;const rows=await w.API.get('/hr/periods');const p=rows.find((p:any)=>p.label===label);await w.App.navigate('hr-timekeeping',{period_id:p.id});},label);
 await page.locator('#tk-more-toggle').click();await page.getByRole('button',{name:'Reconcile payroll',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Payroll reconciliation',exact:true});await expect(dialog).toBeVisible();return dialog;
}
test.beforeAll(async({request})=>{
 const login=await(await request.post('/api/auth/login',{data:{username:'admin',password:'admin123-test-only'}})).json();
 expect((await request.post('/api/accounting/ledger/setup',{headers:{Authorization:`Bearer ${login.token}`},data:{fiscal_year_start:'2026-01-01'}})).status()).toBe(201);
});
test('real payroll comparison is read-only, accessible and matches after an explicit posting',async({page})=>{
 let writes=0;page.on('request',r=>{if(r.url().includes('/api/hr/')&&r.method()!=='GET')writes++;});
 const dialog=await open(page,'RECON-BROWSER-GOOD');await expect(dialog).toContainText('Payroll has not been posted');await expect(dialog).toContainText('1,000');await expect(dialog).toContainText('Bank payment, agency remittance and tax filing evidence are not linked');expect(writes).toBe(0);
 expect((await new AxeBuilder({page}).include('[role="dialog"]').analyze()).violations).toEqual([]);
 await page.screenshot({path:'work/payroll-reconcile-preview.png'});
 await dialog.getByRole('button',{name:'Close',exact:true}).click();await page.locator('#tk-post-gl').click();
 const post=page.getByRole('dialog',{name:'Post payroll to the General Ledger',exact:true});await post.getByRole('button',{name:'Post to GL',exact:true}).click();await expect(post).toBeHidden();
 await page.getByRole('button',{name:'Reconcile payroll',exact:true}).click();await expect(page.locator('#pr-content')).toContainText('Current payroll matches the journal');expect(writes).toBe(1);
});
test('duplicate payroll is visibly held and a real posting attempt preserves the ledger',async({page})=>{
 const dialog=await open(page,'RECON-BROWSER-DUP');await expect(dialog.getByRole('alert')).toContainText('More than one payslip');await expect(dialog).toContainText('Unavailable pending review');
 await dialog.getByRole('button',{name:'Close',exact:true}).click();await page.locator('#tk-post-gl').click();
 const post=page.getByRole('dialog',{name:'Post payroll to the General Ledger',exact:true});await post.getByRole('button',{name:'Post to GL',exact:true}).click();await expect(post.getByRole('alert')).toContainText('duplicate payslips');await expect(post).toBeVisible();
 const result=await page.evaluate(async()=>{const w=window as any;const p=(await w.API.get('/hr/periods')).find((p:any)=>p.label==='RECON-BROWSER-DUP');return w.API.get(`/hr/periods/${p.id}/payroll-reconciliation`);});expect(result.ledger.live_entry_count).toBe(0);
});
test('comparison failures are visible and an older response cannot replace a newer label',async({page})=>{
 let fail=true;
 await page.route('**/api/hr/periods/*/payroll-reconciliation?*',async route=>{if(fail){fail=false;await route.fulfill({status:503,json:{error:'Synthetic comparison unavailable'}});}else await route.continue();});
 const dialog=await open(page,'RECON-BROWSER-GOOD');await expect(dialog.getByRole('alert')).toContainText('Synthetic comparison unavailable');
 await dialog.getByRole('button',{name:'Refresh comparison',exact:true}).click();await expect(dialog).toContainText('Current payroll matches the journal');
 let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>{release=r;}),pending=new Promise<void>(r=>{started=r;});
 await page.route('**/payroll-reconciliation?payroll_period=RECON-LATE',async route=>{started();await gate;await route.fulfill({json:{issues:[],record_ids:[],issue_record_count:0,source:{record_count:999},ledger:{state:'matches',entries:[]},note:'LATE PRIVATE PAYROLL'}});});
 await dialog.locator('#pr-label').fill('RECON-LATE');await dialog.locator('#pr-label').dispatchEvent('change');await pending;
 await dialog.locator('#pr-label').fill('RECON-BROWSER-GOOD');await dialog.locator('#pr-label').dispatchEvent('change');await expect(dialog).toContainText('Current payroll matches the journal');
 const late=page.waitForResponse('**/payroll-reconciliation?payroll_period=RECON-LATE');release();await late;
 await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
 await expect(dialog).not.toContainText('LATE PRIVATE PAYROLL');await expect(dialog).not.toContainText('999');
});
