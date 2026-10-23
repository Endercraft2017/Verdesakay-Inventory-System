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
 await expect(page.locator('#csf-panel')).toBeVisible(); await page.getByRole('button',{name:'Toggle session folders',exact:true}).click(); await use(page);
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
 await expect.poll(()=>page.locator('#csf-panel').evaluate(n=>getComputedStyle(n).colorScheme)).toBe('light');
 await expect.poll(()=>page.locator('#csf-panel').evaluate(n=>getComputedStyle(n).color)).toBe('rgb(0, 0, 0)');
});

test('waits for a late sidebar and ignores ordinary conversation-body links',async({context})=>{
 const p=await context.newPage();
 await p.route('https://chatgpt.com/local/delayed',r=>r.fulfill({contentType:'text/html',body:'<html><body><main><a href="/local/body-only">body link</a></main></body></html>'}));
 await p.goto('https://chatgpt.com/local/delayed');
 await expect(p.locator('#csf-panel')).toHaveCount(0);
 await p.evaluate(()=>{const aside=document.createElement('aside');aside.style.cssText='width:340px;min-height:200px';const a=document.createElement('a');a.href='/local/late-session';a.textContent='Late sidebar task';aside.append(a);document.body.prepend(aside);});
 await expect(p.locator('#csf-panel')).toBeVisible();
 await p.getByRole('button',{name:'Toggle session folders',exact:true}).click();
 await expect(row(p,'Late sidebar task')).toHaveCount(1);
 await expect(p.locator('#csf-panel')).not.toContainText('body link');
});


test('regression: separate global rail, chat sidebar and main; compact default, boundaries, hide and restore',async({context})=>{
 const p=await context.newPage();await p.setViewportSize({width:1600,height:960});
 await p.route('https://chatgpt.com/local/layout-check',r=>r.fulfill({contentType:'text/html',body:`<!doctype html><html style="color-scheme:dark"><head><meta charset="utf-8"><style>
 body{margin:0;font:14px system-ui;background:#111;color:#eee}#sidebar-wrapper{position:fixed;left:0;top:0;width:620px;height:100vh;z-index:5;pointer-events:none}#global-rail{position:fixed;left:0;width:64px;height:100vh;pointer-events:auto;background:#151515}#chat-history{position:fixed;left:80px;width:340px;height:100vh;overflow:auto;pointer-events:auto;background:#181818;padding:12px;box-sizing:border-box}#chat-history a{display:block;color:inherit;padding:9px}main{margin-left:450px;padding:24px}#sidebar-wrapper div{min-width:0}
 </style></head><body><div id="sidebar-wrapper"><nav id="global-rail"><a href="/">Home</a></nav><aside id="chat-history"><h2>Codex</h2><button>New chat</button><h3>Recents</h3><div><a href="/local/one">Better UI/UX</a><a href="/local/two">Mobile task</a></div></aside></div><main><h1>Conversation remains clear</h1><button id="native-control">Native conversation control</button></main></body></html>`}));
 await p.goto('https://chatgpt.com/local/layout-check');
 const panel=p.locator('#csf-panel');await expect(panel).toBeVisible();
 await expect(p.locator('#chat-history #csf-panel')).toHaveCount(1);
 await expect(p.locator('#global-rail #csf-panel')).toHaveCount(0);
 await expect(p.getByRole('button',{name:'Toggle session folders',exact:true})).toHaveAttribute('aria-expanded','false');
 const compact=await panel.boundingBox();expect(compact.height).toBeLessThan(60);
 await expect(p.getByRole('searchbox')).toBeHidden();
 await p.locator('#native-control').click();
 await fs.mkdir(path.resolve(__dirname,'../test-results'),{recursive:true});
 await p.screenshot({path:path.resolve(__dirname,'../test-results/layout-compact.png')});
 await p.getByRole('button',{name:'Toggle session folders',exact:true}).click();
 const bounds=await panel.boundingBox();const host=await p.locator('#chat-history').boundingBox();const main=await p.locator('main').boundingBox();
 expect(bounds.x).toBeGreaterThanOrEqual(host.x);expect(bounds.x+bounds.width).toBeLessThanOrEqual(host.x+host.width);expect(bounds.x+bounds.width).toBeLessThan(main.x);expect(bounds.height).toBeLessThan(440);
 await folder(p,'UI');
 await p.getByRole('button',{name:'Toggle session folders',exact:true}).click();
 await p.reload();await expect(p.getByRole('button',{name:'Toggle session folders',exact:true})).toHaveAttribute('aria-expanded','false');
 await p.evaluate(()=>document.querySelector('#chat-history').style.width='64px');await expect(panel).toHaveCount(0);
 await p.evaluate(()=>document.querySelector('#chat-history').style.width='340px');await expect(panel).toHaveCount(1);
 await p.getByRole('button',{name:'Toggle session folders',exact:true}).click();await expect(p.getByRole('button',{name:'Toggle UI',exact:true})).toBeVisible();
});

