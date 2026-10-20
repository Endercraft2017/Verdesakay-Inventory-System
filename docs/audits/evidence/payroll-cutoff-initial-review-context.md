# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: payroll-cutoff.spec.ts >> a detached payroll view cannot submit its old review
- Location: tests/e2e/payroll-cutoff.spec.ts:28:1

# Error details

```
Error: expect(locator).toHaveCount(expected) failed

Locator:  getByRole('button', { name: 'Recover cutoff of payslip CUTOFF-CONTEXT', exact: true })
Expected: 0
Received: 1
Timeout:  5000ms

Call log:
  - Expect "toHaveCount" getByRole('button', { name: 'Recover cutoff of payslip CUTOFF-CONTEXT', exact: true }) with timeout 5000ms
  - waiting for getByRole('button', { name: 'Recover cutoff of payslip CUTOFF-CONTEXT', exact: true })
    14 × locator resolved to 1 element
       - unexpected value "1"

```

# Page snapshot

```yaml
- generic [active] [ref=e1]:
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
            - searchbox "Search payslips by employee name" [ref=e102]: CUTOFF-CONTEXT
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
          - button "Reset" [ref=e110] [cursor=pointer]
          - group "Print and export the payslips in view" [ref=e111]:
            - button "Print visible" [ref=e112] [cursor=pointer]
            - button "Print Summary" [ref=e117] [cursor=pointer]
            - button "Download Excel" [ref=e122] [cursor=pointer]
        - generic [ref=e126]:
          - button "Choose columns" [ref=e127] [cursor=pointer]
          - generic [ref=e128]: Saved view
          - combobox "Saved view" [ref=e129]:
            - option "Current filters" [selected]
          - button "Save current filters" [ref=e130] [cursor=pointer]
          - button "Remove saved view" [disabled] [ref=e131]
          - status
        - generic [ref=e134]:
          - generic [ref=e135] [cursor=pointer]:
            - button "CUTOFF-CONTEXT 1 payslip" [expanded] [ref=e136]:
              - generic [aria-hidden] [ref=e137]: ▾
              - generic [ref=e138]:
                - strong [ref=e139]: CUTOFF-CONTEXT
                - generic [ref=e140]: 1 payslip
            - generic [ref=e141]:
              - generic [ref=e142]:
                - generic [ref=e143]: Gross
                - generic [ref=e144]: 1,000.00
              - generic [ref=e145]:
                - generic [ref=e146]: Deductions
                - generic [ref=e147]: "0.00"
              - generic [ref=e148]:
                - generic [ref=e149]: Net Pay
                - generic [ref=e150]: 1,000.00
            - generic [ref=e151]:
              - button "Print visible" [ref=e152]
              - button "Print Summary" [ref=e157]
              - button "Export Excel" [ref=e162]
          - table [ref=e167]:
            - rowgroup [ref=e168]:
              - row [ref=e169]:
                - columnheader [ref=e170]:
                  - checkbox "Select all" [ref=e171]
                - columnheader "Number" [ref=e172]
                - columnheader "Employee Name" [ref=e173]
                - columnheader "Dept./Position" [ref=e174]
                - columnheader "Payroll Period" [ref=e175]
                - columnheader "Pay Date" [ref=e176]
                - columnheader "Status" [ref=e177]
                - columnheader "Date" [ref=e178]
                - columnheader [ref=e179]
            - rowgroup [ref=e180]:
              - row [ref=e181] [cursor=pointer]:
                - cell [ref=e182]:
                  - checkbox "Select CUTOFF-CONTEXT" [ref=e183]
                - cell [ref=e184]:
                  - button "CUTOFF-CONTEXT" [ref=e185]
                  - text: · v1 / r1
                - cell "Synthetic Cutoff Browser" [ref=e186]
                - cell [ref=e187]
                - cell "CUTOFF-CONTEXT" [ref=e188]
                - cell "2032-07-16" [ref=e189]
                - cell "draft" [ref=e190]
                - cell "06:22 AM" [ref=e192]
                - cell [ref=e193]:
                  - button "Change history for CUTOFF-CONTEXT" [ref=e194]
                  - button "Print payslip CUTOFF-CONTEXT" [ref=e196]
                  - button "Review owner of payslip CUTOFF-CONTEXT" [ref=e201]
                  - button "Recover cutoff of payslip CUTOFF-CONTEXT" [ref=e205]
                  - button "Email payslip CUTOFF-CONTEXT" [ref=e209]
                  - button "Mark payslip CUTOFF-CONTEXT as paid" [ref=e213]
                  - button "Edit payslip CUTOFF-CONTEXT" [ref=e216]
                  - button "Delete payslip CUTOFF-CONTEXT" [ref=e219]
      - complementary [ref=e222]:
        - generic [ref=e223]:
          - button "Messages" [ref=e224] [cursor=pointer]
          - button "Notifications" [ref=e228] [cursor=pointer]
          - button "Notes" [ref=e232] [cursor=pointer]
          - button "Email" [ref=e236] [cursor=pointer]
          - button "Tasks & reminders" [ref=e240] [cursor=pointer]
          - button "Bookmarks" [ref=e244] [cursor=pointer]
          - button "Report a Bug" [ref=e247] [cursor=pointer]
        - generic [ref=e257]:
          - button "Help" [ref=e258] [cursor=pointer]
          - button "Toggle theme" [ref=e262] [cursor=pointer]
          - button "Sign out" [ref=e265] [cursor=pointer]
    - button "AI Assistant" [ref=e269] [cursor=pointer]
  - dialog "Recover payslip cutoff" [ref=e274]:
    - generic [ref=e275]:
      - heading "Recover payslip cutoff" [level=3] [ref=e276]
      - generic [ref=e277]:
        - button "Guide" [ref=e278] [cursor=pointer]
        - button "Close dialog" [ref=e282] [cursor=pointer]
    - generic [ref=e287]:
      - paragraph [ref=e288]:
        - strong [ref=e289]: CUTOFF-CONTEXT
        - text: · draft
      - paragraph [ref=e290]: "Employee: CUTOFF-BROWSER-EMP — Synthetic Cutoff Browser (employee 3)"
      - paragraph [ref=e291]:
        - text: Recover stored cutoff broken as
        - strong [ref=e292]: CUTOFF-CONTEXT
        - text: (cutoff 4), 2032-07-01 to 2032-07-15.
      - paragraph [ref=e293]: "Reason: Verified original attendance and payroll records"
      - paragraph [ref=e294]: "Evidence reference: CASE-BROWSER-CUTOFF"
      - paragraph [ref=e295]: This changes only the cutoff ID. Amounts, pay date, recorded labels and calculation history stay unchanged. Recheck payroll and contribution reports after recovery. This review expires in five minutes.
    - generic [ref=e296]:
      - button "Cancel" [ref=e297] [cursor=pointer]
      - button "Confirm cutoff recovery" [ref=e298] [cursor=pointer]
```

