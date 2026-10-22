/* ============================================================================
   Builds the render context for a document from an order + company + user, then
   layers the variable registry on top:
     1. base context (company / order / items / user / today) with money formatted
     2. FIELD variables  → alias a catalog path to a friendly key
     3. CONSTANT variables → fixed values (typed)
     4. FORMULA variables → evaluated with doc-formula, iteratively (cycle-guarded)
   Shared by order printing and the template editor preview so they always match.
   Order money totals stay server-authoritative; formulas are display-derived.
   Browser global + CommonJS export (for tests).
   ============================================================================ */

function _evalFormula() {
  if (typeof evalFormula !== 'undefined') return evalFormula; // browser global
  return require('./doc-formula.js').evalFormula; // node/tests
}
function _toNumber(v) {
  if (typeof toNumber !== 'undefined') return toNumber(v);
  return require('./doc-formula.js').toNumber(v);
}

function _money(n) {
  return Number(_toNumber(n)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function _resolve(scope, path) {
  const parts = String(path).split('.');
  let cur = scope;
  for (let i = 0; i < parts.length; i++) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) {
      const rest = parts.slice(i).join('.');
      return cur.map((el) => _resolve(el, rest));
    }
    cur = cur[parts[i]];
  }
  return cur;
}

function _format(value, dataType) {
  if (value === undefined || value === null) return '';
  switch (dataType) {
    case 'currency': return _money(value);
    case 'number': { const n = _toNumber(value); return Number.isInteger(n) ? String(n) : String(Math.round(n * 10000) / 10000); }
    default: return String(value);
  }
}

function baseDocContext(order, company, user) {
  order = order || {};
  const items = (order.items || []).map((it) => ({
    name: order.type === 'sale' && it.fulfillment_mode === 'semi_built' ? `${it.name} (Semi-built)`
      : order.type === 'sale' && it.fulfillment_mode === 'ckd' ? `${it.name} (CKD)`
        : it.name,
    fulfillment_label: it.fulfillment_mode === 'semi_built' ? 'Semi-built'
      : it.fulfillment_mode === 'ckd' ? 'CKD'
        : it.fulfillment_mode === 'ckd_component' ? 'CKD part' : 'Fully built / standard',
    sku: it.sku || '', description: it.description || '',
    quantity: it.quantity, unit: it.unit || '',
    unit_price: _money(it.unit_price), line_total: _money(it.line_total),
  }));
  let today = '';
  try { today = new Date().toLocaleDateString(); } catch { today = ''; }
  return {
    company: company || {},
    order: {
      no: order.number || '',
      type: order.type === 'job' ? 'Job Order' : order.type === 'purchase' ? 'Supplier Purchase Order' : 'Sale Order',
      date: order.order_date || '', status: order.status || '',
      customer_name: order.customer_name || '', customer_contact: order.customer_contact || '',
      notes: order.notes || '', currency: order.currency || 'PHP',
      subtotal: _money(order.subtotal), tax_percent: order.tax_percent || 0,
      tax_amount: _money(order.tax_amount), total: _money(order.total),
    },
    items,
    user: { name: (user && user.full_name) || '' },
    today,
  };
}

/** Layer the variable registry (field aliases, constants, formulas) onto a context. */
function applyVariables(ctx, variables) {
  const vars = Array.isArray(variables) ? variables : [];
  vars.filter((v) => v.source_type === 'field' && v.field_path).forEach((v) => {
    ctx[v.key] = _format(_resolve(ctx, v.field_path), v.data_type);
  });
  vars.filter((v) => v.source_type === 'constant').forEach((v) => {
    ctx[v.key] = (v.data_type === 'number') ? _toNumber(v.value) : _format(v.value, v.data_type);
  });
  const formulas = vars.filter((v) => v.source_type === 'formula' && v.formula);
  const ev = _evalFormula();
  for (let pass = 0; pass <= formulas.length; pass++) {
    let changed = false;
    for (const v of formulas) {
      try {
        const next = _format(ev(v.formula, ctx), v.data_type);
        if (ctx[v.key] !== next) { ctx[v.key] = next; changed = true; }
      } catch { /* dependency not ready this pass */ }
    }
    if (!changed) break;
  }
  return ctx;
}

/** opts = { order, company, user, variables } → render context object. */
function buildDocContext(opts) {
  opts = opts || {};
  const ctx = baseDocContext(opts.order, opts.company, opts.user);
  return applyVariables(ctx, opts.variables);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildDocContext, baseDocContext, applyVariables };
}
