import {describe,it,expect,vi,afterEach} from 'vitest';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
const source=fs.readFileSync(new URL('../public/js/doc-editor.js',import.meta.url),'utf8');
const modelSource=fs.readFileSync(new URL('../public/js/doc-model.js',import.meta.url),'utf8');
const uiSource=fs.readFileSync(new URL('../public/js/ui.js',import.meta.url),'utf8');
const windows:JSDOM[]=[];
afterEach(()=>windows.splice(0).forEach(dom=>dom.window.close()));
function setup(body='<p>Original content</p>',withModel=false,options:any={},runtime:any={}){
 const dom=new JSDOM('<div id="view"></div><div id="modal-root"></div><div id="toasts"></div>',{url:'https://studio.test',runScripts:'dangerously',pretendToBeVisual:true});windows.push(dom);
 const w=dom.window as any;Object.assign(w,runtime);w.eval(uiSource+';window.UI=UI;');w.UI.confirmDialog=vi.fn(async()=>true);
 if(withModel)w.eval(modelSource);
 w.document.execCommand=vi.fn(()=>true);w.document.queryCommandState=vi.fn(()=>false);w.eval(source);
 const ed=w.DocEditor.open({name:'Commands',body,getVariables:()=>[],onSave:()=>true,...options});
 const root=w.document.querySelector('.doc-surface');
 function select(node:Node,start=0,end=4){w.getSelection().setBaseAndExtent(node,start,node,end);w.document.dispatchEvent(new w.Event('selectionchange'));}
 return {w,ed,root,doc:w.document,select};
}
describe('document command dispatch',()=>{
 it('edits/removes a company header divider without removing fields and restores it with Undo',()=>{
  const {doc,w,root,ed,select}=setup('<header class="doc-head" style="border-bottom:2px solid #222"><h1>{{company.name}}</h1><p>Company address</p></header><p>Body</p>',true);
  select(root.querySelector('header p').firstChild,0,4);doc.querySelector('[data-studio-tab=Properties]').click();
  const input=doc.querySelector('[data-header-border=style]');input.value='dashed';input.dispatchEvent(new w.Event('change',{bubbles:true}));ed._history.flush();
  expect(root.querySelector('header').style.borderBottomStyle).toBe('dashed');expect(root.querySelector('[data-token="company.name"]')).not.toBeNull();
  doc.querySelector('[data-header-divider-remove]').click();ed._history.flush();expect(root.querySelector('header').style.borderBottomStyle).toBe('none');expect(root.textContent).toContain('Company address');
  ed._history.undo();expect(root.querySelector('header').style.borderBottomStyle).toBe('dashed');ed._history.undo();expect(root.querySelector('header').style.borderBottomStyle).toBe('solid');
 });
 it('does not modify a locked company header divider',()=>{
  const {doc,w,root,select}=setup('<header class="doc-head" data-doc-locked="true" style="border-bottom:2px solid #222"><p>Company details</p></header><p>Body</p>',true);
  select(root.querySelector('header p').firstChild,0,4);doc.querySelector('[data-studio-tab=Properties]').click();const input=doc.querySelector('[data-header-border=style]');input.value='none';input.dispatchEvent(new w.Event('change',{bubbles:true}));expect(root.querySelector('header').style.borderBottomStyle).toBe('solid');expect(doc.querySelector('.doc-header-divider').disabled).toBe(true);
 });

 it('routes keyboard and toolbar formatting through the same registered native adapter',()=>{
  const {w,doc,root,ed,select}=setup();select(root.querySelector('p').firstChild);
  doc.execCommand.mockClear();doc.querySelector('[data-ex=bold]').click();
  root.dispatchEvent(new w.KeyboardEvent('keydown',{key:'b',ctrlKey:true,bubbles:true,cancelable:true}));
  expect(doc.execCommand.mock.calls).toEqual([['bold',false,undefined],['bold',false,undefined]]);
  expect(ed.commands.list()).toContain('format.bold');expect(ed.commands.run('missing.command')).toBe(false);
 });
 it('preserves a backwards selection across font controls and mirrors active state accessibly',()=>{
  const {w,doc,root,select}=setup();select(root.querySelector('p').firstChild,8,0);
  doc.queryCommandState.mockImplementation((id:string)=>id==='bold');doc.dispatchEvent(new w.Event('selectionchange'));
  expect(doc.querySelector('[data-ex=bold]').getAttribute('aria-pressed')).toBe('true');
  const font=doc.querySelector('[data-cmd=fontName]');font.focus();font.value='Georgia';
  doc.execCommand.mockImplementation(()=>{expect(w.getSelection().anchorOffset).toBe(8);expect(w.getSelection().focusOffset).toBe(0);return true;});
  font.dispatchEvent(new w.Event('change',{bubbles:true}));expect(doc.execCommand).toHaveBeenLastCalledWith('fontName',false,'Georgia');expect(doc.activeElement).toBe(root);
 });
 it('blocks formatting a locked block or a selection crossing it, while preserving undo availability',()=>{
  const {doc,root,ed,select}=setup('<p>Editable</p><p data-doc-locked="true">Locked</p>');
  const nodes=root.querySelectorAll('p');select(nodes[1].firstChild);doc.execCommand.mockClear();
  expect(ed.commands.state('format.bold').enabled).toBe(false);expect(ed.commands.run('format.bold')).toBe(false);expect(doc.execCommand).not.toHaveBeenCalled();
  const w=doc.defaultView;w.getSelection().setBaseAndExtent(nodes[0].firstChild,0,nodes[1].firstChild,3);doc.dispatchEvent(new w.Event('selectionchange'));
  expect(ed.commands.run('paragraph.center')).toBe(false);expect(ed.commands.state('edit.undo').enabled).toBe(false);
 });
 it('formats editable text islands inside a floating object',()=>{
  const {doc,root,ed,select}=setup('<div class="doc-float" data-float-kind="textbox"><div class="doc-float-body" contenteditable="true">Text box</div></div>');
  select(root.querySelector('.doc-float-body').firstChild);doc.execCommand.mockClear();
  expect(ed.commands.state('format.bold').enabled).toBe(true);expect(ed.commands.run('format.bold')).toBe(true);expect(doc.execCommand).toHaveBeenCalledWith('bold',false,undefined);
 });
 it('retains document focus and the selected text after cancelling an insert dialog',()=>{
  const {doc,root,select}=setup();select(root.querySelector('p').firstChild,0,8);
  const button=doc.querySelector('[data-ins=link]');button.focus();button.click();
  expect(doc.querySelector('.modal-overlay')).not.toBeNull();doc.querySelector('.modal-overlay [data-close]').click();
  expect(doc.activeElement).toBe(root);expect(doc.defaultView.getSelection().toString()).toBe('Original');
 });
 it('restores the selection before applying a link and returns focus to the document',async()=>{
  const {doc,root,select}=setup();select(root.querySelector('p').firstChild,0,8);
  const button=doc.querySelector('[data-ins=link]');button.focus();button.click();
  const input=doc.querySelector('#lnk');input.value='https://example.com';input.focus();
  doc.execCommand.mockImplementation((cmd:string)=>{if(cmd==='createLink')expect(doc.defaultView.getSelection().toString()).toBe('Original');return true;});
  doc.querySelector('.modal-overlay [data-confirm]').click();await Promise.resolve();await Promise.resolve();
  expect(doc.execCommand).toHaveBeenLastCalledWith('createLink',false,'https://example.com');expect(doc.activeElement).toBe(root);expect(doc.querySelector('.modal-overlay')).toBeNull();
 });
 it('does not mark failed browser formatting dirty or consume shortcuts in external text inputs',async()=>{
  const {w,doc,root,ed,select}=setup();select(root.querySelector('p').firstChild);doc.execCommand.mockReturnValue(false);
  expect(ed.commands.run('format.bold')).toBe(false);
  const name=doc.querySelector('.doc-fs-name');doc.execCommand.mockClear();const key=new w.KeyboardEvent('keydown',{key:'b',ctrlKey:true,bubbles:true,cancelable:true});name.dispatchEvent(key);
  expect(key.defaultPrevented).toBe(false);expect(doc.execCommand).not.toHaveBeenCalled();
  await ed.close();expect(w.UI.confirmDialog).not.toHaveBeenCalled();
 });
 it('copies field tokens as canonical HTML and plain text, and pastes them as atomic chips',()=>{
  const {w,doc,root,select}=setup('<p>Hello {{employee_name}}</p>');const paragraph=root.querySelector('p');
  w.getSelection().selectAllChildren(paragraph);doc.dispatchEvent(new w.Event('selectionchange'));
  const values:Record<string,string>={};const data={setData:(kind:string,value:string)=>{values[kind]=value;},getData:(kind:string)=>values[kind] || '',items:[]};
  const copy=new w.Event('copy',{bubbles:true,cancelable:true});Object.defineProperty(copy,'clipboardData',{value:data});root.dispatchEvent(copy);
  expect(copy.defaultPrevented).toBe(true);expect(values['text/plain']).toBe('Hello {{employee_name}}');expect(values['text/html']).not.toContain('doc-chip');
  const paste=new w.Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(paste,'clipboardData',{value:data});root.dispatchEvent(paste);
  expect(doc.execCommand.mock.lastCall[0]).toBe('insertHTML');expect(doc.execCommand.mock.lastCall[2]).toContain('data-token="employee_name"');
 });
 it('prevents cutting through locked content and pastes plain text using a text command',()=>{
  const {w,doc,root,select}=setup('<p data-doc-locked="true">Locked</p>');select(root.querySelector('p').firstChild);
  const data={setData:vi.fn(),getData:(kind:string)=>kind==='text/plain'?'<script>literal</script>':'',items:[]};
  const cut=new w.Event('cut',{bubbles:true,cancelable:true});Object.defineProperty(cut,'clipboardData',{value:data});doc.execCommand.mockClear();root.dispatchEvent(cut);
  expect(cut.defaultPrevented).toBe(true);expect(doc.execCommand).not.toHaveBeenCalled();
  root.innerHTML='<p>Editable</p>';select(root.querySelector('p').firstChild);const paste=new w.Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(paste,'clipboardData',{value:data});root.dispatchEvent(paste);
  expect(doc.execCommand).toHaveBeenLastCalledWith('insertText',false,'<script>literal</script>');
 });
 it('tabs through merged table cells without duplicating spans and creates a data row after a header-only table',()=>{
  const {w,root,ed,select}=setup('<table><thead><tr><th colspan="2">Header</th></tr></thead><tbody></tbody></table>');select(root.querySelector('th').firstChild,0,0);
  root.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));
  expect(root.querySelectorAll('tbody td')).toHaveLength(2);expect(w.getSelection().anchorNode).toBe(root.querySelector('td'));
  root.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));expect(w.getSelection().anchorNode).toBe(root.querySelectorAll('td')[1]);
  root.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true}));expect(w.getSelection().anchorNode).toBe(root.querySelector('td'));
  ed._history.undo();expect(root.querySelectorAll('tbody td')).toHaveLength(0);ed._history.redo();expect(root.querySelectorAll('tbody td')).toHaveLength(2);const anchor=w.getSelection().anchorNode;expect(anchor.nodeType===3?anchor.parentElement.closest('td'):anchor.closest('td')).toBe(root.querySelector('td'));expect(w.getSelection().anchorOffset).toBe(0);
 });
 it('routes Tab and Shift+Tab in a list through indent commands and skips field tokens as a whole',()=>{
  const {w,doc,root,select}=setup('<ul><li>Item</li></ul><p>Before {{name}}after</p>');select(root.querySelector('li').firstChild,0,0);doc.execCommand.mockClear();
  root.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));root.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true}));
  expect(doc.execCommand.mock.calls.map((call:any[])=>call[0])).toEqual(['indent','outdent']);
  const paragraph=root.querySelector('p');select(paragraph.lastChild,0,0);root.dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true,cancelable:true}));
  expect(w.getSelection().anchorNode).toBe(paragraph);expect(w.getSelection().anchorOffset).toBe(1);
 });

 it('deletes an adjacent token atomically and restores the original caret on Undo',()=>{
  const {w,root,ed,select}=setup('<p>Before {{name}}after</p>');let paragraph=root.querySelector('p');select(paragraph.lastChild,0,0);
  root.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Backspace',bubbles:true,cancelable:true}));expect(root.querySelector('.doc-chip')).toBeNull();
  ed._history.undo();paragraph=root.querySelector('p');expect(paragraph.querySelector('.doc-chip')).not.toBeNull();expect(w.getSelection().isCollapsed).toBe(true);expect(w.getSelection().anchorNode).toBe(paragraph.lastChild);expect(w.getSelection().anchorOffset).toBe(0);
 });

 it('runs paragraph alignment on the model without execCommand and preserves fields and history',()=>{
  const {w,doc,root,ed,select}=setup('<p>Original {{name}}</p><p>Other</p>',true);select(root.querySelector('p').firstChild,8,0);doc.execCommand.mockClear();doc.queryCommandState.mockImplementation(()=>{throw Error('Native state unavailable');});
  expect(ed.commands.run('paragraph.center')).toBe(true);expect(doc.execCommand).not.toHaveBeenCalled();expect(root.querySelector('p').style.textAlign).toBe('center');expect(root.querySelectorAll('p')[1].style.textAlign).toBe('');expect(root.querySelector('.doc-chip').dataset.token).toBe('name');
  expect(ed.commands.state('paragraph.center').active).toBe(true);expect(w.getSelection().anchorOffset).toBe(8);expect(w.getSelection().focusOffset).toBe(0);
  ed._history.undo();expect(root.querySelector('p').style.textAlign).toBe('');ed._history.redo();expect(root.querySelector('p').style.textAlign).toBe('center');expect(root.querySelector('.doc-chip').dataset.token).toBe('name');
 });

 it('uses model inline commands for selected text and keeps undo, fields and dialog focus',()=>{
  const {w,doc,root,ed,select}=setup('<p>Original {{name}}</p>',true);select(root.querySelector('p').firstChild,8,0);doc.execCommand.mockClear();
  expect(ed.commands.run('format.bold')).toBe(true);expect(doc.execCommand).not.toHaveBeenCalled();expect(w.getSelection().toString()).toBe('Original');expect(ed.commands.state('format.bold').active).toBe(true);expect(root.querySelector('.doc-chip').dataset.token).toBe('name');
  ed.commands.run('format.italic');ed.commands.run('format.font','Georgia');ed.commands.run('format.size','18');ed.commands.run('format.color','#ff0000');
  expect(doc.execCommand).not.toHaveBeenCalled();expect(root.querySelectorAll('[data-doc-run]')).toHaveLength(1);expect(root.querySelector('[data-doc-run]').style.fontSize).toBe('18pt');expect(root.querySelector('[data-doc-run]').style.fontFamily).toBe('Georgia');
  ed._history.undo();expect(root.querySelector('[data-doc-run]').style.color).toBe('');ed._history.redo();expect(root.querySelector('[data-doc-run]').style.color).toBe('rgb(255, 0, 0)');expect(w.getSelection().toString()).toBe('Original');
 });
 it('owns caret marks without dirtying content, then applies them to typing as one undo step',()=>{
  const {w,doc,root,ed,select}=setup('<p>Text</p>',true);select(root.querySelector('p').firstChild,2,2);doc.execCommand.mockClear();const before=root.innerHTML;
  expect(ed.commands.run('format.bold')).toBe(true);ed.commands.run('format.size',18);expect(doc.execCommand).not.toHaveBeenCalled();expect(root.innerHTML).toBe(before);expect(ed.commands.state('edit.undo').enabled).toBe(false);expect(ed.commands.state('format.bold').active).toBe(true);
  const input=new w.InputEvent('beforeinput',{inputType:'insertText',data:'X',bubbles:true,cancelable:true});root.dispatchEvent(input);expect(input.defaultPrevented).toBe(true);
  expect(root.querySelector('[data-doc-run]').textContent).toBe('X');expect(root.querySelector('[data-doc-run]').style.fontWeight).toBe('bold');expect(root.querySelector('[data-doc-run]').style.fontSize).toBe('18pt');ed._history.undo();expect(root.innerHTML).toBe(before);ed._history.redo();expect(root.querySelector('[data-doc-run]').textContent).toBe('X');
 });
 it('clears pending marks when the caret moves and allows a toggle back off',()=>{
  const {root,ed,select}=setup('<p>Text</p>',true);select(root.querySelector('p').firstChild,2,2);ed.commands.run('format.bold');ed.commands.run('format.bold');expect(ed.commands.state('format.bold').active).toBe(false);ed.commands.run('format.bold');select(root.querySelector('p').firstChild,0,0);expect(ed.commands.state('format.bold').active).toBe(false);expect(ed.commands.state('edit.undo').enabled).toBe(false);
 });

 it('applies caret marks after a committed composition and keeps it in one history step',async()=>{
  const {w,doc,root,ed,select}=setup('<p><ins data-doc-change="r" data-doc-author="Reviewer">Added</ins></p>',true);const p=root.querySelector('p');select(p,p.childNodes.length,p.childNodes.length);ed.commands.run('format.italic');const before=root.innerHTML;
  root.dispatchEvent(new w.CompositionEvent('compositionstart',{bubbles:true}));root.dispatchEvent(new w.InputEvent('beforeinput',{inputType:'insertCompositionText',data:'日本',bubbles:true,isComposing:true}));const text=p.querySelector('ins').firstChild;text.appendData('日本');w.getSelection().setBaseAndExtent(text,7,text,7);root.dispatchEvent(new w.InputEvent('input',{inputType:'insertCompositionText',bubbles:true,isComposing:true}));expect(root.querySelector('[data-doc-run]')).toBeNull();
  w.getSelection().setBaseAndExtent(text,5,text,7);root.dispatchEvent(new w.InputEvent('beforeinput',{inputType:'insertCompositionText',data:'日本',bubbles:true,isComposing:true}));w.getSelection().collapse(text,7);root.dispatchEvent(new w.CompositionEvent('compositionend',{data:'日本',bubbles:true}));await Promise.resolve();
  expect(root.querySelector('[data-doc-run]').textContent).toBe('日本');expect(root.querySelector('[data-doc-run]').style.fontStyle).toBe('italic');expect(root.querySelector('ins').dataset.docAuthor).toBe('Reviewer');ed._history.undo();expect(root.innerHTML).toBe(before);ed._history.redo();expect(root.querySelector('[data-doc-run]').textContent).toBe('日本');
 });
 it('formats inherited underline through the registered command and preserves undo',()=>{
  const {doc,root,ed,select}=setup('<p><u><s>Before middle after</s></u></p>',true);select(root.querySelector('s').firstChild,13,7);doc.execCommand.mockClear();expect(ed.commands.run('format.underline')).toBe(true);expect(doc.execCommand).not.toHaveBeenCalled();expect(ed.commands.state('format.underline').active).toBe(false);expect(ed.commands.state('format.strike').active).toBe(true);ed._history.undo();expect(root.querySelector('u').textContent).toBe('Before middle after');ed._history.redo();expect(ed.commands.state('format.underline').active).toBe(false);
 });

 it('keeps styled field tokens atomic for keyboard navigation, deletion and undo',()=>{
  const {w,doc,root,ed,select}=setup('<p>Before {{name}}after</p>',true);const chip=root.querySelector('.doc-chip'),range=doc.createRange();range.selectNode(chip);w.getSelection().removeAllRanges();w.getSelection().addRange(range);doc.dispatchEvent(new w.Event('selectionchange'));ed.commands.run('format.bold');
  let p=root.querySelector('p');select(p.lastChild,0,0);root.dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true,cancelable:true}));expect(w.getSelection().anchorNode).toBe(chip.parentElement);expect(w.getSelection().anchorOffset).toBe(0);
  select(p.lastChild,0,0);root.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Backspace',bubbles:true,cancelable:true}));expect(root.querySelector('.doc-chip')).toBeNull();expect(root.querySelector('[data-doc-run]')).toBeNull();ed._history.undo();p=root.querySelector('p');expect(p.querySelector('.doc-chip').dataset.token).toBe('name');expect(p.querySelector('[data-doc-run]').style.fontWeight).toBe('bold');expect(w.getSelection().anchorNode).toBe(p.lastChild);
 });

});