# Test source

```ts
  1  | /// <reference lib="dom" />
  2  | import {test,expect,type Page} from '@playwright/test';
  3  | import AxeBuilder from '@axe-core/playwright';
  4  | async function open(page:Page,number:string){
  5  |  await page.goto('/?view=desktop');await page.locator('#login-username').fill('admin');await page.locator('#login-password').fill('admin123-test-only');await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page.locator('#app-screen')).toBeVisible();
  6  |  await page.evaluate(number=>(window as any).App.navigate('form-records',{slug:'hr_payroll',q:number}),number);
  7  |  await page.getByRole('button',{name:'Recover cutoff of payslip '+number,exact:true}).click();const dialog=page.getByRole('dialog',{name:'Recover payslip cutoff',exact:true});await expect(dialog).toBeVisible();return dialog;
  8  | }
  9  | async function review(page:Page,number:string){
  10 |  const dialog=await open(page,number);await expect(dialog.locator('#pcr-cutoff')).toHaveValue('');await dialog.locator('#pcr-cutoff').selectOption({index:1});
  11 |  await dialog.locator('#pcr-reason').fill('Verified original attendance and payroll records');await dialog.locator('#pcr-reference').fill('CASE-BROWSER-CUTOFF');await dialog.locator('#pcr-verified').check();await dialog.getByRole('button',{name:'Review cutoff recovery',exact:true}).click();await expect(dialog.getByRole('button',{name:'Confirm cutoff recovery',exact:true})).toBeVisible();return dialog;
  12 | }
  13 | async function record(page:Page,number:string){return page.evaluate(async number=>{const api=(window as any).API,forms=await api.get('/form-definitions'),form=forms.find((r:any)=>r.slug==='hr_payroll'),rows=await api.get(`/form-definitions/${form.id}/records`);return rows.find((r:any)=>r.number===number);},number);}
  14 | test('reviews the authoritative cutoff, preserves original money and creates attributed correction history',async({page})=>{
  15 |  const dialog=await review(page,'CUTOFF-BROWSER'),before=await record(page,'CUTOFF-BROWSER');expect(before.data.cutoff_id).toBe('broken');await expect(dialog).toContainText('Synthetic Cutoff Browser');await expect(dialog).toContainText('Amounts, pay date, recorded labels and calculation history stay unchanged');
  16 |  expect((await new AxeBuilder({page}).include('[role="dialog"]').analyze()).violations).toEqual([]);await page.screenshot({path:'work/payroll-cutoff-review.png'});
  17 |  await dialog.getByRole('button',{name:'Confirm cutoff recovery',exact:true}).click();await expect(dialog).toBeHidden();
  18 |  const after=await record(page,'CUTOFF-BROWSER');expect(typeof after.data.cutoff_id).toBe('number');expect(after.data).toEqual({...before.data,cutoff_id:after.data.cutoff_id});expect(after.revision).toBe(before.revision+1);expect(after.status).toBe('draft');expect(after.updated_at).toBe(before.updated_at);
  19 |  const history=await page.evaluate(async id=>await(window as any).API.get(`/form-records/${id}/revisions`),after.id);expect(history[0]).toMatchObject({source:'payroll-cutoff-recovery'});expect(JSON.parse(history[0].reason).evidence_reference).toBe('CASE-BROWSER-CUTOFF');
  20 | });
  21 | test('cancelling review sends no correction and retains the original stamp',async({page})=>{
  22 |  let confirms=0;page.on('request',r=>{if(r.url().endsWith('/cutoff-recovery/confirm'))confirms++;});const dialog=await review(page,'CUTOFF-CANCEL');page.once('dialog',d=>d.accept());await dialog.getByRole('button',{name:'Cancel',exact:true}).click();await expect(dialog).toBeHidden();expect(confirms).toBe(0);expect((await record(page,'CUTOFF-CANCEL')).data.cutoff_id).toBe('broken');
  23 | });
  24 | test('a new paid state is refused with an accessible error at confirmation',async({page})=>{
  25 |  const dialog=await review(page,'CUTOFF-STALE'),before=await record(page,'CUTOFF-STALE');await page.evaluate(async id=>{await(window as any).API.post(`/hr/payroll/${id}/mark-paid`,{});},before.id);
  26 |  await dialog.getByRole('button',{name:'Confirm cutoff recovery',exact:true}).click();await expect(dialog.getByRole('alert')).toContainText('never been paid');expect((await record(page,'CUTOFF-STALE')).data.cutoff_id).toBe('broken');await expect(dialog).toBeVisible();
  27 | });
  28 | test('a detached payroll view cannot submit its old review',async({page})=>{
  29 |  const dialog=await review(page,'CUTOFF-CONTEXT');let confirms=0;page.on('request',r=>{if(r.url().endsWith('/cutoff-recovery/confirm'))confirms++;});
> 30 |  await page.evaluate(()=>(window as any).App.navigate('home'));await expect(page.getByRole('button',{name:'Recover cutoff of payslip CUTOFF-CONTEXT',exact:true})).toHaveCount(0);
     |                                                                                                                                                                    ^ Error: expect(locator).toHaveCount(expected) failed
  31 |  // The shared modal may stay visible across navigation; its context guard still stops writes.
  32 |  if(await dialog.isVisible()){await dialog.getByRole('button',{name:'Confirm cutoff recovery',exact:true}).click();await expect(dialog.getByRole('alert')).toContainText('changed');}
  33 |  expect(confirms).toBe(0);
  34 | });
  35 |
```
