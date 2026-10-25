// Only work/ui-scratch is disposable. Every other path is a source or retained evidence.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
const require=createRequire(import.meta.url);
export const root=fs.realpathSync(path.resolve(import.meta.dirname,'../..'));
export const output=path.join(root,'work/ui-scratch');
const marker='.ui-scratch-owned.json',owner='otom-ui-scratch-v1';
export function files(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>{const p=path.join(dir,e.name),relative=path.relative(output,p).split(path.sep).join('/');if(e.isSymbolicLink())throw new Error('Scratch output contains a symlink; leaving it untouched.');return e.isDirectory()?[relative+'/',...files(p)]:[relative];});}
export function registerEvidence(){const m=JSON.parse(fs.readFileSync(path.join(output,marker)));m.files=files(output).filter(f=>f!==marker);fs.writeFileSync(path.join(output,marker),JSON.stringify(m,null,2));}
export function clean(){
  if(output!==path.join(root,'work','ui-scratch'))throw new Error('Unexpected scratch path.');
  for(const p of [path.join(root,'work'),output])if(fs.existsSync(p)&&fs.lstatSync(p).isSymbolicLink())throw new Error('Scratch parent/output is a symlink; leaving it untouched.');
  if(fs.existsSync(output)){
    if(!fs.existsSync(path.join(output,marker)))throw new Error('Scratch output has no ownership marker; leaving it untouched.');
    const m=JSON.parse(fs.readFileSync(path.join(output,marker),'utf8'));
    if(m.owner!==owner||m.root!==root||!Array.isArray(m.files))throw new Error('Scratch ownership does not match; leaving it untouched.');
    // Infer ancestors for older ownership manifests, but never assume an empty
    // directory is generated merely because it is inside the output root.
    const allowed=new Set(m.files.flatMap(f=>[f,...f.split('/').slice(0,-1).map((_,i)=>f.split('/').slice(0,i+1).join('/')+'/')]));
    const unknown=files(output).filter(f=>f!==marker&&!allowed.has(f));
    if(unknown.length)throw new Error('Unowned scratch files were preserved: '+unknown.join(', '));
    fs.rmSync(output,{recursive:true});
  }
  fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,marker),JSON.stringify({owner,root,files:[]}));
}
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const sourcePaths=['/js/api.js','/js/auth-controls.js','/js/lib/photo-viewer.js','/mobile/app.js','/mobile/lib/dom.js','/mobile/lib/screen-ux.js','/mobile/lib/role-ui.js','/mobile/lib/read-scope.js','/mobile/lib/stock-ui.js','/mobile/lib/quick-orbit.js','/mobile/lib/locations.js','/mobile/lib/recent.js','/mobile/lib/queue-store.js','/mobile/lib/queue.js','/mobile/lib/production-drafts.js','/mobile/lib/workflow-attempt.js','/mobile/lib/stock-action-ui.js','/mobile/lib/scanner.js','/mobile/lib/item-picker.js','/mobile/lib/batch-attempt.js','/mobile/lib/batch-ui.js','/mobile/lib/quantity-focus.js','/mobile/lib/batch-carousel.js','/mobile/lib/preparation-review.js','/mobile/modules/inventory/batch-move.js'];
function dataFile(p){const full=path.resolve(root,'public',p.replace(/^\//,''));if(!full.startsWith(path.join(root,'public')+path.sep))throw new Error('Asset escaped public/');const ext=path.extname(full),mime=ext==='.svg'?'image/svg+xml':ext==='.png'?'image/png':ext==='.woff2'?'font/woff2':'application/octet-stream';return 'data:'+mime+';base64,'+fs.readFileSync(full).toString('base64');}
export async function generate(){
  // Build everything in memory before clearing old generated output.
  const index=fs.readFileSync(path.join(root,'public/mobile/index.html'),'utf8');
  const styles=[...index.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map(m=>m[1]);
  const css=styles.map(p=>fs.readFileSync(path.join(root,'public',p),'utf8').replace(/url\(['"]?(\/[^)'"\s]+)['"]?\)/g,(_,asset)=>'url("'+dataFile(asset)+'")')).join('\n');
  const scripts=sourcePaths.map(p=>({path:'public'+p,code:fs.readFileSync(path.join(root,'public',p),'utf8')}));
  const baselineRef='Current working tree · List view';
  const before=fs.readFileSync(path.join(root,'public/mobile/modules/inventory/batch-move.js'),'utf8');
  const database=(await build({entryPoints:[require.resolve('fake-indexeddb/auto')],bundle:true,write:false,format:'iife',platform:'browser',minify:true})).outputFiles[0].text;
  const assets={};function bundleImages(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,e.name);if(e.isDirectory()){bundleImages(full);continue;}if(!/\.(svg|png|jpe?g|webp|avif|gif)$/i.test(e.name))continue;const url='/'+path.relative(path.join(root,'public'),full).split(path.sep).join('/');assets[url]=dataFile(url);}}bundleImages(path.join(root,'public/mobile/icons'));
  const body=index.slice(index.indexOf('<body>')+6,index.lastIndexOf('</body>')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace(/src="(\/[^\"]+)"/g,(_,asset)=>'src="'+dataFile(asset)+'"');
  const payload={body,css,scripts,database,assets,notices:fs.readFileSync(path.join(root,'node_modules/fake-indexeddb/LICENSE'),'utf8'),fixtures:fs.readFileSync(path.join(root,'scripts/ui-scratch/fixtures.js'),'utf8'),before};
  const notes=JSON.parse(fs.readFileSync(path.join(root,'scripts/ui-scratch/notes.json'),'utf8'));
  const manifest={sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),baselineRef,builtAt:new Date().toISOString(),sources:[{path:'public/mobile/index.html',sha256:hash(index)},...styles.map(p=>({path:'public'+p,sha256:hash(fs.readFileSync(path.join(root,'public',p)))})),...scripts.map(s=>({path:s.path,sha256:hash(s.code)})),...Object.keys(assets).map(p=>({path:'public'+p,sha256:hash(fs.readFileSync(path.join(root,'public',p)))}))],storage:'fake-indexeddb memory only',transport:'fixture-only fetch; real network forbidden'};
  const html=fs.readFileSync(path.join(root,'scripts/ui-scratch/template.html'),'utf8').replace('/*PAYLOAD*/',JSON.stringify(payload).replace(/</g,'\\u003c')).replace('/*NOTES*/',JSON.stringify(notes).replace(/</g,'\\u003c')).replace('/*MANIFEST*/',JSON.stringify(manifest)).replace('/*REVIEW_JS*/',fs.readFileSync(path.join(root,'scripts/ui-scratch/review.js'),'utf8'));
  clean();fs.writeFileSync(path.join(output,'index.html'),html);fs.writeFileSync(path.join(output,'build.json'),JSON.stringify(manifest,null,2));fs.writeFileSync(path.join(output,'THIRD-PARTY-NOTICES.txt'),'Preview runtime: fake-indexeddb\n\n'+fs.readFileSync(path.join(root,'node_modules/fake-indexeddb/LICENSE'),'utf8'));fs.mkdirSync(path.join(output,'evidence'));fs.writeFileSync(path.join(output,'evidence/README.md'),'Browser verification has not run for this clean build. Run npm run test:ui:scratch.\n');registerEvidence();
  console.log('Scratch entry: '+path.join(output,'index.html'));console.log('Source files: '+manifest.sources.length+'; self-contained HTML: '+Buffer.byteLength(html)+' bytes');return manifest;
}
if(process.argv[1]&&path.resolve(process.argv[1])===import.meta.filename)await generate();
