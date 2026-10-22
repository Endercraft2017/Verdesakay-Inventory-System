# `public/js/doc-editor.js`

## Purpose
`DocEditor` is a full-screen, Word-style WYSIWYG editor for document templates. The
editing surface *is* the document page — no separate "design vs. preview" split for basic
formatting. It supports a Visual mode (`contenteditable` canvas + ribbon toolbar) and a raw
HTML/CSS mode, table tools, a formula builder, variable autocomplete/picker, exact
page-size/margin setup, and a zoomable canvas with Figma-style move/resize/snap for
floating objects. It produces and consumes the HTML + `{{var}}` (+ inline
`{{= formula}}`) body format that `doc-template.js`'s `renderTemplate()` understands. At
~1400 lines this is the largest and most internally complex file in the frontend — this
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
- `getTemplateId()` → the current saved template ID (or null for a draft). Enables
  **Linked forms** for accounts with form-management permissions. The dialog links
  existing forms, assigns default print layouts, and unlinks without deleting the
  template, using the existing scoped form APIs. Drafts offer **Save template and
  continue**. Fields from linked forms join the Insert → Field catalog automatically when opening a saved template and after changing links. Form links apply immediately; document edits still require saving.
- `sampleContext` — a context object used to live-evaluate formulas in the formula
  builder's preview and to drive `renderPreview`.
- `renderPreview(body)` → HTML string — used by the movable preview panel; if omitted, the
  preview shows `<p>No preview</p>`.
- `onManageVars({ refresh })` — if provided, shows **Manage fields** in Insert; clicking it
  hands control to the caller (e.g. opens a "manage variables" modal), and the editor
  expects the caller to call `refresh()` when done so the live preview updates.
- The top bar also has an always-present `?` button (`[data-help]`) → `docEditorHelpDialog()`,
  a tabbed `UI.modal` cheat sheet — **Basics / Variables / Repeating rows / Formulas & totals /
  Layout & pages / Move & resize**, one topic on screen at a time (a left `.dhg-nav` rail +
  scrollable `.dhg-body` pane, wired by a plain `click` delegate in `onOpen` that toggles
  `.active` on the matching `[data-t]` button and pane). Each pane is short numbered
  `.dhg-step`s / bulleted `.dhg-dot` items built by tiny local `step()`/`bullet()`/`note()`
  template helpers, several paired with a small **inline-SVG "screenshot"** mockup
  (`SHOT_MODES`, `SHOT_VARFLOW`, `SHOT_ITEMROW`, `SHOT_FXBTN`, `SHOT_LAYOUT`, `SHOT_FLOAT`) of
  the real ribbon button / pill / table / handles it's describing — UI-chrome shots use
  `var(--...)` tokens so they track the current app theme, while the variable-pill/table
  shots are hardcoded light to match `.doc-chip`/`.doc-table`'s actual theme-independent
  styling on the white "paper". Pure reference — takes no editor handles, no `opts` toggle,
  and only touches its own dialog DOM (no side effects on the editor underneath).
- `onSave({ name, type, period, body, studioVersion, ...printSettings })` → `true` (or `undefined`) to mark saved while keeping the editor open, a
  `string` to show as an inline error toast and keep the editor open, or a rejected Promise
  (caught, shown via `UI.toast(err.message, 'error')`, editor stays open).
- Returns `{ close, _history }`. `_history` is the snapshot undo/redo controller
  (`flush`/`record`/`undo`/`redo`/…) — exposed only so tests can drive undo without waiting
  out the 350 ms coalesce debounce; production callers use `close` only.

### Pure helpers (exported both ways)
- **`bodyToEditorHtml(body)`** → editor-canvas HTML: converts stored `{{var}}` tokens into
  non-editable "chip" `<span class="doc-chip">` elements, and `{{#items}}<tr>...</tr>
  {{/items}}` into a `<tr data-repeat="items">` (dropping the literal token text, since the
  repeat marker becomes a data attribute + CSS treatment instead). See **Body↔canvas
  conversion** below for the full algorithm including the `<img src="{{var}}">` special case.
