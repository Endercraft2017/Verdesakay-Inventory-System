# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: payroll-reports.spec.ts >> same-name employees retain separate certificates, print details and CSV identifiers
- Location: tests/e2e/payroll-reports.spec.ts:11:1

# Error details

```
Test timeout of 30000ms exceeded.
```

```
Error: locator.click: Test timeout of 30000ms exceeded.
Call log:
  - waiting for getByRole('button', { name: 'BIR 2316', exact: true })

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
    - button "Tax & Compliance" [ref=e70] [cursor=pointer]
    - button "General Ledger" [ref=e71] [cursor=pointer]
    - button "Receivables & Payables" [ref=e72] [cursor=pointer]
    - button "Cash" [ref=e73] [cursor=pointer]
    - button "Forms" [ref=e74] [cursor=pointer]
  - generic [ref=e75]:
    - complementary [ref=e76]:
      - generic [ref=e77]:
        - generic [ref=e78]: Tax & Compliance
        - button "Tax & Compliance" [ref=e79] [cursor=pointer]
    - main [ref=e83]:
      - generic [ref=e84]:
        - heading "Tax & Compliance" [level=2] [ref=e85]
        - button "Guide" [ref=e86] [cursor=pointer]
      - generic [ref=e90]:
        - paragraph [ref=e91]: Each item is a worksheet built from your payroll, sales and purchase records — review and adjust before filing in eBIRForms / eFPS or each agency's portal. This app does not submit filings. Use Books for journals and financial statements, and Receivables & Payables for settlements.
        - heading "Value-added tax" [level=4] [ref=e92]
        - generic [ref=e93]:
          - generic [ref=e94] [cursor=pointer]:
            - generic [ref=e98]: BIR 2550M
            - generic [ref=e99]: Monthly VAT — output less input, re-sourced from the sales & purchase journals.
          - generic [ref=e100] [cursor=pointer]:
            - generic [ref=e104]: BIR 2550Q
            - generic [ref=e105]: Quarterly VAT — the quarter's output less input, with a per-month breakdown.
          - generic [ref=e106] [cursor=pointer]:
            - generic [ref=e110]: SLSP
            - generic [ref=e111]: Quarterly Summary List of Sales / Purchases — the RELIEF/DAT file.
          - generic [ref=e112] [cursor=pointer]:
            - generic [ref=e117]: Tax codes
            - generic [ref=e118]: VAT / withholding classifications a sale, bill or note can carry.
        - heading "Expanded withholding (suppliers)" [level=4] [ref=e119]
        - generic [ref=e120]:
          - generic [ref=e121] [cursor=pointer]:
            - generic [ref=e125]: Withholding register
            - generic [ref=e126]: Every vendor bill with EWT held back — by ATC, feeds 0619-E / 1601-EQ.
          - generic [ref=e127] [cursor=pointer]:
            - generic [ref=e131]: BIR 0619-E
            - generic [ref=e132]: Monthly remittance of expanded / creditable withholding tax, per ATC.
          - generic [ref=e133] [cursor=pointer]:
            - generic [ref=e137]: BIR 1601-EQ + QAP
            - generic [ref=e138]: Quarterly EWT return + Quarterly Alphalist of Payees.
          - generic [ref=e139] [cursor=pointer]:
            - generic [ref=e143]: BIR 1604-E
            - generic [ref=e144]: Annual info return of creditable taxes withheld (expanded) + alphalist.
          - generic [ref=e145] [cursor=pointer]:
            - generic [ref=e151]: BIR 2307
            - generic [ref=e152]: Certificate of Creditable Tax Withheld at Source — one per supplier, printable.
        - heading "Income tax" [level=4] [ref=e153]
        - generic [ref=e155] [cursor=pointer]:
          - generic [ref=e159]: BIR 1702Q / 1702-RT
          - generic [ref=e160]: Corporate income tax worksheet — book net income → adjustments → tax due, less credits.
        - heading "Withholding on compensation (payroll)" [level=4] [ref=e161]
        - generic [ref=e162]:
          - generic [ref=e163] [cursor=pointer]:
            - generic [ref=e167]: BIR 1601-C
            - generic [ref=e168]: Monthly withholding-tax remittance worksheet.
          - generic [ref=e169] [cursor=pointer]:
            - generic [ref=e173]: BIR 1604-C
            - generic [ref=e174]: Annual return face + reconciliation to the Alphalist.
          - generic [ref=e175] [cursor=pointer]:
            - generic [ref=e180]: BIR 1604-C Alphalist
            - generic [ref=e181]: Schedule 1 — Alphalist of Employees, BIR column layout.
          - generic [ref=e182] [cursor=pointer]:
            - generic [ref=e188]: BIR 2316
            - generic [ref=e189]: Year-end Certificate of Compensation Payment / Tax Withheld, per employee.
        - heading "Statutory contributions" [level=4] [ref=e190]
        - generic [ref=e191]:
          - generic [ref=e192] [cursor=pointer]:
            - generic [ref=e197]: Contribution schedule
            - generic [ref=e198]: Monthly SSS R-3 / PhilHealth RF-1·EPRS / Pag-IBIG MCRF·eSRS collection list.
          - generic [ref=e199] [cursor=pointer]:
            - generic [ref=e204]: Statutory deductions
            - generic [ref=e205]: Turn SSS / PhilHealth / Pag-IBIG / withholding on or off per employee — feeds payroll.
        - heading "General ledger" [level=4] [ref=e206]
        - generic [ref=e207]:
          - generic [ref=e208] [cursor=pointer]:
            - generic [ref=e212]: Books
            - generic [ref=e213]: Double-entry general ledger — chart of accounts, journal entries, trial balance, P&L, balance sheet, cash flow.
          - generic [ref=e214] [cursor=pointer]:
            - generic [ref=e218]: Receivables & Payables
            - generic [ref=e219]: AR / AP aging, customer receipts & supplier payments, per-party statement.
          - generic [ref=e220] [cursor=pointer]:
            - generic [ref=e224]: Petty cash
            - generic [ref=e225]: Named cash funds with a running money-in / money-out register.
          - generic [ref=e226] [cursor=pointer]:
            - generic [ref=e232]: Books of Accounts
            - generic [ref=e233]: The registered set — General Journal / Ledger, Cash books, Sales / Purchase Journals — printable + CSV for BIR CAS registration.
          - generic [ref=e234] [cursor=pointer]:
            - generic [ref=e240]: Financial Statements (AFS)
            - generic [ref=e241]: The five statements, this year vs last, notes-ready — a draft pack for the CPA.
    - complementary [ref=e242]:
      - generic [ref=e243]:
        - button "Messages" [ref=e244] [cursor=pointer]
        - button "Notifications" [ref=e248] [cursor=pointer]
        - button "Notes" [ref=e252] [cursor=pointer]
        - button "Email" [ref=e256] [cursor=pointer]
        - button "Tasks & reminders" [ref=e260] [cursor=pointer]
        - button "Bookmarks" [ref=e264] [cursor=pointer]
        - button "Report a Bug" [ref=e267] [cursor=pointer]
      - generic [ref=e277]:
        - button "Help" [ref=e278] [cursor=pointer]
        - button "Toggle theme" [ref=e282] [cursor=pointer]
        - button "Sign out" [ref=e285] [cursor=pointer]
  - button "AI Assistant" [ref=e289] [cursor=pointer]
```