describe('model paragraph commands',()=>{
 it('replaces selected text and deletes a Unicode grapheme without native commands, with undo/redo',()=>{
  const {w,doc,root,ed,select}=setup('<p><b>Original</b> 👩‍💻 after {{name}}</p>',true);select(root.querySelector('b').firstChild,8,0);doc.execCommand.mockClear();const before=root.innerHTML;
  const input=new w.InputEvent('beforeinput',{inputType:'insertReplacementText',data:'Changed',bubbles:true,cancelable:true});root.dispatchEvent(input);expect(input.defaultPrevented).toBe(true);expect(doc.execCommand).not.toHaveBeenCalled();expect(root.textContent).toBe('Changed 👩‍💻 after name');ed._history.undo();expect(root.innerHTML).toBe(before);ed._history.redo();
  const text=root.querySelector('p').childNodes[1];select(text,6,6);const deletion=new w.InputEvent('beforeinput',{inputType:'deleteContentBackward',bubbles:true,cancelable:true});root.dispatchEvent(deletion);expect(deletion.defaultPrevented).toBe(true);expect(root.textContent).toBe('Changed  after name');ed._history.undo();expect(root.textContent).toBe('Changed 👩‍💻 after name');
 });
 it('keeps caret underline/script/clear choices ephemeral and applies them to the next typing transaction',()=>{
  const {w,doc,root,ed,select}=setup('<p><b>Before</b> after</p>',true);select(root.querySelector('b').firstChild,6,6);const before=root.innerHTML;doc.execCommand.mockClear();ed.commands.run('format.underline');ed.commands.run('format.superscript');expect(root.innerHTML).toBe(before);expect(ed.commands.state('edit.undo').enabled).toBe(false);expect(ed.commands.state('format.superscript').active).toBe(true);
  root.dispatchEvent(new w.InputEvent('beforeinput',{inputType:'insertText',data:'Raised',bubbles:true,cancelable:true}));expect(root.querySelector('sup').textContent).toBe('Raised');expect(root.textContent).toBe('BeforeRaised after');ed.commands.run('format.clear');expect(ed.commands.state('format.bold').active).toBe(false);expect(ed.commands.state('format.underline').active).toBe(false);expect(ed.commands.state('format.superscript').active).toBe(false);
  root.dispatchEvent(new w.InputEvent('beforeinput',{inputType:'insertText',data:'Plain',bubbles:true,cancelable:true}));expect([...root.querySelectorAll('[data-doc-run]')].some((n:any)=>n.textContent==='Plain'&&n.style.fontWeight==='normal'&&!n.closest('sup'))).toBe(true);expect(doc.execCommand).not.toHaveBeenCalled();ed._history.undo();expect(root.textContent).toBe('BeforeRaised after');ed._history.redo();expect(root.textContent).toBe('BeforeRaisedPlain after');
 });
 it('routes plain text insertion and selected Cut deletion through model commands',()=>{
  const {doc,root,ed,select}=setup('<p>Before middle after {{name}}</p>',true);select(root.querySelector('p').firstChild,13,7);doc.execCommand.mockClear();expect(ed.commands.run('insert.text','New')).toBe(true);expect(root.textContent).toBe('Before New after name');expect(doc.execCommand).not.toHaveBeenCalled();ed._history.undo();select(root.querySelector('p').firstChild,7,13);expect(ed.commands.run('edit.deleteSelection')).toBe(true);expect(root.textContent).toBe('Before  after name');ed._history.undo();expect(root.textContent).toBe('Before middle after name');
 });
});

