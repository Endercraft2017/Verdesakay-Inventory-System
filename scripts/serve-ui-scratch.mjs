// Serves only the generated review entry on loopback; no app/API proxy.
import fs from 'node:fs';import path from 'node:path';import http from 'node:http';import {fileURLToPath} from 'node:url';
const entry=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../work/ui-scratch/index.html');
if(!fs.existsSync(entry))throw Error('Build the preview first: npm run ui:scratch');
const port=Number(process.env.UI_SCRATCH_PORT||4173);if(!Number.isInteger(port)||port<1024||port>65535)throw Error('UI_SCRATCH_PORT must be 1024–65535');
const server=http.createServer((req,res)=>{if(req.method!=='GET'){res.writeHead(405);return res.end();}if(req.url==='/favicon.ico'){res.writeHead(204);return res.end();}if(!['/','/index.html'].includes(new URL(req.url,'http://scratch.invalid').pathname)){res.writeHead(404);return res.end('Scratch entry only');}res.setHeader('Content-Type','text/html; charset=utf-8');res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.end(fs.readFileSync(entry));});
server.listen(port,'127.0.0.1',()=>console.log('Interactive scratch preview: http://localhost:'+port));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>server.close(()=>process.exit(0)));
