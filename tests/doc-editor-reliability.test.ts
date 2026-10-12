import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
const source = fs.readFileSync(new URL('../public/js/doc-editor.js', import.meta.url), 'utf8');
const uiSource = fs.readFileSync(new URL('../public/js/ui.js', import.meta.url), 'utf8');
const windows: JSDOM[] = [];
afterEach(() => { windows.splice(0).forEach((dom) => dom.window.close()); });
function setup(onSave: (value: any) => any = () => 'keep open') {
  const dom = new JSDOM('<html><body></body></html>', { runScripts: 'dangerously', pretendToBeVisual: true });
  windows.push(dom);
  const w = dom.window as any;
  const ui = { esc: String, toast: vi.fn(), confirmDialog: vi.fn(async () => true), modal: vi.fn() };
  w.UI = ui; w.eval(source);
  const ed = w.DocEditor.open({ name: 'Original', body: '<p>Original content</p>', periodLabel: 'Period', typeOptions: ['sale','generic'], getVariables: () => [], onSave });
  const doc = w.document;
  const change = (selector: string, value: string | boolean) => {
    const el = doc.querySelector(selector);
    if (typeof value === 'boolean') el.checked = value; else el.value = value;
    el.dispatchEvent(new w.Event('change', { bubbles: true }));
  };
  return { w, doc, ed, ui, change };
}

describe('editor preservation and saving', () => {
  it.each([['.doc-fs-name','Renamed'],['.doc-fs-type','generic'],['.doc-fs-period','October']])('warns before discarding metadata change %s', async (selector, value) => {
    const { ed, ui, change } = setup(); change(selector, value); await ed.close();
    expect(ui.confirmDialog).toHaveBeenCalledOnce();
  });
  it('preserves content if the code bundle is missing or mount throws', () => {
    for (const broken of [undefined, { mount() { throw new Error('mount failure'); } }]) {
      const { w, doc, ui } = setup(); w.CMBundle = broken;
      doc.querySelector('[data-mode="code"]').click();
      expect(doc.querySelector('.doc-surface').textContent).toBe('Original content');
      expect(doc.querySelector('[data-mode="visual"]').classList.contains('active')).toBe(true);
      expect(ui.toast).toHaveBeenCalled();
    }
  });
  it('round trips code mode without reporting an unchanged document as dirty', async () => {
    const { w, doc, ed, ui } = setup();
    w.CMBundle = { mount(_root: Element, options: any) { let text = ''; return { setValue(v: string) { text = v; options.onChange(); }, getValue: () => text, focus() {}, destroy() {} }; } };
    doc.querySelector('[data-mode="code"]').click(); doc.querySelector('[data-mode="visual"]').click();
    await ed.close(); expect(ui.confirmDialog).not.toHaveBeenCalled();
  });
  it('undoes and redoes every print-grid setting', () => {
    const { ed, doc, change } = setup();
    change('.doc-copies','2'); change('.doc-records-per-page','3'); change('.doc-tile-fill','repeat'); change('.doc-continuous',true); change('.doc-repeat','4');
    ed._history.flush(); ed._history.undo();
    expect(doc.querySelector('.doc-copies').value).toBe('1'); expect(doc.querySelector('.doc-records-per-page').value).toBe('1');
    expect(doc.querySelector('.doc-tile-fill').value).toBe('blank'); expect(doc.querySelector('.doc-continuous').checked).toBe(false); expect(doc.querySelector('.doc-repeat').value).toBe('1');
    ed._history.redo(); expect(doc.querySelector('.doc-copies').value).toBe('2'); expect(doc.querySelector('.doc-repeat').value).toBe('4'); expect(doc.querySelector('.doc-continuous').checked).toBe(true);
  });
  it('keeps new edits made during a pending save', async () => {
    let finish!: (value: boolean) => void;
    const saved = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const { doc, change } = setup(saved);
    doc.querySelector('[data-save]').click(); change('.doc-fs-name','Still editing');
    finish(true); await Promise.resolve(); await Promise.resolve();
    expect(doc.querySelector('.doc-fs')).not.toBeNull(); expect(doc.querySelector('.doc-save-status').textContent).toBe('Unsaved changes');
    expect(saved).toHaveBeenCalledOnce();
  });
  it('keeps the editor and content open after a save conflict', async () => {
    const { doc, ui } = setup(async () => { throw new Error('Template changed'); });
    doc.querySelector('[data-save]').click(); await new Promise((resolve) => setTimeout(resolve, 0));
    expect(doc.querySelector('.doc-surface').textContent).toBe('Original content');
    expect(doc.querySelector('.doc-save-status').textContent).toBe('Save failed'); expect(ui.toast).toHaveBeenCalledWith('Template changed','error');
  });
  it('blocks empty formatted documents and oversized grids', () => {
    const saved = vi.fn(); const { w, doc, change } = setup(saved);
    doc.querySelector('.doc-surface').innerHTML = '<p><br></p>';
    doc.querySelector('[data-save]').click(); expect(saved).not.toHaveBeenCalled();
    doc.querySelector('.doc-surface').innerHTML = '<p>Content</p>';
    change('.doc-copies','6'); change('.doc-records-per-page','6');
    doc.querySelector('[data-save]').click(); expect(saved).not.toHaveBeenCalled();
  });
  it('keeps native undo in metadata inputs while allowing Ctrl+S there', async () => {
    const save = vi.fn(() => 'keep open'); const {w,doc,change} = setup(save); change('.doc-fs-name','Renamed');
    const name = doc.querySelector('.doc-fs-name'); const undo = new w.KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true,cancelable:true}); name.dispatchEvent(undo); expect(undo.defaultPrevented).toBe(false);
    name.dispatchEvent(new w.KeyboardEvent('keydown',{key:'s',ctrlKey:true,bubbles:true,cancelable:true})); await Promise.resolve(); expect(save).toHaveBeenCalledOnce();
  });
  it('protects reload and removes that listener on close', async () => {
    const { w, change, ed } = setup(); change('.doc-fs-name','Changed');
    const before = new w.Event('beforeunload', { cancelable: true }); w.dispatchEvent(before); expect(before.defaultPrevented).toBe(true);
    await ed.close(); const after = new w.Event('beforeunload', { cancelable: true }); w.dispatchEvent(after); expect(after.defaultPrevented).toBe(false);
  });
});

