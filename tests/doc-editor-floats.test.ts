/** DocEditor Visual mode: floating shapes/text boxes + "wrap behind/in front of text" for
    promoted images & tables. Loads doc-editor.js as a real <script> in jsdom (not the CommonJS
    module.exports path used by doc-editor.test.ts) since this exercises the interactive
    `DocEditor.open()` surface, not just the pure transform helpers. jsdom does no real layout,
    so `getBoundingClientRect()` is stubbed to approximate positions from each element's inline
    % styles against a fixed 816x1056 page — enough to exercise the percentage-conversion math
    structurally, though real drag/resize *feel* still needs a browser check. */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const PAGE_W = 816, PAGE_H = 1056;

function setup() {
  const docEditorSrc = fs.readFileSync(path.join(import.meta.dirname, '../public/js/doc-editor.js'), 'utf8')
    .replace("if (typeof module !== 'undefined' && module.exports) {", 'if (false) {');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, runScripts: 'dangerously' });
  const { window } = dom;

  window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.classList && this.classList.contains('doc-surface')) {
      return { left: 0, top: 0, width: PAGE_W, height: PAGE_H, right: PAGE_W, bottom: PAGE_H } as DOMRect;
    }
    const pct = (v: string | undefined) => { const m = /^(-?[\d.]+)%$/.exec(v || ''); return m ? parseFloat(m[1] ?? '0') : null; };
    const l = pct(this.style.left), t = pct(this.style.top), w = pct(this.style.width), h = pct(this.style.height);
    const left = l != null ? (l / 100) * PAGE_W : 50, top = t != null ? (t / 100) * PAGE_H : 50;
    const width = w != null ? (w / 100) * PAGE_W : 100, height = h != null ? (h / 100) * PAGE_H : 40;
    return { left, top, width, height, right: left + width, bottom: top + height } as DOMRect;
  };
  // jsdom 29 has PointerEvent but not the capture methods — DocEditor guards for this, stub anyway.
  window.HTMLElement.prototype.setPointerCapture = function () { /* no-op */ };
  window.HTMLElement.prototype.releasePointerCapture = function () { /* no-op */ };

  (window as unknown as { UI: unknown }).UI = {
    esc: (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    modal: () => ({ overlay: window.document.createElement('div'), close() {} }),
    toast: () => {},
    confirmDialog: () => Promise.resolve(true),
    contextMenu: () => {},
  };

  const scriptEl = window.document.createElement('script');
  scriptEl.textContent = docEditorSrc;
  window.document.body.appendChild(scriptEl);

  return { window, document: window.document };
}

function click(el: Element) { el.dispatchEvent(new (el.ownerDocument!.defaultView as any).MouseEvent('click', { bubbles: true })); }
// Float drag/resize runs on Pointer Events (+ pointer capture) — dispatch those, not mouse events.
function pointerdown(el: Element, opts: Record<string, unknown> = {}) {
  el.dispatchEvent(new (el.ownerDocument!.defaultView as any).PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, ...opts }));
}
function pointermove(doc: Document, opts: Record<string, unknown>) {
  doc.dispatchEvent(new (doc.defaultView as any).PointerEvent('pointermove', { bubbles: true, pointerId: 1, ...opts }));
}
function pointerup(doc: Document, opts: Record<string, unknown> = {}) {
  doc.dispatchEvent(new (doc.defaultView as any).PointerEvent('pointerup', { bubbles: true, pointerId: 1, ...opts }));
}

