import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
const source = fs.readFileSync(new URL('../public/js/doc-editor.js', import.meta.url), 'utf8');
const uiSource = fs.readFileSync(new URL('../public/js/ui.js', import.meta.url), 'utf8');
const renderer = fs.readFileSync(new URL('../public/js/doc-template.js', import.meta.url), 'utf8');
const formula = fs.readFileSync(new URL('../public/js/doc-formula.js', import.meta.url), 'utf8');
const windows: JSDOM[] = [];
afterEach(() => windows.splice(0).forEach(w => w.window.close()));
function setup(extra: any = {}) {
  const dom = new JSDOM('<html><body><div id="toasts"></div><div id="modal-root"></div></body></html>', {url:'https://studio.test', runScripts:'dangerously',pretendToBeVisual:true}); windows.push(dom);
  const w = dom.window as any; w.eval(uiSource + ";window.UI = UI;"); w.UI.confirmDialog=vi.fn(async()=>true);w.eval(formula);w.eval(renderer);w.eval(source);
  w.document.execCommand=vi.fn((cmd: string,_ui: boolean,value:string)=>{if(cmd==='insertHTML'){const surface=w.document.querySelector('.doc-surface');surface.insertAdjacentHTML('beforeend',value);}return true;});
  const opts={documentKey:'template:1',name:'Invoice',body:'<p>Original</p><div class="doc-float" data-float-kind="shape-rect" style="position:absolute;left:10%;top:10%;width:20%;height:10%;z-index:1"><div class="doc-float-shape" style="background:#ccc"></div></div>',getVariables:()=>[{label:'Customer',token:'{{order.customer_name}}'}],sampleContext:{order:{customer_name:'Acme'},items:[{name:'Paper'}]},onSave:()=>true,...extra};
  let editor=w.DocEditor.open(opts);const doc=w.document;
  const tab=(name:string)=>doc.querySelector(`[data-studio-tab="${name}"]`).click();
  const click=(action:string)=>doc.querySelector(`[data-do="${action}"]`).click();
  const change=(selector:string,value:any)=>{const input=doc.querySelector(selector);if(typeof value==='boolean')input.checked=value;else input.value=value;input.dispatchEvent(new w.Event('change',{bubbles:true}));};
  const select=()=>doc.querySelector('.doc-float').dispatchEvent(new w.MouseEvent('click',{bubbles:true}));
  return {w,doc,opts,editor,tab,click,change,select,reopen(){editor=w.DocEditor.open(opts);return editor;}};
}
describe('document studio workflows',()=>{
  it('recovers body, metadata and paper settings after closing without saving, with undo',async()=>{
    const {w,doc,editor,change,tab,click,reopen}=setup();
    change('.doc-fs-name','Recovered');change('.doc-pagesize','custom');change('.doc-custom-w','180');change('.doc-custom-h','250');
    const body=doc.querySelector('.doc-surface');body.querySelector('p').textContent='Draft content';body.dispatchEvent(new w.Event('input',{bubbles:true}));
    await editor.close();const reopened=reopen();tab('History');click('recover');
    expect(doc.querySelector('.doc-fs-name').value).toBe('Recovered');expect(doc.querySelector('.doc-surface').textContent).toContain('Draft content');
    expect(doc.querySelector('.doc-custom-w').value).toBe('180');expect(doc.querySelector('.doc-custom-h').value).toBe('250');
    reopened._history.undo();expect(doc.querySelector('.doc-fs-name').value).toBe('Invoice');expect(doc.querySelector('.doc-surface').textContent).toContain('Original');
  });
  it('stores a successful save as a recoverable checkpoint and clears its draft',async()=>{
    const {w,doc,editor,change,reopen,tab}=setup();change('.doc-fs-name','Saved name');doc.querySelector('[data-save]').click();await new Promise(r=>setTimeout(r,0));await editor.close();reopen();tab('History');
    expect(doc.querySelector('[data-version]')).not.toBeNull();expect(doc.querySelector('[data-do=recover]')).toBeNull();
    [...doc.querySelectorAll('[data-version]')].find((b:any)=>b.textContent.includes('Saved template')).click();expect(doc.querySelector('.doc-fs-name').value).toBe('Saved name');
  });
  it('moves new-template history to its saved identity without leaving a draft behind',async()=>{
    let id: number | null=null;
    const {w,doc,editor,change}=setup({documentKey:'new-template',getDocumentKey:()=>id?'template:'+id:'new-template',onSave:()=>{id=55;return true;}});
    change('.doc-fs-name','Created');doc.querySelector('[data-save]').click();await new Promise(r=>setTimeout(r,0));
    const keys=Object.keys(w.localStorage).filter(k=>k.startsWith('doc-studio:'));
    expect(keys).toHaveLength(1);expect(keys[0]).toMatch(/template:55$/);expect(JSON.parse(w.localStorage.getItem(keys[0])).draft).toBeUndefined();
    await editor.close();
  });
  it('writes a recoverable draft while the editor is still open',async()=>{
    const {w,doc,change}=setup();change('.doc-fs-name','Automatic draft');await new Promise(r=>setTimeout(r,750));
    const key=Object.keys(w.localStorage).find(k=>k.startsWith('doc-studio:'));
    expect(JSON.parse(w.localStorage.getItem(key)).draft.name).toBe('Automatic draft');expect(doc.querySelector('.doc-studio-note').textContent).toContain('Draft saved');
  });
  it('updates object geometry and restores it through undo',()=>{
    const {doc,select,change,editor}=setup();select();change('[data-prop=left]','25');change('[data-prop=width]','35');editor._history.flush();
    expect(doc.querySelector('.doc-float').style.left).toBe('25%');editor._history.undo();expect(doc.querySelector('.doc-float').style.left).toBe('10%');
  });
  it('locks movement and deletion without stealing Delete from sidebar inputs',()=>{
    const {w,doc,tab,select,change}=setup();select();tab('Layers');change('[data-lock]',true);doc.querySelector('[data-layer]').click();
    doc.querySelector('.doc-surface').dispatchEvent(new w.KeyboardEvent('keydown',{key:'Delete',bubbles:true,cancelable:true}));
    expect(doc.querySelector('.doc-float')).not.toBeNull();change('[data-lock]',false);doc.querySelector('[data-layer]').click();
    const input=doc.querySelector('[data-prop=docName]');input.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Delete',bubbles:true,cancelable:true}));expect(doc.querySelector('.doc-float')).not.toBeNull();
  });
  it('nudges selected objects with arrows but allows native input navigation',()=>{
    const {w,doc,select}=setup();select();doc.querySelector('.doc-surface').dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}));expect(doc.querySelector('.doc-float').style.left).toBe('10.1%');
    const event=new w.KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true,cancelable:true});doc.querySelector('[data-prop=left]').dispatchEvent(event);expect(event.defaultPrevented).toBe(false);
  });
  it('keeps object names, lock and hidden state through serialization and print',()=>{
    const {w,doc,tab,select,change}=setup();select();tab('Layers');change('[data-prop=docName]','Logo');change('[data-visible]',false);change('[data-lock]',true);
    const body=w.DocEditor.serializeEditor(doc.querySelector('.doc-surface'));expect(body).toContain('data-doc-name="Logo"');expect(body).toContain('data-doc-hidden="true"');expect(body).toContain('data-doc-locked="true"');expect(body).not.toContain('doc-float-toolbar');
    const output=w.UI.printableHtml(body,'test');expect(output).toContain('[data-doc-hidden="true"]');
  });
  it('keeps sidebar inputs focused when the document selection is unchanged',()=>{
    const {w,doc,select}=setup();select();const p=doc.querySelector('.doc-surface p');const range=doc.createRange();range.selectNodeContents(p);w.getSelection().removeAllRanges();w.getSelection().addRange(range);
    const input=doc.querySelector('[data-prop=left]');input.focus();doc.dispatchEvent(new w.Event('selectionchange'));expect(doc.activeElement).toBe(input);expect(input.isConnected).toBe(true);
  });
  it('does not include temporary controls or page guides when copying document content',()=>{
    const {w,doc,select}=setup();select();const guide=doc.createElement('div');guide.className='doc-page-guide';guide.textContent='Page guide';doc.querySelector('.doc-surface').append(guide);
    const safe=w.DocEditor.sanitizeHtml(doc.querySelector('.doc-surface').innerHTML,doc);expect(safe).not.toContain('Page guide');expect(safe).not.toContain('Bring forward');expect(safe).not.toContain('>Move<');expect(safe).toContain('Original');
  });
  it('stores reusable assets and styles and inserts assets without editor controls',()=>{
    const {doc,select,tab,click}=setup();select();tab('Library');doc.querySelector('[data-library-name]').value='Brand';click('saveAsset');expect(doc.querySelector('[data-asset]')).not.toBeNull();
    doc.querySelector('[data-library-name]').value='Brand style';click('saveStyle');expect(doc.querySelector('[data-style]')).not.toBeNull();doc.querySelector('[data-asset]').click();expect(doc.querySelectorAll('.doc-float')).toHaveLength(2);
  });
  it('inserts repeating and conditional blocks with stable template tokens',()=>{
    const {w,doc,tab,click}=setup();tab('Data');click('repeat');click('conditional');const body=w.DocEditor.serializeEditor(doc.querySelector('.doc-surface'));expect(body).toContain('{{#items}}');expect(body).toContain('{{/items}}');expect(body).toContain('{{#if order.customer_name}}');expect(body).toContain('{{/if}}');
  });
  it('reports mismatched blocks and invalid formulas',()=>{
    const {w,doc,tab,click}=setup({body:'<p>{{#if order.customer_name}}text{{/items}} {{=SUM(}}</p>'});tab('Data');click('validate');expect(doc.querySelector('[data-issues]').textContent).toContain('Unmatched block');expect(doc.querySelector('[data-issues]').textContent).toContain('Formula:');
  });
  it('previews custom and large-table scenarios without changing saved content',()=>{
    const {doc,tab,click,change}=setup({body:'<p>{{order.customer_name}}</p><table><tbody>{{#items}}<tr><td>{{name}}</td></tr>{{/items}}</tbody></table>'});tab('Data');change('[data-scenario]','large');doc.querySelector('[data-preview]').click();
    expect(doc.querySelector('iframe').srcdoc.match(/<tr>/g)).toHaveLength(50);
    doc.querySelector('[data-context]').value='{"order":{"customer_name":"Real customer"},"items":[]}';click('context');expect(doc.querySelector('iframe').srcdoc).toContain('Real customer');expect(doc.querySelector('.doc-surface').textContent).not.toContain('Real customer');
  });
  it('loads real records through the caller and reports failures',async()=>{
    const loader=vi.fn(async(id:number)=>({order:{customer_name:'Record '+id}}));const {doc,tab,click}=setup({loadPreviewRecord:loader,body:'<p>{{order.customer_name}}</p>'});tab('Data');doc.querySelector('[data-record-id]').value='7';click('loadRecord');await new Promise(r=>setTimeout(r,0));doc.querySelector('[data-preview]').click();expect(loader).toHaveBeenCalledWith(7);expect(doc.querySelector('iframe').srcdoc).toContain('Record 7');
  });
  it('prints running headers, footers and page counters with safely escaped text',()=>{
    const {w}=setup();const html=w.UI.printableHtml('<style data-docpage>@page{size:210mm 297mm;margin:14mm}</style><div class="doc-running-header">Brand &lt;/style&gt;</div><div class="doc-running-footer">Footer</div><span class="doc-page-number"></span><p>Body</p>','test');expect(html).toContain('@top-center');expect(html).toContain('counter(page)');expect(html).toContain('counter(pages)');expect(html).not.toContain('content:"Brand </style>');
  });
  it('preserves nested group percentages while converting the outer print geometry',()=>{
    const {w}=setup();const html=w.UI.printableHtml('<style data-docpage>@page{size:210mm 297mm;margin:14mm}</style><div class="doc-float" data-float-kind="group" style="left:10%;width:50%"><div class="doc-float" style="left:20%;width:40%">Child</div></div>','test');const parsed=new JSDOM(html);windows.push(parsed);const floats=parsed.window.document.querySelectorAll('.doc-float') as NodeListOf<HTMLElement>;expect(floats[0]!.style.width).toBe('105mm');expect(floats[1]!.style.width).toBe('40%');
  });
});