const mod: any = { exports: {} }; new Function('module','exports',source)(mod,mod.exports);
const helpers = mod.exports;
function surface(body: string) { const dom = new JSDOM('<div id="r"></div>'); windows.push(dom); const root = dom.window.document.querySelector('#r')!; root.innerHTML = body; return root; }
describe('repeat boundaries and paste safety', () => {
  it.each([
    '<table><tbody>{{#items}}<tr><td>{{name}}</td></tr><tr><td>{{quantity}}</td></tr>{{/items}}</tbody></table>',
    '<table><tbody>{{#other_deductions}}<tr><td>{{name}}</td></tr>{{/other_deductions}}</tbody></table>',
    '<table><tbody>{{#if order.notes}}<tr><td>{{order.notes}}</td></tr>{{/if}}</tbody></table>',
    '<table><tbody><tr><td><table><tbody>{{#items}}<tr><td>{{name}}</td></tr><tr><td>{{quantity}}</td></tr>{{/items}}</tbody></table></td></tr></tbody></table>',
  ])('keeps table block boundaries through visual editing', (body) => {
    const root = surface(helpers.bodyToEditorHtml(body)); expect(helpers.serializeEditor(root)).toBe(body);
    const pasted = surface(helpers.sanitizeHtml(root.innerHTML,root.ownerDocument)); expect(helpers.serializeEditor(pasted)).toBe(body);
  });
  it('removes obfuscated active links and disallowed tags despite editor classes', () => {
    const root = surface(''); const safe = helpers.sanitizeHtml('<a href="java&#10;script:alert(1)">link</a><iframe class="doc-chip"></iframe><object class="doc-checkbox">label</object>',root.ownerDocument);
    expect(safe).toBe('<a>link</a>label');
    expect(helpers.safeDocumentUrl('mailto:office@example.com')).toBe(true); expect(helpers.safeDocumentUrl('/documents/1')).toBe(true);
  });
});

