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
function mousedown(el: Element, opts: Record<string, unknown> = {}) { el.dispatchEvent(new (el.ownerDocument!.defaultView as any).MouseEvent('mousedown', { bubbles: true, button: 0, ...opts })); }
function mousemove(doc: Document, opts: Record<string, unknown>) { doc.dispatchEvent(new (doc.defaultView as any).MouseEvent('mousemove', { bubbles: true, ...opts })); }
function mouseup(doc: Document) { doc.dispatchEvent(new (doc.defaultView as any).MouseEvent('mouseup', { bubbles: true })); }

describe('DocEditor floating objects', () => {
  let window: JSDOM['window'];
  let document: Document;

  beforeEach(() => {
    ({ window, document } = setup());
  });

  function openEditor(body = '<p>hello</p>') {
    let saved: string | null = null;
    (window as unknown as { DocEditor: any }).DocEditor.open({
      title: 'T', name: 'N', typeOptions: ['generic'], body,
      getVariables: () => [],
      onSave: async ({ body: b }: { body: string }) => { saved = b; return true; },
    });
    const fs_ = document.querySelector('.doc-fs')!;
    const surface = fs_.querySelector('.doc-surface')!;
    return { fs: fs_, surface, getSaved: () => saved };
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

  it('z-up/z-down nudge the z-index by ±1 from its current value, repeatably', () => {
    const { fs, surface } = openEditor();
    click(fs.querySelector('[data-ins="shape-rect"]')!);
    const el = surface.querySelector('.doc-float')! as HTMLElement;
    expect(el.style.zIndex).toBe('1'); // fresh insert defaults to "in front" (z=1)
    const up = () => click(el.querySelector('[data-float-act="z-up"]') as HTMLElement);
    const down = () => click(el.querySelector('[data-float-act="z-down"]') as HTMLElement);
    down(); down(); down();
    expect(el.style.zIndex).toBe('-2'); // 1 -> 0 -> -1 -> -2, not a fixed jump to -1
    up();
    expect(el.style.zIndex).toBe('-1');
    up(); up();
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

  it('drag (mousedown+mousemove+mouseup on the frame) updates left/top', () => {
    const { fs, surface } = openEditor();
    click(fs.querySelector('[data-ins="shape-rect"]')!);
    const el = surface.querySelector('.doc-float')! as HTMLElement;
    const startLeft = el.style.left, startTop = el.style.top;
    mousedown(el, { clientX: 100, clientY: 100 });
    mousemove(document, { clientX: 180, clientY: 140 });
    mouseup(document);
    expect(el.style.left).not.toBe(startLeft);
    expect(el.style.top).not.toBe(startTop);
  });

  it('resize (mousedown on a handle) updates width/height', () => {
    const { fs, surface } = openEditor();
    click(fs.querySelector('[data-ins="shape-rect"]')!);
    const el = surface.querySelector('.doc-float')! as HTMLElement;
    const startW = el.style.width, startH = el.style.height;
    const se = el.querySelector('[data-h="se"]') as HTMLElement;
    mousedown(se, { clientX: 200, clientY: 200 });
    mousemove(document, { clientX: 260, clientY: 250 });
    mouseup(document);
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
    mousedown(floatEl, { clientX: 50, clientY: 50 });
    mousemove(document, { clientX: 90, clientY: 70 });
    mouseup(document);
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

  it('does not offer promotion for inline formatting runs or table cells (avoids breaking prose/tables)', () => {
    const { surface } = openEditor('<p>a <b>bold word</b> b</p><table class="doc-table"><tbody><tr><td>cell</td></tr></tbody></table>');
    const b = surface.querySelector('b')!;
    click(b);
    expect(surface.querySelector('.doc-promote-bar')).toBeFalsy();
    const td = surface.querySelector('td')!;
    click(td);
    expect(surface.querySelector('.doc-promote-bar')).toBeFalsy();
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
    const { fs, surface, getSaved } = openEditor();
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
    expect(document.querySelector('.doc-fs')).toBeFalsy(); // successful save closes the editor

    // reopen a fresh editor with the saved body -> normalizeFloats() should restore contenteditable="false"
    const second = openEditor(saved!);
    const reloaded = second.surface.querySelector('.doc-float')! as HTMLElement;
    expect(reloaded).toBeTruthy();
    expect(reloaded.getAttribute('contenteditable')).toBe('false');
  });
});
