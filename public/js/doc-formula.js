/* ============================================================================
   Safe formula evaluator for document templates (NO eval).
   Grammar (recursive descent):
     expr        := compare
     compare     := additive (('=='|'!='|'<='|'>='|'<'|'>') additive)?
     additive    := multiplicative (('+'|'-') multiplicative)*
     multiplicative := unary (('*'|'/'|'%') unary)*
     unary       := ('-'|'+')? primary
     primary     := number | string | funcCall | ref | '(' expr ')'
     funcCall    := IDENT '(' (expr (',' expr)*)? ')'
     ref         := IDENT ('.' IDENT)*
   Functions: sum, avg, count, min, max, round.
   References resolve dotted paths against a scope; when a path crosses an array
   (e.g. `items.line_total`) it maps the rest over each element → an array, so
   `sum(items.line_total)` works. Numbers tolerate "1,200.00"-style strings.
   Browser global + CommonJS export (for tests).
   ============================================================================ */

function toNumber(v) {
  if (typeof v === 'number') return v;
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = parseFloat(String(v).replace(/,/g, '').replace(/[^0-9.eE+-]/g, ''));
  return isNaN(n) ? 0 : n;
}

function flattenNumbers(v) {
  if (Array.isArray(v)) return v.flatMap(flattenNumbers);
  return [toNumber(v)];
}

function resolveRef(scope, path) {
  const parts = path.split('.');
  let cur = scope;
  for (let i = 0; i < parts.length; i++) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const rest = parts.slice(i).join('.');
      return cur.map((el) => resolveRef(el, rest));
    }
    cur = cur[parts[i]];
  }
  return cur;
}

const FUNCS = {
  money: (value, currency = 'PHP') => {
    if(value == null || value === '') return '';
    if(typeof value === 'boolean' || !Number.isFinite(Number(value)) || Math.abs(Number(value)) > Number.MAX_SAFE_INTEGER / 100) throw new Error('Invalid monetary value');
    if(!/^[A-Z]{3}$/.test(currency)) throw new Error('Use a three-letter currency code');
    return new Intl.NumberFormat('en-US', {style:'currency', currency, currencyDisplay:'code', minimumFractionDigits:2, maximumFractionDigits:2}).format(Number(value));
  },
  sum: (a) => flattenNumbers(a).reduce((s, n) => s + n, 0),
  avg: (a) => { const xs = flattenNumbers(a); return xs.length ? xs.reduce((s, n) => s + n, 0) / xs.length : 0; },
  count: (a) => (Array.isArray(a) ? a.flat(Infinity).length : (a === undefined ? 0 : 1)),
  min: (...a) => Math.min(...a.flatMap(flattenNumbers)),
  max: (...a) => Math.max(...a.flatMap(flattenNumbers)),
  round: (x, n) => { const p = Math.pow(10, toNumber(n) || 0); return Math.round(toNumber(x) * p) / p; },
};