- **`serializeEditor(root)`** → the inverse: walks a clone of the canvas DOM, turns chips
  back into `{{token}}` text, `data-var-src` images back into `<img src="{{token}}">`,
  `data-repeat="items"` rows back into text-node `{{#items}}`/`{{/items}}` markers
  surrounding the `<tr>`, strips `.cell-sel` selection-highlight classes, removes any
  `.doc-float-handle` / `.doc-float-toolbar` / `.doc-promote-bar` / `.doc-snap-guide`
  chrome, drops the editor-only `.selected` / `.behind-text` classes off `.doc-float`s, and
  strips all `contenteditable` attributes, then returns `.innerHTML.trim()`.
  (Snap guides are also cleared on pointer-up / deselect / teardown — the strip here is
  belt-and-braces in case a save races an in-flight drag.)
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
- Field chips support click to select, double-click or Enter to change the field
  or edit a formula, and formatting/deletion through the normal editor controls.
  Replacing a chip preserves its inline styling and participates in undo/redo; locked
  and tracked content remains protected. Repetition/condition tokens explain their
  purpose and direct users to Source for paired edits.
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
- **`homePanelHTML()`** — 4 groups: **Undo** (undo/redo — `data-ex="undo"|"redo"`, start
  `disabled`, driven by `open()`'s snapshot history not `execCommand`), **Font** (paragraph-style select,
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
- **`layoutPanelHTML()`** — 3 groups: **Page Setup** (Size select `a4|letter|custom`,
  Orientation select shown only for presets, Width/Height mm number inputs shown only for
  Custom, and an always-present Margin mm input that — unlike the others — also drives the
  live on-screen canvas padding, not just the saved `@page{margin}`), **Zoom** (a `−`
  button, a `.doc-zoomsel` `<select>` with a `Fit` option plus the manual rungs
  `50%…300%`, and a `+` button — `[data-zoom="in"|"out"]`), **Preview** (a single Preview
  tile, `data-preview` — same "moved off the top bar, queried by attribute" pattern as
  Find). The Zoom controls only affect the on-screen canvas; they are never serialized.
- **`tablePanelHTML()`** — only shown while the caret is inside a table (see **Table-tab
  visibility** below): **Rows & Columns** (+Row/−Row/+Col/−Col), **Merge** (Merge →, Merge
  ↓, Split), **Design** (cell-shading color swatch, column-width dialog, table-style select
  `Bordered|Striped|Shaded header|Plain`), **Template** (↻ "Item row" — toggles
  `data-repeat="items"` on the current row, `= ƒx` formula-cell shortcut, delete table).

### 5. Shared modal dialogs
Each takes an `insertHtml`/`saveSel` (and sometimes `getVariables`/`initial`/
`sampleContext`) closure from `wireToolbar`, so they can restore the caret's saved
selection before inserting:
- **`insertTableDialog`** — rows/cols/header-row inputs → builds a `<table class="doc-table">`
  with a real `<thead><tr><th>…` when "Header row" is checked plus a `<tbody>` of `<td>`
  rows (`&nbsp;`-filled). "Rows" is the total including the header. The `<thead>` split is
  what makes the **Shaded header** / **Striped** table styles (and the matching print CSS)
  line up, and makes striping count data rows only.
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

### 6. `wireToolbar(panelsRoot, surface, getVariables, onChange, sampleContext, tabApi, getZoom, onUndo, onRedo)`
The largest function in the file — wires every interactive behavior of the canvas and
ribbon once, at editor-open time. `getZoom` is a live getter (`() => currentZoom`, supplied
by `open()`) that the float drag/snap code reads so its pixel thresholds stay a constant
*on-screen* distance at any canvas zoom. `onUndo`/`onRedo` are thunks into `open()`'s
snapshot history — the ribbon's `data-ex="undo"`/`"redo"` buttons call these instead of
`execCommand('undo'|'redo')`, because the native stack never saw the float/table/page edits.
Key sub-concerns:
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
- **Floating objects — insert / promote / select** — Insert-tab Shapes, Text Box, and the
  "⛶ Make …​ movable" promote bar wrap content in an absolutely-positioned `.doc-float`
  (`position` + `left`/`top`/`width`/`height` as **% of the page**, `z-index`,
  `contenteditable="false"`). `selectFloat()` adds 8 `.doc-float-handle`s + a
  `.doc-float-toolbar` (z-order, fill/border, "put back in the text", delete);
  `serializeEditor` strips all of that back out on save. Promoted images/tables/other
  elements keep an editable inner island (`contenteditable="true"` re-applied by
  `normalizeFloats()` after any full re-render).
  - **`showPromoteBar` refuses page-spanning containers** — if the clicked element's rect
    is > 55 % of the page area, or it holds a `<table>` plus other block children, the bar
    is not shown (a toast points the user at a specific block instead). This is the fix for
    the "I promoted `<div class="doc">` and now the whole document is one un-editable block
    I can't get out of" trap.
- **Floating objects — editable interiors (text boxes, promoted tables/blocks)** — clicking
  the interior selects the object and lets the browser place a caret immediately. Selection
  does not change padding or text wrapping. Drag the explicit **Move** toolbar grip to position
  the object; resize handles remain available outside text editing.
  - A press on the interior is not prevented; the browser drops a
    caret → a `selectionchange` listener (`updateEditing`) sees the caret inside `islandOf()`
    and adds `.editing`, whose CSS **hides 7 of the 8 handles** — the **SE
    handle stays** as a blue corner grip (bigger, filled): **drag it to resize** while editing,
    or **click it** (no drag — `endFloatDrag` sees `!moved` on a `resize` state) to drop
    `.editing` and get the full move/resize chrome back. The toolbar stays visible too.
  - **Escape** is two-stage in `onFloatKeydown`: from `.editing` it pops back to move mode
    (`classList.remove('editing')` + clear the selection + `surface.focus()`); from move mode
    it `blurFloats()`. `deselectFloat`/`serializeEditor`/`normalizeFloats` all strip `.editing`.
  Shapes/images have no island (`islandOf` → null) — any press drags, no frame, no `.editing`.
- **Promoted `<table>` fills its wrapper** — `.doc-float[data-float-kind="table"]{display:grid}`
  + `> table{margin:0;width:100%;height:100%}`. A bare `<table>` is content-height and
  `.doc-page` tables carry a 12 px vertical margin, so without this a resized wrapper just grew
  empty space (drag-resize looked broken, especially vertically) and a promoted table sat
  small inside an over-tall box. Grid stretch is the reliable way to give a `<table>` a
  container's height; `promoteToFloat` also does this for `<img>` (inline `width/height:100%`).
- **Floating objects — deselect / "get out"** — `blurFloats()` (exposed on the `wireToolbar`
  return) drops every kind of float selection + the promote bar. It fires on: **Escape**
  (`onFloatKeydown` calls it and `stopImmediatePropagation`s so `open()`'s `onKey` can't
  also close the editor; `onKey` has a `!wired.blurFloats()` backstop anyway), and a
  **`pointerdown` on the grey desk** outside `.doc-page` (`open()` wires this on `.doc-canvas`
  — the escape hatch when a float covers the whole page). The toolbar's **↩** button
  un-floats a promoted element entirely (`unpromoteFloat`).
- **Floating objects — temporary groups (multi-select)** — `multiSet` (a `Set`, not
  persisted). **Shift-click** a float toggles membership (`toggleMulti`); the first
  shift-click folds the current single selection in, so "click A, shift-click B" = {A, B}
  (dashed `.multi` ring, no handles/toolbar). Dragging any member moves them all by the same
  delta (`dragState.group`, **snapping skipped**); **Delete** removes them all; a plain
  (non-shift) click, Escape, or a desk click clears the group; toggling back down to one
  member collapses to a normal single selection. `serializeEditor` / `normalizeFloats` strip
  the `.multi` class.
- **Floating objects — z-order ("back / front")** — the toolbar's ⬆/⬇ nudge `z-index` by
  ±1, **clamped to `[-2, 60]`**. `.doc-page` sets `isolation: isolate` so it is its own
  stacking context: a float sent to a *negative* z-index paints below the page text but
  **still above the page's white fill** — it no longer "falls through the paper" into the
  grey canvas (the old bug: `.doc-page` had no stacking context unless zoomed, so a
  negative-z float escaped to `.doc-fs` and rendered behind everything). Ceiling 60 keeps a
  front-most float under the 1000+ handle/toolbar layer. A negative z also gets the
  editor-only `.behind-text` class (a faint dashed ring so the hidden float is findable);
  `normalizeFloats()` restores it from the z-index on load, `serializeEditor` strips it
  (the inline `z-index` is the real signal). The print/preview stylesheet (`ui.js`
  `PRINT_CSS`) carries matching `.doc-float*` display rules + `body { isolation: isolate }`.
- **Floating objects — move / resize on Pointer Events** — `pointerdown` on a float frame
  (not its editable island) starts a `move`; on a handle, a `resize`. The pointer is
  captured (`setPointerCapture`, guarded — jsdom 29 lacks it) so a drag survives the
  pointer leaving the window or crossing the preview `<iframe>` (plain `document`
  `mousemove` stops firing there). All geometry stays in `getBoundingClientRect()` space,
  which is **post-CSS-zoom**, so the `%` conversions need no zoom factor — only the 12px
  min-size clamp is multiplied by `zoomNow()`. `pointerup`/`pointercancel` end the drag and
  fire `onChange()` **only if the float actually moved** (a plain click that just selects a
  float is not a dirtying edit). Listeners are on `document` and removed in `teardown()`.
- **Floating objects — snap-to-guide** (`applySnap`) — on every move/resize frame, the
  dragged edges (`left`/centre-x/`right`, `top`/middle-y/`bottom` for a move; only the
  handle's live edges for a resize) are tested against: every **other** float's
  left/centre/right + top/middle/bottom (`siblingLines`), and the page frame + margin box
  (from `getComputedStyle(surface).padding*`, scaled) + page centre (`pageLines`). Within
  `SNAP_SCREEN_PX` (6 real screen px, no zoom factor) the value is nudged onto the line and
  a `.doc-snap-guide` (`.v` / `.h`, a `%`-positioned 1px child of the surface) is drawn.
  Guides are cleared on
  `pointerup`/`pointercancel`, on `deselectFloat()`, in `teardown()`, and — as a last
  resort — by `serializeEditor`.
- **Toolbar state reflection** — a `document`-level `selectionchange` listener
  (`reflect()`) toggles `.active` on the Bold/Italic/Underline/Strikethrough buttons based
  on `document.queryCommandState(cmd)`, so the ribbon shows which formats are active at the
  caret — Word-like live state, not just click-to-apply.
- Returns `{ teardown(), normalizeFloats(), blurFloats() }` — `teardown()` removes the
  `selectionchange` listener, the three `document` float-pointer listeners
  (`pointermove`/`pointerup`/`pointercancel`), the float `keydown` listener, and clears any
  stray snap guides (called from `open()`'s `close()`). `blurFloats()` drops any float
  selection / multi-group / promote bar and returns whether it cleared anything — `open()`
  calls it from the desk-click handler and as the Escape backstop.

### 7. `open(opts)` — top-level orchestration
- `ensureStyles()` — injects a single `<style id="doc-editor-styles">` into `<head>` once
  per page load (idempotent guard via `document.getElementById` check) containing every
  class this file uses: `.doc-fs` (fixed, full-viewport overlay), `.doc-fs-bar` (top bar,
  split into `.doc-fs-bar-scroll` + `.doc-fs-bar-actions` — see Notes), `.doc-tabs`/
  `.doc-panel`/`.doc-group`/`.doc-tile` (ribbon), `.doc-canvas`/`.doc-zoom`/`.doc-page` (the
  actual editing surface, styled to look like a physical page — white background,
  box-shadow, Segoe UI; `.doc-zoom` is the zoom sizer, see **Canvas zoom** below),
  `.doc-float`/`.doc-float-handle`/`.doc-float-toolbar`/`.doc-promote-bar`/`.doc-snap-guide`
  (floating-object chrome — handles, toolbars and the promote bar counter-scale by
  `1/var(--zoom)` so they stay a constant on-screen size),
  `.doc-chip`/`.doc-chip-ctrl`/`.doc-chip-fx` (variable chip styling incl. the
  `::before` type-marker glyphs `{ }`/`‹›`/`ƒx`), `.doc-find` (find/replace bar), `.doc-ac`
  (autocomplete popup), `.doc-preview-float` (the movable preview panel). All colors are
  CSS custom properties with light-mode fallbacks (`var(--accent, #2b7fff)`) so the editor
  respects the app's dark/light theme even though it's injected as a plain `<style>` tag
  rather than living in `styles.css`.
- **DOM construction** — builds one `.doc-fs` div containing: the top bar (title, name
  input, type select, optional period input, Visual/HTML-CSS mode toggle, variables-manage
  gear button — all in the scrolling region — plus pinned Save/Close buttons); the tab
  strip; four `.doc-panel`s (home visible, insert/layout/table hidden via inline
  `style="display:none"`); the canvas (`.doc-canvas` > `.doc-zoom` >
  `.doc-page.doc-surface[contenteditable]` — the `.doc-zoom` wrapper is the zoom sizer);
  and a hidden `<textarea class="doc-code">` for HTML/CSS mode.
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
  physical dimensions). Every page-setup `change` also calls `applyZoom()` so the zoom
  sizer tracks the new page dimensions.
- **Initial load**: `surface.innerHTML = bodyToEditorHtml(pg.rest)` — deliberately **not**
  routed through `onChange()`/marked dirty, since loading existing content isn't a user edit.
- **Canvas zoom** — `.doc-page` is CSS-`transform: scale()`d; `.doc-zoom` is a real-px sizer
  (`margin: 0 auto`, its `width`/`height` set to `naturalPageSize() * zoom`) so scrollbars
  are correct and a page wider than the viewport scrolls left instead of clipping (`margin:
  auto` beats `justify-content` on a flex item). `applyZoom()` also sets `--zoom` on
  `.doc-zoom` for the counter-scaled handle/toolbar CSS, and stores the effective factor in
  `currentZoom` (read by `wireToolbar` via the `getZoom` param). Zoom levels are a fixed
  ladder `ZOOM_LADDER` (`0.25…4`) plus a `fit` mode (`computeFit()` — page width vs.
  `canvas.clientWidth`, capped at 100%, auto-selected on open if an A4 page would overflow).
  Inputs: the Layout-tab **Zoom** group (`.doc-zoomsel` + `[data-zoom="in"|"out"]`),
  `Ctrl/Cmd + wheel` on `.doc-canvas` (zoom-to-cursor — adjusts `scrollLeft/Top` so the
  point under the pointer stays fixed), and `Ctrl/Cmd + +/-/0`. A `ResizeObserver`
  (rAF-debounced, guarded — absent in jsdom) on `surface` + `canvas` re-runs `applyZoom()`
  on content growth (more pages) and window resize (for `fit`); disconnected in `close()`.
  `setMode('visual')` also calls `applyZoom()` after the re-render.
- **Find & replace bar** (`toggleFind`) — a lazily-created `.doc-find` bar inserted just
  before `.doc-canvas`. "Find next" uses the (non-standard but widely supported)
  `window.find()` browser API for live in-page highlighting; "Replace all" uses
  `replaceAllInSurface` (the chip-skipping text-node walker described above).
- **Mode switching** (`setMode('visual'|'code')`) — going to `code` mode serializes the
  current canvas into the `<textarea>` and hides the canvas/tabs/panels; going back to
  `visual` re-parses the textarea's raw HTML via `bodyToEditorHtml` back into chips. This
  means **any editor state that only exists as ribbon UI state (e.g. an in-progress cell
  selection) is lost across a mode switch** — expected, since the underlying model
  (serialized HTML) is the only thing preserved. `history.flush()` runs on the way out and
  `history.record()` on the way back to `visual`, so a code-mode edit is one undo step.
- **Snapshot undo / redo** (`history`, built after the zoom block; needs the page-setup
  controls + `applyZoom`, so declared as a forward `let` and referenced lazily by `onChange`
  / `wireToolbar`). A **snapshot** = `{ body: serializeEditor(surface), page: {size, orient,
  w, h, margin} }` — everything the browser's `execCommand` undo stack misses (floats,
  tables, checkboxes, page setup). `onChange` (and the page-setup change handlers) call
  `history.scheduleRecord()`, which coalesces bursts on a 350 ms timer; `undo()` / `redo()`
  / save / mode-switch / surface `blur` `flush()` the pending one first, so a quick Ctrl+Z
  still lands. `record()` truncates the redo tail, pushes, caps the stack at 60, and toggles
  the ↶/↷ buttons' `disabled`. `restore(s)` sets a `restoring` guard (so it can't re-record
  itself), does `surface.innerHTML = bodyToEditorHtml(s.body)` + `normalizeFloats()`,
  re-applies the page-setup controls + `applyCanvas`/`applyZoom`, marks `dirty`, and
  re-focuses the surface. Selection/caret is **not** preserved across an undo. History is
  **visual-mode only** — in code mode CodeMirror owns undo, and the Ctrl+Z/Y key handler
  early-returns.
