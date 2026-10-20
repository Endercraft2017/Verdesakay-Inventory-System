/* Personal notes and checklists use the same records and linked tasks as desktop. */
(function () {
  // Keep a note locked across filtering/reopening and reconcile fetches begun before a tick saved.
  var operations = Object.create(null), updates = Object.create(null), revision = 0, activeList = null;
  function load(view,params) {
    MApp.setTitle('Notes / checklists');
    view.innerHTML='<div class="m-actions"><button class="m-btn" id="m-note-new">New note / checklist</button></div><label class="m-field"><span class="m-label">Search notes</span><input class="m-input" id="m-note-search" type="search"></label><div id="m-note-list" aria-live="polite"></div>';
    view.querySelector('#m-note-new').onclick=function(){MApp.go('notes',{new:1});};
    if(params && params.new){editor(view,null);return;}
    var host=view.querySelector('#m-note-list'),search=view.querySelector('#m-note-search');
    var account=(MApp.getMe()||{}).id,list={host:host,rows:[],loaded:false,paint:draw,account:account},loading=false;
    activeList=list;
    function key(id){return account+':'+id;}
    function apply(row,items){
      row.checklist=items;
      // The note PUT also updates the linked task's completion on the server.
      if(row.scheduled_task && items.length)row.scheduled_task.done=items.every(function(item){return item.done;});
    }
    async function fetchNotes(){
      if(loading || !host.isConnected)return;
      loading=true;list.loaded=false;var requestedAt=revision;
      host.innerHTML='<div class="m-hint" role="status">Loading notes…</div>';
      try{
        var rows=await API.get('/notes');if(!host.isConnected)return;
        rows.forEach(function(row){var op=operations[key(row.id)],item=(row.checklist||[]).find(function(item){return item.id===op?.itemId;});if(op&&!op.pending&&(!item||item.done===op.desired))delete operations[key(row.id)];var update=updates[key(row.id)];if(update && update.version>requestedAt)apply(row,update.items);else if(update)delete updates[key(row.id)];});
        if(params && params.id){var note=rows.find(function(n){return String(n.id)===String(params.id);});if(note){editor(view,note);return;}host.innerHTML='<div class="m-error" role="alert">This note is no longer available.</div><button class="m-btn" data-all>All notes</button>';host.querySelector('[data-all]').onclick=function(){MApp.go('notes');};return;}
        list.rows=rows;list.loaded=true;draw();
      }catch(error){if(host.isConnected){host.innerHTML='<div class="m-error" role="alert">'+mEsc(error.message||'Could not load notes.')+'</div><button type="button" class="m-btn" data-retry>Retry</button>';host.querySelector('[data-retry]').onclick=fetchNotes;}}
      finally{loading=false;}
    }
    function draw(){
      if(!list.loaded || !host.isConnected)return;
      var q=search.value.toLowerCase().trim(),shown=list.rows.filter(function(n){return [n.title,n.body].concat((n.checklist||[]).map(function(i){return i.text;})).join(' ').toLowerCase().includes(q);});
      host.innerHTML=shown.length?'':'<div class="m-empty">'+(q?'No matching notes. Clear the search to show all notes.':'No notes yet. Create a note or checklist to get started.')+'</div>';
      shown.forEach(function(n){
        var items=n.checklist||[],completed=items.filter(function(i){return i.done;}).length,op=operations[key(n.id)]||{};
        var card=mEl('<article class="m-card m-note-card" data-note-id="'+mEsc(n.id)+'" aria-busy="'+!!op.pending+'"><button class="m-note-open" data-note="'+mEsc(n.id)+'"><strong>'+mEsc(n.title||'Untitled note')+'</strong><p>'+mEsc((n.body||'').slice(0,180))+'</p><small>'+mEsc(items.length?completed+' / '+items.length+' items done':'Text note')+(n.scheduled_task?' · '+(n.scheduled_task.done?'Task complete':'Due '+mEsc(PersonalUX.format(n.scheduled_task.due_date))):'')+'</small></button>'+(n.scheduled_task?'<button type="button" class="m-btn m-btn-secondary m-btn-sm" data-card-task>Open linked task</button>':'')+(n.scheduled_task?.remind_at?'<p class="m-hint">Reminder '+mEsc(PersonalUX.format(n.scheduled_task.remind_at))+'</p>':'')+(items.length?'<div class="m-note-preview-checks">'+items.slice(0,3).map(function(item,index){return '<label><input type="checkbox" data-preview="'+index+'" aria-label="Complete '+mEsc(item.text)+'" '+(item.done?'checked':'')+'><span>'+mEsc(item.text)+'</span></label>';}).join('')+'<small>Checklist ticks save immediately</small></div>':'')+(op.pending?'<p class="m-note-feedback" role="status">Saving checklist…</p>':op.error?'<div class="m-note-feedback m-error" role="alert">'+mEsc(op.error)+'<button type="button" class="m-btn m-btn-sm" data-retry-tick>Try again</button></div>':'')+'</article>');
        card.querySelector('[data-note]').onclick=function(){MApp.go('notes',{id:n.id});};
        card.querySelector('[data-card-task]')?.addEventListener('click',function(){MApp.go('tasks',{id:n.scheduled_task.id});});
        card.querySelectorAll('[data-preview]').forEach(function(input){input.onchange=function(){var item=items[Number(input.dataset.preview)];saveTick(n,item.id,input.checked);};});
        var retry=card.querySelector('[data-retry-tick]');if(retry)retry.onclick=function(){saveTick(n,op.itemId,op.desired);};
        if(op.pending)card.querySelectorAll('button,input').forEach(function(el){el.disabled=true;});host.appendChild(card);
      });
    }
    async function saveTick(note,itemId,desired){
      var id=key(note.id);if(operations[id]?.pending)return;
      // Retry the intended item against the latest row, preserving its other edits.
      var items=(note.checklist||[]).map(function(item){return {...item};}),item=items.find(function(item){return item.id===itemId;});
      if(!item)return;item.done=desired;
      var op={pending:true,itemId:itemId,desired:desired,error:null};operations[id]=op;draw();
      try{
        await API.put('/notes/'+note.id,{title:note.title,body:note.body,checklist:items});
        updates[id]={version:++revision,items:items};apply(note,items);delete operations[id];
        if(activeList?.account===account && activeList.host.isConnected)activeList.rows.forEach(function(row){if(String(row.id)===String(note.id))apply(row,items);});
        // PUT is authoritative: a second GET must not turn a saved tick into an apparent failure.
      }catch(error){op.error='Could not save this checklist change. '+(error.message||'Check your connection and try again.');}
      finally{op.pending=false;if(activeList?.account===account && activeList.host.isConnected)activeList.paint();}
    }
    search.oninput=draw;fetchNotes();
  }
  function editor(view,note){
    MApp.setTitle(note?'Edit note':'New note / checklist');
    var items=(note?.checklist||[]).map(function(i){return {...i};}),task=note?.scheduled_task||null,savedId=note?.id||null,busy=false,busyAction='saving',confirmation=null,proceedLeave=null,schedulePending=false;
    view.innerHTML='';
    var f=mEl('<form class="m-form" id="m-note-editor" novalidate><label class="m-field"><span class="m-label">Title</span><input class="m-input" id="m-note-title" maxlength="200" value="'+mEsc(note?.title||'')+'"></label><label class="m-field"><span class="m-label">Note</span><textarea class="m-input" id="m-note-body" rows="4" maxlength="20000">'+mEsc(note?.body||'')+'</textarea></label><h3 class="m-sec">Checklist</h3><small class="m-hint">Checklist edits save with the note.</small><div id="m-note-items"></div><label class="m-field"><span class="m-label">New checklist item</span><input class="m-input" id="m-note-item" maxlength="500"></label><button type="button" class="m-btn m-btn-secondary" id="m-note-add-item">Add item</button><label class="m-field m-note-schedule"><span><input type="checkbox" id="m-note-scheduled" '+(task?'checked':'')+'> Schedule this note</span></label>'+(task?'<button type="button" class="m-btn m-btn-secondary" data-task>Open linked task</button>':'')+'<div id="m-note-schedule-fields" '+(task?'':'hidden')+'><label class="m-field"><span class="m-label">Due date and time *</span><input class="m-input" type="datetime-local" id="m-note-due" value="'+mEsc(mPersonalTime.input(task?.due_date))+'"></label><label class="m-field"><span class="m-label">Remind me (optional)</span><input class="m-input" type="datetime-local" id="m-note-remind" value="'+mEsc(mPersonalTime.input(task?.remind_at))+'"></label><p class="m-hint">Reminders appear in Notifications. Enable device notifications to receive them outside the app.</p></div><p class="m-error" id="m-note-error" role="alert" tabindex="-1" hidden></p><div class="personal-editor-actions"><span class="personal-save-status" data-save-status aria-live="polite"></span><div class="m-actions"><button class="m-btn" type="submit" id="m-note-save">Save note</button><button type="button" class="m-btn m-btn-secondary" data-cancel>Cancel</button></div></div><details class="personal-secondary-actions"><summary>More actions</summary>'+(note?'<button type="button" class="m-btn m-btn-warn" data-delete>Delete note</button>':'')+'</details></form>');
    view.appendChild(f);PersonalUX.footer(f);PersonalUX.schedule(f,'#m-note-due','#m-note-remind',task?.due_date);let saveStatus;
    function error(message,field,status){
      saveStatus?.failed(status||'Not saved');var el=f.querySelector('#m-note-error');el.textContent=message;el.hidden=false;
      if(field){field.setAttribute('aria-invalid','true');field.focus();}else el.focus();
      el.scrollIntoView?.({block:'nearest'});
    }
    f.addEventListener('input',function(event){event.target.removeAttribute('aria-invalid');});
    function drawItems(){
      var host=f.querySelector('#m-note-items');host.innerHTML=items.map(function(i,index){return '<div class="m-note-item-row"><input type="checkbox" data-check="'+index+'" aria-label="Complete item '+(index+1)+'" '+(i.done?'checked':'')+'><input class="m-input" data-text="'+index+'" aria-label="Checklist item '+(index+1)+'" maxlength="500" value="'+mEsc(i.text)+'"><button type="button" class="m-icbtn" data-remove="'+index+'" aria-label="Remove item '+(index+1)+'">×</button></div>';}).join('');
      host.querySelectorAll('[data-check]').forEach(function(el){el.onchange=function(){items[Number(el.dataset.check)].done=el.checked;};});
      host.querySelectorAll('[data-text]').forEach(function(el){el.oninput=function(){items[Number(el.dataset.text)].text=el.value;};});
      host.querySelectorAll('[data-remove]').forEach(function(el){el.onclick=function(){items.splice(Number(el.dataset.remove),1);drawItems();saveStatus?.update();};});
    }
    function add(){var input=f.querySelector('#m-note-item'),value=input.value.trim();if(!value)return;if(items.length>=200){error('A checklist can contain up to 200 items.');return;}items.push({id:crypto.randomUUID(),text:value,done:false});input.value='';drawItems();saveStatus?.update();input.focus();}
    f.querySelector('#m-note-add-item').onclick=add;f.querySelector('#m-note-item').onkeydown=function(e){if(e.key==='Enter'){e.preventDefault();add();}};
    f.querySelector('#m-note-scheduled').onchange=function(){f.querySelector('#m-note-schedule-fields').hidden=!this.checked;let warning=f.querySelector('[data-unschedule-note]');if(!warning){warning=mEl('<p class="m-hint" data-unschedule-note></p>');this.closest('label').after(warning);}warning.textContent=task&&!this.checked?'Saving removes this task and its reminder. Your note and checklist stay.':'';};drawItems();
    var snapshot=function(){return JSON.stringify({items:items,fields:[...f.querySelectorAll('input:not([data-check]):not([data-text]),textarea,select')].map(function(el){return {value:el.type==='checkbox'?el.checked:el.value,edited:el.dataset.edited||''};})});},initial=snapshot();saveStatus=PersonalUX.status(f,f.querySelector('[data-save-status]'),()=>schedulePending||snapshot()!==initial,!!note);
    mPersonalDraft.arm(function(){return !!confirmation||schedulePending||snapshot()!==initial;},function(){return busy;},{
      busyText:function(){return busyAction==='deleting'?'Please wait for deletion to finish.':'Please wait for saving to finish.';},
      confirmLeave:function(proceed){proceedLeave=proceed;showConfirmation('leave');}
    });
    f.querySelector('[data-cancel]').onclick=function(){MApp.go('notes');};
    if(task)f.querySelector('[data-task]').onclick=function(){MApp.go('tasks',{id:task.id});};
    if(note)f.querySelector('[data-delete]').onclick=function(){showConfirmation('delete');};
    function showConfirmation(kind){
      if(busy)return;if(confirmation){confirmation.focus();return;}
      var removing=kind==='delete',returnFocus=document.activeElement;
      var root=mEl('<div class="m-task-confirm-backdrop m-note-confirm-backdrop" aria-label="'+(removing?'Delete this note?':'Discard note changes?')+'"><section class="m-task-confirm m-note-confirm"><h2>'+(removing?'Delete this note?':'Discard note changes?')+'</h2><blockquote>'+mEsc(f.querySelector('#m-note-title').value.trim()||'Untitled note')+'</blockquote><p>'+(removing?'The note and its checklist will be deleted.':schedulePending?'Your note was saved, but its schedule still needs saving. Leave without finishing the schedule?':'Your text, checklist or schedule changes haven’t been saved.')+'</p>'+(removing&&task?'<p class="m-task-linked">Its linked task and reminder will stay in Tasks &amp; reminders.</p>':'')+(!removing?'<p>Keep editing to finish and save your note.</p>':'')+'<p class="m-error" data-confirm-error role="alert" tabindex="-1"></p><div class="m-actions"><button type="button" class="m-btn m-btn-secondary" data-keep>'+(removing?'Cancel':'Keep editing')+'</button><button type="button" class="m-btn m-btn-danger" data-confirm>'+(removing?'Delete note':'Discard changes')+'</button></div></section></div>');
      f.inert=true;document.body.appendChild(root);
      var control=MessageOverlay.mount(root,{initialFocus:'[data-keep]',canClose:function(){return !busy;},onClose:function(){confirmation=null;f.inert=false;if(returnFocus?.isConnected)returnFocus.focus();}});confirmation=control;
      var keep=root.querySelector('[data-keep]'),confirm=root.querySelector('[data-confirm]'),feedback=root.querySelector('[data-confirm-error]');
      keep.onclick=control.close;
      confirm.onclick=async function(){
        if(busy)return;
        if(!removing){control.close();if(proceedLeave)proceedLeave();return;}
        busy=true;busyAction='deleting';keep.disabled=true;confirm.disabled=true;confirm.textContent='Deleting…';feedback.textContent='';root.setAttribute('aria-busy','true');
        try{await API.del('/notes/'+savedId);busy=false;mPersonalDraft.clear();control.close();if(f.isConnected){mToast('Note deleted');MApp.go('notes');}}
        catch(failure){if(root.isConnected){feedback.textContent='The note could not be deleted. '+(failure.message||'Try again when connected.');feedback.focus();}}
        finally{busy=false;keep.disabled=false;confirm.disabled=false;confirm.textContent='Delete note';root.removeAttribute('aria-busy');}
      };
    }
    f.onsubmit=async function(e){
      e.preventDefault();if(busy||confirmation)return;if(f.querySelector('#m-note-item').value.trim()){add();if(f.querySelector('#m-note-item').value.trim())return;}
      f.querySelector('#m-note-error').hidden=true;
      var body=f.querySelector('#m-note-body').value.trim(),title=f.querySelector('#m-note-title').value.trim(),scheduled=f.querySelector('#m-note-scheduled').checked,due=f.querySelector('#m-note-due').value,reminder=f.querySelector('#m-note-remind').value;
      if((!body&&!items.length)||items.some(function(i){return !i.text.trim();})){error('Add note text or a checklist and give every item a label.');return;}
      if(scheduled&&!due){error('Choose a due date and time.',f.querySelector('#m-note-due'));return;}
      var dueField=f.querySelector('#m-note-due'),remindField=f.querySelector('#m-note-remind'),preset=f.querySelector('[aria-label="Reminder timing"]').value;
      var invalid=[...f.querySelectorAll('input,textarea')].find(function(field){return !field.checkValidity() && (scheduled||!field.closest('#m-note-schedule-fields'));});
      if(invalid){error(invalid.validationMessage,invalid);return;}
      if(scheduled&&preset==='custom'&&!reminder){error('Choose a reminder date and time, or select No reminder.',remindField);return;}
      if(!scheduled&&task&&!window.confirm('Remove this task and reminder? Your note and checklist will stay.'))return;
      saveStatus.saving();var noteSaved=false;var data={title:title,body:body,checklist:items.map(function(i){return {...i,text:i.text.trim()};})};busy=true;busyAction='saving';f.inert=true;f.querySelector('#m-note-save').disabled=true;f.querySelector('#m-note-save').textContent='Saving…';
      try{
        if(savedId)await API.put('/notes/'+savedId,data);else savedId=(await API.post('/notes',data)).id;noteSaved=true;
        if(scheduled){var result=await API.post('/notes/'+savedId+'/schedule',{due_date:PersonalUX.dueValue(f.querySelector('#m-note-due'),task?.due_date),remind_at:PersonalUX.reminderValue(f.querySelector('#m-note-remind'),task?.remind_at)});task={id:result.id,due_date:PersonalUX.dueValue(dueField,task?.due_date),remind_at:PersonalUX.reminderValue(remindField,task?.remind_at)};}
        else if(task){await API.del('/tasks/'+task.id);task=null;}
        schedulePending=false;saveStatus.saved();mPersonalDraft.clear();if(f.isConnected){mToast(scheduled?'Note saved and scheduled':'Note saved');MApp.go('notes');}
      }catch(ex){
        f.inert=false;
        schedulePending=noteSaved||schedulePending;
        error((noteSaved?(scheduled?'Note saved. Your schedule could not be saved. Retry saving to finish scheduling; no duplicate note will be created. ':'Note saved. Its linked task and reminder could not be removed. Retry saving to finish. '):'Your latest note changes could not be saved. Your text and checklist are still here. ')+(ex.message||'Check your connection and try again.'),null,noteSaved?'Note saved · schedule needs retry':'Not saved');
      }
      finally{busy=false;f.inert=false;f.querySelector('#m-note-save').disabled=false;f.querySelector('#m-note-save').textContent=schedulePending?'Retry save':'Save note';}
    };
  }
  MApp.route('notes',function(view,params){load(view,params);});
})();
