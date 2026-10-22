/* Durable recovery and shared editing use the existing authenticated tenant API.
   Independent blocks merge; overlapping edits remain local until explicitly resolved. */
const DocStudio = (() => {
  const clone = value => JSON.parse(JSON.stringify(value));
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value==='object' ? Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])) : value;
  const equal = (a,b) => JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
  function merge(base,local,remote,preferLocal=false) {
    const result=clone(remote), conflicts=[];
    for(const key of Object.keys(local)) {
      if(equal(local[key],base[key]))continue;
      if(equal(remote[key],base[key])||equal(local[key],remote[key])){result[key]=local[key];continue;}
      if(key==='body') {
        const split=body=>{const p=String(body).split(/<!--doc-sync:([\w-]+)-->/);if(p.length<3)return null;const m=new Map([['$prefix',p[0]]]);for(let i=1;i<p.length;i+=2){if(m.has(p[i]))return null;m.set(p[i],p[i+1]);}return m;};
        const b=split(base.body),l=split(local.body),r=split(remote.body);
        if(b&&l&&r&&equal([...b.keys()],[...l.keys()])&&equal([...b.keys()],[...r.keys()])) {
          const m=new Map(r);let blocked=false;
          for(const [id,v] of l)if(v!==b.get(id)){if(r.get(id)!==b.get(id)&&r.get(id)!==v){conflicts.push('block:'+id);blocked=true;if(preferLocal)m.set(id,v);}else m.set(id,v);}
          if(!blocked||preferLocal)result.body=[...m].map(([id,v])=>id==='$prefix'?v:`<!--doc-sync:${id}-->${v}`).join('');
          continue;
        }
      }
      conflicts.push(key);if(preferLocal)result[key]=local[key];
    }
    return {snapshot:result,conflicts};
  }
  function mount(fs,opts,api) {
    const clientId=crypto.randomUUID();
    let closed=false,paused=false,applying=false,busy=false,initializing=true,connected=false,conflict=null,pendingSync=null;
    let documentKey=opts.getDocumentKey?.()||opts.documentKey;
    let base=null,version=0,draftVersion=0,draft=null,peers=[],comments=[],library=[],history=[];
    let timer=null,heartbeat=null,chain=Promise.resolve(),sharedEnabled=/^(template|form):/.test(documentKey);
    let generation=0, draftDirty=false, draftConflict=false, status='Connecting to shared storage…';
    const badge=document.createElement('span');badge.className='doc-save-status doc-shared-status';badge.setAttribute('role','status');fs.querySelector('.doc-fs-bar-actions').prepend(badge);
    const url=()=>'/templates/studio/documents/'+encodeURIComponent(documentKey);
    const say=text=>{status=text;if(!closed)badge.textContent=text;};
    say(status);
    function enqueue(task){const pending=chain.then(task);chain=pending.catch(()=>{});return pending;}
    const safely=(task)=>task.catch(err=>{if(!closed)say(err.message+' · local recovery remains available');});
    const formatDate=value=>new Date(value.replace(' ','T')+'Z').toLocaleString();
    const safeBody=body=>{const root=document.createElement('div');root.innerHTML=body;root.querySelectorAll('script,iframe,object,embed,link,meta,base').forEach(n=>n.remove());root.querySelectorAll('*').forEach(el=>{[...el.attributes].forEach(a=>{if(/^on/i.test(a.name))el.removeAttribute(a.name);if(['href','src'].includes(a.name)&&!api.safeUrl(a.value,el.tagName==='IMG'))el.removeAttribute(a.name);});});return root.innerHTML;};
    function apply(value) {applying=true;try{const copy=clone(value);copy.body=safeBody(copy.body);api.apply(copy);api.markBlocks();}finally{applying=false;}}
    function showConflict(value,remoteVersion,message,mergeBase=base) {
      conflict={snapshot:value,version:remoteVersion,base:mergeBase?clone(mergeBase):null};say(message||'Overlapping edits need review · your local draft is safe');api.render();
    }
    function acknowledgeSync(sent,response){
      if(response.version<version)return;
      const merged=merge(sent,api.snapshot(),response.snapshot);
      base=clone(response.snapshot);version=response.version;
      if(merged.conflicts.length){showConflict(response.snapshot,response.version,undefined,sent);return;}
      if(!equal(api.snapshot(),merged.snapshot))apply(merged.snapshot);
      say(peers.length>1?`${peers.length} editors · changes synced`:'Shared changes synced');
    }
    function reconcilePendingSync(){
      if(!pendingSync||api.isComposing?.())return;
      const pending=pendingSync;pendingSync=null;
      acknowledgeSync(pending.sent,pending.response);
    }
    async function privateDraft() {
      if(closed||api.isComposing?.()||!draftDirty||draftConflict)return;
      const local=api.snapshot(), sentGeneration=generation;
      try {const r=await API.put(url()+'/draft',{snapshot:local,expected_version:draftVersion});if(closed)return;draftVersion=r.version;draft={snapshot:local,version:r.version};if(generation===sentGeneration)draftDirty=false; if(!conflict)say('Draft backed up to server');}
      catch(err){if(err.status===409){draftConflict=true;say('Draft changed on another device · open History to review');draft=await API.get(url()+'/draft');}else throw err;}
    }
    async function acceptRoom(room) {
      if(api.isComposing?.())return;
      reconcilePendingSync();if(conflict)return;
      // Versions are monotonic within a document key. A delayed response cannot
      // roll the client back behind a newer write from this same session.
      if(room.version<version)return;
      peers=room.presence||peers;
      if(room.room_saved_revision && room.saved_revision!==room.room_saved_revision){showConflict(room.snapshot,room.version,'Saved template changed outside this session · review Shared');return;}
      if(!room.snapshot){base=api.snapshot();version=0;return;}
      if(!base) {
        const local=api.snapshot();base=clone(room.snapshot);version=room.version;
        // Opening a saved document adopts the current shared room before editing begins.
        if(!api.dirty()){if(!equal(api.snapshot(),room.snapshot) && (room.version>0 || room.saved_revision!==opts.getSavedRevision?.()))apply(room.snapshot);base=clone(room.snapshot);if(!equal(api.snapshot(),room.snapshot)) await sync();}
        else {const merged=merge(room.snapshot,local,room.snapshot);base=clone(room.snapshot);if(!equal(local,merged.snapshot))apply(merged.snapshot);}
      }else if(room.version!==version) {
        const merged=merge(base,api.snapshot(),room.snapshot);
        if(merged.conflicts.length){showConflict(room.snapshot,room.version);return;}
        const current=api.snapshot();base=clone(room.snapshot);version=room.version;
        if(!equal(current,merged.snapshot))apply(merged.snapshot);
      }
      if(room.saved_revision && (!room.room_saved_revision||room.saved_revision===room.room_saved_revision))opts.onSharedRevision?.(room.saved_revision);
    }
    async function sync() {
      reconcilePendingSync();
      if(!sharedEnabled||closed||paused||conflict||api.isComposing?.())return;
      const local=api.snapshot();if(base&&equal(local,base)&&version>0)return;
      const sent=clone(local);
      try {
        const response=await API.put(url()+'/room',{snapshot:sent,base:base||sent,expected_version:version,client_id:clientId});
        if(closed)return;
        // Do not replace DOM while text composition or a page drag is active, but
        // retain the successful write so our next poll does not mistake it for a peer.
        if(api.isComposing?.()){pendingSync={sent,response};return;}
        acknowledgeSync(sent,response);
      }catch(err){if(err.status===409)showConflict(err.data?.snapshot||null,err.data?.version||version,err.message);else throw err;}
    }
    async function tick() {
      if(closed||paused||busy||initializing||api.isComposing?.())return;busy=true;
      try {
        if(!connected)await connect();
        if(draftDirty)await privateDraft();
        if(sharedEnabled&&!paused&&!conflict){const room=await API.get(url()+'/room');if(closed)return;await acceptRoom(room);await sync();}
        peers=sharedEnabled?await API.post(url()+'/presence',{client_id:clientId}):[];
        if(peers.length>1&&!conflict&&!draftConflict)say(`${peers.length} editors · live session`);
      }finally{busy=false;}
    }
    async function connect() {
      const [backup,entries]=await Promise.all([API.get(url()+'/draft'),API.get('/templates/studio/library')]);if(closed)return;
      draft=backup;draftVersion=backup?.version||0;library=entries;
      if(sharedEnabled){api.markBlocks();await acceptRoom(await API.get(url()+'/room'));await sync();}
      else base=api.snapshot();
      connected=true;
      say(draft?'Server draft available in History':'Connected · server recovery ready');
    }
    const ready=(async()=>{
      try {await connect();}
      catch(err){say(err.message+' · using local recovery');throw err;}
      finally{initializing=false;if(!closed){api.render();heartbeat=setInterval(()=>{enqueue(tick).catch(err=>say(err.message+' · retrying; local edits preserved'));},2000);}}
    })();
    ready.catch(()=>{});
    function changed(){if(applying||closed)return;generation++;draftDirty=true;clearTimeout(timer);timer=setTimeout(()=>{enqueue(async()=>{await ready.catch(()=>{});await tick();}).catch(err=>say(err.message+' · local edits preserved'));},900);}
    function blockId(){const sel=window.getSelection();const el=sel?.anchorNode?.nodeType===3?sel.anchorNode.parentElement:sel?.anchorNode;return el?.closest?.('[data-doc-node]')?.dataset.docNode||'';}
    function button(text,fn){const b=document.createElement('button');b.type='button';b.textContent=text;b.onclick=()=>safely(enqueue(fn));return b;}
    function paragraph(text){const p=document.createElement('p');p.textContent=text;return p;}
    function renderInto(panel,tab) {
      if(!['History','Library','Shared'].includes(tab))return;
      const target=document.createElement('section');target.className='doc-shared-tools';target.style.cssText='display:flex;flex-direction:column;gap:9px;border-top:1px solid var(--border,#ddd);padding-top:12px';panel.append(target);
      if(tab==='History') {
        target.append(paragraph('Server recovery · available across devices'));
        if(draft)target.append(button('Recover my server draft',async()=>{apply(draft.snapshot);draftVersion=draft.version;draftDirty=true;draftConflict=false;conflict=null;changed();api.render();}));
        target.append(button('Refresh server recovery',async()=>{draft=await API.get(url()+'/draft');draftVersion=draft?.version||0;history=await API.get(url()+'/history');api.render();}));
        if(draftConflict)target.append(button('Replace server draft with my current work',async()=>{const latest=await API.get(url()+'/draft');draftVersion=latest?.version||0;draftConflict=false;draftDirty=true;await privateDraft();api.render();}));
        if(draft)target.append(button('Delete my server draft',async()=>{await API.del(url()+'/draft?version='+draft.version);draft=null;draftVersion=0;draftConflict=false;api.render();}));

        const active=target;API.get(url()+'/history').then(items=>{if(closed||!active.isConnected)return;history=items;active.querySelectorAll('[data-server-version]').forEach(n=>n.remove());items.forEach(item=>{const b=button('Saved version · '+formatDate(item.created_at),async()=>{apply(await API.get(url()+'/history/'+item.id));changed();api.render();});b.dataset.serverVersion=item.id;active.append(b);});}).catch(err=>{if(active.isConnected)active.append(paragraph(err.message));});
      }else if(tab==='Library') {
        target.append(paragraph('Company library · shared with this workspace'));
        const name=document.createElement('input');name.placeholder='Company style / logo / section name';name.setAttribute('aria-label','Company library entry name');target.append(name);
        const publish=typeof App!=='undefined'&&App.hasPermission?.('templates.company');
        if(publish){target.append(button('Publish selected style',async()=>{const el=api.selected();if(!el)throw Error('Select a text block first');const css=getComputedStyle(el),values={};['fontFamily','fontSize','fontWeight','color','backgroundColor','lineHeight','textAlign','padding','marginBottom'].forEach(k=>values[k]=css[k]);await API.post('/templates/studio/library',{kind:'style',name:name.value,value:{values}});library=await API.get('/templates/studio/library');api.render();}));
          target.append(button('Publish selected asset / section',async()=>{const el=api.selected();if(!el)throw Error('Select an object or block first');const root=document.createElement('div');root.append(el.cloneNode(true));await API.post('/templates/studio/library',{kind:'asset',name:name.value,value:{html:api.serialize(root)}});library=await API.get('/templates/studio/library');api.render();}));
          target.append(button('Publish brand colors & font',async()=>{const el=api.selected()||api.surface,css=getComputedStyle(el);await API.post('/templates/studio/library',{kind:'brand',name:name.value,value:{fontFamily:css.fontFamily,color:css.color}});library=await API.get('/templates/studio/library');api.render();}));}
        library.forEach(entry=>{const row=document.createElement('div');row.className='doc-layer';row.append(button(entry.kind+' · '+entry.name,async()=>{if(entry.kind==='asset')api.insert(api.sanitize(safeBody(entry.value.html||''),document));else{let el=api.selected()||api.surface.querySelector('.doc');if(!el){el=document.createElement('div');while(api.surface.firstChild)el.append(api.surface.firstChild);api.surface.append(el);}if(el.closest('[data-doc-locked="true"]'))throw Error('Unlock this object first');const values=entry.kind==='style'?entry.value.values:entry.value;const allowed=['fontFamily','fontSize','fontWeight','color','backgroundColor','lineHeight','textAlign','padding','marginBottom'];allowed.forEach(k=>{if(typeof values?.[k]==='string')el.style[k]=values[k];});api.change();}}));if(publish)row.append(button('Delete',async()=>{await API.del('/templates/studio/library/'+entry.id+'?version='+entry.version);library=await API.get('/templates/studio/library');api.render();}));target.append(row);});
        target.append(button('Refresh company library',async()=>{library=await API.get('/templates/studio/library');api.render();}));
      }else {
        target.append(paragraph(status),paragraph('Independent block edits sync every two seconds. Changes to the same block require review. Save publishes the shared working document.'));
        if(!sharedEnabled)target.append(paragraph('Save this new template before collaborating.'));
        peers.forEach(p=>target.append(paragraph(p.full_name+(p.client_id===clientId?' (you)':''))));
        if(conflict) {
          target.append(paragraph('Your local work is preserved in recovery. Review before replacing either version.'));
          const comparison=document.createElement('textarea');comparison.readOnly=true;comparison.setAttribute('aria-label','Shared document content for comparison');comparison.value=conflict.snapshot?.body||'The saved template changed outside this room.';target.append(comparison);
          if(conflict.snapshot){target.append(button('Use shared version',async()=>{apply(conflict.snapshot);base=clone(conflict.snapshot);version=conflict.version;conflict=null;changed();api.render();}));
            target.append(button('Keep my version for these conflicts',async()=>{const resolved=merge(conflict.base||base||conflict.snapshot,api.snapshot(),conflict.snapshot,true);apply(resolved.snapshot);base=clone(conflict.snapshot);version=conflict.version;conflict=null;changed();await sync();api.render();}));}
          target.append(button('Reload saved template into this session',async()=>{const room=await API.get(url()+'/room');const reset=await API.post(url()+'/reset',{expected_version:room.version});conflict=null;base=clone(reset.snapshot);version=reset.version;apply(reset.snapshot);opts.onSharedRevision?.(reset.saved_revision);api.render();}));
        }
        const input=document.createElement('textarea');input.placeholder='Comment on the selected block or document';input.setAttribute('aria-label','New document comment');target.append(input,button('Add comment',async()=>{await API.post(url()+'/comments',{body:input.value,block_id:blockId()});comments=await API.get(url()+'/comments');api.render();}));
        const list=document.createElement('div');list.style.cssText='display:flex;flex-direction:column;gap:10px';target.append(list);
        function drawComments(items){list.replaceChildren();items.forEach(c=>{const row=document.createElement('div');row.append(paragraph((c.full_name||'Former user')+' · '+formatDate(c.created_at)),paragraph(c.body));if(c.block_id)row.append(button('Go to block',async()=>{const el=api.surface.querySelector('[data-doc-node="'+c.block_id+'"]');if(el){el.scrollIntoView({block:'center'});el.focus();}else throw Error('This block was removed from the document');}));row.append(button(c.resolved?'Reopen':'Resolve',async()=>{await API.put(url()+'/comments/'+c.id,{resolved:!c.resolved});comments=await API.get(url()+'/comments');drawComments(comments);}));if(typeof App!=='undefined'&&c.created_by===App.getMe()?.id)row.append(button('Delete comment',async()=>{await API.del(url()+'/comments/'+c.id);comments=await API.get(url()+'/comments');drawComments(comments);}));list.append(row);});}
        drawComments(comments);API.get(url()+'/comments').then(items=>{if(!closed&&list.isConnected){comments=items;drawComments(items);}}).catch(err=>{if(list.isConnected)list.append(paragraph(err.message));});
      }
    }
    return {changed,renderInto,ready,get version(){return sharedEnabled?version:undefined;},
      prepareSave(){return enqueue(async()=>{await ready.catch(()=>{});if(closed)throw Error('This editor session is closed');if(!connected)await tick();if(conflict)throw Error('Resolve overlapping edits in Shared before saving');if(sharedEnabled){await acceptRoom(await API.get(url()+'/room'));await sync();if(conflict)throw Error('Resolve overlapping edits in Shared before saving');}paused=true;});},
      saved(unchanged){return enqueue(async()=>{try{const oldKey=documentKey;documentKey=opts.getDocumentKey?.()||opts.documentKey;sharedEnabled=/^(template|form):/.test(documentKey);
        if(oldKey!==documentKey){try{if(draftVersion)await API.del('/templates/studio/documents/'+encodeURIComponent(oldKey)+'/draft?version='+draftVersion);}catch{/* retain old draft if a newer device wrote it */}draftVersion=0;draft=null;base=null;version=0;pendingSync=null;}
        if(unchanged&&draftVersion){try{await API.del(url()+'/draft?version='+draftVersion);draftVersion=0;draft=null;draftDirty=false;clearTimeout(timer);}catch(err){say(err.message);}}
        if(sharedEnabled)await acceptRoom(await API.get(url()+'/room'));api.render();return unchanged && (!sharedEnabled || equal(api.snapshot(),base));}finally{paused=false;}});},
      failed(){paused=false;},
      close(){if(closed)return;clearTimeout(timer);clearInterval(heartbeat);if(draftDirty)privateDraft().catch(()=>{});if(sharedEnabled)API.del(url()+'/presence/'+clientId).catch(()=>{});closed=true;badge.remove();}
    };
  }
  return {mount,merge};
})();
if(typeof window!=='undefined')window.DocStudio=DocStudio;
if(typeof module!=='undefined'&&module.exports)module.exports={merge:DocStudio.merge};