function tokenize(src) {
  const tokens = [];
  const re = /\s*(?:(\d+(?:\.\d+)?)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")|([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)|(==|!=|<=|>=|[-+*/%(),<>]))/g;
  let m;
  let last = 0;
  while ((m = re.exec(src))) {
    if (m.index !== last) break; // unexpected char
    last = re.lastIndex;
    if (m[1] !== undefined) tokens.push({ t: 'num', v: parseFloat(m[1]) });
    else if (m[2] !== undefined) tokens.push({ t: 'str', v: m[2].slice(1, -1).replace(/\\(.)/g, '$1') });
    else if (m[3] !== undefined) tokens.push({ t: 'ident', v: m[3] });
    else tokens.push({ t: 'op', v: m[4] });
  }
  if (last !== src.length && src.slice(last).trim() !== '') {
    throw new Error('Unexpected token in formula near: ' + src.slice(last).trim());
  }
  return tokens;
}

function parse(tokens) {
  let i = 0;
  const peek = () => tokens[i];
  const eat = (v) => {
    const tk = tokens[i];
    if (!tk || (v && !(tk.t === 'op' && tk.v === v))) throw new Error('Expected "' + v + '"');
    i++;
    return tk;
  };

  function parseExpr() { return parseCompare(); }
  function parseCompare() {
    let left = parseAdd();
    const tk = peek();
    if (tk && tk.t === 'op' && ['==', '!=', '<=', '>=', '<', '>'].includes(tk.v)) {
      i++; const right = parseAdd(); return { n: 'cmp', op: tk.v, left, right };
    }
    return left;
  }
  function parseAdd() {
    let left = parseMul();
    while (peek() && peek().t === 'op' && (peek().v === '+' || peek().v === '-')) {
      const op = tokens[i++].v; left = { n: 'bin', op, left, right: parseMul() };
    }
    return left;
  }
  function parseMul() {
    let left = parseUnary();
    while (peek() && peek().t === 'op' && ['*', '/', '%'].includes(peek().v)) {
      const op = tokens[i++].v; left = { n: 'bin', op, left, right: parseUnary() };
    }
    return left;
  }
  function parseUnary() {
    if (peek() && peek().t === 'op' && (peek().v === '-' || peek().v === '+')) {
      const op = tokens[i++].v; return { n: 'unary', op, arg: parseUnary() };
    }
    return parsePrimary();
  }
  function parsePrimary() {
    const tk = peek();
    if (!tk) throw new Error('Unexpected end of formula');
    if (tk.t === 'num') { i++; return { n: 'num', v: tk.v }; }
    if (tk.t === 'str') { i++; return { n: 'str', v: tk.v }; }
    if (tk.t === 'op' && tk.v === '(') { i++; const e = parseExpr(); eat(')'); return e; }
    if (tk.t === 'ident') {
      i++;
      if (peek() && peek().t === 'op' && peek().v === '(') {
        i++; const args = [];
        if (!(peek() && peek().t === 'op' && peek().v === ')')) {
          args.push(parseExpr());
          while (peek() && peek().t === 'op' && peek().v === ',') { i++; args.push(parseExpr()); }
        }
        eat(')');
        return { n: 'call', name: tk.v.toLowerCase(), args };
      }
      return { n: 'ref', path: tk.v };
    }
    throw new Error('Unexpected token: ' + tk.v);
  }

  const tree = parseExpr();
  if (i !== tokens.length) throw new Error('Unexpected trailing tokens in formula');
  return tree;
}

function evalNode(node, scope) {
  switch (node.n) {
    case 'num': return node.v;
    case 'str': return node.v;
    case 'ref': return resolveRef(scope, node.path);
    case 'unary': { const v = toNumber(evalNode(node.arg, scope)); return node.op === '-' ? -v : v; }
    case 'bin': {
      const a = toNumber(evalNode(node.left, scope));
      const b = toNumber(evalNode(node.right, scope));
      switch (node.op) {
        case '+': return a + b; case '-': return a - b; case '*': return a * b;
        case '/': return b === 0 ? 0 : a / b; case '%': return b === 0 ? 0 : a % b;
      }
      return 0;
    }
    case 'cmp': {
      const a = evalNode(node.left, scope); const b = evalNode(node.right, scope);
      const na = toNumber(a); const nb = toNumber(b);
      switch (node.op) {
        case '==': return a == b; case '!=': return a != b;
        case '<': return na < nb; case '>': return na > nb;
        case '<=': return na <= nb; case '>=': return na >= nb;
      }
      return false;
    }
    case 'call': {
      const fn = FUNCS[node.name];
      if (!fn) throw new Error('Unknown function: ' + node.name);
      const args = node.args.map((a) => evalNode(a, scope));
      return fn(...args);
    }
  }
  return undefined;
}

/** Evaluate a formula string against a scope. Throws on parse error. */
function evalFormula(expr, scope) {
  const tree = parse(tokenize(String(expr == null ? '' : expr)));
  return evalNode(tree, scope || {});
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { evalFormula, toNumber };
}
