const { test: base, expect, chromium } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const fixture = `<!doctype html><html style="color-scheme:dark"><head><meta charset="utf-8"><title>Codex sidebar fixture</title><style>body{margin:0;background:#111;color:#eee;font:14px system-ui;display:flex}aside{width:340px;min-height:100vh;background:#151515}nav>div{padding:8px}nav>div>a{color:#ddd;text-decoration:none;display:inline-block;width:240px}main{padding:36px}button{cursor:pointer}</style></head><body><aside><nav aria-label="Chat history"><h2>Codex</h2><h3>Recents</h3><div><a href="/local/aaa-111">Better UI/UX</a><button data-native="menu">Native menu</button></div><div><a href="/local/bbb-222">Mobile photo previews</a></div><div><a href="/local/ccc-333">Module architecture</a></div><div><a href="/c/ddd-444">CRM research</a></div><div><a href="https://other.example/local/unsafe">External link</a></div></nav></aside><main><h1>Codex session folders</h1><p>Test fixture — no real account or conversations.</p><a href="/local/main-content">A conversation-body link, not a sidebar session</a><button id="update">Simulate update</button></main></body></html>`;
const test = base.extend({ context: async ({}, use) => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'csf-pw-'));
  const extension = path.resolve(__dirname, '../extension');
  const context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium', args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-sandbox'], viewport: { width: 1180, height: 900 } });
  await context.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body: fixture }));
  await use(context); await context.close(); await fs.rm(profile,{recursive:true,force:true});
}, page: async ({context}, use) => {
 const page=await context.newPage(); await page.goto('https://chatgpt.com/local/aaa-111');
 await expect(page.locator('#csf-panel')).toBeVisible(); await use(page);
}});
async function folder(page, name) {
 await page.getByRole('button',{name:'Create folder',exact:true}).click();
 await page.getByRole('textbox',{name:'Folder name',exact:true}).fill(name);
 await page.getByRole('button',{name:'Save',exact:true}).click();
 await expect(page.getByRole('button',{name:`Toggle ${name}`,exact:true})).toBeVisible();
}
const row = (page,title) => page.locator('#csf-panel .csf-session').filter({has:page.getByRole('link',{name:title,exact:true})});

test('real extension: recognizes local sessions, assigns folders, persists and navigates',async({page})=>{
 await expect(page.locator('#csf-panel .csf-session')).toHaveCount(4);
 await expect(page.locator('#csf-panel')).not.toContainText('External link');
 await expect(page.locator('#csf-panel')).not.toContainText('conversation-body link');
 await folder(page,'Verdesakay UI');
 const id=await page.locator('#csf-panel select option').filter({hasText:'Verdesakay UI'}).first().getAttribute('value');
 await row(page,'Better UI/UX').getByRole('combobox').selectOption(id);
 await expect(page.getByRole('button',{name:'Toggle Verdesakay UI',exact:true})).toContainText('(1)');
 await page.getByRole('button',{name:'Toggle Verdesakay UI',exact:true}).click();
 await expect(row(page,'Better UI/UX')).toHaveCount(0);
 await page.reload();
 await expect(page.getByRole('button',{name:'Toggle Verdesakay UI',exact:true})).toHaveAttribute('aria-expanded','false');
 await page.getByRole('button',{name:'Toggle Verdesakay UI',exact:true}).click();
 await expect(row(page,'Better UI/UX').getByRole('combobox')).toHaveValue(id);
 await row(page,'Better UI/UX').getByRole('link').click(); await expect(page).toHaveURL(/\/local\/aaa-111$/);
});

test('rename, duplicate validation, search, delete only unfiles links',async({page})=>{
 await folder(page,'UI'); await folder(page,'Mobile');
 await page.getByRole('button',{name:'Rename UI',exact:true}).click();
 await page.getByRole('textbox',{name:'Rename folder',exact:true}).fill('Mobile');
 await page.getByRole('button',{name:'Save',exact:true}).click();
 await expect(page.locator('dialog')).toBeVisible();
 await page.getByRole('textbox',{name:'Rename folder',exact:true}).fill('Design');
 await page.getByRole('button',{name:'Save',exact:true}).click();
 const id=await row(page,'Better UI/UX').locator('option').filter({hasText:'Design'}).getAttribute('value');
 await row(page,'Better UI/UX').getByRole('combobox').selectOption(id);
 await page.getByRole('searchbox',{name:'Find saved sessions'}).fill('photo');
 await expect(page.locator('#csf-panel .csf-session')).toHaveCount(1);
 await page.getByRole('searchbox',{name:'Find saved sessions'}).fill('');
 await page.getByRole('button',{name:'Delete Design',exact:true}).click();
 await expect(row(page,'Better UI/UX').getByRole('combobox')).toHaveValue('');
 await expect(page.locator('nav>div>a[href="/local/aaa-111"]')).toHaveCount(1);
 await expect(page.locator('[data-native=menu]')).toBeVisible();
 await expect(page.getByRole('button',{name:'Toggle Unfiled',exact:true})).toContainText('(4)');
});

