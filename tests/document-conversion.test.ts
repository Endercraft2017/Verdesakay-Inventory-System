import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import JSZip from 'jszip';
import { exportDocx, importDocx } from '../src/core/document-conversion';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';
const options={name:'Conversion audit',widthMm:210,heightMm:297,marginMm:14};
const image='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=';
describe('DOCX document conversion',()=>{
 it('exports real Word structures, formatting, links, merged tables and embedded images',async()=>{
  const body=`<h1>Heading</h1><p style="text-align:center;margin-bottom:16px"><strong>Bold</strong> <em>Italic</em> {{employee_name}} <a href="https://example.com">Link</a></p><ol><li>One</li><li>Two</li></ol><table><thead><tr><th colspan="2">Header</th></tr></thead><tbody><tr><td>A</td><td>B</td></tr></tbody></table><p><img src="data:image/png;base64,${image}" alt="Pixel" style="width:40px;height:20px"></p>`;
  const result=await exportDocx({...options,body});expect(result.warnings).toEqual([]);const zip=await JSZip.loadAsync(result.buffer);const xml=await zip.file('word/document.xml')!.async('string');
  expect(xml).toContain('Heading1');expect(xml).toContain('<w:b');expect(xml).toContain('<w:i');expect(xml).toContain('{{employee_name}}');expect(xml).toContain('w:numPr');expect(xml).toContain('w:gridSpan w:val="2"');expect(xml).toContain('w:tblHeader');expect(xml).toContain('Pixel');
  const imported=await importDocx(result.buffer);expect(imported.body).toContain('<h1>Heading</h1>');expect(imported.body).toContain('Bold');expect(imported.body).toContain('{{employee_name}}');expect(imported.body).toContain('<table class="doc-table">');expect(imported.body).toContain('data:image/png;base64,');
 });
 it('keeps heading bookmark targets through Word export and import',async()=>{
  const result=await exportDocx({...options,body:'<div><p>Contents</p><a href="#doc-heading-example">Overview</a></div><h1 id="doc-heading-example" style="font-size:24px;color:#2b7fff">Overview</h1>'});const zip=await JSZip.loadAsync(result.buffer);const xml=await zip.file('word/document.xml')!.async('string');expect(xml).toContain('w:anchor="doc_heading_example"');expect(xml).toContain('w:name="doc_heading_example"');expect(xml).toContain('w:sz w:val="36"');expect(xml).toContain('2b7fff');const imported=await importDocx(result.buffer);expect(imported.body).toContain('href="#doc-heading-import-1"');expect(imported.body).toContain('id="doc-heading-import-1"');
 });
 it('maps saved table appearance and row settings into Word',async()=>{
  const result=await exportDocx({...options,body:'<table class="doc-table shaded" style="width:80%;margin-left:auto;margin-right:auto"><thead><tr><th>Header</th></tr></thead><tbody><tr style="height:40px;break-inside:avoid"><td style="padding:12px;border:2px dashed #2b7fff;vertical-align:middle">Cell</td></tr></tbody></table>'});const zip=await JSZip.loadAsync(result.buffer);const xml=await zip.file('word/document.xml')!.async('string');expect(xml).toContain('w:w="80%"');expect(xml).toContain('16243D');expect(xml).toContain('FFFFFF');expect(xml).toContain('w:val="dashed"');expect(xml).toContain('w:sz="12"');expect(xml).toContain('w:cantSplit');expect(xml).toContain('w:hRule="atLeast"');expect(xml).toContain('w:vAlign w:val="center"');
 });
 it('reports template control blocks that cannot remain editable Word logic',async()=>{
  const result=await exportDocx({...options,body:'<table><tbody>{{#items}}<tr><td>{{name}}</td></tr>{{/items}}</tbody></table>'});expect(result.warnings.join(' ')).toContain('not preserved as editable logic in Word');expect(result.warnings.join(' ')).toContain('Export HTML');
 });
 it('reports loss of freeform positioning and linked images instead of fetching external resources',async()=>{
  const result=await exportDocx({...options,body:'<div class="doc-float" style="position:absolute;rotate:20deg"><p>Object</p></div><p><img src="http://127.0.0.1/private" alt="External"></p>'});expect(result.warnings.join(' ')).toMatch(/Floating objects/);expect(result.warnings.join(' ')).toMatch(/Linked or unsupported images/);
 });
 it('rejects invalid or oversized expanded DOCX archives',async()=>{
  await expect(importDocx(Buffer.from('not a zip'))).rejects.toThrow();const zip=new JSZip();zip.file('word/document.xml','x'.repeat(16*1024*1024));await expect(importDocx(await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}))).rejects.toThrow(/large when expanded/);
 });
 it('removes unsafe hyperlink targets from imported Word documents',async()=>{
  const base=await exportDocx({...options,body:'<p><a href="https://example.com">Link text</a></p>'});const zip=await JSZip.loadAsync(base.buffer);const rel=zip.file('word/_rels/document.xml.rels')!;zip.file(rel.name,(await rel.async('string')).replace('https://example.com','javascript:alert(1)'));
  const imported=await importDocx(await zip.generateAsync({type:'nodebuffer'}));expect(imported.body).toContain('Link text');expect(imported.body).not.toContain('javascript:');
 });
});
let ctx:TestContext,token:string,employeeToken:string,templateId:number;
beforeAll(async()=>{ctx=await setupApp();token=await login(ctx.api);employeeToken=(await createEmployee(ctx.api,token,{username:'conversion_employee',role:'warehouse'})).token;templateId=(await ctx.api.get('/api/templates').set('Authorization','Bearer '+token)).body[0].id;});afterAll(()=>cleanup(ctx));
describe('authorized DOCX workflows',()=>{
 it('exports and imports through the document identity without modifying the saved template',async()=>{
  const before=(await ctx.api.get('/api/templates/'+templateId).set('Authorization','Bearer '+token)).body;
  const result=await ctx.api.post(`/api/templates/studio/documents/template:${templateId}/export-docx`).set('Authorization','Bearer '+token).send({...options,body:'<h1>Unsaved draft</h1><p>Body text</p>'});expect(result.status).toBe(200);expect(result.body.filename).toBe('Conversion audit.docx');
  const imported=await ctx.api.post(`/api/templates/studio/documents/template:${templateId}/import-docx`).set('Authorization','Bearer '+token).attach('file',Buffer.from(result.body.data,'base64'),'source.docx');expect(imported.status).toBe(200);expect(imported.body.body).toContain('Unsaved draft');expect(imported.body.warnings.length).toBeGreaterThan(0);
  expect((await ctx.api.get('/api/templates/'+templateId).set('Authorization','Bearer '+token)).body.body).toBe(before.body);
 });
 it('enforces editor permissions before accepting conversion and rejects malformed uploads',async()=>{
  const path=`/api/templates/studio/documents/template:${templateId}`;
  expect((await ctx.api.post(path+'/export-docx').set('Authorization','Bearer '+employeeToken).send({...options,body:'Text'})).status).toBe(403);
  expect((await ctx.api.post(path+'/import-docx').set('Authorization','Bearer '+employeeToken).attach('file',Buffer.from('x'),'x.docx')).status).toBe(403);
  expect((await ctx.api.post(path+'/import-docx').set('Authorization','Bearer '+token).attach('file',Buffer.from('x'),'x.docx')).status).toBe(400);
  expect((await ctx.api.post(path+'/import-docx').set('Authorization','Bearer '+token).attach('file',Buffer.alloc(8*1024*1024+1),'large.docx')).status).toBe(413);
 });
});

