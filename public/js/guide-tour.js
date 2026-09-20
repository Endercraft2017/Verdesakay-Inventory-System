/* Step-by-step walkthrough overlay for the Guide (public/js/guide-data.js).

   A single floating "coach" card — deliberately NOT a modal, so the app stays
   usable while it walks you through a pipeline. Each step can carry the user to
   the screen it describes (App.navigate) and spotlight an element there.

   Public API:
     GuideTour.start(pipelineId, stepIndex = 0)
     GuideTour.resume(pipelineId)          // start at the last-seen step
     GuideTour.savedStep(pipelineId)       // -> 0-based index, or 0
     GuideTour.close()
*/
(function () {
  const LS_KEY = (id) => `vds_guide_step_${id}`;
  let state = null; // { p, i, coach, onKey, spotEl }

  function savedStep(id) {
    try { return Math.max(0, parseInt(localStorage.getItem(LS_KEY(id)), 10) || 0); }
    catch { return 0; }
  }
  function remember(id, i) {
    try { localStorage.setItem(LS_KEY(id), String(i)); } catch { /* ignore */ }
  }

  function clearSpot() {
    if (state && state.spotEl) {
      state.spotEl.classList.remove('guide-spot');
      state.spotEl = null;
    }
  }

  function spotlight(selector) {
    clearSpot();
    if (!selector) return;
    // The chrome (tree / subnav) re-renders on navigate — wait a frame for it.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!state) return;
        let el = null;
        try { el = document.querySelector(selector); } catch { el = null; }
        if (!el) return;
        el.classList.add('guide-spot');
        state.spotEl = el;
        try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch { /* ignore */ }
      });
    });
  }

  function go(delta) {
    if (!state) return;
    const next = state.i + delta;
    if (next < 0) return;
    if (next >= state.p.steps.length) { close(true); return; }
    state.i = next;
    render();
  }

  function openStepScreen(auto) {
    if (!state) return;
    const step = state.p.steps[state.i];
    const to = step && step.to;
    if (!to || !to.route || typeof App === 'undefined') return;
    try { App.navigate(to.route, to.filter); } catch { /* ignore */ }
    spotlight(step.spot);
    if (!auto) {
      // keep the coach on top after a navigate repaint
      requestAnimationFrame(() => state && state.coach && state.coach.focus({ preventScroll: true }));
    }
  }

  function render() {
    if (!state) return;
    const { p, i } = state;
    const step = p.steps[i];
    const n = p.steps.length;
    const pct = Math.round(((i + 1) / n) * 100);
    remember(p.id, i);

    const hasScreen = step.to && step.to.route;
    const screenLabel = step.to && (step.to.label || step.to.route);
    const isExternal = step.to && step.to.external;

    state.coach.innerHTML = `
      <div class="guide-coach-bar"><span style="width:${pct}%"></span></div>
      <div class="guide-coach-head">
        ${UI.icon(p.icon || 'help', 16)}
        <div class="guide-coach-title">${UI.esc(p.title)}</div>
        <div class="guide-coach-count">Step ${i + 1} of ${n}</div>
        <button type="button" class="icon-btn" data-act="close" aria-label="End walkthrough">${UI.icon('close', 16)}</button>
      </div>
      <div class="guide-coach-body">
        <h4>${UI.esc(step.title)}</h4>
        ${step.role ? `<div class="guide-coach-role">${UI.esc(step.role)}</div>` : ''}
        <div class="guide-coach-text">${step.body || ''}</div>
        ${step.tip ? `<div class="guide-tip">${UI.icon('sparkles', 13)} <div>${step.tip}</div></div>` : ''}
        ${isExternal ? `<div class="guide-coach-ext">${UI.icon('inventory', 13)} ${UI.esc(step.to.label)} — open this on the phone app.</div>` : ''}
      </div>
      <div class="guide-coach-foot">
        <button type="button" class="btn secondary small" data-act="back" ${i === 0 ? 'disabled' : ''}>${UI.icon('arrow-left', 14)} Back</button>
        <div class="grow"></div>
        ${hasScreen ? `<button type="button" class="btn secondary small" data-act="open" title="${UI.esc(screenLabel)}">Open screen ${UI.icon('send', 13)}</button>` : ''}
        <button type="button" class="btn small" data-act="next">${i + 1 >= n ? 'Finish' : 'Next'} ${UI.icon(i + 1 >= n ? 'check' : 'send', 14)}</button>
      </div>`;

    state.coach.querySelector('[data-act="close"]').onclick = () => close(true);
    state.coach.querySelector('[data-act="back"]').onclick = () => go(-1);
    state.coach.querySelector('[data-act="next"]').onclick = () => go(1);
    const openBtn = state.coach.querySelector('[data-act="open"]');
    if (openBtn) openBtn.onclick = () => openStepScreen(false);

    // Auto-follow: if this step lives on a screen, take the user there.
    if (hasScreen) openStepScreen(true);
    else clearSpot();
  }

  function close(userEnded) {
    if (!state) return;
    clearSpot();
    document.removeEventListener('keydown', state.onKey);
    const { coach, p, i } = state;
    coach.classList.remove('open');
    setTimeout(() => coach.remove(), 180);
    if (userEnded && i + 1 >= p.steps.length) {
      try { localStorage.removeItem(LS_KEY(p.id)); } catch { /* ignore */ }
      UI.toast(`Walkthrough complete — ${p.title}`, 'success');
    }
    state = null;
  }

  function start(pipelineId, stepIndex) {
    if (typeof GUIDE === 'undefined') return;
    const p = GUIDE.byId[pipelineId];
    if (!p) return;
    if (state) close(false);
    // Drop any coach still mid fade-out from a previous tour so it can't be clicked.
    document.querySelectorAll('.guide-coach').forEach((el) => el.remove());
    document.querySelectorAll('.guide-spot').forEach((el) => el.classList.remove('guide-spot'));

    const coach = document.createElement('section');
    coach.className = 'guide-coach';
    coach.setAttribute('tabindex', '-1');
    coach.setAttribute('role', 'dialog');
    coach.setAttribute('aria-label', `${p.title} walkthrough`);
    document.body.appendChild(coach);

    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(true); return; }
      // Don't hijack arrow keys while the user is typing in a field mid-walkthrough.
      const tag = (e.target && e.target.tagName) || '';
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || (e.target && e.target.isContentEditable)) return;
      if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'ArrowLeft') go(-1);
    };
    document.addEventListener('keydown', onKey);

    const startAt = Math.min(Math.max(0, stepIndex || 0), p.steps.length - 1);
    state = { p, i: startAt, coach, onKey, spotEl: null };
    requestAnimationFrame(() => coach.classList.add('open'));
    render();
  }

  window.GuideTour = {
    start,
    resume: (id) => start(id, savedStep(id)),
    savedStep,
    close: () => close(false),
  };
})();
