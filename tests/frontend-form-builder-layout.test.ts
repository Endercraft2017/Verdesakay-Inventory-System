import { it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
it('keeps optional settings collapsed while preserving generated IDs, fields and form creation', async () => {
  const dom = new JSDOM('<div id="view"></div><div id="modal-root"></div><div id="toasts"></div>', { runScripts: 'outside-only', url: 'https://localhost/' }); const w = dom.window as any; let render: any; let created: any;
  w.App = { register: (_n: string, fn: any) => { render = fn; }, hasPermission: () => true };
  w.API = { get: async () => [], post: async (_p: string, body: any) => { created = body; return { id: 1 }; } };
  w.eval(['ui.js','lib/data-forms.js', 'lib/form-print.js', 'lib/form-connections.js', 'lib/form-math.js', 'lib/form-items.js', 'lib/form-validation.js','modules/core/form-builder.js'].map(s=>fs.readFileSync(path.join(import.meta.dirname,'../public/js',s),'utf8')).join('\n;\n'));
  await render(w.document.querySelector('#view'), { scope: 'hr' }); await new Promise(r => setTimeout(r, 0));
  const open = [...w.document.querySelectorAll('button')].find((b:any)=>b.textContent.includes('New Form')) as any; expect(open).toBeTruthy(); open.click();
  expect(w.document.querySelector('.fb-advanced').open).toBe(false); expect(w.document.querySelector('#fb-panel-automation').hidden).toBe(true); w.document.querySelector('[data-setup-tab=automation]').click(); expect(w.document.querySelector('.fb-actions').open).toBe(true); w.document.querySelector('[data-setup-tab=details]').click(); expect(w.document.querySelector('.fb-advanced summary button,.fb-advanced summary [role=button]')).toBeNull(); expect(w.document.querySelector('.fb-advanced').textContent).toContain('The form ID is generated from its name.');
  const name = w.document.querySelector('[data-f="name"]'); name.value = 'Team Request'; name.dispatchEvent(new w.Event('input', { bubbles: true })); expect(w.document.querySelector('[data-f="slug"]').value).toBe('team_request');
  w.document.querySelector('[data-confirm]').click(); for(let i=0;i<8;i++)await new Promise(r=>setTimeout(r,0));
  expect(created).toMatchObject({ name: 'Team Request', slug:'team_request', number_prefix:'FM', icon:'file', scope:'hr', fields:[], actions:[] }); expect(w.document.querySelector('.modal-overlay')).toBeNull(); dom.window.close();
});
