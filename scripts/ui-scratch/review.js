(function(){
  const $=s=>document.querySelector(s),esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const defaults={view:'out',compare:'both',size:'390x780',response:'normal',role:'adjust',count:'3',dark:false,long:false,finished:false,reserved:false,keyboard:false,ready:false,layout:'photos',photo:'normal',request:'inventory'};
  let selected={...defaults},generation=0;
  $('#intro').textContent=NOTES.scope;$('#isolation').textContent=NOTES.isolation;
  $('#decisions').innerHTML='<p>Try the <b>List / Photos</b> control inside the phone, change a quantity, move to another item and return. Use <b>Review 1 item</b> to reveal the blocked fuse. Try missing or slow photos and similar-looking parts in the fixture controls.</p><h3>Task and information order</h3><ul>'+NOTES.tasks.map(t=>'<li><b>'+esc(t.view)+':</b> '+esc(t.task)+' '+esc(t.hierarchy)+'</li>').join('')+'</ul><h3>Layout decisions</h3><ul>'+NOTES.decisions.map(s=>'<li>'+esc(s)+'</li>').join('')+'</ul><h3>State and action matrix</h3><dl>'+NOTES.states.map(s=>'<dt><b>'+esc(s.state)+'</b></dt><dd>'+esc(s.signal)+' '+esc(s.action)+'</dd>').join('')+'</dl>';
  $('#brief').innerHTML='<ol>'+NOTES.deeperWork.map(s=>'<li>'+esc(s)+'</li>').join('')+'</ol><p>'+esc(NOTES.brief)+'</p>';
  $('#provenance').innerHTML=(NOTES.research?'<h3>Animation references actually read</h3><ul>'+NOTES.research.map(r=>'<li><a href="'+esc(r.url)+'" target="_blank" rel="noopener">'+esc(r.title)+'</a>: '+esc(r.finding)+'</li>').join('')+'</ul>':'')+'<ul>'+NOTES.iterations.map(s=>'<li>'+esc(s)+'</li>').join('')+'</ul><p>Source commit: <code>'+esc(MANIFEST.sourceCommit)+'</code>. Comparison reference: <code>'+esc(MANIFEST.baselineRef)+'</code>. Generated from '+MANIFEST.sources.length+' source files. No duplicate hand-styled phone UI is maintained.</p><details><summary>Source paths and SHA-256 hashes</summary><pre>'+esc(JSON.stringify(MANIFEST.sources,null,2))+'</pre></details><details><summary>Preview runtime license</summary><pre>'+esc(PAYLOAD.notices)+'</pre></details>';
  function script(code){return '<script>'+code.replace(/<\/script/gi,'<\\/script')+'<\/script>';}
  function bootstrap(config){
    const scripts=PAYLOAD.scripts.map(s=>config.variant==='before'&&s.path==='public/mobile/modules/inventory/batch-move.js'?PAYLOAD.before:s.code);
    const start=async function(scripts){
      await window.__scratchReady;
      for(const code of scripts){const s=document.createElement('script');s.textContent=code;document.body.appendChild(s);}
      const unsupported=function(view){view.innerHTML='<section class="m-card"><h2>Outside this review</h2><p>This route keeps its real navigation path, but only the three batch views have fixture data. Use the preview controls to return to Batch Stock In or Out.</p></section>';};
      for(const name of ['home','work','clock','inbox','settings','notifications','queue','scan','requests','report-problem'])MApp.route(name,unsupported);
      document.getElementById('m-guide-start').onclick=function(){parent.postMessage({type:'scratch-guide'},'*');};
      const waitFor=async fn=>{for(let n=0;n<160;n++){if(fn())return;await new Promise(r=>setTimeout(r,50));}throw new Error('The source component did not become ready.');};
      const config=window.__SCRATCH_CONFIG__;
      if(config.request&&config.request!=='inventory')MApp.route('batch',function(view){mPreparationReview.open(view,{kind:config.request==='jo'?'jo':'so',ids:config.request==='jo'?[601,602]:[501]});});
      await waitFor(()=>document.querySelector('[data-batch-stage], .m-preparation-review .m-batch-viewbar, [data-no-permission]'));
      document.activeElement?.blur();window.__scratchBooted=true;parent.postMessage({type:'scratch-ready',variant:config.variant,generation:config.generation},'*');
    };
    return '<!doctype html><html lang="en" data-theme="'+(config.dark?'dark':'light')+'"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data: blob:; connect-src \'none\'; base-uri \'none\'; form-action \'none\'"><title>Isolated real batch component</title><style>'+PAYLOAD.css+'</style>'+script(PAYLOAD.database)+script('window.__SCRATCH_CONFIG__='+JSON.stringify(config)+';window.__SCRATCH_ASSETS__='+JSON.stringify(PAYLOAD.assets).replace(/</g,'\\u003c')+';'+PAYLOAD.fixtures)+'</head><body>'+PAYLOAD.body+script('('+start.toString()+')('+JSON.stringify(scripts).replace(/</g,'\\u003c')+').catch(e=>{window.__scratchError=e.message;parent.postMessage({type:"scratch-error",error:e.message},"*");})')+'</body></html>';
  }
  function sizing(){const[w,h]=selected.size.split('x').map(Number);document.querySelectorAll('iframe').forEach(f=>{f.style.width=w+'px';f.style.height=(selected.keyboard?Math.min(480,h):h)+'px';});$('#before-card').hidden=selected.compare==='after';}
  function render(){generation++;sizing();$('#status').textContent='Loading actual app code with disposable fixtures…';for(const variant of ['before','after'])$('#'+variant).srcdoc=bootstrap({...selected,variant,generation,layout:variant==='before'?'list':selected.layout});}
  for(const key of Object.keys(defaults)){const el=$('#'+key);if(!el)continue;el.addEventListener('change',()=>{selected[key]=el.type==='checkbox'?el.checked:el.value;if(key==='compare'||key==='size'||key==='keyboard'){sizing();return;}render();});}
  $('#reset').onclick=()=>{selected={...defaults};for(const k of Object.keys(defaults)){const el=$('#'+k);if(el.type==='checkbox')el.checked=selected[k];else el.value=selected[k];}render();};
  $('#reconnect').onclick=()=>{for(const id of ['before','after'])$('#'+id).contentWindow.__scratch?.reconnect();$('#status').textContent='Fixture transport restored. Use Check original requests for unresolved rows.';};
  $('#inspect').onclick=()=>{$('#ledger-output').textContent=JSON.stringify($('#after').contentWindow.__scratch?.inspect()||{},null,2);};
  window.addEventListener('message',e=>{if(![$('#before').contentWindow,$('#after').contentWindow].includes(e.source))return;if(e.data?.type==='scratch-ready'&&e.data.generation===generation)$('#status').textContent='Real source components ready. Every write stays inside this disposable preview.';if(e.data?.type==='scratch-guide'){$('#decisions').closest('details').open=true;$('#decisions').scrollIntoView({block:'start'});}if(e.data?.type==='scratch-error')$('#status').textContent='Preview error: '+e.data.error;});
  window.__scratchReview={reset:render,manifest:MANIFEST,settings:()=>({...selected}),generation:()=>generation,payload:PAYLOAD};render();
})();
