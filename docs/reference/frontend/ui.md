# `public/js/ui.js`

## Purpose
Shared, framework-free UI toolkit for the whole SPA: HTML-escaping, toasts, formatting
helpers, modals, a right-docked drawer, a context menu, print/preview HTML generation, and
an inline SVG icon set. Every view builds its markup with these primitives instead of
duplicating DOM/CSS boilerplate.

## Exports / Public API

Attached as the global `const UI` (IIFE; no CommonJS export — browser-only).

```js
{ esc, toast, fmtDate, fmtDateShort, fmtBytes, money, initials, modal, confirmDialog,
  drawer, contextMenu, closeContextMenu, printDocument, printableHtml,
  icon, helpIcon, emptyState, fileIconName, downloadCsv }
```

### Escaping & formatting
- **`esc(s)`** → HTML-escapes `&`, `<`, `>`, `"`, `'`. Treats `null`/`undefined` as `''`.
  Used everywhere any user/server-supplied string is interpolated into a template literal.
- **`fmtDate(s)`** → formats a SQLite `"YYYY-MM-DD HH:MM:SS"` (UTC, no `Z`) string as a
  locale date+time (`Aug 25, 2026, 2:30 PM`-style). Appends `Z` before parsing so it's
  read as UTC, not local time. Returns `s` unchanged if parsing fails.
- **`fmtDateShort(s)`** → same UTC parsing, but shows just a time (`"2:30 PM"`) if the date
  is today, otherwise `"Aug 25"`-style short date. Used for message/notification lists.
- **`fmtBytes(n)`** → human file size (`"0 B"`, `"512 B"`, `"1.5 KB"`, …), 1 decimal above B.
- **`money(n)`** *(added 2026-08-25)* → `Number(n || 0).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})`. Extracted here after `orders.js` and `hr-employees.js` were each found to independently define an identical local `money()` helper — both now alias `const money = UI.money`.
- **`initials(name)`** → first letter of up to the first 2 space-separated words,
  uppercased — used for avatar bubbles. `'?'` if `name` is falsy.

### Modal
- **`modal(opts)`** → `{ overlay, close, showErr }`.
  `opts`: `{ title, bodyHTML, confirmText?, cancelText?, onConfirm(overlayEl, showErr)?,
  size? ('lg'|'xl'), headActionHTML?, onOpen(overlayEl)? }`.
  - Appends a `.modal-overlay > .modal` structure to `#modal-root`.
  - Wires close on: any `[data-close]` click, clicking the overlay backdrop itself
    (`mousedown` where `e.target === overlay`).
  - If `opts.confirmText` is set, renders a `[data-confirm]` button; clicking it disables
    the button, clears any previous error, calls `opts.onConfirm(overlay, showErr)`
    (awaited), and closes the modal unless the callback explicitly returns `false` (a
    validation failure) — the callback throwing also keeps the modal open and shows
    `e.message` via `showErr`.
  - Any `<input>` inside the modal submits (clicks confirm) on `Enter`.
  - Autofocuses the first `input,select,textarea` found.
  - `opts.onOpen(overlay)` fires synchronously after wiring, before focus — used to attach
    custom listeners/render dynamic content.
- **`confirmDialog(message, confirmText = 'Confirm')`** → `Promise<boolean>`. Thin wrapper
  around `modal()`: resolves `true` on confirm, `false` on any close button. Standard
  "Delete this?" pattern used across almost every view.

### Drawer (right-docked, single instance)
- **`drawer(opts)`** → `{ el, close } | null`.
  `opts`: `{ title, bodyHTML, icon?, footHTML?, key?, onOpen(el)? }`.
  - Module-level `currentDrawer` enforces **only one drawer open at a time**: opening a
    new one closes the previous; calling `drawer()` again with the **same `opts.key`**
    while it's already open **toggles it closed** and returns `null` (used by `tools.js`'s
    rail buttons so clicking the same tool icon twice closes it).
  - Renders into `#drawer-root` (or `document.body` if absent), with a `.drawer-catch`
    backdrop element that closes on click.
  - Slide animation: adds `.open` class via `requestAnimationFrame` after insert; on close,
    removes `.open` then removes the DOM node after a 180ms `setTimeout` (matches the CSS
    transition duration — must stay in sync with `styles.css` if that timing changes).
  - Closes on `Escape` (document-level `keydown` listener, removed on close).

