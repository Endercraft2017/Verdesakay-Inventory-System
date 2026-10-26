import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {output} from './build.mjs';
export function scratchServer(){
  const entry=path.join(output,'index.html');
  if(!fs.existsSync(entry))throw new Error('Run npm run ui:scratch first.');
  return http.createServer((req,res)=>{if(!['/','/index.html'].includes(new URL(req.url,'http://scratch.invalid').pathname)){res.writeHead(404);res.end('Not found');return;}res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});fs.createReadStream(entry).pipe(res);});
}
if(process.argv[1]&&path.resolve(process.argv[1])===import.meta.filename){const server=scratchServer();server.listen(Number(process.env.UI_SCRATCH_PORT||4178),'127.0.0.1',()=>console.log('Workspace loopback only: http://127.0.0.1:'+server.address().port+'/ — forward this port to use it remotely. Download index.html for a standalone preview.'));}
