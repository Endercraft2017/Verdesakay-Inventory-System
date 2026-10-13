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
        steps: [{ title: 'Open ' + leaf.label, to: { route: leaf.route, filter: leaf.filter, label: leaf.label }, body: help ? text(help.html).trim().slice(0, 450) : `Open ${primary.label} → ${sub.label} → ${leaf.label}. The walkthrough on that screen explains the available controls.` }], gotchas: [] });
    })));
    const tools=[
      {id:'email',title:'Compose an email',icon:'mail',description:'Open Email, fill in the recipient, subject and message, then review before Send. Sending requires email access; only administrators can configure the outbound mailbox.',spot:'#em-to'},
      {id:'scheduler',title:'Plan a task or reminder',icon:'calendar',description:'Open Tasks & reminders to add a task with a due date. Use Schedule / edit to set a time or reminder; linked notes open directly from their tasks.',spot:'#task-title'},
      {id:'bookmarks',title:'Bookmark useful screens',icon:'bookmark',description:'Save the current screen for quick access. You can also right-click a menu item to bookmark it.',spot:'#bm-add'},
      {id:'bug',title:'Report a problem',icon:'bug',description:'Give a clear title, steps to reproduce, and optional screenshots. Review the report before submitting it.',spot:'#bug-title'},
    ].map(t=>({id:'tool:'+t.id,title:t.title,icon:t.icon,module:'home',kind:'workflow',audience:'Personal tools',tagline:t.description,intro:window.Help?.topics.find(p=>p.id===t.id)?.html||'',steps:[{title:'Open the tool',spot:'[data-tool="'+t.id+'"]',advanceOn:'click',nextSpot:t.spot,body:t.description},...({email:['#em-to','#em-subj','#em-body','#em-send'],scheduler:['#task-title','#task-date','#task-list'],bookmarks:['#bm-add','#bm-list'],bug:['#bug-title','#bug-steps','#bug-desc','#bug-shots-input','#bug-submit']}[t.id] || [t.spot]).map(spot=>{const row=window.GuideInstructions?.find(row=>row[0]===spot);return {title:row?.[1] || t.title,spot,body:row?.[2] || t.description};})],gotchas:[]}));
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
    const tips = [{ keys: 'Alt + Shift + G', text: 'Start the highlighted walkthrough for this screen or dialog.' }, { keys: 'Tab / Shift + Tab', text: 'Move between controls.' }];
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
    const available = target => { if(!target || target.disabled || target.closest('[hidden], .hidden, details:not([open])')) return false; for(let el=target;el;el=el.parentElement) { if(el.style.display==='none' || el.style.visibility==='hidden') return false; if(el===root) break; } return true; };
    const add = (title, body, target, tip) => { if (available(target)) { const token = target.id || 'guide-control-' + Math.random().toString(36).slice(2); target.dataset.guideTarget = token; steps.push({ title, body, target, spot: target.id && /^[a-zA-Z][\w-]*$/.test(target.id) ? '#' + target.id : '[data-guide-target="' + token + '"]', tip }); } };
    if (!isDialog && route === 'hr-employees') {
      [
        ['#emp-search','Find an employee','Type part of an employee’s name to narrow the employee list. Clear the search to show everyone again.'],
        ['#emp-dept-filter','Filter by department','Select a department to show its employees. Choose All departments to remove this filter.'],
        ['#emp-status-filter','Filter by employment status','Select the employment status you want to review. This filters the list; it does not change anyone’s status.'],
        ['#emp-table','Open an employee record','Use the pencil on an employee’s row to edit their record, or the view button if you have read-only access. The ID-card button opens an ID preview.'],
        ['#emp-new','Add an employee','Press New Employee, fill in Employee No. and Full name, then review Basic Info, Pay & Schedule, Payroll Rules, and Leave & Records before saving.'],
        ['#emp-import','Import employees from CSV','Press Import and download the sample CSV. Include employee_no and name; existing employees are matched by employee_no, so check numbers before importing. Departments must already exist.'],
        ['#emp-no-settings','Set the employee numbering format','Press this gear to configure the suggested employee number: prefix, increasing number or hire-date numbering, and zero-padding. Review the preview and press Save. Individual employee numbers remain editable.'],
      ].forEach(([selector,name,body])=>add(name,body,root.querySelector(selector)));
    } else if (isDialog && root.querySelector('#emp-no-preview')) {
      [
        ['[data-p="prefix"]','Choose a prefix','Enter the letters that should precede suggested employee numbers, such as EMP. Leave this blank if you do not want a prefix.'],
        ['[data-p="mode"]','Choose the numbering method','Select Increasing number for a sequence, or Based on hire date to use the employee’s start date.'],
        ['[data-p="pad"]','Set the number of digits','Enter how many digits to use, from 1 to 8. Short numbers are padded with leading zeroes.'],
        ['[data-p="date_format"]','Choose the hire-date format','When using hire-date numbering, choose YYYYMMDD or YYMMDD. Check the preview to confirm the date appears as intended.'],
        ['#emp-no-preview','Check the example','Review the suggested-number preview before saving. This policy changes suggestions, not existing employee numbers.'],
        ['#emp-no-save','Save the numbering policy','Press Save to apply this format to future suggested employee numbers.'],
      ].forEach(([selector,name,body])=>add(name,body,root.querySelector(selector)));
    } else if (isDialog && root.querySelector('[data-formtab="basic"]')) {
      [
        ['[data-f="employee_no"]','Enter the employee number','Use a unique employee number. Keep existing numbers stable because CSV imports match employees by this number.'],
        ['[data-f="name"]','Enter the full name','Enter the employee’s full name as it should appear in HR records and payroll.'],
        ['[data-formtab="basic"]','Complete Basic Info','Review department, position, employment status and start date. Link a login account here if the employee needs access to their own HR requests.'],
        ['[data-formtab="pay"]','Review Pay & Schedule','Open this tab to review the daily or monthly rate, default shift and rest days. For an existing employee, use Change rate to record a pay change.'],
        ['[data-formtab="rules"]','Review Payroll Rules','Open this tab and review the employee’s payroll settings before generating payslips.'],
        ['[data-formtab="leave"]','Review Leave & Records','Open this tab to review leave balances, documents and issued assets. Adjust balance records additions or deductions with a reason.'],
      ].forEach(([selector,name,body])=>add(name,body,root.querySelector(selector)));
    } else if (!isDialog && route === 'form-records' && App.currentLocation?.().filter?.slug === 'hr_payroll') {
      add('Find an employee’s payslips', 'Search by employee name to narrow the payslips shown.', root.querySelector('#fr-search'));
      add('Filter by status', 'Show the payroll status you need to review. Filtering does not change any payslip.', root.querySelector('#fr-status'));
      add('Choose the payroll period', 'Select a cutoff to focus your review on its payslips and totals.', root.querySelector('#fr-period'));
      add('Review the cutoff', 'Expand the cutoff and open a payslip to check its earnings, deductions and net pay.', root.querySelector('[data-bundle-toggle]') || root.querySelector('#fr-table'));
      add('Print a payroll summary', 'Preview totals and department subtotals for the payslips currently in view before printing.', root.querySelector('#fr-print-summary'));
      add('Export the filtered payroll', 'Download Excel exports the payslips currently in view. Check your filters first.', root.querySelector('#fr-download-csv'));
    } else if (root?.querySelector('.fb-editor')) {
      add('Name the form', 'Enter the name employees will see, such as Leave Request. The internal form ID is generated from this name.', root.querySelector('#fb-name'));
      add('Build the fields', 'Press Add field. Enter its label and key, choose its type and mark it required if reviewers need it. Include a Reason field for requests. Saved field keys are used by print templates.', root.querySelector('#fb-add-field'));
      add('Use advanced settings when needed', 'Expand Advanced settings to review the internal form ID, record-number prefix and icon. Keep an existing form ID stable so links continue to work.', root.querySelector('.fb-advanced summary'));
      add('Choose optional automation', 'Expand Automated actions and press Add action if a saved or approved record should trigger a follow-up. Choose its action type and trigger, then check the recipient and message before creating the form.', root.querySelector('.fb-actions summary'));
    } else if (root?.matches('.doc-fs')) {
      add('Name the document', 'Enter a recognizable template name, such as Employee payslip. Check its associated form before saving.', root.querySelector('.doc-fs-name'));
      add('Edit the content', 'Click the document canvas to write. Select text before applying formatting; insert form fields where record values should appear.', root.querySelector('.doc-surface'), 'Ctrl/Cmd + Z undoes; Ctrl/Cmd + Y redoes inside the editor.');
      add('Preview the output', 'Press Preview and choose a record. Inspect the filled values and page breaks, then return to the editor to correct any missing or misplaced information.', root.querySelector('[data-preview]'));
      add('Save deliberately', 'Press Save to store the template content and layout after reviewing the preview. Saving the template does not issue a business record.', root.querySelector('[data-save]'), 'Ctrl/Cmd + S saves in this editor.');
    } else if (root?.querySelector('#note-title')) {
      add('Give the note a clear title', 'Enter a short action-oriented title, such as Review October payroll. The linked Tasks & reminders task uses this title.', root.querySelector('#note-title'));
      add('Add text or a checklist', 'Write the details or context you need to remember. Add checklist items below if the work has several steps; a checklist can also be saved without body text.', root.querySelector('#note-body'));
      add('Build a checklist', 'Type one action, then press Add item or Enter. Repeat for each step. Check items as you finish them; completing the checklist completes its linked task.', root.querySelector('#note-item-text'), 'Enter here adds an item; it does not save the note.');
      add('Schedule it if needed', 'Check Schedule this note to reveal Due date and time and Remind me. Enter the deadline and optional reminder, then Save. Editing the schedule updates the existing linked task.', root.querySelector('#note-scheduled'));
      add('Choose the deadline', 'Use Today, Tomorrow or Pick date, then check the due date and time shown.',root.querySelector('#note-due'));
      add('Choose a reminder', 'Select a reminder relative to the deadline, or Custom date and time. Relative choices update while editing this schedule. Review the reminder date before saving.',root.querySelector('.personal-reminder-choice select'));
    } else {
      const covered = new Set();
      (window.GuideInstructions || []).forEach(([selector,name,body]) => { const target = root?.querySelector(selector); if(available(target)) { add(name, body, target); covered.add(target); } });
      const controls = [...(root?.querySelectorAll('input:not([type="hidden"]), select, textarea') || [])].filter(el => !covered.has(el) && available(el)).slice(0, 6);
      controls.forEach(el => {
        let label = (el.id ? [...root.querySelectorAll('label')].find(l => l.htmlFor === el.id) : null); if(!label) { for(let parent=el.parentElement; parent && parent!==root; parent=parent.parentElement) { const candidate=parent.querySelector('label'); if(candidate) { label=candidate; break; } } }
        const name = (label?.textContent || el.getAttribute('aria-label') || el.placeholder || el.title || el.getAttribute('data-f') || 'Field').replace(/_/g, ' ').replace(/\s+/g, ' ').replace(/\s*\*$/, '').trim();
        if(name === 'Field') return;
        const help = el.getAttribute('data-guide-help') || el.getAttribute('aria-description') || el.title; const described = (el.getAttribute('aria-describedby') || '').split(/\s+/).map(id=>document.getElementById(id)?.textContent || '').join(' ').trim(); const instruction = help || described || (el.type === 'search' || (!isDialog && /search/i.test(name)) ? 'Type a search term to narrow ' + title + '. Clear the search to show the list again.' : el.tagName === 'SELECT' ? (isDialog ? 'Select ' + name + ' for this record. Review the selection before saving.' : 'Select ' + name + ' to change which results are shown or how they are arranged.') : el.type === 'checkbox' ? 'Check ' + name + ' to enable this option; uncheck it to disable it.' : el.type === 'file' ? 'Choose the file to upload. Check its filename and contents before confirming.' : 'Enter ' + name + (el.required ? '. This field is required before saving.' : '.')); add(name, UI.esc(instruction), el);
      });
      if (!isDialog) {
        [...(root?.querySelectorAll('.topbar .btn, .panel-head .btn') || [])].filter(el => !covered.has(el) && !el.matches('[data-guide-open]') && available(el)).slice(0, 5).forEach(el => { const name = el.getAttribute('aria-label') || el.title || el.textContent.trim(); const help = el.getAttribute('data-guide-help') || el.getAttribute('aria-description') || el.title; if(name && help) add(name, UI.esc(help), el); });
      }
    }
    if (isDialog) { const confirm = root.querySelector('.modal-foot [data-confirm]'); if(confirm) { const action = confirm.textContent.trim(); add(action, 'Check the information above, then press ' + UI.esc(action) + ' when ready. If validation shows an error, correct the highlighted field and try again. Exit the walkthrough or use the dialog’s Cancel/Close action to leave without confirming.', confirm); } }
    if (!steps.length) { const help = window.Help?.topics.find(t => (t.routes || []).includes(route)); const summary = help ? text(help.html).trim().slice(0, 450) : root?.querySelector('.empty, .tool-note')?.textContent?.trim(); add(title, UI.esc(summary || 'No editable controls are available in this view right now. Check the screen’s loading or access message before proceeding.'), root?.querySelector('.panel, h2, h3') || root); }
    const brief=steps.filter((_,i)=>i===0 || i===Math.floor(steps.length/2) || i===steps.length-1);
    return { id: 'context:' + route + ':' + title, title, icon: 'help', steps, variants:steps.length>3?{detailed:steps,brief}:null,gotchas: [], context: root };
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
      const shown = items.filter(p => [p.id,p.title,p.tagline,p.audience,...p.steps.map(s=>text((s.body||'')+' '+(s.tip||'')))].join(' ').toLowerCase().includes(q));
      host.innerHTML = shown.map(p => `<button type="button" class="guide-result" data-guide-id="${UI.esc(p.id)}"><span>${UI.icon(p.icon,16)} <strong>${UI.esc(p.title)}</strong></span><small>${UI.esc(moduleLabels[p.module] || p.module)} · ${p.kind === 'workflow' ? p.steps.length + ' steps' : 'Feature reference'}</small><p>${UI.esc(p.tagline)}</p></button>`).join('') || '<p class="empty">No related guides match. Clear your search or browse the Guide Center for other tasks.</p>';
      host.querySelectorAll('[data-guide-id]').forEach(b => b.onclick = () => {
        const p = shown.find(p=>p.id===b.dataset.guideId);
        if (root?.matches('.modal-overlay,.drawer,.doc-fs')) { UI.modal({ title: p.title, guide: false, size: 'lg', cancelText: 'Back to guides', bodyHTML: `<p class="muted">Reference only — your current draft remains open. Start this workflow from the Guide Center after finishing your draft.</p>${p.intro || ''}<ol class="guide-reference-steps">${p.steps.map(s=>`<li><strong>${UI.esc(s.title)}</strong><div>${s.body || ''}</div>${s.tip?`<p class="guide-tip">${s.tip}</p>`:''}</li>`).join('')}</ol>` }); return; }
        modal.close(); if (p.kind === 'feature') start({root}); else GuideTour.start(p,0);
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
  function start(options = {}) {
    const root = options.root || [...document.querySelectorAll('.modal-overlay:not([data-guide-off])')].at(-1) || document.querySelector('.doc-fs') || document.querySelector('.drawer.open') || document.querySelector('#view');
    const guide = contextual(root);
    GuideTour.start(guide, GuideTour.savedStep(guide.id), {root});
  }
  function wireHeaders() {
    const view=document.querySelector('#view');
    const headers=[...document.querySelectorAll('.modal-head, .drawer-head, .doc-fs-bar')];
    const screenHeader=view?.querySelector('.topbar, [data-page-header]');
    if(screenHeader){view.querySelector('.guide-screen-anchor')?.remove();headers.push(screenHeader);}
    else if(view && !view.querySelector('.guide-screen-anchor')) { const anchor=document.createElement('div');anchor.className='guide-screen-anchor';view.prepend(anchor);headers.push(anchor); }
    else if(view)headers.push(view.querySelector('.guide-screen-anchor'));
    headers.forEach(header => {
      if (header.closest('[data-guide-off]') || header.querySelector('[data-guide-open], [data-help]')) return;
      const button = document.createElement('button'); button.type='button'; button.className='btn secondary small guide-entry'; button.dataset.guideOpen=''; button.innerHTML=UI.icon('help',14)+' Guide'; button.title='Guides and shortcuts (Alt + Shift + G)';
      button.onclick=()=>start({root:header.closest('.modal-overlay,.drawer,.doc-fs') || document.querySelector('#view')});
      const actions=header.querySelector('.modal-head-actions, .doc-fs-bar-actions, .tk-cutoff-actions, [data-page-actions]'); if(actions)actions.prepend(button);else if(header.matches('.drawer-head'))header.insertBefore(button,header.querySelector('[data-close]'));else header.append(button);
    });
  }
  function init() {
    wireHeaders(); const observer = new MutationObserver(wireHeaders); observer.observe(document.body,{childList:true,subtree:true});
    document.addEventListener('keydown',e=>{if(!e.isComposing&&!e.repeat&&e.altKey&&e.shiftKey&&!e.ctrlKey&&!e.metaKey&&e.code==='KeyG'){e.preventDefault();start({root:[...document.querySelectorAll('.modal-overlay:not([data-guide-off])')].at(-1) || document.querySelector('.doc-fs') || document.querySelector('.drawer.open') || document.querySelector('#view')});}});
  }
  window.GuideCenter={catalog,suggestions,open,start,contextual,shortcutHTML,shortcuts,moduleLabels};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
