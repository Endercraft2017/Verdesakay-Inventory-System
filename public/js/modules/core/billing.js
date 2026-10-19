/* Billing (users.manage; docs/SAAS-READINESS.md §12): the invoices we send this workspace, how to
   pay (GCash or bank transfer), and reporting a payment with its receipt (and the BIR 2307 when the
   company withholds EWT). We confirm each payment against our GCash / bank records before the
   invoice shows as paid. Reached from Admin → Billing or the workspace banner. Works while past
   due, and is the only screen of a workspace awaiting its first payment (app.js). */
App.register('billing', async (view) => {
  view.innerHTML = '<div class="empty">Loading…</div>';
  let data;
  try { data = await API.get('/tenant/billing'); } catch (e) {
    view.innerHTML = UI.emptyState({ icon: 'alert', title: 'Could not load billing', hint: e.message });
    return;
  }
  if (!data.enabled) {
    view.innerHTML = `<div class="topbar"><h2>Billing</h2></div>
      ${UI.emptyState({ icon: 'file', title: 'No billing on this installation', hint: 'This copy of the system is not billed per workspace.' })}`;
    return;
  }

  const peso = (n) => '₱' + UI.money(n);
  const STATUS = {
    open: ['status-open', 'Unpaid'],
    payment_submitted: ['status-confirmed', 'Being verified'],
    paid: ['ok', 'Paid'],
    void: ['muted', 'Void'],
  };
  const statusPill = (inv) => inv.overdue
    ? '<span class="badge-pill low">Overdue</span>'
    : `<span class="badge-pill ${STATUS[inv.status][0]}">${STATUS[inv.status][1]}</span>`;
  const PAY_STATUS = { pending: ['status-confirmed', 'Being verified'], confirmed: ['ok', 'Confirmed'], rejected: ['low', 'Not accepted'] };
  // A reported transfer waits for us; the customer reports again only if we send it back (or it fell short).
  const canPay = (inv) => inv.status === 'open';

  render();

  function payOptions() {
    const g = data.gcash;
    const gcash = g ? `
      <div style="flex:1;min-width:220px">
        <div class="muted" style="font-size:12px;text-transform:uppercase;letter-spacing:.04em">GCash</div>
        <div style="font-weight:600">${UI.esc(g.name || '')}</div>
        <div class="mono" style="font-size:16px">${UI.esc(g.number)}</div>
        ${g.has_qr ? '<img id="gcash-qr" alt="GCash QR code" style="margin-top:8px;width:180px;max-width:100%;border-radius:8px;background:#fff" />' : ''}
      </div>` : '';
    const bank = data.bank_details ? `
      <div style="flex:1;min-width:220px">
        <div class="muted" style="font-size:12px;text-transform:uppercase;letter-spacing:.04em">Bank transfer</div>
        <div style="white-space:pre-wrap;font-weight:600">${UI.esc(data.bank_details)}</div>
      </div>` : '';
    return gcash || bank
      ? `<div style="display:flex;gap:24px;flex-wrap:wrap">${gcash}${bank}</div>`
      : '<p class="muted">Payment details are not set yet — contact us for payment instructions.</p>';
  }

  function render() {
    const invs = data.invoices;
    const waiting = data.awaiting_payment
      ? `<div class="card" style="margin-bottom:16px;border-left:4px solid var(--warn,#b8860b)">
          <strong>Your workspace opens once your first payment is confirmed.</strong>
          <div class="muted" style="font-size:13px;margin-top:4px">${invs.length
            ? 'Pay the invoice below, then press <strong>Report payment</strong> and attach your receipt. We usually confirm within the business day.'
            : 'We are preparing your first invoice — it will appear here shortly. You can pay as soon as it does.'}</div>
        </div>` : '';
    view.innerHTML = `
      <div class="topbar"><h2>Billing</h2></div>
      ${waiting}
      <div class="card" style="margin-bottom:16px">
        <h3 style="margin-top:0">How to pay</h3>
        <p class="muted"><a href="${UI.esc((window.VDS_BASE_PATH || '') + '/policies')}">Privacy, terms and refunds (drafts)</a></p>
        ${payOptions()}
        <ol class="muted" style="margin:12px 0 0;padding-left:18px;font-size:13px">
          <li>Send the payment by GCash, InstaPay, PESONet or over the counter, and write the <strong>invoice reference</strong> in the message or note.</li>
          <li>If your company withholds tax (EWT), pay the <strong>“if you withhold”</strong> amount and attach your BIR Form 2307.</li>
          <li>Press <strong>Report payment</strong> with the reference number and a screenshot of the receipt. The invoice shows as paid once we confirm it.</li>
        </ol>
      </div>
      <div id="bill-table">${invs.length ? table(invs) : UI.emptyState({ icon: 'file', title: 'No invoices yet', hint: 'Invoices we send this workspace appear here.' })}</div>`;
    view.querySelectorAll('[data-pay]').forEach((b) => b.onclick = (e) => {
      e.stopPropagation();
      report(invs.find((i) => i.id == b.dataset.pay));
    });
    view.querySelectorAll('tr[data-open]').forEach((tr) => tr.onclick = () => details(invs.find((i) => i.id == tr.dataset.open)));
    const qr = view.querySelector('#gcash-qr');
    if (qr) API.blobUrl('/tenant/billing/gcash-qr').then((url) => { qr.src = url; }).catch(() => qr.remove());
  }

  function table(invs) {
    return `
      <div style="overflow-x:auto">
      <table>
        <thead><tr><th>Reference</th><th>For</th><th>Due</th><th style="text-align:right">Amount</th>
          <th style="text-align:right">If you withhold</th><th style="text-align:right">Balance</th><th>Status</th><th></th></tr></thead>
        <tbody>${invs.map((i) => `
          <tr class="clickable" data-open="${i.id}">
            <td class="mono" style="white-space:nowrap">${UI.esc(i.reference)}</td>
            <td>${UI.esc(i.description)}</td>
            <td style="white-space:nowrap">${UI.esc(i.due_on)}</td>
            <td style="text-align:right">${peso(i.amount)}</td>
            <td style="text-align:right">${peso(i.net_if_withheld)}</td>
            <td style="text-align:right">${i.status === 'void' ? '—' : peso(i.balance)}</td>
            <td>${statusPill(i)}</td>
            <td class="actions">${canPay(i) ? `<button class="btn small" data-pay="${i.id}">Report payment</button>` : ''}</td>
          </tr>`).join('')}
        </tbody>
      </table>
      </div>`;
  }

  async function reload() {
    try { data = await API.get('/tenant/billing'); } catch (e) { UI.toast(e.message, 'error'); return; }
    render();
  }

  function details(inv) {
    const pays = inv.payments.length ? inv.payments.map((p) => `
      <div style="border:1px solid var(--border);border-radius:8px;padding:8px 10px;margin-bottom:8px">
        <div style="display:flex;justify-content:space-between;gap:8px">
          <strong>${peso(p.amount)}</strong>
          <span class="badge-pill ${PAY_STATUS[p.status][0]}">${PAY_STATUS[p.status][1]}</span>
        </div>
        <div class="muted" style="font-size:12.5px">${p.method === 'gcash' ? 'GCash' : p.method === 'bank' ? 'Bank transfer' : 'Recorded by us'} · ref ${UI.esc(p.reference_no || '—')} · paid ${UI.esc(p.paid_on || '—')}</div>
        ${p.review_note ? `<div style="font-size:13px;margin-top:4px">${UI.esc(p.review_note)}</div>` : ''}
        <div style="display:flex;gap:6px;margin-top:6px">
          ${p.has_proof ? `<button class="btn secondary small" data-file="${p.id}" data-kind="proof">Receipt</button>` : ''}
          ${p.has_2307 ? `<button class="btn secondary small" data-file="${p.id}" data-kind="form_2307">2307</button>` : ''}
        </div>
      </div>`).join('') : '<p class="muted">No payment reported yet.</p>';
    const m = UI.modal({
      title: inv.reference,
      cancelText: 'Close',
      confirmText: canPay(inv) ? 'Report payment' : null,
      bodyHTML: `
        <p style="margin-top:0">${UI.esc(inv.description)} ${statusPill(inv)}</p>
        <p class="muted" style="font-size:13px">Issued ${UI.esc(inv.issued_on)} · due ${UI.esc(inv.due_on)}${inv.period_start
          ? ` · covers ${UI.esc(inv.period_start)} – ${UI.esc(inv.period_end || '')}` : ''}${inv.bir_invoice_no ? ` · BIR invoice ${UI.esc(inv.bir_invoice_no)}` : ''}</p>
        <table style="margin-bottom:12px"><tbody>
          <tr><td>Amount</td><td style="text-align:right">${peso(inv.amount)}</td></tr>
          ${inv.vat_rate ? `<tr><td class="muted">includes VAT ${inv.vat_rate}%</td><td class="muted" style="text-align:right">${peso(inv.vat)}</td></tr>` : ''}
          <tr><td class="muted">EWT ${inv.ewt_rate}% you may withhold</td><td class="muted" style="text-align:right">−${peso(inv.ewt)}</td></tr>
          <tr><td>To pay if you withhold</td><td style="text-align:right">${peso(inv.net_if_withheld)}</td></tr>
          <tr><td>Confirmed so far</td><td style="text-align:right">${peso(inv.paid_total)}</td></tr>
          <tr><td><strong>Balance</strong></td><td style="text-align:right"><strong>${inv.status === 'void' ? '—' : peso(inv.balance)}</strong></td></tr>
        </tbody></table>
        ${inv.void_reason ? `<p class="muted">Voided: ${UI.esc(inv.void_reason)}</p>` : ''}
        <h4 style="margin:8px 0">Payments</h4>${pays}`,
      onConfirm: () => { report(inv); return true; },
    });
    m.overlay.querySelectorAll('[data-file]').forEach((b) => b.onclick = async () => {
      try {
        const url = await API.blobUrl(`/tenant/billing/payments/${b.dataset.file}/files/${b.dataset.kind}`);
        window.open(url, '_blank');
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      } catch (e) { UI.toast(e.message, 'error'); }
    });
  }

  function report(inv) {
    const suggested = inv.paid_total > 0 ? inv.balance : inv.net_if_withheld;
    const channels = [data.gcash ? ['gcash', 'GCash'] : null, data.bank_details ? ['bank', 'Bank transfer'] : null].filter(Boolean);
    if (!channels.length) channels.push(['bank', 'Bank transfer'], ['gcash', 'GCash']);
    let attempt = null;
    UI.modal({
      title: `Report payment — ${inv.reference}`,
      confirmText: 'Send for verification',
      bodyHTML: `
        <p class="muted" style="margin-top:0;font-size:13px">Full amount ${peso(inv.amount)} · if you withhold EWT ${peso(inv.net_if_withheld)}${inv.paid_total > 0 ? ` · balance ${peso(inv.balance)}` : ''}</p>
        <div><label>Paid by *</label><select data-f="channel">${channels.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div>
        <div class="field-row">
          <div><label>Reference no. *</label><input data-f="reference_no" placeholder="From the GCash or bank receipt" /></div>
          <div><label>Amount transferred (₱) *</label><input data-f="amount" type="number" min="0" step="0.01" value="${suggested}" /></div>
        </div>
        <div><label>Date paid *</label><input data-f="paid_on" type="date" value="${new Date().toISOString().slice(0, 10)}" /></div>
        <div><label>Receipt screenshot or deposit slip * <span class="muted">(photo or PDF, up to 10 MB)</span></label>
          <input data-f="proof" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" /></div>
        <div><label>BIR Form 2307 <span class="muted">(if you withheld tax)</span></label>
          <input data-f="form_2307" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" /></div>
        <div><label>Note <span class="muted">(optional)</span></label><input data-f="note" /></div>`,
      onConfirm: async (overlay, showErr) => {
        const f = (k) => overlay.querySelector(`[data-f="${k}"]`);
        if (!attempt) {
          const proof = f('proof').files[0];
          if (!f('reference_no').value.trim()) { showErr('Enter the reference number from your receipt.'); return false; }
          if (!proof) { showErr('Attach the receipt screenshot or deposit slip.'); return false; }
          const fd = new FormData();
          fd.append('channel', f('channel').value);
          fd.append('reference_no', f('reference_no').value.trim());
          fd.append('amount', f('amount').value);
          fd.append('paid_on', f('paid_on').value);
          fd.append('note', f('note').value.trim());
          fd.append('proof', proof);
          if (f('form_2307').files[0]) fd.append('form_2307', f('form_2307').files[0]);
          if (!window.crypto?.randomUUID) { showErr('Use a current browser on a secure connection to report payment.'); return false; }
          attempt = { key: window.crypto.randomUUID(), data: fd };
        }
        // Preserve the exact request after an uncertain result; edits need a reviewed new report.
        const fields = overlay.querySelectorAll('input,select');
        fields.forEach(field => { field.disabled = true; });
        try {
          await API.upload(`/tenant/billing/invoices/${inv.id}/payments`, attempt.data, { idempotencyKey: attempt.key });
        } catch (error) {
          if (error.status === 400) {
            attempt = null;
            fields.forEach(field => { field.disabled = false; });
            showErr(error.message);
          } else {
            showErr('Report outcome is unconfirmed. Retry this unchanged report, or check Billing before starting another. ' + error.message);
          }
          return false;
        }
        UI.toast('Sent — we will confirm it against our GCash / bank records.');
        await reload();
        return true;
      },
    });
  }
});