- **Close** (`close(force)`) — if `dirty` and not `force`, confirms discard via
  `UI.confirmDialog` first; otherwise tears down the toolbar wiring, cancels the history's
  pending debounce, removes the preview panel if open, disconnects the zoom `ResizeObserver`
  (+ cancels its pending rAF), removes the `.doc-fs` DOM node, and removes the `keydown`
  listener.
- **Keyboard shortcuts** (document-level `keydown`, added in `open()`, removed in `close()`):
  `Escape` closes (unless a `.modal-overlay` is open, or a float is selected — then it just
  clears the selection); `Ctrl/Cmd+Z` = undo, `Ctrl/Cmd+Y` **or** `Ctrl/Cmd+Shift+Z` = redo
  (visual mode only; `preventDefault` so the browser's native contenteditable undo doesn't
  double-fire); `Ctrl/Cmd+S` clicks Save; `Ctrl/Cmd+F` toggles Find; `Ctrl/Cmd + +/-` step
  the zoom ladder and `Ctrl/Cmd+0` resets to 100% (the in-cell `=` formula shortcut is
  suppressed while `Ctrl/Cmd` is held so `Ctrl+=` zooms instead).
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
- **`public/js/modules/core/templates.js`** — the only caller (`window.DocEditor.open({...})` in
  its `editor(tpl)` function), for both "New template" and "Edit template". Supplies
  `getVariables` (built from `/templates/variables/catalog` + custom variables),
  `sampleContext`/`renderPreview` (built from the module's `SAMPLE` context +
  `applyVariables` from `doc-context.js`), and `onSave` (persists via `POST`/`PUT
  /templates`).
