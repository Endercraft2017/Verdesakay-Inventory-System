/* Production record — read-only dossier for one produced unit or batch, opened from a
   scanned QR label or the QC screen. #/record?unit=<id> | #/record?batch=<id>. */
(function () {
  function dt(s) { return mEsc((s || '').slice(0, 16).replace('T', ' ')); }

  function load(view, params) {
    var qs = params && params.unit ? 'unit=' + encodeURIComponent(params.unit)
      : params && params.batch ? 'batch=' + encodeURIComponent(params.batch) : '';
    if (!qs) { view.innerHTML = '<div class="m-empty">No record selected.</div>'; return; }
    MApp.setTitle('Record');
    view.innerHTML = '<div class="m-hint">Loading…</div>';
    API.get('/production/record?' + qs)
      .then(function (d) { render(view, d); })
      .catch(function (ex) { view.innerHTML = '<div class="m-error">' + mEsc(ex.message || 'Not found') + '</div>'; });
  }

  function render(view, d) {
    view.innerHTML = '';
    var p = d.product || {};
    var jo = d.job_order || {};
    var u = d.unit || null;
    var b = d.batch || null;
    var head = u ? (u.identifier || ('Unit #' + u.id)) : (b.number + (b.identifier ? ' · ' + b.identifier : ''));
    MApp.setTitle(head);

    view.appendChild(mEl(
      '<div class="m-jo-head"><h2>' + mEsc(p.name || jo.product_name || '—') + '</h2>' +
      '<div class="m-jo-meta">' + mEsc(head) + '</div>' +
      (p.variant ? '<div class="m-hint">Variant: ' + mEsc(p.variant) + (p.model ? ' · ' + mEsc(p.model) : '') + '</div>' : '') +
      '</div>'
    ));

    var kv = mEl('<ul class="m-kv"></ul>');
    function row(k, v) { kv.appendChild(mEl('<li><span>' + mEsc(k) + '</span><b>' + v + '</b></li>')); }
    if (u) {
      row('Status', mEsc(u.status) + (u.disposition ? ' (' + mEsc(u.disposition) + ')' : ''));
      row('Location', mEsc(u.location_name || '—'));
      if (u.batch_number) row('Batch', mEsc(u.batch_number));
      if (u.order_number) row('Sales order', mEsc(u.order_number));
    } else {
      row('Batch status', mEsc(b.status));
      row('Quantity', b.qty);
      if (b.created_by_name) row('Created by', mEsc(b.created_by_name));
    }
    row('Built', dt((u || b).created_at));
    if (jo.number) {
      row('Job order', mEsc(jo.number));
      if (jo.team_name) row('Team', mEsc(jo.team_name));
      if (jo.created_by_name) row('Made by', mEsc(jo.created_by_name));
      if (jo.released_by_name) row('Released by', mEsc(jo.released_by_name));
      if (jo.accepted_by_name) row('Accepted by', mEsc(jo.accepted_by_name));
    }
    view.appendChild(kv);

    // QR identifies the immutable unit/batch record, independently of mutable serial text.
    var qrCode = u ? ('VDS:UNIT:' + u.id) : ('VDS:BATCH:' + b.id);
    view.appendChild(mEl(
      '<div class="m-record-qr"><img alt="" src="' + mProductionPrint.qrDataUrl(qrCode) + '" /><div class="m-hint">' + mEsc(qrCode) + '</div></div>'
    ));

    if (u) {
      view.appendChild(mEl('<h3 class="m-h3">Photos</h3>'));
      view.appendChild(mPhoto.thumbs('qc_unit', u.id, { editable: false }));
    }

    if(d.stock) {
      view.appendChild(mEl('<h3 class="m-h3">Same product in stock</h3>'));
      d.stock.forEach(function(s){view.appendChild(mEl('<div class="m-hint">'+(s.build_mode==='semi_built'?'Semi-built':'Fully built / standard')+': '+mEsc(String(s.quantity))+'</div>'));});
    }
    if(b&&d.batch_stock){
      view.appendChild(mEl('<h3 class="m-h3">This batch</h3>'));
      d.batch_stock.forEach(function(s){view.appendChild(mEl('<div class="m-hint">'+mEsc(s.location_name)+': '+s.on_hand+' on hand · '+s.reserved+' reserved · '+s.available+' free</div>'));});
      (d.batch_allocations||[]).forEach(function(a){view.appendChild(mEl('<div class="m-hint">'+mEsc(a.order_number)+': '+a.quantity+' '+mEsc(a.state)+'</div>'));});
      if(!d.batch_stock.length&&b.received_qty>0)view.appendChild(mEl('<div class="m-hint">Older batch stock needs a verified count before exact-batch allocation.</div>'));
      if(MApp.can('inventory.adjust')&&!(d.units&&d.units.length)){
        var counts=mEl('<section class="m-card"><h3>Reconcile batch stock</h3><p class="m-hint">Count the remaining physical batch. This assigns existing stock to the batch; it does not add stock.</p><label>Warehouse<select data-count-location></select></label><label>Quantity<input type="number" min="0" step="any" data-count-qty></label><label>Reason<input data-count-reason maxlength="500"></label><button class="m-btn" data-count-save>Save verified count</button></section>');
        view.appendChild(counts);
        mLocations.load().then(function(){counts.querySelector('[data-count-location]').innerHTML=mLocations.list().filter(function(l){return l.type!=='truck';}).map(function(l){return '<option value="'+l.id+'">'+mEsc(l.name)+'</option>';}).join('');});
        counts.querySelector('[data-count-save]').onclick=function(){
          var qty=counts.querySelector('[data-count-qty]').value,reason=counts.querySelector('[data-count-reason]').value.trim();
          if(qty===''||!Number.isFinite(Number(qty))||Number(qty)<0||reason.length<5){mToast('Enter a counted quantity and a reason of at least five characters.','err');return;}
          var btn=this;btn.disabled=true;
          API.post('/rts/batches/'+b.id+'/count',{location_id:Number(counts.querySelector('[data-count-location]').value),quantity:Number(qty),expected_quantity:((d.batch_stock||[]).find(function(s){return s.location_id===Number(counts.querySelector('[data-count-location]').value);})||{on_hand:0}).on_hand,reason:reason},{idempotencyKey:crypto.randomUUID()}).then(function(result){if(API.syncLocal(result)){mToast('Batch count awaiting authority confirmation');btn.disabled=true;return;}mToast('Batch count saved');load(view,{batch:b.id});}).catch(function(e){mToast(e.message,'err');btn.disabled=false;});
        };
      }
    }

    if(b&&d.units&&d.units.length){
      var inStock=d.units.filter(function(unit){return unit.status==='in_stock';}).length;
      var reserved=d.units.filter(function(unit){return unit.status==='reserved';}).length;
      view.appendChild(mEl('<h3 class="m-h3">Units in this batch</h3><p class="m-hint">'+inStock+' ready to sell · '+reserved+' reserved · '+d.units.length+' produced. Scan each unit sticker when receiving or releasing serialized stock.</p>'));
      d.units.forEach(function(unit){
        var button=mEl('<button class="m-btn m-btn-secondary">'+mEsc(unit.identifier||('Unit #'+unit.id))+' · '+mEsc(unit.status)+'</button>');
        button.onclick=function(){MApp.go('record',{unit:unit.id});};view.appendChild(button);
      });
    }

    // QC/QA
    view.appendChild(mEl('<h3 class="m-h3">QC / QA</h3>'));
    var qc = d.qc || [];
    if (!qc.length) {
      view.appendChild(mEl('<div class="m-hint">No inspection recorded.</div>'));
    } else {
      var ql = mEl('<div class="m-qc-log"></div>');
      qc.forEach(function (q) {
        var fails = (Array.isArray(q.checklist) ? q.checklist : []).filter(function (c) { return c.ok === false; })
          .map(function (c) { return c.label; }).join(', ');
        ql.appendChild(mEl(
          '<div class="m-qc-log-row"><div><b class="m-qc-log-' + (q.result === 'pass' ? 'ok' : 'bad') + '">' +
          (q.result === 'pass' ? 'PASS' : 'FAIL') + '</b>' + (q.stage ? ' · stage ' + q.stage : '') +
          (q.disposition ? ' · ' + mEsc(q.disposition) : '') + '</div>' +
          '<div class="m-qc-log-meta">' + mEsc(q.inspector_name || 'unknown') + ' · ' + dt(q.created_at) + '</div>' +
          (q.remarks ? '<div class="m-qc-log-note">' + mEsc(q.remarks) + '</div>' : '') +
          (fails ? '<div class="m-qc-log-note">Issues: ' + mEsc(fails) + '</div>' : '') + '</div>'
        ));
      });
      view.appendChild(ql);
    }

    // Repairs
    if (d.repairs && d.repairs.length) {
      view.appendChild(mEl('<h3 class="m-h3">Repairs</h3>'));
      var rl = mEl('<ul class="m-list"></ul>');
      d.repairs.forEach(function (r) {
        rl.appendChild(mEl(
          '<li class="m-list-row"><div><b>' + mEsc(r.number) + ' · ' + mEsc(r.kind) + '</b>' +
          '<span>' + mEsc(r.component_name) + ' ×' + r.quantity + (r.fault ? ' · ' + mEsc(r.fault) : '') + '</span></div>' +
          '<div class="m-list-qty">' + mEsc(r.status) + '</div></li>'
        ));
      });
      view.appendChild(rl);
    }

    // Movements
    if (d.movements && d.movements.length) {
      view.appendChild(mEl('<h3 class="m-h3">Stock movements</h3>'));
      var ml = mEl('<ul class="m-kv"></ul>');
      d.movements.slice(0, 15).forEach(function (m) {
        ml.appendChild(mEl('<li><span>' + dt(m.created_at) + ' · ' + mEsc(m.reason || '') + '</span><b>' +
          (m.change > 0 ? '+' : '') + m.change + '</b></li>'));
      });
      view.appendChild(ml);
    }

    var acts = mEl('<div class="m-actions"></div>');
    if (u && ['production.inspect_qc', 'production.inspect_qa', 'production.manage', 'production.record'].some(MApp.can)) {
      var issues = mEl('<button class="m-btn m-btn-secondary">Issues and photos</button>');
      issues.onclick = function () { MApp.go('unit-issues', { unit: u.id, role: MApp.can('production.inspect_qa') ? 'qa' : 'qc' }); }; acts.appendChild(issues);
    }
    if (u || b) {
      var printBtn = mEl('<button class="m-btn">Print label</button>');
      printBtn.onclick = function () { (u ? mProductionPrint.printUnitRecords([d]) : mProductionPrint.printBatchRecord(d)).catch(function (err) { mToast(err.message, 'err'); }); };
      acts.appendChild(printBtn);
    }
    var back = mEl('<button class="m-btn m-btn-secondary">Back</button>');
    back.onclick = function () { history.length > 1 ? history.back() : MApp.go('home'); };
    acts.appendChild(back);
    view.appendChild(acts);
  }

  MApp.route('record', function (view, params) { load(view, params); });
})();
