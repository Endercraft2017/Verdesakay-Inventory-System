/* Document-model foundation. Independently implemented for our HTML/template contract.
   Wordcraft's document/path model is the behavioral reference; see WORDCRAFT-PORT-PLAN.md. */
const DocModel = (() => {
  /** @typedef {{kind:'text',text:string}|{kind:'field',token:string,raw:string}|{kind:'comment',text:string}|{kind:'opaque',html:string}|{kind:'paragraph'|'run'|'list'|'listItem'|'table'|'tableGroup'|'row'|'cell'|'image'|'break'|'page'|'section'|'element',tag:string,attrs:Array<[string,string]>,children:Array<ModelNode>,repeat?:string}} ModelNode */
  /** @typedef {{kind:'document',version:1,children:Array<ModelNode>}} ModelDocument */
  const CHROME='.doc-float-handle,.doc-float-toolbar,.doc-promote-bar,.doc-snap-guide,.doc-page-guide';
  const RAW=new Set(['style','script','textarea','title']);
  const VOID=new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
  const PARAGRAPHS='p,h1,h2,h3,h4,h5,h6,li,blockquote';
  const kinds={p:'paragraph',h1:'paragraph',h2:'paragraph',h3:'paragraph',h4:'paragraph',h5:'paragraph',h6:'paragraph',blockquote:'paragraph',ul:'list',ol:'list',li:'listItem',table:'table',thead:'tableGroup',tbody:'tableGroup',tfoot:'tableGroup',tr:'row',td:'cell',th:'cell',img:'image',br:'break',span:'run',b:'run',strong:'run',i:'run',em:'run',u:'run',s:'run',sup:'run',sub:'run',ins:'run',del:'run',a:'run'};
  const escapeText=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  const escapeAttr=value=>escapeText(value).replaceAll('"','&quot;');
  const field=raw=>({kind:'field',raw,token:raw.slice(2,-2).trim()});

  /** Capture canonical data plus ephemeral DOM references. DOM references never enter saved data. */
  function capture(root,{editor=true,fieldMarker=null}={}) {
    const paths=new WeakMap(),refs=new Map();
    function read(node,path) {
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
  function alignStyle(style,value) {
    const parts=[];let start=0,depth=0,quote='',comment=false;
    for(let i=0;i<style.length;i++){
      const ch=style[i];if(comment){if(ch==='*'&&style[i+1]==='/'){comment=false;i++;}continue;}
      if(quote){if(ch==='\\'){i++;continue;}if(ch===quote)quote='';continue;}
      if(ch==='/'&&style[i+1]==='*'){comment=true;i++;continue;}
      if(ch==='"'||ch==="'"){quote=ch;continue;}if(ch==='(')depth++;else if(ch===')')depth=Math.max(0,depth-1);
      else if(ch===';'&&!depth){parts.push(style.slice(start,i));start=i+1;}
    }
    parts.push(style.slice(start));
    return parts.filter(p=>p.trim()&&!/^text-align\s*:/i.test(p.replace(/\/\*[\s\S]*?\*\//g,'').trim())).join(';')+';text-align:'+value;
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
      if(!style){style=['style',''];node.attrs.push(style);}style[1]=alignStyle(style[1],value);
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
  return {capture,fromHtml,toHtml,at,alignParagraphs,alignSelection,alignmentActive};
})();
if(typeof window!=='undefined')window.DocModel=DocModel;
if(typeof module!=='undefined'&&module.exports)module.exports=DocModel;
