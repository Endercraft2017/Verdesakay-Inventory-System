/** Owner-console WebAuthn storage/verification. No tenant credentials or request-derived origins. */
import crypto from 'node:crypto';
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse,
  type RegistrationResponseJSON, type AuthenticationResponseJSON } from '@simplewebauthn/server';
import { platformDb } from './platform';
import { tokenDigest } from '../shared/db';
import { verifyPassword } from '../shared/password-hash';

function db() {
  const d = platformDb();
  d.exec(`CREATE TABLE IF NOT EXISTS platform_passkeys (
    id TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
    public_key TEXT NOT NULL,counter INTEGER NOT NULL,transports TEXT NOT NULL,label TEXT NOT NULL,
    backed_up INTEGER NOT NULL,device_type TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT(datetime('now')));
    CREATE TABLE IF NOT EXISTS platform_passkey_challenges (
    token_hash TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,purpose TEXT NOT NULL,challenge TEXT NOT NULL,key_stamp TEXT NOT NULL,
    session_hash TEXT NOT NULL,password_stamp TEXT NOT NULL,expires_at TEXT NOT NULL,used INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS platform_session_security(token_hash TEXT PRIMARY KEY REFERENCES platform_sessions(token) ON DELETE CASCADE,verified_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS platform_security_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  return d;
}
function config() {
  const raw = process.env.PLATFORM_WEBAUTHN_ORIGIN || process.env.PUBLIC_APP_URL;
  if (!raw) throw Object.assign(new Error('Configure PLATFORM_WEBAUTHN_ORIGIN before enrolling console passkeys.'), { status: 503 });
  let url: URL;
  try { url = new URL(raw); } catch { throw Object.assign(new Error('Configure a valid console HTTPS origin.'),{status:503}); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && url.protocol === 'http:' && url.hostname === 'localhost'))) throw Object.assign(new Error('Console passkeys require a configured HTTPS origin.'), { status: 503 });
  return { origin: url.origin, rpID: url.hostname };
}
export function hasPlatformPasskey(id: number): boolean { return !!db().prepare('SELECT 1 FROM platform_passkeys WHERE user_id=?').get(id); }
export function requiresPlatformPasskeySetup(id: number): boolean {
  return (process.env.PLATFORM_REQUIRE_PASSKEY === 'true' || !!db().prepare("SELECT 1 FROM platform_security_settings WHERE key='require_passkeys' AND value='true'").get()) && !hasPlatformPasskey(id);
}
export function platformSessionVerified(token: string, fresh = true): boolean {
  return !!db().prepare(`SELECT 1 FROM platform_session_security WHERE token_hash=? ${fresh ? "AND verified_at>datetime('now','-5 minutes')" : ''}`).get(tokenDigest(token));
}
export function markPlatformSessionVerified(token: string): void {
  db().prepare("INSERT INTO platform_session_security VALUES(?,datetime('now')) ON CONFLICT(token_hash) DO UPDATE SET verified_at=datetime('now')").run(tokenDigest(token));
}
export function listPlatformPasskeys(id: number) { return db().prepare('SELECT id,label,backed_up,created_at FROM platform_passkeys WHERE user_id=?').all(id); }
function passwordHash(id: number): string { return (db().prepare('SELECT password_hash FROM platform_users WHERE id=?').get(id) as {password_hash:string}).password_hash; }
function keyStamp(id:number):string { return tokenDigest(JSON.stringify(db().prepare('SELECT id,public_key FROM platform_passkeys WHERE user_id=? ORDER BY id').all(id))); }
function saveChallenge(id: number, purpose: string, challenge: string, session: string): string {
  const d = db(), token = crypto.randomBytes(32).toString('hex');
  d.prepare("DELETE FROM platform_session_security WHERE token_hash NOT IN (SELECT token FROM platform_sessions)").run();
  d.prepare("DELETE FROM platform_passkey_challenges WHERE expires_at<=datetime('now') OR used=1").run();
  d.prepare('INSERT INTO platform_passkey_challenges(token_hash,user_id,purpose,challenge,session_hash,password_stamp,key_stamp,expires_at) VALUES(?,?,?,?,?,?,?,datetime(\'now\',\'+5 minutes\'))')
    .run(tokenDigest(token),id,purpose,challenge,session ? tokenDigest(session) : '',tokenDigest(passwordHash(id)),keyStamp(id));
  return token;
}
function claimChallenge(token: string, purpose: string, session: string) {
  const d = db();
  const row = d.prepare("SELECT * FROM platform_passkey_challenges WHERE token_hash=? AND purpose=? AND session_hash=? AND used=0 AND expires_at>datetime('now')").get(tokenDigest(token),purpose,session ? tokenDigest(session) : '') as {user_id:number;challenge:string;password_stamp:string;key_stamp:string} | undefined;
  if (!row || row.password_stamp !== tokenDigest(passwordHash(row.user_id)) || row.key_stamp!==keyStamp(row.user_id)) throw Object.assign(new Error('Verification expired. Start again.'),{status:400});
  if (Number(d.prepare('UPDATE platform_passkey_challenges SET used=1 WHERE token_hash=? AND used=0').run(tokenDigest(token)).changes)!==1) throw Object.assign(new Error('Verification already used.'),{status:400});
  return row;
}
export async function registrationOptions(id: number, session: string, password: string) {
  const cfg = config(), d = db();
  if (!verifyPassword(password,passwordHash(id))) throw Object.assign(new Error('Current password is incorrect.'),{status:403});
  if (hasPlatformPasskey(id) && !platformSessionVerified(session)) throw Object.assign(new Error('Verify an existing passkey before adding another.'),{status:403});
  const keys = listPlatformPasskeys(id);
  if (keys.length>=10) throw Object.assign(new Error('Maximum ten passkeys per operator.'),{status:409});
  const user = d.prepare('SELECT username FROM platform_users WHERE id=?').get(id) as {username:string};
  const options = await generateRegistrationOptions({rpName:'Otom owner console',rpID:cfg.rpID,userName:user.username,userID:new TextEncoder().encode(`platform:${id}`),attestationType:'none',supportedAlgorithmIDs:[-7,-257],
    authenticatorSelection:{residentKey:'required',userVerification:'required'},preferredAuthenticatorType:'localDevice',excludeCredentials:keys.map(k=>({id:String(k.id)}))});
  return {options,token:saveChallenge(id,'register',options.challenge,session)};
}
export async function finishRegistration(id: number, session: string, token: string, response: RegistrationResponseJSON, label: string) {
  const row = claimChallenge(token,'register',session), cfg=config();
  if (row.user_id!==id) throw Object.assign(new Error('Wrong operator.'),{status:403});
  const result = await verifyRegistrationResponse({response,expectedChallenge:row.challenge,expectedOrigin:cfg.origin,expectedRPID:cfg.rpID,requireUserVerification:true});
  if (!result.verified || !result.registrationInfo) throw new Error('Passkey verification failed.');
  // Recheck account/session state after the asynchronous signature verification.
  const d=db();
  if (!d.prepare("SELECT 1 FROM platform_sessions WHERE token=? AND user_id=? AND expires_at>datetime('now')").get(tokenDigest(session),id) || row.password_stamp!==tokenDigest(passwordHash(id)) || row.key_stamp!==keyStamp(id)) throw Object.assign(new Error('Session changed. Sign in again.'),{status:403});
  const {credential,credentialBackedUp,credentialDeviceType}=result.registrationInfo;
  d.prepare('INSERT INTO platform_passkeys(id,user_id,public_key,counter,transports,label,backed_up,device_type) VALUES(?,?,?,?,?,?,?,?)').run(credential.id,id,Buffer.from(credential.publicKey).toString('base64url'),credential.counter,JSON.stringify(credential.transports||[]),label,credentialBackedUp?1:0,credentialDeviceType);
  d.prepare('DELETE FROM platform_sessions WHERE user_id=? AND token<>?').run(id,tokenDigest(session));
  markPlatformSessionVerified(session);
}
export async function authenticationOptions(id: number, session = '') {
  const keys=db().prepare('SELECT id,transports FROM platform_passkeys WHERE user_id=?').all(id) as {id:string;transports:string}[];
  if (!keys.length) throw Object.assign(new Error('No enrolled passkey.'),{status:409});
  const options=await generateAuthenticationOptions({rpID:config().rpID,userVerification:'required',allowCredentials:keys.map(k=>({id:k.id,transports:JSON.parse(k.transports)}))});
  return {options,token:saveChallenge(id,session?'stepup':'login',options.challenge,session)};
}
export async function finishAuthentication(token: string,response: AuthenticationResponseJSON,session=''): Promise<number> {
  const row=claimChallenge(token,session?'stepup':'login',session),d=db(),cfg=config();
  const key=d.prepare('SELECT * FROM platform_passkeys WHERE id=? AND user_id=?').get(response.id,row.user_id) as {id:string;public_key:string;counter:number;transports:string}|undefined;
  if (!key) throw Object.assign(new Error('Passkey is not enrolled for this operator.'),{status:403});
  const result=await verifyAuthenticationResponse({response,expectedChallenge:row.challenge,expectedOrigin:cfg.origin,expectedRPID:cfg.rpID,requireUserVerification:true,
    credential:{id:key.id,publicKey:new Uint8Array(Buffer.from(key.public_key,'base64url')),counter:key.counter,transports:JSON.parse(key.transports)}});
  if (!result.verified || row.password_stamp!==tokenDigest(passwordHash(row.user_id)) || row.key_stamp!==keyStamp(row.user_id)) throw new Error('Passkey verification failed.');
  if (session && !d.prepare("SELECT 1 FROM platform_sessions WHERE token=? AND user_id=? AND expires_at>datetime('now')").get(tokenDigest(session),row.user_id)) throw Object.assign(new Error('Session expired.'),{status:403});
  if (Number(d.prepare('UPDATE platform_passkeys SET counter=?,backed_up=? WHERE id=? AND user_id=? AND counter=?').run(result.authenticationInfo.newCounter,result.authenticationInfo.credentialBackedUp?1:0,key.id,row.user_id,key.counter).changes)!==1) throw Object.assign(new Error('Credential changed. Try again.'),{status:409});
  if (session) markPlatformSessionVerified(session);
  return row.user_id;
}
export function requireAllPlatformPasskeys(session: string): void {
  if (!platformSessionVerified(session)) throw Object.assign(new Error('Verify your passkey first.'),{status:403});
  db().prepare("INSERT INTO platform_security_settings VALUES('require_passkeys','true') ON CONFLICT(key) DO UPDATE SET value='true'").run();
}

export function removePlatformPasskey(id:number,session:string,keyId:string,password:string):void {
  if (!platformSessionVerified(session) || !verifyPassword(password,passwordHash(id))) throw Object.assign(new Error('Verify your passkey and current password first.'),{status:403});
  if (listPlatformPasskeys(id).length<2) throw Object.assign(new Error('Enroll and test a backup passkey before removing the last one.'),{status:409});
  if (Number(db().prepare('DELETE FROM platform_passkeys WHERE id=? AND user_id=?').run(keyId,id).changes)!==1) throw Object.assign(new Error('Passkey not found.'),{status:404});
  db().prepare('DELETE FROM platform_sessions WHERE user_id=? AND token<>?').run(id,tokenDigest(session));
}
