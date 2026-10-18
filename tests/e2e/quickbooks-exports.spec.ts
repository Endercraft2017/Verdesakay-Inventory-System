import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
test('administrator sees durable export failures, handles status errors and refreshes safely',async({page})=>{
 await page.goto('/');await page.locator('#login-username').fill('admin');await page.locator('#login-password').fill('admin123-test-only');await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page.locator('#app-screen')).toBeVisible();
 await page.evaluate(()=>{(window as any).App.navigate('orders',{type:'sale'});});
 await page.getByRole('button',{name:'Export status',exact:true}).click();
 const dialog=page.getByRole('dialog').filter({has:page.getByText('QuickBooks export status',{exact:true})});
 await expect(dialog.getByText('AUTO-E2E-ATTENTION',{exact:true})).toBeVisible();await expect(dialog).toContainText('Needs attention');await expect(dialog).toContainText('remote outcome is unknown');await expect(dialog).toContainText('sandbox:111');await expect(dialog.locator('li').filter({has:page.getByText('AUTO-E2E-ATTENTION',{exact:true})}).getByRole('button',{name:'Retry automatic export'})).toHaveCount(0);
 const safeRow=dialog.locator('li').filter({has:page.getByText('AUTO-E2E-SAFE-RETRY',{exact:true})});await safeRow.getByRole('button',{name:'Retry automatic export'}).click();await expect(safeRow).toContainText('Waiting to export');
 const axe=await new AxeBuilder({page}).include('#qb-export-status').withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze();expect(axe.violations).toEqual([]);
 await page.route('**/api/quickbooks/exports',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Status temporarily unavailable'})}));
 await dialog.getByRole('button',{name:'Refresh status'}).click();await expect(dialog.getByRole('alert')).toContainText('Status temporarily unavailable');
 await page.unroute('**/api/quickbooks/exports');await dialog.getByRole('button',{name:'Refresh status'}).click();await expect(dialog).toContainText('Needs attention');
 await page.screenshot({path:'work/qbo-export-status.png'});
 await dialog.getByRole('button',{name:'Close',exact:true}).click();await expect(dialog).not.toBeVisible();
});
