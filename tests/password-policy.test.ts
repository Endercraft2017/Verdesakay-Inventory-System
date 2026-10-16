import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { newPasswordSchema, passwordPolicyError } from '../src/shared/password-policy';
import { hashPassword } from '../src/shared/password-hash';
import { setupApp, cleanup, login, type TestContext } from './helpers';
let ctx: TestContext, admin: string;
beforeAll(async () => { ctx=await setupApp(); admin=await login(ctx.api); });
afterAll(() => cleanup(ctx));
describe('new-password policy', () => {
  it('requires 15 Unicode code points, preserves spaces, permits passphrases and 128-point Unicode input', () => {
    expect(passwordPolicyError('fourteen chars')).toContain('15');
    expect(passwordPolicyError('🔐'.repeat(8))).toContain('15');
    expect(passwordPolicyError('quiet otters wander')).toBeNull();
    expect(passwordPolicyError('🔐'.repeat(15))).toBeNull();
    expect(passwordPolicyError('🔐'.repeat(128))).toBeNull();
    expect(passwordPolicyError('a'.repeat(129))).toContain('128');
    expect(newPasswordSchema().parse('  a quiet river  ')).toBe('  a quiet river  ');
    expect(passwordPolicyError('Password1')).toBeTruthy();
    expect(passwordPolicyError('PasswordPassword')).toContain('most common');
    expect(passwordPolicyError('123456789012345')).toContain('most common');
  });
  it('rejects short account creation and password changes without mutating a credential', async () => {
    const h={Authorization:`Bearer ${admin}`};
    expect((await ctx.api.post('/api/users').set(h).send({username:'too-short',full_name:'Short',role:'admin',password:'short-but-new'})).status).toBe(400);
    const user = await ctx.api.post('/api/users').set(h).send({username:'long-password',full_name:'Long',role:'admin',password:'several quiet otters wander'});
    expect(user.status).toBe(201);
    const token = await login(ctx.api,'long-password','several quiet otters wander');
    expect((await ctx.api.post('/api/auth/change-password').set('Authorization',`Bearer ${token}`).send({current_password:'several quiet otters wander',new_password:'eight888'})).status).toBe(400);
    expect(await login(ctx.api,'long-password','several quiet otters wander')).toBeTruthy();
  });
  it('keeps existing short credentials usable while requiring the new policy for replacement', async () => {
    const db=await import('../src/shared/db');
    // Deliberately seed an existing credential: creation endpoints must not accept this value.
    db.run("INSERT INTO users(username,full_name,role,password_hash) VALUES('legacy-short','Legacy','warehouse',?)",hashPassword('oldpass8'));
    const token=await login(ctx.api,'legacy-short','oldpass8');
    expect((await ctx.api.post('/api/auth/change-password').set('Authorization',`Bearer ${token}`).send({current_password:'oldpass8',new_password:'another8'})).status).toBe(400);
    expect((await ctx.api.post('/api/auth/change-password').set('Authorization',`Bearer ${token}`).send({current_password:'oldpass8',new_password:'a new long replacement phrase'})).status).toBe(200);
    expect(await login(ctx.api,'legacy-short','a new long replacement phrase')).toBeTruthy();
  });
  it('applies identical length rules to direct tenant and console provisioning', async () => {
    const {upsertPlatformUser}=await import('../src/platform/platform-users');
    const {createTenant}=await import('../src/platform/provisioning');
    expect(()=>upsertPlatformUser('short-operator','short888')).toThrow('15');
    expect(()=>upsertPlatformUser('long-operator','a'.repeat(129))).toThrow('128');
    expect(()=>createTenant({slug:'short-policy',name:'Short',admin_username:'owner',admin_password:'short888'})).toThrow('15');
    expect(()=>createTenant({slug:'long-policy',name:'Long',admin_username:'owner',admin_password:'a'.repeat(129)})).toThrow('128');
  });
  it('does not weaken an existing operator through environment-based password reset', async () => {
    const users=await import('../src/platform/platform-users');
    const platform=await import('../src/platform/platform');
    users.upsertPlatformUser('bootstrap-policy','a long original console phrase');
    process.env.PLATFORM_ADMIN_USERNAME='bootstrap-policy';
    process.env.PLATFORM_ADMIN_PASSWORD='short888';
    try {
      platform._resetPlatformDb();
      // An ignored old environment value must not break an existing account.
      expect(()=>platform.platformDb()).not.toThrow();
      expect(users.platformLogin('bootstrap-policy','a long original console phrase')).toBeTruthy();
      process.env.PLATFORM_ADMIN_RESET='true';
      platform._resetPlatformDb();
      expect(()=>platform.platformDb()).toThrow('15');
      delete process.env.PLATFORM_ADMIN_RESET;
      platform._resetPlatformDb();
      expect(users.platformLogin('bootstrap-policy','a long original console phrase')).toBeTruthy();
    } finally {
      delete process.env.PLATFORM_ADMIN_USERNAME; delete process.env.PLATFORM_ADMIN_PASSWORD;
      delete process.env.PLATFORM_ADMIN_RESET;
    }
  });
  it('accepts every allowed Unicode code point through sign-in and factor confirmation schemas', async () => {
    const {loginSchema}=await import('../src/shared/validation');
    const password='🔐'.repeat(128);
    expect(loginSchema.parse({username:'unicode-user',password}).password).toHaveLength(256);
    expect((await ctx.api.post('/api/users').set('Authorization',`Bearer ${admin}`).send({username:'unicode-user',full_name:'Unicode',role:'warehouse',password})).status).toBe(201);
    const token=await login(ctx.api,'unicode-user',password);
    expect((await ctx.api.post('/api/auth/mfa/setup').set('Authorization',`Bearer ${token}`).send({password})).status).toBe(200);
  });
});