### Context menu
- **`contextMenu(x, y, items)`** — `items = [{ label, icon?, onClick() }]`.
  Renders a single `.context-menu` at viewport coordinates `(x, y)`, clamped to stay within
  the viewport (`Math.max(8, Math.min(x, innerWidth - width - 8))`, same for y).
  Auto-closes on: any click outside `.context-menu`, `Escape`, or scroll (capture-phase
  `scroll` listener on `window`, since menus don't scroll with content).
- **`closeContextMenu()`** — explicit close; also called internally at the start of every
  `contextMenu()` call (only one instance at a time, tracked in module-level `ctxState`).

### Printing
- **`printableHtml(html, title)`** → a full standalone `<!DOCTYPE html>` document string:
  fixed black-on-white `PRINT_CSS` (independent of the app's light/dark theme — always
  legible on paper) + `html` as the body. Used both for actual printing and for preview
  iframes (`srcdoc`).
- **`printDocument(html, title)`** — opens `window.open('', '_blank', 'width=900,height=1000')`,
  writes `printableHtml(...)` into it with an injected `onload` script that calls
  `window.print()` after a 250ms delay, then closes the document stream. **If the popup is
  blocked** (`window.open` returns falsy), shows an error toast and does nothing else.
  See Notes below — this is the *legacy* print path; prefer the iframe pattern for new code.
- `PRINT_CSS` (internal constant, not exported) — the print stylesheet: `.doc`, `.doc-head`,
  `.doc-table`, `.doc-totals`, etc. classes that order/template print bodies are expected
  to use; `@page { margin: 14mm }`.

### Icons
- **`icon(name, size = 18)`** → inline `<svg class="ic">` string, `stroke="currentColor"`
  (inherits the surrounding text color, works in both themes without extra CSS), viewBox
  `0 0 24 24`. Looks up `name` in the internal `ICONS` map (Lucide-style path data);
  unknown names render an empty (bodyless) SVG rather than throwing.
- `ICONS` (internal, not exported) — ~35 named icons: `dashboard, inventory, forms,
  messages, users, settings, logout, search, plus, edit, trash, download, upload, history,
  adjust, close, reply, send, inbox, folder, sun, moon, key, building, image, sheet,
  archive, filter, alert, user, note, mail, calendar, bookmark, sparkles, star, check,
  printer, eye, file, idcard`. To add a new icon, add a `name: '<svg path data>'` entry
  here — never use emoji or icon fonts per the project convention (though `doc-editor.js`
  deliberately breaks this convention in its own toolbar, see its doc).
- **`helpIcon(text)`** → a small `?` button (`class="help-icon"`, `data-tip="<text>"`) that
  a self-installing document-level listener (see below) turns into a hover/tap tooltip.
  Returns `''` if `text` is falsy.
- **Tooltip controller** (`initHelpTips`, an IIFE run once at module load) — delegated
  `mouseover`/`mouseout`/`click` listeners on `document` watch for `.help-icon` targets and
  show/hide a single floating `.help-tip` div appended to `document.body` (not nested
  inside whatever scrollable container the icon lives in, so it's never clipped by a
  scrolling modal). Position: centered above the icon, flipped below if it would clip the
  viewport top; horizontally clamped into the viewport. Closes on any outside click or
  `scroll` (capture-phase, since it may live inside a scrolling modal body).

### Misc
- **`emptyState({ icon, title, hint, action })`** → a centered "nothing here" block HTML
  string; `icon` defaults to `'inbox'`, `title` to `'Nothing here yet'`. `action` is raw
  HTML (e.g. a button) inserted as-is (not escaped — caller's responsibility).
- **`fileIconName(filename)`** → picks an icon name from a file extension: images →
  `'image'`, spreadsheets → `'sheet'`, archives → `'archive'`, else `'forms'`.
- **`downloadCsv(filename, headers, rows)`** — builds a CSV string (with a UTF-8 BOM
  prefix `'﻿'` for Excel compatibility), quoting any cell containing `"`, `,`, or a
  newline (doubling internal `"`), joins with CRLF, and triggers a client-side download via
  a temporary `Blob` + object URL + synthetic `<a download>` click (immediately revoked
  after).

## Internal structure
Single IIFE. Module-level mutable state is scoped per concern: `currentDrawer` (drawer
singleton), `ctxState` (context menu singleton), and the tooltip controller's own closure
state (`tip`). No shared "app state" — `UI` is purely presentational/stateless from the
caller's perspective aside from those two singletons enforcing "only one at a time" UX.

## Dependencies
None on other app modules — `ui.js` loads second in `index.html`, right after `api.js` and
before everything else, and has zero references to `API`, `App`, `NAV`, etc. It does expect
`#modal-root`, `#drawer-root` (optional, falls back to `document.body`), and `#toasts` to
exist in the DOM (defined in `index.html`'s shell).

## Used by
Every other frontend file: `app.js`, `tools.js`, `doc-editor.js`, `doc-template.js` (does
not call UI but is invoked by code that does), and all of `public/js/views/*.js`. This is
the single most widely-depended-upon frontend module besides `api.js`.

## Notes / gotchas
- **Prefer the preview-modal + iframe pattern over `printDocument()`'s `window.open()`**
  for any print flow that does async work first (e.g. fetching a template body, building a
  payroll slip HTML). Popup blockers — including strict "always block" browser settings,
  not just gesture-timing heuristics — can silently prevent `window.open()`. An `<iframe>`
  inside an already-open `UI.modal()` can never be popup-blocked because no new
  window/tab is requested. See `printSlips()` in `public/js/views/form-records.js` and the
  "Generate ID" flow in `public/js/views/hr-employees.js` for the reference implementation:
  `UI.modal({ bodyHTML: '<iframe>...' })` then set `frame.srcdoc = UI.printableHtml(html, title)`,
  with a "Print…" confirm button that calls `frame.contentWindow.print()`.
- `fmtDate`/`fmtDateShort` assume the input is a SQLite `DATETIME` string in UTC with a
  space separator (`"YYYY-MM-DD HH:MM:SS"`) — they replace the space with `T` and append
  `Z` before `new Date(...)`. Passing an already-ISO string with a timezone would double up
  incorrectly; only use these on raw DB timestamps.
- The drawer's 180ms removal delay is a magic number tied to the CSS slide-out transition
  in `styles.css` — if that transition duration changes, update this too.
- `emptyState`'s `action` param and `modal`'s `headActionHTML`/`bodyHTML` are all raw,
  un-escaped HTML by design (composability) — callers must `UI.esc()` any dynamic data
  themselves before interpolating it into these strings.
