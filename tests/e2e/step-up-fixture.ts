import { createHash } from 'node:crypto';
// Disposable local browser fixtures, never production credentials.
export const stepUpUsername='step-up-browser';
export const stepUpPassword='Synthetic security confirmation phrase';
export const stepUpSessionToken=createHash('sha256').update('synthetic stale browser session').digest('hex');
const code=createHash('sha256').update('synthetic one-use browser factor').digest('hex').slice(0,10);
export const stepUpRecoveryCode=code.slice(0,5)+'-'+code.slice(5);
export const stepUpCookie='vds_session_'+createHash('sha256').update('default').digest('hex').slice(0,16);