describe('balanced document and design tools',()=>{
 it('rotates, fades and centers an object with undoable document properties',()=>{
  const {doc,select,change,click}=setup();select();change('[data-prop="rotate"]','30');change('[data-prop="opacity"]','0.5');
  const object=doc.querySelector('.doc-float');expect(object.style.rotate).toBe('30deg');expect(object.style.opacity).toBe('0.5');
  click('align-center');expect(object.style.left).toBe('40%');
  change('[data-prop="opacity"]','2');expect(object.style.opacity).toBe('0.5');
 });
 it('shows headings in the document outline without modifying their content',()=>{
  const {doc,tab}=setup({body:'<h1>Overview</h1><h2>Details</h2><p>Body text</p>'});tab('Outline');
  expect([...doc.querySelectorAll('[data-outline]')].map((el:any)=>el.textContent)).toEqual(['Overview','Details']);
 });
 it('applies paragraph line spacing and indentation to the selected paragraph',()=>{
  const {w,doc}=setup();const p=doc.querySelector('.doc-surface p');const range=doc.createRange();range.selectNodeContents(p);const selection=w.getSelection();selection.removeAllRanges();selection.addRange(range);p.dispatchEvent(new w.MouseEvent('mouseup',{bubbles:true}));
  doc.querySelector('[data-paragraph]').click();doc.querySelector('#pg-line').value='2';doc.querySelector('#pg-after').value='24';doc.querySelector('#pg-first').value='16';doc.querySelector('#pg-line').closest('.modal-overlay').querySelector('[data-confirm]').click();
  expect(p.style.lineHeight).toBe('2');expect(p.style.marginBottom).toBe('24px');expect(p.style.textIndent).toBe('16px');
 });
});