describe('simplified editor workspace',()=>{
 it('keeps sidebar insertion in its paragraph after the live DOM is refreshed',()=>{
  const {w,doc,root}=setup('<p>Before {{name}} after</p><p>Other paragraph</p>',true);const range=doc.createRange();range.selectNodeContents(root.querySelector('p'));range.collapse(false);w.getSelection().removeAllRanges();w.getSelection().addRange(range);doc.dispatchEvent(new w.Event('selectionchange'));doc.querySelector('[data-studio-tab=Data]').click();doc.querySelector('[data-variable-search]').focus();root.innerHTML=root.innerHTML;doc.querySelector('[data-variable-insert]').click();expect(root.querySelectorAll('p')[0].querySelectorAll('.doc-chip')).toHaveLength(2);expect(root.querySelectorAll('p')[1].textContent).toBe('Other paragraph');
 });
 it('inserts a variable inside the paragraph at a formatted end boundary with undo',()=>{
  const {w,doc,root,ed}=setup('<p><b>End of paragraph</b></p>',true);const p=root.querySelector('p'),range=doc.createRange();range.selectNodeContents(p);range.collapse(false);w.getSelection().removeAllRanges();w.getSelection().addRange(range);doc.dispatchEvent(new w.Event('selectionchange'));doc.execCommand.mockClear();ed.commands.run('insert.html',w.DocEditor.bodyToEditorHtml('{{company.name}}'));expect(p.querySelector('.doc-chip').dataset.token).toBe('company.name');expect(doc.execCommand).not.toHaveBeenCalled();ed._history.undo();expect(root.querySelector('.doc-chip')).toBeNull();
 });
 it('selects starter chips on click and deletes them as whole tokens with undo',()=>{
  const {w,doc,root,ed}=setup('<header><h1>{{company.name}}</h1><div>{{company.address}}</div><div>{{company.phone}} · {{company.email}}</div><div>{{today}}</div></header><p>Body</p>',true);
  const first=root.querySelector('.doc-chip');first.dispatchEvent(new w.MouseEvent('click',{bubbles:true}));expect(w.getSelection().isCollapsed).toBe(false);expect(ed.commands.state('edit.deleteAtomic').enabled).toBe(true);
  root.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Delete',bubbles:true,cancelable:true}));expect(root.querySelectorAll('.doc-chip')).toHaveLength(4);ed._history.undo();expect(root.querySelectorAll('.doc-chip')).toHaveLength(5);
  for(const chip of [...root.querySelectorAll('.doc-chip')]){chip.dispatchEvent(new w.MouseEvent('click',{bubbles:true}));root.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Backspace',bubbles:true,cancelable:true}));}
  expect(root.querySelector('.doc-chip')).toBeNull();expect(w.DocEditor.serializeEditor(root)).not.toContain('{{company.');expect(root.querySelector('p').textContent).toBe('Body');
 });
 it('uses color pickers and no-fill controls while preserving existing colors until changed',()=>{
  const {w,doc,root,select}=setup('<p style="color:rgb(17, 34, 51);background-color:rgba(70, 80, 90, 0.4)">Text</p>',true);const p=root.querySelector('p');select(p.firstChild,0,0);p.dispatchEvent(new w.MouseEvent('click',{bubbles:true}));doc.querySelector('[data-studio-tab=Properties]').click();
  const color=doc.querySelector('[data-prop=color]'),bg=doc.querySelector('[data-prop=backgroundColor]');expect(color.type).toBe('color');expect(color.value).toBe('#112233');expect(bg.type).toBe('color');expect(bg.value).toBe('#46505a');expect(p.style.backgroundColor).toBe('rgba(70, 80, 90, 0.4)');
  color.value='#ff6600';color.dispatchEvent(new w.Event('change',{bubbles:true}));expect(p.style.color).toBe('rgb(255, 102, 0)');
  doc.querySelector('[data-clear-fill]').click();expect(p.style.backgroundColor).toBe('transparent');expect(doc.querySelector('[data-clear-fill]').getAttribute('aria-pressed')).toBe('true');
 });
 it('offers size and spacing presets and retains precise existing values',()=>{
  const {w,doc,root,select}=setup('<p style="font-size:17pt;line-height:1.42;padding:7px;margin-bottom:5px">Text</p>',true);const p=root.querySelector('p');select(p.firstChild,0,0);p.dispatchEvent(new w.MouseEvent('click',{bubbles:true}));doc.querySelector('[data-studio-tab=Properties]').click();
  for(const prop of ['fontSize','lineHeight','padding','marginBottom'])expect(doc.querySelector(`[data-prop=${prop}]`).tagName).toBe('SELECT');
  expect(doc.querySelector('[data-prop=fontSize]').value).toBe('17');expect(doc.querySelector('[data-prop=padding]').value).toBe('7');
  const line=doc.querySelector('[data-prop=lineHeight]');line.value='2';line.dispatchEvent(new w.Event('change',{bubbles:true}));expect(p.style.lineHeight).toBe('2');
  const padding=doc.querySelector('[data-prop=padding]');padding.value='16';padding.dispatchEvent(new w.Event('change',{bubbles:true}));expect(p.style.padding).toBe('16px');
  const size=doc.querySelector('[data-prop=fontSize]');size.value='custom';size.dispatchEvent(new w.Event('change',{bubbles:true}));expect(doc.querySelector('[data-custom-property]').value).toBe('17');
 });
 it('collapses the ribbon and tool sidebar without changing document content',()=>{
  const {doc,root}=setup('<p>Text</p>',true);const ribbon=doc.querySelector('[data-ribbon-toggle]'),rail=doc.querySelector('[data-rail-toggle]');
  ribbon.click();expect(ribbon.getAttribute('aria-expanded')).toBe('false');expect(doc.querySelector('.doc-fs').classList.contains('ribbon-collapsed')).toBe(true);
  doc.querySelector('[data-tab=insert]').click();expect(ribbon.getAttribute('aria-expanded')).toBe('true');expect(doc.querySelector('[data-panel=insert]').style.display).toBe('');
  rail.click();expect(rail.getAttribute('aria-expanded')).toBe('false');expect(doc.querySelector('.doc-workspace').classList.contains('rail-collapsed')).toBe(true);
  doc.querySelector('[data-studio-tab=Pages]').click();expect(doc.querySelector('.doc-studio-side').hidden).toBe(false);doc.querySelector('[data-inspector-close]').click();expect(doc.querySelector('.doc-studio-side').hidden).toBe(true);
  rail.click();expect(rail.getAttribute('aria-expanded')).toBe('true');expect(root.innerHTML).toBe('<p>Text</p>');
 });
 it('keeps settings and inspector out of the initial workspace, with direct panel navigation and close focus',()=>{
  const {doc,root}=setup('<p>Text</p>',true);const side=doc.querySelector('.doc-studio-side');expect(side.hidden).toBe(true);expect(doc.querySelector('.doc-tool-rail')).not.toBeNull();
  const settings=doc.querySelector('[data-details]');settings.click();expect(doc.querySelector('[role=dialog]').getAttribute('aria-label')).toBe('Editor settings');expect(doc.querySelector('[data-sidebar-panel=Template]').hidden).toBe(true);expect(doc.querySelector('.doc-details').closest('.doc-studio-side')).not.toBeNull();doc.querySelector('.modal-overlay [data-close]').click();
  const pages=doc.querySelector('[data-studio-tab=Pages]');pages.click();expect(side.hidden).toBe(false);expect(side.querySelector('[data-inspector-title]').textContent).toBe('Pages');expect(pages.getAttribute('aria-pressed')).toBe('true');side.querySelector('[data-inspector-close]').click();expect(side.hidden).toBe(true);expect(doc.activeElement).toBe(pages);expect(root.textContent).toBe('Text');
 });
 it('groups familiar ribbon tools and keeps template automation in persistent sidebar controls',()=>{
  const {doc,root}=setup('<p>Text</p>',true,{copiesPerRecord:2,recordsPerPage:2});
  expect(doc.querySelector('[data-tab=home]').textContent).toBe('Home');expect(doc.querySelector('[data-tab=layout]').textContent).toBe('Layout');
  expect([...doc.querySelectorAll('.doc-tool-rail [data-tool-group]')].map((el:any)=>el.dataset.toolGroup)).toEqual(['Document','Design','Template','Review']);
  expect(doc.querySelector('[data-panel=home] [data-cmd=formatBlock]').closest('[aria-label="Headings & styles"]')).not.toBeNull();
  expect(doc.querySelector('[data-panel=insert] [data-ins=variable]')).toBeNull();expect(doc.querySelector('[data-panel=layout] .doc-copies')).toBeNull();
  expect(doc.querySelector('.doc-view-tools .doc-zoomsel')).not.toBeNull();expect(doc.querySelectorAll('.doc-copies')).toHaveLength(1);
  const copies=doc.querySelector('.doc-copies');doc.querySelector('[data-open-panel=Print]').click();
  expect(doc.querySelector('[data-sidebar-panel=Print]').hidden).toBe(false);expect(doc.querySelector('[data-grid-summary]').textContent).toContain('4 layouts per sheet');
  doc.querySelector('[data-studio-tab=Data]').click();expect(doc.querySelector('[data-sidebar-panel=Data]').hidden).toBe(false);expect(doc.querySelector('[data-ins=variable]').closest('[data-sidebar-panel=Data]')).not.toBeNull();
  doc.querySelector('[data-studio-tab=Template]').click();expect(doc.querySelector('.doc-fs-type-top').closest('[data-sidebar-panel=Template]')).not.toBeNull();
  doc.querySelector('[data-studio-tab=Print]').click();expect(doc.querySelector('.doc-copies')).toBe(copies);
  expect(doc.querySelector('.doc-save-status').textContent).toBe('No unsaved changes');expect(root.textContent).toBe('Text');
 });
 it('retains print settings through sidebar changes, undo and saving',async()=>{
  const save=vi.fn((_value:any)=>true);const {doc,w,ed}=setup('<p>Text</p>',true,{copiesPerRecord:2,recordsPerPage:2,onSave:save});
  doc.querySelector('[data-open-panel=Print]').click();const columns=doc.querySelector('.doc-records-per-page');columns.value='3';columns.dispatchEvent(new w.Event('change',{bubbles:true}));ed._history.flush();
  expect(doc.querySelector('[data-grid-summary]').textContent).toContain('6 layouts per sheet');ed._history.undo();expect(columns.value).toBe('2');expect(doc.querySelector('[data-grid-summary]').textContent).toContain('4 layouts per sheet');
  doc.querySelector('[data-save]').click();await new Promise(resolve=>setTimeout(resolve,0));expect(save.mock.calls[0]![0]).toMatchObject({copiesPerRecord:2,recordsPerPage:2,gapXmm:6,gapYmm:6});
 });
 it('opens the sidebar guide and returns More-menu settings focus to its visible launcher',()=>{
  const {doc}=setup();const menu=doc.querySelector('.doc-more-menu');menu.open=true;doc.querySelector('[data-details]').click();expect(menu.open).toBe(false);
  doc.querySelector('.modal-overlay .modal-foot [data-close]').click();expect(doc.activeElement).toBe(menu.querySelector('summary'));
  doc.querySelector('.doc-tool-rail [data-help]').click();expect(doc.querySelector('[role=dialog]').getAttribute('aria-label')).toBe('Template editor — quick guide');
 });
 it('closes advanced formatting with Escape without closing the document and supports keyboard ribbon tabs',()=>{
  const {w,doc}=setup();const menu=doc.querySelector('.doc-format-extra');menu.open=true;menu.querySelector('summary').dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));expect(menu.open).toBe(false);expect(doc.querySelector('.doc-fs')).not.toBeNull();
  const tab=doc.querySelector('[data-tab=home]');tab.focus();tab.dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}));expect(doc.activeElement).toBe(doc.querySelector('[data-tab=insert]'));expect(doc.activeElement.getAttribute('aria-selected')).toBe('true');
 });
 it('shows the selected font/point size and mixed selections instead of stale toolbar defaults',()=>{
  const {w,doc,root,select}=setup('<p style="font-family:Georgia;font-size:18pt">Text</p><h1 style="font-size:24pt">Title</h1>',true);select(root.querySelector('p').firstChild,0,4);expect(doc.querySelector('[data-cmd=fontName]').value).toBe('Georgia');expect(doc.querySelector('[data-fontsize]').value).toBe('18');
  w.getSelection().setBaseAndExtent(root.querySelector('p').firstChild,0,root.querySelector('h1').firstChild,5);doc.dispatchEvent(new w.Event('selectionchange'));expect(doc.querySelector('[data-fontsize]').selectedOptions[0].textContent).toBe('Mixed');expect(doc.querySelector('[data-cmd=formatBlock]').selectedOptions[0].textContent).toBe('Mixed');
 });
 it('uses point sizes consistently in the inspector and retains explained source editing in Source',()=>{
  const {w,doc,root,select}=setup('<p style="font-size:16px">Text</p>',true);select(root.querySelector('p').firstChild,1,1);root.querySelector('p').dispatchEvent(new w.MouseEvent('click',{bubbles:true}));doc.querySelector('[data-studio-tab=Properties]').click();const size=doc.querySelector('[data-prop=fontSize]');expect(size.value).toBe('12');size.value='18';size.dispatchEvent(new w.Event('change',{bubbles:true}));expect(root.querySelector('p').style.fontSize).toBe('18pt');
  expect(doc.querySelector('[data-mode=code]').closest('.doc-more-menu')).not.toBeNull();w.CMBundle={mount(){let text='';return {setValue(value:string){text=value;},getValue(){return text;},focus(){},destroy(){}};}};doc.querySelector('[data-mode=code]').click();expect(doc.querySelector('.doc-code').style.display).not.toBe('none');doc.querySelector('[data-mode=visual]').click();expect(doc.querySelector('.doc-canvas').style.display).not.toBe('none');
 });
});