- `tests/doc-editor.test.ts` — exercises the CommonJS-exported pure helpers directly:
  `bodyToEditorHtml`/`serializeEditor` round-trips (plain vars, formulas, control tokens,
  repeatable item rows, checkboxes, the `<img src="{{var}}">` placeholder case, that an
  *ordinary* (non-variable) image src is left untouched, and that a stray `.doc-snap-guide`
  is stripped), `sanitizeHtml` paste-hardening, `replaceAllInSurface`, and
  `parsePageStyle`/`pageStyleTag`/`pageDims` round-trips including custom-size detection and
  legacy-format backward compatibility.
- `tests/doc-editor-floats.test.ts` — loads `doc-editor.js` as a real `<script>` in jsdom
  and drives `DocEditor.open()`: shape/text-box insert, promote-to-float, z-order, delete,
  Pointer-Event drag/resize, snap-to-guide (guide drawn + cleared on drop + free-move when
  out of tolerance), the Zoom select / `+`/`-` buttons, the z-order clamp + `.behind-text`
  hint + `serializeEditor` stripping it, Escape / desk-click deselect, shift-click temporary
  groups (move + delete as one, collapse back to single), the `showPromoteBar`
  page-spanning-container refusal, snapshot undo/redo (Ctrl+Z/Y/Shift+Z + the ↶/↷ buttons +
  the `disabled` states, incl. undoing a float insert and a float move), a promoted table's
  vertical (south-handle) resize, the direct text-box caret entry and the separate Move grip, two-stage Escape (edit → move → deselect), the edit-mode
  corner grip (drag = resize + stay editing, tap = back to move handles), the regression
  guard that promoting a table with a stray caret already inside it starts in move mode
  (not `.editing`) with all 8 handles, and the
  save-strips-chrome round trip. `getBoundingClientRect` is stubbed from each element's
  inline `%` styles; `setPointerCapture`/`releasePointerCapture` are stubbed (jsdom 29 lacks
  them); undo tests call `ret._history.flush()` to skip the coalesce debounce.

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
- **Tables render from two nearly-identical stylesheets** — the editor's `.doc-table` (in
  `ensureStyles`) uses `border-collapse: separate` + `border-radius` + `overflow: hidden`
  for rounded corners; `PRINT_CSS` (`ui.js`) keeps `border-collapse: collapse` so a long
  line-items table page-breaks cleanly (an `overflow:hidden` table clips rows on page 2).
  Same palette, so the only visible drift is the corner radius. Change one, change the
  other. Bare `<table>` (pasted, no `.doc-table`) falls back to plain collapsed borders.
