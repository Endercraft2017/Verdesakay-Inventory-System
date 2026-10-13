/* Searchable guides and context-sensitive entry points. Never performs a business action. */
(function () {
  const moduleLabels = { home: 'Home & personal tools', forms: 'Documents', documents: 'Documents', messages: 'Messages', account: 'My account', support: 'Support', hr: 'HR', inventory: 'Inventory', manufacturing: 'Production', purchasing: 'Purchasing', accounting: 'Accounting', admin: 'Administration' };
  const workflowModules = { production: 'manufacturing', sales: 'inventory', purchasing: 'purchasing', payroll: 'hr', inventory: 'inventory', accounting: 'accounting', 'qc-repair': 'manufacturing' };
  const access = (route, filter) => !App.canAccessRoute || App.canAccessRoute(route, filter);
  const text = html => { const el = document.createElement('div'); el.innerHTML = html || ''; return el.textContent || ''; };
  function catalog() {
    const workflows = GUIDE.pipelines.filter(p => {
      const module = p.module || workflowModules[p.id];
      if (module && module !== 'home' && App.hasModule && !App.hasModule(module)) return false;
      return !p.steps.some(s => s.to?.route) || p.steps.some(s => s.to?.route && access(s.to.route, s.to.filter));
    }).map(p => ({ ...p, module: p.module || workflowModules[p.id] || 'home', kind: 'workflow' }));
    const features = [], seen = new Set();
    if (typeof NAV !== 'undefined') NAV.forEach(primary => primary.subtabs.forEach(sub => sub.tree.forEach(leaf => {
      if (!leaf.route || leaf.route === 'sop' || !access(leaf.route, leaf.filter)) return;
      const key = leaf.route + ':' + JSON.stringify(leaf.filter || {}); if (seen.has(key)) return; seen.add(key);
      const help = window.Help?.topics.find(t => (t.routes || []).includes(leaf.route));
      features.push({ id: 'feature:' + key, title: leaf.label, module: sub.requiredModule || primary.requiredModule || primary.id, kind: 'feature', icon: leaf.icon || 'help', audience: primary.label + ' · ' + sub.label,
        tagline: help ? text(help.html).trim().slice(0, 170) : `Find and use ${leaf.label} in ${primary.label}.`, intro: help ? help.html : '', route: leaf.route, filter: leaf.filter,
        steps: [{ title: 'Open ' + leaf.label, to: { route: leaf.route, filter: leaf.filter, label: leaf.label }, body: 'Open this screen, then use its Guide button for a walkthrough of the controls available to you.' }], gotchas: [] });
    })));
    const tools=[
      {id:'email',title:'Compose an email',icon:'mail',description:'Open Email, fill in the recipient, subject and message, then review before Send. Sending requires mail.send; mailbox configuration requires administrator access.',spot:'#em-to'},
      {id:'scheduler',title:'Plan a task or reminder',icon:'calendar',description:'Open Scheduler to add a task with a due date. Use Schedule / edit to set a time or reminder; linked notes open directly from their tasks.',spot:'#task-title'},
      {id:'bookmarks',title:'Bookmark useful screens',icon:'bookmark',description:'Save the current screen for quick access. You can also right-click a menu item to bookmark it.',spot:'#bm-add'},
      {id:'bug',title:'Report a problem',icon:'bug',description:'Give a clear title, steps to reproduce, and optional screenshots. Review the report before submitting it.',spot:'#bug-title'},
    ].map(t=>({id:'tool:'+t.id,title:t.title,icon:t.icon,module:'home',kind:'workflow',audience:'Personal tools',tagline:t.description,intro:window.Help?.topics.find(p=>p.id===t.id)?.html||'',steps:[{title:'Open the tool',spot:'[data-tool="'+t.id+'"]',advanceOn:'click',nextSpot:t.spot,body:t.description},{title:'Review the details',spot:t.spot,body:'Use the Guide button in this panel to walk through its controls. Saving, sending and submitting remain your explicit actions.'}],gotchas:[]}));
    return workflows.concat(tools,features);
  }
  function suggestions(items, location, root) {
    const route = location?.route, filter = location?.filter || {};
    const matches = (to) => to?.route === route && Object.entries(to.filter || {}).every(([key,value]) => String(filter[key]) === String(value)) && (Object.keys(to.filter || {}).length > 0 || Object.keys(filter).length === 0);
    const tool = root?.matches('.doc-fs') ? 'document-editing' : root?.querySelector('.fb-editor') ? 'build-form' : root?.querySelector('#note-title') ? 'notes-scheduler' : root?.querySelector('#em-to') ? 'tool:email' : root?.querySelector('#task-title') ? 'tool:scheduler' : root?.querySelector('#bm-add') ? 'tool:bookmarks' : root?.querySelector('#bug-title') ? 'tool:bug' : null;
    const exact = items.filter(p => p.id === tool || (p.kind === 'feature' ? matches(p) : p.steps.some(s => matches(s.to))));
    if (tool) return exact.filter(p => p.id === tool).slice(0, 4);
    const related = GUIDE.forRoute(route);
    const ranked = exact.sort((a,b) => Number(b.kind === 'feature') - Number(a.kind === 'feature') || Number(b.id === related?.id) - Number(a.id === related?.id));
    if (ranked.length) return ranked.slice(0, 4);
    return items.filter(p => p.id === related?.id).slice(0, 4);
  }
  function shortcuts(root) {
    const tips = [{ keys: 'Alt + Shift + G', text: 'Open guides for the current screen or dialog.' }, { keys: 'Tab / Shift + Tab', text: 'Move between controls.' }];
    if (root?.matches('.modal-overlay, .drawer')) tips.push({ keys: 'Escape', text: 'Close help first; otherwise close the dialog or panel. Unsaved changes may require confirmation.' });
    else tips.push({ keys: 'Enter in Search Menu', text: 'Open the first matching screen. Escape closes suggestions.' });
    if (root?.querySelector('#note-item-text')) tips.push({ keys: 'Enter in checklist item', text: 'Add the item without saving the note.' });
    if (root?.querySelector('.doc-fs, .doc-editor') || root?.matches('.doc-fs')) tips.push({ keys: 'Ctrl / Cmd + S, Z, Y', text: 'In the document editor: save, undo, redo.' });
    return tips;
  }
  function shortcutHTML(root) { return `<details class="guide-shortcuts"><summary>Tips & keyboard shortcuts</summary>${shortcuts(root).map(t => `<p><kbd>${UI.esc(t.keys)}</kbd><span>${UI.esc(t.text)}</span></p>`).join('')}<p class="muted">Use the shortcuts listed for this context. Document-editor commands apply inside the editor.</p></details>`; }
  function contextual(root) {
    const route = App.currentLocation?.().route || document.querySelector('#view')?.dataset.route || 'dashboard';
    const isDialog = root?.matches('.modal-overlay, .drawer, .doc-fs');
    const title = isDialog ? (root.querySelector('.modal-head h3, .drawer-head h3, .doc-fs-title')?.textContent || 'This dialog') : (root?.querySelector('.topbar h2, h2')?.textContent || route);
    const steps = [];
    const add = (title, body, target, tip) => { if (target) steps.push({ title, body, target, tip }); };
    if (root?.querySelector('.fb-editor')) {
      add('Name the form', 'Use a recognizable name. The internal ID is generated from it.', root.querySelector('#fb-name'));
      add('Build the fields', 'Add the information people need to provide. Mark essential fields required and keep keys stable for templates.', root.querySelector('#fb-add-field'));
      add('Use advanced settings when needed', 'The form ID, numbering prefix and icon live here. Use the question marks for details.', root.querySelector('.fb-advanced summary'));
      add('Choose optional automation', 'Review what the action does and when it runs. Existing automation is shown when editing.', root.querySelector('.fb-actions summary'));
    } else if (root?.matches('.doc-fs')) {
      add('Name the document', 'Use a clear name so people can find the saved template.', root.querySelector('.doc-fs-name'));
      add('Edit the content', 'Write and format the document. Editing is separate from saving or issuing.', root.querySelector('.doc-surface'), 'Ctrl/Cmd + Z undoes; Ctrl/Cmd + Y redoes inside the editor.');
      add('Preview the output', 'Check real-record data, page breaks and missing fields before saving.', root.querySelector('[data-preview]'));
      add('Save deliberately', 'Save when the content and layout are correct. The guide never presses Save.', root.querySelector('[data-save]'), 'Ctrl/Cmd + S saves in this editor.');
    } else if (root?.querySelector('#note-title')) {
      add('Give the note a clear title', 'A good title helps you find this note and recognize its Scheduler task.', root.querySelector('#note-title'));
      add('Add text or a checklist', 'You can save a note, a checklist, or both.', root.querySelector('#note-body'));
      add('Build a checklist', 'Type an item and press Add item or Enter. Completed items update the linked task.', root.querySelector('#note-item-text'), 'Enter here adds an item; it does not save the note.');
      add('Schedule it if needed', 'Enable scheduling to choose a due time and an optional reminder. Rescheduling keeps one task.', root.querySelector('#note-scheduled'));
    } else {
      const controls = [...(root?.querySelectorAll('input:not([type="hidden"]), select, textarea') || [])].filter(el => !el.disabled && !el.closest('[hidden], .hidden') && !el.closest('details:not([open])')).slice(0, 6);
      controls.forEach(el => {
        const label = el.id ? [...root.querySelectorAll('label')].find(l => l.htmlFor === el.id) : null;
        const name = (label?.textContent || el.getAttribute('aria-label') || el.placeholder || el.title || el.getAttribute('data-f') || 'This field').replace(/\s+/g, ' ').trim();
        add(name, el.type === 'checkbox' ? 'Choose whether this option should apply. Read its help before changing it.' : 'Review this value and enter the information needed for your task. Required fields and validation still apply.', el);
      });
      if (!isDialog) {
        [...(root?.querySelectorAll('.topbar .btn, .panel-head .btn') || [])].filter(el => !el.matches('[data-guide-open]') && !el.closest('[hidden],.hidden') && !el.disabled).slice(0, 5).forEach(el => add(el.textContent.trim(), 'Use this control when it matches the task you want to perform. Opening a dialog does not save or approve it.', el));
      }
    }
    if (isDialog) add('Review before confirming', 'Check the information and warnings first. Confirming, saving, approving, deleting or paying is always your explicit action.', root.querySelector('.modal-foot [data-confirm], .drawer-foot .btn, .doc-btn-save'));
    if (!steps.length) add('Explore this screen', 'Use the task guides and feature reference to find what you need. Search Menu can take you to another screen.', root?.querySelector('h2,h3') || root);
    return { id: 'context:' + route + ':' + title, title, icon: 'help', steps, gotchas: [], context: root };
  }
  function open(options = {}) {
    window.GuideTour?.close();
    const root = options.root || [...document.querySelectorAll('.modal-overlay:not([data-guide-off])')].at(-1) || document.querySelector('.doc-fs') || document.querySelector('.drawer.open') || document.querySelector('#view');
    const route = App.currentLocation?.().route || document.querySelector('#view')?.dataset.route;
    const local = contextual(root);
    const items = suggestions(catalog(), { ...App.currentLocation?.(), route }, root);
    const modal = UI.modal({ title: 'Guides for ' + local.title, size: 'lg', guide: false, protectChanges: false, cancelText: 'Back to my work', bodyHTML: `<div class="guide-context-actions"><button class="btn" id="guide-context-start">${UI.icon('sparkles', 15)} ${GuideTour.savedStep(local.id)>0?'Resume guide for this':'Guide this'} ${root?.matches('.modal-overlay,.drawer,.doc-fs') ? 'dialog' : 'screen'}</button>${GuideTour.savedStep(local.id)>0?'<button class="btn secondary" id="guide-context-restart">Start over</button>':''}<button class="btn secondary" id="guide-center-open">Browse Guide Center</button></div>${shortcutHTML(root)}<label class="sr-only" for="guide-context-search">Search guides for this screen</label><input type="search" id="guide-context-search" placeholder="Search guides for this screen…"><div id="guide-context-results"></div>` });
    const host = modal.overlay.querySelector('#guide-context-results');
    function draw() {
      const q = modal.overlay.querySelector('#guide-context-search').value.toLowerCase().trim();
      const shown = items.filter(p => [p.title,p.tagline,p.audience,...p.steps.map(s=>text((s.body||'')+' '+(s.tip||'')))].join(' ').toLowerCase().includes(q));
      host.innerHTML = shown.map(p => `<button type="button" class="guide-result" data-guide-id="${UI.esc(p.id)}"><span>${UI.icon(p.icon,16)} <strong>${UI.esc(p.title)}</strong></span><small>${UI.esc(moduleLabels[p.module] || p.module)} · ${p.kind === 'workflow' ? p.steps.length + ' steps' : 'Feature reference'}</small><p>${UI.esc(p.tagline)}</p></button>`).join('') || '<p class="empty">No related guides match. Clear your search or browse the Guide Center for other tasks.</p>';
      host.querySelectorAll('[data-guide-id]').forEach(b => b.onclick = () => {
        const p = shown.find(p=>p.id===b.dataset.guideId);
        if (root?.matches('.modal-overlay,.drawer,.doc-fs')) { UI.modal({ title: p.title, guide: false, size: 'lg', cancelText: 'Back to guides', bodyHTML: `<p class="muted">Reference only — your current draft remains open. Start this workflow from the Guide Center after finishing your draft.</p>${p.intro || ''}<ol class="guide-reference-steps">${p.steps.map(s=>`<li><strong>${UI.esc(s.title)}</strong><div>${s.body || ''}</div>${s.tip?`<p class="guide-tip">${s.tip}</p>`:''}</li>`).join('')}</ol>` }); return; }
        modal.close(); if (p.kind === 'feature') App.navigate('sop',{topic:p.id}); else GuideTour.start(p,0);
      });
    }
    modal.overlay.querySelector('#guide-context-search').oninput = draw;
    modal.overlay.querySelector('#guide-context-start').onclick = () => { modal.close(); GuideTour.start(local,GuideTour.savedStep(local.id),{root}); };
    modal.overlay.querySelector('#guide-context-restart')?.addEventListener('click',()=>{modal.close();GuideTour.start(local,0,{root});});
    modal.overlay.querySelector('#guide-center-open').onclick = () => {
      if (root?.matches('.modal-overlay,.drawer,.doc-fs')) { UI.toast('Your draft is still open. Close it before navigating to the Guide Center.', 'info'); return; }
      modal.close(); App.navigate('sop');
    };
    draw();
  }
  function wireHeaders() {
    const view=document.querySelector('#view');
    const headers=[...document.querySelectorAll('.modal-head, .drawer-head, .doc-fs-bar')];
    const screenHeader=view?.querySelector('.topbar');
    if(screenHeader)headers.push(screenHeader);
    else if(view && !view.querySelector('.guide-screen-anchor')) { const anchor=document.createElement('div');anchor.className='guide-screen-anchor';view.prepend(anchor);headers.push(anchor); }
    else if(view)headers.push(view.querySelector('.guide-screen-anchor'));
    headers.forEach(header => {
      if (header.closest('[data-guide-off]') || header.querySelector('[data-guide-open]')) return;
      const button = document.createElement('button'); button.type='button'; button.className='btn secondary small guide-entry'; button.dataset.guideOpen=''; button.innerHTML=UI.icon('help',14)+' Guide'; button.title='Guides and shortcuts (Alt + Shift + G)';
      button.onclick=()=>open({root:header.closest('.modal-overlay,.drawer,.doc-fs') || document.querySelector('#view')});
      const actions=header.querySelector('.modal-head-actions, .doc-fs-bar-actions, .tk-cutoff-actions'); if(actions)actions.prepend(button);else if(header.matches('.drawer-head'))header.insertBefore(button,header.querySelector('[data-close]'));else header.append(button);
    });
  }
  function init() {
    wireHeaders(); const observer = new MutationObserver(wireHeaders); observer.observe(document.body,{childList:true,subtree:true});
    document.addEventListener('keydown',e=>{if(!e.isComposing&&!e.repeat&&e.altKey&&e.shiftKey&&!e.ctrlKey&&!e.metaKey&&e.code==='KeyG'){e.preventDefault();open({root:[...document.querySelectorAll('.modal-overlay:not([data-guide-off])')].at(-1) || document.querySelector('.doc-fs') || document.querySelector('.drawer.open') || document.querySelector('#view')});}});
  }
  window.GuideCenter={catalog,suggestions,open,contextual,shortcutHTML,shortcuts,moduleLabels};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
