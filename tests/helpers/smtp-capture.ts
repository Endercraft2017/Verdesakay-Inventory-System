/** Isolated TLS SMTP peer. Its wire observations are independent of the app's result rows. */
import tls from 'node:tls';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
export type SmtpMode='accept'|'reject'|'disconnect'|'hold-data'|'hold-greeting'|'reject-data'|'reject-temporary';
export interface CapturedMessage {from:string;to:string[];raw:string;html:string;message_id:string|null}
export async function smtpCapture(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'payroll-smtp-'));
 const key=path.join(dir,'key.pem'),cert=path.join(dir,'cert.pem');
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1','-keyout',key,'-out',cert],{stdio:'ignore'});
 const pem=fs.readFileSync(cert,'utf8');
 // Trust this ephemeral test CA; verification remains enabled in the production transport.
 const previous=tls.getCACertificates('default');tls.setDefaultCACertificates([...previous,pem]);
 const sockets=new Set<tls.TLSSocket>(),messages:CapturedMessage[]=[],connections:{count:number}={count:0};let mode:SmtpMode='accept';const recipientModes=new Map<string,SmtpMode>();
 const held:Array<()=>void>=[];
 const server=tls.createServer({key:fs.readFileSync(key),cert:pem},socket=>{
  sockets.add(socket);connections.count++;socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));
  if(mode==='hold-greeting')held.push(()=>socket.write('220 capture.example.test ESMTP\r\n'));else socket.write('220 capture.example.test ESMTP\r\n');
  let buffer='',inData=false,from='',to:string[]=[],transactionMode=mode;
  socket.on('data',chunk=>{
   buffer+=chunk.toString('utf8');
   while(true){
    if(inData){const end=buffer.indexOf('\r\n.\r\n');if(end<0)return;const raw=buffer.slice(0,end).replace(/^\.\./gm,'.');buffer=buffer.slice(end+5);inData=false;
     const body=raw.slice(raw.indexOf('\r\n\r\n')+4);let html=body;
     if(/content-transfer-encoding: quoted-printable/i.test(raw)){const bytes=body.replace(/=\r\n/g,'').replace(/=([0-9a-f]{2})/gi,(_,h)=>String.fromCharCode(parseInt(h,16)));html=Buffer.from(bytes,'binary').toString('utf8');}
     else if(/content-transfer-encoding: base64/i.test(raw))html=Buffer.from(body.replace(/\s/g,''),'base64').toString('utf8');
     messages.push({from,to:[...to],raw,html,message_id:raw.match(/^Message-ID:\s*(.+)$/mi)?.[1]?.trim()??null});
     if(transactionMode==='disconnect'){socket.destroy();return;}if(transactionMode==='hold-data')held.push(()=>socket.write('250 2.0.0 stored by capture\r\n'));else if(transactionMode==='reject-data')socket.write('550 5.7.1 synthetic DATA rejection\r\n');else socket.write('250 2.0.0 stored by capture\r\n');continue;
    }
    const end=buffer.indexOf('\r\n');if(end<0)return;const line=buffer.slice(0,end);buffer=buffer.slice(end+2);
    if(/^(EHLO|HELO)\b/i.test(line))socket.write('250-capture.example.test\r\n250 SIZE 2097152\r\n');
    else if(/^MAIL FROM:/i.test(line)){from=line.replace(/^MAIL FROM:\s*/i,'').split(' ')[0]!;to=[];transactionMode=mode;socket.write('250 Sender OK\r\n');}
    else if(/^RCPT TO:/i.test(line)){transactionMode=recipientModes.get(line.replace(/^RCPT TO:\s*</i,'').replace(/>.*/,''))??transactionMode;if(transactionMode==='reject'||transactionMode==='reject-temporary')socket.write(transactionMode==='reject'?'550 5.1.1 synthetic recipient rejected\r\n':'451 4.3.0 synthetic temporary rejection\r\n');else{to.push(line.replace(/^RCPT TO:\s*/i,'').split(' ')[0]!);socket.write('250 Recipient OK\r\n');}}
    else if(/^DATA$/i.test(line)){inData=true;socket.write('354 End data with CRLF.CRLF\r\n');}
    else if(/^QUIT$/i.test(line)){socket.end('221 Bye\r\n');return;}
    else socket.write('250 OK\r\n');
   }
  });
 });
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const address=server.address();if(!address||typeof address==='string')throw new Error('No SMTP port');
 return {port:address.port,cert,dir,messages,connections,activeConnections:()=>sockets.size,setRecipientMode:(recipient:string,value:SmtpMode)=>{recipientModes.set(recipient,value);},setMode:(value:SmtpMode)=>{mode=value;},release:()=>{for(const send of held.splice(0))send();},reset:()=>{messages.length=0;connections.count=0;mode='accept';},close:async()=>{for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));tls.setDefaultCACertificates(previous);fs.rmSync(dir,{recursive:true,force:true});}};
}
