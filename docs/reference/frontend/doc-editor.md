# `public/js/doc-editor.js`

## Purpose
`DocEditor` is a full-screen, Word-style WYSIWYG editor for document templates. The
editing surface *is* the document page — no separate "design vs. preview" split for basic
formatting. It supports a Visual mode (`contenteditable` canvas + ribbon toolbar) and a raw
HTML/CSS mode, table tools, a formula builder, variable autocomplete/picker, and exact
page-size/margin setup. It produces and consumes the HTML + `{{var}}` (+ inline
`{{= formula}}`) body format that `doc-template.js`'s `renderTemplate()` understands. At
~1050 lines this is the largest and most internally complex file in the frontend — this
doc is organized by internal concern rather than strictly top-to-bottom, since a developer
extending the ribbon needs to navigate by *feature*, not by line number.

## Exports / Public API

```js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { bodyToEditorHtml, serializeEditor, sanitizeHtml, parsePageStyle,
                      pageStyleTag, pageDims, replaceAllInSurface };
} else {
  window.DocEditor = { open, bodyToEditorHtml, serializeEditor, sanitizeHtml };
}
```
Note the export lists **differ**: the browser global additionally exposes `open`, while the
CommonJS (test) export additionally includes `parsePageStyle`, `pageStyleTag`, `pageDims`,
and `replaceAllInSurface` — pure helpers that tests exercise directly but that browser
callers only ever use indirectly through `DocEditor.open()`.

### `DocEditor.open(opts)` — the editor's only browser entry point
`opts`:
- `title` — shown as static text in the top bar (e.g. `"Edit Template"`).
- `name`, `type`, `typeOptions` (default `['sale','job','generic']`) — initial name-input
  value, initial type-select value, and the type select's options.