it('opens Find and replace from the ribbon without disrupting the workspace',()=>{
 const {doc,root}=setup('<p>Find this text</p>',true);doc.querySelector('[data-find]').click();expect(doc.querySelector('.doc-find')).not.toBeNull();expect(root.textContent).toBe('Find this text');doc.querySelector('[data-find]').click();expect(doc.querySelector('.doc-find')).toBeNull();expect(doc.querySelector('[data-find-launch]')).toBeNull();
});

describe('editor preferences',()=>{
 it('applies and persists shortcuts and spelling preferences without changing the document',async()=>{
  const {w,doc,root}=setup('<p>Keep this content</p>',true);
  doc.querySelector('[data-details]').click();const dialog=doc.querySelector('.modal-overlay');
  dialog.querySelector('[data-pref=save]').value='shift+s';dialog.querySelector('[data-pref=find]').value='shift+f';dialog.querySelector('[data-pref=spellcheck]').checked=false;dialog.querySelector('[data-pref=compactRibbon]').checked=true;
  dialog.querySelector('[data-confirm]').click();await Promise.resolve();await Promise.resolve();
  expect(root.spellcheck).toBe(false);expect(root.textContent).toBe('Keep this content');expect(doc.querySelector('.doc-fs').classList.contains('ribbon-collapsed')).toBe(true);
  expect(JSON.parse(w.localStorage.getItem('doc-editor-preferences-v1')).save).toBe('shift+s');
  root.dispatchEvent(new w.KeyboardEvent('keydown',{key:'f',ctrlKey:true,bubbles:true,cancelable:true}));expect(doc.querySelector('.doc-find')).toBeNull();
  root.dispatchEvent(new w.KeyboardEvent('keydown',{key:'F',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true}));expect(doc.querySelector('.doc-find')).not.toBeNull();
 });
 it('rejects duplicate shortcuts and allows restoring defaults before applying',async()=>{
  const {doc,w}=setup();doc.querySelector('[data-details]').click();const dialog=doc.querySelector('.modal-overlay');dialog.querySelector('[data-pref=find]').value='s';dialog.querySelector('[data-confirm]').click();await Promise.resolve();await Promise.resolve();
  expect(dialog.querySelector('[data-modal-error]').textContent).toContain('different shortcut');expect(w.localStorage.getItem('doc-editor-preferences-v1')).toBeNull();
  dialog.querySelector('[data-reset-preferences]').click();expect(dialog.querySelector('[data-pref=find]').value).toBe('f');
 });
 it('opens document details under File and applies metadata without revealing a workspace row',async()=>{
  const {doc,ed}=setup();doc.querySelector('[data-file]').click();doc.querySelector('[data-document-details]').click();const dialogs=doc.querySelectorAll('.modal-overlay');const dialog=dialogs[dialogs.length-1];expect(dialog.querySelector('[role=dialog]').getAttribute('aria-label')).toBe('Document details');dialog.querySelector('[data-detail-type]').value='generic';dialog.querySelector('[data-confirm]').click();await Promise.resolve();await Promise.resolve();
  expect(doc.querySelector('.doc-fs-type-top').value).toBe('generic');expect(doc.querySelector('[data-sidebar-panel=Template]').hidden).toBe(true);expect(doc.querySelector('.doc-details').closest('.doc-studio-side')).not.toBeNull();
 });
});

