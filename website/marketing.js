(function () {
  'use strict';
  var ids = ['otom-walkthrough', 'custom-workflow', 'managed-operations', 'referral-partnership'];
  var titles = ['Request an OTOM walkthrough', 'Discuss a workflow with AFK³', 'Discuss managed operations with AFK³', 'Discuss a referral partnership with AFK³'];
  var el = function (id) { return document.getElementById(id); };
  var select = el('c-intent'), note = el('inquiry-context');
  if (!select || !note) return;
  var locked = false, disabledBefore = [];
  var params = new URLSearchParams(location.search);
  var valid = function (value) { return ids.indexOf(value) !== -1; };
  var intent = function () { return valid(select.value) ? select.value : ids[0]; };
  var partner = function () { return intent() === 'referral-partnership'; };
  var individual = function () { return partner() && el('c-individual').checked; };
  function token(key, max) {
    var value = params.get(key) || '';
    return value.length <= max && /^[a-zA-Z0-9_.-]*$/.test(value) ? value : '';
  }
  var sourcePage = token('source_page', 40);
  if (['home', 'products', 'custom-software', 'automation', 'managed-operations', 'partners'].indexOf(sourcePage) === -1) sourcePage = '';
  // URL values are untrusted first-page claims, not commission attribution.
  var source = { entry_path: location.pathname.slice(0, 80), source: token('utm_source', 40), campaign: token('utm_campaign', 40), source_page: sourcePage, claimed_referral: token('ref', 40) };
  function apply() {
    if (locked) return;
    var isPartner = partner(), isIndividual = individual();
    el('contact-title').textContent = titles[ids.indexOf(intent())];
    el('c-individual-wrap').hidden = !isPartner;
    el('c-company-wrap').hidden = isIndividual;
    el('c-company').disabled = isIndividual;
    el('c-company').required = !isIndividual;
    el('c-employees-wrap').hidden = isPartner;
    el('c-employees').disabled = isPartner;
    el('c-modules-fieldset').hidden = isPartner;
    el('c-modules-fieldset').disabled = isPartner;
    el('c-message').placeholder = isPartner ? 'Your relevant client audience, referral experience and questions about the arrangement…' : 'Your current workflow, records, constraints and desired next step…';
    note.textContent = isPartner ? 'Optional referral discussion: no salary or guaranteed income. Rate, eligible sale and payout terms are agreed in writing before a referral is accepted.' : 'We check workflow and product fit before proposing scope, dates or price.';
  }
  function company() { return individual() ? 'Individual referral partner (no company)' : el('c-company').value.trim(); }
  function message(raw) {
    var meta = Object.assign({}, source, { intent: intent(), applicant: individual() ? 'individual-no-company' : (partner() ? 'organisation-partner' : 'buyer') });
    var composed = '[Website context ' + JSON.stringify(meta) + ']\n\n' + raw;
    if (raw.length > 1400 || composed.length > 2000) throw new Error('Please shorten the message so its inquiry context can be retained.');
    return composed;
  }
  function lock() {
    if (locked) return;
    locked = true;
    disabledBefore = [];
    el('contact-form').querySelectorAll('input,select,textarea,fieldset').forEach(function (field) {
      disabledBefore.push([field, field.disabled]); field.disabled = true;
    });
    var status = el('inquiry-retry-note');
    status.hidden = false;
    status.textContent = 'This inquiry is fixed while confirmation is pending. If sending is interrupted, retry here with the same details. Do not start another submission until the result is confirmed.';
  }
  function unlock() {
    disabledBefore.forEach(function (entry) { entry[0].disabled = entry[1]; });
    disabledBefore = []; locked = false;
    el('inquiry-retry-note').hidden = true;
    apply();
  }
  window.AFKInquiry = { intent: intent, partner: partner, individual: individual, company: company, message: message, lock: lock, unlock: unlock, isLocked: function () { return locked; }, apply: apply };
  select.value = valid(params.get('intent')) ? params.get('intent') : ids[0];
  select.addEventListener('change', apply);
  el('c-individual').addEventListener('change', apply);
  document.querySelectorAll('[data-open="contact"]').forEach(function (button) {
    button.addEventListener('click', function () {
      if (!locked && valid(button.dataset.intent)) select.value = button.dataset.intent;
      apply();
    });
  });
  apply();
  var screenButtons = document.querySelectorAll('[data-screen]');
  var panels = document.querySelectorAll('[data-proof]');
  function showScreen(name, animate) {
    panels.forEach(function (panel) {
      var active = panel.dataset.proof === name;
      panel.hidden = !active;
      if (active && animate && panel.animate && !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) {
        panel.animate([{ opacity: 0.65, transform: 'translateY(6px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 220, easing: 'ease-out' });
      }
    });
    screenButtons.forEach(function (button) { button.setAttribute('aria-pressed', String(button.dataset.screen === name)); });
  }
  screenButtons.forEach(function (button) { button.addEventListener('click', function () { showScreen(button.dataset.screen, true); }); });
  if (screenButtons.length && panels.length) showScreen('roster', false);
})();