test('hide, restore, Escape and reload preserve folders without covering the page',async({page})=>{
 await folder(page,'Keep my folders');
 await page.getByRole('button',{name:'Hide panel',exact:true}).click();
 await expect(page.locator('#csf-panel')).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Show session folders',exact:true})).toBeVisible();
 await page.reload();
 await expect(page.getByRole('button',{name:'Show session folders',exact:true})).toBeVisible();
 await expect(page.locator('#csf-panel')).toHaveCount(0);
 await page.getByRole('button',{name:'Show session folders',exact:true}).click();
 await expect(page.getByRole('button',{name:'Toggle Keep my folders',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Hide panel',exact:true}).focus();await page.keyboard.press('Escape');
 await expect(page.locator('#csf-panel')).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Show session folders',exact:true})).toBeFocused();
});

test('floating panel moves and resizes with real pointers, survives reload, fits smaller viewport',async({page})=>{
 await folder(page,'Verdesakay');await folder(page,'Research');
 await page.getByRole('button',{name:'Float panel',exact:true}).click();
 const panel=page.locator('#csf-panel');await expect(panel).toHaveAttribute('data-mode','floating');
 const before=await panel.boundingBox();
 const grip=await page.getByRole('button',{name:'Move panel',exact:true}).boundingBox();
 await page.mouse.move(grip.x+grip.width/2,grip.y+grip.height/2);await page.mouse.down();await page.mouse.move(grip.x+grip.width/2+190,grip.y+grip.height/2+100,{steps:10});await page.mouse.up();
 const moved=await panel.boundingBox();expect(moved.x).toBeGreaterThan(before.x+150);expect(moved.y).toBeGreaterThan(before.y+70);
 const handle=await page.getByRole('button',{name:'Resize panel',exact:true}).boundingBox();
 await page.mouse.move(handle.x+handle.width/2,handle.y+handle.height/2);await page.mouse.down();await page.mouse.move(handle.x+handle.width/2+90,handle.y+handle.height/2+60,{steps:10});await page.mouse.up();
 const resized=await panel.boundingBox();expect(resized.width).toBeGreaterThan(moved.width+70);expect(resized.height).toBeGreaterThan(moved.height+40);
 await page.reload();await expect(panel).toHaveAttribute('data-mode','floating');
 const restored=await panel.boundingBox();expect(Math.abs(restored.x-resized.x)).toBeLessThan(2);expect(Math.abs(restored.width-resized.width)).toBeLessThan(2);
 await page.screenshot({path:path.resolve(__dirname,'../test-results/floating-glass.png'),fullPage:true});
 await page.setViewportSize({width:400,height:400});
 await expect.poll(async()=>{const r=await panel.boundingBox();return r.x+r.width<=400 && r.y+r.height<=400 && r.x>=0 && r.y>=0;}).toBe(true);
 await expect(page.getByRole('button',{name:'Hide panel',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Hide panel',exact:true}).click();await expect(page.getByRole('button',{name:'Show session folders',exact:true})).toBeVisible();
});

test('keyboard geometry, docking and restore when the native sidebar disappears',async({page})=>{
 await folder(page,'Portable');await page.getByRole('button',{name:'Float panel',exact:true}).click();
 const panel=page.locator('#csf-panel');const before=await panel.boundingBox();
 await page.getByRole('button',{name:'Move panel',exact:true}).focus();await page.keyboard.press('ArrowRight');
 await expect.poll(async()=>Math.round((await panel.boundingBox()).x)).toBe(Math.round(before.x+12));
 await page.getByRole('button',{name:'Resize panel',exact:true}).focus();await page.keyboard.press('ArrowRight');
 await expect.poll(async()=>Math.round((await panel.boundingBox()).width)).toBe(Math.round(before.width+12));
 await page.getByRole('button',{name:'Dock panel',exact:true}).click();
 await expect(page.locator('aside #csf-panel')).toHaveCount(1);await expect(panel).toHaveAttribute('data-mode','docked');
 await page.evaluate(()=>document.querySelector('aside').remove());
 await expect(panel).toHaveCount(0);await expect(page.getByRole('button',{name:'Show session folders',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Show session folders',exact:true}).click();
 await expect(panel).toHaveAttribute('data-mode','floating');await expect(page.getByRole('button',{name:'Toggle Portable',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Dock panel',exact:true}).click();await expect(page.getByRole('status')).toContainText('Open the chat sidebar');
});
