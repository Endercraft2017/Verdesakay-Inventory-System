# `public/js/doc-context.js`

## Purpose
Builds the render context for a printable document from an order + company + user, then
layers a variable registry (field aliases, constants, formulas) on top. Intended as the
shared context-building logic so order printing and the template editor's live preview
always agree on shape — see **Notes** below for how far that intent currently reaches in
practice.

## Exports / Public API

Three globals, plus CommonJS export:
```js
if (typeof module !== 'undefined' && module.exports)
  module.exports = { buildDocContext, baseDocContext, applyVariables };
```

- **`baseDocContext(order, company, user)`** → the "raw" context object:
  `{ company, order: {no, type, date, status, customer_name, customer_contact, notes,
  currency, subtotal, tax_percent, tax_amount, total}, items: [...], user: {name}, today }`.
  `order.type` is rendered as `'Job Order'` or `'Sale Order'` (only distinguishes those two
  — a `purchase` order also gets `'Sale Order'` here, unlike `views/orders.js`'s own local
  `buildContext`, which correctly labels `'Purchase Request'`; see Notes). Money fields
  (`subtotal`, `tax_amount`, `total`, each item's `unit_price`/`line_total`) are formatted
  via the internal `_money()` (2-decimal, thousands-separated). `today` is
  `new Date().toLocaleDateString()`, wrapped in try/catch (empty string on failure).
- **`applyVariables(ctx, variables)`** → mutates and returns `ctx` with a variable registry
  layered on top, in three passes:
  1. **`field`**-sourced variables (`v.source_type === 'field'`): `ctx[v.key] =
     _format(_resolve(ctx, v.field_path), v.data_type)` — aliases an existing context path
     to a friendlier key, with type-aware formatting.
  2. **`constant`**-sourced variables: `ctx[v.key]` set directly from `v.value`, coerced by
     `v.data_type` (`number` → `_toNumber`, else `_format`).
  3. **`formula`**-sourced variables: evaluated via `evalFormula(v.formula, ctx)`
     (`doc-formula.js`), formatted by `v.data_type`. Run in **iterative passes**
     (`pass <= formulas.length`), re-evaluating every formula each pass and stopping early
     once a full pass produces no changes — this lets one formula variable reference another
     formula variable regardless of definition order, up to `formulas.length` levels of
     dependency depth, with a thrown error on any pass treated as "not ready yet" (silently
     skipped, not fatal) rather than a hard failure.
- **`buildDocContext(opts)`** → `opts = { order, company, user, variables }`. Convenience
  one-shot: `applyVariables(baseDocContext(opts.order, opts.company, opts.user),
  opts.variables)`.

### Internal (not exported)
- **`_evalFormula()`** / **`_toNumber(v)`** — the dual browser-global/`require` resolution
  pattern (same as `doc-template.js`'s `evalInlineFormula`), pulling `evalFormula`/
  `toNumber` from `doc-formula.js`.
- **`_money(n)`** — `Number(_toNumber(n)).toLocaleString('en-US', {minimumFractionDigits:
  2, maximumFractionDigits: 2})`.
- **`_resolve(scope, path)`** — like `doc-template.js`'s `resolvePath`, but **array-aware
  mid-path**: if a path segment lands on an array, the *rest* of the path is mapped over
  every element (`cur.map(el => _resolve(el, rest))`), producing an array of resolved
  values — e.g. `items.line_total` on a context whose `items` is an array yields an array
  of each item's `line_total`, which is exactly the shape `doc-formula.js`'s `sum()`/`avg()`
  functions expect via their own `flattenNumbers`.
- **`_format(value, dataType)`** — `dataType` ∈ `'currency'` (→ `_money`), `'number'` (→
  integer as-is, else rounded to 4 decimals as a plain string), or default (→ `String(value)`).
  Returns `''` for `null`/`undefined` regardless of `dataType`.

## Internal structure
No classes, no persistent module state — every exported function is a pure transform over
its arguments (aside from `applyVariables` mutating the `ctx` object it's given in place,
which callers rely on: it also returns `ctx` for chaining).

## Dependencies
`evalFormula`/`toNumber` from `doc-formula.js` (dual-resolved). Loaded in `index.html`
after `doc-template.js` and before `doc-editor.js`.

## Used by
- **`public/js/views/templates.js`** — the *only* browser call site. `previewContext(custom)`
  calls the bare global `applyVariables(ctx, custom || [])` (guarded by
  `typeof applyVariables !== 'undefined'`) to layer a template's custom variables onto a
  deep-cloned `SAMPLE` context for the editor's live preview and the "Preview" action.
  `buildDocContext`/`baseDocContext` are **not called from any browser view** — see Notes.
- `tests/doc-context.test.ts` — exercises `buildDocContext`/`baseDocContext`/
  `applyVariables` directly via `require()`.

## Notes / gotchas
- **`buildDocContext`/`baseDocContext` are effectively unused in the running app today.**
  `public/js/views/orders.js`'s `printOrder()` builds its own equivalent context by hand
  (a local `buildContext(order, company, me)` function) rather than calling
  `buildDocContext()` from this file — and that local version also does **not** call
  `applyVariables`, so custom/global template variables are never layered onto a printed
  order's context, only onto the *template editor's preview*. Only `applyVariables` (the
  bare global) is actually wired into a live UI flow, via `views/templates.js`. If you're
  asked to make custom variables apply to real order printing, `orders.js`'s
  `buildContext`/`printOrder` is the code to change (either call `buildDocContext` there
  instead of duplicating the logic, or add an `applyVariables` call).
- `baseDocContext`'s `order.type` label logic (`job` → `'Job Order'`, everything else →
  `'Sale Order'`) does **not** special-case `purchase` orders the way `orders.js`'s own
  `buildContext` does (`'Purchase Request'`) — a discrepancy to be aware of if this file's
  `baseDocContext` is ever wired into the purchase-order print path.
- Order money totals are described as "server-authoritative" (per the file's header
  comment) — formulas here are purely *display-derived* re-formatting/aliasing on top of
  values the server already computed; this module never recomputes an order's actual total.
