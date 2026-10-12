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

describe('model text ranges and inline formatting',()=>{
 it('formats an immutable backwards text range across runs without changing fields or annotations',()=>withDocument(doc=>{
  const tree=model.fromHtml('<p><a href="https://example.com" data-extra="keep">One</a>{{name}}<ins data-doc-change="r">Two</ins></p>',doc),before=JSON.stringify(tree);
  const range={anchor:{path:[0,2,0],offset:3},focus:{path:[0,0,0],offset:0}},result=model.formatTextRange(tree,range,'font-weight','bold');
  const html=model.toHtml(result.document);expect(JSON.stringify(tree)).toBe(before);expect(html).toContain('href="https://example.com" data-extra="keep"');expect(html).toContain('{{name}}');expect(html).toContain('data-doc-change="r"');expect(html.match(/font-weight:bold/g)).toHaveLength(2);
 }));
 it('preserves a backwards live selection and field-chip identity while applying and toggling formatting',()=>withDocument(doc=>{
  const root=doc.querySelector('#root')!;root.innerHTML='<p>One <span class="doc-chip" data-token="name" contenteditable="false">name</span><a href="#keep">Two</a></p>';
  const chip=root.querySelector('.doc-chip'),link=root.querySelector('a')!,p=root.querySelector('p')!,sel=doc.defaultView!.getSelection()!;sel.setBaseAndExtent(link.firstChild!,3,p.firstChild!,0);
  expect(model.formatSelection(root,sel,'font-weight','bold')).toBe(true);expect(sel.toString()).toBe('One nameTwo');expect(root.querySelector('.doc-chip')).toBe(chip);expect(root.querySelector('a')).toBe(link);expect(root.innerHTML).not.toContain('doc-inline-');expect(model.inlineActive(root,sel,'font-weight')).toBe(true);
  expect(model.formatSelection(root,sel,'font-weight','normal')).toBe(true);expect(model.inlineActive(root,sel,'font-weight')).toBe(false);expect(root.querySelectorAll('[data-doc-run]')).toHaveLength(2);expect(sel.toString()).toBe('One nameTwo');
 }));
 it('formats only the selected part of a text node and keeps surrounding text unchanged',()=>withDocument(doc=>{
  const root=doc.querySelector('#root')!;root.innerHTML='<p>Before middle after</p>';const text=root.querySelector('p')!.firstChild!,sel=doc.defaultView!.getSelection()!;sel.setBaseAndExtent(text,7,text,13);
  model.formatSelection(root,sel,'font-style','italic');expect(root.querySelector('[data-doc-run]')!.textContent).toBe('middle');expect(root.textContent).toBe('Before middle after');expect(sel.toString()).toBe('middle');
 }));
 it('overrides inherited bold and reuses a fully selected model run',()=>withDocument(doc=>{
  const root=doc.querySelector('#root')!;root.innerHTML='<p><strong data-keep="yes">Original</strong></p>';const strong=root.querySelector('strong')!,sel=doc.defaultView!.getSelection()!;sel.selectAllChildren(strong);model.formatSelection(root,sel,'font-weight','normal');
  expect(root.querySelector('strong')).toBe(strong);expect(root.querySelector('[data-doc-run]')!.getAttribute('style')).toContain('font-weight:normal');const text=root.querySelector('[data-doc-run]')!.firstChild!;sel.setBaseAndExtent(text,0,text,8);model.formatSelection(root,sel,'font-style','italic');
  expect(root.querySelectorAll('[data-doc-run]')).toHaveLength(1);expect(sel.toString()).toBe('Original');expect(root.querySelector('strong')!.getAttribute('data-keep')).toBe('yes');
 }));
 it('rejects a locked range without leaving marker comments or changing HTML',()=>withDocument(doc=>{
  const root=doc.querySelector('#root')!;root.innerHTML='<p>One</p><p data-doc-locked="true">Two</p>';const before=root.innerHTML,p=root.querySelectorAll('p'),sel=doc.defaultView!.getSelection()!;sel.setBaseAndExtent(p[0]!.firstChild!,0,p[1]!.firstChild!,3);
  expect(()=>model.formatSelection(root,sel,'font-weight','bold')).toThrow('locked');expect(root.innerHTML).toBe(before);expect(sel.toString()).toBe('OneTwo');
 }));
 it('keeps hidden/deleted review text and opaque objects untouched',()=>withDocument(doc=>{
  const root=doc.querySelector('#root')!;root.innerHTML='<p>One<del data-doc-change="r">Old</del><span data-doc-hidden="true">Hidden</span><svg><text>SVG</text></svg>Two</p>';const sel=doc.defaultView!.getSelection()!;sel.selectAllChildren(root.querySelector('p')!);
  model.formatSelection(root,sel,'color','#ff0000');expect(root.querySelector('del')!.innerHTML).toBe('Old');expect(root.querySelector('[data-doc-hidden]')!.innerHTML).toBe('Hidden');expect(root.querySelector('svg')!.innerHTML).toBe('<text>SVG</text>');expect(root.querySelectorAll('[data-doc-run]')).toHaveLength(2);
 }));
 it('rejects invalid values and positions that split emoji without changing live content',()=>withDocument(doc=>{
  const tree=model.fromHtml('<p>😀 word</p>',doc),point={path:[0,0],offset:1};expect(()=>model.formatTextRange(tree,{anchor:point,focus:{path:[0,0],offset:2}},'font-weight','bold')).toThrow('Unicode');
  const root=doc.querySelector('#root')!;root.innerHTML='<p>😀 word</p>';const text=root.querySelector('p')!.firstChild!,sel=doc.defaultView!.getSelection()!;sel.setBaseAndExtent(text,1,text,2);const before=root.innerHTML;
  expect(()=>model.formatSelection(root,sel,'font-weight','bold')).toThrow('Unicode');expect(root.innerHTML).toBe(before);expect(()=>model.formatTextRange(tree,{anchor:{path:[0,0],offset:0},focus:{path:[0,0],offset:2}},'font-family','bad; color:red')).toThrow('Invalid');
 }));
});
