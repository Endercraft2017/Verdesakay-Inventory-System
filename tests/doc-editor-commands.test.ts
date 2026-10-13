import {describe,it,expect,vi,afterEach} from 'vitest';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
const source=fs.readFileSync(new URL('../public/js/doc-editor.js',import.meta.url),'utf8');
const modelSource=fs.readFileSync(new URL('../public/js/doc-model.js',import.meta.url),'utf8');
const uiSource=fs.readFileSync(new URL('../public/js/ui.js',import.meta.url),'utf8');
const windows:JSDOM[]=[];
afterEach(()=>windows.splice(0).forEach(dom=>dom.window.close()));
function setup(body='<p>Original content</p>',withModel=false){
 const dom=new JSDOM('<div id="view"></div><div id="modal-root"></div><div id="toasts"></div>',{url:'https://studio.test',runScripts:'dangerously',pretendToBeVisual:true});windows.push(dom);
 const w=dom.window as any;w.eval(uiSource+';window.UI=UI;');w.UI.confirmDialog=vi.fn(async()=>true);
 if(withModel)w.eval(modelSource);
 w.document.execCommand=vi.fn(()=>true);w.document.queryCommandState=vi.fn(()=>false);w.eval(source);
 const ed=w.DocEditor.open({name:'Commands',body,getVariables:()=>[],onSave:()=>true});
 const root=w.document.querySelector('.doc-surface');
 function select(node:Node,start=0,end=4){w.getSelection().setBaseAndExtent(node,start,node,end);w.document.dispatchEvent(new w.Event('selectionchange'));}
 return {w,ed,root,doc:w.document,select};
}
describe('document command dispatch',()=>{
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