test('handles dynamically mounted sidebar, virtualized rows, renames and remounts',async({page})=>{
 await page.evaluate(()=>{const nav=document.querySelector('nav');const d=document.createElement('div');const a=document.createElement('a');a.href='/local/lazy-555';a.textContent='Older loaded task';d.append(a);nav.append(d);});
 await expect(row(page,'Older loaded task')).toHaveCount(1);
 await page.evaluate(()=>document.querySelector('nav>div>a[href="/local/lazy-555"]').parentElement.remove());
 await expect(row(page,'Older loaded task')).toHaveCount(1);
 await page.evaluate(()=>document.querySelector('nav>div>a[href="/local/aaa-111"]').textContent='Renamed native task');
 await expect(row(page,'Renamed native task')).toHaveCount(1);
 await page.evaluate(()=>{const host=document.querySelector('aside');const copy=host.cloneNode(true);copy.querySelector('#csf-panel').remove();host.replaceWith(copy);});
 await expect(page.locator('#csf-panel')).toHaveCount(1);
 await expect(row(page,'Older loaded task')).toHaveCount(1);
 await page.evaluate(()=>document.querySelector('#csf-panel').remove());
 await expect(page.locator('#csf-panel')).toHaveCount(1);
});

test('exports and restores real chrome storage; rejects malicious URLs and renders labels as text',async({page})=>{
 await folder(page,'<img src=x onerror=alert(1)>');
 const downloadP=page.waitForEvent('download');await page.getByRole('button',{name:'Export folder backup'}).click();
 const download=await downloadP;const exported=JSON.parse(await fs.readFile(await download.path(),'utf8'));
 expect(exported.version).toBe(1);expect(Object.keys(exported.sessions)).toHaveLength(4);
 const raw={version:1,folders:[{id:'f-test',name:'Imported'}],assignments:{'/local/aaa-111':'f-test'},sessions:{'/local/aaa-111':{title:'<script>alert(1)</script>'},'javascript:alert(1)':{title:'Unsafe'},'https://evil.example/local/abc':{title:'Evil'}},collapsed:{}};
 page.on('dialog',d=>d.accept());
 await page.locator('#csf-panel input[type=file]').setInputFiles({name:'backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(raw))});
 await expect(page.getByRole('button',{name:'Toggle Imported',exact:true})).toBeVisible();
 await expect(page.locator('#csf-panel a[href^="javascript:"]')).toHaveCount(0);
 await expect(page.locator('#csf-panel img,#csf-panel script')).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Toggle Imported',exact:true})).toContainText('(1)');
 await page.reload();await expect(row(page,'Better UI/UX').getByRole('combobox')).toHaveValue('f-test');
 await page.locator('#csf-panel input[type=file]').setInputFiles({name:'bad.json',mimeType:'application/json',buffer:Buffer.from('{broken')});
 await expect(page.getByRole('status')).toContainText('Import failed');
});

test('multiple tabs observe storage changes and keyboard can create a folder',async({page,context})=>{
 const second=await context.newPage();await second.goto('https://chatgpt.com/local/bbb-222');
 await expect(second.locator('#csf-panel')).toBeVisible();
 await page.getByRole('button',{name:'Create folder',exact:true}).focus();await page.keyboard.press('Enter');
 await page.getByRole('textbox',{name:'Folder name',exact:true}).fill('Keyboard folder');await page.keyboard.press('Enter');
 await expect(second.getByRole('button',{name:'Toggle Keyboard folder',exact:true})).toBeVisible();
});

test('captures preview and leaves native controls interactive',async({page})=>{
 await folder(page,'Verdesakay'); await folder(page,'Research');
 await page.locator('#csf-panel .csf-session').filter({hasText:'Better UI/UX'}).getByRole('combobox').selectOption({label:'Verdesakay'});
 await page.locator('#csf-panel .csf-session').filter({hasText:'CRM research'}).getByRole('combobox').selectOption({label:'Research'});
 await page.locator('[data-native=menu]').click();
 await fs.mkdir(path.resolve(__dirname,'../test-results'),{recursive:true});
 const colors=await page.locator('#csf-panel').evaluate(n=>({bg:getComputedStyle(n).backgroundColor,fg:getComputedStyle(n).color}));
 expect(colors.bg).not.toBe(colors.fg);
 expect(colors.bg).not.toBe('rgb(255, 255, 255)');
 await page.screenshot({path:path.resolve(__dirname,'../test-results/preview.png'),fullPage:true});
 await page.evaluate(()=>document.documentElement.style.colorScheme='light');
 await expect.poll(()=>page.locator('#csf-panel').evaluate(n=>getComputedStyle(n).backgroundColor)).toBe('rgb(255, 255, 255)');
 await expect.poll(()=>page.locator('#csf-panel').evaluate(n=>getComputedStyle(n).color)).toBe('rgb(0, 0, 0)');
});

test('waits for a late sidebar and ignores ordinary conversation-body links',async({context})=>{
 const p=await context.newPage();
 await p.route('https://chatgpt.com/local/delayed',r=>r.fulfill({contentType:'text/html',body:'<html><body><main><a href="/local/body-only">body link</a></main></body></html>'}));
 await p.goto('https://chatgpt.com/local/delayed');
 await expect(p.locator('#csf-panel')).toHaveCount(0);
 await p.evaluate(()=>{const aside=document.createElement('aside');const a=document.createElement('a');a.href='/local/late-session';a.textContent='Late sidebar task';aside.append(a);document.body.prepend(aside);});
 await expect(p.locator('#csf-panel')).toBeVisible();
 await expect(row(p,'Late sidebar task')).toHaveCount(1);
 await expect(p.locator('#csf-panel')).not.toContainText('body link');
});
