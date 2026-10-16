import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
const source = fs.readFileSync(new URL('../public/js/modules/core/templates.js', import.meta.url), 'utf8');
const uiSource = fs.readFileSync(new URL('../public/js/ui.js', import.meta.url), 'utf8');
const renderer = fs.readFileSync(new URL('../public/js/doc-template.js', import.meta.url), 'utf8');
const contextSource = fs.readFileSync(new URL('../public/js/doc-context.js', import.meta.url), 'utf8');
const windows: JSDOM[] = [];
afterEach(() => windows.splice(0).forEach((dom) => dom.window.close()));
const flush = () => new Promise((resolve) => setTimeout(resolve,0));
async function setup(permissions = ['templates.edit']) {
  const dom = new JSDOM('<div id="view"></div><div id="toasts"></div><div id="modal-root"></div>', { runScripts:'dangerously', pretendToBeVisual:true }); windows.push(dom);
  const w = dom.window as any; let route: any;
  w.eval(uiSource + ';window.UI=UI;'); w.eval(fs.readFileSync(new URL('../public/js/doc-formula.js', import.meta.url), 'utf8')); w.eval(renderer); w.eval(contextSource);
  const template = { id: 1, name:'Source', type:'generic', period:'2026-10', body:'<p>{{custom_note}}</p>', copies_per_record:2, records_per_page:3, tile_fill:'repeat', tile_continuous:1, repeat_count:7, revision:'a'.repeat(64), updated_at:'2026-10-10' };
  const vars = [{ id:9,scope:'template',template_id:1,key:'custom_note',label:'Note',source_type:'constant',value:'Resolved note',data_type:'text' }];
  const get = vi.fn(async (path: string) => {
    if (path === '/templates') return [template];
    if (path === '/templates/1') return template;
    if (path === '/templates/variables/catalog') return [];
    if (path.startsWith('/templates/variables')) return vars;
    if (path === '/templates/company') return { name:'Company', address:'',phone:'',email:'',logo_url:'' };
    throw new Error('Unexpected API request '+path);
  });
  w.API = { get, post:vi.fn(async () => ({id:2,revision:'c'.repeat(64)})), put:vi.fn(async () => ({revision:'b'.repeat(64)})) };
  const open = vi.fn(); w.DocEditor = {open};
  w.App = {hasPermission:(p: string) => permissions.includes(p),register:(_name: string,fn: any) => {route=fn;}};
  w.eval(source); const view = w.document.querySelector('#view'); await route(view);
  return { w, view, get, open, template };
}
describe('template library integrations', () => {
  it('resolves custom variables in saved-template preview', async () => {
    const {view,w,get} = await setup(); view.querySelector('[data-prev]').click(); await flush();
    expect(get).toHaveBeenCalledWith('/templates/variables?template_id=1');
    expect(w.document.querySelector('#tpl-preview-frame').srcdoc).toContain('Resolved note');
  });
  it('keeps configuration and local variables when opening a copy and saving it', async () => {
    const { view, w, open, template } = await setup(); view.querySelector('#tpl-new').click(); w.document.querySelector('[data-copy="1"]').click(); await flush();
    const options = open.mock.calls[0]![0];
    expect(options).toMatchObject({ name:'Source (copy)',period:'2026-10',copiesPerRecord:2,recordsPerPage:3,tileFill:'repeat',continuous:true,repeatCount:7 });
    expect(options.sampleContext().custom_note).toBe('Resolved note');
    expect(options.onManageVars).toBeUndefined(); // source variables must not be changed while designing a copy
    await options.onSave({ name:options.name,type:options.type,period:options.period,body:template.body,copiesPerRecord:2,recordsPerPage:3,tileFill:'repeat',continuous:true,repeatCount:7 });
    expect(w.API.post).toHaveBeenCalledWith('/templates', expect.objectContaining({source_template_id:1,source_revision:template.revision,repeat_count:7}));
  });
  it('updates the newly created template on a second save instead of creating a duplicate', async () => {
    const { view, w, open } = await setup(); view.querySelector('#tpl-new').click(); w.document.querySelector('[data-starter=""]').click(); await flush();
    const options = open.mock.calls[0]![0];
    const content = {name:'New',type:'generic',body:'<p>Content</p>',copiesPerRecord:1,recordsPerPage:1,tileFill:'blank',continuous:false,repeatCount:1};
    await options.onSave(content); await options.onSave({...content,body:'<p>Second edit</p>'});
    expect(w.API.post).toHaveBeenCalledOnce(); expect(w.API.put).toHaveBeenCalledWith('/templates/2',expect.objectContaining({expected_revision:'c'.repeat(64),body:'<p>Second edit</p>'}));
  });
  it('sends the loaded revision when saving an existing template', async () => {
    const { view, w, open } = await setup(); view.querySelector('[data-edit]').click(); await flush();
    await open.mock.calls[0]![0].onSave({name:'Edited',type:'generic',body:'<p>Edited</p>',copiesPerRecord:1,recordsPerPage:1,tileFill:'blank',continuous:false,repeatCount:1});
    expect(w.API.put).toHaveBeenCalledWith('/templates/1',expect.objectContaining({expected_revision:'a'.repeat(64)}));
  });
  it.each([['templates.edit',true],['templates.company',false]])('uses company permission independently of %s', async (permission, disabled) => {
    const { view, w } = await setup([permission]); view.querySelector('#tpl-company').click(); await flush();
    expect(w.document.querySelector('[data-f="name"]').disabled).toBe(disabled);
  });
});