# Test source

```ts
  1  | /// <reference lib="dom" />
  2  | import {test, expect, type Page} from '@playwright/test';
  3  | import AxeBuilder from '@axe-core/playwright';
  4  | async function login(page: Page) {
  5  |   await page.goto('/?view=desktop'); await page.locator('#login-username').fill('admin');
  6  |   await page.locator('#login-password').fill('admin123-test-only');
  7  |   await page.getByRole('button', {name:'Sign in', exact:true}).click();
  8  |   await expect(page.locator('#app-screen')).toBeVisible();
  9  |   await page.evaluate(() => (window as any).App.navigate('accounting'));
  10 | }
  11 | test('same-name employees retain separate certificates, print details and CSV identifiers', async ({page}) => {
> 12 |   await login(page); await page.getByRole('button',{name:'BIR 2316',exact:true}).click();
     |                                                                                  ^ Error: locator.click: Test timeout of 30000ms exceeded.
  13 |   await page.locator('#b16-year').selectOption('2025');
  14 |   const a = page.locator('#b16-body tr').filter({hasText:'REPORT-BROWSER-0'});
  15 |   const b = page.locator('#b16-body tr').filter({hasText:'REPORT-BROWSER-1'});
  16 |   await expect(a).toContainText('Synthetic Report Twin'); await expect(b).toContainText('Synthetic Report Twin');
  17 |   const download = page.waitForEvent('download'); await page.locator('#b16-csv').click();
  18 |   const stream = await (await download).createReadStream(); const chunks: Buffer[] = [];
  19 |   for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  20 |   const csv = Buffer.concat(chunks).toString(); expect(csv).toContain('REPORT-BROWSER-0'); expect(csv).toContain('REPORT-TIN-1');
  21 |   expect((await new AxeBuilder({page}).include('[role="dialog"]').analyze()).violations).toEqual([]);
  22 |   await page.screenshot({path:'work/payroll-reports-twins.png'});
  23 |   await b.getByRole('button',{name:'Print',exact:true}).click();
  24 |   const frame = page.frameLocator('#b16-frame');
  25 |   await expect(frame.locator('body')).toContainText('REPORT-TIN-1');
  26 |   await expect(frame.locator('body')).not.toContainText('REPORT-TIN-0');
  27 |   await expect(frame.locator('body')).toContainText('24,000');
  28 | });
  29 | test('every payroll report shows the real integrity error and disables export', async ({page}) => {
  30 |   await login(page);
  31 |   for (const [fn, body, csv] of [
  32 |     ['bir1601cModal','c16','c16'], ['bir1604cModal','a4','a4'],
  33 |     ['birAlphalistModal','al','al'], ['bir2316Modal','b16','b16'],
  34 |     ['contributionScheduleModal','cs','cs'], ['thirteenthMonthModal','tm','tm'],
  35 |   ]) {
  36 |     await page.evaluate(name => (window as any)[name](), fn);
  37 |     await expect(page.locator(`#${body}-body`)).toContainText('Payroll report blocked');
  38 |     await expect(page.locator(`#${csv}-csv`)).toBeDisabled();
  39 |     await expect(page.locator(`#${body}-body`)).not.toContainText('No payslips');
  40 |     await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();
  41 |   }
  42 | });
  43 | test('changing year clears export immediately and ignores a late older response', async ({page}) => {
  44 |   await login(page); await page.getByRole('button',{name:'BIR 2316',exact:true}).click();
  45 |   await expect(page.locator('#b16-body')).toContainText('Payroll report blocked');
  46 |   await page.locator('#b16-year').selectOption('2025');
  47 |   await expect(page.locator('#b16-body')).toContainText('REPORT-BROWSER-0');
  48 |   let release!: () => void;
  49 |   const gate = new Promise<void>(resolve => { release = resolve; });
  50 |   let started!: () => void; const pending = new Promise<void>(resolve => { started = resolve; });
  51 |   await page.route('**/api/accounting/bir-2316?year=2024', async route => {
  52 |     started(); await gate;
  53 |     await route.fulfill({json:{year:'2024',rows:[{employee_name:'LATE PRIVATE RESPONSE',employee_id:999,figures:{}}]}});
  54 |   });
  55 |   await page.locator('#b16-year').selectOption('2024'); await pending;
  56 |   await expect(page.locator('#b16-csv')).toBeDisabled();
  57 |   await expect(page.locator('#b16-body')).not.toContainText('REPORT-BROWSER-0');
  58 |   await page.locator('#b16-year').selectOption('2026');
  59 |   await expect(page.locator('#b16-body')).toContainText('Payroll report blocked');
  60 |   const late = page.waitForResponse('**/api/accounting/bir-2316?year=2024'); release(); await late;
  61 |   // Let the response's promise and render callbacks run, without a fixed-duration sleep.
  62 |   await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  63 |   await expect(page.locator('#b16-body')).not.toContainText('LATE PRIVATE RESPONSE');
  64 |   await expect(page.locator('#b16-csv')).toBeDisabled();
  65 | });
  66 |
```
