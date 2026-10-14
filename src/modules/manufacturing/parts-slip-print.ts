/** Printable HTML for the warehouse side of the job-order parts release: the consolidated
 *  pick list (GET /job-orders/pick-list?format=html) and a parts release slip
 *  (GET /parts-slips/:id/print). Standalone pages with their own print styles, rendered on
 *  the server so printing doesn't depend on the desktop UI. The slip itself is a record in
 *  the app (paperless); printing is optional. */
import type { PartsReleaseSlip } from '../../shared/types';

const esc = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const fmtDate = (s: string | null | undefined): string => (s ? esc(s.slice(0, 16).replace('T', ' ')) : '');

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  body { font: 13px/1.45 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color: #111; background: #fff; margin: 24px; }
  h1 { font-size: 20px; margin: 0 0 2px; }
  .sub { color: #555; margin: 0 0 16px; }
  .kv { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 8px 16px; margin: 0 0 16px; }
  .kv b { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #666; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; margin: 0 0 16px; }
  th, td { border: 1px solid #bbb; padding: 6px 8px; text-align: left; vertical-align: top; }
  th { background: #f2f2f2; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
  td.num, th.num { text-align: right; }
  td.box { width: 70px; }
  .muted { color: #666; font-size: 12px; }
  .sign { display: grid; grid-template-columns: 1fr 1fr; gap: 32px; margin-top: 40px; }
  .sign div { border-top: 1px solid #333; padding-top: 4px; font-size: 12px; color: #444; }
  .noprint { margin: 0 0 16px; }
  @media print { body { margin: 10mm; } .noprint { display: none; } }
</style></head>
<body><div class="noprint"><button onclick="window.print()">Print</button></div>${body}</body></html>`;
}

export interface PickListData {
  job_orders: Array<{ id: number; number: string; product_name: string | null; qty_ordered: number;
    source_location_name: string | null; team_name: string | null }>;
  lines: Array<{ component_name: string; sku: string | null; unit: string | null; location_name: string | null;
    need: number; picked: number; on_hand: number; held_elsewhere: number; free_for_list: number;
    job_orders: Array<{ number: string; need: number }> }>;
}

export function pickListHtml(d: PickListData): string {
  const jos = d.job_orders.map((j) =>
    `<tr><td>${esc(j.number)}</td><td>${esc(j.product_name)}</td><td class="num">${j.qty_ordered}</td>` +
    `<td>${esc(j.source_location_name || '—')}</td><td>${esc(j.team_name || '—')}</td></tr>`).join('');
  const lines = d.lines.map((l) =>
    `<tr><td>${esc(l.location_name || '—')}</td><td>${esc(l.component_name)}${l.sku ? `<div class="muted">${esc(l.sku)}</div>` : ''}</td>` +
    `<td class="num">${l.need} ${esc(l.unit || '')}</td><td class="num">${l.on_hand}</td>` +
    `<td class="num">${l.held_elsewhere}</td><td class="num">${l.free_for_list}</td>` +
    `<td>${l.job_orders.map((j) => `${esc(j.number)}: ${j.need}`).join('<br>')}</td><td class="box"></td></tr>`).join('');
  return page('Pick list', `
    <h1>Pick list</h1>
    <p class="sub">${d.job_orders.length} job order${d.job_orders.length === 1 ? '' : 's'} · printed ${esc(new Date().toISOString().slice(0, 16).replace('T', ' '))}</p>
    <table><thead><tr><th>Job order</th><th>Product</th><th class="num">Qty</th><th>Pull from</th><th>Team</th></tr></thead><tbody>${jos}</tbody></table>
    <table><thead><tr><th>Location</th><th>Component</th><th class="num">Pick</th><th class="num">On hand</th><th class="num">Held elsewhere</th><th class="num">Free for this list</th><th>Per job order</th><th>Picked ✓</th></tr></thead>
      <tbody>${lines || '<tr><td colspan="8" class="muted">No components to pick.</td></tr>'}</tbody></table>
    <div class="sign"><div>Picked by</div><div>Checked by</div></div>`);
}

export function partsSlipHtml(slip: PartsReleaseSlip): string {
  const items = (slip.items ?? []).map((it, i) =>
    `<tr><td class="num">${i + 1}</td><td>${esc(it.name)}${it.sku ? `<div class="muted">${esc(it.sku)}</div>` : ''}</td>` +
    `<td class="num">${it.quantity}</td><td>${esc(it.unit || '')}</td></tr>`).join('');
  return page(`Parts release slip ${slip.number}`, `
    <h1>Parts Release Slip — ${esc(slip.number)}</h1>
    <p class="sub">Parts issued from the warehouse to production</p>
    <div class="kv">
      <div><b>Job order</b>${esc(slip.job_order_number)}</div>
      <div><b>Product</b>${esc(slip.product_name)}${slip.qty_ordered != null ? ` × ${slip.qty_ordered}` : ''}</div>
      <div><b>Pulled from</b>${esc(slip.source_location_name || '—')}</div>
      <div><b>Released</b>${fmtDate(slip.released_at)}</div>
      <div><b>Released by</b>${esc(slip.released_by_name || '—')}</div>
      <div><b>Received by</b>${esc(slip.received_by || '—')}</div>
    </div>
    <table><thead><tr><th class="num">#</th><th>Component</th><th class="num">Qty</th><th>Unit</th></tr></thead>
      <tbody>${items || '<tr><td colspan="4" class="muted">No components (product built without a BOM).</td></tr>'}</tbody></table>
    ${slip.notes ? `<p><b>Notes:</b> ${esc(slip.notes)}</p>` : ''}
    <div class="sign"><div>Released by (warehouse)</div><div>Received by (production)</div></div>`);
}
