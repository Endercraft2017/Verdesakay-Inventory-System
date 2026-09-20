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
  `order.type` is rendered as `'Job Order'`, `'Purchase Request'`, or `'Sale Order'`
  (default) — see Notes for a fix made here on 2026-08-25. Money fields
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
- **`public/js/modules/core/templates.js`** — `previewContext(custom)` calls the bare global
  `applyVariables(ctx, custom || [])` (guarded by `typeof applyVariables !== 'undefined'`)
  to layer a template's custom variables onto a deep-cloned `SAMPLE` context for the editor's
  live preview and the "Preview" action.
- **`public/js/modules/inventory/orders.js`** *(wired up 2026-08-25 — see Notes)* — `printOrder()` calls
  `buildDocContext({ order, company, user, variables })` to build the real print context for
  Sale/Job/Purchase orders, fetching that order's applicable `doc_variables` from
  `GET /templates/variables?template_id=` first.
- `tests/doc-context.test.ts` — exercises `buildDocContext`/`baseDocContext`/
  `applyVariables` directly via `require()`.

## Notes / gotchas
- **(Fixed 2026-08-25)** `buildDocContext`/`baseDocContext` used to be dead code as far as the
  running app was concerned: `orders.js`'s `printOrder()` built its own equivalent context by
  hand instead of calling this file, and that local version never called `applyVariables`, so
  custom/global template variables (`doc_variables`) never applied to a real printed order —
  only to the template editor's *preview* (via the bare `applyVariables` global). Fixed by
  switching `orders.js` to call `buildDocContext()` here instead of duplicating the logic;
  verified end-to-end against a live server that a global `doc_variables` constant now
  substitutes into a printed Sale Order. As part of the same fix, `baseDocContext`'s
  `order.type` label logic was extended to cover `purchase` → `'Purchase Request'` (it used to
  only distinguish `job` vs. everything-else-is-`'Sale Order'`, which would have silently
  mislabeled Purchase Requests once `orders.js` started calling this function).
- Order money totals are described as "server-authoritative" (per the file's header
  comment) — formulas here are purely *display-derived* re-formatting/aliasing on top of
  values the server already computed; this module never recomputes an order's actual total.
