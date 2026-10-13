/* Personal notes and checklists use the same records and linked tasks as desktop. */
(function () {
  function load(view,params) {
    MApp.setTitle('Notes / checklists');
    view.innerHTML='<div class="m-actions"><button class="m-btn" id="m-note-new">New note / checklist</button></div><label class="m-field"><span class="m-label">Search notes</span><input class="m-input" id="m-note-search" type="search"></label><div id="m-note-list" aria-live="polite">Loading…</div>';
    var host=view.querySelector('#m-note-list');
    view.querySelector('#m-note-new').onclick=function(){MApp.go('notes',{new:1});};
    if(params && params.new){editor(view,null);return;}
    API.get('/notes').then(function(rows){
      if(!host.isConnected)return;
      if(params && params.id){var note=rows.find(function(n){return String(n.id)===String(params.id);});if(note){editor(view,note);return;}host.innerHTML='<div class="m-error">This note is no longer available.</div><button class="m-btn" data-all>All notes</button>';host.querySelector('[data-all]').onclick=function(){MApp.go('notes');};return;}
      function draw(){
        var q=view.querySelector('#m-note-search').value.toLowerCase().trim();var shown=rows.filter(function(n){return [n.title,n.body].concat((n.checklist||[]).map(function(i){return i.text;})).join(' ').toLowerCase().includes(q);});
        host.innerHTML=shown.length?'':'<div class="m-empty">'+(q?'No matching notes. Clear the search to show all notes.':'No notes yet. Create a note or checklist to get started.')+'</div>';
        shown.forEach(function(n){var items=n.checklist||[],completed=items.filter(function(i){return i.done;}).length;
          var card=mEl('<article class="m-card m-note-card"><button class="m-note-open" data-note="'+n.id+'"><strong>'+mEsc(n.title||'Untitled note')+'</strong><p>'+mEsc((n.body||'').slice(0,180))+'</p><small>'+mEsc(items.length?completed+' / '+items.length+' items done':'Text note')+(n.scheduled_task?' · Scheduled':'')+'</small></button></article>');
          card.querySelector('[data-note]').onclick=function(){MApp.go('notes',{id:n.id});};host.appendChild(card);
        });
      }
      view.querySelector('#m-note-search').oninput=draw;draw();
    }).catch(function(e){if(host.isConnected){host.innerHTML='<div class="m-error">'+mEsc(e.message)+'</div><button class="m-btn" data-retry>Retry</button>';host.querySelector('[data-retry]').onclick=function(){load(view,params);};}});
  }
  function editor(view,note){
    MApp.setTitle(note?'Edit note':'New note / checklist');
    var items=(note?.checklist||[]).map(function(i){return {...i};}),task=note?.scheduled_task||null,savedId=note?.id||null,busy=false,noteSaved=false;
    view.innerHTML='';
    var f=mEl('<form class="m-form" id="m-note-editor"><label class="m-field"><span class="m-label">Title</span><input class="m-input" id="m-note-title" maxlength="200" value="'+mEsc(note?.title||'')+'"></label><label class="m-field"><span class="m-label">Note</span><textarea class="m-input" id="m-note-body" rows="4" maxlength="20000">'+mEsc(note?.body||'')+'</textarea></label><h3 class="m-sec">Checklist</h3><div id="m-note-items"></div><label class="m-field"><span class="m-label">New checklist item</span><input class="m-input" id="m-note-item" maxlength="500"></label><button type="button" class="m-btn m-btn-secondary" id="m-note-add-item">Add item</button><label class="m-field m-note-schedule"><span><input type="checkbox" id="m-note-scheduled" '+(task?'checked':'')+'> Schedule this note</span></label><div id="m-note-schedule-fields" '+(task?'':'hidden')+'><label class="m-field"><span class="m-label">Due date and time *</span><input class="m-input" type="datetime-local" id="m-note-due" value="'+mEsc(mPersonalTime.input(task?.due_date))+'"></label><label class="m-field"><span class="m-label">Remind me (optional)</span><input class="m-input" type="datetime-local" id="m-note-remind" value="'+mEsc(mPersonalTime.input(task?.remind_at))+'"></label><p class="m-hint">Reminders appear in Notifications. Enable device notifications to receive them outside the app.</p></div><p class="m-error" id="m-note-error" role="alert" hidden></p><div class="m-actions"><button class="m-btn" type="submit" id="m-note-save">Save note</button><button type="button" class="m-btn m-btn-secondary" data-cancel>Cancel</button>'+(task?'<button type="button" class="m-btn m-btn-secondary" data-task>View in Scheduler</button>':'')+(note?'<button type="button" class="m-btn m-btn-warn" data-delete>Delete note</button>':'')+'</div></form>');
    view.appendChild(f);
    function error(message){var el=f.querySelector('#m-note-error');el.textContent=message;el.hidden=false;}
    function drawItems(){
      var host=f.querySelector('#m-note-items');host.innerHTML=items.map(function(i,index){return '<div class="m-note-item-row"><input type="checkbox" data-check="'+index+'" aria-label="Complete item '+(index+1)+'" '+(i.done?'checked':'')+'><input class="m-input" data-text="'+index+'" aria-label="Checklist item '+(index+1)+'" maxlength="500" value="'+mEsc(i.text)+'"><button type="button" class="m-icbtn" data-remove="'+index+'" aria-label="Remove item '+(index+1)+'">×</button></div>';}).join('');
      host.querySelectorAll('[data-check]').forEach(function(el){el.onchange=function(){items[Number(el.dataset.check)].done=el.checked;};});
      host.querySelectorAll('[data-text]').forEach(function(el){el.oninput=function(){items[Number(el.dataset.text)].text=el.value;};});
      host.querySelectorAll('[data-remove]').forEach(function(el){el.onclick=function(){items.splice(Number(el.dataset.remove),1);drawItems();};});
    }
    function add(){var input=f.querySelector('#m-note-item'),value=input.value.trim();if(!value)return;if(items.length>=200){error('A checklist can contain up to 200 items.');return;}items.push({id:crypto.randomUUID(),text:value,done:false});input.value='';drawItems();input.focus();}
    f.querySelector('#m-note-add-item').onclick=add;f.querySelector('#m-note-item').onkeydown=function(e){if(e.key==='Enter'){e.preventDefault();add();}};
    f.querySelector('#m-note-scheduled').onchange=function(){f.querySelector('#m-note-schedule-fields').hidden=!this.checked;};drawItems();
    var snapshot=function(){return JSON.stringify({items:items,fields:[...f.querySelectorAll('input:not([data-check]):not([data-text]),textarea')].map(function(el){return el.type==='checkbox'?el.checked:el.value;})});},initial=snapshot();
    mPersonalDraft.arm(function(){return snapshot()!==initial;},function(){return busy;});
    f.querySelector('[data-cancel]').onclick=function(){if(mPersonalDraft.allow())MApp.go('notes');};
    if(task)f.querySelector('[data-task]').onclick=function(){MApp.go('tasks',{id:task.id});};
    if(note)f.querySelector('[data-delete]').onclick=async function(){if(busy||!window.confirm('Delete this note? Its scheduled task will remain in Scheduler.'))return;busy=true;f.inert=true;try{await API.del('/notes/'+savedId);mPersonalDraft.clear();if(f.isConnected){mToast('Note deleted');MApp.go('notes');}}catch(e){error(e.message);}finally{busy=false;f.inert=false;}};
    f.onsubmit=async function(e){
      e.preventDefault();if(busy)return;if(f.querySelector('#m-note-item').value.trim())add();
      var body=f.querySelector('#m-note-body').value.trim(),title=f.querySelector('#m-note-title').value.trim(),scheduled=f.querySelector('#m-note-scheduled').checked,due=f.querySelector('#m-note-due').value,reminder=f.querySelector('#m-note-remind').value;
      if((!body&&!items.length)||items.some(function(i){return !i.text.trim();})){error('Add note text or a checklist and give every item a label.');return;}
      if(scheduled&&!due){error('Choose a due date and time.');f.querySelector('#m-note-due').focus();return;}
      var data={title:title,body:body,checklist:items.map(function(i){return {...i,text:i.text.trim()};})};busy=true;f.inert=true;f.querySelector('#m-note-save').disabled=true;
      try{
        if(savedId)await API.put('/notes/'+savedId,data);else savedId=(await API.post('/notes',data)).id;noteSaved=true;
        if(scheduled){var result=await API.post('/notes/'+savedId+'/schedule',{due_date:due,remind_at:reminder?new Date(reminder).toISOString():null});task={id:result.id};}
        else if(task){await API.del('/tasks/'+task.id);task=null;}
        mPersonalDraft.clear();if(f.isConnected){mToast(scheduled?'Note saved and scheduled':'Note saved');MApp.go('notes');MApp.render();}
      }catch(ex){error((noteSaved?'Note saved. Your latest changes or schedule may still need saving; correct the issue and retry. ':'')+ex.message);}
      finally{busy=false;f.inert=false;f.querySelector('#m-note-save').disabled=false;}
    };
  }
  MApp.route('notes',function(view,params){load(view,params);});
})();