- **Float print fidelity is approximate** — the editor positions floats as `%` of
  `.doc-page` (816px incl. padding); at print they position as `%` of `<body>`'s content
  box (page width − 48px). Close, not pixel-exact. Making it exact needs `printableHtml` to
  wrap the body in a page-sized positioned container (deferred).
- **`--doc-paper` stays white in dark mode** — a template is printed on white paper, so the
  editor "page" does not follow the app's dark theme; only the surrounding chrome/desk do
  (`--doc-desk` / `--doc-desk-dot` flip).
- **`document.execCommand` is deprecated but load-bearing** — this editor's entire
  formatting layer (bold/italic/alignment/lists/font/color/insertHTML) runs on it. Any
  future browser removal of `execCommand` would require rewriting `wireToolbar`'s `exec`/
  `insertHtml` around the Selection/Range APIs directly. **Undo/redo no longer uses it** —
  `execCommand('undo')` only ever saw the rich-text edits, never the float/table/page
  changes, so the ribbon buttons + Ctrl+Z/Y now drive `open()`'s snapshot history and the
  Ctrl+Z handler `preventDefault`s to stop the native stack double-firing.
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
  striped|shaded|plain|is-repeat|float|float-body|float-shape)/g`), not just adding it
  elsewhere.
- **Zoom math is mostly "do nothing"** — float drag/resize works entirely in real on-screen
  CSS px (`getBoundingClientRect()` already includes the CSS `scale()`; `e.clientX` is
  viewport px), and positions are stored as `%` of the (also-scaled) page rect, so the
  percentage conversions are zoom-invariant with **no** `/zoom` factor. `SNAP_SCREEN_PX` is
  likewise a plain screen-px constant (that's what keeps the snap a constant *visual*
  distance). The **one** zoom-aware value is the `12 * zoomNow()` min-size clamp — it means
  "12px in the final printed document", not on screen, so it grows with zoom. `pageLines()`
  also multiplies the *computed* (unscaled) `padding` by zoom to bring it into the scaled
  screen-px space the rest of the snap math uses. If you add a pixel constant to the drag
  code, decide which of those two camps it's in.
- **`.doc-zoom` uses `margin: 0 auto`, not `justify-content`** — a flex item with an auto
  margin isn't clipped when it overflows its container the way `justify-content: center`
  clips the start edge, so a zoomed-in page still scrolls left. Don't "simplify" it back to
  `justify-content` on `.doc-canvas`.
- **Handles / toolbars / promote bar counter-scale via `calc(… / var(--zoom,1))`** (with
  `--zoom` set on `.doc-zoom` by `applyZoom()`), so they stay a constant on-screen size at
  any canvas zoom. A `--zoom` of `0` or an unset var would divide-by-zero / fall back to
  `1`; `applyZoom()` always writes a positive number.
- **Float drag is Pointer Events, but table cell-selection / column-resize and the preview
  panel drag are still `mousedown`/`mousemove`** — deliberately left alone (they work and
  are out of scope). If you unify them later, the float pointer-capture pattern is the one
  to copy.


## Reliability and workspace refinement (October 2026)

The visible editing mode is labeled **Design** (internal mode remains `visual`). The
workspace separates document identity, labeled metadata, ribbon commands and the paper;
its status bar shows paper dimensions and zoom. Save state remains visible on desktop.
Consistent SVG icons replace platform-dependent emoji in the main ribbon and actions.
The library uses document rows with layout summaries and independently gated company controls.

Code mode switches only after CodeMirror initializes and receives the existing body.
Metadata edits participate in dirty tracking, and dirty/pending saves protect browser unload.
Edits made while a save is pending keep the editor open; a newly created template's ID and
revision are retained so a subsequent save updates it instead of creating another copy.
Undo snapshots now include every print-grid setting. Keyboard undo in metadata/modal inputs
retains native behavior. The studio tools described below add draft recovery, local history,
layers, page controls, and server-backed collaboration described below.

Single-row item loops use the existing repeat-row representation. Other table-level control
boundaries use encoded comments so HTML table parsing cannot move them outside their table.
Serialization restores the tokens at their original boundaries, including multi-row loops and
non-item datasets. Logical table occupancy handles colspan/rowspan and excludes nested tables;
merges that cut through another span or table section are refused.

Paste handling enforces the tag allowlist regardless of class, normalizes ignored URL controls,
and uses explicit scheme checks. Preview iframes are sandboxed without script execution.
`UI.documentCss` supplies common typography/table styling for editor and output. Standalone
output translates full-paper percentage float coordinates to physical content coordinates;
tiled output keeps floats relative to their cells and uses the selected physical content width.

Regression coverage: `tests/doc-editor-reliability.test.ts`, `tests/templates-ui.test.ts`,
`tests/templates.test.ts`, and `tests/form-builder.test.ts` alongside existing editor/render tests.

## Studio tools and interaction improvements

The **Tools** button shows or hides a persistent sidebar. On narrow screens it starts
collapsed to preserve canvas space. Saving now keeps the editor open. Ribbon commands
use click events, so keyboard activation works; their mouse press preserves the caret.
Selected objects can be nudged with arrow keys (0.1% of the containing page), or Shift
and an arrow for a 1% step. Inputs retain their own navigation and deletion behavior.

- **Properties:** edit position and dimensions for floating objects; font, line height,
  spacing, alignment and colors for selected blocks. Changes enter the same undo history
  as text, page settings and print-grid settings.
- **Layers:** select, name, reorder, hide and lock floating objects. Shift-click objects
  and choose Group; Ungroup restores their absolute positions. Hidden layers are hidden
  in output too. Locking prevents object movement/deletion and disables editable interiors.
- **Data:** insert fields, conditional blocks and repeating tables; check unmatched blocks,
  unknown fields, missing preview values and formula parse errors. Preview scenarios cover
  long strings, empty values/collections, and 50-row collections. Real record IDs load through
  existing order/form APIs and their access checks. JSON contexts are also supported. Preview
  data is transient and never becomes template content.
- **Pages:** insert explicit page breaks, running header/footer text and printed page numbers;
  check floating objects that extend outside the paper. Automatic canvas guides are approximate:
  browser pagination, rendered data and table fragmentation determine final printed pages.
- **Library:** save and reuse selected styles and blocks/assets, with names and deletion controls.
- **History:** recover automatically saved drafts (700 ms debounce), create checkpoints,
  and restore up to 20 saved/opened versions. Recovery includes metadata, paper dimensions,
  margins and grid settings and can be undone. Successful saves create checkpoints; the
  draft clears only if no newer edits occurred while saving.

Local fallback history and personal asset/style collections use **local browser storage**, scoped by origin, user,
workspace identity when available, and document key. They are not shared server backups;
clearing browser data removes them. Storage failures produce a visible message. Callers supply
`documentKey`; template creation additionally supplies `getDocumentKey()` so local history moves
to the permanent template identity on the first successful save. Form templates begin with the form ID and shared server data migrates to the linked template ID on publication.
Custom/real preview contexts are deliberately excluded from local checkpoints.

`UI.printableHtml` repeats table headers and uses paged-media margin boxes for running text and
page counters. This is verified in Chromium; browser support for margin boxes varies. Running
header/footer output uses text with fixed print styling. Saved floating groups retain child
percentages; only the outermost float is mapped from paper coordinates to physical print units.
Measured pagination and shared history are described below.

Additional regression coverage: `tests/doc-editor-studio.test.ts` and real Chromium checks of
responsive controls, grouped objects, and a two-page A4 PDF with running text and counters.

## Server-backed studio and measured pages

`doc-studio.js` connects template and form editors to tenant-local `/templates/studio`
endpoints. Drafts belong to the authenticated user and persist across devices. Optimistic
versions protect drafts from stale replacement. Local recovery remains a fallback. Saved
template history retains the latest 100 body/metadata/print-setting snapshots; custom
variable registries and company values are not included in those snapshots. Restoring a
version is an undoable edit and requires Save to publish.

Saved templates have a shared working session polled every two seconds, editor presence,
and block-anchored comments. Stable `data-doc-node` IDs and `doc-sync` comments support
three-way merges of independent blocks and metadata. Simultaneous changes to the same
block or document structure require explicit review in Shared; local work is preserved.
Publishing checks both the saved revision and working-session version. New standalone
templates use private drafts until first save. Form-scoped permissions apply to form editors.

Library includes company assets, reusable styles, and brand font/color defaults. Company
publication and deletion require `templates.company`; optimistic versions reject stale writes.
Private drafts and shared sessions are distinct from the published template used by records.

`doc-pagination.js` measures rendered content after fonts/images load. Pages mode and
`UI.loadPrintFrame` use the same physical sheets as `UI.printFrame`. Long text and tables
fragment into available space; table headers repeat and rowspan groups stay together.
Running text and page counters appear on each sheet. Complex oversized atomic layouts
fall back visibly to native browser pagination with the original content preserved. Tiled
and payslip layouts retain their existing fitters. Page preview clicks return to the
corresponding block in Design. Continuous canvas guides remain approximate.

Coverage includes `tests/doc-studio.test.ts` and real Chromium sessions with separate
authenticated users, independent edits, comments, mobile controls, and a six-page A4
PDF containing every row of a 90-row table.

## Choosing form layouts

Form Builder's template action opens **Print templates**. Users can create, link, edit,
duplicate, make default, or unlink layouts within their form-management scope. Shared
layouts show a reuse count and explain that edits affect all linked forms; duplicate for
independent changes. New layout editors use separate private draft identities and switch
to the permanent template identity after Save. Editing an alternative never changes the
form's default. Copies retain source-scoped custom variables and print settings.

Record printing loads the current linked layouts. With multiple layouts, **Choose print
layout** preselects the default; another selection affects only that print. This applies to
single and bulk records, including payslips. Payslip record details and email use the assigned
default. The specialized payslip pairing layout is retained. Template variables still must
match the destination form's fields; the form editor exposes those fields in its picker.

Page setup parsing accepts DOM-normalized `data-docpage=""` attributes and strips duplicate
setup tags when loading, preventing remote restoration from accumulating page rules or
leaving a completed new-template save marked unsaved.


### Grid spacing and table properties

Layout → Print Grid provides horizontal and vertical gaps in millimetres (0–30; default
6 preserves existing templates). Zero packs cells together. Settings travel with template
copies, shared sessions, drafts and history; previews and each grid print path use the
same values. Fitting considers width and height and never enlarges content.

Select a table cell, open the Table tab, then Properties to configure table width,
alignment, auto/fixed column layout, border color/style/width, cell padding, current
cell vertical alignment, current row minimum height and keeping that row together.
First-row header formatting uses a semantic thead for repeated pagination headers.
Equal columns distributes widths while respecting merged cells. Existing merge/split,
row/column operations, cell shading, table styles and drag resizing remain available.


### Balanced editor update

Editor chrome follows the shared Segoe UI font stack, theme surfaces, accent, border,
radius and shadow tokens. Paper content remains independent of the application theme.
Home → Spacing sets line spacing, space before/after, left indent and first-line indent
for selected paragraphs. Outline navigates semantic headings. Browser spellcheck is
enabled. The status bar counts document words, excluding variable chips and editor tools.

Properties adds rotation, opacity and corner radius for floating objects. Page alignment
operates on the active object or multiple Shift-selected objects. Horizontal/vertical
distribution requires at least three unlocked objects with the same parent. Changes use
the existing undo, draft, history, collaboration and publication paths. Paste sanitization
preserves supported paragraph, table and object styling.


### File conversion and picture tools

The header's Import and export button opens Word export, HTML export, print/PDF preview
and DOCX import. Export includes the current unsaved snapshot; choose editable template fields or the
current preview data. Word export converts
supported semantic HTML to genuine DOCX structures (headings, formatted runs, lists,
links/bookmarks, tables, page setup and embedded PNG/JPEG/GIF/BMP images). Floating
geometry, custom CSS, image effects and linked/unsupported images produce conversion
notes; no remote resources are fetched by the server. Repeating/conditional template
logic does not round-trip through Word; HTML export retains template CSS, classes and
logic while removing executable HTML. Grid settings apply to printing.

DOCX import accepts one file up to 8 MB and checks archive counts/expanded size before
Mammoth conversion. Editor permissions use the existing document identity resolver.
Converted content is sanitized, shown in a sandboxed preview and applied by appending
or replacing as an undoable unsaved edit. Replacing is blocked if the document changed
during conversion. The original can be downloaded unchanged. Import does not overwrite
a saved template or its page/grid settings.

Select an image (or floating image) and open Properties → Picture settings. The preview
shows fit/crop/stretch, masks, focal point, radius and basic filters before Apply. Inline
images have editable frame dimensions. Replacement preserves frame/effect settings;
replacing a variable-bound image intentionally removes its source binding. Alternative
text is saved with the image. CSS settings survive drafts, saved layouts and printing.

Outline → Insert contents list creates links to semantic headings. Titles update with
heading edits and targets survive DOCX conversion. Measured previews fill contents page numbers from actual heading sheets. Word exports
use an updateable contents field; native column pagination does not guess numbers. Grid printing suffixes heading IDs and their links separately in each cell.


## Structured documents and design pages

Pages → Create design pages wraps existing content as the first page. Add page, Duplicate,
Move earlier/later, Delete, names and backgrounds are undoable. Graphics are scoped to their
own page, including movement, resizing, snapping and grouping. Design pages share the main
page setup; sections can set their own size/margins. A second page or forced page boundary
resets rows/columns/repeat to 1 and Continuous to off and disables grid controls. Older saved
incompatible layouts bypass grids rather than being squeezed into a cell.

Styles applies named paragraph styles. Edit updates all paragraphs using that style;
direct formatting remains until that definition changes. Hierarchical numbering works on
numbered lists, with the existing Indent/Outdent tools controlling levels.

Review tracks typing, plain-text paste and simple deletion/replacement within one unlocked
paragraph. Reviewer names are descriptive metadata, not proof of identity. Structural edits,
format changes and composition input require tracking off. Accept/reject can target a change
or all changes and supports undo. Comparison shows text from the opening snapshot alongside
current proposed text. Prints hide deleted text; editable DOCX preserves actual Word revisions.

Pages → Section / columns wraps selected sibling paragraphs or inserts a new section. Size,
margin, columns/gap, start and background are persisted in HTML metadata. Different page setup
forces a new page. One-column sections use measured sheets; column sections keep native
browser pagination and surface that fact in preview. Pages → Insert footnote adds a linked
reference and editable note at the document end; numbering follows reference order. Word
export creates real footnotes. Import uses proposed Word text and does not retain review
history or section/style metadata; the original remains available.