describe('picture and Word workflows',()=>{
 it('applies crop focal points, masks, filters and alt text without replacing the original image',async()=>{
  const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=';
  const {w,doc,click,editor}=setup({body:`<p><img src="${image}" alt="Original" style="width:300px;height:200px"></p>`});
  doc.querySelector('.doc-surface img').dispatchEvent(new w.MouseEvent('click',{bubbles:true}));click('picture');
  doc.querySelector('#pic-fit').value='cover';doc.querySelector('#pic-mask').value='circle';doc.querySelector('#pic-x').value='75';doc.querySelector('#pic-grayscale').value='100';doc.querySelector('#pic-brightness').value='0';doc.querySelector('#pic-alt').value='New description';
  doc.querySelector('#pic-alt').closest('.modal-overlay').querySelector('[data-confirm]').click();await new Promise(r=>setTimeout(r,0));
  const img=doc.querySelector('.doc-surface img');expect(img.src).toBe(image);expect(img.style.objectFit).toBe('cover');expect(img.style.objectPosition).toBe('75% 50%');expect(img.style.clipPath).toContain('circle');expect(img.style.filter).toContain('grayscale(100%)');expect(img.alt).toBe('New description');
  click('picture');expect(doc.querySelector('#pic-brightness').value).toBe('0');doc.querySelector('#pic-alt').closest('.modal-overlay').remove();editor._history.undo();expect(doc.querySelector('.doc-surface img').alt).toBe('Original');
 });
 it('updates contents links after heading edits and preserves them through serialization',()=>{
  const {w,doc,tab,click}=setup({body:'<h1>Overview</h1><h2>Details {{order.customer_name}}</h2><p>Body</p>'});tab('Outline');click('contents');
  const toc=doc.querySelector('[data-doc-toc]');expect(toc.textContent).toContain('{{order.customer_name}}');expect(toc.querySelectorAll('a')).toHaveLength(2);const heading=doc.querySelector('.doc-surface h2');expect(toc.querySelectorAll('a')[1].getAttribute('href')).toBe('#'+heading.id);
  heading.textContent='Updated section';heading.dispatchEvent(new w.Event('input',{bubbles:true}));expect(toc.textContent).toContain('Updated section');const html=w.DocEditor.serializeEditor(doc.querySelector('.doc-surface'));expect(html).toContain('data-doc-toc');expect(w.DocEditor.sanitizeHtml(html)).toContain(heading.id);
 });
 it('previews a DOCX import then replaces content as an undoable edit',async()=>{
  const {w,doc,editor}=setup();w.API={upload:vi.fn(async()=>({body:'<h1>Imported heading</h1><p>Imported text</p>',warnings:['Review layout']}))};doc.querySelector('[data-file]').click();
  const file=new w.File(['x'],'original.docx');Object.defineProperty(doc.querySelector('[data-import-file]'),'files',{value:[file]});doc.querySelector('[data-import-mode]').value='replace';doc.querySelector('[data-import-convert]').click();await new Promise(r=>setTimeout(r,0));
  expect(doc.querySelector('[data-import-result] iframe').srcdoc).toContain('Imported heading');expect(doc.querySelector('.doc-surface').textContent).toContain('Original');doc.querySelector('[data-import-result]').closest('.modal-overlay').querySelector('[data-confirm]').click();await new Promise(r=>setTimeout(r,0));expect(doc.querySelector('.doc-surface').textContent).toContain('Imported text');editor._history.undo();expect(doc.querySelector('.doc-surface').textContent).toContain('Original');
 });
 it('exports the current unsaved snapshot and reports conversion limitations',async()=>{
  const {w,doc}=setup();w.API={post:vi.fn(async()=>({data:'eA==',filename:'Test.docx',warnings:['Floating objects need review']}))};const surface=doc.querySelector('.doc-surface');surface.querySelector('p').textContent='Unsaved export {{order.customer_name}}';surface.dispatchEvent(new w.Event('input',{bubbles:true}));doc.querySelector('[data-file]').click();doc.querySelector('[data-export-word]').click();await new Promise(r=>setTimeout(r,0));expect(w.API.post.mock.calls[0][1].body).toContain('Unsaved export');expect(doc.querySelector('[data-export-result]').textContent).toContain('Floating objects need review');expect(doc.querySelector('[data-export-result] button').textContent).toContain('Download');expect(w.API.post.mock.calls[0][1].body).toContain('{{order.customer_name}}');doc.querySelector('[data-export-content]').value='preview';doc.querySelector('[data-export-word]').click();await new Promise(r=>setTimeout(r,0));expect(w.API.post.mock.calls[1][1].body).toContain('Acme');expect(w.API.post.mock.calls[1][1].body).not.toContain('{{order.customer_name}}');
 });
});