describe('structured Word export',()=>{
 it('exports genuine revisions, footnotes, running fields, semantic styles and section columns',async()=>{
  const cfg=JSON.stringify({trackChanges:true,styles:{normal:{name:'Company body',font:'Arial',size:14,color:'#123456',line:1.5,after:10}}}).replaceAll('"','&quot;');
  const body=`<div data-doc-settings data-doc-config="${cfg}"></div><div class="doc-running-header">Company header</div><div class="doc-running-footer">Confidential</div><span class="doc-page-number"></span><p data-doc-style="normal">Keep <del data-doc-change="c" data-doc-author="Sam" data-doc-date="2026-10-10T12:00:00Z">old</del><ins data-doc-change="c" data-doc-author="Sam" data-doc-date="2026-10-10T12:00:00Z">new</ins><a data-doc-note-ref="n1">1</a></p><div data-doc-section="s" data-doc-section-break="page" data-doc-section-width="215.9" data-doc-section-height="279.4" data-doc-section-margin="10" style="column-count:2;column-gap:8mm"><p>Section content</p></div><div data-doc-notes><p data-doc-footnote="n1"><span data-doc-note-text>Source text</span></p></div>`;
  const result=await exportDocx({...options,body}),zip=await JSZip.loadAsync(result.buffer),xml=await zip.file('word/document.xml')!.async('string');expect(xml).toContain('<w:ins');expect(xml).toContain('<w:del');expect(xml).toContain('w:author="Sam"');expect(xml).toContain('w:footnoteReference');expect(xml).toContain('Studio_normal');expect(xml).toContain('w:num="2"');expect(xml).toContain('w:w="12240"');expect(xml.match(/<w:sectPr/g)).toHaveLength(2);expect(await zip.file('word/footnotes.xml')!.async('string')).toContain('Source text');expect(await zip.file('word/styles.xml')!.async('string')).toContain('Company body');expect(await zip.file('word/header1.xml')!.async('string')).toContain('Company header');expect(await zip.file('word/footer1.xml')!.async('string')).toContain('NUMPAGES');
 });
});
it('exports contents as an actual Word field instead of guessed page numbers',async()=>{const result=await exportDocx({...options,body:'<div data-doc-toc><p>Contents</p><a href="#doc-heading-one">One</a></div><h1 id="doc-heading-one">One</h1><p>Text</p>'}),zip=await JSZip.loadAsync(result.buffer),xml=await zip.file('word/document.xml')!.async('string');expect(xml).toContain('TOC');expect(xml).toContain('w:fldChar');expect(result.warnings.join(' ')).toContain('refreshes the contents field');});
it('does not add a blank Word page for page CSS before a multipage design',async()=>{const result=await exportDocx({...options,body:'<style data-docpage>@page{size:210mm 297mm;margin:14mm}</style><div data-doc-design-page="a"><h1>Cover</h1></div><div data-doc-design-page="b"><h1>Details</h1></div>'}),zip=await JSZip.loadAsync(result.buffer),xml=await zip.file('word/document.xml')!.async('string');expect(xml.match(/<w:sectPr/g)).toHaveLength(2);});

