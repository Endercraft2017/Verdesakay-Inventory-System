# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: payroll-repair.spec.ts >> stale payroll state is refused and shows an accessible error in the review
- Location: tests/e2e/payroll-repair.spec.ts:28:1

# Error details

```
Test timeout of 30000ms exceeded.
```

```
Error: locator.click: Test timeout of 30000ms exceeded.
Call log:
  - waiting for getByRole('button', { name: 'Review owner of payslip REPAIR-STALE', exact: true })

```

# Page snapshot

```yaml
- generic [ref=e2]:
  - generic [ref=e3]:
    - searchbox "Search Menu" [ref=e8]
    - button "Site Map" [ref=e9] [cursor=pointer]
    - button "Pinned" [ref=e10] [cursor=pointer]
  - banner [ref=e14]:
    - generic [ref=e15]:
      - generic [ref=e16]: O
      - generic [ref=e17]:
        - text: Workspace
        - generic [ref=e18]: Otom
    - navigation [ref=e19]:
      - button "Home" [ref=e20] [cursor=pointer]
      - button "Support" [ref=e27] [cursor=pointer]
      - button "Inventory" [ref=e32] [cursor=pointer]
      - button "Production" [ref=e37] [cursor=pointer]
      - button "Documents" [ref=e41] [cursor=pointer]
      - button "HR" [ref=e46] [cursor=pointer]
      - button "Accounting" [ref=e53] [cursor=pointer]
      - button "Admin" [ref=e57] [cursor=pointer]
    - button "My Account" [ref=e64] [cursor=pointer]:
      - generic [ref=e65]:
        - generic [ref=e66]: System Administrator
        - generic [ref=e67]: Administrator · Administration
      - generic [ref=e68]: SA
  - navigation [ref=e69]:
    - button "Files" [ref=e70] [cursor=pointer]
    - button "Data Forms" [ref=e71] [cursor=pointer]
    - button "Templates" [ref=e72] [cursor=pointer]
  - generic [ref=e73]:
    - complementary [ref=e74]:
      - generic [ref=e75]:
        - generic [ref=e76]: Data Forms
        - button "All Forms" [ref=e77] [cursor=pointer]
    - main [ref=e81]:
      - generic [ref=e82]:
        - button "All Forms" [ref=e83] [cursor=pointer]
        - generic [ref=e86]:
          - heading "HR Payroll" [level=2] [ref=e87]
          - generic [ref=e88]: Payslips grouped by cutoff — open one to see how its pay was computed.
        - button "Import & cleanup" [ref=e89] [cursor=pointer]
        - button "New Record" [ref=e93] [cursor=pointer]
        - button "Guide" [ref=e95] [cursor=pointer]
      - generic [ref=e99]:
        - generic [ref=e100]:
          - generic [ref=e101]: Search payslips by employee name
          - searchbox "Search payslips by employee name" [ref=e102]
        - generic [ref=e103]:
          - generic [ref=e104]: Status
          - combobox "Status" [ref=e105]:
            - option "All statuses" [selected]
            - option "pending"
            - option "draft"
            - option "submitted"
            - option "approved"
            - option "rejected"
            - option "completed"
            - option "paid"
        - generic [ref=e106]:
          - generic [ref=e107]: Period
          - textbox "Period" [ref=e109]:
            - /placeholder: Type a period…
            - text: All periods
        - group "Print and export the payslips in view" [ref=e110]:
          - button "Print visible" [ref=e111] [cursor=pointer]
          - button "Print Summary" [ref=e116] [cursor=pointer]
          - button "Download Excel" [ref=e121] [cursor=pointer]
      - generic [ref=e125]:
        - button "Choose columns" [ref=e126] [cursor=pointer]
        - generic [ref=e127]: Saved view
        - combobox "Saved view" [ref=e128]:
          - option "Current filters" [selected]
        - button "Save current filters" [ref=e129] [cursor=pointer]
        - button "Remove saved view" [disabled] [ref=e130]
        - status
      - generic [ref=e132]:
        - generic [ref=e133]:
          - generic [ref=e134] [cursor=pointer]:
            - button "RECON-BROWSER-DUP 2024-06-01 – 2024-06-15 · 2 payslips" [expanded] [ref=e135]:
              - generic [aria-hidden] [ref=e136]: ▾
              - generic [ref=e137]:
                - strong [ref=e138]: RECON-BROWSER-DUP
                - generic [ref=e139]: 2024-06-01 – 2024-06-15 · 2 payslips
            - generic [ref=e140]:
              - generic [ref=e141]:
                - generic [ref=e142]: Gross
                - generic [ref=e143]: 2,000.00
              - generic [ref=e144]:
                - generic [ref=e145]: Deductions
                - generic [ref=e146]: "0.00"
              - generic [ref=e147]:
                - generic [ref=e148]: Net Pay
                - generic [ref=e149]: 2,000.00
            - generic [ref=e150]:
              - button "Print visible" [ref=e151]
              - button "Print Summary" [ref=e156]
              - button "Export Excel" [ref=e161]
              - button "Post to GL" [ref=e165]
          - table [ref=e170]:
            - rowgroup [ref=e171]:
              - row [ref=e172]:
                - columnheader [ref=e173]:
                  - checkbox "Select all" [ref=e174]
                - columnheader "Number" [ref=e175]
                - columnheader "Employee Name" [ref=e176]
                - columnheader "Dept./Position" [ref=e177]
                - columnheader "Payroll Period" [ref=e178]
                - columnheader "Pay Date" [ref=e179]
                - columnheader "Status" [ref=e180]
                - columnheader "Date" [ref=e181]
                - columnheader [ref=e182]
            - rowgroup [ref=e183]:
              - row [ref=e184] [cursor=pointer]:
                - cell [ref=e185]:
                  - checkbox "Select RECON-BROWSER-DUP-1" [ref=e186]
                - cell [ref=e187]:
                  - button "RECON-BROWSER-DUP-1" [ref=e188]
                  - text: · v1 / r1
                - cell "Synthetic Reconciliation DUP" [ref=e189]
                - cell [ref=e190]
                - cell [ref=e191]
                - cell "2024-06-15" [ref=e192]
                - cell "draft" [ref=e193]
                - cell "05:43 AM" [ref=e195]
                - cell [ref=e196]:
                  - button "Change history for RECON-BROWSER-DUP-1" [ref=e197]
                  - button "Print payslip RECON-BROWSER-DUP-1" [ref=e199]
                  - button "Review owner of payslip RECON-BROWSER-DUP-1" [ref=e204]
                  - button "Email payslip RECON-BROWSER-DUP-1" [ref=e208]
                  - button "Mark payslip RECON-BROWSER-DUP-1 as paid" [ref=e212]
                  - button "Edit payslip RECON-BROWSER-DUP-1" [ref=e215]
                  - button "Delete payslip RECON-BROWSER-DUP-1" [ref=e218]
              - row [ref=e221] [cursor=pointer]:
                - cell [ref=e222]:
                  - checkbox "Select RECON-BROWSER-DUP-0" [ref=e223]
                - cell [ref=e224]:
                  - button "RECON-BROWSER-DUP-0" [ref=e225]
                  - text: · v1 / r1
                - cell "Synthetic Reconciliation DUP" [ref=e226]
                - cell [ref=e227]
                - cell [ref=e228]
                - cell "2024-06-15" [ref=e229]
                - cell "draft" [ref=e230]
                - cell "05:43 AM" [ref=e232]
                - cell [ref=e233]:
                  - button "Change history for RECON-BROWSER-DUP-0" [ref=e234]
                  - button "Print payslip RECON-BROWSER-DUP-0" [ref=e236]
                  - button "Review owner of payslip RECON-BROWSER-DUP-0" [ref=e241]
                  - button "Email payslip RECON-BROWSER-DUP-0" [ref=e245]
                  - button "Mark payslip RECON-BROWSER-DUP-0 as paid" [ref=e249]
                  - button "Edit payslip RECON-BROWSER-DUP-0" [ref=e252]
                  - button "Delete payslip RECON-BROWSER-DUP-0" [ref=e255]
        - generic [ref=e259] [cursor=pointer]:
          - button "RECON-BROWSER-GOOD 2024-06-01 – 2024-06-15 · 1 payslip" [ref=e260]:
            - generic [aria-hidden] [ref=e261]: ▸
            - generic [ref=e262]:
              - strong [ref=e263]: RECON-BROWSER-GOOD
              - generic [ref=e264]: 2024-06-01 – 2024-06-15 · 1 payslip
          - generic [ref=e265]:
            - generic [ref=e266]:
              - generic [ref=e267]: Gross
              - generic [ref=e268]: 1,000.00
            - generic [ref=e269]:
              - generic [ref=e270]: Deductions
              - generic [ref=e271]: "0.00"
            - generic [ref=e272]:
              - generic [ref=e273]: Net Pay
              - generic [ref=e274]: 1,000.00
          - generic [ref=e275]:
            - button "Print visible" [ref=e276]
            - button "Print Summary" [ref=e281]
            - button "Export Excel" [ref=e286]
            - button "Post to GL" [ref=e290]
        - generic [ref=e295] [cursor=pointer]:
          - button "(no period) 8 payslips" [ref=e296]:
            - generic [aria-hidden] [ref=e297]: ▸
            - generic [ref=e298]:
              - strong [ref=e299]: (no period)
              - generic [ref=e300]: 8 payslips
          - generic [ref=e301]:
            - generic [ref=e302]:
              - generic [ref=e303]: Gross
              - generic [ref=e304]: 36,000.00
            - generic [ref=e305]:
              - generic [ref=e306]: Deductions
              - generic [ref=e307]: "0.00"
            - generic [ref=e308]:
              - generic [ref=e309]: Net Pay
              - generic [ref=e310]: 45,924.00
          - generic [ref=e311]:
            - button "Print visible" [ref=e312]
            - button "Print Summary" [ref=e317]
            - button "Export Excel" [ref=e322]
    - complementary [ref=e326]:
      - generic [ref=e327]:
        - button "Messages" [ref=e328] [cursor=pointer]
        - button "Notifications" [ref=e332] [cursor=pointer]
        - button "Notes" [ref=e336] [cursor=pointer]
        - button "Email" [ref=e340] [cursor=pointer]
        - button "Tasks & reminders" [ref=e344] [cursor=pointer]
        - button "Bookmarks" [ref=e348] [cursor=pointer]
        - button "Report a Bug" [ref=e351] [cursor=pointer]
      - generic [ref=e361]:
        - button "Help" [ref=e362] [cursor=pointer]
        - button "Toggle theme" [ref=e366] [cursor=pointer]
        - button "Sign out" [ref=e369] [cursor=pointer]
  - button "AI Assistant" [ref=e373] [cursor=pointer]
```

