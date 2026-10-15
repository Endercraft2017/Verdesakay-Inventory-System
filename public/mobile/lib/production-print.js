/* Shared QR + print-sheet helpers for production unit/batch dossiers — used by record.js
   (print one, from the dossier view) and receiving.js (print a set of selected units from
   the Products In queue). Reuses the exact same editable label template desktop's Finished
   Products "Labels" editor writes (GET /production/label-templates, rendered by
   public/js/doc-template.js's renderTemplate — loaded globally on mobile too, see
   index.html) and the same qr_src/{{code}}/{{sub}} convention as
   public/js/modules/manufacturing/finished-products.js's labelContext(), so a unit printed
   from a phone looks identical to one printed from the desktop. The QR encodes the unit's
   immutable VDS:UNIT:<id> or VDS:BATCH:<id> identity (never a URL) — scanning it anywhere in the app (mobile/lib/scanner.js +
   inventory/lookup) already resolves back to this unit and offers "Open production record",
   same as every other QR/barcode in this app. */
(function () {
  function qrDataUrl(text) {
    var qr = window.qrcode(0, 'M');
    qr.addData(String(text || ''));
    qr.make();
    return qr.createDataURL(6, 0);
  }

  /** Build the label-template context for one unit dossier (a GET /production/record?unit=
      response). `sub` mirrors what the user asked to see on the printed card: the team that
      built it and the date. */
  function unitLabelContext(d) {
    var u = d.unit || {};
    var p = d.product || {};
    var jo = d.job_order || {};
    var code = u.identifier || ('UNIT-' + u.id);
    var subParts = [];
    if (jo.team_name) subParts.push(jo.team_name);
    if (u.created_at) subParts.push(String(u.created_at).slice(0, 10));
    return {
      product: { name: p.name || '', sku: p.sku || '', model: p.model || '', variant: p.variant || '' },
      code: code, sub: subParts.join(' · '), batch: {},
      qr_src: qrDataUrl('VDS:UNIT:' + u.id),
      date: u.created_at ? String(u.created_at).slice(0, 10) : new Date().toISOString().slice(0, 10),
    };
  }

  var SHEET_CSS =
    '*{box-sizing:border-box} body{margin:0;font-family:system-ui,Arial,sans-serif}' +
    '.sheet{display:flex;flex-wrap:wrap;gap:4mm;padding:6mm}' +
    '.lbl{width:52mm;height:30mm;border:1px solid #ddd;border-radius:2mm;display:flex;gap:2mm;padding:2mm;align-items:center;page-break-inside:avoid;overflow:hidden}' +
    '.lbl-qr{width:26mm;height:26mm;flex:none}' +
    '.lbl-txt{overflow:hidden;font-size:9pt;line-height:1.2}' +
    '.lbl-name{font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.lbl-variant{color:#111;font-size:8.5pt}' +
    '.lbl-model,.lbl-sku{color:#555;font-size:8pt}' +
    '.lbl-code{font-family:ui-monospace,Menlo,Consolas,monospace;word-break:break-all;font-size:8pt}' +
    '.lbl-sub{color:#888;font-size:7.5pt}' +
    '@media print{.lbl{border-color:#999}}';

  /* Print once the sheet's QR images have loaded — triggered from here, because a <script>
     inside the written pop-up would be blocked by the Content-Security-Policy it inherits
     (same as UI.printWhenLoaded on desktop). */
  function printWhenLoaded(w) {
    var done = false;
    var go = function () { if (done) return; done = true; try { w.focus(); w.print(); } catch (e) { /* closed */ } };
    if (w.document.readyState === 'complete') setTimeout(go, 50);
    else { w.addEventListener('load', go, { once: true }); setTimeout(go, 1500); }
  }

  function openSheet(title, cells) {
    var w = window.open('', '_blank');
    if (!w) { mToast('Allow pop-ups to open the print sheet', 'err'); return false; }
    w.document.write('<!doctype html><html><head><title>' + mEsc(title) + '</title><style>' + SHEET_CSS + '</style></head>' +
      '<body><div class="sheet">' + cells.join('') + '</div></body></html>');
    w.document.close();
    printWhenLoaded(w);
    return true;
  }

  /** dossiers: one or more GET /production/record?unit= responses — one label per unit,
      using the same editable template as desktop. Returns a Promise<boolean>. */
  function printUnitRecords(dossiers) {
    if (!window.renderTemplate) { mToast('Label renderer failed to load', 'err'); return Promise.resolve(false); }
    return API.get('/production/label-templates').catch(function () { return {}; }).then(function (tpl) {
      var body = tpl.unit || '';
      var cells = dossiers.map(function (d) {
        return '<div class="lbl">' + window.renderTemplate(body, unitLabelContext(d)) + '</div>';
      });
      var ok = openSheet('Unit labels', cells);
      if (ok) mToast(cells.length + ' label' + (cells.length === 1 ? '' : 's') + ' ready');
      return ok;
    });
  }

  function batchLabelContext(d) {
    var b = d.batch, p = d.product || {}, jo = d.job_order || {};
    return {
      product: { name: p.name || jo.product_name || '', sku: p.sku || '', variant: p.variant || '' },
      batch: b, code: b.number, sub: b.identifier || '', qr_src: qrDataUrl('VDS:BATCH:' + b.id),
      date: String(b.created_at || '').slice(0, 10),
    };
  }
  function printBatchRecord(d) {
    if (!window.renderTemplate) return Promise.reject(new Error('Label renderer failed to load'));
    return API.get('/production/label-templates').then(function (tpl) {
      if (!tpl.batch) throw new Error('Batch label template unavailable');
      return openSheet('Batch label', ['<div class="lbl">' + window.renderTemplate(tpl.batch, batchLabelContext(d)) + '</div>']);
    });
  }

  window.mProductionPrint = { qrDataUrl: qrDataUrl, unitLabelContext: unitLabelContext, batchLabelContext: batchLabelContext, printUnitRecords: printUnitRecords, printBatchRecord: printBatchRecord };
})();