it('restores editor preferences on reopen and supports preview shortcuts and disabled scroll zoom',async()=>{
 const {w,doc,ed}=setup();doc.querySelector('[data-details]').click();const dialog=doc.querySelector('.modal-overlay');dialog.querySelector('[data-pref=wheelZoom]').checked=false;dialog.querySelector('[data-pref=spellcheck]').checked=false;dialog.querySelector('[data-confirm]').click();await Promise.resolve();await Promise.resolve();
 const wheel=new w.WheelEvent('wheel',{ctrlKey:true,deltaY:-100,bubbles:true,cancelable:true});doc.querySelector('.doc-canvas').dispatchEvent(wheel);expect(wheel.defaultPrevented).toBe(false);
 doc.querySelector('.doc-surface').dispatchEvent(new w.KeyboardEvent('keydown',{key:'P',metaKey:true,shiftKey:true,bubbles:true,cancelable:true}));expect(doc.querySelector('.doc-preview-float')).not.toBeNull();
 ed.close();w.DocEditor.open({name:'Reopened',body:'<p>Text</p>',getVariables:()=>[]});expect(doc.querySelector('.doc-surface').spellcheck).toBe(false);
});

describe('linked forms inside the editor',()=>{
 const settle=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
 function runtime(){return {App:{hasPermission:(p:string):boolean=>p==='forms.manage.hr'},API:{get:vi.fn(async(path:string):Promise<Array<{id:number;name?:string;scope?:string;is_default?:boolean;fields?:Array<{key:string;label:string;type?:string}>}>>=>path==='/form-definitions'?[{id:1,name:'Leave request',scope:'hr'},{id:2,name:'Inventory',scope:'inventory'}]:[]),post:vi.fn(async()=>({ok:true})),put:vi.fn(async()=>({ok:true})),del:vi.fn(async()=>({ok:true}))}};}
 it('links a managed form and supports setting defaults and unlinking',async()=>{
  const env=runtime();let linked=false,isDefault=false;
  env.API.get.mockImplementation(async(path:string)=>path==='/form-definitions'?[{id:1,name:'Leave <request>',scope:'hr'},{id:2,name:'Restricted',scope:'inventory'}]:linked?[{id:10,is_default:isDefault}]:[]);
  env.API.post.mockImplementation(async()=>{linked=true;return {ok:true};});env.API.put.mockImplementation(async()=>{isDefault=true;return {ok:true};});env.API.del.mockImplementation(async()=>{linked=false;return {ok:true};});
  const {doc,root}=setup('<p>Template stays intact</p>',true,{getTemplateId:()=>10},env);
  doc.querySelector('[data-linked-forms]').click();await settle();expect(doc.querySelector('[data-link-form]').textContent).toContain('Leave <request>');expect(doc.querySelector('[data-link-form]').textContent).not.toContain('Restricted');expect(env.API.get).not.toHaveBeenCalledWith('/form-definitions/2/templates');
  doc.querySelector('[data-link-form]').value='1';doc.querySelector('[data-link-form-action]').click();await settle();expect(env.API.post).toHaveBeenCalledWith('/form-definitions/1/templates',{template_id:10,make_default:false});
  doc.querySelector('[data-link-make-default]').click();await settle();expect(env.API.put).toHaveBeenCalledWith('/form-definitions/1/template',{template_id:10});expect(doc.querySelector('[data-form-links]').textContent).toContain('Default');
  doc.querySelector('[data-link-unlink]').click();await settle();expect(env.API.del).toHaveBeenCalledWith('/form-definitions/1/templates/10');expect(root.innerHTML).toBe('<p>Template stays intact</p>');
 });
 it('filters available forms without exposing restricted scopes or stale selection',async()=>{
  const env=runtime();const {doc,w}=setup('<p>Template</p>',true,{getTemplateId:()=>10},env);
  doc.querySelector('[data-linked-forms]').click();await settle();const search=doc.querySelector('[data-link-search]'),select=doc.querySelector('[data-link-form]');select.value='1';
  search.value='hr';search.dispatchEvent(new w.Event('input',{bubbles:true}));expect(select.value).toBe('1');
  search.value='Inventory';search.dispatchEvent(new w.Event('input',{bubbles:true}));expect(select.options).toHaveLength(1);expect(select.value).toBe('');expect(select.textContent).toContain('No matching forms');
  search.value='leave';search.dispatchEvent(new w.Event('input',{bubbles:true}));expect(select.options).toHaveLength(2);expect(select.textContent).toContain('Leave request');
 });
 it('offers admin-scoped forms to admin form managers',async()=>{
  const env=runtime();env.App.hasPermission=(permission:string)=>permission==='forms.manage.admin';
  env.API.get.mockImplementation(async(path:string)=>path==='/form-definitions'?[{id:3,name:'Admin request',scope:'admin'}]:[]);
  const {doc}=setup('<p>Template</p>',true,{getTemplateId:()=>10},env);
  expect(doc.querySelector('[data-linked-forms]').hidden).toBe(false);
  doc.querySelector('[data-linked-forms]').click();await settle();
  expect(doc.querySelector('[data-link-form]').textContent).toContain('Admin request');
 });
 it('saves a new template before presenting the linking controls',async()=>{
  const env=runtime();let id:number|null=null;const save=vi.fn(async()=>{id=12;return true;});const {doc}=setup('<p>Draft</p>',true,{getTemplateId:()=>id,onSave:save},env);
  doc.querySelector('[data-linked-forms]').click();expect(env.API.get).not.toHaveBeenCalled();doc.querySelector('[data-save-link]').click();await settle();expect(save).toHaveBeenCalledOnce();expect(doc.querySelector('[data-link-form]')).not.toBeNull();
 });
 it('keeps failed saves unlinked and hides linking without form permissions',async()=>{
  const env=runtime();const {doc}=setup('<p>Draft</p>',true,{getTemplateId:()=>null,onSave:()=> 'Save failed'},env);doc.querySelector('[data-linked-forms]').click();doc.querySelector('[data-save-link]').click();await settle();expect(env.API.post).not.toHaveBeenCalled();expect(doc.querySelector('[data-save-link]').disabled).toBe(false);
  const other=setup('<p>Draft</p>',true,{getTemplateId:()=>10},{App:{hasPermission:()=>false}});expect(other.doc.querySelector('[data-linked-forms]').hidden).toBe(true);
 });
 it('shows load failures and allows retry',async()=>{
  const env=runtime();env.API.get.mockRejectedValueOnce(new Error('Connection unavailable')).mockRejectedValueOnce(new Error('Connection unavailable'));const {doc}=setup('<p>Template</p>',true,{getTemplateId:()=>10},env);doc.querySelector('[data-linked-forms]').click();await settle();expect(doc.querySelector('[data-links-error]').textContent).toContain('Connection unavailable');doc.querySelector('[data-links-retry]').click();await settle();expect(doc.querySelector('[data-link-form]')).not.toBeNull();
 });
});

