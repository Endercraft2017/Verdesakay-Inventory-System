/** Disposable processes: an uncaught decoder/parser error must remain fatal here. */
import assert from 'node:assert/strict';
import http from 'node:http';
import {PassThrough} from 'node:stream';
import {gzipSync} from 'node:zlib';
import multer from 'multer';
import {setupApp,cleanup} from '../helpers';

async function compressedRequest() {
  const ctx=await setupApp(),server=http.createServer(ctx.app);
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=(server.address() as {port:number}).port;
  const request=(body:Buffer,headers:Record<string,string>)=>new Promise<number>((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port,path:'/api/dependency-advisory-probe',method:'POST',
      headers:{'Content-Type':'application/json','Content-Length':String(body.length),...headers}},res=>{
        res.resume();res.on('end',()=>resolve(res.statusCode!));res.on('error',reject);
      });
    req.on('error',reject);req.setTimeout(5000,()=>req.destroy(new Error('HTTP probe deadline')));req.end(body);
  });
  try {
    const normal=await request(gzipSync(Buffer.from('{}')),{'Content-Encoding':'gzip'});
    // Upstream's gzip frame terminator followed by 100 KiB of trailing bytes.
    const adversarial=await request(Buffer.concat([gzipSync(Buffer.from('{}')),Buffer.from([0]),Buffer.alloc(100*1024,0x58)]),{'Content-Encoding':'gzip'});
    await new Promise(resolve=>setTimeout(resolve,300));
    const healthy=await new Promise<number>((resolve,reject)=>http.get({host:'127.0.0.1',port,path:'/api/health'},res=>{res.resume();res.on('end',()=>resolve(res.statusCode!));}).on('error',reject));
    console.log('ADVISORY_RESULT '+JSON.stringify({normal,adversarial,healthy}));
  } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));cleanup(ctx);}
}

async function lateFilter() {
  // Upstream teardown sequence; intentionally not an app route (our filters are synchronous).
  const req=new PassThrough() as PassThrough & {headers:Record<string,string>;files?:unknown[]};
  let resumeFilter:multer.FileFilterCallback|undefined,parser:PassThrough|undefined,nextCalls=0;
  const filterError=new Error('synthetic filter refusal'),boundary='AdvisoryBoundary';
  const body=['--'+boundary,'Content-Disposition: form-data; name="first"; filename="first.txt"','Content-Type: text/plain','','a',
    '--'+boundary,'Content-Disposition: form-data; name="second"; filename="second.txt"','Content-Type: text/plain','','b'].join('\r\n');
  const options={fileHwm:1,streamHandler:(_req:unknown,p:PassThrough)=>{parser=p;req.pipe(p);},
    fileFilter:(_req:unknown,file:Express.Multer.File,cb:multer.FileFilterCallback)=>{
      if(file.fieldname==='first')resumeFilter=cb;
      else req.once('end',()=>setImmediate(()=>cb(filterError)));
    }};
  req.headers={'content-type':'multipart/form-data; boundary='+boundary,'content-length':String(Buffer.byteLength(body))};
  await new Promise<void>((resolve,reject)=>{
    multer(options).any()(req as any,null as any,(err:unknown)=>{
      nextCalls++;try{assert.equal(err,filterError);assert.equal(typeof resumeFilter,'function');}catch(e){reject(e);return;}
      setImmediate(()=>{parser!.once('close',()=>{
        try{assert.equal(nextCalls,1);assert.deepEqual(req.files,[]);console.log('ADVISORY_RESULT '+JSON.stringify({nextCalls,files:req.files}));resolve();}catch(e){reject(e);}
      });resumeFilter!(null,true);});
    });
    req.end(body);
  });
}

const deadline=setTimeout(()=>{throw new Error('Disposable advisory probe exceeded 45 seconds');},45000);
try {if(process.argv[2]==='http')await compressedRequest();else if(process.argv[2]==='multer')await lateFilter();else throw new Error('Unknown probe');}
finally {clearTimeout(deadline);}
