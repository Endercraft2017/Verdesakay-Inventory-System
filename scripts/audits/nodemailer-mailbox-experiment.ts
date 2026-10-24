/** OPEN exact-mailbox experiment. Exit 1 is retained evidence, not a passing gate.
 * Run: node --import tsx scripts/audits/nodemailer-mailbox-experiment.ts
 * Only a disposable loopback TLS SMTP peer receives synthetic content.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import nodemailer from 'nodemailer';
import {smtpCapture} from '../../tests/helpers/smtp-capture';

const to='<"a@outside.example.test>"@approved.example.test>',peer=await smtpCapture();
const transport=nodemailer.createTransport({host:'127.0.0.1',port:peer.port,secure:true});
try {
  await transport.sendMail({from:'sender@example.test',to,subject:'Synthetic exact-mailbox experiment',text:'Synthetic non-customer content'});
  const result={input:to,expectedEnvelope:to,commands:peer.commands,messages:peer.messages};
  const dir=process.env.DEPENDENCY_EVIDENCE_DIR;
  if(dir){fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'quoted-mailbox-experiment.json'),JSON.stringify(result,null,2)+'\n');}
  console.log(JSON.stringify(result,null,2));
  // Retain the original strict oracle. Do not silently accept domain-only preservation.
  assert.deepEqual(peer.commands.filter(c=>c.startsWith('RCPT TO:')),['RCPT TO:'+to]);
}finally {transport.close();await peer.close();}
