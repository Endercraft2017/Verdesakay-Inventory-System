/* Contextual phone coaching. Shares the desktop tour engine, not its router or actions. */
(function(){
  window.GuideTourPlatform={keys:'Use Back / Next to move through steps. Exit closes help; the guide never saves or submits.',
    App:{getMe:function(){return MApp.getMe();},currentLocation:function(){var p=MApp.currentLocation();return {route:p.name,filter:p.params};},canAccessRoute:function(){return false;},navigate:function(){}},
    UI:{esc:function(s){return mEsc(s);},toast:function(s,kind){mToast(s,kind);},icon:function(name){return '<span aria-hidden="true">'+(name==='close'?'×':'↕')+'</span>';}}
  };
  function steps(root){
    var result=[];
    function add(selector,title,body){var target=typeof selector==='string'?root.querySelector(selector):selector;if(!target || (target.id==='m-note-items' && !target.children.length) || target.disabled || target.closest('[hidden],.hidden'))return;for(var el=target;el && el!==root;el=el.parentElement){if(el.style.display==='none')return;}var token='m-guide-'+result.length;target.dataset.mobileGuide=token;result.push({title:title,body:body,target:target,spot:target.id?'#'+target.id:'[data-mobile-guide="'+token+'"]'});}
    if(root.querySelector('#m-note-editor')){
      add('#m-note-title','Name the note','Enter an action-oriented title, such as Review October payroll. Its linked task uses the same title.');
      add('#m-note-body','Write the context','Enter the details you need to remember. You can save body text, a checklist, or both.');
      add('#m-note-item','Add checklist items','Type one action and press Add item or Enter. Repeat for each action you need to complete.');
      add('#m-note-items','Update checklist progress','Check completed items and edit their text here. Press Save note to store changes; completing every item also completes the linked task.');
      add('#m-note-scheduled','Schedule this note','Check Schedule this note to reveal Due date and time and Remind me. Saving creates one linked task or updates the existing task. Unchecking and saving removes the scheduled task while keeping the note.');
      add('#m-note-due','Choose when the work is due','Enter the local date and time the task should be completed. A due date is required when scheduling a note.');
      add('.personal-reminder-choice select','Choose reminder timing','Choose No reminder, a time before the deadline, or Custom date and time. Relative choices update while editing this schedule. Check a saved custom reminder if you change the deadline.');
      add('#m-note-remind','Choose an optional reminder','Choose when to receive a notification. Enable device notifications to receive it outside the app.');
      add('#m-note-save','Save the note and schedule','Check the title, checklist and schedule, then press Save note. If scheduling fails after the note saves, correct the error and retry; the saved note is reused.');
    }else if(root.querySelector('[data-title]') && root.querySelector('[data-due]')){
      add('[data-title]','Name the task','Enter the action you need to do. If this task is linked to a note, use Open linked note to change its title and checklist.');
      add('[data-due]','Choose the due time','Choose the local date and time for the deadline. This is the same schedule shown in the webapp’s Tasks & reminders.');
      add('.personal-reminder-choice select','Choose reminder timing','Choose No reminder, a relative reminder or Custom date and time. Relative reminders need a due date; Custom needs a reminder date/time. Resolve validation errors before saving.');
      add('[data-remind]','Set an optional reminder','Choose the reminder date and time. It appears in Notifications and can use push when enabled on the device.');
      add('[data-open-note]','Open the linked checklist','Open linked note to read or edit its text and checklist. Unsaved schedule changes require saving or discarding before leaving.');
      add('[type=submit]','Save the schedule','Review the local deadline, reminder and save status, then press Save or Add. More actions → Delete task asks for confirmation and removes its reminder, but keeps a linked note. Cancel/discard protects unsaved edits; saving updates the shared task.');
    }else if(root.querySelector('#m-note-list')){
      add('#m-note-new','Create a note or checklist','Press New note / checklist. Add text or checklist items and optionally schedule a deadline before saving.');
      add('#m-note-search','Find a note','Search title, body text or checklist items. Clear the search to show all your notes.');
      add('#m-note-list','Open a shared note','Open a note to edit text/checklist and save editor changes. Checklist ticks on the notes list save immediately: wait for Saving checklist, and use Try again if it fails. A tick can update the linked task; these are your own shared webapp notes.');
    }else if(root.querySelector('#m-task-list')){
      add('#m-task-add','Create a task','Press Add task, enter its title and optionally set a due time and reminder.');
      add('#m-task-list','Complete or inspect a task','Tasks are grouped into Overdue, Today, Upcoming, No date and Done. Tap a task to view it; the check button completes/reopens it. Wait for Updating task to finish. If it fails, Try again repeats that intended change; do not assume it saved. Linked checklist progress changes with the task.');
    }else if(root.querySelector('#m-guide-search')){
      add('#m-guide-search','Find a task guide','Search by the work you need to do, such as checklist, leave or payroll. Clear the search to show the available workflows again.');
      add('#m-guide-results','Read the workflow','Open a guide to read its steps. A step naming a webapp screen is performed there; use the phone screen’s Guide button for its own controls.');
    }else{
      var p=MApp.currentLocation(),route=p.name;
      if(route==='work'){
        add('.v2-work-heading','Your active Work tasks','<p>This guide explains only the tasks and tools currently shown for your account. Access comes from your assigned permissions and enabled modules.</p><p><b>WAITING</b> is the queue count, <b>CLEAR</b> means no work is currently counted, and <b>OPEN</b> means the task is available without a confirmed count. These labels do not mean the task has been completed.</p><p>Choose Jump to a task to read one explanation directly, or use Next to highlight each entry. The guide never opens or submits work.</p>');
        root.querySelectorAll('[data-work-guide]').forEach(function(row){
          add(row,row.dataset.workGuideTitle,
            (row.dataset.workGuideEffect?'<p class="work-guide-effect"><b>Stock effect:</b> '+mEsc(row.dataset.workGuideEffect)+'</p>':'')+'<p><b>What it is:</b> '+mEsc(row.dataset.workGuidePurpose)+'</p>'+
            '<p><b>When to use it:</b> '+mEsc(row.dataset.workGuideWhen)+'</p>'+
            '<p><b>Result / next step:</b> '+mEsc(row.dataset.workGuideResult)+'</p>');
        });
      }
      if(route==='receiving'){
        add('[data-jo]','Choose the receiving job group','Open the eligible job-order group before selecting units/batches. An empty queue means none are ready for this stage; a QC pass alone is not stock.');
        add('#rts-legacy','Enter or resume a pre-system unit','Use only for an existing physical unit not yet in the system. Identifier, photo, location, reason and valuation are required. Intake creates no stock and no BOM release; both QC and QA must pass.');
        add('[data-legacy-product]','Select the existing product','Select the finished product for this physical unit. The available catalogue choices do not grant permission to create or adjust products.');
        add('[data-legacy-identifier]','Record physical identity','Use a distinct identifier physically marked on the unit. Do not enter it twice or recreate an uncertain saved intake.');
        add('[data-legacy-cost]','Review the declared valuation','Review the prefilled unit cost and correct it when appropriate. This valuation follows the legacy unit; it is not a new BOM manufacturing cost.');
        add('#legacy-submit','Send to QC, then QA','Review the physical-unit confirmation, photo and required fields. Submission creates an inspection-only LI record, not available stock. Recover the saved original attempt after an unknown response.');
        add('#rts-print-labels','Print and attach the stock sticker','Print the label for the exact unit or batch and attach it to the physical goods. The next verification requires scanning the attached sticker.');
        add('[data-label-verification]','Scan each attached sticker','Camera-scan every expected attached label. Do not bypass sticker verification or use another unit’s code.');
        add('#rts-post','Confirm RTS stock-in','After final inspection, sticker scans, physical verification and storage checks, post the receipt once. Only confirmed Products In adds stock; recover saved attempts after uncertainty.');
      }
      if(route==='qc'){
        add('[data-jo]','Choose the inspection job group','Open the eligible job group and select its Ready/Reinspect or Ready/Recheck unit card. Only your current inspection stage is shown.');
        add('#qc-identity','Match the physical unit first','Match the production identifier and job/intake against the physical unit. A QR sticker is not required before Products In. Stop and use Wrong unit if identity is unclear.');
        add('#qc-start','Start the verified inspection','Confirm identity before starting the required checks. QC and QA stay separate on two-stage work, including legacy intake. Starting inspection adds no stock.');
      }
      if(route==='inbox'){
        add('#m-chat-input','Write to the selected conversation','Check the recipient and any reply/edit state before typing. A draft is not yet a sent message.');
        add('#m-chat-attach','Review attachments','Attach the intended files/photos and check preview/upload status before sending. If recovery reports an uncertain result, check the conversation before resending.');
        add('#m-chat-send','Send and check the result','Send only after reviewing recipient, text and attachments. On a failure read the feedback before retrying.');
        add('.m-chat-row','Reply, react or manage a message','Open the message’s actions to Reply or React, and Edit/Remove your own eligible messages. Reactions show their saved badge; if confirmation is unclear check it before retrying. Removing needs confirmation.');
      }
      if(!result.length){
        var overview={home:'Use the attendance summary and shortcuts to open Clock, employee requests or your current work.',clock:'Choose the punch you are recording, scan the required code and follow the selfie prompt. Check the recorded confirmation before leaving.',requests:'Open a request to inspect its status, or choose New request and complete its type, dates and reason before submitting.',approvals:'Open a pending request, inspect its reason and dates, then choose your decision and enter a note before saving.',schedule:'Review your shift and work dates. Open the relevant request or attendance correction when the schedule and actual work differ.',payslips:'Open a payroll period to inspect your own earnings and deductions. Use Download when a payslip is released and download is available.',notifications:'Tap a notification to open the record or task it refers to. Enable device notifications in Profile if you need push reminders.',inbox:'Open the intended conversation, write your message and check recipients and attachments before sending.',settings:'Review your profile, device notifications and sign-in settings. Confirm the effect of a setting before saving it.',production:'Open the authorized queue for your role to inspect the job, units or parts waiting for action.',scan:'Scan the item or unit code, verify the result and choose the appropriate stock or production action.',queue:'Review pending offline actions and their errors. Reconnect to sync; queued changes are not complete until the server accepts them.'};
        add('h1,h2,.m-card,.m-actions','Use '+(document.querySelector('#m-title')?.textContent||'this screen'),overview[route]||'Read the record details and status shown here before choosing its action. Check the action’s confirmation and recorded result.');
        [...root.querySelectorAll('[data-guide-help], [aria-description]')].forEach(function(el){add(el,el.getAttribute('aria-label')||el.title||'Screen control',mEsc(el.getAttribute('data-guide-help')||el.getAttribute('aria-description')));});
      }
    }
    return result;
  }
  function start(){var root=document.querySelector('#m-view');if(!root || /Loading…/.test(root.textContent)){mToast('Wait for the screen to load, then press Guide.');return;}var p=MApp.currentLocation();if(p.name==='work')root=root.querySelector('.v2-work')||root;var list=steps(root);if(!list.length){mToast('No controls are available in this view right now.');return;}var id='mobile:'+p.name+':'+(root.querySelector('#m-note-editor')?'note-editor':root.querySelector('[data-due]')?'task-editor':'screen');GuideTour.start({id:id,title:document.querySelector('#m-title').textContent,steps:list,stepPicker:p.name==='work'?'Jump to a task':null,variants:p.name!=='work'&&list.length>3?{detailed:list,brief:list.filter((_,i)=>i===0||i===Math.floor(list.length/2)||i===list.length-1)}:null,context:root},0,{root:root});if(p.name==='work')document.querySelector('.guide-coach')?.classList.add('work-task-guide');}
  window.MobileGuide={start:start,steps:steps};
  function init(){document.querySelector('#m-guide-start')?.addEventListener('click',start);window.addEventListener('hashchange',function(){window.GuideTour?.close();});}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
