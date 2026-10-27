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

  /* These are static, source-rendered local demonstration captures, not an ERP session. */
  var tour = document.querySelector('.product-tour');
  if (tour) {
    var tourControls = tour.querySelector('[data-tour-controls]');
    var tourButtons = Array.from(tour.querySelectorAll('[data-tour-screen]'));
    var tourFigure = tour.querySelector('.tour-figure');
    var tourMedia = tour.querySelector('[data-tour-media]');
    var tourImage = tour.querySelector('img[data-tour-image]');
    var tourStatus = tour.querySelector('[data-tour-status]');
    var tourInquiry = tour.querySelector('[data-tour-inquiry]');
    var activeTour = tourButtons.find(function (button) { return button.getAttribute('aria-pressed') === 'true'; });
    var selectionRequest = 0;
    var tourAnimation = null;
    function selectTour(button, pointerInitiated) {
      if (button === activeTour && tourFigure.getAttribute('aria-busy') !== 'true') return;
      var request = ++selectionRequest;
      if (tourAnimation) { tourAnimation.cancel(); tourAnimation = null; }
      tourFigure.setAttribute('aria-busy', 'true');
      tourInquiry.disabled = true;
      tourStatus.textContent = 'Loading ' + button.textContent.trim() + ' screen…';
      var nextImage = new Image();
      nextImage.onload = function () {
        if (request !== selectionRequest) return;
        tourImage.src = button.dataset.tourImage;
        tourImage.alt = button.dataset.tourAlt;
        tourImage.width = nextImage.naturalWidth || Number(button.dataset.tourWidth);
        tourImage.height = nextImage.naturalHeight || Number(button.dataset.tourHeight);
        tourMedia.dataset.device = button.dataset.tourDevice;
        tourFigure.querySelector('[data-tour-title]').textContent = button.dataset.tourTitle;
        tourFigure.querySelector('[data-tour-description]').textContent = button.dataset.tourDescription;
        tour.querySelector('[data-tour-full]').href = button.dataset.tourImage;
        tourButtons.forEach(function (item) { item.setAttribute('aria-pressed', String(item === button)); });
        activeTour = button;
        tourFigure.setAttribute('aria-busy', 'false');
        tourInquiry.disabled = false;
        tourStatus.textContent = 'Showing ' + button.textContent.trim() + '. Local demonstration with synthetic data.';
        if (pointerInitiated && !preference.matches && tourMedia.animate) {
          try {
            tourAnimation = tourMedia.animate([{opacity: 0.65}, {opacity: 1}], {duration: 220, easing: 'cubic-bezier(.22,1,.36,1)'});
            var animation = tourAnimation;
            running.add(animation);
            animation.finished.then(function () { running.delete(animation); }, function () { running.delete(animation); });
          } catch (_) { /* The selected screenshot is already visible. */ }
        }
      };
      nextImage.onerror = function () {
        if (request !== selectionRequest) return;
        tourFigure.setAttribute('aria-busy', 'false');
        tourInquiry.disabled = false;
        tourStatus.textContent = 'That screen image could not be loaded. The previous view is still shown. Please try again.';
      };
      nextImage.src = button.dataset.tourImage;
    }
    tourButtons.forEach(function (button) {
      button.addEventListener('click', function (event) { selectTour(button, event.detail > 0); });
    });
    tourInquiry.addEventListener('click', function () { if (activeTour) suggestBrief(activeTour.dataset.tourBrief); });
    tourImage.addEventListener('error', function () {
      tourStatus.textContent = 'The screen image could not be loaded. You can still request a guided demo using the contact options below.';
    });
    tourControls.hidden = false;
    tourInquiry.hidden = false;
    tour.querySelector('[data-tour-fallback]').hidden = true;
  }
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

