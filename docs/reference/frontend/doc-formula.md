# `public/js/doc-formula.js`

## Purpose
A safe (no `eval`/`Function`) formula evaluator for document templates and template
variables: a hand-written tokenizer + recursive-descent parser + tree evaluator for a small
expression grammar with references into a data scope, arithmetic, comparisons, and a
handful of aggregate functions.

## Exports / Public API

Two globals, plus CommonJS export:
```js
if (typeof module !== 'undefined' && module.exports) module.exports = { evalFormula, toNumber };
```

- **`evalFormula(expr, scope)`** → evaluates a formula string against `scope` (an object;
  defaults to `{}`). Throws (`Error`) on any tokenize/parse error (unexpected character,
  unmatched paren, unknown function, trailing tokens, etc.) — callers (`doc-template.js`'s
  `evalInlineFormula`, `doc-context.js`'s `applyVariables`, `doc-editor.js`'s formula
  dialog) are expected to catch. Returns whatever the expression evaluates to: a number, a
  string, an array (if a reference crosses into an array field without being reduced by a
  function), or a boolean (comparison result).
- **`toNumber(v)`** → coerces any value to a number for arithmetic: `number` passes through;
  `null`/`undefined`/`''` → `0`; `boolean` → `1`/`0`; strings are stripped of commas and any
  character not in `[0-9.eE+-]` before `parseFloat`, with `NaN` results forced to `0`. This
  means `toNumber("1,200.00")` → `1200`, and `toNumber("₱1,200.00")` also → `1200` (currency
  symbols are stripped along with everything else non-numeric).

### Grammar (documented in the file header comment)
```
expr        := compare
compare     := additive (('=='|'!='|'<='|'>='|'<'|'>') additive)?
additive    := multiplicative (('+'|'-') multiplicative)*
multiplicative := unary (('*'|'/'|'%') unary)*
unary       := ('-'|'+')? primary
primary     := number | string | funcCall | ref | '(' expr ')'
funcCall    := IDENT '(' (expr (',' expr)*)? ')'
ref         := IDENT ('.' IDENT)*
```
Comparisons don't chain (`a < b < c` is not valid — `compare` allows at most one comparison
operator at the top level, everything below it is pure arithmetic).

### Built-in functions (`FUNCS`, internal)
- **`sum(a)`** — `flattenNumbers(a).reduce((s,n)=>s+n, 0)`.
- **`avg(a)`** — mean of `flattenNumbers(a)`, `0` if empty.
- **`count(a)`** — `a.flat(Infinity).length` if `a` is an array, else `1` (or `0` if `a` is
  `undefined`) — so `count(items)` counts line items, tolerating nested arrays.
- **`min(...a)` / `max(...a)`** — variadic; each argument is flattened+numberized first, so
  `min(items.line_total)` (one array arg) and `min(a, b, c)` (several scalar args) both work.
- **`round(x, n)`** — rounds `x` to `n` decimal places (`n` defaults to `0` via `toNumber`).

### Internal machinery (not exported)
- **`flattenNumbers(v)`** — recursively flattens nested arrays and coerces every leaf via
  `toNumber`. This is what lets `sum(items.line_total)` work when `_resolve`/`resolveRef`
  has turned a dotted path crossing an array into an array of values.
- **`resolveRef(scope, path)`** — dotted-path resolution, **array-aware mid-path** exactly
  like `doc-context.js`'s `_resolve`: hitting an array partway through the path maps the
  remaining path over every element, returning an array. This is the mechanism that makes
  `items.line_total` mean "the `line_total` of every item" rather than requiring an
  explicit loop construct in the formula language itself.
- **`tokenize(src)`** — single regex-driven scanner (`num`, `str` — single or double
  quoted with backslash escapes, `ident` — supports dotted identifiers like
  `order.subtotal` as **one token**, and `op` — `==`, `!=`, `<=`, `>=`, or a single char
  from `-+*/%(),<>`). Throws `Unexpected token in formula near: ...` if the regex can't
  make forward progress from the current position (an unrecognized character) or if
  trailing non-whitespace remains after the last match.
- **`parse(tokens)`** — classic recursive-descent (`parseExpr → parseCompare → parseAdd →
  parseMul → parseUnary → parsePrimary`), building a small AST of node kinds `num`, `str`,
  `ref` (`{path}`), `unary` (`{op, arg}`), `bin` (`{op, left, right}`), `cmp` (`{op, left,
  right}`), `call` (`{name, args}` — function name is lower-cased). Throws on unexpected
  tokens, missing closing parens, or trailing tokens after a complete expression.
- **`evalNode(node, scope)`** — tree-walking evaluator. Arithmetic operators (`bin`,
  `unary`) coerce both sides via `toNumber` first (so `"5" - "2"` works, and division/modulo
  by zero returns `0` instead of `Infinity`/`NaN`). Comparison (`cmp`) uses loose `==`/`!=`
  on the **raw** evaluated values for equality but numeric coercion (`toNumber`) for
  `<`/`>`/`<=`/`>=`. `call` looks up the function in `FUNCS`, throwing `Unknown function:
  <name>` if not found.

## Internal structure
Straight-line: `evalFormula` → `tokenize` → `parse` → `evalNode`. Every piece is a pure
function; no module-level mutable state. This is the lowest layer of the three `doc-*`
formula/template files (`doc-formula.js` has no dependency on either of the other two).

## Dependencies
None — pure, self-contained. Loaded in `index.html` right after `item-form-config.js` and
before `doc-template.js`.

## Used by
- **`public/js/doc-template.js`** — `evalInlineFormula` calls `evalFormula` for `{{= expr}}`
  inline-formula var tokens.
- **`public/js/doc-context.js`** — `_evalFormula()`/`_toNumber()` resolve to this module's
  `evalFormula`/`toNumber`; used by `applyVariables`'s formula-variable pass.
- **`public/js/doc-editor.js`** — the formula-builder dialog (`formulaDialog`) calls the
  bare global `evalFormula` directly for its live "Result on sample data" preview, and the
  Excel-style `=` cell trigger opens that same dialog.
- `tests/doc-formula.test.ts` — exercises `evalFormula`/`toNumber` directly.

## Notes / gotchas
- **No `eval`/`Function` constructor anywhere** — this is a deliberate security boundary
  since formula strings can originate from less-trusted admin input (template authors) but
  are evaluated against data that may include end-user-submitted form values.
- `toNumber`'s aggressive stripping (`replace(/[^0-9.eE+-]/g, '')`) means it will silently
  extract a number from almost any string, including ones that look like garbage —
  `toNumber("abc123def")` → `123`, not `0` or an error. This is intentional (tolerating
  currency-symbol-prefixed, comma-grouped numbers from real-world data) but means malformed
  numeric-ish input won't be caught here.
- Dotted identifiers are tokenized as **one** `ident` token (the regex
  `[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*` matches the whole dotted path greedily) — you cannot
  write `a . b` with spaces around the dot; it must be written `a.b`.
- `resolveRef`'s array-crossing behavior means a formula like `sum(items.line_total *
  1.1)` is **not** valid syntax (you can't apply an operator across a resolved array
  inline) — the arithmetic operators (`bin`) call `toNumber` on their operands, which on an
  array input falls through to `toNumber`'s string coercion path and effectively yields `0`
  or garbage. Multiply-then-sum patterns must be expressed as a formula *variable* whose
  per-row math happens in the template's row cells (via a formula cell/`fxcell`), with the
  grand-total formula only summing the already-computed column.
