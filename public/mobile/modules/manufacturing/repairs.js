/* Repairs — the warehouse queue for parts a rework unit needs. Accept issues the
   replacement from a location (and books the removed part into damage for a 'replace');
   reject needs a reason. #/repairs */
(function () {
  function list(view) {
    MApp.setTitle('Repairs');
    view.innerHTML = '<div class="m-hint">Loading…</div>';
    Promise.all([API.get('/production/repairs?status=requested'), mLocations.load()])
      .then(function (r) { render(view, r[0] || []); })
      .catch(function (ex) { view.innerHTML = '<div class="m-error">' + mEsc(ex.message) + '</div>'; });
  }

  function render(view, rows) {
    view.innerHTML = '';
    if (!rows.length) {
      view.appendChild(mEl('<div class="m-empty">No open parts requests.</div>'));
      view.appendChild(mEl('<div class="m-hint">Requests land here when a QA/QC inspector fails a unit for repair and asks for parts.</div>'));
      return;
    }
    rows.forEach(function (r) {
      var card = mEl(
        '<div class="m-panel" style="margin-bottom:10px">' +
        '<div><b>' + mEsc(r.number) + '</b> · ' + mEsc(r.kind === 'replace' ? 'Replace' : 'Add') +
        (r.kind === 'replace' ? (r.return_to_damage ? ' <span class="m-hint">(old → damage)</span>' : ' <span class="m-hint">(old discarded)</span>') : '') + '</div>' +
        '<div class="m-hint">' + mEsc(r.component_name) + ' ×' + r.quantity +
        (r.fault ? ' · fault: ' + mEsc(r.fault) : '') + '</div>' +
        '<div class="m-hint">' + mEsc(r.job_order_number || '') + ' · unit #' + r.unit_id +
        (r.unit_identifier ? ' (' + mEsc(r.unit_identifier) + ')' : '') +
        ' · by ' + mEsc(r.requested_by_name || '—') + '</div>' +
        (r.notes ? '<div class="m-hint">Note: ' + mEsc(r.notes) + '</div>' : '') +
        '</div>'
      );
      var locF = mLocations.select({ label: 'Issue from' });
      card.appendChild(locF.el);
      var rem = mEl('<label class="m-field"><span class="m-label">Remarks</span><input class="m-input" data-rem placeholder="e.g. handed over 3 pcs" /></label>');
      card.appendChild(rem);
      var acts = mEl('<div class="m-actions"></div>');
      var ok = mEl('<button class="m-btn">Accept & issue</button>');
      var no = mEl('<button class="m-btn m-btn-warn">Reject</button>');
      ok.onclick = function () {
        ok.disabled = true;
        mSubmit('/production/repairs/' + r.id + '/accept',
          { from_location_id: locF.value(), warehouse_remarks: (rem.querySelector('[data-rem]').value || '').trim() || null },
          { label: 'Accept ' + r.number })
          .then(function (res) { mToast(res && res.queued ? 'Queued (offline)' : 'Part issued'); list(view); })
          .catch(function (ex) { mToast(ex.message || 'Failed', 'err'); ok.disabled = false; });
      };
      no.onclick = function () {
        var reason = (rem.querySelector('[data-rem]').value || '').trim();
        if (!reason) { mToast('Add a reason to reject', 'err'); return; }
        no.disabled = true;
        mSubmit('/production/repairs/' + r.id + '/reject', { warehouse_remarks: reason }, { label: 'Reject ' + r.number })
          .then(function () { mToast('Rejected'); list(view); })
          .catch(function (ex) { mToast(ex.message || 'Failed', 'err'); no.disabled = false; });
      };
      acts.appendChild(ok); acts.appendChild(no);
      card.appendChild(acts);
      view.appendChild(card);
    });
  }

  MApp.route('repairs', function (view) { list(view); });
})();
