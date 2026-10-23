/// <reference lib="dom" />
import { test, expect } from '@playwright/test';
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';

test('real Word import preserves the draft on failure, previews before apply and remains undoable', async ({ page }, testInfo) => {
  await page.goto('/?view=desktop');
  await page.locator('#login-username').fill('admin');
  await page.locator('#login-password').fill('admin123-test-only');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('#app-screen')).toBeVisible();
  const id = await page.evaluate(async () => {
    const app = (window as any).App, api = (window as any).API;
    const template = await api.post('/templates', {
      name: 'Synthetic Word dependency browser', type: 'generic', body: '<p>Preserved browser draft.</p>',
    });
    app.navigate('templates');
    return template.id;
  });
  await page.locator(`[data-edit="${id}"]`).click();
  const surface = page.locator('.doc-surface');
  await expect(surface).toContainText('Preserved browser draft.');
  await expect(page.locator('.doc-shared-status')).toContainText('Connected');
  const saved = () => page.evaluate(async id => (await (window as any).API.get('/templates/' + id)).body, id);
  const before = await saved();
  await page.locator('.doc-fs [data-file]').click();
  const dialog = page.getByRole('dialog', { name: 'Import and export', exact: true });
  const upload = dialog.locator('[data-import-file]');
  await upload.setInputFiles({ name: 'broken.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('not a zip') });
  const rejected = page.waitForResponse(r => r.url().endsWith('/import-docx'));
  await dialog.getByRole('button', { name: 'Convert and preview', exact: true }).click();
  expect((await rejected).status()).toBe(400);
  await expect(dialog.locator('[data-import-result]')).toContainText('Choose a valid document');
  await expect(surface).toContainText('Preserved browser draft.');
  expect(await saved()).toBe(before);

  const buffer = await Packer.toBuffer(new Document({ sections: [{ children: [
    new Paragraph({ text: 'Reviewed Word import', heading: HeadingLevel.HEADING_1 }),
    new Paragraph({ children: [new TextRun('Independent UTF-8 café 🌱 '), new TextRun({ text: 'bold content', bold: true })] }),
  ] }] }));
  await upload.setInputFiles({ name: 'Source with spaces.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer });
  await dialog.locator('[data-import-mode]').selectOption('replace');
  const converted = page.waitForResponse(r => r.url().endsWith('/import-docx'));
  await dialog.getByRole('button', { name: 'Convert and preview', exact: true }).click();
  const response = await converted;
  expect(response.status()).toBe(200);
  const result = await response.json();
  expect(result.body).toContain('<h1>Reviewed Word import</h1>');
  expect(result.body).toContain('<strong>bold content</strong>');
  await expect(dialog.frameLocator('iframe').getByRole('heading', { name: 'Reviewed Word import' })).toBeVisible();
  await expect(surface).not.toContainText('Reviewed Word import');
  expect(await saved()).toBe(before);
  await page.screenshot({ path: testInfo.outputPath('word-reviewed-before-apply.png'), fullPage: true });
  await dialog.getByRole('button', { name: 'Apply import', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(surface).toContainText('Independent UTF-8 café 🌱');
  await expect(surface).not.toContainText('Preserved browser draft.');
  expect(await saved()).toBe(before);
  await page.locator('.doc-fs [data-ex="undo"]').click();
  await expect(surface).toContainText('Preserved browser draft.');
  await expect(surface).not.toContainText('Reviewed Word import');
  expect(await saved()).toBe(before);
});