describe('field chip interaction',()=>{
 it('replaces a field on double-click and allows undo',()=>{
  const {doc,w,root,ed}=setup('<p>Hello {{company.name}}</p>',true,{getVariables:()=>[{category:'Company',label:'Address',token:'{{company.address}}'}]});const chip=root.querySelector('.doc-chip');chip.dispatchEvent(new w.MouseEvent('dblclick',{bubbles:true,cancelable:true}));expect(doc.querySelector('[role=dialog]').getAttribute('aria-label')).toBe('Change field');doc.querySelector('.var-pick').click();expect(root.querySelector('.doc-chip').dataset.token).toBe('company.address');expect(root.textContent).toContain('Hello');ed._history.undo();expect(root.querySelector('.doc-chip').dataset.token).toBe('company.name');
 });
 it('opens an existing formula with Enter and protects locked fields',()=>{
  const {doc,w,root}=setup('<p>{{= 2 + 3}}</p><p data-doc-locked="true">{{company.name}}</p>',true);root.querySelector('.doc-chip-fx').dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));expect(doc.querySelector('#fx-expr').value).toBe('2 + 3');doc.querySelector('.modal-overlay [data-close]').click();root.querySelector('[data-doc-locked] .doc-chip').dispatchEvent(new w.MouseEvent('dblclick',{bubbles:true}));expect(doc.querySelector('.modal-overlay')).toBeNull();
 });
 it('loads saved linked-form fields before opening Linked forms',async()=>{
  const API={get:vi.fn(async(path:string):Promise<Array<{id:number;name?:string;scope?:string;is_default?:boolean;fields?:Array<{key:string;label:string;type?:string}>}>>=>path==='/form-definitions'?[{id:1,name:'Leave request',scope:'hr',fields:[{key:'reason',label:'Reason',type:'text'}]}]:[{id:10,is_default:true}])};const {doc}=setup('<p>Template</p>',true,{getTemplateId:()=>10},{App:{hasPermission:(p:string):boolean=>p==='forms.manage.hr'},API});for(let i=0;i<12;i++)await Promise.resolve();doc.querySelector('[data-ins=variable]').click();doc.querySelector('[data-cat="Form: Leave request"]').click();expect(doc.querySelector('.var-pick').dataset.token).toBe('{{reason}}');
 });
});


