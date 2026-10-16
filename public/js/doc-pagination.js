/* Measure rendered content, then use the same physical sheets on screen and in print.
   Unsupported oversized atomic blocks retain native browser flow rather than losing content. */
const DocPagination = (() => {
  async function paginate(doc) {
    if(doc.documentElement.dataset.docPaginated==='true')return {pages:doc.querySelectorAll('.doc-paged-sheet').length,warnings:[]};
    if(doc.querySelector('.tiled-grid,.payslip-grid'))return {pages:0,warnings:['Grid documents use their existing fitted print layout.']};
    await doc.fonts?.ready;
    await Promise.all([...doc.images].filter(img=>!img.complete).map(img=>new Promise(resolve=>{const done=()=>{clearTimeout(timer);resolve();};const timer=setTimeout(done,2000);img.addEventListener('load',done,{once:true});img.addEventListener('error',done,{once:true});})));
    const setup=doc.querySelector('style[data-docpage]')?.textContent||'';
    const dimensions=setup.match(/size:\s*([\d.]+)mm\s+([\d.]+)mm/i),margin=setup.match(/margin:\s*([\d.]+)mm/i);
    let width=dimensions?+dimensions[1]:/letter/i.test(setup)?215.9:210,height=dimensions?+dimensions[2]:/letter/i.test(setup)?279.4:297;
    if(!dimensions&&/landscape/i.test(setup))[width,height]=[height,width];
    const m=margin?+margin[1]:14;
    if(!Number.isFinite(width+height+m)||width<=2*m||height<=2*m)return {pages:0,warnings:['Invalid page setup.']};
    let source=doc.querySelector('.doc-print-content');
    if(!source){source=doc.createElement('div');source.className='doc-print-content';while(doc.body.firstChild)source.append(doc.body.firstChild);doc.body.append(source);}
    if([...source.querySelectorAll('[data-doc-section]')].some(el=>Number(el.style.columnCount)>1))return {pages:0,warnings:['Column sections use native browser pagination. Print/PDF preserves their page setup and columns.']};
    const oldWidth=source.style.width;source.style.width=(width-2*m)+'mm';
    const view=doc.defaultView, warnings=[];
    const header=source.querySelector('.doc-running-header')?.textContent||'',footer=source.querySelector('.doc-running-footer')?.textContent||'',numbered=!!source.querySelector('.doc-page-number');
    const style=doc.createElement('style');style.dataset.docPagination='';style.textContent=`
      .doc-paged-document{margin:0 auto;display:block}
      .doc-paged-sheet{box-sizing:border-box!important;position:relative;isolation:isolate;width:${width}mm;height:${height}mm;padding:${m}mm;background:white;margin:0 auto 24px;box-shadow:0 2px 14px #0002;break-after:page;page-break-after:always}
      .doc-paged-sheet:last-child{break-after:auto;page-break-after:auto}
      .doc-page-flow{position:relative;isolation:isolate;box-sizing:border-box;width:100%;height:${height-2*m}mm;display:flow-root}
      .doc-page-running{position:absolute;left:${m}mm;right:${m}mm;text-align:center;font:10px Arial;color:#666;line-height:1.3}
      .doc-page-running.top{top:4mm}.doc-page-running.bottom{bottom:4mm}
      .doc-paged-document .doc-running-header,.doc-paged-document .doc-running-footer,.doc-paged-document .doc-page-number,.doc-paged-document .doc-pagebreak{display:none!important}
      @media print{html,body{padding:0!important;margin:0!important}.doc-paged-sheet{margin:0;box-shadow:none}.doc-paged-document{margin:0}}
    `;doc.head.append(style);
    const output=doc.createElement('div');output.className='doc-paged-document';source.after(output);
    const sheets=[],shellIds=new WeakMap();let shellSeq=0,current;
    let pageSetup={width,height,margin:m},pageStyleSeq=0;
    function newPage(){const sheet=doc.createElement('section');sheet.className='doc-paged-sheet';sheet.setAttribute('aria-label','Page '+(sheets.length+1));const flow=doc.createElement('div');flow.className='doc-page-flow';const cfg=pageSetup;sheet.style.width=cfg.width+'mm';sheet.style.height=cfg.height+'mm';sheet.style.padding=cfg.margin+'mm';flow.style.height=(cfg.height-2*cfg.margin)+'mm';if(cfg.width!==width||cfg.height!==height){const name='measuredsection'+(++pageStyleSeq);sheet.style.page=name;style.textContent+=`@page ${name}{size:${cfg.width}mm ${cfg.height}mm;margin:0}`;}sheet.append(flow);output.append(sheet);const page={sheet,flow,shells:new Map(),items:0};sheets.push(page);current=page;return page;}

    function container(shells){let parent=current.flow;for(const shell of shells){let id=shellIds.get(shell);if(!id){id=++shellSeq;shellIds.set(shell,id);}let copy=current.shells.get(id);if(!copy){copy=shell.cloneNode(false);copy.removeAttribute('id');copy.style.minHeight='0';copy.style.height='auto';copy.style.breakBefore='auto';copy.style.breakAfter='auto';copy.style.page='auto';parent.append(copy);current.shells.set(id,copy);}parent=copy;}return parent;}
    function overflows(){const rect=current.flow.getBoundingClientRect();return current.flow.scrollHeight>current.flow.clientHeight+1||[...current.flow.querySelectorAll('*')].some(el=>!el.closest('.doc-float')&&view.getComputedStyle(el).position!=='absolute'&&el.getBoundingClientRect().bottom>rect.bottom+1);}
    function removeEmptyShells(){[...current.shells.entries()].reverse().forEach(([id,el])=>{if(!el.childNodes.length){el.remove();current.shells.delete(id);}});}
    const items=[];
    function collect(node,shells=[]){
      if(node.nodeType===3){if(node.textContent.trim())items.push({node,shells});return;}
      if(node.nodeType!==1)return;
      if(node.matches('style,script,.doc-running-header,.doc-running-footer,.doc-page-number,[data-doc-hidden="true"]'))return;
      if(node.hasAttribute('data-doc-design-page')){items.push({node,shells,design:true});return;}
      if(node.hasAttribute('data-doc-section')){items.push({section:node});[...node.childNodes].forEach(child=>collect(child,[...shells,node]));items.push({sectionEnd:true});return;}
      if(node.matches('.doc-pagebreak')){items.push({break:true});return;}
      const css=view.getComputedStyle(node);
      if(css.display==='none')return;
      if(node.classList.contains('doc-float')){items.push({node,shells,float:true});return;}
      const blocks=[...node.children].filter(c=>/^(DIV|P|H[1-6]|TABLE|UL|OL|HEADER|FOOTER|SECTION|BLOCKQUOTE|FIGURE)$/.test(c.tagName));
      if(/^(DIV|SECTION|ARTICLE|MAIN)$/.test(node.tagName)&&blocks.length>1&&['block','flow-root',''].includes(css.display)&&(!css.columnCount||css.columnCount==='auto'||css.columnCount==='1')){[...node.childNodes].forEach(child=>collect(child,[...shells,node]));return;}
      items.push({node,shells});
    }
    [...source.childNodes].forEach(n=>collect(n));newPage();
    let unsupported=false;
    function appendNode(node,shells){const copy=node.cloneNode(true);container(shells).append(copy);return copy;}
    function splitText(node,shells){
      const walker=doc.createTreeWalker(node,4),texts=[];let text,total=0;
      while((text=walker.nextNode())){texts.push({node:text,start:total,end:total+text.length});total+=text.length;}
      if(!total)return false;
      function point(offset){const t=texts.find(t=>offset<=t.end)||texts.at(-1);return [t.node,Math.max(0,Math.min(t.node.length,offset-t.start))];}
      function fragment(start,end){const range=doc.createRange();range.setStart(...point(start));range.setEnd(...point(end));const copy=node.cloneNode(false);if(start)copy.removeAttribute('id');copy.append(range.cloneContents());return copy;}
      let start=0;
      while(start<total){let lo=start+1,hi=total,fit=start;const parent=container(shells);
        while(lo<=hi){const mid=Math.floor((lo+hi)/2),piece=fragment(start,mid);parent.append(piece);const fits=!overflows();piece.remove();if(fits){fit=mid;lo=mid+1;}else hi=mid-1;}
        if(fit===start){if(current.items){newPage();continue;}return false;}
        if(fit<total){const text=node.textContent;const boundary=text.lastIndexOf(' ',fit-1);if(boundary>start+Math.max(20,(fit-start)*.65))fit=boundary+1;}
        parent.append(fragment(start,fit));current.items++;start=fit;if(start<total)newPage();if(sheets.length>500)return false;
      }return true;
    }
    function splitTable(table,shells){
      const rows=[...table.rows].filter(r=>r.closest('table')===table&&!r.closest('thead,tfoot'));
      if(!rows.length)return false;
      const units=[];for(let i=0;i<rows.length;){let end=i+1;for(let j=i;j<end&&j<rows.length;j++){for(const cell of rows[j].cells){const span=cell.rowSpan===0?rows.filter(r=>r.parentNode===rows[j].parentNode).length-(rows.slice(0,j).filter(r=>r.parentNode===rows[j].parentNode).length):cell.rowSpan;end=Math.max(end,Math.min(rows.length,j+span));}}units.push(rows.slice(i,end));i=end;}
      let part,bodyMap,partRows=0;
      function nextPart(){part=table.cloneNode(false);part.removeAttribute('id');[...table.children].filter(c=>['CAPTION','COLGROUP','THEAD','TFOOT'].includes(c.tagName)).forEach(c=>part.append(c.cloneNode(true)));container(shells).append(part);bodyMap=new Map();partRows=0;}
      nextPart();
      for(const unit of units){const appended=[];const add=()=>unit.forEach(row=>{let body=bodyMap.get(row.parentNode);if(!body){body=row.parentNode.cloneNode(false);body.removeAttribute('id');part.append(body);bodyMap.set(row.parentNode,body);}const clone=row.cloneNode(true);body.append(clone);appended.push(clone);});add();
        if(overflows()){appended.forEach(r=>r.remove());if(partRows===0){part.remove();removeEmptyShells();}if(current.items||partRows){newPage();nextPart();appended.length=0;add();}else return false;if(overflows())return false;}
        partRows+=unit.length;current.items++;if(sheets.length>500)return false;
      }return true;
    }
    for(const item of items){
      if(item.section||item.sectionEnd){const n=item.section;const w=Number(n?.dataset.docSectionWidth)||width,h=Number(n?.dataset.docSectionHeight)||height,margin=n?.dataset.docSectionMargin!=null?Number(n.dataset.docSectionMargin):m;const valid=w>=50&&w<=1000&&h>=50&&h<=1000&&margin>=0&&margin<=100&&margin*2<Math.min(w,h);const next=valid?{width:w,height:h,margin}:{width,height,margin:m};const different=next.width!==pageSetup.width||next.height!==pageSetup.height||next.margin!==pageSetup.margin;pageSetup=next;if(current.items&&(different||n?.dataset.docSectionBreak==='page'))newPage();else if(!current.items){current.sheet.style.width=next.width+'mm';current.sheet.style.height=next.height+'mm';current.sheet.style.padding=next.margin+'mm';current.flow.style.height=(next.height-2*next.margin)+'mm';if(different){const name='measuredsection'+(++pageStyleSeq);current.sheet.style.page=name;style.textContent+=`@page ${name}{size:${next.width}mm ${next.height}mm;margin:0}`;}}continue;}
      if(item.design){if(current.items)newPage();const clone=appendNode(item.node,item.shells);clone.style.margin='0';clone.style.breakAfter='auto';clone.style.height=current.flow.style.height;current.sheet.style.backgroundColor=clone.dataset.docPageBg||clone.style.backgroundColor||'white';current.items++;if(overflows()){unsupported=true;warnings.push('Design page content extends beyond its paper. Native print flow preserves the content; adjust the design before exporting.');break;}continue;}
      if(item.break){if(current.items)newPage();continue;}
      if(item.float){const copy=appendNode(item.node,item.shells);const top=parseFloat(copy.style.top)||0;const units=copy.style.top.endsWith('mm')?1:copy.style.top.endsWith('px')?25.4/96:0;const pageIndex=units?Math.max(0,Math.floor((top*units+m)/height)):0;if(pageIndex>=sheets.length){while(sheets.length<=pageIndex)newPage();}const old=current;current=sheets[pageIndex];container(item.shells).append(copy);if(pageIndex)copy.style.top=(top*units-pageIndex*height)+'mm';current.items++;current=old;continue;}
      let copy=appendNode(item.node,item.shells);
      if(overflows()) {
        const height=copy.getBoundingClientRect().height;
        copy.remove();removeEmptyShells();
        if(height>current.flow.clientHeight && (item.node.tagName==='TABLE' || /^(P|H[1-6]|BLOCKQUOTE|DIV|LI)$/.test(item.node.tagName)&&!item.node.querySelector('table,img,svg'))){
          const ok=item.node.tagName==='TABLE'?splitTable(item.node,item.shells):splitText(item.node,item.shells);
          if(!ok){unsupported=true;break;}continue;
        }
        if(current.items){newPage();copy=appendNode(item.node,item.shells);}
        if(!copy.isConnected)copy=appendNode(item.node,item.shells);
        if(overflows()){
          copy.remove();removeEmptyShells();
          const ok=item.node.tagName==='TABLE'?splitTable(item.node,item.shells):/^(P|H[1-6]|BLOCKQUOTE|DIV|LI)$/.test(item.node.tagName)&&!item.node.querySelector('table,img,svg')?splitText(item.node,item.shells):false;
          if(!ok){unsupported=true;break;}
        }else current.items++;
      }else current.items++;
    }
    if(unsupported){output.remove();style.remove();source.style.width=oldWidth;return {pages:0,warnings:[...warnings,'An oversized image, merged table block, or complex layout needs native browser pagination. Content has been preserved.']};}
    while(sheets.length>1&&!sheets.at(-1).items)sheets.pop().sheet.remove();
    const pageRule=doc.createElement('style');pageRule.dataset.docPagination='';pageRule.textContent=`@page{size:${width}mm ${height}mm;margin:0;@top-center{content:none}@bottom-center{content:none}}`;output.append(pageRule);
    sheets.forEach((page,i)=>{if(header){const h=doc.createElement('div');h.className='doc-page-running top';h.style.left=h.style.right=page.sheet.style.padding;h.textContent=header;page.sheet.append(h);}if(footer||numbered){const f=doc.createElement('div');f.className='doc-page-running bottom';f.style.left=f.style.right=page.sheet.style.padding;f.textContent=footer+(numbered?(footer?' · ':'')+'Page '+(i+1)+' of '+sheets.length:'');page.sheet.append(f);} });
    const retainedStyles=[...source.querySelectorAll('style')].map(s=>s.cloneNode(true));source.replaceWith(...retainedStyles);doc.documentElement.dataset.docPaginated='true';
    output.querySelectorAll('[data-doc-toc-page]').forEach(slot=>{const heading=doc.getElementById(slot.dataset.docTocPage);const page=heading?.closest('.doc-paged-sheet');if(page)slot.textContent=String(sheets.findIndex(p=>p.sheet===page)+1);});

    doc.dispatchEvent(new view.CustomEvent('doc:paginated',{detail:{pages:sheets.length,warnings}}));return {pages:sheets.length,warnings};
  }
  return {paginate};
})();
if(typeof window!=='undefined')window.DocPagination=DocPagination;