describe('portable HTML export',()=>{
 it('retains custom CSS, classes and table repeat blocks while removing active HTML',async()=>{
  const {w,doc}=setup({body:'<style>.brand{color:#2b7fff}</style><p class="brand">Brand</p><table class="custom-table"><tbody>{{#items}}<tr><td>{{name}}</td></tr>{{/items}}</tbody></table>'});let captured:any;w.URL.createObjectURL=vi.fn((blob:any)=>{captured=blob;return 'blob:test';});w.URL.revokeObjectURL=vi.fn();w.HTMLAnchorElement.prototype.click=vi.fn();
  doc.querySelector('.doc-surface').insertAdjacentHTML('beforeend','<script>bad()</script><p onclick="bad()">Text</p>');doc.querySelector('[data-file]').click();doc.querySelector('[data-export-html]').click();const html=await new Promise<string>((resolve,reject)=>{const reader=new w.FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=reject;reader.readAsText(captured);});
  expect(html).toContain('.brand{color:#2b7fff}');expect(html).toContain('class="brand"');expect(html).toMatch(/<tbody>\{\{#items\}\}<tr/);expect(html).toContain('{{/items}}</tbody>');expect(html).not.toContain('<script>bad()');expect(html).not.toContain('onclick=');
 });
});

describe('structured document and multipage design tools',()=>{
  const tick=()=>new Promise(r=>setTimeout(r,0));
  it('creates independent pages, switches grids off, copies backgrounds, reorders and undoes',async()=>{
    const save=vi.fn((_value:any)=>true);const {doc,w,tab,editor,change}=setup({body:'<p>Page one</p>',copiesPerRecord:2,recordsPerPage:2,onSave:save});tab('Pages');
    doc.querySelector('[data-adv=page-add]').click();await tick();expect(doc.querySelectorAll('[data-doc-design-page]')).toHaveLength(1);expect(doc.querySelector('.doc-copies').disabled).toBe(false);
    doc.querySelector('[data-adv=page-add]').click();await tick();expect(doc.querySelectorAll('[data-doc-design-page]')).toHaveLength(2);expect(doc.querySelector('.doc-copies').disabled).toBe(true);expect(doc.querySelector('.doc-copies').value).toBe('1');expect(doc.querySelector('.doc-continuous').checked).toBe(false);
    change('[data-adv-page-name]','Back');change('[data-adv-page-bg]','#112233');doc.querySelector('[data-adv=page-copy]').click();await tick();expect(doc.querySelectorAll('[data-doc-design-page]')).toHaveLength(3);expect([...doc.querySelectorAll('[data-doc-design-page]')].at(-1).style.backgroundColor).toBe('rgb(17, 34, 51)');
    doc.querySelector('[data-adv=page-up]').click();await tick();expect(doc.querySelectorAll('[data-doc-design-page]')[1].dataset.docPageName).toBe('Back copy');doc.querySelector('[data-save]').click();await tick();expect(save.mock.calls[0]![0]).toMatchObject({copiesPerRecord:1,recordsPerPage:1,continuous:false});expect(save.mock.calls[0]![0].body).toContain('data-doc-design-page');
    editor._history.undo();expect(doc.querySelectorAll('[data-doc-design-page]')[2].dataset.docPageName).toBe('Back copy');
  });
  it('disables grids on explicit document breaks and restores them with undo',()=>{const {doc,tab,click,editor}=setup({body:'<p>Text</p>',copiesPerRecord:2});tab('Pages');click('pagebreak');expect(doc.querySelector('.doc-copies').disabled).toBe(true);editor._history.undo();expect(doc.querySelector('.doc-copies').disabled).toBe(false);expect(doc.querySelector('.doc-copies').value).toBe('2');});
  it('updates all paragraphs using a named style and persists its definition through sanitizing',async()=>{
    const {doc,w,tab}=setup({body:'<p data-doc-style="normal">First</p><p data-doc-style="normal">Second</p>'});tab('Styles');doc.querySelector('[data-adv=style-edit][data-style-key=normal]').click();doc.querySelector('#ds-size').value='18';doc.querySelector('#ds-color').value='#123456';doc.querySelector('#ds-size').closest('.modal-overlay').querySelector('[data-confirm]').click();await tick();
    expect([...doc.querySelectorAll('[data-doc-style]')].map(p=>p.style.fontSize)).toEqual(['18px','18px']);const html=w.DocEditor.serializeEditor(doc.querySelector('.doc-surface'));expect(html).toContain('data-doc-config');expect(w.DocEditor.sanitizeHtml(html)).toContain('data-doc-style="normal"');
  });
  it('tracks selected text replacement, persists attribution, rejects and undoes review',async()=>{
    const {doc,w,tab,change,editor}=setup({body:'<p>Hello world</p>'});tab('Review');change('[data-adv-author]','Reviewer');change('[data-adv-tracking]',true);const p=doc.querySelector('.doc-surface p'),r=doc.createRange();r.setStart(p.firstChild,6);r.setEnd(p.firstChild,11);w.getSelection().removeAllRanges();w.getSelection().addRange(r);
    p.dispatchEvent(new w.InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'insertText',data:'team'}));expect(p.querySelector('del').textContent).toBe('world');expect(p.querySelector('ins').textContent).toBe('team');expect(p.querySelector('ins').dataset.docAuthor).toBe('Reviewer');const markup=w.DocEditor.serializeEditor(doc.querySelector('.doc-surface'));expect(w.DocEditor.sanitizeHtml(markup)).toContain('data-doc-change');tab('Review');doc.querySelector('[data-adv=review-reject]').click();await tick();expect(p.textContent).toBe('Hello world');expect(doc.querySelector('[data-doc-change]')).toBeNull();editor._history.undo();expect(doc.querySelector('.doc-surface ins').textContent).toBe('team');
  });
  it('accepts tracked edits without deleting unrelated content and prints proposed text',async()=>{const {doc,w,tab}=setup({body:'<p>Keep <del data-doc-change="c1" data-doc-author="A">old</del><ins data-doc-change="c1" data-doc-author="A">new</ins></p>'});const print=w.UI.printableHtml(w.DocEditor.serializeEditor(doc.querySelector('.doc-surface')));expect(print).toContain('del[data-doc-change]{display:none!important}');tab('Review');doc.querySelector('[data-adv=review-all-accept]').click();await tick();expect(doc.querySelector('.doc-surface p').textContent).toBe('Keep new');expect(doc.querySelector('[data-doc-change]')).toBeNull();});
  it('inserts a linked numbered note and round-trips the reference with undo',async()=>{
    const {doc,w,tab,editor}=setup({body:'<p>Statement</p>'});const p=doc.querySelector('.doc-surface p');p.click();const r=doc.createRange();r.selectNodeContents(p);r.collapse(false);w.getSelection().removeAllRanges();w.getSelection().addRange(r);doc.dispatchEvent(new w.Event('selectionchange'));tab('Pages');doc.querySelector('[data-adv=footnote]').click();doc.querySelector('#fn-text').value='Reference source';doc.querySelector('#fn-text').closest('.modal-overlay').querySelector('[data-confirm]').click();await tick();const ref=doc.querySelector('[data-doc-note-ref]'),note=doc.querySelector('[data-doc-footnote]');expect(ref.textContent).toBe('1');expect(ref.getAttribute('href')).toBe('#'+note.id);expect(note.textContent).toContain('Reference source');expect(w.DocEditor.sanitizeHtml(w.DocEditor.serializeEditor(doc.querySelector('.doc-surface')))).toContain(note.id);editor._history.undo();expect(doc.querySelector('[data-doc-note-ref]')).toBeNull();
  });
  it('inserts a section with columns and independent page dimensions and prevents grids',async()=>{const {doc,w,tab}=setup({body:'<p>Text</p>'});doc.querySelector('.doc-surface p').click();tab('Pages');doc.querySelector('[data-adv=section]').click();doc.querySelector('#sec-cols').value='2';doc.querySelector('#sec-w').value='215.9';doc.querySelector('#sec-h').value='279.4';doc.querySelector('#sec-break').value='page';doc.querySelector('#sec-name').closest('.modal-overlay').querySelector('[data-confirm]').click();await tick();const section=doc.querySelector('[data-doc-section]');expect(section.style.columnCount).toBe('2');expect(section.dataset.docSectionWidth).toBe('215.9');expect(doc.querySelector('.doc-copies').disabled).toBe(true);expect(w.UI.printableHtml(w.DocEditor.serializeEditor(doc.querySelector('.doc-surface')))).toContain('@page docsection0{size:215.9mm 279.4mm;');});
});
it('copies a design page with its linked note and creates independent references',async()=>{const {doc,w,tab}=setup({body:'<div data-doc-design-page="a"><p>Text<a data-doc-note-ref="n1" href="#doc-note-n1">1</a></p></div><div data-doc-design-page="b"><div data-doc-notes><p data-doc-footnote="n1"><a data-doc-note-number href="#doc-note-ref-n1">1. </a><span data-doc-note-text>Source</span></p></div></div>'});doc.querySelector('[data-doc-design-page] p').click();tab('Pages');doc.querySelector('[data-adv=page-copy]').click();await new Promise(r=>setTimeout(r,0));const refs=[...doc.querySelectorAll('[data-doc-note-ref]')];expect(refs).toHaveLength(2);expect(refs[0].dataset.docNoteRef).not.toBe(refs[1].dataset.docNoteRef);const copied=refs[1].closest('[data-doc-design-page]'),note=copied.querySelector('[data-doc-footnote]');expect(note.textContent).toContain('Source');expect(note.id).toBe(refs[1].getAttribute('href').slice(1));expect(note.querySelector('[data-doc-note-number]').getAttribute('href')).toBe('#'+refs[1].id);});
it('keeps consecutive typing and backspace in one tracked insertion',()=>{const {doc,w,tab,change}=setup({body:'<p>Start</p>'});tab('Review');change('[data-adv-tracking]',true);const p=doc.querySelector('.doc-surface p'),r=doc.createRange();r.selectNodeContents(p);r.collapse(false);w.getSelection().removeAllRanges();w.getSelection().addRange(r);for(const text of ['a','b'])p.dispatchEvent(new w.InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'insertText',data:text}));expect(p.querySelectorAll('ins')).toHaveLength(1);expect(p.querySelector('ins').textContent).toBe('ab');p.dispatchEvent(new w.InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'deleteContentBackward'}));expect(p.querySelector('ins').textContent).toBe('a');expect(p.querySelector('del')).toBeNull();});
