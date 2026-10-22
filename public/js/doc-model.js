/* Document-model foundation. Independently implemented for our HTML/template contract.
   Wordcraft's document/path model is the behavioral reference; see WORDCRAFT-PORT-PLAN.md. */
const DocModel = (() => {
  /** @typedef {{kind:'text',text:string}|{kind:'field',token:string,raw:string}|{kind:'comment',text:string}|{kind:'opaque',html:string}|{kind:'paragraph'|'run'|'list'|'listItem'|'table'|'tableGroup'|'row'|'cell'|'image'|'break'|'page'|'section'|'element',tag:string,attrs:Array<[string,string]>,children:Array<ModelNode>,repeat?:string}} ModelNode */
  /** @typedef {{kind:'document',version:1,children:Array<ModelNode>}} ModelDocument */
  /** @typedef {{path:Array<number>,offset:number}} TextPosition */
  /** @typedef {{anchor:TextPosition,focus:TextPosition}} ModelTextRange */
  const CHROME='.doc-float-handle,.doc-float-toolbar,.doc-promote-bar,.doc-snap-guide,.doc-page-guide';
  const RAW=new Set(['style','script','textarea','title']);
  const VOID=new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
  const DERIVED=['data-doc-toc','data-doc-toc-page','data-doc-note-ref','data-doc-note-number'];
  const PARAGRAPHS='p,h1,h2,h3,h4,h5,h6,li,blockquote';
  const kinds={p:'paragraph',h1:'paragraph',h2:'paragraph',h3:'paragraph',h4:'paragraph',h5:'paragraph',h6:'paragraph',blockquote:'paragraph',ul:'list',ol:'list',li:'listItem',table:'table',thead:'tableGroup',tbody:'tableGroup',tfoot:'tableGroup',tr:'row',td:'cell',th:'cell',img:'image',br:'break',span:'run',b:'run',strong:'run',i:'run',em:'run',u:'run',s:'run',sup:'run',sub:'run',ins:'run',del:'run',a:'run'};
  const escapeText=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  const escapeAttr=value=>escapeText(value).replaceAll('"','&quot;');
  const field=raw=>({kind:'field',raw,token:raw.slice(2,-2).trim()});

  /** Capture canonical data plus ephemeral DOM references. DOM references never enter saved data. */
  function capture(root,{editor=true,fieldMarker=null,ignoreNodes=null}={}) {
    const paths=new WeakMap(),refs=new Map();
    function read(node,path) {
      if(ignoreNodes?.has(node)||(node.nodeType===3&&!node.nodeValue))return null;
      paths.set(node,path);refs.set(JSON.stringify(path),node);
      if(node.nodeType===3)return {kind:'text',text:node.nodeValue};
      if(node.nodeType===8){
        if(fieldMarker&&node.data.startsWith(fieldMarker)){try{const raw=decodeURIComponent(node.data.slice(fieldMarker.length));if(/^\{\{[^}]+\}\}$/.test(raw))return field(raw);}catch{/* preserve malformed markers */}}
        if(editor&&node.data.startsWith('doc-block:')){try{return field('{{'+decodeURIComponent(node.data.slice(10))+'}}');}catch{/* preserve malformed markers */}}
        return {kind:'comment',text:node.data};
      }
      if(node.nodeType!==1)return null;
      if(editor&&node.matches(CHROME))return null;
      if(editor&&node.matches('.doc-chip'))return field('{{'+(node.getAttribute('data-token') || '')+'}}');
      if(node.namespaceURI!=='http://www.w3.org/1999/xhtml'){
        const html=fieldMarker?node.outerHTML.replace(new RegExp('<!--'+fieldMarker+'([^]*?)-->','g'),(marker,encoded)=>{try{return decodeURIComponent(encoded);}catch{return marker;}}):node.outerHTML;
        return {kind:'opaque',html};
      }
      const tag=node.localName,attrs=[...node.attributes].filter(a=>!editor || (a.name!=='contenteditable' && a.name!=='data-var-src' && !(tag==='tr'&&a.name==='data-repeat'))).map(a=>[a.name,a.value]);
      const classes=attrs.find(a=>a[0]==='class');
      if(editor&&classes){const transient=new Set(['cell-sel']);if(node.matches('.doc-float'))['selected','behind-text','multi','editing'].forEach(c=>transient.add(c));if(node.matches('tr[data-repeat="items"]'))transient.add('is-repeat');classes[1]=classes[1].split(/\s+/).filter(c=>c&&!transient.has(c)).join(' ');}
      if(editor&&node.hasAttribute('data-var-src')){const src=attrs.find(a=>a[0]==='src');if(src)src[1]='{{'+node.getAttribute('data-var-src')+'}}';}
      const result={kind:node.hasAttribute('data-doc-design-page')?'page':node.hasAttribute('data-doc-section')?'section':kinds[tag] || 'element',tag,attrs,children:[]};
      if(editor&&node.matches('tr[data-repeat="items"]'))result.repeat='items';
      for(const child of node.childNodes){const value=read(child,[...path,result.children.length]);if(value)result.children.push(value);}
      return result;
    }
    const document={kind:'document',version:1,children:[]};
    for(const child of root.childNodes){const value=read(child,[document.children.length]);if(value)document.children.push(value);}
    return {document,paths,refs};
  }
  /** Field comments keep control tokens inside table groups instead of HTML foster parenting. */
  function fromHtml(html,ownerDocument) {
    const box=ownerDocument.createElement('div'),fieldMarker='doc-model-field-'+Math.random().toString(36).slice(2)+':';let rawTag='';
    box.innerHTML=String(html).replace(/(<!--[\s\S]*?-->|<(?:[^>"']|"[^"]*"|'[^']*')*>)|\{\{[^}]+\}\}/g,(match,tag)=>{
      if(tag){const parsed=tag.match(/^<\s*(\/?)\s*([\w-]+)/);if(parsed){const name=parsed[2].toLowerCase();if(rawTag){if(parsed[1]&&name===rawTag)rawTag='';}else if(RAW.has(name)&&!parsed[1])rawTag=name;}return tag;}
      return rawTag?match:'<!--'+fieldMarker+encodeURIComponent(match).replaceAll('-','%2D')+'-->';
    });
    return capture(box,{editor:false,fieldMarker}).document;
  }
  function toHtml(document) {
    function write(node,raw=false) {
      if(node.kind==='text')return raw?node.text:escapeText(node.text);
      if(node.kind==='field')return node.raw;
      if(node.kind==='comment')return '<!--'+node.text+'-->';
      if(node.kind==='opaque')return node.html;
      const attrs=node.attrs.map(([key,value])=>' '+key+'="'+escapeAttr(value)+'"').join('');
      const html='<'+node.tag+attrs+'>'+(VOID.has(node.tag)?'':node.children.map(child=>write(child,RAW.has(node.tag))).join('')+'</'+node.tag+'>');
      return node.repeat?'{{#'+node.repeat+'}}'+html+'{{/'+node.repeat+'}}':html;
    }
    return document.children.map(node=>write(node)).join('');
  }
  function at(document,path){let node=document;for(const index of path){node=node.children?.[index];if(!node)return null;}return node;}
  // Split CSS statements without damaging semicolons in quoted values or URLs.
  function setStyleProperty(style,property,value) {
    const parts=[];let start=0,depth=0,quote='',comment=false;
    for(let i=0;i<style.length;i++){
      const ch=style[i];if(comment){if(ch==='*'&&style[i+1]==='/'){comment=false;i++;}continue;}
      if(quote){if(ch==='\\'){i++;continue;}if(ch===quote)quote='';continue;}
      if(ch==='/'&&style[i+1]==='*'){comment=true;i++;continue;}
      if(ch==='"'||ch==="'"){quote=ch;continue;}if(ch==='(')depth++;else if(ch===')')depth=Math.max(0,depth-1);
      else if(ch===';'&&!depth){parts.push(style.slice(start,i));start=i+1;}
    }
    parts.push(style.slice(start));
    return parts.filter(p=>p.trim()&&p.replace(/\/\*[\s\S]*?\*\//g,'').trim().split(':')[0].trim().toLowerCase()!==property).join(';')+';'+property+':'+value;
  }
  /** Pure immutable model command; locked ancestors are rejected and unsupported paths remain intact. */
  function alignParagraphs(document,paths,value) {
    if(!['left','center','right','justify'].includes(value))throw new Error('Invalid paragraph alignment');
    const next=JSON.parse(JSON.stringify(document)),changes=[];
    for(const path of paths){
      const node=at(next,path);if(!node||!['paragraph','listItem'].includes(node.kind))continue;
      const locked=path.some((_,i)=>at(next,path.slice(0,i+1))?.attrs?.some(([k,v])=>k==='data-doc-locked'&&v==='true'));
      if(locked)throw new Error('This paragraph is locked');
      const before=JSON.parse(JSON.stringify(node.attrs));let style=node.attrs.find(a=>a[0]==='style');
      if(!style){style=['style',''];node.attrs.push(style);}style[1]=setStyleProperty(style[1],'text-align',value);
      changes.push({path,before,after:node.attrs});
    }
    return {document:next,changes};
  }
  function selectedParagraphs(root,selection) {
    if(!selection?.rangeCount || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode))return null;
    const range=selection.getRangeAt(0),element=n=>n.nodeType===3?n.parentElement:n;
    const start=element(range.startContainer)?.closest?.(PARAGRAPHS),end=element(range.endContainer)?.closest?.(PARAGRAPHS);
    const blocks=range.collapsed?(start&&root.contains(start)?[start]:[]):[...root.querySelectorAll(PARAGRAPHS)].filter(el=>{
      if(!range.intersectsNode(el) || [...el.querySelectorAll(PARAGRAPHS)].some(child=>range.intersectsNode(child)))return false;
      if(el===end && el!==start){const prefix=range.cloneRange();prefix.selectNodeContents(el);prefix.setEnd(range.endContainer,range.endOffset);if(!prefix.toString()&&!prefix.cloneContents().querySelector('img,.doc-chip,input,br'))return false;}
      return true;
    });
    return blocks;
  }
  function alignmentActive(root,selection,value){const blocks=selectedParagraphs(root,selection);return !!blocks?.length && blocks.every(el=>{const align=root.ownerDocument.defaultView.getComputedStyle(el).textAlign;return (align==='start'||!align?'left':align==='end'?'right':align)===value;});}
  function alignSelection(root,selection,value){
    const blocks=selectedParagraphs(root,selection);if(!blocks?.length)return null;
    const captured=capture(root),result=alignParagraphs(captured.document,blocks.map(el=>captured.paths.get(el)),value);
    // Patch attributes in place. Text nodes, selection direction and field islands stay live.
    for(const change of result.changes){const el=captured.refs.get(JSON.stringify(change.path));const style=change.after.find(a=>a[0]==='style');el.setAttribute('style',style[1]);}
    return result.changes.length>0;
  }
  /** Text positions are structural paths plus UTF-16 offsets; field/opaque nodes are atomic. */
  function comparePosition(a,b){for(let i=0;i<Math.min(a.path.length,b.path.length);i++)if(a.path[i]!==b.path[i])return a.path[i]-b.path[i];return a.path.length-b.path.length || a.offset-b.offset;}
  function validatePosition(document,point){
    if(!point||!Array.isArray(point.path)||!point.path.every(i=>Number.isInteger(i)&&i>=0))throw new Error('Invalid text position');
    const node=at(document,point.path),offset=point.offset;
    if(!['text','field'].includes(node?.kind)||!Number.isInteger(offset)||offset<0||offset>(node.kind==='field'?1:node.text.length))throw new Error('Invalid text position');
    if(node.kind==='text'&&offset>0&&offset<node.text.length&&/[\uD800-\uDBFF]/.test(node.text[offset-1])&&/[\uDC00-\uDFFF]/.test(node.text[offset]))throw new Error('Text position splits a Unicode character');
  }
  function validateInline(property,value){
    if(property==='font-weight'&&!['bold','normal'].includes(value))throw new Error('Invalid font weight');
    if(property==='font-style'&&!['italic','normal'].includes(value))throw new Error('Invalid font style');
    if(property==='font-family'&&(!/^[\p{L}\p{N}\s,'"._-]{1,150}$/u.test(value)))throw new Error('Invalid font family');
    if(property==='font-size'&&(!/^\d+(\.\d+)?pt$/.test(value)||parseFloat(value)<1||parseFloat(value)>400))throw new Error('Invalid font size');
    if(['color','background-color'].includes(property)&&!/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(value))throw new Error('Invalid text color');
    if(property==='vertical-align'&&!['super','sub'].includes(value))throw new Error('Invalid script');
    if(property==='text-decoration-line'&&!['underline','line-through','underline line-through'].includes(value))throw new Error('Invalid text decoration');
    if(!['font-weight','font-style','font-family','font-size','color','background-color','text-decoration-line','vertical-align'].includes(property))throw new Error('Unsupported inline format');
  }
  /** Immutable selected-run command. Existing inline ancestors/attributes are retained. */
  function formatTextRange(document,range,property,value){
    validateInline(property,value);if(!range?.anchor||!range?.focus)throw new Error('Invalid text range');validatePosition(document,range.anchor);validatePosition(document,range.focus);
    const [start,end]=comparePosition(range.anchor,range.focus)<=0?[range.anchor,range.focus]:[range.focus,range.anchor];
    const next=JSON.parse(JSON.stringify(document)),changes=[];
    function walk(node,path,locked=false,skip=false){
      const attrs=node.attrs || [],attribute=name=>attrs.find(a=>a[0]===name)?.[1];
      locked ||= attribute('data-doc-locked')==='true';
      skip ||= DERIVED.some(key=>attrs.some(([k])=>k===key))||attribute('data-doc-hidden')==='true'||RAW.has(node.tag)||node.kind==='opaque'||(node.tag==='del'&&attribute('data-doc-change'))||/\bdoc-checkbox\b/.test(attribute('class') || '');
      if(skip)return;
      if(node.kind==='text'||node.kind==='field'){
        if(node.kind==='field'&&/^[#/]/.test(node.token))return;
        const length=node.kind==='field'?1:node.text.length;
        const a=path.join(',')===start.path.join(',')?start.offset:0,b=path.join(',')===end.path.join(',')?end.offset:length;
        if(comparePosition({path,offset:length},start)<=0||comparePosition({path,offset:0},end)>=0||b<=a)return;
        if(locked)throw new Error('Selected text is locked');
        const parentPath=path.slice(0,-1),parent=at(next,parentPath),owned=parent?.tag==='span'&&parent.attrs.some(([k,v])=>k==='data-doc-run'&&v==='inline')&&parent.children.length===1;
        if(property!=='vertical-align'&&owned&&a===0&&b===length){
          let style=parent.attrs.find(a=>a[0]==='style');if(!style){style=['style',''];parent.attrs.push(style);}let desired=value;if(property==='text-decoration-line'){const previous=style[1].match(/(?:^|;)\s*text-decoration(?:-line)?\s*:\s*([^;]+)/i)?.[1] || '';desired=[...new Set((previous+' '+value).trim().split(/\s+/))].filter(t=>['underline','line-through','overline'].includes(t)).join(' ');}style[1]=setStyleProperty(style[1],property,desired);
          changes.push({type:'attributes',path:parentPath,attrs:parent.attrs});return;
        }
        const run={kind:'run',tag:property==='vertical-align'?(value==='super'?'sup':'sub'):'span',attrs:[['data-doc-run','inline'],['style',property+':'+value]],children:[node.kind==='field'?node:{kind:'text',text:node.text.slice(a,b)}]};
        const parts=[];if(a)parts.push({kind:'text',text:node.text.slice(0,a)});parts.push(run);if(b<length)parts.push({kind:'text',text:node.text.slice(b)});
        changes.push({type:'text',path,parts});return;
      }
      node.children?.forEach((child,i)=>walk(child,[...path,i],locked,skip));
    }
    // Resolve all paths before splicing. Reverse order keeps sibling path indices stable.
    walk(next,[]);
    for(const change of [...changes].reverse())if(change.type==='text'){const parent=at(next,change.path.slice(0,-1));parent.children.splice(change.path.at(-1),1,...change.parts);}
    return {document:next,changes};
  }
  function editableText(root,range){
    const texts=[],walker=root.ownerDocument.createTreeWalker(root,5);let node;
    while((node=walker.nextNode())){
      if(node.nodeType===1){
        if(!node.matches('.doc-chip')||/^[#/]/.test(node.dataset.token || '')||node.namespaceURI!=='http://www.w3.org/1999/xhtml'||node.closest(CHROME+',svg,math,.doc-checkbox,[data-doc-toc],[data-doc-toc-page],[data-doc-note-ref],[data-doc-note-number],.doc-page-number,[data-doc-hidden="true"],del[data-doc-change]'))continue;
        const bounds=root.ownerDocument.createRange();bounds.selectNode(node);
        if(range.compareBoundaryPoints(0,bounds)<=0&&range.compareBoundaryPoints(2,bounds)>=0)texts.push({node,start:0,end:1,atomic:true});
        continue;
      }
      if(!node.length||node.parentElement.closest('svg,math')||node.parentElement.namespaceURI!=='http://www.w3.org/1999/xhtml'||node.parentElement.closest(CHROME+',.doc-chip,.doc-checkbox,[data-doc-toc],[data-doc-toc-page],[data-doc-note-ref],[data-doc-note-number],.doc-page-number,style,script,textarea,title,del[data-doc-change],[data-doc-hidden="true"]'))continue;
      if(!range.intersectsNode(node))continue;
      const start=range.startContainer===node?range.startOffset:0,end=range.endContainer===node?range.endOffset:node.length;
      if(end>start)texts.push({node,start,end});
    }
    return texts;
  }
  /** Bold/italic active state resolved against inherited browser CSS. */
  function inlineActive(root,selection,property){
    if(!['font-weight','font-style'].includes(property))return null;
    if(!selection?.rangeCount||!root.contains(selection.anchorNode)||!root.contains(selection.focusNode))return null;
    const range=selection.getRangeAt(0);if(range.collapsed){const el=range.startContainer.nodeType===3?range.startContainer.parentElement:range.startContainer;const css=root.ownerDocument.defaultView.getComputedStyle(el);return property==='font-weight'?css.fontWeight==='bold'||Number(css.fontWeight)>=600:css.fontStyle==='italic';}
    const texts=editableText(root,range);if(!texts.length)return false;
    return texts.every(({node})=>{const css=root.ownerDocument.defaultView.getComputedStyle(node.parentElement);return property==='font-weight'?css.fontWeight==='bold'||Number(css.fontWeight)>=600:css.fontStyle==='italic';});
  }
  /** Toolbar readout. null means mixed values; field labels use their containing text style. */
  function inlineValue(root,selection,property){
    if(!selection?.rangeCount||!root.contains(selection.anchorNode)||!root.contains(selection.focusNode))return '';
    if(property==='paragraph-style'){const values=(selectedParagraphs(root,selection)||[]).map(block=>/^h[1-6]$/.test(block.localName)?block.localName:'p');return values.length&&values.every(value=>value===values[0])?values[0]:values.length?null:'p';}
    const range=selection.getRangeAt(0);let nodes;
    if(range.collapsed){let node=range.startContainer;if(node.nodeType===1){const child=node.childNodes[Math.min(range.startOffset,node.childNodes.length-1)];if(child)node=child;}const el=node.nodeType===3?node.parentElement:node;nodes=[el.closest('.doc-chip')?.parentElement || el];}
    else nodes=editableText(root,range).map(item=>item.node.parentElement);
    const values=nodes.map(el=>{const css=root.ownerDocument.defaultView.getComputedStyle(el);if(property==='font-size'){const value=css.fontSize;return value?Number((parseFloat(value)*(value.endsWith('pt')?1:.75)).toFixed(2))+'pt':'';}return css.getPropertyValue(property);});
    return values.length&&values.every(value=>value===values[0])?values[0]:null;
  }
  /** Marker bookmarks restore exact range boundaries/direction after selected text is split. */
  function formatSelection(root,selection,property,value){
    if(!selection?.rangeCount||!root.contains(selection.anchorNode)||!root.contains(selection.focusNode))return null;
    const original=selection.getRangeAt(0).cloneRange();if(original.collapsed)return null;
    if(!editableText(root,original).length)return false;
    for(const [node,offset] of [[original.startContainer,original.startOffset],[original.endContainer,original.endOffset]])if(node.nodeType===3&&offset>0&&offset<node.length&&/[\uD800-\uDBFF]/.test(node.data[offset-1])&&/[\uDC00-\uDFFF]/.test(node.data[offset]))throw new Error('Text position splits a Unicode character');
    validateInline(property,value);
    const backwards=selection.anchorNode===original.endContainer&&selection.anchorOffset===original.endOffset;
    const start=root.ownerDocument.createComment('doc-inline-start'),end=root.ownerDocument.createComment('doc-inline-end');
    const startNode=original.startContainer,startOffset=original.startOffset;const endRange=original.cloneRange();endRange.collapse(false);endRange.insertNode(end);const startRange=root.ownerDocument.createRange();startRange.setStart(startNode,startOffset);startRange.collapse(true);startRange.insertNode(start);
    const markerParents=new Set([start.parentNode,end.parentNode]);
    try{
      const range=root.ownerDocument.createRange();range.setStartAfter(start);range.setEndBefore(end);
      const texts=editableText(root,range),captured=capture(root,{ignoreNodes:new Set([start,end])});
      if(!texts.length)return false;
      const first=texts[0],last=texts.at(-1),modelRange={anchor:{path:captured.paths.get(first.node),offset:first.start},focus:{path:captured.paths.get(last.node),offset:last.end}};
      const result=formatTextRange(captured.document,modelRange,property,value);
      for(const change of result.changes){
        const node=captured.refs.get(JSON.stringify(change.path));
        if(change.type==='attributes'){node.setAttribute('style',change.attrs.find(a=>a[0]==='style')[1]);continue;}
        const fragment=root.ownerDocument.createDocumentFragment();
        for(const part of change.parts){if(part.kind==='text')fragment.append(root.ownerDocument.createTextNode(part.text));else{const span=root.ownerDocument.createElement(part.tag);part.attrs.forEach(([k,v])=>span.setAttribute(k,v));if(part.children[0].kind!=='field')span.textContent=part.children[0].text;fragment.append(span);}}
        if(node.nodeType===1){const span=fragment.firstChild;node.before(fragment);span.append(node);}else node.replaceWith(fragment);
      }
      return result.changes.length>0;
    }finally{
      const restored=root.ownerDocument.createRange();restored.setStartAfter(start);restored.setEndBefore(end);
      if(backwards)selection.setBaseAndExtent(restored.endContainer,restored.endOffset,restored.startContainer,restored.startOffset);else{selection.removeAllRanges();selection.addRange(restored);}
      end.remove();start.remove();markerParents.forEach(parent=>parent?.normalize());
    }
  }
  function ownDecoration(el,token){
    if(el.matches('ins[data-doc-change],del[data-doc-change]'))return false;
    const explicit=el.style.textDecorationLine||el.style.textDecoration;
    if(explicit)return explicit.split(/\s+/).includes(token);
    if(token==='underline'?el.tagName==='U':['S','STRIKE','DEL'].includes(el.tagName))return true;
    const css=el.ownerDocument.defaultView.getComputedStyle(el);return (css.textDecorationLine||css.textDecoration).split(/\s+/).includes(token);
  }
  function decorationAt(root,node,token){
    for(let el=node.nodeType===3?node.parentElement:node;el&&el!==root;el=el.parentElement){
      if(el.matches('ins[data-doc-change],del[data-doc-change]'))continue;
      const css=root.ownerDocument.defaultView.getComputedStyle(el);
      if(ownDecoration(el,token)||(css.textDecorationLine||css.textDecoration).split(/\s+/).includes(token))return true;
    }
    return false;
  }
  function decorationActive(root,selection,token){
    if(!selection?.rangeCount||!root.contains(selection.anchorNode)||!root.contains(selection.focusNode))return null;
    if(selection.isCollapsed)return decorationAt(root,selection.anchorNode,token);
    const units=editableText(root,selection.getRangeAt(0));return !!units.length&&units.every(item=>decorationAt(root,item.node,token));
  }
  /** Remove inline decoration structurally: descendants cannot cancel ancestor paint with CSS. */
  function formatDecoration(root,selection,token,on){
    if(!['underline','line-through'].includes(token))throw new Error('Invalid decoration');
    if(!selection?.rangeCount||selection.isCollapsed||!root.contains(selection.anchorNode)||!root.contains(selection.focusNode))return null;
    if(on)return formatSelection(root,selection,'text-decoration-line',token);
    const original=selection.getRangeAt(0).cloneRange(),initial=editableText(root,original);
    if(!initial.length)return false;
    for(const [node,offset] of [[original.startContainer,original.startOffset],[original.endContainer,original.endOffset]])if(node.nodeType===3&&offset>0&&offset<node.length&&/[\uD800-\uDBFF]/.test(node.data[offset-1])&&/[\uDC00-\uDFFF]/.test(node.data[offset]))throw new Error('Text position splits a Unicode character');
    // Keep the native adapter for block decorations until block-run projection exists.
    for(const {node} of initial){
      if(node.parentElement.closest('[data-doc-locked="true"]'))throw new Error('Selected text is locked');
      for(let el=node.parentElement;el&&el!==root;el=el.parentElement){
        if(el.matches('ins[data-doc-change],del[data-doc-change]'))continue;
        const css=root.ownerDocument.defaultView.getComputedStyle(el),paint=(css.textDecorationLine||css.textDecoration).split(/\s+/).includes(token);
        if((ownDecoration(el,token)||paint)&&el.matches(PARAGRAPHS+',div,section,td,th'))return null;
      }
    }
    const backwards=selection.anchorNode===original.endContainer&&selection.anchorOffset===original.endOffset;
    const start=root.ownerDocument.createComment('doc-decor-start'),end=root.ownerDocument.createComment('doc-decor-end');
    const startNode=original.startContainer,startOffset=original.startOffset;const tail=original.cloneRange();tail.collapse(false);tail.insertNode(end);const head=root.ownerDocument.createRange();head.setStart(startNode,startOffset);head.collapse(true);head.insertNode(start);
    const clones=[],parents=new Set([start.parentNode,end.parentNode]);let changed=false;
    try{
      const range=root.ownerDocument.createRange();range.setStartAfter(start);range.setEndBefore(end);
      for(const {node} of editableText(root,range)){
        let highest=null;for(let el=node.parentElement;el&&el!==root&&!el.matches(PARAGRAPHS+',div,section,td,th');el=el.parentElement)if(ownDecoration(el,token))highest=el;
        if(!highest)continue;
        const stop=highest.parentNode,focus=root.ownerDocument.createElement('span');focus.dataset.docRun='inline';node.before(focus);focus.append(node);let child=focus;
        while(child.parentNode!==stop){
          let parent=child.parentElement;
          const side=()=>{const clone=parent.cloneNode(false);clone.removeAttribute('id');clone.removeAttribute('data-doc-node');clones.push(clone);return clone;};
          if(child.previousSibling){const before=side();while(parent.firstChild!==child)before.append(parent.firstChild);parent.before(before);}
          if(child.nextSibling){const after=side();while(child.nextSibling)after.append(child.nextSibling);parent.after(after);}
          if(ownDecoration(parent,token)){
            const computed=parent.ownerDocument.defaultView.getComputedStyle(parent),remaining=(parent.style.textDecorationLine||parent.style.textDecoration||computed.textDecorationLine||computed.textDecoration).split(/\s+/).filter(word=>word!==token&&['underline','line-through','overline'].includes(word)).join(' ');
            const semantic=token==='underline'?parent.tagName==='U':['S','STRIKE','DEL'].includes(parent.tagName);
            if(semantic){const replacement=root.ownerDocument.createElement('span');for(const attr of parent.attributes)replacement.setAttribute(attr.name,attr.value);replacement.append(...parent.childNodes);parent.replaceWith(replacement);parent=replacement;}
            for(const property of ['text-decoration','text-decoration-line']){
              const value=parent.style.getPropertyValue(property);if(value){const next=value.split(/\s+/).filter(word=>word!==token).join(' ');parent.style.setProperty(property,next||'none');}
            }
            parent.style.textDecorationLine=remaining||'none';
          }
          child=parent;
        }
        changed=true;
      }
      return changed;
    }finally{
      const range=root.ownerDocument.createRange();range.setStartAfter(start);range.setEndBefore(end);if(backwards)selection.setBaseAndExtent(range.endContainer,range.endOffset,range.startContainer,range.startOffset);else{selection.removeAllRanges();selection.addRange(range);}
      end.remove();start.remove();for(const clone of clones)if(!clone.hasChildNodes())clone.remove();parents.forEach(parent=>parent?.normalize());
    }
  }
  /** Resolve committed composition text backwards from its final caret, across inline boundaries. */
  function rangeBeforeCaret(root,selection,length){
    if(!selection?.isCollapsed||!Number.isInteger(length)||length<=0||!root.contains(selection.anchorNode))return null;
    const el=selection.anchorNode.nodeType===3?selection.anchorNode.parentElement:selection.anchorNode;
    const block=el.closest(PARAGRAPHS)||root,prefix=root.ownerDocument.createRange();prefix.selectNodeContents(block);prefix.setEnd(selection.anchorNode,selection.anchorOffset);
    const texts=editableText(root,prefix).filter(item=>block.contains(item.node)&&!item.atomic);let remaining=length;
    for(const item of texts.reverse()){
      const available=item.end-item.start;if(remaining>available){remaining-=available;continue;}
      const range=prefix.cloneRange();range.setStart(item.node,item.end-remaining);return range;
    }
    return null;
  }
  const TEXT_BLOCKS=PARAGRAPHS+',td,th,.doc-float-body';
  const PROTECTED=CHROME+',.doc-checkbox,.doc-chip-ctrl,.doc-chip[data-token^="#"],.doc-chip[data-token^="/"],[data-doc-locked="true"],[data-doc-hidden="true"],[data-doc-toc],[data-doc-toc-page],[data-doc-note-ref],[data-doc-note-number],.doc-page-number,del[data-doc-change],svg,math,style,script';
  const CHARACTER_STYLE=['font-weight','font-style','font-family','font-size','color','background-color','background','text-decoration','text-decoration-line','vertical-align'];
  function element(node){return node.nodeType===3?node.parentElement:node;}
  function validateLivePoint(node,offset){if(node.nodeType===3&&offset>0&&offset<node.length&&/[\uD800-\uDBFF]/.test(node.data[offset-1])&&/[\uDC00-\uDFFF]/.test(node.data[offset]))throw new Error('Text position splits a Unicode character');}
  function overlaps(range,node){const a=range.cloneRange(),b=range.cloneRange();a.selectNode(node);a.collapse(false);b.selectNode(node);b.collapse(true);return range.compareBoundaryPoints(0,a)<0&&range.compareBoundaryPoints(2,b)>0;}
  /** A conservative paragraph text transaction. null delegates structural edits to the browser. */
  function editText(root,selection,text='',direction=null,marks={}){
    if(typeof text!=='string'||!selection?.rangeCount||!root.contains(selection.anchorNode)||!root.contains(selection.focusNode))return false;
    if(/[\r\n]/.test(text))return null;
    for(const [property,value] of Object.entries(marks))validateInline(property,value);
    let range=selection.getRangeAt(0).cloneRange();
    for(const [node,offset] of [[range.startContainer,range.startOffset],[range.endContainer,range.endOffset]]){
      validateLivePoint(node,offset);const el=element(node);if(el.closest(PROTECTED+',.doc-chip')||el.closest('[contenteditable]')?.getAttribute('contenteditable')==='false')return false;
    }
    const block=element(range.startContainer).closest(TEXT_BLOCKS)||root,endBlock=element(range.endContainer).closest(TEXT_BLOCKS)||root;
    for(const node of (block===endBlock?block:root).querySelectorAll(PROTECTED))if(overlaps(range,node))return false;
    if(block!==endBlock)return null;
    if(range.collapsed&&direction){
      const all=root.ownerDocument.createRange();all.selectNodeContents(block);const units=editableText(root,all),prefix=all.cloneRange();prefix.setEnd(range.startContainer,range.startOffset);
      const point=editableText(root,prefix).reduce((n,item)=>n+(item.atomic?1:item.end-item.start),0),value=units.map(item=>item.atomic?'\uFFFC':item.node.data).join('');
      const segments=[...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(value)];
      const segment=direction==='backward'?segments.findLast(item=>item.index<point):segments.find(item=>item.index+item.segment.length>point);
      if(!segment)return null;
      const a=segment.index,b=a+segment.segment.length;
      function locate(offset,end=false){let count=0;for(const item of units){const length=item.atomic?1:item.node.length;if(offset<count+length||end&&offset===count+length){if(item.atomic){const r=root.ownerDocument.createRange();offset===count?r.setStartBefore(item.node):r.setStartAfter(item.node);return [r.startContainer,r.startOffset];}return [item.node,offset-count];}count+=length;}return [block,block.childNodes.length];}
      range=root.ownerDocument.createRange();range.setStart(...locate(a));range.setEnd(...locate(b,true));
      // Do not skip an intervening protected atom just because it contributes no editable text.
      const gap=root.ownerDocument.createRange();if(direction==='backward'){gap.setStart(range.endContainer,range.endOffset);gap.setEnd(selection.anchorNode,selection.anchorOffset);}else{gap.setStart(selection.anchorNode,selection.anchorOffset);gap.setEnd(range.startContainer,range.startOffset);}
      if(gap.cloneContents().querySelector(PROTECTED+',.doc-chip,br,img,hr'))return false;
    }
    const fragment=range.cloneContents();
    if(fragment.querySelector(PROTECTED))return false;
    const comments=root.ownerDocument.createTreeWalker(fragment,128);let comment;while((comment=comments.nextNode()))if(comment.data.startsWith('doc-block:'))return false;
    for(const node of block.querySelectorAll(PROTECTED))if(overlaps(range,node))return false;
    if(fragment.querySelector(TEXT_BLOCKS+',br,img,hr,table,section,[data-doc-design-page]'))return null;
    if(range.collapsed&&!text)return false;
    if(text&&range.collapsed){const visible=[...block.childNodes].filter(n=>n.nodeType===1||n.nodeType===3&&n.textContent.trim());if(visible.length===1&&visible[0].nodeName==='BR'){range.setStartBefore(visible[0]);range.collapse(true);visible[0].remove();}}
    range.deleteContents();range.collapse(true);selection.removeAllRanges();selection.addRange(range);
    if(text){const span=root.ownerDocument.createElement('span');span.dataset.docRun='inline';span.style.whiteSpace='pre-wrap';for(const [property,value] of Object.entries(marks))span.style.setProperty(property,value);span.textContent=text;range.insertNode(span);const inserted=root.ownerDocument.createRange();inserted.selectNodeContents(span);selection.removeAllRanges();selection.addRange(inserted);}
    else {const marker=root.ownerDocument.createComment('doc-edit-caret');range.insertNode(marker);for(const run of block.querySelectorAll('[data-doc-run="inline"]'))if(!run.textContent&&!run.querySelector('.doc-chip,img,br')&&!run.contains(marker))run.remove();const caret=root.ownerDocument.createRange();caret.setStartBefore(marker);caret.collapse(true);selection.removeAllRanges();selection.addRange(caret);marker.remove();}
    return true;
  }
  /** Split inline ancestors around selected leaf islands, retaining attributes and live atoms. */
  function stripInline(root,selection,kind){
    if(!selection?.rangeCount||selection.isCollapsed||!root.contains(selection.anchorNode)||!root.contains(selection.focusNode))return null;
    const original=selection.getRangeAt(0).cloneRange(),units=editableText(root,original);
    const match=el=>(kind==='script'?(el.matches('sup,sub')||['super','sub'].includes(el.style.verticalAlign)):(el.matches('b,strong,i,em,u,s,strike,sup,sub,font,del:not([data-doc-change])')||CHARACTER_STYLE.some(key=>el.style.getPropertyValue(key))||ownDecoration(el,'underline')||ownDecoration(el,'line-through')));
    for(const item of units){if(item.node.parentElement.closest('[data-doc-locked="true"]'))throw new Error('Selected text is locked');for(let el=item.node.parentElement;el&&el!==root;el=el.parentElement)if(el.matches(TEXT_BLOCKS+',div,section')&&(kind==='script'?match(el):ownDecoration(el,'underline')||ownDecoration(el,'line-through')))return null;}
    validateLivePoint(original.startContainer,original.startOffset);validateLivePoint(original.endContainer,original.endOffset);
    const backwards=selection.anchorNode===original.endContainer&&selection.anchorOffset===original.endOffset,start=root.ownerDocument.createComment('doc-strip-start'),end=root.ownerDocument.createComment('doc-strip-end');
    const startNode=original.startContainer,startOffset=original.startOffset;const tail=original.cloneRange();tail.collapse(false);tail.insertNode(end);const head=root.ownerDocument.createRange();head.setStart(startNode,startOffset);head.collapse(true);head.insertNode(start);const clones=[];let changed=false;
    try{
      const selected=root.ownerDocument.createRange();selected.setStartAfter(start);selected.setEndBefore(end);
      for(const {node} of editableText(root,selected)){
        let highest=null;for(let el=node.parentElement;el&&el!==root&&!el.matches(TEXT_BLOCKS+',div,section');el=el.parentElement)if(match(el))highest=el;if(!highest)continue;
        const stop=highest.parentNode,focus=root.ownerDocument.createElement('span');focus.dataset.docRun='inline';node.before(focus);focus.append(node);let child=focus;
        while(child.parentNode!==stop){let parent=child.parentElement;
          const side=()=>{const clone=parent.cloneNode(false);clone.removeAttribute('id');clone.removeAttribute('data-doc-node');clones.push(clone);return clone;};
          if(child.previousSibling){const before=side();while(parent.firstChild!==child)before.append(parent.firstChild);parent.before(before);}if(child.nextSibling){const after=side();while(child.nextSibling)after.append(child.nextSibling);parent.after(after);}
          if(match(parent)){
            if(parent.matches(kind==='script'?'sup,sub':'b,strong,i,em,u,s,strike,sup,sub,font,del:not([data-doc-change])')){const span=root.ownerDocument.createElement('span');for(const attr of parent.attributes)span.setAttribute(attr.name,attr.value);span.dataset.docRun='inline';if(parent.tagName==='FONT')for(const attr of ['size','face','color'])span.removeAttribute(attr);span.append(...parent.childNodes);parent.replaceWith(span);parent=span;}
            if(kind==='script')parent.style.removeProperty('vertical-align');else{CHARACTER_STYLE.forEach(key=>parent.style.removeProperty(key));parent.style.textDecorationLine='none';}
          }
          child=parent;
        }changed=true;
      }
      for(const run of root.querySelectorAll('span[data-doc-run="inline"]'))if(!run.getAttribute('style')&&!run.id&&[...run.attributes].every(a=>['data-doc-run','style'].includes(a.name)))run.replaceWith(...run.childNodes);
      return changed;
    }finally{const range=root.ownerDocument.createRange();range.setStartAfter(start);range.setEndBefore(end);end.remove();start.remove();for(const clone of clones)if(!clone.hasChildNodes())clone.remove();if(backwards)selection.setBaseAndExtent(range.endContainer,range.endOffset,range.startContainer,range.startOffset);else{selection.removeAllRanges();selection.addRange(range);}}
  }
  function scriptActive(root,selection,value){
    if(!selection?.rangeCount||!root.contains(selection.anchorNode)||!root.contains(selection.focusNode))return null;
    const active=node=>{for(let el=element(node);el&&el!==root;el=el.parentElement){if(el.tagName==='SUP'||el.style.verticalAlign==='super')return value==='super';if(el.tagName==='SUB'||el.style.verticalAlign==='sub')return value==='sub';}return false;};
    const units=selection.isCollapsed?[{node:selection.anchorNode}]:editableText(root,selection.getRangeAt(0));return !!units.length&&units.every(item=>active(item.node));
  }
  function formatScript(root,selection,value){
    if(!['super','sub','baseline'].includes(value))throw new Error('Invalid script');
    const result=stripInline(root,selection,'script');if(result===null)return null;
    if(value==='baseline')return result;
    return formatSelection(root,selection,'vertical-align',value);
  }
  function defaultCharacterMarks(root,selection){
    const block=element(selection.anchorNode).closest(TEXT_BLOCKS)||root,css=root.ownerDocument.defaultView.getComputedStyle(block);
    const rgb=css.color.match(/^rgba?\(\s*(\d+)[, ]+\s*(\d+)[, ]+\s*(\d+)/),color=rgb?'#'+rgb.slice(1,4).map(n=>Number(n).toString(16).padStart(2,'0')).join(''):'#111827';
    const size=Math.max(1,Math.min(400,(parseFloat(css.fontSize)||16)*(css.fontSize.endsWith('pt')?1:.75)));
    return {'font-weight':css.fontWeight==='bold'||Number(css.fontWeight)>=600?'bold':'normal','font-style':css.fontStyle==='italic'?'italic':'normal','font-family':css.fontFamily||'Arial','font-size':Number(size.toFixed(3))+'pt',color,'background-color':'#00000000'};
  }
  function clearSelection(root,selection){
    if(!selection?.rangeCount||selection.isCollapsed)return null;
    const blocks=new Set(editableText(root,selection.getRangeAt(0)).map(item=>element(item.node).closest(TEXT_BLOCKS)||root));if(blocks.size>1)return null;
    const marks=defaultCharacterMarks(root,selection);for(const [property,value] of Object.entries(marks))validateInline(property,value);const result=stripInline(root,selection,'clear');if(result===null)return null;
    for(const [property,value] of Object.entries(marks))formatSelection(root,selection,property,value);return true;
  }
  /** Insert marked text at an editable caret without browser pending-format state. */
  function insertMarkedText(root,selection,text,marks){
    if(typeof text!=='string'||!text.length||/[\r\n]/.test(text))return false;
    if(!selection?.isCollapsed||!selection.rangeCount||!root.contains(selection.anchorNode))return false;
    const range=selection.getRangeAt(0),el=range.startContainer.nodeType===3?range.startContainer.parentElement:range.startContainer;
    if(el.closest('[data-doc-locked="true"],.doc-chip,.doc-checkbox,del[data-doc-change]')||el.closest('[contenteditable]')?.getAttribute('contenteditable')==='false')return false;
    for(const [property,value] of Object.entries(marks))validateInline(property,value);
    const span=root.ownerDocument.createElement('span');span.dataset.docRun='inline';span.style.whiteSpace='pre-wrap';for(const [property,value] of Object.entries(marks))span.style.setProperty(property,value);
    span.textContent=text;range.insertNode(span);const caret=root.ownerDocument.createRange();caret.selectNodeContents(span);caret.collapse(false);selection.removeAllRanges();selection.addRange(caret);normalizeRuns(root,selection);return true;
  }
  /** Coalesce adjacent owned runs only when every attribute agrees; keep caret and atoms live. */
  function normalizeRuns(root,selection){
    if(!selection?.isCollapsed||!root.contains(selection.anchorNode))return;
    const marker=root.ownerDocument.createComment('doc-run-caret'),range=selection.getRangeAt(0).cloneRange();range.insertNode(marker);
    try{
      const scope=element(selection.anchorNode).closest(TEXT_BLOCKS)||root,selector='span[data-doc-run="inline"],sup[data-doc-run="inline"],sub[data-doc-run="inline"]';
      const attrs=el=>el.tagName+JSON.stringify([...el.attributes].map(a=>[a.name,a.value]).sort());
      // Unwrap first, then merge. Otherwise unwrapping a child can expose siblings already visited.
      for(const run of scope.querySelectorAll(selector)){
        if(run.id||!run.isConnected)continue;
        if(run.tagName==='SPAN'&&!run.getAttribute('style')&&[...run.attributes].every(a=>['data-doc-run','style'].includes(a.name))){run.replaceWith(...run.childNodes);continue;}
        if(run.parentElement.matches('[data-doc-run="inline"]')&&attrs(run)===attrs(run.parentElement))run.replaceWith(...run.childNodes);
      }
      for(const run of scope.querySelectorAll(selector)){
        if(run.id||!run.isConnected)continue;let next=run.nextSibling;
        while(next?.nodeType===1&&next.matches(selector)&&!next.id&&attrs(run)===attrs(next)){run.append(...next.childNodes);next.remove();next=run.nextSibling;}
      }
      const caret=root.ownerDocument.createRange();caret.setStartBefore(marker);caret.collapse(true);selection.removeAllRanges();selection.addRange(caret);
    }finally{const parent=marker.parentNode;marker.remove();parent?.normalize();}
  }
  return {inlineValue,defaultCharacterMarks,editText,formatScript,scriptActive,clearSelection,formatDecoration,decorationActive,rangeBeforeCaret,insertMarkedText,normalizeRuns,validateInline,capture,fromHtml,toHtml,at,alignParagraphs,alignSelection,alignmentActive,comparePosition,formatTextRange,formatSelection,inlineActive};
})();
if(typeof window!=='undefined')window.DocModel=DocModel;
if(typeof module!=='undefined'&&module.exports)module.exports=DocModel;
