import {describe,it,expect} from 'vitest';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
const source=fs.readFileSync(new URL('../public/js/doc-model.js',import.meta.url),'utf8');
const mod:any={exports:{}};new Function('module',source)(mod);const model=mod.exports;
function withDocument(fn:(doc:Document)=>void){const dom=new JSDOM('<div id="root"></div>');try{fn(dom.window.document);}finally{dom.window.close();}}
const body='<style data-docpage>@page{size:210mm 297mm;margin:14mm}.x{color:{{color}}}</style><!--keep--><section data-doc-section="s" data-doc-section-width="210"><div data-doc-design-page="p1" data-doc-page-bg="#fff"><h1 data-doc-node="title">Title {{ name }}</h1><p style="color:red" data-custom="keep"><ins data-doc-change="r" data-doc-author="Editor">Added</ins><del data-doc-change="r">Old</del><a data-doc-note-ref="n" href="#n">1</a></p><table><tbody>{{#items}}<tr><td rowspan="2">{{name}}</td><td>{{=sum(items.total)}}</td></tr>{{/items}}<tr><td colspan="2">Total</td></tr></tbody></table><img src="{{company.logo}}" alt="Logo"><svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg><custom-tag data-key="x">Unknown</custom-tag></div></section>';
describe('document model HTML preservation',()=>{
 it('preserves fields, row loops, design/section metadata, revisions, raw CSS and unfamiliar HTML',()=>withDocument(doc=>{
  const tree=model.fromHtml(body,doc),html=model.toHtml(tree);expect(tree.version).toBe(1);
  expect(html.match(/\{\{[^}]+\}\}/g)).toEqual(body.match(/\{\{[^}]+\}\}/g));
  expect(html).toContain('<tbody>{{#items}}<tr>');expect(html).toContain('</tr>{{/items}}<tr>');
  for(const text of ['data-doc-design-page="p1"','data-doc-change="r"','rowspan="2"','colspan="2"','data-custom="keep"','<svg','<custom-tag','<!--keep-->'])expect(html).toContain(text);
  expect(model.toHtml(model.fromHtml(html,doc))).toBe(html);
 }));
 it('preserves quoted attribute delimiters and unfamiliar marker comments',()=>withDocument(doc=>{
  const html='<p data-info="x > {{name}}">Body {{name}}</p><!--doc-model-field:%3Cscript%3Ebad%3C%2Fscript%3E--><svg><text>{{name}}</text></svg>';
  const result=model.toHtml(model.fromHtml(html,doc));expect(result).toContain('data-info="x &gt; {{name}}"');expect(result).toContain('<!--doc-model-field:%3Cscript%3Ebad%3C%2Fscript%3E-->');expect(result).not.toContain('<script>');expect(result).toContain('<text>{{name}}</text>');expect(result).not.toMatch(/doc-model-field-[a-z0-9]+:/);
 }));
 it('captures editor chips and repeat rows as canonical fields without editor controls',()=>withDocument(doc=>{
  const root=doc.querySelector('#root')!;root.innerHTML='<p>Hello <span class="doc-chip" data-token="name" contenteditable="false">name</span></p><table><tbody><tr data-repeat="items" class="is-repeat"><td>Item</td></tr></tbody></table><div class="doc-float selected" contenteditable="false"><p>Text</p><button class="doc-float-handle">Handle</button></div>';
  const snapshot=model.capture(root),html=model.toHtml(snapshot.document);
  expect(html).toContain('Hello {{name}}');expect(html).toContain('{{#items}}<tr');expect(html).not.toMatch(/contenteditable|doc-chip|Handle|is-repeat|selected/);
 }));
 it('preserves canonical contenteditable and unknown attributes when importing saved HTML',()=>withDocument(doc=>{
  expect(model.toHtml(model.fromHtml('<p contenteditable="false" data-other="yes">Keep</p>',doc))).toContain('contenteditable="false" data-other="yes"');
 }));
});
describe('immutable model paragraph command',()=>{
 it('changes only selected paragraph alignment while preserving unrelated CSS and all model content',()=>withDocument(doc=>{
  const tree=model.fromHtml('<p style="background:url(&quot;data:image/svg+xml;a;b&quot;);color:red;text-align:left">One {{name}}</p><p>Two</p>',doc);
  const before=JSON.stringify(tree),result=model.alignParagraphs(tree,[[0]],'center');
  expect(JSON.stringify(tree)).toBe(before);expect(model.toHtml(result.document)).toContain('color:red');expect(model.toHtml(result.document)).toContain('data:image/svg+xml;a;b');
  expect(model.toHtml(result.document)).toContain('text-align:center');expect(model.toHtml(result.document)).toContain('One {{name}}');expect(result.document.children[1]).toEqual(tree.children[1]);
 }));
 it('rejects locked paragraphs and invalid alignment without mutating the input',()=>withDocument(doc=>{
  const tree=model.fromHtml('<section data-doc-locked="true"><p>Locked</p></section>',doc),before=JSON.stringify(tree);
  expect(()=>model.alignParagraphs(tree,[[0,0]],'center')).toThrow('locked');expect(()=>model.alignParagraphs(tree,[[0,0]],'bad')).toThrow('Invalid');expect(JSON.stringify(tree)).toBe(before);
 }));
 it('does not align the next paragraph when a selection ends at its first text offset',()=>withDocument(doc=>{
  const root=doc.querySelector('#root')!;root.innerHTML='<p>First</p><p>Second</p>';const paragraphs=root.querySelectorAll('p'),sel=doc.defaultView!.getSelection()!;sel.setBaseAndExtent(paragraphs[0]!.firstChild!,0,paragraphs[1]!.firstChild!,0);
  model.alignSelection(root,sel,'center');expect(paragraphs[0]!.style.textAlign).toBe('center');expect(paragraphs[1]!.style.textAlign).toBe('');
 }));
 it('patches live attributes without replacing text nodes, selection direction or field chips',()=>withDocument(doc=>{
  const root=doc.querySelector('#root')!;root.innerHTML='<p>Original <span class="doc-chip" data-token="name" contenteditable="false">name</span></p><p>Other</p>';
  const text=root.querySelector('p')!.firstChild!,chip=root.querySelector('.doc-chip'),sel=doc.defaultView!.getSelection()!;sel.setBaseAndExtent(text,8,text,0);
  expect(model.alignSelection(root,sel,'center')).toBe(true);expect(root.querySelector('p')!.firstChild).toBe(text);expect(root.querySelector('.doc-chip')).toBe(chip);expect(sel.anchorOffset).toBe(8);expect(sel.focusOffset).toBe(0);
  expect(model.alignmentActive(root,sel,'center')).toBe(true);expect(root.querySelectorAll('p')[1]!.getAttribute('style')).toBeNull();
 }));
});
