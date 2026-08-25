# `public/js/doc-template.js`

## Purpose
A tiny, safe Mustache-style template renderer for printable documents: `{{var}}`
interpolation, `{{#items}}...{{/items}}` array loops, and `{{#if cond}}...{{/if}}`
conditionals — all output HTML-escaped, no `eval`. This is the engine that turns a
`doc_templates.body` (or a custom form's field template) plus a render context into the
final printable HTML for orders, HR payroll slips, and the Employee ID Card.

## Exports / Public API

Two globals, plus CommonJS export:
```js
if (typeof module !== 'undefined' && module.exports)
  module.exports = { renderTemplate, ORDER_VARIABLES };
```

- **`renderTemplate(body, context)`** → `string`. Tokenizes, parses, and renders `body`
  (coerced to `''` if `null`/`undefined`) against `context` (defaults to `{}`). This is the
  only function most callers need.
- **`ORDER_VARIABLES`** — the variable catalog shown in the template editor's "Insert
  variable" palette (`doc-editor.js`'s `variableDialog`). An array of `{ group, items:
  [{ token, label }] }` groups: `Company` (`{{company.name}}` etc.), `Order`
  (`{{order.no}}`, `{{order.total}}`, …), `Line items (loop)` (the `{{#items}}...{{/items}}`
  block plus `{{index}}`/`{{name}}`/`{{quantity}}`/etc. fields available inside it), `Meta`
  (`{{user.name}}`, `{{today}}`, and the `{{#if order.notes}}...{{/if}}` conditional
  pattern). This is a **static, curated reference list** for the palette UI — it does not
  drive rendering behavior; `renderTemplate` will happily resolve any dotted path that
  exists on the actual context object, catalog or not.

### Internal (not exported)
- **`escapeDocHtml(s)`** — HTML-escapes `&<>"'` (same character set as `UI.esc`, but
  reimplemented locally so this file has no dependency on `ui.js` and can run standalone
  under Node for tests).
- **`resolvePath(ctx, path)`** — resolves a dotted path (`"order.total"`) against `ctx`,
  short-circuiting to `undefined` on any `null`/`undefined` intermediate. `path === '.'`
  returns `ctx` itself (used for `{{.}}` inside a loop over primitive arrays, though no
  current template uses this).
- **`isTruthy(v)`** — the `{{#if}}`/section truthiness rule: arrays are truthy iff
  non-empty; otherwise falsy for `undefined`, `null`, `false`, `''`, `0`, and the **string**
  `'0'` (this last one matters — a numeric-looking string `"0"` from form data is treated as
  falsy, unlike normal JS truthiness).
- **`tokenizeDoc(tpl)`** — regex-splits the template into `{t:'text'|'var'|'section'|'if'|
  'end', v}` tokens. `{{#name}}` → `section` (or `if` when it starts with `if `, case-
  insensitive, e.g. `{{#if order.notes}}`), `{{/name}}` → `end`, anything else → `var`.
- **`parseDoc(tokens)`** — recursive-descent parser building a tree of `{t:'text'|'var'}`
  leaf nodes and `{t:'section'|'if', v, children}` block nodes. A stray unmatched `{{/...}}`
  is silently ignored (not an error) rather than throwing.
- **`evalInlineFormula(expr, ctx)`** — handles `{{= expr}}` var tokens (an inline formula,
  distinct from the block-level `{{#if}}`): calls `evalFormula` (global in-browser, or
  `require('./doc-formula.js')` under Node) and formats a numeric result via
  `toLocaleString` (2 decimal max) if it's a non-integer number, else stringifies. Any
  thrown error (bad formula syntax, missing ref) is swallowed and rendered as `''`.
- **`renderNodes(nodes, ctx)`** — the actual tree-walking renderer:
  - `text` nodes pass through verbatim (already-HTML, not re-escaped — this is the trusted
    literal HTML the template author wrote).
  - `var` nodes: if the token starts with `=`, delegates to `evalInlineFormula`; otherwise
    resolves the path and HTML-escapes the result (`undefined`/`null` → `''`).
  - `if` nodes render `children` only when `resolvePath(ctx, n.v)` is truthy.
  - `section` nodes: if the resolved value is an **array**, renders `children` once per
    element with a scope of `{ ...ctx, ...item, index: idx + 1 }` (so loop-body variables
    shadow outer-scope ones of the same name, and `{{index}}` is always available,
    1-based); if the value is truthy but not an array, renders `children` once against the
    **unchanged** outer `ctx` (a non-repeating conditional-section shorthand).

## Internal structure
Straight-line pipeline: `renderTemplate` → `tokenizeDoc` → `parseDoc` → `renderNodes`. No
class/closure-heavy state — every function is pure given its inputs (aside from
`evalInlineFormula`'s use of the ambient `evalFormula` global/require).

## Dependencies
- `evalFormula` from `doc-formula.js` — resolved lazily inside `evalInlineFormula` via
  `typeof evalFormula !== 'undefined'` (browser global) or `require('./doc-formula.js')`
  (Node/tests) — the same dual-resolution pattern used by `doc-context.js`.
- Loaded in `index.html` **after** `doc-formula.js` and before `doc-context.js`/
  `doc-editor.js`: `nav-config.js, item-form-config.js, doc-formula.js, doc-template.js,
  doc-context.js, doc-editor.js, hr-payroll-print.js, app.js, ...`.

## Used by
- `public/js/views/orders.js` — `printOrder()` calls `renderTemplate(tplBody, ctx)` (with a
  hand-built `ctx` from its own local `buildContext()`, not `doc-context.js`'s
  `buildDocContext`) and feeds the result to `UI.printDocument()`.
- `public/js/views/templates.js` — template list "Preview" action and the editor's live
  preview both call `renderTemplate(t.body, SAMPLE | previewContext(custom))`; `ORDER_VARIABLES`
  is not directly read here (the editor gets its variable list from the server's `/templates/
  variables/catalog` route plus custom variables — see `buildVarList` in that file), but
  `doc-editor.js`'s formula dialog does reference the general variable-catalog UI pattern
  this file establishes.
- `public/js/hr-payroll-print.js` — `renderSlip()` calls `_renderTemplate()(templateBody,
  buildSlipContext(d))` (resolved the same dual-global/require way) to render each
  individual payroll slip from the "HR Payroll Slip" `doc_templates` row.
- `public/js/doc-editor.js` — does not call `renderTemplate` directly, but its formula
  dialog's live "Result on sample data" preview uses the sibling `evalFormula` the same way
  this file does, and its `sampleContext`/`getVariables` options (passed in by callers like
  `templates.js`) are what a template ultimately renders against.
- `tests/doc-template.test.ts` — exercises `renderTemplate` directly (vars, `{{#items}}`
  loop, `{{#if}}` incl. nested, HTML-escaping, missing-var, and the `ORDER_VARIABLES`
  catalog shape).

## Notes / gotchas
- **No `eval`, ever** — variable resolution is a plain property-path walk; formulas go
  through `doc-formula.js`'s own hand-written recursive-descent parser/evaluator, not
  `eval`/`Function`. This is a deliberate security property since template bodies are
  admin-authored but the *data* rendered into them can include less-trusted values (form
  submissions).
- `isTruthy`'s treatment of the string `'0'` as falsy is a common gotcha if a template
  author expects `{{#if some_numeric_field}}` to behave like a plain JS truthy check on a
  string-typed form value.
- Section-vs-loop dual behavior (`{{#name}}`) is easy to misread: the **same** `{{#x}}...
  {{/x}}` syntax means "loop" when `x` resolves to an array, or "conditionally show once"
  when it resolves to any other truthy value. There's no separate loop-only syntax.
- `renderTemplate`'s output for `text` nodes is never escaped (by design — that's the
  literal template HTML), only `var` node values are escaped. A template body itself is
  trusted (admin-authored, gated by `templates.edit` permission); never allow untrusted
  input to become part of a `doc_templates.body` string.