describe('logical table operations', () => {
  it('deletes the correct column after a colspan and keeps nested tables intact', () => {
    const root = surface('<table><tbody><tr><td colspan="2">A</td><td>B</td></tr><tr><td>C<table><tr><td>nested</td></tr></table></td><td>D</td><td>E</td></tr></tbody></table>');
    const table = root.querySelector('table')!; helpers.editTableColumn(table.rows[0]!.cells[1]!,true);
    expect(table.rows[0]!.cells[0]!.colSpan).toBe(2); expect(table.rows[0]!.cells.length).toBe(1);
    expect(table.rows[1]!.cells.length).toBe(2); expect(table.querySelector('table')!.rows[0]!.cells[0]!.textContent).toBe('nested');
  });
  it('inserts a logical column through a span', () => {
    const root = surface('<table><tr><td>A</td><td>B</td></tr><tr><td colspan="2">C</td></tr></table>');
    const table = root.querySelector('table')!; helpers.editTableColumn(table.rows[0]!.cells[0]!);
    expect(table.rows[0]!.cells.length).toBe(3); expect(table.rows[1]!.cells[0]!.colSpan).toBe(3);
  });
  it('splits a two-dimensional span without shifting later columns', () => {
    const root = surface('<table><tbody><tr><td rowspan="2" colspan="2">A</td><td>B</td></tr><tr><td>C</td></tr></tbody></table>');
    const table = root.querySelector('table')!; helpers.splitTableCell(table.rows[0]!.cells[0]!);
    expect([...table.rows].map((r) => r.cells.length)).toEqual([3,3]); expect(table.rows[1]!.cells[2]!.textContent).toBe('C');
  });
  it('preserves a spanning cell when its origin row is deleted', () => {
    const root = surface('<table><tbody><tr><td rowspan="2">Keep</td><td>Delete</td></tr><tr><td>Next</td></tr></tbody></table>');
    const table = root.querySelector('table')!; helpers.editTableRow(table.rows[0]!.cells[1]!,true);
    expect(table.rows.length).toBe(1); expect([...table.rows[0]!.cells].map((c) => c.textContent)).toEqual(['Keep','Next']); expect(table.rows[0]!.cells[0]!.rowSpan).toBe(1);
  });
  it('rejects a merge that intersects an unselected spanning cell', () => {
    const root = surface('<table><tr><td>A</td><td rowspan="2">B</td></tr><tr><td>C</td></tr></table>');
    const table = root.querySelector('table')!; const before = table.outerHTML;
    expect(helpers.mergeTableCells([table.rows[0]!.cells[0]!,table.rows[0]!.cells[1]!])).toBe(false); expect(table.outerHTML).toBe(before);
  });
});

describe('shared document output', () => {
  it('uses the physical content width for tiled previews without changing cell-relative floats', () => {
    const dom = new JSDOM('<body></body>'); windows.push(dom);
    const ui = new Function('document','window',uiSource + ';return UI;')(dom.window.document,dom.window);
    const html = ui.printableHtml('<style data-docpage>@page{size:210mm 297mm;margin:14mm}</style><div class="tiled-grid"><div><div class="doc-float" style="left:50%;top:20%"></div></div></div>','Tiled');
    expect(html).toContain('width:182mm'); expect(html).toContain('left:50%');
  });
  it('maps paper-relative floats into printable content coordinates', () => {
    const dom = new JSDOM('<body></body>'); windows.push(dom);
    const ui = new Function('document','window',uiSource + ';return UI;')(dom.window.document,dom.window);
    const html = ui.printableHtml('<style data-docpage>@page{size:210mm 297mm;margin:14mm}</style><div class="doc-float" style="left:50%;top:50%;width:20%;height:10%"></div>','Test');
    const output = new JSDOM(html); windows.push(output); const float = output.window.document.querySelector('.doc-float') as HTMLElement;
    expect(float.style.left).toBe('91mm'); expect(float.style.top).toBe('134.5mm'); expect(float.style.width).toBe('42mm'); expect(float.style.height).toBe('29.7mm');
    expect(ui.documentCss).toContain('line-height: 1.55'); expect(html).toContain('width:182mm');
  });
});

