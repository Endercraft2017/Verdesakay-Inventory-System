/* Public demo planning and static captures only. No authenticated API access or tracking. */
(function () {
  'use strict';
  var planner = document.querySelector('.demo-planner');
  if (!planner) return;
  var preference = window.matchMedia('(prefers-reduced-motion: reduce)');
  var running = new Set();
  function animate(element, distance, duration) {
    if (preference.matches || !element.animate) return;
    try {
      var animation = element.animate([
        {opacity: 0.7, transform: 'translateY(' + distance + 'px)'},
        {opacity: 1, transform: 'translateY(0)'}
      ], {duration: duration, easing: 'cubic-bezier(.22,1,.36,1)'});
      running.add(animation);
      animation.finished.then(function () { running.delete(animation); }, function () { running.delete(animation); });
    } catch (_) { /* Static content is already visible. */ }
  }
  function stopMotion(event) {
    if (event.matches) { running.forEach(function (animation) { animation.cancel(); }); running.clear(); }
  }
  if (preference.addEventListener) preference.addEventListener('change', stopMotion);
  var controls = planner.querySelector('.review-controls');
  var buttons = Array.from(planner.querySelectorAll('[data-review-step]'));
  var panels = Array.from(planner.querySelectorAll('[data-review-panel]'));
  var selected = 'attendance';
  var briefs = {
    attendance: 'Attendance review for one cutoff, including corrections and review responsibilities.',
    kiosk: 'Kiosk device approval, a sample attendance punch and the resulting record.',
    payroll: 'Draft payslip output and the checks our payroll reviewer needs before a pilot.'
  };
  function select(step, withMotion) {
    if (!briefs[step]) return;
    selected = step;
    buttons.forEach(function (button) { button.setAttribute('aria-pressed', String(button.dataset.reviewStep === step)); });
    panels.forEach(function (panel) {
      panel.hidden = panel.dataset.reviewPanel !== step;
      if (!panel.hidden && withMotion) animate(panel, 6, 220);
    });
  }
  buttons.forEach(function (button) { button.addEventListener('click', function () { select(button.dataset.reviewStep, true); }); });
  function suggestBrief(value) {
    var field = document.getElementById('c-workflow');
    // Never replace a visitor's edited brief when they reopen the dialog.
    if (field && (!field.value || field.dataset.demoSuggested === field.value)) {
      field.value = value; field.dataset.demoSuggested = field.value;
      field.dispatchEvent(new Event('input', {bubbles: true}));
    }
  }
  planner.querySelector('[data-review-inquiry]').addEventListener('click', function () { suggestBrief(briefs[selected]); });
  document.querySelectorAll('[data-operations-brief]').forEach(function (button) {
    button.addEventListener('click', function () { suggestBrief(button.dataset.operationsBrief); });
  });

  // The reusable product-showcase module owns screenshot motion and selection.
  // Its event leaves this page's inquiry wiring separate from the presentation.
  document.querySelectorAll('[data-product-showcase]').forEach(function (tour) {
    var activeBrief = tour.querySelector('[data-tour-screen][aria-pressed="true"]');
    var brief = activeBrief ? activeBrief.dataset.tourBrief : '';
    tour.addEventListener('otom:screenchange', function (event) { brief = event.detail.brief; });
    var inquiry = tour.querySelector('[data-tour-inquiry]');
    if (inquiry) inquiry.addEventListener('click', function () { if (brief) suggestBrief(brief); });
  });
  select(selected, false);
  controls.hidden = false;
  var optional = document.querySelector('.optional-scope');
  if (optional) optional.open = false;
  if ('IntersectionObserver' in window) {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        observer.unobserve(entry.target); animate(entry.target, 14, 420);
      });
    }, {threshold: 0.15});
    document.querySelectorAll('.demo-planner,.fit-section h2,.operations-grid article,.subscription > div').forEach(function (element) { observer.observe(element); });
  }
})();