it('exports explicit bold/italic resets, highlight and formatted revision runs',async()=>{
 const body='<p><strong><em><span data-doc-run="inline" style="font-weight:normal;font-style:normal">Regular</span></em></strong><span data-doc-run="inline" style="background-color:#ffff00">Highlight</span><ins data-doc-change="r" data-doc-author="Reviewer" data-doc-date="2026-10-12T01:00:00Z"><span data-doc-run="inline" style="font-weight:bold;font-family:Georgia;font-size:18pt;color:#ff0000">Reviewed</span> plain</ins><del data-doc-change="d" data-doc-author="Reviewer">Removed</del></p>';
 const result=await exportDocx({...options,body}),zip=await JSZip.loadAsync(result.buffer),xml=await zip.file('word/document.xml')!.async('string');
 expect(xml).toContain('<w:b w:val="false"');expect(xml).toContain('<w:i w:val="false"');expect(xml).toContain('w:fill="ffff00"');expect(xml).toContain('w:author="Reviewer"');expect(xml).toMatch(/<w:ins[^>]*>[\s\S]*?<w:b\/>[\s\S]*?Reviewed/);expect(xml).toContain('w:ascii="Georgia"');expect(xml).toContain('w:sz w:val="36"');expect(xml).toContain('ff0000');const deletion=xml.match(/<w:del\b[\s\S]*?<\/w:del>/)![0];expect(deletion).toContain('Removed');expect(deletion).not.toContain('<w:strike');
});

it('exports model decoration lines and structurally removed decorations without changing field bindings',async()=>{
 const body='<p><u><s>Before </s></u><span data-keep="yes"><s><span data-doc-run="inline">middle</span></s></span><u><s> after</s></u><span data-doc-run="inline" style="text-decoration-line:underline line-through">{{employee.name}}</span></p>';
 const result=await exportDocx({...options,body}),zip=await JSZip.loadAsync(result.buffer),xml=await zip.file('word/document.xml')!.async('string');
 const runs=xml.match(/<w:r>[\s\S]*?<\/w:r>/g)!;const middle=runs.find(run=>run.includes('middle'))!,field=runs.find(run=>run.includes('{{employee.name}}'))!;
 expect(middle).toContain('<w:strike');expect(middle).not.toContain('<w:u ');expect(field).toContain('<w:u ');expect(field).toContain('<w:strike');expect(xml).toContain('Before ');expect(xml).toContain(' after');
});

it('exports script overrides without leaving both super/sub flags and retains cleared character defaults',async()=>{
 const body='<p style="font-size:18pt"><sup>Raised<sub>Lowered</sub><span style="vertical-align:baseline">Baseline</span></sup><span data-doc-run="inline" style="font-weight:normal;font-style:normal;font-size:18pt;background-color:#00000000">Clear</span></p>';
 const result=await exportDocx({...options,body}),zip=await JSZip.loadAsync(result.buffer),xml=await zip.file('word/document.xml')!.async('string'),runs=xml.match(/<w:r>[\s\S]*?<\/w:r>/g)!;
 const raised=runs.find(run=>run.includes('Raised'))!,lowered=runs.find(run=>run.includes('Lowered'))!,baseline=runs.find(run=>run.includes('Baseline'))!,clear=runs.find(run=>run.includes('Clear'))!;
 expect(raised).toContain('superscript');expect(lowered).toContain('subscript');expect(lowered).not.toContain('superscript');expect(baseline).not.toContain('superscript');expect(baseline).not.toContain('subscript');expect(clear).toContain('w:sz w:val="36"');expect(clear).toContain('<w:b w:val="false"');expect(clear).not.toContain('w:shd');
});