describe('Wordcraft foundation: selection and editing transactions', () => {
  function caret(w: any, node: Node, offset: number) { w.getSelection().setBaseAndExtent(node, offset, node, offset); }
  function type(w: any, root: Element, text: string, inputType = 'insertText') {
    root.dispatchEvent(new w.InputEvent('beforeinput', { inputType, data: text, bubbles: true, cancelable: true }));
    const range = w.getSelection().getRangeAt(0); range.deleteContents();
    const node = w.document.createTextNode(text); range.insertNode(node); caret(w, node, text.length);
    root.dispatchEvent(new w.InputEvent('input', { inputType, data: text, bubbles: true }));
  }
  it('restores the original caret on undo and the resulting caret on redo, despite adjacent text nodes', () => {
    const {w,doc,ed} = setup(); const root = doc.querySelector('.doc-surface');
    caret(w,root.querySelector('p').firstChild,8); type(w,root,'new '); ed._history.flush();
    ed._history.undo(); expect(root.textContent).toBe('Original content'); expect(w.getSelection().anchorOffset).toBe(8);
    ed._history.redo(); expect(root.textContent).toBe('Originalnew  content'); expect(w.getSelection().anchorOffset).toBe(12);
  });
  it('enables Undo immediately for the first typing burst', () => {
    const {w,doc}=setup(); const root=doc.querySelector('.doc-surface');
    caret(w,root.querySelector('p').firstChild,0); type(w,root,'A'); type(w,root,'B');
    const undo=doc.querySelector('[data-ex=undo]'); expect(undo.disabled).toBe(false);undo.click();
    expect(root.textContent).toBe('Original content');doc.querySelector('[data-ex=redo]').click();
    expect(root.textContent).toBe('ABOriginal content');
  });
  it('preserves a backwards selection when replacement text is undone', () => {
    const {w,doc,ed} = setup(); const root = doc.querySelector('.doc-surface'), text = root.querySelector('p').firstChild;
    w.getSelection().setBaseAndExtent(text,8,text,0); type(w,root,'New'); ed._history.undo();
    expect(w.getSelection().toString()).toBe('Original');
    expect(w.getSelection().anchorOffset).toBe(8); expect(w.getSelection().focusOffset).toBe(0);
  });
  it('separates typing after a caret move and discards the redo branch after a new edit', () => {
    const {w,doc,ed} = setup(); const root = doc.querySelector('.doc-surface');
    caret(w,root.querySelector('p').firstChild,0); type(w,root,'A');
    caret(w,root.querySelector('p').lastChild,root.querySelector('p').lastChild.length); type(w,root,'B');
    ed._history.undo(); expect(root.textContent).toBe('AOriginal content');
    ed._history.undo(); expect(root.textContent).toBe('Original content');
    type(w,root,'C'); ed._history.flush(); ed._history.redo(); expect(root.textContent).toBe('COriginal content');
  });
  it('routes browser beforeinput history commands through editor history once', () => {
    const {w,doc} = setup(); const root = doc.querySelector('.doc-surface');
    caret(w,root.querySelector('p').firstChild,0); type(w,root,'A');
    const event = new w.InputEvent('beforeinput',{inputType:'historyUndo',bubbles:true,cancelable:true}); root.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true); expect(root.textContent).toBe('Original content');
    root.dispatchEvent(new w.InputEvent('beforeinput',{inputType:'historyRedo',bubbles:true,cancelable:true})); expect(root.textContent).toBe('AOriginal content');
  });
  it('keeps a long composition as one undo step and does not consume IME keyboard events', async () => {
    const {w,doc,ed} = setup(); const root = doc.querySelector('.doc-surface');
    caret(w,root.querySelector('p').firstChild,0);
    root.dispatchEvent(new w.CompositionEvent('compositionstart',{bubbles:true}));
    type(w,root,'あ','insertCompositionText'); await new Promise(r=>setTimeout(r,400));
    const key = new w.KeyboardEvent('keydown',{key:'z',ctrlKey:true,isComposing:true,bubbles:true,cancelable:true}); root.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(false);
    type(w,root,'い','insertCompositionText');
    root.dispatchEvent(new w.CompositionEvent('compositionend',{bubbles:true,data:'あい'})); await Promise.resolve();
    ed._history.undo(); expect(root.textContent).toBe('Original content');
    ed._history.redo(); expect(root.textContent).toBe('あいOriginal content');
  });
  it('restores selections around variable chips, empty cells and float controls after serialization', () => {
    const root = surface('<table><tbody><tr><td><br></td><td>Before {{name}} after</td></tr></tbody></table><div class="doc-float"><p>Text</p><button class="doc-float-handle">UI</button></div>');
    root.innerHTML=helpers.bodyToEditorHtml(root.innerHTML);
    const win = root.ownerDocument.defaultView!; const cell=root.querySelectorAll('td')[1]!;
    win.getSelection()!.setBaseAndExtent(cell.lastChild!,3,cell.firstChild!,2);
    const bookmark=helpers.captureEditorSelection(root); root.innerHTML=helpers.bodyToEditorHtml(helpers.serializeEditor(root));
    expect(helpers.restoreEditorSelection(root,bookmark)).toBe(true); expect(win.getSelection()!.anchorOffset).toBe(3);expect(win.getSelection()!.focusOffset).toBe(2);
    const empty=root.querySelector('td')!;win.getSelection()!.setBaseAndExtent(empty,0,empty,0);
    const emptyBookmark=helpers.captureEditorSelection(root);root.innerHTML=helpers.bodyToEditorHtml(helpers.serializeEditor(root));helpers.restoreEditorSelection(root,emptyBookmark);
    expect(win.getSelection()!.anchorNode).toBe(root.querySelector('td'));
  });
});