describe('everyday Word-style ribbon commands',()=>{
 it('steps font sizes through the existing model and undo history',()=>{
  const {doc,root,ed,select}=setup('<p style="font-size:12pt">Text</p>',true);select(root.querySelector('p').firstChild,0,4);
  doc.querySelector('[data-size-step=up]').click();expect(root.querySelector('p').innerHTML).toContain('14pt');ed._history.flush();ed._history.undo();expect(root.innerHTML).not.toContain('14pt');
 });
 it('applies font-size choices to an empty placeholder paragraph as pending typing format',()=>{
  const {doc,w,root}=setup('<p><br></p>',true);const r=doc.createRange();r.selectNodeContents(root.querySelector('p'));w.getSelection().removeAllRanges();w.getSelection().addRange(r);doc.dispatchEvent(new w.Event('selectionchange'));
  const size=doc.querySelector('[data-fontsize]');size.value='12';size.dispatchEvent(new w.Event('change',{bubbles:true}));doc.querySelector('[data-size-step=up]').click();expect(size.value).toBe('14');expect(root.innerHTML).toContain('<br>');expect(doc.querySelector('.doc-save-status').textContent).toBe('No unsaved changes');
 });
 it('selects the document without creating an edit, and disables editing tools for locked content',()=>{
  const {doc,w,root}=setup('<p>Text</p><p data-doc-locked="true">Protected</p>',true);doc.querySelector('[data-select-all]').click();
  expect(w.getSelection().toString()).toContain('Protected');expect(doc.querySelector('.doc-save-status').textContent).toBe('No unsaved changes');expect(doc.querySelector('[data-size-step=up]').disabled).toBe(true);expect(doc.querySelector('[data-clipboard=cut]').disabled).toBe(true);expect(doc.querySelector('[data-clipboard=copy]').disabled).toBe(false);
 });
 it('never deletes a selection when clipboard Cut is denied',async()=>{
  const {doc,w,root,select}=setup('<p>Text</p>',true);Object.defineProperty(w.navigator,'clipboard',{value:{writeText:vi.fn(async()=>{throw Error('Denied');})},configurable:true});select(root.querySelector('p').firstChild,0,4);doc.querySelector('[data-clipboard=cut]').click();await new Promise(r=>setTimeout(r,0));expect(root.textContent).toBe('Text');expect(doc.querySelector('.doc-save-status').textContent).toBe('No unsaved changes');
 });
 it('does not cut at a changed selection while clipboard permission is pending',async()=>{
  const {doc,w,root,select}=setup('<p>First Second</p>',true);let finish!:()=>void;Object.defineProperty(w.navigator,'clipboard',{value:{writeText:vi.fn(()=>new Promise<void>(r=>{finish=r;}))},configurable:true});select(root.querySelector('p').firstChild,0,5);doc.querySelector('[data-clipboard=cut]').click();select(root.querySelector('p').firstChild,6,12);finish();await new Promise(r=>setTimeout(r,0));expect(root.textContent).toBe('First Second');expect(doc.querySelector('.doc-save-status').textContent).toBe('No unsaved changes');
 });
 it('adds reusable headers/footers without replacing selected writing, with undo',()=>{
  const {doc,root,ed,select}=setup('<p>Text</p>');select(root.querySelector('p').firstChild,0,4);doc.querySelector('[data-open-page-tool=header]').click();expect(root.querySelector('.doc-running-header').textContent).toBe('Document header');expect(root.querySelector('p').textContent).toBe('Text');ed._history.flush();ed._history.undo();expect(root.querySelector('.doc-running-header')).toBeNull();
  select(root.querySelector('p').firstChild,0,4);doc.querySelector('[data-open-page-tool=footer]').click();expect(root.querySelector('.doc-running-footer').textContent).toBe('Document footer');expect(root.querySelector('p').textContent).toBe('Text');doc.querySelector('[data-open-page-tool=footer]').click();expect(root.querySelectorAll('.doc-running-footer')).toHaveLength(1);
 });
});
