/* Local retrieval of authored guides. No model, network calls, generated prose or saved queries. */
(function () {
  const STOP = new Set('a an the i we you our my me to for of in on at and or is are was be do does can could how what want need would like please help with it this that have has get some'.split(' '));
  const WORDS = {received:'receive',receiving:'receive',receipt:'receive',receipts:'receive',returned:'return',returning:'return',broken:'damage',damaged:'damage',damages:'damage',vendor:'supplier',vendors:'supplier',suppliers:'supplier',purchased:'purchase',purchasing:'purchase',bought:'purchase',buy:'purchase',buying:'purchase',liquidate:'liquidation',reimburse:'reimbursement',reimbursed:'reimbursement',repairing:'repair',repairs:'repair',finished:'finish',finishing:'finish',payments:'payment',paying:'pay',paid:'pay',counting:'count',counted:'count',employees:'employee'};
  const INTENTS = [
    {id:'customer-return', patterns:[/customer.*(?:return|damage|broken)/,/return.*customer/,/goods.*brought back/]},
    {id:'budgeted-purchase-request', patterns:[/budget/,/liquidat/,/cash advance/,/request.*(?:buy|purchase|spend)/,/internal.*purchase/,/reimburse/,/\b(?:buy|purchase)\b.*\b(?:tools|supplies|office)\b/]},
    {id:'legacy-unit-intake',patterns:[/pre.?system/,/legacy.*unit/,/(?:old|existing).*stock/,/unit.*before.*system/]},
    {id:'semi-finishing',patterns:[/semi.?built.*(?:finish|convert|assemble)/,/finish.*semi/,/semi.?finishing/]},
    {id:'physical-count',patterns:[/count.*(?:shelf|stock|physical)/,/stock.*(?:count|mismatch|difference)/,/cycle count/]},
    {id:'split-trips',patterns:[/courier/,/(?:multiple|another|second|several|partial).*trip/,/ship.*(?:truck|load)/,/deliver.*goods/]},
    {id:'ckd-sale',patterns:[/ckd/,/ship.*(?:kit|component|parts)/]},
    {id:'quality-to-rts',patterns:[/receive.*(?:production|finished|built)/,/rts/,/(?:qc|qa).*inspect/,/inspection.*fail/]},
    {id:'purchase-to-pay',patterns:[/receive.*supplier/,/supplier.*(?:arriv|deliver|receive)/,/vendor bill/,/pay.*supplier/]},
    {id:'payroll-correction',patterns:[/(?:fix|correct|change).*(?:pay|deduction)/,/(?:payroll|deduction).*correct/,/earlier.*cutoff/]},
    {id:'attendance-to-payroll',patterns:[/pay.*employee/,/generate.*pay/,/attendance.*pay/]},
    {id:'connected-invoice',patterns:[/invoice.*form/,/form.*(?:sales|sale|invoice)/,/submit.*invoice/]},
    {id:'notes-scheduler',patterns:[/remind/,/checklist/,/schedule.*task/]},
  ];
  function plain(html) { const el=document.createElement('div');el.innerHTML=String(html||'').replace(/<\/(?:p|div|li|h[1-6]|tr|section)>|<br\s*\/?>/gi,'$& ');return (el.textContent||'').replace(/\s+/g,' ').trim(); }
  function normalize(value) { return String(value||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim(); }
  function tokens(value) { return [...new Set(normalize(value).split(/\s+/).filter(t=>t&&!STOP.has(t)).map(t=>WORDS[t]||(t.length>4&&t.endsWith('s')&&!t.endsWith('ss')?t.slice(0,-1):t)))]; }
  function create(items, canUse = () => false) {
    const docs=[];
    for(const guide of items) {
      const original=guide.helpTopic?.workflow && items.find(p=>p.id===guide.helpTopic.workflow);
      if(original?.steps?.[0]?.body && plain(guide.helpTopic.html).includes(plain(original.steps[0].body)))continue;
      const steps=guide.steps?.length?guide.steps:[{title:guide.title,body:guide.helpTopic?.html||guide.intro||''}];
      steps.forEach((step,index)=>{
        const title=plain(guide.title), heading=plain(step.title), body=plain(step.body), before=plain(step.before), result=plain(step.result);
        docs.push({guide,step,index,title,heading,body,before,result, titleWords:new Set(tokens(title)),headingWords:new Set(tokens(heading)),words:new Set(tokens([title,heading,body,before,result,plain(step.tip),plain(step.branch?.body),plain(guide.tagline)].join(' ')))});
      });
    }
    const frequency=new Map();for(const d of docs)for(const t of d.words)frequency.set(t,(frequency.get(t)||0)+1);
    const ids=new Set(items.map(p=>p.id));
    function search(value) {
      const query=String(value||'').trim().slice(0,500), normalized=normalize(query), terms=tokens(query);
      if(!terms.length)return {query,results:[],choices:[],message:'Describe the task you want to do.'};
      let choices=[],needsClarification=false;
      if(/\breceive\b|\breceiving\b/.test(normalized)&&!/(supplier|vendor|production|finished|built|customer|return|pr|purchase|rts|legacy)/.test(normalized)) {
        needsClarification=true;choices=[['Supplier goods arriving','receive supplier goods','purchase-to-pay'],['Production output / RTS','receive finished production output','quality-to-rts'],['Customer goods returned','receive customer return','customer-return']];
      } else if(/^(pr|purchase request)$/.test(normalized)) {
        needsClarification=true;choices=[['Internal spending budget','request purchase budget','budgeted-purchase-request'],['Supplier goods receiving','receive supplier goods','purchase-to-pay']];
      }
      choices=choices.filter(c=>ids.has(c[2])).map(([label,query])=>({label,query}));
      if(needsClarification)return {query,results:[],choices,message:choices.length?'Which task do you mean?':'No matching receiving/request workflow is available in your current guide library.'};
      const intents=INTENTS.filter(x=>x.patterns.some(re=>re.test(normalized))).map(x=>x.id);
      const ranked=[];
      for(const d of docs) {
        let score=0,hits=0;
        for(const t of terms)if(d.words.has(t)){hits++;const idf=1+Math.log(1+docs.length/(1+(frequency.get(t)||0)));score+=idf*(d.headingWords.has(t)?3:d.titleWords.has(t)?2:1);}
        const intent=intents.includes(d.guide.id);
        if(!intent&&(hits===0||hits/terms.length<0.35))continue;
        if(intent)score+=24;
        // Start broad requests at their prerequisite checkpoint; explicit follow-up words
        // may select a later step. These hints choose authored text, never synthesize it.
        let preferred=-1;
        if(intent&&d.guide.id==='customer-return')preferred=/credit|refund/.test(normalized)?3:/repair|salvage|dispose|reject/.test(normalized)?2:0;
        if(intent&&d.guide.id==='budgeted-purchase-request')preferred=/close|change returned/.test(normalized)?4:/liquidat|receipt/.test(normalized)?3:/cash issued|cash hand/.test(normalized)?2:/approv/.test(normalized)?1:0;
        if(intent&&d.guide.id==='legacy-unit-intake')preferred=/sticker|stock in/.test(normalized)?3:/\bqa\b/.test(normalized)?2:/\bqc\b|inspect/.test(normalized)?1:0;
        if(d.index===preferred)score+=20;
        if(hits===0&&!intent)continue;
        const available=!!canUse(d.step,d.guide);
        score+=available?1.5:0;
        ranked.push({id:d.guide.id,title:d.title,stepTitle:d.heading,stepIndex:d.index,body:d.body,before:d.before,result:d.result,available,score,referenceOnly:!d.guide.steps?.length,matched:terms.filter(t=>d.words.has(t)),role:plain(d.step.role),screen:plain(d.step.to?.label)});
      }
      ranked.sort((a,b)=>b.score-a.score||a.stepIndex-b.stepIndex||a.id.localeCompare(b.id));
      const seen=new Set();const results=ranked.filter(r=>!seen.has(r.id)&&seen.add(r.id)).slice(0,5);
      return {query,results,choices:[],message:results.length?'Matching published instructions':'No close match. Try a specific task such as “receive supplier goods” or browse the guides below.'};
    }
    return {search};
  }
  function mount(root,{items,esc,onSelect,canUse}) {
    root.innerHTML='<section class="guide-retrieval" aria-label="Find instructions for your task"><form data-intent-form><label>What do you want to do?<input type="search" maxlength="500" data-intent-input placeholder="e.g. A customer returned a damaged unit" autocomplete="off"></label><button type="submit">Find instructions</button><button type="button" data-intent-clear>Clear</button></form><p class="guide-retrieval-note">Search published guide steps. No AI-generated instructions. Your question stays in this browser.</p><p data-intent-status role="status"></p><div data-intent-results></div></section>';
    const engine=create(items,canUse),input=root.querySelector('[data-intent-input]'),host=root.querySelector('[data-intent-results]'),status=root.querySelector('[data-intent-status]');
    function run(){const answer=engine.search(input.value);status.textContent=answer.message;
      host.innerHTML=answer.choices.length?answer.choices.map((c,i)=>`<button type="button" data-intent-choice="${i}">${esc(c.label)}</button>`).join(''):answer.results.map((r,i)=>`<article class="guide-retrieval-result"><h4>${esc(r.stepTitle)}</h4><p class="guide-retrieval-source">${esc(r.title)} · ${r.referenceOnly?'Screen guide':'Step '+(r.stepIndex+1)}</p><p>${esc(r.body.length>600?r.body.slice(0,600).trimEnd()+'…':r.body)}</p>${r.before?`<p><b>Before:</b> ${esc(r.before)}</p>`:''}${r.result?`<p><b>Result:</b> ${esc(r.result)}</p>`:''}<p class="guide-retrieval-access">${r.available?'Related screen available to your account':'Read the guide for context; this step may need another team or the webapp'}${r.role?' · '+esc(r.role):''}</p><button type="button" data-intent-select="${i}">Read this guide${r.referenceOnly?'':' at step '+(r.stepIndex+1)}</button></article>`).join('');
      host.querySelectorAll('[data-intent-choice]').forEach(b=>b.onclick=()=>{input.value=answer.choices[Number(b.dataset.intentChoice)].query;run();});
      host.querySelectorAll('[data-intent-select]').forEach(b=>b.onclick=()=>{const r=answer.results[Number(b.dataset.intentSelect)];onSelect(r.id,r.stepIndex);});
    }
    root.querySelector('[data-intent-form]').onsubmit=e=>{e.preventDefault();run();};
    root.querySelector('[data-intent-clear]').onclick=()=>{input.value='';host.innerHTML='';status.textContent='';input.focus();};
  }
  function mobileAccess(step,app) {
    const web={ 'production-receiving':'receiving','production-qc':'qc','job-orders':'job-orders',repairs:'repairs',releasing:'so','stock-counts':'stock-counts',inventory:'item','hr-requests':'requests','hr-approvals':'approvals',messages:'inbox',announcements:'announcements','production-record':'record',account:'settings' };
    if(step.to?.external){const match=step.to.external.match(/#\/([^?]+)/);return !!match&&app.canOpen(match[1]);}
    const route=web[step.to?.route];return !!route&&app.canOpen(route);
  }
  window.GuideSearch={create,mount,mobileAccess};
})();
