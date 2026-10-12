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
    if(node?.kind!=='text'||!Number.isInteger(offset)||offset<0||offset>node.text.length)throw new Error('Invalid text position');
    if(offset>0&&offset<node.text.length&&/[\uD800-\uDBFF]/.test(node.text[offset-1])&&/[\uDC00-\uDFFF]/.test(node.text[offset]))throw new Error('Text position splits a Unicode character');
  }
  function validateInline(property,value){
    if(property==='font-weight'&&!['bold','normal'].includes(value))throw new Error('Invalid font weight');
    if(property==='font-style'&&!['italic','normal'].includes(value))throw new Error('Invalid font style');
    if(property==='font-family'&&(!/^[\p{L}\p{N}\s,'"._-]{1,150}$/u.test(value)))throw new Error('Invalid font family');
    if(property==='font-size'&&(!/^\d+(\.\d+)?pt$/.test(value)||parseFloat(value)<1||parseFloat(value)>400))throw new Error('Invalid font size');
    if(['color','background-color'].includes(property)&&!/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(value))throw new Error('Invalid text color');
    if(!['font-weight','font-style','font-family','font-size','color','background-color'].includes(property))throw new Error('Unsupported inline format');
  }
  /** Immutable selected-run command. Existing inline ancestors/attributes are retained. */
  function formatTextRange(document,range,property,value){
    validateInline(property,value);if(!range?.anchor||!range?.focus)throw new Error('Invalid text range');validatePosition(document,range.anchor);validatePosition(document,range.focus);
    const [start,end]=comparePosition(range.anchor,range.focus)<=0?[range.anchor,range.focus]:[range.focus,range.anchor];
    const next=JSON.parse(JSON.stringify(document)),changes=[];
    function walk(node,path,locked=false,skip=false){
      const attrs=node.attrs || [],attribute=name=>attrs.find(a=>a[0]===name)?.[1];
      locked ||= attribute('data-doc-locked')==='true';
      skip ||= DERIVED.some(key=>attrs.some(([k])=>k===key))||attribute('data-doc-hidden')==='true'||RAW.has(node.tag)||node.kind==='field'||node.kind==='opaque'||(node.tag==='del'&&attribute('data-doc-change'))||/\bdoc-checkbox\b/.test(attribute('class') || '');
      if(skip)return;
      if(node.kind==='text'){
        const a=path.join(',')===start.path.join(',')?start.offset:0,b=path.join(',')===end.path.join(',')?end.offset:node.text.length;
        if(comparePosition({path,offset:node.text.length},start)<=0||comparePosition({path,offset:0},end)>=0||b<=a)return;
        if(locked)throw new Error('Selected text is locked');
        const parentPath=path.slice(0,-1),parent=at(next,parentPath),owned=parent?.tag==='span'&&parent.attrs.some(([k,v])=>k==='data-doc-run'&&v==='inline')&&parent.children.length===1;
        if(owned&&a===0&&b===node.text.length){
          let style=parent.attrs.find(a=>a[0]==='style');if(!style){style=['style',''];parent.attrs.push(style);}style[1]=setStyleProperty(style[1],property,value);
          changes.push({type:'attributes',path:parentPath,attrs:parent.attrs});return;
        }
        const run={kind:'run',tag:'span',attrs:[['data-doc-run','inline'],['style',property+':'+value]],children:[{kind:'text',text:node.text.slice(a,b)}]};
        const parts=[];if(a)parts.push({kind:'text',text:node.text.slice(0,a)});parts.push(run);if(b<node.text.length)parts.push({kind:'text',text:node.text.slice(b)});
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
    const texts=[],walker=root.ownerDocument.createTreeWalker(root,4);let node;
    while((node=walker.nextNode())){
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
    const range=selection.getRangeAt(0);if(range.collapsed)return null;
    const texts=editableText(root,range);if(!texts.length)return false;
    return texts.every(({node})=>{const css=root.ownerDocument.defaultView.getComputedStyle(node.parentElement);return property==='font-weight'?css.fontWeight==='bold'||Number(css.fontWeight)>=600:css.fontStyle==='italic';});
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
    const endRange=original.cloneRange();endRange.collapse(false);endRange.insertNode(end);const startRange=original.cloneRange();startRange.collapse(true);startRange.insertNode(start);
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
        for(const part of change.parts){if(part.kind==='text')fragment.append(root.ownerDocument.createTextNode(part.text));else{const span=root.ownerDocument.createElement('span');part.attrs.forEach(([k,v])=>span.setAttribute(k,v));span.textContent=part.children[0].text;fragment.append(span);}}
        node.replaceWith(fragment);
      }
      return result.changes.length>0;
    }finally{
      const restored=root.ownerDocument.createRange();restored.setStartAfter(start);restored.setEndBefore(end);
      if(backwards)selection.setBaseAndExtent(restored.endContainer,restored.endOffset,restored.startContainer,restored.startOffset);else{selection.removeAllRanges();selection.addRange(restored);}
      end.remove();start.remove();markerParents.forEach(parent=>parent?.normalize());
    }
  }
  return {capture,fromHtml,toHtml,at,alignParagraphs,alignSelection,alignmentActive,comparePosition,formatTextRange,formatSelection,inlineActive};
})();
if(typeof window!=='undefined')window.DocModel=DocModel;
if(typeof module!=='undefined'&&module.exports)module.exports=DocModel;
