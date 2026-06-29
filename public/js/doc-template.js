/* ============================================================================
   Tiny, safe Mustache-style template renderer for printable documents.
   Supports:
     {{path.with.dots}}          → HTML-escaped value
     {{#items}} … {{/items}}     → repeat block per array element (item fields in scope,
                                    plus {{index}} = 1-based position)
     {{#if path}} … {{/if}}      → render block only when the value is truthy
   No eval; all interpolated values are HTML-escaped. The template body itself is
   admin-authored (trusted). Browser global + CommonJS export (for tests).
   ============================================================================ */

/** Variable catalog shown in the template editor's "Insert variable" palette. */
const ORDER_VARIABLES = [
  {
    group: 'Company', items: [
      { token: '{{company.name}}', label: 'Company name' },
      { token: '{{company.address}}', label: 'Company address' },
      { token: '{{company.phone}}', label: 'Company phone' },
      { token: '{{company.email}}', label: 'Company email' },
    ],
  },
  {
    group: 'Order', items: [
      { token: '{{order.no}}', label: 'Order number' },
      { token: '{{order.type}}', label: 'Order type' },
      { token: '{{order.date}}', label: 'Order date' },
      { token: '{{order.status}}', label: 'Status' },
      { token: '{{order.customer_name}}', label: 'Customer name' },
      { token: '{{order.customer_contact}}', label: 'Customer contact' },
      { token: '{{order.notes}}', label: 'Notes' },
      { token: '{{order.currency}}', label: 'Currency' },
      { token: '{{order.subtotal}}', label: 'Subtotal' },
      { token: '{{order.tax_percent}}', label: 'Tax %' },
      { token: '{{order.tax_amount}}', label: 'Tax amount' },
      { token: '{{order.total}}', label: 'Total' },
    ],
  },
  {
    group: 'Line items (loop)', items: [
      { token: '{{#items}} … {{/items}}', label: 'Repeat per line item' },
      { token: '{{index}}', label: 'Row number' },
      { token: '{{name}}', label: 'Item name' },
      { token: '{{sku}}', label: 'SKU' },
      { token: '{{description}}', label: 'Description' },
      { token: '{{quantity}}', label: 'Quantity' },
      { token: '{{unit}}', label: 'Unit' },
      { token: '{{unit_price}}', label: 'Unit price' },
      { token: '{{line_total}}', label: 'Line total' },
    ],
  },
  {
    group: 'Meta', items: [
      { token: '{{user.name}}', label: 'Prepared by' },
      { token: '{{today}}', label: "Today's date" },
      { token: '{{#if order.notes}} … {{/if}}', label: 'Show block only if value set' },
    ],
  },
];

function escapeDocHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function resolvePath(ctx, path) {
  if (path === '.') return ctx;
  let cur = ctx;
  for (const key of path.split('.')) {
    if (cur == null) return undefined;
    cur = cur[key];
  }
  return cur;
}

function isTruthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0 && v !== '0';
}

function tokenizeDoc(tpl) {
  const re = /\{\{\s*([#/][^}]+|[^}]+?)\s*\}\}/g;
  const tokens = [];
  let last = 0;
  let m;
  while ((m = re.exec(tpl))) {
    if (m.index > last) tokens.push({ t: 'text', v: tpl.slice(last, m.index) });
    const raw = m[1].trim();
    if (raw[0] === '#') {
      const inner = raw.slice(1).trim();
      if (inner.toLowerCase().startsWith('if ')) tokens.push({ t: 'if', v: inner.slice(3).trim() });
      else tokens.push({ t: 'section', v: inner });
    } else if (raw[0] === '/') {
      tokens.push({ t: 'end', v: raw.slice(1).trim() });
    } else {
      tokens.push({ t: 'var', v: raw });
    }
    last = re.lastIndex;
  }
  if (last < tpl.length) tokens.push({ t: 'text', v: tpl.slice(last) });
  return tokens;
}

function parseDoc(tokens) {
  let i = 0;
  function walk(endName) {
    const nodes = [];
    while (i < tokens.length) {
      const tk = tokens[i++];
      if (tk.t === 'end') {
        if (endName) return nodes; // close current block
        continue; // stray close — ignore
      }
      if (tk.t === 'section') nodes.push({ t: 'section', v: tk.v, children: walk(tk.v) });
      else if (tk.t === 'if') nodes.push({ t: 'if', v: tk.v, children: walk('if') });
      else nodes.push(tk);
    }
    return nodes;
  }
  return walk(null);
}

function renderNodes(nodes, ctx) {
  let out = '';
  for (const n of nodes) {
    if (n.t === 'text') out += n.v;
    else if (n.t === 'var') {
      const v = resolvePath(ctx, n.v);
      out += v === undefined || v === null ? '' : escapeDocHtml(v);
    } else if (n.t === 'if') {
      if (isTruthy(resolvePath(ctx, n.v))) out += renderNodes(n.children, ctx);
    } else if (n.t === 'section') {
      const val = resolvePath(ctx, n.v);
      if (Array.isArray(val)) {
        val.forEach((item, idx) => {
          out += renderNodes(n.children, { ...ctx, ...item, index: idx + 1 });
        });
      } else if (isTruthy(val)) {
        out += renderNodes(n.children, ctx);
      }
    }
  }
  return out;
}

function renderTemplate(body, context) {
  return renderNodes(parseDoc(tokenizeDoc(String(body == null ? '' : body))), context || {});
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { renderTemplate, ORDER_VARIABLES };
}
