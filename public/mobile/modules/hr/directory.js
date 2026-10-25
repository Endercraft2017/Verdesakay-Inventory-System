/* Active colleagues, grouped as before. Reads belong to this visible sign-in only. */
MApp.route('directory', function(view) {
  MApp.setTitle('Directory');
  var root=mEl('<section class="m-directory"><h1 class="work-sr-only">Directory</h1><div class="directory-heading"><p class="m-hint">Find a colleague and open your conversation.</p><button type="button" class="work-text-button" data-directory-refresh hidden tabindex="-1" aria-hidden="true">Refresh</button></div><label class="m-field" for="m-dir-q"><span class="m-label">Search colleagues</span></label><div class="directory-search"><input type="search" class="m-input" id="m-dir-q" placeholder="Search name, department or role"><button type="button" class="work-text-button" data-directory-clear disabled>Clear</button></div><p class="m-hint" data-directory-count role="status"></p><div data-directory-feedback></div><div id="m-dir-list"></div></section>');
  view.replaceChildren(root);
  var scope=mReadScope.create(root),me=MApp.getMe()||{},q=root.querySelector('#m-dir-q'),list=root.querySelector('#m-dir-list');
  var all=[],loaded=false,loading=false,error='',status='',opening=null;
  function role(u){return String(u.role_label||u.role||'').replace(/_/g,' ').replace(/\b(hr|qc|qa|rts)\b/gi,function(s){return s.toUpperCase();}).replace(/\b\w/g,function(c){return c.toUpperCase();});}
  function present(){return scope.current()&&root.isConnected;}
  function render() {
    if(!present())return;
    var term=q.value.trim().toLowerCase(),rows=all.filter(function(u){return String(u.id)!==String(me.id)&&u.active!==0&&u.active!==false&&(!term||[u.full_name,u.department_name,u.role,role(u)].some(function(s){return String(s||'').toLowerCase().includes(term);}));});
    var button=root.querySelector('[data-directory-refresh]');button.disabled=loading;button.textContent=loading?'Refreshing…':'Refresh';
    root.querySelector('[data-directory-clear]').disabled=!q.value;
    root.querySelector('[data-directory-count]').textContent=loading&&!loaded?'Loading directory…':loaded?rows.length+' colleague'+(rows.length===1?'':'s')+(term?' found':''):'';
    root.querySelector('[data-directory-feedback]').innerHTML=(error?'<p class="work-feedback error" role="alert">'+mEsc(error)+(loaded?' Showing last loaded colleagues. Your search is kept.':'')+'</p><button type="button" class="m-v2-secondary" data-directory-retry>Try again</button>':'')+(status?'<p class="m-hint" role="status">'+mEsc(status)+'</p>':'');
    root.querySelector('[data-directory-retry]')?.addEventListener('click',function(){if(this.isConnected)load();});
    list.innerHTML='';
    if(loaded&&!rows.length){list.innerHTML='<div class="m-empty">'+(term?'No colleagues match your search. Clear it or try another name, department or role.':'No other active colleagues are available.')+'</div>';return;}
    var groups=Object.create(null);rows.forEach(function(u){(groups[u.department_name||'No department']=groups[u.department_name||'No department']||[]).push(u);});
    Object.keys(groups).sort().forEach(function(dep){
      list.appendChild(mEl('<h2 class="m-sec">'+mEsc(dep)+'</h2>'));var ul=mEl('<ul class="m-list"></ul>');
      groups[dep].sort(function(a,b){return String(a.full_name||'').localeCompare(String(b.full_name||''));}).forEach(function(u){
        var li=mEl('<li><button type="button" class="m-list-row m-directory-person" aria-label="Message '+mEsc(u.full_name||u.username||'colleague')+'"><div><b>'+mEsc(u.full_name||u.username||'Colleague')+'</b><span>'+mEsc(role(u))+'</span></div><div class="m-list-qty" aria-hidden="true">✉️</div></button></li>');
        var person=li.querySelector('button');person.disabled=opening!==null;
        person.onclick=function(){
          if(!person.isConnected||!present()||opening!==null)return;
          if(!MApp.canOpen('inbox')){error='Messaging is not available with your current access.';render();return;}
          opening=u.id;root.querySelectorAll('.m-directory-person').forEach(function(b){b.disabled=true;});
          Promise.resolve().then(function(){if(!present())return;return mCompose(u.id,u.full_name);}).catch(function(e){if(present())error=e.message||'The conversation could not be opened.';}).finally(function(){opening=null;if(present())render();});
        };ul.appendChild(li);
      });list.appendChild(ul);
    });
  }
  async function load() {
    if(loading||!present())return;loading=true;error=status='';render();
    try {
      var rows=await scope.run(function(opts){return API.get('/users',opts);});
      if(!present())return;
      if(!Array.isArray(rows)||rows.some(function(u){return !u||!Number.isInteger(Number(u.id))||Number(u.id)<=0;}))throw new Error('The directory response could not be read. Try again.');
      // Ordinary directory responses omit active; management responses include inactive accounts.
      all=rows.filter(function(u){return u.active!==0&&u.active!==false&&String(u.id)!==String(me.id);});loaded=true;status='Directory checked just now.';
    } catch(e) {
      if(e.cancelled||!present())return;error=e.message||'Could not load the directory.';
      if(e.status===401||e.status===403){all=[];loaded=false;}
    } finally {loading=false;if(present())render();}
  }
  q.addEventListener('input',render);
  root.querySelector('[data-directory-clear]').onclick=function(){if(!present())return;q.value='';render();q.focus();};
  root.querySelector('[data-directory-refresh]').onclick=load;window.mScreenUX?.bindRefresh(root,async function(){await load();return {ok:!error};},function(){return present()&&!loading&&opening===null;});load();
});