- `period`, `periodLabel` — optional; if `periodLabel` is given, an extra period `<input>`
  appears in the top bar (used for HR Payroll templates' accounting-period stamp).
- `body` — the initial saved body (raw HTML + `{{var}}` tokens + an optional leading
  `<style data-docpage>` page-setup tag).
- `getVariables()` → `[{ category, label, token|key }]` — variable catalog for the
  Insert-Variable picker, the formula builder's field list, and `{{` autocomplete.
- `sampleContext` — a context object used to live-evaluate formulas in the formula
  builder's preview and to drive `renderPreview`.
- `renderPreview(body)` → HTML string — used by the movable preview panel; if omitted, the
  preview shows `<p>No preview</p>`.
- `onManageVars({ refresh })` — if provided, shows a `⚙` button in the top bar; clicking it
  hands control to the caller (e.g. opens a "manage variables" modal), and the editor
  expects the caller to call `refresh()` when done so the live preview updates.
- `onSave({ name, type, period, body })` → `true` (or `undefined`) to close on success, a
  `string` to show as an inline error toast and keep the editor open, or a rejected Promise
  (caught, shown via `UI.toast(err.message, 'error')`, editor stays open).
- Returns `{ close }`.

### Pure helpers (exported both ways)
- **`bodyToEditorHtml(body)`** → editor-canvas HTML: converts stored `{{var}}` tokens into
  non-editable "chip" `<span class="doc-chip">` elements, and `{{#items}}<tr>...</tr>
  {{/items}}` into a `<tr data-repeat="items">` (dropping the literal token text, since the
  repeat marker becomes a data attribute + CSS treatment instead). See **Body↔canvas
  conversion** below for the full algorithm including the `<img src="{{var}}">` special case.
- **`serializeEditor(root)`** → the inverse: walks a clone of the canvas DOM, turns chips
  back into `{{token}}` text, `data-var-src` images back into `<img src="{{token}}">`,
  `data-repeat="items"` rows back into text-node `{{#items}}`/`{{/items}}` markers
  surrounding the `<tr>`, strips `.cell-sel` selection-highlight classes and all
  `contenteditable` attributes, and returns `.innerHTML.trim()`.
- **`sanitizeHtml(html, doc)`** → allowlist-sanitizes pasted HTML (Word/web paste
  cruft-stripping) — see **Paste sanitizer** below.
- **`parsePageStyle(body)`** → `{ widthMm, heightMm, marginMm, preset, rest }` — extracts
  and removes any leading `<style data-docpage>@page{...}</style>` tag from `body`,
  returning the parsed page dimensions/margin plus `rest` (the body with that tag
  stripped). See **Page setup** below.
- **`pageStyleTag(widthMm, heightMm, marginMm)`** → the `<style data-docpage>@page{size:
  ${w}mm ${h}mm;margin:${m}mm}</style>` string to prepend on save.
- **`pageDims(widthMm, heightMm)`** → `[widthPx, heightPx]` at 96dpi, for sizing the
  on-screen canvas to match the real printed page.
- **`replaceAllInSurface(root, find, repl)`** → `number` (replacement count). Walks all text
  nodes under `root` via a `TreeWalker`, **skipping any text node inside a `.doc-chip`**
  (so Find & Replace can never corrupt a variable token), doing a literal (non-regex)
  substring replace.

## Internal structure

### 1. Body ↔ canvas conversion
- **`tokenChip(token)`** — builds one `<span class="doc-chip ...">` for a `{{token}}`.
  Control tokens (`#items`, `/items`, …) get `doc-chip-ctrl`; formula tokens (`=expr`) get
  `doc-chip-fx` and have their `=` sigil stripped from the *displayed* text (the sigil is
  re-added visually via `::before` CSS content `'ƒx'` — see **Styling**). The chip is
  `contenteditable="false"` so it behaves as one atomic unit for cursor movement/deletion.
- **`EDITOR_IMG_PLACEHOLDER`** — a small inline SVG data-URI (silhouette icon) shown in the
  canvas wherever a template's `<img src="{{var}}">` exists, since the real image only
  exists at print/render time.
- **`bodyToEditorHtml(body)`** (see Exports above) does its work as **three sequential
  regex passes**, each important and order-dependent:
  1. `{{#items}}<tr` → `<tr data-repeat="items"` and `</tr>{{/items}}` → `</tr>` — collapses
     the repeat-block markers into a data attribute on the row itself.
  2. `<img ... src="{{var}}" ...>` → `<img ... src="<placeholder>" data-var-src="var" ...>`
     — **this must run before pass 3**, because a `{{var}}` sitting inside a quoted HTML
     attribute value cannot be chip-ified (a chip is a `<span>`, and a `<span>` cannot
     legally appear inside another tag's attribute string) — trying to chip it in place
     would corrupt the `<img>` tag's HTML.
  3. Every remaining `{{...}}` becomes a chip **only when it's in text content, never
     inside a tag**: the regex `(<[^>]*>)|\{\{\s*([^}]+?)\s*\}\}` alternates between
     matching a whole tag (passed through untouched, atomically) and matching a `{{...}}`
     token (converted via `tokenChip`) — the alternation is what protects any remaining
     attribute-embedded tokens (there shouldn't be any left after pass 2, but this ordering
     is defensive) from being corrupted.
- **`serializeEditor(root)`** reverses all three, operating on a `cloneNode(true)` (never
  mutates the live canvas): images with `data-var-src` first (before the generic chip pass,
  since the placeholder image itself is not a chip), then `.doc-chip` → text node, then
  `[data-repeat="items"]` rows get sibling text nodes inserted before/after them for the
  open/close markers, then strips selection state and all `contenteditable` attributes
  before reading `.innerHTML`.

### 2. Paste sanitizer
An **allowlist**-based HTML sanitizer used on paste (`surface`'s `paste` event handler,
when `clipboardData` has `text/html`), so pasting from Word/a web page doesn't inject
`<script>`, inline event handlers, arbitrary classes/styles, or disallowed tags.
- `SANITIZE_TAGS` — the allowed tag set (`P, BR, B, STRONG, I, EM, U, S, STRIKE, SUP, SUB,
  H1-H4, UL, OL, LI, TABLE, THEAD, TBODY, TR, TD, TH, SPAN, DIV, A, IMG, HR, FONT,
  BLOCKQUOTE`).
- `SANITIZE_ATTR` — per-tag attribute allowlist (`A: href`, `IMG: src, alt`, `TD/TH:
  colspan, rowspan`).
- `SANITIZE_STYLE` — allowed inline CSS property names (`color, background-color,
  background, text-align, font-size, font-family, font-weight, font-style,
  text-decoration, width, page-break-after, break-after`).
- `SANITIZE_DATA` — allowed `data-*` attributes (`data-token, data-repeat, data-checked,
  data-var-src`) — this is what lets pasted content preserve the editor's own chip/repeat
  markup if a user copy-pastes *within* the editor.
- **`sanitizeNode(node, doc)`** — recursive: text nodes pass through as text nodes;
  non-allowlisted elements are **unwrapped, not deleted** (`kids` — their sanitized
  children — are returned in place of the element itself), *except* elements the editor
  itself generated (detected via a `special` regex test on `class` for `doc-chip`,
  `doc-checkbox`, or `doc-pagebreak`), which are always kept regardless of tag name.
  `SCRIPT`/`STYLE` tags are dropped entirely (children discarded too). Allowed elements are
  rebuilt attribute-by-attribute: `on*` handlers are always stripped; `style` is filtered
  through `filterStyle` (declaration-list filtering by property name); `class` is filtered
  through a fixed regex matching only editor-internal class names; `href`/`src` get
  scheme checks (`javascript:` hrefs stripped; `src` must match `data:image/`, `https?:`,
  or a root-relative `/` path).
- **`filterStyle(s)`** — splits a `style` string on `;`, keeps only declarations whose
  property is in `SANITIZE_STYLE`.
- **`sanitizeHtml(html, doc)`** — entry point: builds a detached `<div>`, sets `innerHTML`
  to the untrusted string, sanitizes every child node, and returns the resulting safe
  `innerHTML`.

### 3. Page setup (exact-size, not just A4/Letter)
- `PX_PER_MM = 96/25.4`; `PAGE_PRESETS_MM = { a4: [210,297], letter: [215.9,279.4] }`.
- **`matchPagePreset(widthMm, heightMm)`** — fuzzy-matches (±0.5mm tolerance) a dimension
  pair against the presets **in either orientation** (so a landscape A4 still reports
  `'a4'`), else returns `'custom'`.
- **`parsePageStyle(body)`** understands **two on-disk formats** for backward
  compatibility: the current `size: <W>mm <H>mm` form, and a legacy `size: a4|letter
  portrait|landscape` form saved by older editor versions — if the mm-pair regex doesn't
  match, it falls back to parsing the legacy keyword form and derives width/height from
  `PAGE_PRESETS_MM` + orientation. Margin is parsed separately (`margin: <N>mm`), defaulting
  to `14`mm if absent. This function is what makes old templates keep opening correctly
  after the page-setup feature was upgraded to exact mm sizing.
- The saved `<style data-docpage>` tag stores the **real** `widthMm`/`heightMm`/`marginMm`
  (plus a derived `preset` used only to pre-select the Layout tab's Size dropdown) — so a
  CR-80 ID-card-sized template (a genuinely custom, non-A4/Letter size) is fully
  representable, not forced into a preset.
- `pageDims(widthMm, heightMm)` converts to on-screen px (rounded) for sizing `.doc-page`'s
  `width`/`min-height` so the canvas visually matches the real printed page proportions.

### 4. Ribbon construction — tabs, groups, panels
The ribbon is a **tab strip** (`tabsHTML()`: `Home`, `Insert`, `Layout`, plus a hidden-by-
default `Table` tab) — only the active tab's `.doc-panel` is visible at a time, keeping the
toolbar a fixed ~2-row height regardless of window width (no wrapping/scrolling grid of
every possible button, unlike a flat toolbar).
- **`groupHTML(caption, innerHtml)`** — the atomic ribbon building block: a row of controls
  (`.doc-group-row`) with a small caption underneath (`.doc-group-cap`), mirroring Word's
  own ribbon group structure (e.g. "Font", "Paragraph", "Page Setup").
- **`tile(kind, value, icon, label, extraClass)`** — builds one `.doc-tile` button
  (icon-over-label, larger touch target) — `data-${kind}="${value}"` (e.g.
  `data-ins="image"`). Insert/Layout use these bigger tiles since they hold fewer,
  higher-level commands; Home/Table stay compact icon-only buttons (denser, for frequent
  commands) — matching the same information-density split Word itself uses between its
  Home tab and Insert tab.
- **`homePanelHTML()`** — 4 groups: **Undo** (undo/redo), **Font** (paragraph-style select,
  font-name select, numeric pt font-size select, bold/italic/underline/strike/superscript/
  subscript, text-color + highlight `<input type="color">` swatches, clear-formatting),
  **Paragraph** (align ×4, bullet/numbered list, outdent/indent), **Editing** (a single
  Find tile — `data-find` — intentionally the *only* thing in this group, since Find was
  moved off the always-visible top bar into the ribbon to save top-bar width; this is the
  one and only `[data-find]` element in the whole DOM, so it's queried by attribute not
  position).
- **`insertPanelHTML()`** — 6 groups: **Illustrations** (Picture), **Tables** (Table),
  **Links** (Link), **Text** (Checkbox, Line/`<hr>`, Page Break, Text Box, Signature Line),
  **Symbols** (Symbol picker), **Template** (Variable — `.btn-variable` styled, Formula —
  `.btn-fx` styled).
- **`layoutPanelHTML()`** — 2 groups: **Page Setup** (Size select `a4|letter|custom`,
  Orientation select shown only for presets, Width/Height mm number inputs shown only for
  Custom, and an always-present Margin mm input that — unlike the others — also drives the
  live on-screen canvas padding, not just the saved `@page{margin}`), **Preview** (a single
  Preview tile, `data-preview` — same "moved off the top bar, queried by attribute" pattern
  as Find).
- **`tablePanelHTML()`** — only shown while the caret is inside a table (see **Table-tab
  visibility** below): **Rows & Columns** (+Row/−Row/+Col/−Col), **Merge** (Merge →, Merge
  ↓, Split), **Design** (cell-shading color swatch, column-width dialog, table-style select
  `Bordered|Striped|Shaded header|Plain`), **Template** (↻ "Item row" — toggles
  `data-repeat="items"` on the current row, `= ƒx` formula-cell shortcut, delete table).

### 5. Shared modal dialogs
Each takes an `insertHtml`/`saveSel` (and sometimes `getVariables`/`initial`/
`sampleContext`) closure from `wireToolbar`, so they can restore the caret's saved
selection before inserting:
- **`insertTableDialog`** — rows/cols/header-row inputs → builds a `<table class="doc-
  table"><tbody>...</tbody></table>` HTML string with `&nbsp;`-filled cells.
- **`imageDialog`** — URL input **or** file upload (read via `FileReader.readAsDataURL`,
  so uploaded images are embedded as base64 data URIs directly in the saved body — no
  server-side image storage).
- **`symbolDialog`** — a fixed `SYMBOLS` grid (currency/legal/math glyphs incl. `₱`) —
  clicking one inserts it plus a trailing `&nbsp;`.
- **`variableDialog(saveSel, getVariables, insertFn, opts)`** — search box + category tabs
  (from `getVariables()`'s distinct `category`s) + a scrollable pick list; `insertFn`
  receives the chosen `token` string. `opts.keepOpen` (unused by current call sites, but
  supported) would keep the dialog open after a pick for inserting multiple variables in
  a row.
- **`formulaDialog(insertHtml, saveSel, getVariables, initial, sampleContext)`** — the most
  elaborate dialog, four numbered sections in a `size: 'lg'` modal:
  1. **Your formula** — a text input plus a live "Result on sample data" readout
     (`fx-ok`/`fx-bad` styling) recomputed on every keystroke via `evalFormula(expr,
     sampleContext)` (swallowing errors into a "⚠ not a valid formula yet" state).
  2. **Sum a whole column** — auto-derives candidate columns from `getVariables()` entries
     whose `category` matches `/item|line/i`, rendering one `Σ <label>` button per column
     (inserts `sum(items.<ref>)`) plus a `# Count items` button (inserts `count(items)`).
     If no item-row variables exist yet, shows a hint to add an "Item row" first.
  3. **Functions & operators** — buttons for `sum(, avg(, count(, min(, max(, round(` (each
     with a tooltip) and `+ - * / ( )`.
  4. **Insert a value or per-row field** — the same search+category-tabs variable picker as
     `variableDialog`, but inserting the bare `ref` (via `refOf`, stripping `{{`/`}}`)
     instead of a chip, since formula text is plain text inside the input, not canvas HTML.
  On confirm, wraps the typed expression as `tokenChip('= ' + expr)` and inserts it (so a
  formula always becomes a `doc-chip-fx` chip in the canvas, never raw editable text).

### 6. `wireToolbar(panelsRoot, surface, getVariables, onChange, sampleContext, tabApi)`
The largest function in the file — wires every interactive behavior of the canvas and
ribbon once, at editor-open time. Key sub-concerns:
- **Selection save/restore** (`saveSel`/`restoreSel`/`exec`/`insertHtml`) — because opening
  a modal dialog (table insert, variable picker, etc.) steals focus from the
  `contenteditable` surface and collapses the browser's live selection, every toolbar
  action that needs "where was the caret" must **save a cloned `Range`** before losing
  focus and **restore it** before calling `document.execCommand`. `document.execCommand`
  (yes, the deprecated API — still the pragmatic choice for a no-framework, no-build,
  contenteditable rich-text editor) drives all basic formatting.
- **Ribbon button wiring** — `[data-ex]` buttons map 1:1 to `execCommand` names (bold,
  italic, justifyLeft, insertUnorderedList, …); `select[data-cmd]` selects map to
  `execCommand(cmd, false, value)` on change (paragraph style, font name); `[data-color]`
  color inputs map to `execCommand('foreColor'|'hiliteColor', ...)`; the numeric font-size
  select uses the classic `execCommand('fontSize', false, '7')` + strip-`size`-attr +
  apply-`style.fontSize` hack, since `execCommand('fontSize')` only accepts the legacy 1–7
  scale, not arbitrary pt values.
- **Insert-button wiring** — each `[data-ins="..."]` tile wires to its dialog or a direct
  `insertHtml(...)` call (Line, Page Break, Checkbox, Text Box, Signature Line are inserted
  directly with no dialog).
- **Table helpers (`tbl` object)** — `addRow, delRow, addCol, delCol, mergeRight,
  mergeDown, split, width, repeat, fxcell, delTable`, all operating relative to
  `currentCell()` (resolved from the saved range's `startContainer`, walking up to the
  nearest `TD`/`TH`). `repeat()` toggles the `data-repeat="items"` attribute + `.is-repeat`
  class on the current row (visually indicated by a blue inset box-shadow in the canvas —
  see Styling) and toasts which state it's now in.
- **Excel-style rectangular cell selection + column resize** — a `mousedown`/`mousemove`/
  `mouseup` trio on `surface` implements drag-to-select-a-rectangle-of-cells
  (`markRect(a,b)` computes the row/col bounding box between anchor and current cell and
  adds `.cell-sel` to every cell inside it) and drag-to-resize a column (detected by
  `mousedown` within 6px of a cell's right edge, switching the cursor to `col-resize` on
  hover via `mousemove` even before a drag starts). `mergeSelection()`/`splitCells()`
  operate on the full `.cell-sel` rectangle (concatenating non-empty cell contents into the
  top-left cell on merge) rather than just the single current cell the ribbon's Merge
  buttons use.
- **Right-click context menu on a cell** — via `UI.contextMenu`: a reduced menu (Merge N
  cells / Split / Background / Text color / Align center / Bold) when multiple cells are
  selected, or a fuller per-cell menu (background, text color, align L/C/R, bold, insert
  row/col, merge-or-split depending on current span state, delete row/col) for a single
  cell — collapsing the current selection to just that cell first.
- **`{{` autocomplete** (VS-Code-style) — an `input` listener (`updateAC`) matches the text
  immediately before the caret against `/\{\{([\w. ]*)$/` (an open, unclosed `{{` followed
  by partial identifier characters); if matched, filters `getVariables()` by substring and
  renders up to 8 results in a fixed-position `.doc-ac` popup positioned under the caret's
  bounding rect (`Range.getBoundingClientRect()`, with fallbacks if that's unavailable).
  `ArrowUp`/`ArrowDown` navigate, `Enter`/`Tab` accept (`acceptAC`, which deletes the raw
  `{{partial` text via a fresh `Range` and inserts a real chip + trailing space), `Escape`
  or blur (150ms delay, to allow a mousedown-triggered accept to land first) closes it.
- **Excel-style `=` trigger** — a `keydown` listener: pressing `=` while the caret is in an
  **empty** table cell (`currentCell().textContent.trim() === ''`) prevents the default
  character insertion and opens `formulaDialog` directly — a shortcut for building a
  formula cell without going through the ribbon.
- **Drag-drop + paste images** — dropped/pasted image files are embedded as base64 data
  URIs via `FileReader` (`embed()`); pasted HTML goes through `sanitizeHtml()` before
  insertion; plain-text paste is not intercepted (falls through to the browser's default
  paste behavior).
- **Toolbar state reflection** — a `document`-level `selectionchange` listener
  (`reflect()`) toggles `.active` on the Bold/Italic/Underline/Strikethrough buttons based
  on `document.queryCommandState(cmd)`, so the ribbon shows which formats are active at the
  caret — Word-like live state, not just click-to-apply.
- Returns `{ teardown() }` — removes the `selectionchange` listener (called from `open()`'s
  `close()`).

### 7. `open(opts)` — top-level orchestration
- `ensureStyles()` — injects a single `<style id="doc-editor-styles">` into `<head>` once
  per page load (idempotent guard via `document.getElementById` check) containing every
  class this file uses: `.doc-fs` (fixed, full-viewport overlay), `.doc-fs-bar` (top bar,
  split into `.doc-fs-bar-scroll` + `.doc-fs-bar-actions` — see Notes), `.doc-tabs`/
  `.doc-panel`/`.doc-group`/`.doc-tile` (ribbon), `.doc-canvas`/`.doc-page` (the actual
  editing surface, styled to look like a physical page — white background, box-shadow,
  Segoe UI), `.doc-chip`/`.doc-chip-ctrl`/`.doc-chip-fx` (variable chip styling incl. the
  `::before` type-marker glyphs `{ }`/`‹›`/`ƒx`), `.doc-find` (find/replace bar), `.doc-ac`
  (autocomplete popup), `.doc-preview-float` (the movable preview panel). All colors are
  CSS custom properties with light-mode fallbacks (`var(--accent, #2b7fff)`) so the editor
  respects the app's dark/light theme even though it's injected as a plain `<style>` tag
  rather than living in `styles.css`.
- **DOM construction** — builds one `.doc-fs` div containing: the top bar (title, name
  input, type select, optional period input, Visual/HTML-CSS mode toggle, variables-manage
  gear button — all in the scrolling region — plus pinned Save/Close buttons); the tab
  strip; four `.doc-panel`s (home visible, insert/layout/table hidden via inline
  `style="display:none"`); the canvas (`.doc-page.doc-surface[contenteditable]`); and a
  hidden `<textarea class="doc-code">` for HTML/CSS mode.
- **Tab switching** (`switchTab(name)`) — toggles `.active` on the tab buttons and
  `display: '' | 'none'` on each panel. `tabApi.setTableTabVisible(visible)` is the hook
  `wireToolbar`'s `updateTableBar()` calls on every selection change to show/hide the Table
  tab button itself and auto-return to Home if the Table tab was active when the caret left
  a table.
- **Preview panel** (`togglePreview`/`refreshPreview`) — a floating, draggable (`mousedown`
  on `.doc-preview-head` + document-level `mousemove`/`mouseup`), resizable (native CSS
  `resize: both`) panel containing an `<iframe>` whose `srcdoc` is set from
  `opts.renderPreview(currentBody())`. `currentBody()` reads from `code.value` in HTML mode
  or `serializeEditor(surface)` in visual mode — so the preview always reflects the
  currently-active editing mode's content, not necessarily what's currently visible.
  `onChange()` (called on every canvas/page-setup edit) marks `dirty = true` and calls
  `refreshPreview()` unconditionally (even when the preview panel is closed —
  `refreshPreview` no-ops if `previewEl` is null, so this is cheap).
- **Page setup wiring** — reads the initial state via `parsePageStyle(opts.body)`,
  populates the Size/Orientation/Width/Height/Margin controls, and wires `change` on all of
  them to `syncSizeUI()` (show/hide the Orientation vs. Width/Height controls depending on
  whether Size is `custom`) + `applyCanvas()` (resize `.doc-page`'s CSS `width`/
  `min-height` via `pageDims()` and set its `padding` from the margin value — **the only
  page-setup control that visually affects the on-screen canvas in real time**; Size/
  Orientation don't move visible content, only the saved `@page` rule and the canvas's
  physical dimensions).
- **Initial load**: `surface.innerHTML = bodyToEditorHtml(pg.rest)` — deliberately **not**
  routed through `onChange()`/marked dirty, since loading existing content isn't a user edit.
- **Find & replace bar** (`toggleFind`) — a lazily-created `.doc-find` bar inserted just
  before `.doc-canvas`. "Find next" uses the (non-standard but widely supported)
  `window.find()` browser API for live in-page highlighting; "Replace all" uses
  `replaceAllInSurface` (the chip-skipping text-node walker described above).
- **Mode switching** (`setMode('visual'|'code')`) — going to `code` mode serializes the
  current canvas into the `<textarea>` and hides the canvas/tabs/panels; going back to
  `visual` re-parses the textarea's raw HTML via `bodyToEditorHtml` back into chips. This
  means **any editor state that only exists as ribbon UI state (e.g. an in-progress cell
  selection) is lost across a mode switch** — expected, since the underlying model
  (serialized HTML) is the only thing preserved.
- **Close** (`close(force)`) — if `dirty` and not `force`, confirms discard via
  `UI.confirmDialog` first; otherwise tears down the toolbar wiring, removes the preview
  panel if open, removes the `.doc-fs` DOM node, and removes the `keydown` listener.
- **Keyboard shortcuts** (document-level `keydown`, added in `open()`, removed in `close()`):
  `Escape` closes (unless a `.modal-overlay` is currently open, so Escape inside a nested
  dialog doesn't also close the whole editor); `Ctrl/Cmd+S` clicks Save; `Ctrl/Cmd+F`
  toggles Find.
- **Save** (`[data-save]` click handler) — serializes the body (from whichever mode is
  active), computes final `widthMm`/`heightMm` via `currentPageMm()`, **strips any stale
  `<style data-docpage>` tag out of the body and re-prepends a freshly-built one** via
  `pageStyleTag(...)` (so the saved page-setup values always come from the live form
  controls, never a leftover parsed value), disables the Save button during the async
  `opts.onSave(...)` call, and interprets the result per the `onSave` contract described in
  Exports above.

## Dependencies
- **`UI`** — `UI.modal`, `UI.toast`, `UI.confirmDialog`, `UI.contextMenu`, `UI.esc` are used
  throughout the dialogs and wiring. `doc-editor.js` does **not** use `UI.icon()` for its
  own ribbon buttons — it uses raw Unicode glyphs/emoji instead (`↶ ↷ B I U S ⬅ ⬌ ➡ ☰ • ≣
  1 ≣ ⇤ ⇥ 🔍 🖼 ▦ 🔗 ☐ ― ⤓ ▭ ✒ Ω { } ƒx 👁 …`), a deliberate departure from the app-wide
  "use `UI.icon()`, never emoji" convention (see ARCHITECTURE.md §5) — likely because the
  ribbon needs a much larger, denser icon set than `ui.js`'s curated `ICONS` map covers.
- **`evalFormula`** (global from `doc-formula.js`) — used directly (not via a
  dual-resolution helper) in the formula dialog's live preview; guarded with
  `typeof evalFormula !== 'undefined'`.
- Loaded in `index.html` after `doc-context.js`, before `hr-payroll-print.js` and `app.js`:
  `..., doc-formula.js, doc-template.js, doc-context.js, doc-editor.js, hr-payroll-print.js,
  app.js, ...`.
- Depends on the caller (`views/templates.js`) to supply `getVariables`, `sampleContext`,
  `renderPreview`, and `onSave` — the editor itself has zero knowledge of `API`, template
  storage, or the variable-catalog server route.

## Used by
- **`public/js/views/templates.js`** — the only caller (`window.DocEditor.open({...})` in
  its `editor(tpl)` function), for both "New template" and "Edit template". Supplies
  `getVariables` (built from `/templates/variables/catalog` + custom variables),
  `sampleContext`/`renderPreview` (built from the module's `SAMPLE` context +
  `applyVariables` from `doc-context.js`), and `onSave` (persists via `POST`/`PUT
  /templates`).
- `tests/doc-editor.test.ts` — exercises the CommonJS-exported pure helpers directly:
  `bodyToEditorHtml`/`serializeEditor` round-trips (plain vars, formulas, control tokens,
  repeatable item rows, checkboxes, the `<img src="{{var}}">` placeholder case, and that an
  *ordinary* (non-variable) image src is left untouched), `sanitizeHtml` paste-hardening,
  `replaceAllInSurface`, and `parsePageStyle`/`pageStyleTag`/`pageDims` round-trips
  including custom-size detection and legacy-format backward compatibility.

## Notes / gotchas
- **Chip-in-`<img src>` serialization trick**: a `{{var}}` used as an image source can't
  become an inline chip `<span>` without breaking the `<img>` tag's HTML, so
  `bodyToEditorHtml` swaps it for `EDITOR_IMG_PLACEHOLDER` (a neutral silhouette SVG data
  URI) plus `data-var-src="<token>"`, and `serializeEditor` restores the real
  `src="{{token}}"` from that attribute on save. If you're debugging why a template's image
  variable "disappeared," check for this placeholder swap before assuming data loss.
- **Top bar is deliberately split into a scrolling region and a pinned region**
  (`.doc-fs-bar-scroll` vs. `.doc-fs-bar-actions`) so **Save and Close can never become
  reachable only via horizontal scroll** on a narrow window — every other top-bar control
  (name/type/period inputs, mode toggle, variables gear) lives in the scrolling half and
  has been deliberately trimmed (Find/Preview relocated into ribbon groups, Variables
  button icon-only, narrower name/period widths, ellipsis'd title) to keep that half under
  one screen-width in practice.
- **`Find`/`Preview` are queried by attribute, not position** (`[data-find]`,
  `[data-preview]`) — there is exactly one of each in the whole DOM (now living inside
  ribbon groups rather than the old top bar), so moving them again just means moving the
  `groupHTML(...)` call site; no other code needs to change.
- **Page setup**: only the **Margin** field affects the live on-screen canvas
  (`applyCanvas()`'s `padding`); Size/Width/Height/Orientation only affect the canvas's own
  `width`/`min-height` and the saved `@page` rule — don't expect changing Size alone to
  visibly reflow on-canvas margins.
- **`document.execCommand` is deprecated but load-bearing** — this editor's entire
  formatting layer (bold/italic/alignment/lists/font/color/insertHTML) runs on it. Any
  future browser removal of `execCommand` would require rewriting `wireToolbar`'s `exec`/
  `insertHtml` around the Selection/Range APIs directly.
- **Selection save/restore is mandatory before any modal-driven insert** — opening
  `UI.modal(...)` moves focus off the `contenteditable` surface, which collapses/loses the
  live browser selection. Every dialog function calls `saveSel()` synchronously (inside the
  triggering click handler, before the modal opens) so `restoreSel()` can put the caret
  back before `execCommand`/`insertHTML` runs on confirm.
- **CommonJS vs. browser export lists differ** (see Exports above) — `open` is browser-only
  (it's not meaningfully testable without a real DOM + `execCommand`), while
  `parsePageStyle`/`pageStyleTag`/`pageDims`/`replaceAllInSurface` are CommonJS-only exports
  not attached to `window.DocEditor` (though they're still defined as top-level functions
  usable internally by `open`) — if you need one of these from another browser file, you'd
  need to add it to the `window.DocEditor` object explicitly, it is not currently exposed
  there.
- **`sanitizeHtml`'s class allowlist is a fixed regex**, not `SANITIZE_TAGS`-driven — adding
  a new editor-generated CSS class that must survive a paste round-trip requires updating
  the regex in `sanitizeNode` (`/doc-(chip|chip-ctrl|chip-fx|checkbox|pagebreak|table|
  striped|shaded|plain|is-repeat)/g`), not just adding it elsewhere.
