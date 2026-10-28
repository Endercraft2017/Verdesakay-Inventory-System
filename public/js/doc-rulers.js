/* Document workspace measurements. Rulers are editor chrome, never authored HTML. */
const DocRulers = (() => {
  const PX_PER_MM = 96 / 25.4, SIZE = 24;
  const units = { mm: 1, cm: 10, in: 25.4 };

  function ticks(lengthMm, pixelsPerMm, unit = 'mm', originMm = 0, visibleStart = 0, visibleEnd = lengthMm) {
    const factor = units[unit] || 1, scale = pixelsPerMm * factor;
    if (!(lengthMm > 0) || !(scale > 0) || !Number.isFinite(lengthMm + scale)) return [];
    let major;
    if (unit === 'in') major = [.125, .25, .5, 1, 2, 5, 10, 20, 50].find(n => n * scale >= 32) || 100;
    else {
      const power = 10 ** Math.floor(Math.log10(32 / scale));
      major = [1, 2, 5, 10].map(n => n * power).find(n => n * scale >= 32);
    }
    const divisions = major * scale / 5 >= 4 ? 5 : 1, step = major / divisions;
    const first = Math.ceil((Math.max(0, visibleStart) - originMm) / factor / step);
    const last = Math.floor((Math.min(lengthMm, visibleEnd) - originMm) / factor / step);
    const result = [];
    for (let i = first; i <= last && result.length < 2000; i++) {
      const value = i * step, mm = value * factor + originMm;
      result.push({ mm, value, major: i % divisions === 0, label: String(Number(value.toFixed(3))) });
    }
    return result;
  }

  function mount(canvas, surface, { readPage, openSettings, options = {} }) {
    const doc = surface.ownerDocument, win = doc.defaultView;
    if (!doc.getElementById('doc-ruler-styles')) {
      const style = doc.createElement('style'); style.id = 'doc-ruler-styles';
      style.textContent = `
        .doc-ruler-frame{flex:1;min-width:0;min-height:0;display:grid;grid-template-columns:24px minmax(0,1fr);grid-template-rows:24px minmax(0,1fr);overflow:hidden}
        .doc-ruler-frame>.doc-canvas{grid-area:2/2;min-width:0;min-height:0}
        .doc-ruler-frame[data-rulers=false]{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr)}
        .doc-ruler-frame[data-rulers=false]>.doc-canvas{grid-area:1/1}
        .doc-ruler-frame>.doc-ruler-axis[hidden],.doc-ruler-frame>.doc-ruler-corner[hidden]{display:none!important}
        .doc-ruler-axis{overflow:hidden;background:var(--surface-2);color:var(--text-muted);pointer-events:none;user-select:none}
        .doc-ruler-axis svg{display:block;overflow:hidden;font:9px var(--font,system-ui)}
        .doc-ruler-x{grid-area:1/2;border-bottom:1px solid var(--border)}
        .doc-ruler-y{grid-area:2/1;border-right:1px solid var(--border)}
        .doc-ruler-paper{fill:var(--surface)}.doc-ruler-margin{fill:var(--surface-2)}
        .doc-ruler-tick{stroke:var(--text-muted);stroke-width:1}.doc-ruler-number{fill:var(--text-muted)}
        .doc-ruler-marker{stroke:var(--accent);stroke-width:2;pointer-events:none}
        .doc-ruler-corner{grid-area:1/1;border:0;border-right:1px solid var(--border);border-bottom:1px solid var(--border);padding:0;background:var(--surface-2);color:var(--text);font:10px var(--font,system-ui);cursor:pointer;min-width:0}
        .doc-ruler-corner:hover{background:var(--accent-weak)}.doc-ruler-corner:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
        @media print{.doc-ruler-axis,.doc-ruler-corner{display:none!important}}
      `; doc.head.append(style);
    }
    const frame = doc.createElement('div'); frame.className = 'doc-ruler-frame';
    const corner = doc.createElement('button'); corner.type = 'button'; corner.className = 'doc-ruler-corner';
    corner.title = 'Ruler settings'; corner.setAttribute('aria-label', 'Ruler settings');
    const axis = direction => {
      const el = doc.createElement('div'); el.className = 'doc-ruler-axis doc-ruler-' + direction;
      el.setAttribute('role', 'img'); el.innerHTML = '<svg aria-hidden="true"></svg>';
      return el;
    };
    const horizontal = axis('x'), vertical = axis('y');
    const axisKeys = new WeakMap();
    canvas.before(frame); frame.append(corner, horizontal, vertical, canvas);
    let settings, mode = 'visual', raf = 0, closed = false, source = 'caret', pointer = null;
    let activePage = null;
    const clean = value => ({ show: value.show !== false, cursor: value.cursor !== false,
      unit: Object.hasOwn(units, value.unit) ? value.unit : 'mm', origin: value.origin === 'content' ? 'content' : 'page' });
    const queue = () => { if (!closed && !raf) raf = win.requestAnimationFrame(draw); };
    function geometry() {
      const spec = { ...readPage() }, rect = surface.getBoundingClientRect();
      spec.marginMm = Math.max(0, Number(spec.marginMm) || 0);
      const scale = rect.width / spec.widthMm;
      if (!(scale > 0) || !(spec.heightMm > 0)) return null;
      const pageHeight = spec.heightMm * scale, viewport = canvas.getBoundingClientRect();
      const pages = [...surface.querySelectorAll('[data-doc-design-page]')];
      const node = source === 'pointer' && pointer ? doc.elementFromPoint?.(pointer.x, pointer.y) : win.getSelection()?.focusNode;
      const element = node?.nodeType === 3 ? node.parentElement : node;
      const selectedPage = element?.closest?.('[data-doc-design-page]');
      const y = source === 'pointer' && pointer ? pointer.y : caretRect()?.top;
      const positionVisible = y != null && y >= viewport.top && y <= viewport.bottom;
      if (activePage && !surface.contains(activePage)) activePage = null;
      if (pages.length) {
        if (selectedPage && surface.contains(selectedPage) && positionVisible) activePage = selectedPage;
        else if (positionVisible) activePage = pages.reduce((nearest, page) => {
          const distance = candidate => {const box=candidate.getBoundingClientRect();return Math.max(box.top-y,0,y-box.bottom);};
          return distance(page) < distance(nearest) ? page : nearest;
        }, pages[0]);
        else activePage = pages.reduce((visible, page) => {
          const overlap = candidate => {const box=candidate.getBoundingClientRect();return Math.max(0,Math.min(box.bottom,viewport.bottom)-Math.max(box.top,viewport.top));};
          return overlap(page) > overlap(visible) ? page : visible;
        }, pages.at(-1));
      }
      const index = pages.length ? 0 : Math.max(0, Math.min(Math.ceil(rect.height / pageHeight) - 1,
        Math.floor(((positionVisible ? y : (Math.max(rect.top,viewport.top)+Math.min(rect.bottom,viewport.bottom))/2) - rect.top) / pageHeight)));
      return { ...spec, scale, left: rect.left, top: activePage && pages.length ? activePage.getBoundingClientRect().top - spec.marginMm * scale : rect.top + index * pageHeight };
    }
    function caretRect() {
      const sel = win.getSelection();
      if (!sel?.rangeCount || !surface.contains(sel.focusNode)) return null;
      try {
        const range = doc.createRange(); range.setStart(sel.focusNode, sel.focusOffset); range.collapse(true);
        const box = [...range.getClientRects()].find(rect => rect.height > 0);
        if (box) return box;
        // Owned inline runs can leave a perfectly valid caret between child nodes.
        // Chromium gives those collapsed element ranges no rectangle. Probe the
        // adjacent text boundary instead, without inserting measurement DOM.
        if (sel.focusNode.nodeType === 1) {
          const children = [...sel.focusNode.childNodes];
          const previous = children.slice(0, sel.focusOffset).reverse();
          const following = children.slice(sel.focusOffset);
          function edge(nodes, end) {
            for (const node of nodes) {
              if (node.nodeType === 8 || (node.nodeType === 3 && !node.length)) continue;
              if (node.nodeType === 3) {
                range.setStart(node, end ? node.length : 0); range.collapse(true);
                const rect = [...range.getClientRects()].find(rect => rect.height > 0);
                if (rect) return rect;
              } else if (node.nodeType === 1 && !node.matches('.doc-promote-bar,.doc-page-guide,.doc-float-toolbar,.doc-float-handle')) {
                if (node.matches('.doc-chip,.doc-checkbox,img')) {
                  const rect = node.getBoundingClientRect();
                  if (rect.height) return {left:end ? rect.right : rect.left, top:rect.top, height:rect.height};
                } else {
                  const rect = edge(end ? [...node.childNodes].reverse() : [...node.childNodes], end);
                  if (rect) return rect;
                }
              }
            }
            return null;
          }
          const adjacent = edge(previous, true) || edge(following, false);
          if (adjacent) return adjacent;
          const block = sel.focusNode.closest('p,h1,h2,h3,h4,h5,h6,li,td,th,.doc-float-body') || surface;
          if (!block.textContent.trim() && !block.querySelector('img,svg,table,.doc-chip')) {
            const rect = block.getBoundingClientRect(), css = win.getComputedStyle(block);
            const scale = surface.getBoundingClientRect().width / (surface.offsetWidth || 1);
            const font = parseFloat(css.fontSize) || 13;
            return {left:rect.left + (parseFloat(css.paddingLeft) || 0) * scale,
              top:rect.top + (parseFloat(css.paddingTop) || 0) * scale,
              height:(parseFloat(css.lineHeight) || font * 1.2) * scale};
          }
        }
      } catch { /* A replaced selection is redrawn on the next selection/input event. */ }
      return null;
    }
    function drawAxis(el, direction, g, viewport, marker) {
      const x = direction === 'x', length = x ? g.widthMm : g.heightMm;
      const extent = x ? canvas.clientWidth : canvas.clientHeight;
      const offset = (x ? g.left - viewport.left : g.top - viewport.top);
      const origin = settings.origin === 'content' ? g.marginMm : 0;
      const svg = el.firstElementChild;
      el.dataset.rulerOffset = String(offset); el.dataset.rulerScale = String(g.scale); el.dataset.rulerOrigin = String(origin);
      const key = [extent,length,offset,g.scale,origin,g.marginMm,settings.unit].join(':');
      if (axisKeys.get(el) !== key) {
        axisKeys.set(el,key);
        svg.setAttribute('width', x ? extent : SIZE); svg.setAttribute('height', x ? SIZE : extent);
        el.setAttribute('aria-label', (x ? 'Horizontal' : 'Vertical') + ' ruler in ' + ({mm:'millimeters',cm:'centimeters',in:'inches'}[settings.unit]));
        const band = (start, size, cls) => x ? `<rect class="${cls}" x="${start}" y="0" width="${Math.max(0,size)}" height="24"/>` : `<rect class="${cls}" x="0" y="${start}" width="24" height="${Math.max(0,size)}"/>`;
        let html = band(offset, length * g.scale, 'doc-ruler-paper');
        const margin = Math.min(g.marginMm, length / 2) * g.scale;
        html += band(offset, margin, 'doc-ruler-margin') + band(offset + length * g.scale - margin, margin, 'doc-ruler-margin');
        for (const tick of ticks(length, g.scale, settings.unit, origin, (-offset - 20) / g.scale, (extent - offset + 20) / g.scale)) {
          const position = offset + tick.mm * g.scale;
          if (position < -20 || position > extent + 20) continue;
          const near = tick.major ? 15 : 20;
          html += x ? `<line class="doc-ruler-tick" x1="${position}" x2="${position}" y1="${near}" y2="24"/>` : `<line class="doc-ruler-tick" y1="${position}" y2="${position}" x1="${near}" x2="24"/>`;
          if (tick.major) html += x ? `<text class="doc-ruler-number" text-anchor="middle" x="${position}" y="10">${tick.label}</text>` : `<text class="doc-ruler-number" text-anchor="middle" transform="translate(9 ${position}) rotate(-90)">${tick.label}</text>`;
        }
        svg.innerHTML = html + '<line class="doc-ruler-marker" visibility="hidden"/>';
      }
      const indicator = svg.querySelector('.doc-ruler-marker');
      if (marker != null && marker >= 0 && marker <= length) {
        const position = offset + marker * g.scale;
        el.dataset.rulerPosition = String(marker - origin);
        for (const [name,value] of Object.entries(x ? {x1:position,x2:position,y1:0,y2:24} : {y1:position,y2:position,x1:0,x2:24})) indicator.setAttribute(name,String(value));
        indicator.setAttribute('visibility','visible');
      } else {delete el.dataset.rulerPosition;indicator.setAttribute('visibility','hidden');}
    }
    function draw() {
      raf = 0;
      if (closed || !settings.show || mode !== 'visual') return;
      frame.dataset.rulerSource = source;
      const g = geometry(); if (!g) return;
      const viewport = canvas.getBoundingClientRect();
      let point = null;
      if (settings.cursor) {
        if (source === 'pointer') point = pointer;
        else if (!doc.activeElement || surface.contains(doc.activeElement) || doc.activeElement === surface) {
          const box = caretRect(); if (box) point = { x: box.left, y: box.top + box.height / 2 };
        }
      }
      const within = point && point.x >= g.left && point.x <= g.left + g.widthMm * g.scale && point.y >= g.top && point.y <= g.top + g.heightMm * g.scale;
      const mx = within ? (point.x - g.left) / g.scale : null, my = within ? (point.y - g.top) / g.scale : null;
      drawAxis(horizontal, 'x', g, viewport, mx); drawAxis(vertical, 'y', g, viewport, my);
    }
    function setOptions(value) {
      settings = clean(value); frame.dataset.rulers = String(settings.show);
      corner.hidden = horizontal.hidden = vertical.hidden = !settings.show; corner.textContent = settings.unit;
      queue();
    }
    function onPointer(e) { source = 'pointer'; pointer = {x:e.clientX,y:e.clientY}; queue(); }
    function onLeave() { source = 'caret'; pointer = null; queue(); }
    function onCaret() { source = 'caret'; queue(); }
    function onFocus() { queue(); }
    corner.addEventListener('mousedown', e => e.preventDefault()); corner.addEventListener('click', openSettings);
    surface.addEventListener('pointermove', onPointer); surface.addEventListener('pointerleave', onLeave);
    surface.addEventListener('input', onCaret); surface.addEventListener('keyup', onCaret);
    doc.addEventListener('selectionchange', onCaret); doc.addEventListener('focusin', onFocus);
    canvas.addEventListener('scroll', queue, {passive:true}); win.addEventListener('resize', queue);
    const ro = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(queue) : null;
    ro?.observe(canvas); ro?.observe(surface);
    const mo = new win.MutationObserver(queue);
    mo.observe(surface, {subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['style','data-doc-design-page']});
    setOptions(options);
    return { frame, update: queue, setOptions,
      setMode(value) { mode = value; frame.style.display = mode === 'visual' ? '' : 'none'; queue(); },
      destroy() {
        closed = true; if (raf) win.cancelAnimationFrame(raf); ro?.disconnect(); mo.disconnect();
        surface.removeEventListener('pointermove', onPointer); surface.removeEventListener('pointerleave', onLeave);
        surface.removeEventListener('input', onCaret); surface.removeEventListener('keyup', onCaret);
        doc.removeEventListener('selectionchange', onCaret); doc.removeEventListener('focusin', onFocus);
        canvas.removeEventListener('scroll', queue); win.removeEventListener('resize', queue);
        frame.before(canvas); frame.remove();
      }
    };
  }
  return { mount, ticks, PX_PER_MM };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = DocRulers;
else window.DocRulers = DocRulers;
