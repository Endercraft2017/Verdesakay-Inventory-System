/** Negative authorization boundaries complement real WebAuthn signatures in Playwright. */
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { setupApp, cleanup, type TestContext } from './helpers';
let ctx: TestContext, token: string, id: number;
let keys: typeof import('../src/platform/platform-passkeys');
let users: typeof import('../src/platform/platform-users');
let db: ReturnType<typeof import('../src/platform/platform')['platformDb']>;
const headers = () => ({ Authorization: `Bearer ${token}` });
beforeAll(async () => {
  process.env.PLATFORM_CONSOLE = 'true';
  process.env.PLATFORM_WEBAUTHN_ORIGIN = 'https://console.example.test';
  ctx = await setupApp();
  users = await import('../src/platform/platform-users');
  keys = await import('../src/platform/platform-passkeys');
  db = (await import('../src/platform/platform')).platformDb();
  users.upsertPlatformUser('passkey-operator', 'Synthetic console password', 'Operator');
  token = users.platformLogin('passkey-operator', 'Synthetic console password')!;
  id = Number((db.prepare('SELECT id FROM platform_users WHERE username=?').get('passkey-operator') as {id:number}).id);
});
afterAll(() => {
  delete process.env.PLATFORM_CONSOLE; delete process.env.PLATFORM_WEBAUTHN_ORIGIN;
  delete process.env.PLATFORM_REQUIRE_PASSKEY; cleanup(ctx);
});
describe('operator passkey boundaries', () => {
  it('uses the configured RP, requires user verification and binds enrollment to the password', async () => {
    const bad = await ctx.api.post('/_platform/api/passkeys/register/options').set(headers()).send({current_password:'wrong'});
    expect(bad.status).toBe(403);
    const result = await ctx.api.post('/_platform/api/passkeys/register/options').set(headers()).set('X-Forwarded-Host','attacker.example.test').send({current_password:'Synthetic console password'});
    expect(result.status).toBe(200);
    expect(result.body.options.rp.id).toBe('console.example.test');
    expect(result.body.options.authenticatorSelection.userVerification).toBe('required');
    expect(result.body.options.authenticatorSelection.residentKey).toBe('required');
    expect(result.headers['cache-control']).toBe('no-store');
  });
  it('rejects malformed, replayed and cross-session registration responses', async () => {
    const first = await keys.registrationOptions(id,token,'Synthetic console password');
    const response = {id:'fake',type:'public-key'} as any;
    await expect(keys.finishRegistration(id,'different-session',first.token,response,'test')).rejects.toThrow();
    await expect(keys.finishRegistration(id,token,first.token,response,'test')).rejects.toThrow();
    await expect(keys.finishRegistration(id,token,first.token,response,'test')).rejects.toThrow('Verification expired');
    expect(keys.hasPlatformPasskey(id)).toBe(false);
  });
  it('invalidates challenges after password changes or expiry', async () => {
    const first = await keys.registrationOptions(id,token,'Synthetic console password');
    db.prepare("UPDATE platform_passkey_challenges SET expires_at=datetime('now','-1 second')").run();
    await expect(keys.finishRegistration(id,token,first.token,{} as any,'test')).rejects.toThrow();
    const next = await keys.registrationOptions(id,token,'Synthetic console password');
    db.prepare("UPDATE platform_users SET password_hash=password_hash||'x' WHERE id=?").run(id);
    await expect(keys.finishRegistration(id,token,next.token,{} as any,'test')).rejects.toThrow();
    db.prepare('UPDATE platform_users SET password_hash=substr(password_hash,1,length(password_hash)-1) WHERE id=?').run(id);
  });
  it('does not infer a relying party from request headers or permit insecure production origins', async () => {
    delete process.env.PLATFORM_WEBAUTHN_ORIGIN;
    const previous = process.env.PUBLIC_APP_URL; delete process.env.PUBLIC_APP_URL;
    await expect(keys.registrationOptions(id,token,'Synthetic console password')).rejects.toMatchObject({status:503});
    if (previous !== undefined) process.env.PUBLIC_APP_URL=previous;
    process.env.PLATFORM_WEBAUTHN_ORIGIN='http://insecure.example.test';
    await expect(keys.registrationOptions(id,token,'Synthetic console password')).rejects.toMatchObject({status:503});
    process.env.PLATFORM_WEBAUTHN_ORIGIN='https://console.example.test';
  });
  it('limits a mandatory unenrolled session to setup and logout', async () => {
    process.env.PLATFORM_REQUIRE_PASSKEY='true';
    expect((await ctx.api.get('/_platform/api/me').set(headers())).body.passkey_setup_required).toBe(true);
    expect((await ctx.api.get('/_platform/api/tenants').set(headers())).status).toBe(403);
    expect((await ctx.api.post('/_platform/api/password').set(headers()).send({})).status).toBe(403);
    expect((await ctx.api.get('/_platform/api/passkeys').set(headers())).status).toBe(200);
    delete process.env.PLATFORM_REQUIRE_PASSKEY;
  });
  it('blocks password-only login, stale sessions and unfresh mutations once enrolled', async () => {
    // Synthetic public key is used only for policy denial checks, never a successful signature.
    db.prepare('INSERT INTO platform_passkeys(id,user_id,public_key,counter,transports,label,backed_up,device_type) VALUES(?,?,?,0,?,?,0,?)').run('synthetic-key',id,'AA','[]','test','singleDevice');
    expect(users.platformLogin('passkey-operator','Synthetic console password')).toBeNull();
    const challenge = await ctx.api.post('/_platform/api/login').send({username:'passkey-operator',password:'Synthetic console password'});
    expect(challenge.body.passkey_required).toBe(true);
    expect(challenge.body.options.userVerification).toBe('required');
    expect(challenge.headers['set-cookie']).toBeUndefined();
    expect((await ctx.api.get('/_platform/api/tenants').set(headers())).status).toBe(403);
    keys.markPlatformSessionVerified(token);
    expect((await ctx.api.get('/_platform/api/tenants').set(headers())).status).toBe(200);
    db.exec("UPDATE platform_session_security SET verified_at=datetime('now','-6 minutes')");
    expect((await ctx.api.post('/_platform/api/tenants').set(headers()).send({})).body.passkey_required).toBe(true);
    expect((await ctx.api.get('/_platform/api/tenants').set(headers())).status).toBe(200);
    expect(() => keys.requireAllPlatformPasskeys(token)).toThrow();
    keys.markPlatformSessionVerified(token);
    expect(() => keys.removePlatformPasskey(id,token,'synthetic-key','Synthetic console password')).toThrow('backup');
    users.platformLogout(token);
    expect((await ctx.api.get('/_platform/api/tenants').set(headers())).status).toBe(401);
  });
});
