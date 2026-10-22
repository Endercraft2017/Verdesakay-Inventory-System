// Browser-only fault injection. Source files on disk are never changed by these challenges.
const once=(source,before,after)=>{if(!source.includes(before))throw Error('Mutation anchor missing: '+before);return source.replace(before,after);};
export function mutate(kind,file,source){
 if(kind==='ambiguous-count'&&file.endsWith('/hr/work.js'))return once(source,'function homeCount(source,rows){',"function homeCount(source,rows){ return rows.length+' pending';");
 if(kind==='hide-blocked'&&file.endsWith('/hr/work.js'))return once(source,'function blockedInspection(source,r){','function blockedInspection(source,r){return false;');
 if(kind==='couple-queues'&&file.endsWith('/hr/work.js'))return once(source,'await Promise.all(desks.map(async function(source){','await Promise.all(desks.map(function(s){return readAttention(s,true).catch(function(){return null;});}));\n      await Promise.all(desks.map(async function(source){');
 if(kind==='hide-on-summary-failure'&&file.endsWith('/core/home.js'))return once(source,'render(view,{todayUnavailable:true},preview());',"view.innerHTML='<div class=\"m-error\">Employee summary failed</div>';");
 if(kind==='late-rts-paint'&&file.endsWith('/manufacturing/receiving.js'))return source.replace('if (!current()) return;','').replace('if(!current())return;','');
 return source;
}