# Test source

```ts
  1  | /// <reference lib="dom" />
  2  | import {test,expect,type Page} from '@playwright/test';
  3  | import AxeBuilder from '@axe-core/playwright';
  4  | async function open(page:Page,number:string){
  5  |  await page.goto('/?view=desktop');await page.locator('#login-username').fill('admin');await page.locator('#login-password').fill('admin123-test-only');await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page.locator('#app-screen')).toBeVisible();
  6  |  await page.evaluate(()=>(window as any).App.navigate('form-records',{slug:'hr_payroll'}));
> 7  |  const button=page.getByRole('button',{name:'Review owner of payslip '+number,exact:true});await button.click();
     |                                                                                                         ^ Error: locator.click: Test timeout of 30000ms exceeded.
  8  |  const dialog=page.getByRole('dialog',{name:'Review payslip owner',exact:true});await expect(dialog).toBeVisible();return dialog;
  9  | }
  10 | async function review(page:Page,number:string){
  11 |  const dialog=await open(page,number);await dialog.locator('#pri-search').fill('DISC-BROWSER-0');await dialog.getByRole('button',{name:'Find employee',exact:true}).click();
  12 |  await expect(dialog.locator('#pri-employee option')).toHaveCount(2);await dialog.locator('#pri-employee').selectOption({index:1});
  13 |  await dialog.locator('#pri-reason').fill('Verified the original employment records');await dialog.locator('#pri-reference').fill('CASE-BROWSER-TEST');await dialog.locator('#pri-verified').check();
  14 |  await dialog.getByRole('button',{name:'Review correction',exact:true}).click();await expect(dialog.getByRole('button',{name:'Confirm identity repair',exact:true})).toBeVisible();return dialog;
  15 | }
  16 | test('reviewed repair preserves paid state and grants the identified employee access',async({page,playwright})=>{
  17 |  const dialog=await review(page,'REPAIR-BROWSER');await expect(dialog).toContainText('Synthetic Payroll New');await expect(dialog).toContainText('payslip-original');await expect(dialog).toContainText('Paid status, amounts and payment timestamps will be preserved');
  18 |  expect((await new AxeBuilder({page}).include('[role="dialog"]').analyze()).violations).toEqual([]);
  19 |  await page.screenshot({path:'work/payroll-repair-review.png'});
  20 |  await dialog.getByRole('button',{name:'Confirm identity repair',exact:true}).click();await expect(dialog).toBeHidden();
  21 |  const row=page.locator('tr').filter({hasText:'REPAIR-BROWSER'});await expect(row).toContainText('paid');
  22 |  const request=await playwright.request.newContext({baseURL:'http://127.0.0.1:4173'});
  23 |  try{const login=await(await request.post('/api/auth/login',{data:{username:'payslip-original',password:'payslip-browser-test-only'}})).json();const rows=await(await request.get('/api/me/payslips',{headers:{Authorization:`Bearer ${login.token}`}})).json();const repaired=rows.find((r:any)=>r.number==='REPAIR-BROWSER');expect(repaired.finalized).toBe(true);expect((await request.get(`/api/me/payslips/${repaired.id}/pdf`,{headers:{Authorization:`Bearer ${login.token}`}})).status()).toBe(200);}finally{await request.dispose();}
  24 | });
  25 | test('cancelling a reviewed repair sends no confirmation',async({page})=>{
  26 |  let confirms=0;page.on('request',r=>{if(r.url().endsWith('/identity/confirm'))confirms++;});const dialog=await review(page,'REPAIR-CANCEL');page.once('dialog',dialog=>dialog.accept());await dialog.getByRole('button',{name:'Cancel',exact:true}).click();await expect(dialog).toBeHidden();expect(confirms).toBe(0);
  27 | });
  28 | test('stale payroll state is refused and shows an accessible error in the review',async({page})=>{
  29 |  const dialog=await review(page,'REPAIR-STALE');
  30 |  await page.evaluate(async()=>{const api=(window as any).API;const forms=await api.get('/form-definitions');const form=forms.find((r:any)=>r.slug==='hr_payroll');const records=await api.get(`/form-definitions/${form.id}/records`);const record=records.find((r:any)=>r.number==='REPAIR-STALE');await api.post(`/hr/payroll/${record.id}/unmark-paid`,{});});
  31 |  await dialog.getByRole('button',{name:'Confirm identity repair',exact:true}).click();await expect(dialog.getByRole('alert')).toContainText('changed');await expect(dialog).toBeVisible();
  32 | });
  33 |
```
