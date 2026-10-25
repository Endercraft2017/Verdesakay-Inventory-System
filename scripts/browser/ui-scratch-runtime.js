/* Preview-only transport/storage isolation. App HTML/CSS/JS is not rewritten. */
(function () {
  const state=window.__scratch;
  const storage=()=>{const entries=new Map();return {getItem:key=>entries.has(String(key))?entries.get(String(key)):null,setItem:(key,value)=>entries.set(String(key),String(value)),removeItem:key=>entries.delete(String(key)),clear:()=>entries.clear(),key:index=>[...entries.keys()][index]??null,get length(){return entries.size;}};};
  Object.defineProperty(window,'localStorage',{configurable:true,value:storage()});
  Object.defineProperty(window,'sessionStorage',{configurable:true,value:storage()});
  window.localStorage.setItem('vds_token','scratch-session-only');
  window.localStorage.setItem('vds_theme',state.theme);
  Object.defineProperty(navigator,'serviceWorker',{configurable:true,value:{controller:null,register:()=>Promise.reject(Error('Service workers disabled in scratch preview')),addEventListener(){}}});
  class OfflineSocket extends EventTarget {static CONNECTING=0;static OPEN=1;static CLOSING=2;static CLOSED=3;readyState=3;close(){}send(){throw Error('No socket in offline scratch preview');}}
  window.WebSocket=OfflineSocket;
  function report(event){window.parent.postMessage({type:'ui-scratch-event',...event},'*');}
  // Dynamic RoleUI markup still points at the app's original icon paths. Resolve
  // those paths to the exact bundled bytes without changing app component code.
  function resolveImage(image){const url=image.getAttribute('src'),asset=state.assets?.[url];if(asset){image.setAttribute('data-scratch-image-source',url);image.setAttribute('src',asset);}}
  function resolveImages(node){if(node.nodeType!==1)return;if(node.matches('img[src]'))resolveImage(node);node.querySelectorAll('img[src]').forEach(resolveImage);}
  new MutationObserver(records=>records.forEach(record=>{if(record.type==='attributes')resolveImage(record.target);else record.addedNodes.forEach(resolveImages);})).observe(document,{subtree:true,childList:true,attributes:true,attributeFilter:['src']});
  document.querySelectorAll('img[src]').forEach(resolveImage);
  const read=new Set();let readAll=false;
  const keyFor=value=>{const u=new URL(typeof value==='string'?value:value.url,'https://scratch.invalid');u.searchParams.sort();return u.pathname+u.search;};
  window.fetch=async function(input,options={}){
    const key=keyFor(input),method=(options.method||'GET').toUpperCase();
    const queue=/\/api\/(?:job-orders|qc|rts|production\/repairs|release-slips|orders|stock-count-tasks|tasks|me\/today|me\/approvals|me\/requests|me\/schedule|me\/time-corrections|hr\/clock\/my-status|users|inventory|locations)/.test(key);
    if(options.signal?.aborted)throw new DOMException('Cancelled','AbortError');
    if(state.network==='slow'&&queue)await new Promise((resolve,reject)=>{const timeout=setTimeout(resolve,2500);options.signal?.addEventListener('abort',()=>{clearTimeout(timeout);reject(new DOMException('Cancelled','AbortError'));},{once:true});});
    if(options.signal?.aborted)throw new DOMException('Cancelled','AbortError');
    let response;
    if(method==='POST'&&key==='/api/notifications/read-all'){readAll=true;response={status:200,body:{ok:true,unread:0}};}
    else if(method==='POST'&&/^\/api\/notifications\/\d+\/read$/.test(key)){read.add(Number(key.match(/\/(\d+)\/read/)[1]));response={status:200,body:{ok:true}};}
    else if(method==='PUT'&&key==='/api/mobile/quick-actions'){
      let ids;try{ids=JSON.parse(options.body).shortcuts;}catch{}
      const allowed=state.responses[key]?.body?.options||[];
      if(!Array.isArray(ids)||!ids.length||ids.length>3||new Set(ids).size!==ids.length)response={status:400,body:{error:'Choose up to three different work shortcuts.'}};
      else if(ids.some(id=>!allowed.includes(id)))response={status:403,body:{error:'This shortcut is not available with your sample access.'}};
      else {response={status:200,body:{shortcuts:ids,options:allowed}};state.responses[key]=structuredClone(response);}
    }
    else if(method!=='GET')response={status:409,body:{error:'Scratch preview: business writes are disabled. No live record was changed.'}};
    else if(state.network==='failed'&&queue)response={status:503,body:{error:'Simulated unavailable check. Use the preview controls to reconnect.'}};
    else response=state.responses[key]||{status:501,body:{error:'This destination was not captured in this Work preview. Return to Work; no live request was sent.'}};
    const body=structuredClone(response.body);
    if(method==='GET'&&key.startsWith('/api/notifications')){if(Array.isArray(body.items)){body.items=body.items.map(item=>readAll||read.has(item.id)?{...item,read_at:item.read_at||'now'}:item);if(key.includes('unread=1'))body.items=body.items.filter(item=>!item.read_at);}if(Number.isInteger(body.unread))body.unread=readAll?0:Math.max(0,body.unread-read.size);if(key==='/api/notifications/unread-count'&&Number.isInteger(body.count))body.count=readAll?0:Math.max(0,body.count-read.size);}
    report({method,path:key,status:response.status,simulated:true});
    return new Response(JSON.stringify(body),{status:response.status,headers:{'Content-Type':'application/json'}});
  };
  class OfflineXHR extends EventTarget {open(){}setRequestHeader(){}send(){report({method:'UPLOAD',path:'blocked',status:409,simulated:true});this.status=409;this.responseText=JSON.stringify({error:'Uploads are disabled in this offline scratch preview'});this.onload?.();}abort(){}getResponseHeader(){return 'application/json';}upload=new EventTarget();}
  window.XMLHttpRequest=OfflineXHR;
  window.addEventListener('error',event=>report({error:event.message}));
  window.addEventListener('unhandledrejection',event=>report({error:String(event.reason?.message||event.reason)}));
  window.addEventListener('hashchange',()=>report({route:location.hash}));
  window.addEventListener('message',event=>{if(event.source!==window.parent)return;if(event.data?.type==='ui-scratch-home')location.hash='#/work';else if(event.data?.type==='ui-scratch-sales')location.hash='#/sales';else if(event.data?.type==='ui-scratch-approvals')location.hash='#/approvals';});
})();
