/** One bounded SMTP attempt; never retries and never interprets a lost reply as rejection. */
import nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import {Socket} from 'node:net';
import {createHash} from 'node:crypto';
import {getSetting} from './db';
import {getMailSettings} from './mailer';
import {decryptSecret} from './secrets';
export const mailContentHash=(html:string)=>createHash('sha256').update(html).digest('hex');
export const mailDigest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function singleMailbox(value:unknown):string {
 if(typeof value!=='string'||value.length>254||! /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(value))
  throw Object.assign(new Error('Use one valid email address on the linked active account and in sender settings. Display names and recipient lists are not supported.'),{status:409});
 // RFC 5321 section 2.4: domain case is insignificant; local-part case is preserved.
 const at=value.lastIndexOf('@');return value.slice(0,at+1)+value.slice(at+1).toLowerCase();
}
export function reviewedSmtpConfig(){
 const settings=getMailSettings(),password=getSetting<string>('mail_smtp_pass')||'';
 if(settings.transport!=='smtp'||!settings.smtp_host||!Number.isInteger(settings.smtp_port)||settings.smtp_port<1||settings.smtp_port>65535)
  throw Object.assign(new Error('Configure SMTP under Email settings before reviewing release.'),{status:409});
 settings.from_email=singleMailbox(settings.from_email);if(settings.reply_to)settings.reply_to=singleMailbox(settings.reply_to);
 return {settings,password,stamp:mailDigest([settings,password])};
}
export interface ReviewedMessage {to:string;html:string;subject:string;message_id:string;date:string}
export interface SmtpOutcome {state:'accepted'|'not_accepted'|'unknown';code:string}
export async function submitReviewedMail(message:ReviewedMessage,config:ReturnType<typeof reviewedSmtpConfig>):Promise<SmtpOutcome>{
 const s=config.settings,socket=new Socket();
 // Own the socket as well as the transport: non-pooled transport.close alone does not
 // reliably abort active SMTP I/O. Certificate verification is never disabled.
 const transport=nodemailer.createTransport({socket,host:s.smtp_host,port:s.smtp_port,secure:s.smtp_secure,
  requireTLS:!s.smtp_secure,connectionTimeout:10_000,greetingTimeout:10_000,socketTimeout:15_000,
  auth:s.smtp_user?{user:s.smtp_user,pass:decryptSecret(config.password)}:undefined} as SMTPTransport.Options);
 let timer:ReturnType<typeof setTimeout>|undefined;
 try {
  const info=await Promise.race([
   transport.sendMail({from:{name:s.from_name,address:s.from_email},to:{address:message.to,name:''},replyTo:s.reply_to||undefined,
    envelope:{from:s.from_email,to:[message.to]},subject:message.subject,html:message.html,messageId:message.message_id,date:new Date(message.date),
    disableFileAccess:true,disableUrlAccess:true}),
   new Promise<never>((_,reject)=>{timer=setTimeout(()=>{socket.destroy();transport.close();reject(new Error('SMTP deadline'));},30_000);})
  ]);
  const accepted=info.accepted as Array<string|{address:string}>|undefined;
  return accepted?.length===1&&(typeof accepted[0]==='string'?accepted[0]:accepted[0]?.address)===message.to&&!(info.rejected?.length)&&/^2\d\d\b/.test(info.response)
   ?{state:'accepted',code:'smtp_accepted'}:{state:'unknown',code:'unexpected_smtp_result'};
 }catch(error){
  const e=error as {responseCode?:number;command?:string};
  const negative=typeof e.responseCode==='number'&&e.responseCode>=400&&e.responseCode<=599&&/^(?:AUTH\b|EHLO\b|HELO\b|MAIL\b|RCPT\b|DATA\b|STARTTLS\b)/.test(e.command||'');
  return negative?{state:'not_accepted',code:'smtp_rejected_'+e.responseCode}:{state:'unknown',code:'smtp_outcome_unknown'};
 }finally{if(timer)clearTimeout(timer);socket.destroy();transport.close();}
}
