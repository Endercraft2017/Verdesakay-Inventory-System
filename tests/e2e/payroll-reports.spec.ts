/// <reference lib="dom" />
import {test, expect, type Page} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
async function login(page: Page) {
  await page.goto('/?view=desktop'); await page.locator('#login-username').fill('admin');
  await page.locator('#login-password').fill('admin123-test-only');
  await page.getByRole('button', {name:'Sign in', exact:true}).click();
  await expect(page.locator('#app-screen')).toBeVisible();
  await page.evaluate(() => (window as any).App.navigate('accounting'));
}
test('same-name employees retain separate certificates, print details and CSV identifiers', async ({page}) => {
  await login(page); await page.locator('[data-card="BIR 2316"]').click();
  await page.locator('#b16-year').selectOption('2025');
  const a = page.locator('#b16-body tr').filter({hasText:'REPORT-BROWSER-0'});
  const b = page.locator('#b16-body tr').filter({hasText:'REPORT-BROWSER-1'});
  await expect(a).toContainText('Synthetic Report Twin'); await expect(b).toContainText('Synthetic Report Twin');
  const download = page.waitForEvent('download'); await page.locator('#b16-csv').click();
  const stream = await (await download).createReadStream(); const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const csv = Buffer.concat(chunks).toString(); expect(csv).toContain('REPORT-BROWSER-0'); expect(csv).toContain('REPORT-TIN-1');
  expect((await new AxeBuilder({page}).include('[role="dialog"]').analyze()).violations).toEqual([]);
  await page.screenshot({path:'work/payroll-reports-twins.png'});
  await b.getByRole('button',{name:'Print',exact:true}).click();
  const frame = page.frameLocator('#b16-frame');
  await expect(frame.locator('body')).toContainText('REPORT-TIN-1');
  await expect(frame.locator('body')).not.toContainText('REPORT-TIN-0');
  await expect(frame.locator('body')).toContainText('24,000');
});
test('every payroll report shows the real integrity error and disables export', async ({page}) => {
  await login(page);
  for (const [fn, body, csv] of [
    ['bir1601cModal','c16','c16'], ['bir1604cModal','a4','a4'],
    ['birAlphalistModal','al','al'], ['bir2316Modal','b16','b16'],
    ['contributionScheduleModal','cs','cs'], ['thirteenthMonthModal','tm','tm'],
  ] as const) {
    await page.evaluate(name => (window as any)[name](), fn);
    await expect(page.locator(`#${body}-body`)).toContainText('Payroll report blocked');
    await expect(page.locator(`#${csv}-csv`)).toBeDisabled();
    await expect(page.locator(`#${body}-body`)).not.toContainText('No payslips');
    await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();
  }
});
test('changing year clears export immediately and ignores a late older response', async ({page}) => {
  await login(page); await page.locator('[data-card="BIR 2316"]').click();
  await expect(page.locator('#b16-body')).toContainText('Payroll report blocked');
  await page.locator('#b16-year').selectOption('2025');
  await expect(page.locator('#b16-body')).toContainText('REPORT-BROWSER-0');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void; const pending = new Promise<void>(resolve => { started = resolve; });
  await page.route('**/api/accounting/bir-2316?year=2024', async route => {
    started(); await gate;
    await route.fulfill({json:{year:'2024',rows:[{employee_name:'LATE PRIVATE RESPONSE',employee_id:999,figures:{}}]}});
  });
  await page.locator('#b16-year').selectOption('2024'); await pending;
  await expect(page.locator('#b16-csv')).toBeDisabled();
  await expect(page.locator('#b16-body')).not.toContainText('REPORT-BROWSER-0');
  await page.locator('#b16-year').selectOption('2026');
  await expect(page.locator('#b16-body')).toContainText('Payroll report blocked');
  const late = page.waitForResponse('**/api/accounting/bir-2316?year=2024'); release(); await late;
  // Let the response's promise and render callbacks run, without a fixed-duration sleep.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.locator('#b16-body')).not.toContainText('LATE PRIVATE RESPONSE');
  await expect(page.locator('#b16-csv')).toBeDisabled();
});