describe('DocEditor floating objects', () => {
  let window: JSDOM['window'];
  let document: Document;

  beforeEach(() => {
    ({ window, document } = setup());
  });

  function openEditor(body = '<p>hello</p>') {
    let saved: string | null = null;
    const ret = (window as unknown as { DocEditor: any }).DocEditor.open({
      title: 'T', name: 'N', typeOptions: ['generic'], body,
      getVariables: () => [],
      onSave: async ({ body: b }: { body: string }) => { saved = b; return true; },
    });
    const fs_ = document.querySelector('.doc-fs') as HTMLElement;
    const surface = fs_.querySelector('.doc-surface') as HTMLElement;
    return { fs: fs_, surface, getSaved: () => saved, history: ret._history as any, close: ret.close };
  }

  it('renders a Shapes group with Rectangle/Oval/Line tiles', () => {
    const { fs } = openEditor();
    expect(fs.querySelector('[data-ins="shape-rect"]')).toBeTruthy();
    expect(fs.querySelector('[data-ins="shape-oval"]')).toBeTruthy();
    expect(fs.querySelector('[data-ins="shape-line"]')).toBeTruthy();
  });

  it('inserting a shape appends a floating, non-editable, front-wrapped object', () => {
    const { fs, surface } = openEditor();
    click(fs.querySelector('[data-ins="shape-rect"]')!);
    const floats = surface.querySelectorAll('.doc-float');
    expect(floats.length).toBe(1);
    const el = floats[0] as HTMLElement;
    expect(el.getAttribute('data-float-kind')).toBe('shape-rect');
    expect(el.style.zIndex).toBe('1');
    expect(el.getAttribute('contenteditable')).toBe('false');
    expect(el.style.position).toBe('absolute');
    // selected immediately on insert -> handles + toolbar present
    expect(el.classList.contains('selected')).toBe(true);
    expect(el.querySelectorAll('.doc-float-handle').length).toBe(8);
    expect(el.querySelector('.doc-float-toolbar')).toBeTruthy();
  });

  it('inserting a text box gives it an editable inner island', () => {
    const { fs, surface } = openEditor();
    click(fs.querySelector('[data-ins="textbox"]')!);
    const el = surface.querySelector('.doc-float[data-float-kind="textbox"]')!;
    expect(el.getAttribute('contenteditable')).toBe('false');
    const body = el.querySelector('.doc-float-body')!;
    expect(body.getAttribute('contenteditable')).toBe('true');
  });

  it('z-up/z-down nudge the z-index by ±1, clamped to [-2, 60], and toggle the behind-text hint', () => {
    const { fs, surface } = openEditor();
    click(fs.querySelector('[data-ins="shape-rect"]')!);
    const el = surface.querySelector('.doc-float')! as HTMLElement;
    expect(el.style.zIndex).toBe('1'); // fresh insert defaults to "in front" (z=1)
    const up = () => click(el.querySelector('[data-float-act="z-up"]') as HTMLElement);
    const down = () => click(el.querySelector('[data-float-act="z-down"]') as HTMLElement);
    down(); down(); down();
    expect(el.style.zIndex).toBe('-2'); // 1 -> 0 -> -1 -> -2, a nudge not a fixed jump
    expect(el.classList.contains('behind-text')).toBe(true); // negative z -> "behind the text" hint
    down(); down();
    expect(el.style.zIndex).toBe('-2'); // clamped at the floor, never deeper
    up(); up();
    expect(el.style.zIndex).toBe('0');
    expect(el.classList.contains('behind-text')).toBe(false); // back to >= 0 -> hint cleared
    up();
    expect(el.style.zIndex).toBe('1');
  });

  it('the delete toolbar button removes the float', () => {
    const { fs, surface } = openEditor();
    click(fs.querySelector('[data-ins="shape-oval"]')!);
    expect(surface.querySelectorAll('.doc-float').length).toBe(1);
    const delBtn = surface.querySelector('[data-float-act="delete"]') as HTMLElement;
    click(delBtn);
    expect(surface.querySelectorAll('.doc-float').length).toBe(0);
  });

  it('the Delete key removes a selected float (frame selection, not inner text editing)', () => {
    const { fs, surface } = openEditor();
    click(fs.querySelector('[data-ins="shape-line"]')!);
    expect(surface.querySelectorAll('.doc-float').length).toBe(1);
    document.dispatchEvent(new (window as any).KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    expect(surface.querySelectorAll('.doc-float').length).toBe(0);
  });

  function keydown(key: string, opts: Record<string, unknown> = {}) {
    document.dispatchEvent(new (window as any).KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts }));
  }

  it('Escape drops the float selection instead of closing the editor', () => {
    const { fs, surface } = openEditor();
    click(fs.querySelector('[data-ins="shape-rect"]')!);
    const el = surface.querySelector('.doc-float')! as HTMLElement;
    expect(el.classList.contains('selected')).toBe(true);
    keydown('Escape');
    expect(el.classList.contains('selected')).toBe(false);
    expect(surface.querySelector('.doc-float-handle')).toBeFalsy();
    expect(document.querySelector('.doc-fs')).toBeTruthy(); // editor stays open (Escape was consumed by the selection)
  });

  it('pressing the grey desk outside the page clears a float selection', () => {
    const { fs, surface } = openEditor();
    const canvas = fs.querySelector('.doc-canvas')!;
    click(fs.querySelector('[data-ins="shape-rect"]')!);
    expect((surface.querySelector('.doc-float') as HTMLElement).classList.contains('selected')).toBe(true);
    canvas.dispatchEvent(new (window as any).PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1 }));
    expect((surface.querySelector('.doc-float') as HTMLElement).classList.contains('selected')).toBe(false);
  });

  function shiftClick(el: Element) {
    el.dispatchEvent(new (el.ownerDocument!.defaultView as any).MouseEvent('click', { bubbles: true, shiftKey: true }));
  }

  it('shift-click builds a temporary group that moves and deletes as one', () => {
    const { fs, surface } = openEditor();
    click(fs.querySelector('[data-ins="shape-rect"]')!); // A, left 8%
    click(fs.querySelector('[data-ins="shape-oval"]')!); // B, left 12%
    const a = surface.querySelectorAll('.doc-float')[0] as HTMLElement;
    const b = surface.querySelectorAll('.doc-float')[1] as HTMLElement;
    click(a);          // single-select A
    shiftClick(b);     // -> temporary group {A, B}
    expect(a.classList.contains('multi')).toBe(true);
    expect(b.classList.contains('multi')).toBe(true);
    expect(surface.querySelector('.doc-float-handle')).toBeFalsy(); // no single-select chrome in group mode
    const aL = parseFloat(a.style.left), bL = parseFloat(b.style.left);
    pointerdown(b, { clientX: 0, clientY: 0 });
    pointermove(document, { clientX: 60, clientY: 0 });
    pointerup(document, { clientX: 60, clientY: 0 });
    // both shifted by the same delta
    expect(parseFloat(a.style.left) - aL).toBeCloseTo(parseFloat(b.style.left) - bL, 3);
    expect(parseFloat(a.style.left)).toBeGreaterThan(aL);
    // Delete removes the whole group
    keydown('Delete');
    expect(surface.querySelectorAll('.doc-float').length).toBe(0);
  });

  it('a plain (non-shift) click collapses the temporary group back to a single selection', () => {
    const { fs, surface } = openEditor();
    click(fs.querySelector('[data-ins="shape-rect"]')!);
    click(fs.querySelector('[data-ins="shape-oval"]')!);
    const a = surface.querySelectorAll('.doc-float')[0] as HTMLElement;
    const b = surface.querySelectorAll('.doc-float')[1] as HTMLElement;
    click(a); shiftClick(b);
    expect(b.classList.contains('multi')).toBe(true);
    click(a); // plain click -> just A
    expect(a.classList.contains('multi')).toBe(false);
    expect(b.classList.contains('multi')).toBe(false);
    expect(a.classList.contains('selected')).toBe(true);
  });

  it('does not offer "make movable" for a page-spanning container (the whole-doc trap)', () => {
    const { fs, surface } = openEditor('<div class="doc" style="width:95%;height:95%"><h1>Head</h1><table class="doc-table"><tbody><tr><td>x</td></tr></tbody></table></div>');
    click(surface.querySelector('.doc')!);
    expect(surface.querySelector('.doc-promote-bar')).toBeFalsy();
    // but a specific child still promotes fine
    click(surface.querySelector('h1')!);
    expect(surface.querySelector('.doc-promote-bar')).toBeTruthy();
  });

  it('drag (pointerdown+pointermove+pointerup on the frame) updates left/top', () => {
    const { fs, surface } = openEditor();
    click(fs.querySelector('[data-ins="shape-rect"]')!);
    const el = surface.querySelector('.doc-float')! as HTMLElement;
    const startLeft = el.style.left, startTop = el.style.top;
    pointerdown(el, { clientX: 100, clientY: 100 });
    pointermove(document, { clientX: 180, clientY: 140 });
    pointerup(document, { clientX: 180, clientY: 140 });
    expect(el.style.left).not.toBe(startLeft);
    expect(el.style.top).not.toBe(startTop);
  });

  it('resize (pointerdown on a handle) updates width/height', () => {
    const { fs, surface } = openEditor();
    click(fs.querySelector('[data-ins="shape-rect"]')!);
    const el = surface.querySelector('.doc-float')! as HTMLElement;
    const startW = el.style.width, startH = el.style.height;
    const se = el.querySelector('[data-h="se"]') as HTMLElement;
    pointerdown(se, { clientX: 200, clientY: 200 });
    pointermove(document, { clientX: 260, clientY: 250 });
    pointerup(document, { clientX: 260, clientY: 250 });
    expect(el.style.width).not.toBe(startW);
    expect(el.style.height).not.toBe(startH);
  });

  it('promotes a plain inline image to a floating object, then z-down sends it behind text', () => {
    const { fs, surface } = openEditor('<p>text <img src="data:image/png;base64,x" alt="pic"> more</p>');
    const img = surface.querySelector('img')!;
    click(img); // shows the single "make movable" promote bar (no more front/behind wording)
    const makeBtn = surface.querySelector('.doc-promote-bar [data-promote="make"]') as HTMLElement;
    expect(makeBtn).toBeTruthy();
    click(makeBtn);
    const floatEl = surface.querySelector('.doc-float[data-float-kind="image"]')! as HTMLElement;
    expect(floatEl).toBeTruthy();
    expect(floatEl.style.zIndex).toBe('1'); // starts in front
    expect(floatEl.contains(img)).toBe(true);
    // the float's own toolbar sends it behind, one step at a time
    click(floatEl.querySelector('[data-float-act="z-down"]') as HTMLElement);
    click(floatEl.querySelector('[data-float-act="z-down"]') as HTMLElement);
    expect(floatEl.style.zIndex).toBe('-1');
    void fs;
  });

  it('dismisses transient promotion chrome when focus leaves the canvas while keeping its own action reachable', () => {
    const {fs,surface}=openEditor('<p>text <img src="data:image/png;base64,x" alt="pic"></p>');
    surface.focus();click(surface.querySelector('img')!);
    const make=surface.querySelector('.doc-promote-bar button') as HTMLButtonElement;
    make.focus();expect(surface.querySelector('.doc-promote-bar')).toBeTruthy();
    (fs.querySelector('.doc-fs-name') as HTMLInputElement).focus();
    expect(surface.querySelector('.doc-promote-bar')).toBeNull();
    click(surface.querySelector('img')!);expect(surface.querySelector('.doc-promote-bar')).toBeTruthy();
  });

  it('promotes a plain table and keeps it editable via the contenteditable island pattern', () => {
    const { surface } = openEditor('<table class="doc-table"><tbody><tr><td>a</td></tr></tbody></table>');
    const table = surface.querySelector('table')!;
    click(table);
    click(surface.querySelector('.doc-promote-bar [data-promote="make"]') as HTMLElement);
    const floatEl = surface.querySelector('.doc-float[data-float-kind="table"]')! as HTMLElement;
    expect(floatEl).toBeTruthy();
    expect(floatEl.contains(table)).toBe(true);
    expect(table.getAttribute('contenteditable')).toBe('true');
  });

  it('regression: promoting a table starts in move mode, even if a caret was already inside it', () => {
    // the click that opens the promote bar can leave a real caret in a cell (contenteditable) —
    // selectFloat must clear it so the new float doesn't land straight in .editing (no move frame,
    // no resize handles but the corner grip — reported as "moving/resizing is now broken").
    const { surface } = openEditor('<table class="doc-table"><tbody><tr><td>a</td></tr></tbody></table>');
    const table = surface.querySelector('table')!;
    const td = table.querySelector('td')!;
    const sel = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(td);
    sel.removeAllRanges();
    sel.addRange(range);

    click(table);
    click(surface.querySelector('.doc-promote-bar [data-promote="make"]') as HTMLElement);
    const floatEl = surface.querySelector('.doc-float[data-float-kind="table"]') as HTMLElement;
    expect(floatEl.classList.contains('selected')).toBe(true);
    expect(floatEl.classList.contains('editing')).toBe(false); // move mode, not edit mode
    expect(floatEl.querySelectorAll('.doc-float-handle').length).toBe(8); // all 8 handles present
  });

  function promoteTable() {
    const { fs, surface } = openEditor('<table class="doc-table" style="left:10%;top:10%;width:40%;height:20%"><tbody><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></tbody></table>');
    const table = surface.querySelector('table') as HTMLElement;
    click(table);
    click(surface.querySelector('.doc-promote-bar [data-promote="make"]') as HTMLElement);
    const floatEl = surface.querySelector('.doc-float[data-float-kind="table"]') as HTMLElement;
    return { fs, surface, floatEl, table };
  }

  it('a promoted table resizes on the vertical (south) handle, not just width', () => {
    const { floatEl } = promoteTable();
    const h0 = floatEl.style.height, w0 = floatEl.style.width;
    const s = floatEl.querySelector('[data-h="s"]') as HTMLElement;
    pointerdown(s, { clientX: 200, clientY: 200 });
    pointermove(document, { clientX: 200, clientY: 320 }); // straight down
    pointerup(document, { clientX: 200, clientY: 320 });
    expect(floatEl.style.height).not.toBe(h0); // vertical scaling works
    expect(floatEl.style.width).toBe(w0);      // south handle leaves width alone
  });

  it('first press on a promoted table selects it while allowing the caret immediately', () => {
    const { floatEl, table } = promoteTable();
    // fresh promote leaves it selected — deselect so we test the first-press path
    document.dispatchEvent(new (window as any).KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(floatEl.classList.contains('selected')).toBe(false);

    const pd1 = new (window as any).PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerId: 1 });
    table.dispatchEvent(pd1);
    expect(floatEl.classList.contains('selected')).toBe(true); // press 1 -> selected for move
    expect(pd1.defaultPrevented).toBe(false);                  // caret is allowed immediately

    const pd2 = new (window as any).PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerId: 1 });
    table.dispatchEvent(pd2);
    expect(pd2.defaultPrevented).toBe(false); // press 2 -> caret allowed through (edit intent)
    expect(floatEl.classList.contains('selected')).toBe(true);
  });

  it('the explicit Move grip moves an editable object without changing its inner content',()=>{
    const {floatEl,table}=promoteTable();
    const left=floatEl.style.left;const content=table.innerHTML;
    const grip=floatEl.querySelector('[data-float-move]')!;
    pointerdown(grip,{clientX:100,clientY:100});pointermove(document,{clientX:200,clientY:160});pointerup(document);
    expect(floatEl.style.left).not.toBe(left);expect(table.innerHTML).toBe(content);
  });

  it('Escape is two-stage on an editing islanded float: exit edit -> exit selection', () => {
    const { floatEl } = promoteTable();
    floatEl.classList.add('editing'); // simulate "caret is in the interior"
    const esc = () => document.dispatchEvent(new (window as any).KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    esc();
    expect(floatEl.classList.contains('editing')).toBe(false);
    expect(floatEl.classList.contains('selected')).toBe(true);  // still selected -> move handles back
    expect(document.querySelector('.doc-fs')).toBeTruthy();      // editor NOT closed
    esc();
    expect(floatEl.classList.contains('selected')).toBe(false);  // now deselected
    expect(document.querySelector('.doc-fs')).toBeTruthy();      // still not closed
  });

  it('the edit-mode corner grip resizes the table and stays in edit mode when dragged', () => {
    const { floatEl } = promoteTable();
    floatEl.classList.add('editing');
    const w0 = floatEl.style.width, h0 = floatEl.style.height;
    const se = floatEl.querySelector('[data-h="se"]') as HTMLElement;
    pointerdown(se, { clientX: 300, clientY: 300 });
    pointermove(document, { clientX: 360, clientY: 380 });
    pointerup(document, { clientX: 360, clientY: 380 });
    expect(floatEl.style.width).not.toBe(w0);
    expect(floatEl.style.height).not.toBe(h0);
    expect(floatEl.classList.contains('editing')).toBe(true); // a drag = resize, keep editing
  });

  it('tapping the corner grip (no drag) hands the move handles back', () => {
    const { floatEl } = promoteTable();
    floatEl.classList.add('editing');
    const se = floatEl.querySelector('[data-h="se"]') as HTMLElement;
    pointerdown(se, { clientX: 300, clientY: 300 });
    pointerup(document, { clientX: 300, clientY: 300 }); // no move -> a click
    expect(floatEl.classList.contains('editing')).toBe(false); // back to move mode
    expect(floatEl.classList.contains('selected')).toBe(true);
  });

  it('promotes an arbitrary element (e.g. an ID card field <div>) to a movable object', () => {
    const { surface } = openEditor('<div class="idcard-name">Jane Doe</div>');
    const nameEl = surface.querySelector('.idcard-name')!;
    click(nameEl);
    const bar = surface.querySelector('.doc-promote-bar');
    expect(bar).toBeTruthy(); // any element, not just <img>/<table>, gets the promote bar
    click(surface.querySelector('.doc-promote-bar [data-promote="make"]') as HTMLElement);
    const floatEl = surface.querySelector('.doc-float[data-float-kind="text"]')! as HTMLElement;
    expect(floatEl).toBeTruthy();
    expect(floatEl.contains(nameEl)).toBe(true);
    expect(nameEl.getAttribute('contenteditable')).toBe('true');
    // it can now be dragged like any other float
    pointerdown(floatEl, { clientX: 50, clientY: 50 });
    pointermove(document, { clientX: 90, clientY: 70 });
    pointerup(document, { clientX: 90, clientY: 70 });
    expect(floatEl.style.left).not.toBe('');
  });

  it('does not force width/height:100% on a promoted non-image element (would squash its own CSS-driven sizing)', () => {
    const { surface } = openEditor('<div class="idcard-photo" style="width:20mm;height:20mm;border-radius:50%">x</div>');
    const photoLike = surface.querySelector('.idcard-photo')!;
    click(photoLike);
    click(surface.querySelector('.doc-promote-bar [data-promote="make"]') as HTMLElement);
    // its own width/height (from the style attribute it already had) must survive untouched
    expect((photoLike as HTMLElement).style.width).toBe('20mm');
    expect((photoLike as HTMLElement).style.height).toBe('20mm');
  });

  it('DOES stretch a promoted <img> to fill its wrapper (matches Word picture-resize behavior)', () => {
    const { surface } = openEditor('<img src="data:image/png;base64,x" alt="pic">');
    const img = surface.querySelector('img')!;
    click(img);
    click(surface.querySelector('.doc-promote-bar [data-promote="make"]') as HTMLElement);
    expect((img as HTMLElement).style.width).toBe('100%');
    expect((img as HTMLElement).style.height).toBe('100%');
  });

  it('does not offer promotion for inline formatting runs (avoids breaking prose)', () => {
    const { surface } = openEditor('<p>a <b>bold word</b> b</p>');
    const b = surface.querySelector('b')!;
    click(b);
    expect(surface.querySelector('.doc-promote-bar')).toBeFalsy();
  });

  // A click inside a table always lands on a TD/TH — a single cell can't be "made movable" on
  // its own, but cells are the ONLY thing you can click INTO in a table, so the click walks up
  // to the enclosing <table> and offers to promote THAT (previously this was excluded entirely,
  // making a table impossible to ever select for promotion).
  it('clicking into a table cell offers to promote the enclosing table, not the cell', () => {
    const { surface } = openEditor('<table class="doc-table"><tbody><tr><td>cell</td></tr></tbody></table>');
    const td = surface.querySelector('td')!;
    click(td);
    const bar = surface.querySelector('.doc-promote-bar');
    expect(bar).toBeTruthy();
    expect(bar!.textContent).toContain('table');
    click(bar!.querySelector('[data-promote="make"]') as HTMLElement);
    expect(surface.querySelector('.doc-float[data-float-kind="table"]')).toBeTruthy();
  });

  it('"in line with text" unwraps a promoted image back to a plain inline <img>', () => {
    const { surface } = openEditor('<p><img src="data:image/png;base64,x" alt="pic"></p>');
    const img = surface.querySelector('img')!;
    click(img);
    click(surface.querySelector('.doc-promote-bar [data-promote="make"]') as HTMLElement);
    expect(surface.querySelector('.doc-float')).toBeTruthy();
    click(img); // re-select the (now floating) image to open its toolbar
    const inlineBtn = surface.querySelector('.doc-float-toolbar [data-float-act="inline"]') as HTMLElement;
    expect(inlineBtn).toBeTruthy();
    click(inlineBtn);
    expect(surface.querySelector('.doc-float')).toBeFalsy();
    expect(surface.querySelector('img')).toBeTruthy();
  });

  it('save strips handles/toolbar and reload restores contenteditable on the float wrapper', async () => {
    const { fs, surface, getSaved, close } = openEditor();
    click(fs.querySelector('[data-ins="shape-rect"]')!);
    // float is still .selected (handles/toolbar present) at the moment of Save
    expect(surface.querySelector('.doc-float-handle')).toBeTruthy();
    click(fs.querySelector('[data-save]')!);
    await new Promise((r) => setTimeout(r, 10));
    const saved = getSaved();
    expect(saved).toBeTruthy();
    expect(saved).toContain('class="doc-float"');
    expect(saved).toContain('data-float-kind="shape-rect"');
    expect(saved).not.toContain('doc-float-handle');
    expect(saved).not.toContain('doc-float-toolbar');
    expect(saved).not.toContain('selected');
    expect(saved).not.toContain('contenteditable');
    expect(document.querySelector('.doc-fs')).toBeTruthy(); // saving keeps the workspace open
    expect(fs.querySelector('.doc-save-status')?.textContent).toBe('Saved');
    await close(); // reopen the saved document below

    // reopen a fresh editor with the saved body -> normalizeFloats() should restore contenteditable="false"
    const second = openEditor(saved!);
    const reloaded = second.surface.querySelector('.doc-float')! as HTMLElement;
    expect(reloaded).toBeTruthy();
    expect(reloaded.getAttribute('contenteditable')).toBe('false');
  });

  // ---- canvas zoom ----
  function change(el: Element) { el.dispatchEvent(new (el.ownerDocument!.defaultView as any).Event('change', { bubbles: true })); }

  it('the Zoom select scales the page surface and sizes the .doc-zoom sizer to match', () => {
    const { fs, surface } = openEditor();
    const zoomSel = fs.querySelector('.doc-zoomsel') as HTMLSelectElement;
    const zoomWrap = fs.querySelector('.doc-zoom') as HTMLElement;
    expect(zoomSel).toBeTruthy();
    zoomSel.value = '2';
    change(zoomSel);
    expect(surface.style.transform).toBe('scale(2)');
    // A4 natural width in px = round(210 * 96/25.4) = 794 -> sizer is 794 * 2
    expect(zoomWrap.style.width).toBe('1588px');
  });

  it('the +/- zoom buttons step along the zoom ladder and 100% clears the transform', () => {
    const { fs, surface } = openEditor();
    const zin = fs.querySelector('[data-zoom="in"]') as HTMLElement;
    const zout = fs.querySelector('[data-zoom="out"]') as HTMLElement;
    click(zin);
    expect(surface.style.transform).toBe('scale(1.25)');
    click(zin);
    expect(surface.style.transform).toBe('scale(1.5)');
    click(zout); click(zout);
    expect(surface.style.transform).toBe('');
  });

  // ---- snap-to-guide ----
  it('a dragged float snaps to another float\'s left edge and shows a guide that clears on drop', () => {
    const { fs, surface } = openEditor();
    click(fs.querySelector('[data-ins="shape-rect"]')!); // float A
    const a = surface.querySelectorAll('.doc-float')[0] as HTMLElement;
    a.style.left = '25%'; // A's left edge -> 0.25 * 816 = 204px
    click(fs.querySelector('[data-ins="shape-rect"]')!); // float B, auto-selected, starts at left 12%
    const b = surface.querySelectorAll('.doc-float')[1] as HTMLElement;
    pointerdown(b, { clientX: 0, clientY: 0 });
    // B left 12% = 97.92px; +104 -> 201.92, within 6px of A's 204 -> snaps
    pointermove(document, { clientX: 104, clientY: 0 });
    const vGuide = surface.querySelector('.doc-snap-guide.v') as HTMLElement;
    expect(vGuide).toBeTruthy();
    expect(parseFloat(vGuide.style.left)).toBeCloseTo(25, 4); // guide drawn on A's left edge (25%)
    expect(parseFloat(b.style.left)).toBeCloseTo(25, 4); // B snapped exactly onto it
    pointerup(document, { clientX: 104, clientY: 0 });
    expect(surface.querySelector('.doc-snap-guide')).toBeFalsy();
  });

  it('does not snap when no edge is within tolerance', () => {
    const { fs, surface } = openEditor();
    click(fs.querySelector('[data-ins="shape-rect"]')!);
    const a = surface.querySelectorAll('.doc-float')[0] as HTMLElement;
    a.style.left = '60%';
    click(fs.querySelector('[data-ins="shape-rect"]')!);
    const b = surface.querySelectorAll('.doc-float')[1] as HTMLElement;
    pointerdown(b, { clientX: 0, clientY: 0 });
    pointermove(document, { clientX: 40, clientY: 0 }); // B left 12% (97.92px) + 40 -> 137.92, far from every line
    expect(surface.querySelector('.doc-snap-guide')).toBeFalsy();
    // free move: startLeft + dx, converted straight to % — not snapped to A's 60% nor left at the 12% start
    expect(parseFloat(b.style.left)).toBeCloseTo(((0.12 * PAGE_W + 40) / PAGE_W) * 100, 3);
    pointerup(document, { clientX: 40, clientY: 0 });
  });

  it('serializeEditor drops the editor-only behind-text class (z-index carries the meaning)', async () => {
    const { fs, surface, getSaved, close } = openEditor();
    click(fs.querySelector('[data-ins="shape-rect"]')!);
    const el = surface.querySelector('.doc-float')! as HTMLElement;
    click(el.querySelector('[data-float-act="z-down"]') as HTMLElement); // 1 -> 0
    click(el.querySelector('[data-float-act="z-down"]') as HTMLElement); // 0 -> -1  => behind-text
    expect(el.classList.contains('behind-text')).toBe(true);
    click(fs.querySelector('[data-save]')!);
    await new Promise((r) => setTimeout(r, 10));
    const saved = getSaved()!;
    expect(saved).toMatch(/z-index:\s*-1/); // the real "behind text" signal survives
    expect(saved).not.toContain('behind-text'); // the editor-only hint class does not
  });

  // ---- snapshot undo / redo ----
  it('Ctrl+Z / Ctrl+Y undo and redo a float insert (things execCommand never saw)', () => {
    const { fs, surface } = openEditor();
    click(fs.querySelector('[data-ins="shape-rect"]')!);
    expect(surface.querySelectorAll('.doc-float').length).toBe(1);
    keydown('z', { ctrlKey: true });                 // undo (flushes the pending snapshot first)
    expect(surface.querySelectorAll('.doc-float').length).toBe(0);
    keydown('y', { ctrlKey: true });                 // redo
    expect(surface.querySelectorAll('.doc-float').length).toBe(1);
    keydown('z', { ctrlKey: true });                 // undo again
    expect(surface.querySelectorAll('.doc-float').length).toBe(0);
    keydown('Z', { ctrlKey: true, shiftKey: true }); // Ctrl+Shift+Z == redo
    expect(surface.querySelectorAll('.doc-float').length).toBe(1);
  });

  it('the Undo toolbar button starts disabled, enables after an edit, and matches Ctrl+Z', () => {
    const { fs, surface, history } = openEditor();
    const undoBtn = fs.querySelector('[data-ex="undo"]') as HTMLButtonElement;
    const redoBtn = fs.querySelector('[data-ex="redo"]') as HTMLButtonElement;
    expect(undoBtn.disabled).toBe(true);
    expect(redoBtn.disabled).toBe(true);
    click(fs.querySelector('[data-ins="shape-oval"]')!);
    history.flush(); // commit the pending snapshot now (skip the debounce)
    expect(undoBtn.disabled).toBe(false);
    undoBtn.click();
    expect(surface.querySelectorAll('.doc-float').length).toBe(0);
    expect(redoBtn.disabled).toBe(false);
  });

  it('Ctrl+Z restores a float\'s position after a move (once the insert is its own step)', () => {
    const { fs, surface, history } = openEditor();
    click(fs.querySelector('[data-ins="shape-rect"]')!);
    history.flush(); // the insert is now a committed undo step
    const el = surface.querySelector('.doc-float')! as HTMLElement;
    const left0 = el.style.left;
    pointerdown(el, { clientX: 10, clientY: 10 });
    pointermove(document, { clientX: 120, clientY: 60 });
    pointerup(document, { clientX: 120, clientY: 60 });
    expect(el.style.left).not.toBe(left0);
    keydown('z', { ctrlKey: true });
    const el2 = surface.querySelector('.doc-float')! as HTMLElement; // re-queried (innerHTML was replaced)
    expect(el2).toBeTruthy();               // the float itself is still there — only the move was undone
    expect(el2.style.left).toBe(left0);
  });
});
