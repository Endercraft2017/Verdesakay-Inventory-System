/* Guide — a modern, browsable map of every end-to-end pipeline: what the flow is,
   which screen each step lives on (as a real hyperlink), and a "walk me through it"
   button that drives the step-by-step overlay (public/js/guide-tour.js).

   Content is authored in public/js/guide-data.js (window.GUIDE); the fuller written
   manuals for trainers live in docs/guides/. filter.topic deep-links to a pipeline,
   filter.tour=1 auto-starts its walkthrough. */
App.register('sop', (view, filter) => {
  const PIPELINES = window.GuideCenter ? GuideCenter.catalog() : [...((window.GUIDE && GUIDE.pipelines) || [])];
  const topics = (window.Help && Help.topics) || [];
  const moduleForGroup = {HR:'hr', Manufacturing:'production', Inventory:'inventory', Orders:'inventory', Accounting:'accounting', Documents:'documents', Admin:'admin', Basics:'home', Tools:'home'};
  topics.filter(t => !t.routes.length || !App.canAccessRoute || t.routes.some(r => App.canAccessRoute(r))).forEach(t => PIPELINES.push({id:'help:'+t.id, title:t.title, tagline:t.group, module:moduleForGroup[t.group] || 'home', steps:[], gotchas:[], helpTopic:t}));
  const byId = Object.fromEntries(PIPELINES.map(p=>[p.id,p]));

  if (!PIPELINES.length) {
    view.innerHTML = `<div class="empty">Guide content unavailable.</div>`;
    return;
  }

  let active = filter && byId['help:'+filter.helpTopic] ? 'help:'+filter.helpTopic : (filter && filter.topic && byId[filter.topic]) ? filter.topic : (byId['getting-started'] ? 'getting-started' : PIPELINES[0].id);

  view.innerHTML = `
    <div class="topbar">
      <div>
        <h2>Guide Center</h2>
        <div class="sub">Find a task or feature, follow its steps, and learn useful shortcuts.</div>
      </div>
      <div class="grow"></div>
      <button class="btn secondary" id="guide-print">${UI.icon('printer')} Print</button>
    </div>
    <div class="guide-catalog-filters"><label class="sr-only" for="guide-search">Search guides</label><input id="guide-search" type="search" placeholder="What would you like to do? e.g. payroll, leave, checklist…"><label for="guide-module">Module</label><select id="guide-module"><option value="">All available modules</option>${[...new Set(PIPELINES.map(p=>p.module || 'home'))].map(m=>`<option value="${UI.esc(m)}">${UI.esc(window.GuideCenter?.moduleLabels[m]||m)}</option>`).join('')}</select><span id="guide-match-count" aria-live="polite"></span></div>
    <div class="guide-layout">
      <nav class="guide-nav" id="guide-nav">
        ${PIPELINES.map((p) => `
          <button class="guide-nav-item" data-id="${UI.esc(p.id)}">
            <span class="guide-nav-ic">${UI.icon(p.icon || 'help', 17)}</span>
            <span class="guide-nav-txt">
              <span class="guide-nav-title">${UI.esc(p.title)}</span>
              <span class="guide-nav-sub">${UI.esc(p.tagline || '')}</span>
            </span>
          </button>`).join('')}
      </nav>
      <div class="guide-main" id="guide-main"></div>
    </div>`;

  const navEl = view.querySelector('#guide-nav');
  const mainEl = view.querySelector('#guide-main');

  /** Build the URL hash for an in-app screen (same scheme as App.hashFor). */
  function hashFor(to) {
    if (!to || !to.route) return '';
    const keys = to.filter ? Object.keys(to.filter) : [];
    if (!keys.length) return '#' + to.route;
    const qs = keys.map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(to.filter[k])}`).join('&');
    return `#${to.route}?${qs}`;
  }

  function stepLinkHTML(step) {
    if (step.to && step.to.route) {
      if (App.canAccessRoute && !App.canAccessRoute(step.to.route,step.to.filter)) return '<span class="guide-ext">This screen belongs to another role or an unavailable module.</span>';
      return `<a class="guide-jump" href="${hashFor(step.to)}"
        data-route="${step.to.route}" data-filter='${step.to.filter ? UI.esc(JSON.stringify(step.to.filter)) : ''}'>
        ${UI.icon('send', 13)} Open: ${UI.esc(step.to.label || step.to.route)}</a>`;
    }
    if (step.to && step.to.external) {
      return `<span class="guide-ext">${UI.icon('inventory', 13)} ${UI.esc(step.to.label)} <em>(phone app)</em></span>`;
    }
    return '';
  }

  function draw() {
    navEl.querySelectorAll('.guide-nav-item').forEach((b) =>
      b.classList.toggle('active', b.dataset.id === active));

    const p = byId[active];
    if (p.helpTopic) {
      mainEl.innerHTML = `<div class="guide-hero"><h3>${UI.esc(p.title)}</h3><div class="help-content">${p.helpTopic.html}</div></div>${Help.feedbackHTML()}`;
      Help.wireFeedback(mainEl, p.helpTopic);
      mainEl.scrollTop = 0; return;
    }
    const saved = (window.GuideTour && GuideTour.savedStep(p.id)) || 0;
    const canResume = saved > 0 && saved < p.steps.length;

    mainEl.innerHTML = `
      <div class="guide-hero">
        <div class="guide-hero-top">
          <span class="guide-hero-ic">${UI.icon(p.icon || 'help', 22)}</span>
          <div>
            <h3>${UI.esc(p.title)}</h3>
            ${p.audience ? `<div class="guide-hero-aud">${UI.icon('users', 12)} ${UI.esc(p.audience)}</div>` : ''}
          </div>
        </div>
        ${p.intro ? `<p class="guide-hero-intro">${p.intro}</p>` : ''}
        <div class="guide-cta">
          <button class="btn" id="guide-tour-start">${UI.icon('sparkles', 15)} Start step-by-step walkthrough</button>
          ${canResume ? `<button class="btn secondary" id="guide-tour-resume">Resume from step ${saved + 1}</button>` : ''}
          <span class="guide-cta-note">${p.steps.length} steps · open screens explicitly · no business action is automatic</span>
        </div>
      </div>

      <ol class="guide-steps">
        ${p.steps.map((s, idx) => `
          <li class="guide-step">
            <div class="guide-step-num">${idx + 1}</div>
            <div class="guide-step-main">
              <div class="guide-step-head">
                <h4>${UI.esc(s.title)}</h4>
                ${s.role ? `<span class="guide-step-role">${UI.esc(s.role)}</span>` : ''}
              </div>
              <div class="guide-step-body">${s.body || ''}</div>
              ${stepLinkHTML(s)}
              ${s.tip ? `<div class="guide-tip">${UI.icon('sparkles', 13)} <div>${s.tip}</div></div>` : ''}
            </div>
          </li>`).join('')}
      </ol>

      ${p.gotchas && p.gotchas.length ? `
        <div class="guide-watch">
          <div class="guide-watch-head">${UI.icon('alert', 14)} Watch out</div>
          <ul>${p.gotchas.map((g) => `<li>${g}</li>`).join('')}</ul>
        </div>` : ''}

      <p class="muted guide-foot-note">
        The rail <b>Help</b> button (${UI.icon('help', 12)}) has the quick per-screen version;
        Guide buttons in headers provide help for the current screen or dialog.
      </p>`;

    if (window.Help) { mainEl.insertAdjacentHTML('beforeend', Help.feedbackHTML());
    Help.wireFeedback(mainEl, p); }
    mainEl.querySelector('#guide-tour-start').onclick = () => window.GuideTour && GuideTour.start(p, 0);
    const resumeBtn = mainEl.querySelector('#guide-tour-resume');
    if (resumeBtn) resumeBtn.onclick = () => window.GuideTour && GuideTour.start(p, saved);

    mainEl.querySelectorAll('.guide-jump').forEach((a) =>
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const f = a.dataset.filter ? JSON.parse(a.dataset.filter) : undefined;
        App.navigate(a.dataset.route, f);
      }));

    if (window.GuideCenter) mainEl.insertAdjacentHTML('beforeend',GuideCenter.shortcutHTML(document.querySelector('#view')));
    mainEl.scrollTop = 0;
  }

  navEl.querySelectorAll('.guide-nav-item').forEach((b) =>
    b.addEventListener('click', () => { active = b.dataset.id; draw(); }));
  function filterGuides() {
    const q=view.querySelector('#guide-search').value.trim().toLowerCase(), module=view.querySelector('#guide-module').value;let count=0;
    navEl.querySelectorAll('.guide-nav-item').forEach(b=>{const p=byId[b.dataset.id];const el=document.createElement('div');el.innerHTML=[p.id,p.title,p.tagline,p.audience,...p.steps.map(s=>(s.body||'')+' '+(s.tip||''))].join(' ');b.hidden=!!((module && (p.module||'home')!==module) || (q && !el.textContent.toLowerCase().includes(q)));if(!b.hidden)count++;});
    view.querySelector('#guide-match-count').textContent=count+' matching guide'+(count===1?'':'s');
    const first=[...navEl.querySelectorAll('.guide-nav-item')].find(b=>!b.hidden);if(first){if(!navEl.querySelector('.active:not([hidden])') || mainEl.querySelector('.empty-state')){active=first.dataset.id;draw();}}else mainEl.innerHTML=UI.emptyState({icon:'search',title:'No matching guides',hint:'Try a different task name or module.'});
  }
  view.querySelector('#guide-search').oninput=filterGuides;view.querySelector('#guide-module').onchange=filterGuides;
  view.querySelector('#guide-print').onclick = () => window.print();

  const style = document.createElement('style');
  style.textContent = `@media print{
    .topbar,.tool-rail,.rail,.primary-nav,.subnav,.tree,.util-bar,.guide-nav,.guide-cta,.guide-foot-note{display:none!important}
    .guide-layout{display:block!important}
    .guide-step,.guide-watch,.guide-hero{break-inside:avoid}
  }`;
  view.appendChild(style);

  draw(); filterGuides();

  if (filter && filter.tour === '1' && window.GuideTour) {
    setTimeout(() => GuideTour.start(byId[active], 0), 60);
  }
});
