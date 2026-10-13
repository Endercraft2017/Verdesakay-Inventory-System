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
      add('.personal-reminder-choice select','Choose reminder timing','Choose a reminder relative to the deadline or select a custom date and time.');
      add('[data-remind]','Set an optional reminder','Choose the reminder date and time. It appears in Notifications and can use push when enabled on the device.');
      add('[data-open-note]','Open the linked checklist','Open linked note to read or edit its text and checklist. Unsaved schedule changes require saving or discarding before leaving.');
      add('[type=submit]','Save the schedule','Review the deadline and reminder, then press Save or Add. Saving here updates the same task used by the webapp.');
    }else if(root.querySelector('#m-note-list')){
      add('#m-note-new','Create a note or checklist','Press New note / checklist. Add text or checklist items and optionally schedule a deadline before saving.');
      add('#m-note-search','Find a note','Search title, body text or checklist items. Clear the search to show all your notes.');
      add('#m-note-list','Open a shared note','Tap a note to edit it. These are your own notes from the webapp; checklist progress and linked schedules stay connected.');
    }else if(root.querySelector('#m-task-list')){
      add('#m-task-add','Create a task','Press Add task, enter its title and optionally set a due time and reminder.');
      add('#m-task-list','Complete or inspect a task','Tap a task to view its schedule and linked note. Use its check button to complete or reopen it; linked checklist completion changes with the task.');
    }else if(root.querySelector('#m-guide-search')){
      add('#m-guide-search','Find a task guide','Search by the work you need to do, such as checklist, leave or payroll. Clear the search to show the available workflows again.');
      add('#m-guide-results','Read the workflow','Open a guide to read its steps. A step naming a webapp screen is performed there; use the phone screen’s Guide button for its own controls.');
    }else{
      var p=MApp.currentLocation(),route=p.name;
      if(route==='work'){
        add('.v2-work-list','Open your current work','Tap the selected personal task or authorized queue. Personal tasks open that exact Tasks & reminders record; role queues show the operational work you are allowed to handle.');
        add('.v2-work-tools','Open personal tools','Choose Tasks & reminders to view your tasks, or Notes / checklists to open a note. Schedule shows your employee work schedule.');
      }
      if(!result.length){
        var overview={home:'Use the attendance summary and shortcuts to open Clock, employee requests or your current work.',clock:'Choose the punch you are recording, scan the required code and follow the selfie prompt. Check the recorded confirmation before leaving.',requests:'Open a request to inspect its status, or choose New request and complete its type, dates and reason before submitting.',approvals:'Open a pending request, inspect its reason and dates, then choose your decision and enter a note before saving.',schedule:'Review your shift and work dates. Open the relevant request or attendance correction when the schedule and actual work differ.',payslips:'Open a payroll period to inspect your own earnings and deductions. Use Download when a payslip is released and download is available.',notifications:'Tap a notification to open the record or task it refers to. Enable device notifications in Profile if you need push reminders.',inbox:'Open the intended conversation, write your message and check recipients and attachments before sending.',settings:'Review your profile, device notifications and sign-in settings. Confirm the effect of a setting before saving it.',production:'Open the authorized queue for your role to inspect the job, units or parts waiting for action.',scan:'Scan the item or unit code, verify the result and choose the appropriate stock or production action.',queue:'Review pending offline actions and their errors. Reconnect to sync; queued changes are not complete until the server accepts them.'};
        add('h1,h2,.m-card,.m-actions','Use '+(document.querySelector('#m-title')?.textContent||'this screen'),overview[route]||'Read the record details and status shown here before choosing its action. Check the action’s confirmation and recorded result.');
        [...root.querySelectorAll('[data-guide-help], [aria-description]')].forEach(function(el){add(el,el.getAttribute('aria-label')||el.title||'Screen control',mEsc(el.getAttribute('data-guide-help')||el.getAttribute('aria-description')));});
      }
    }
    return result;
  }
  function start(){var root=document.querySelector('#m-view');if(!root || /Loading…/.test(root.textContent)){mToast('Wait for the screen to load, then press Guide.');return;}var p=MApp.currentLocation(),list=steps(root);if(!list.length){mToast('No controls are available in this view right now.');return;}var id='mobile:'+p.name+':'+(root.querySelector('#m-note-editor')?'note-editor':root.querySelector('[data-due]')?'task-editor':'screen');GuideTour.start({id:id,title:document.querySelector('#m-title').textContent,steps:list,variants:list.length>3?{detailed:list,brief:list.filter((_,i)=>i===0||i===Math.floor(list.length/2)||i===list.length-1)}:null,context:root},0,{root:root});}
  window.MobileGuide={start:start,steps:steps};
  function init(){document.querySelector('#m-guide-start')?.addEventListener('click',start);window.addEventListener('hashchange',function(){window.GuideTour?.close();});}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
