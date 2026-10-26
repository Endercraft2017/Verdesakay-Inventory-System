// Run after opening the existing Site source, before packaging. Preserve topic reviews.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
const hosting=JSON.parse(fs.readFileSync('docs/design/ui-scratch-hosting.json','utf8')),site=hosting.source_checkout,dist=path.join(site,'dist'),workPath='/reviews/work-guides/',prepPath='/reviews/preparation/';
assert.equal(JSON.parse(fs.readFileSync(path.join(site,'.openai/hosting.json'))).project_id,hosting.project_id);
const work=fs.readFileSync('work/ui-scratch/index.html'),manifest=JSON.parse(fs.readFileSync('work/ui-scratch/source-manifest.json'));
for(const source of manifest.files)assert.equal(createHash('sha256').update(fs.readFileSync(source.path)).digest('hex'),source.sha256,'Rebuild Work preview: '+source.path+' changed');
const current=fs.readFileSync(path.join(dist,'index.html'),'utf8'),prepFile=path.join(dist,prepPath,'index.html');let preparation=current.includes('Outside this review')?current:fs.existsSync(prepFile)?fs.readFileSync(prepFile,'utf8'):null;
if(preparation){
 if(!preparation.includes("type:'scratch-open-work'")){
  const handler='const unsupported=function(view){',listener="window.addEventListener('message',e=>{if(![$('#before').contentWindow,$('#after').contentWindow].includes(e.source))return;";
  assert.equal(preparation.split(handler).length,2,'Expected exactly one old review route fallback');assert.equal(preparation.split(listener).length,2,'Expected the review-owned message listener');
  preparation=preparation.replace(handler,handler+"if(location.hash.split('?')[0]==='#/work'){view.innerHTML='<section class=\"m-card\"><h2>Opening Work…</h2><p role=\"status\">Opening the full Work review.</p></section>';parent.postMessage({type:'scratch-open-work'},'*');return;}");
  preparation=preparation.replace(listener,listener+"if(e.data?.type==='scratch-open-work'){location.assign('/reviews/work-guides/?screen=work');return;}");
 }
 fs.mkdirSync(path.dirname(prepFile),{recursive:true});fs.writeFileSync(prepFile,preparation);
 for(const name of ['THIRD-PARTY-NOTICES.txt','fake-indexeddb-LICENSE'])if(fs.existsSync(path.join(dist,name)))fs.copyFileSync(path.join(dist,name),path.join(dist,prepPath,name));
}
fs.mkdirSync(path.join(dist,workPath),{recursive:true});fs.writeFileSync(path.join(dist,workPath,'index.html'),work);fs.copyFileSync('work/ui-scratch/fake-indexeddb-LICENSE',path.join(dist,workPath,'fake-indexeddb-LICENSE'));
fs.writeFileSync(path.join(dist,'index.html'),`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Cache-Control" content="no-store"><meta http-equiv="refresh" content="0;url=${workPath}?screen=work"><title>Open Work preview</title></head><body><p><a href="${workPath}?screen=work">Open Work preview</a></p><script>location.replace('${workPath}?screen=work');</script></body></html>\n`);
fs.writeFileSync(path.join(site,'REVIEW-PATHS.md'),`# Private scratch review entry points\n\n- Root / is the canonical Work entry and redirects to ${workPath}?screen=work.\n- Work, Guides and native BOM: ${workPath}?screen=work.\n- Preserved preparation review: ${prepPath}. Its Work tab opens the full Work review.\n\nKeep all topics in dist/reviews/<topic>/. Preserve other topic directories. Do not\nreplace root with an isolated review that stubs the Work tab. After opening the\nSite source, run the application repository's scripts/prepare-ui-scratch-site.mjs\nbefore packaging. Never connect these previews to live business APIs.\n`);
console.log(JSON.stringify({root:'Work entry',work:workPath,preparation:preparation?prepPath:null,sourceHashes:manifest.files.length}));
