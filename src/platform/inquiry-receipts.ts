/** Public inquiry acknowledgement: no private response/body or raw key is stored here. */
import {createHash} from 'node:crypto';
import {platformDb} from './platform';
import {getInquiry,type NewInquiry} from './inquiries';
import {hashPasswordForPublicRequest,verifyPasswordForLogin} from '../shared/password-hash';
import {ControlPlaneError} from './request-errors';

type Receipt = {keyHash:string;verifier:string;replay:boolean};
const TTL=24*60*60*1000;
export function pruneInquiryReceipts():void {
  platformDb().prepare('UPDATE platform_inquiry_receipts SET verifier=NULL WHERE expires_at<=? AND verifier IS NOT NULL').run(Date.now());
}
/** Call after host/rate-limit/schema/honeypot checks; never use a key as authentication. */
export async function prepareInquiryReceipt(key:string|undefined,input:NewInquiry):Promise<Receipt|null> {
  if(key===undefined)return null; // Legacy clients retain their old behavior.
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key))throw new ControlPlaneError(400,'Idempotency-Key must be a random UUID v4.');
  pruneInquiryReceipts();
  const keyHash=createHash('sha256').update(key.toLowerCase()).digest('hex');
  const digest=createHash('sha256').update(JSON.stringify([input.name,input.company,input.email,input.phone||null,input.employees||null,input.modules||[],input.message||null])).digest('hex');
  const row=platformDb().prepare('SELECT verifier,inquiry_id,expires_at FROM platform_inquiry_receipts WHERE key_hash=?').get(keyHash) as {verifier:string|null;inquiry_id:number;expires_at:number}|undefined;
  if(row){
    if(!row.verifier||row.expires_at<=Date.now()||!(await verifyPasswordForLogin(digest,row.verifier,false)).valid){
      throw new ControlPlaneError(409,'This inquiry request cannot be repeated with these details. Restore the original message or contact us before sending another.');
    }
    // Awaited work admits concurrent changes: recheck the live receipt/source before acknowledging.
    const current=platformDb().prepare('SELECT verifier,inquiry_id,expires_at FROM platform_inquiry_receipts WHERE key_hash=?').get(keyHash);
    if(!current||current.verifier!==row.verifier||current.inquiry_id!==row.inquiry_id||Number(current.expires_at)<=Date.now()||!getInquiry(row.inquiry_id)) {
      throw new ControlPlaneError(409,'This inquiry request cannot be repeated with these details. Restore the original message or contact us before sending another.');
    }
    return {keyHash,verifier:row.verifier,replay:true};
  }
  // Slow salted binding avoids persisting a cheap verifier for private contact/message fields.
  return {keyHash,verifier:await hashPasswordForPublicRequest(digest),replay:false};
}
/** Trusted synchronous createInquiry callback: source, enabled alert and receipt commit together. */
export function saveInquiryReceipt(receipt:Receipt|null,inquiryId:number):undefined {
  if(!receipt)return;
  const inserted=platformDb().prepare(`INSERT INTO platform_inquiry_receipts(key_hash,verifier,inquiry_id,expires_at) VALUES(?,?,?,?)
    ON CONFLICT(key_hash) DO NOTHING`).run(receipt.keyHash,receipt.verifier,inquiryId,Date.now()+TTL);
  if(inserted.changes!==1)throw new ControlPlaneError(409,'Another request completed this inquiry. Retry with the same details.');
}
