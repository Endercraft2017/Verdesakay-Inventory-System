import {describe,it,expect,vi,afterEach} from 'vitest';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
const source=fs.readFileSync(new URL('../public/js/doc-editor.js',import.meta.url),'utf8');
const uiSource=fs.readFileSync(new URL('../public/js/ui.js',import.meta.url),'utf8');
const windows:JSDOM[]=[];
afterEach(()=>windows.splice(0).forEach(dom=>dom.window.close()));
function setup(body='<p>Original content</p>'){
 const dom=new JSDOM('<div id="view"></div><div id="modal-root"></div><div id="toasts"></div>',{url:'https://studio.test',runScripts:'dangerously',pretendToBeVisual:true});windows.push(dom);
 const w=dom.window as any;w.eval(uiSource+';window.UI=UI;');w.UI.confirmDialog=vi.fn(async()=>true);
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

});
