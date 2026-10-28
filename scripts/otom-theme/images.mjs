// Resize/format actual screenshots only. No UI repainting, generated screenshots or crops.
import fs from 'node:fs';import path from 'node:path';import{spawnSync,execFileSync}from'node:child_process';import{createHash}from'node:crypto';
const root=path.resolve(import.meta.dirname,'../..'),input=path.join(root,'work/otom-theme/after'),output=path.join(root,'website/assets/screens'),keys=['attendance','payroll','mobile','inventory','production','sales'];fs.mkdirSync(output,{recursive:true});
const python=String.raw`from pathlib import Path
from PIL import Image
import sys
root=Path(sys.argv[1]);src=root/'work/otom-theme/after';dst=root/'website/assets/screens'
for key in ['attendance','payroll','mobile','inventory','production','sales']:
 image=Image.open(src/(key+('-390-light.png' if key=='mobile' else '-1440-light.png'))).convert('RGB')
 image.save(dst/('otom-'+key+'.webp'),'WEBP',quality=91,method=6)
 if key!='mobile':
  image.resize((960,round(image.height*960/image.width)),Image.Resampling.LANCZOS).save(dst/('otom-'+key+'-960.webp'),'WEBP',quality=88,method=6)
  responsive=Image.open(src/(key+'-390-light.png')).convert('RGB');responsive.save(dst/('otom-'+key+'-390.webp'),'WEBP',quality=91,method=6)
`;
const run=spawnSync('python3',['-c',python,root],{encoding:'utf8'});if(run.status!==0)throw Error(run.stderr);const manifest={sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),workingTree:true,synthetic:true,source:'Real createApp handlers and disposable SQLite; capture.mjs, no image repainting or cropping.',files:keys.map(key=>{const source=key+(key==='mobile'?'-390-light.png':'-1440-light.png');return{key,source,sourceSha256:createHash('sha256').update(fs.readFileSync(path.join(input,source))).digest('hex'),webpSha256:createHash('sha256').update(fs.readFileSync(path.join(output,'otom-'+key+'.webp'))).digest('hex')};}),styleSources:['public/css/otom-tokens.css','public/css/styles.css','public/css/visual-refresh.css','public/mobile/mobile-v2.css'].map(file=>({file,sha256:createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')}))};fs.writeFileSync(path.join(output,'capture-manifest.json'),JSON.stringify(manifest,null,2));console.log('Exported actual source captures and responsive WebP sizes with provenance.');
