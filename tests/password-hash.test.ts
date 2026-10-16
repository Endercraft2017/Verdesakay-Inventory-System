import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { hashPassword, verifyPassword, passwordNeedsUpgrade } from '../src/shared/password-hash';
import { setupApp, cleanup, type TestContext } from './helpers';

it('salts credentials and verifies the entire long Unicode password', () => {
  const password = '🔐'.repeat(25) + randomUUID();
  const first = hashPassword(password);
  expect(first).not.toBe(hashPassword(password));
  expect(first).not.toContain(password);
  expect(verifyPassword(password, first)).toBe(true);
  expect(verifyPassword(password.slice(0, -1) + '!', first)).toBe(false);
  expect(verifyPassword('🔐'.repeat(25) + 'different suffix', first)).toBe(false);
  expect(passwordNeedsUpgrade(first)).toBe(false);
});

it('supports legacy credentials without accepting bcrypt truncation aliases', () => {
  const password = randomUUID();
  const legacy = bcrypt.hashSync(password, 4);
  expect(verifyPassword(password, legacy)).toBe(true);
  expect(verifyPassword('wrong', legacy)).toBe(false);
  expect(passwordNeedsUpgrade(legacy)).toBe(true);
  const boundary = 'a'.repeat(72);
  const longHash = bcrypt.hashSync(boundary + 'original', 4);
  expect(bcrypt.compareSync(boundary + 'attacker', longHash)).toBe(true);
  expect(verifyPassword(boundary + 'attacker', longHash)).toBe(false);
  expect(verifyPassword('🔐'.repeat(19), bcrypt.hashSync('🔐'.repeat(19), 4))).toBe(false);
});

it('rejects malformed, unbounded-cost and oversized credential inputs', () => {
  for (const encoded of ['garbage', '', 'scrypt$v2$131072$8$1$aa$bb', '$2a$99$' + 'a'.repeat(53), 'scrypt$v1$999999999$8$1$aa$bb']) {
    expect(verifyPassword('example', encoded)).toBe(false);
  }
  expect(() => hashPassword('a'.repeat(4097))).toThrow();
  expect(verifyPassword('a'.repeat(4097), 'garbage')).toBe(false);
});

let ctx: TestContext;
let db: typeof import('../src/shared/db');
beforeAll(async () => { ctx = await setupApp(); db = await import('../src/shared/db'); });
afterAll(() => cleanup(ctx));

it('upgrades only a successful tenant login and keeps the new hash usable', async () => {
  const password = randomUUID();
  const legacy = bcrypt.hashSync(password, 4);
  db.run('UPDATE users SET password_hash = ? WHERE id = 1', legacy);
  expect((await ctx.api.post('/api/auth/login').send({ username: 'admin', password: 'incorrect' })).status).toBe(401);
  expect(db.queryOne<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = 1')!.password_hash).toBe(legacy);
  expect((await ctx.api.post('/api/auth/login').send({ username: 'admin', password })).status).toBe(200);
  const migrated = db.queryOne<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = 1')!.password_hash;
  expect(passwordNeedsUpgrade(migrated)).toBe(false);
  expect(verifyPassword(password, migrated)).toBe(true);
  expect((await ctx.api.post('/api/auth/login').send({ username: 'admin', password })).status).toBe(200);
});

it('upgrades platform credentials in their separate database and rejects a wrong password', async () => {
  const { platformDb } = await import('../src/platform/platform');
  const { platformLogin } = await import('../src/platform/platform-users');
  const password = randomUUID();
  const legacy = bcrypt.hashSync(password, 4);
  platformDb().prepare('INSERT INTO platform_users(username,password_hash) VALUES (?,?)').run('hash-owner', legacy);
  expect(platformLogin('hash-owner', 'wrong')).toBeNull();
  expect(platformLogin('hash-owner', password)).toBeTruthy();
  const row = platformDb().prepare('SELECT password_hash FROM platform_users WHERE username = ?').get('hash-owner') as { password_hash: string };
  expect(row.password_hash.startsWith('scrypt$v1$')).toBe(true);
  expect(verifyPassword(password, row.password_hash)).toBe(true);
});

it('does not change cloud-owned credentials during an installed-site login', async () => {
  const password = randomUUID();
  const legacy = bcrypt.hashSync(password, 4);
  db.run('UPDATE users SET password_hash = ? WHERE id = 1', legacy);
  const before = process.env.DEPLOY_MODE;
  process.env.DEPLOY_MODE = 'node';
  try {
    expect((await ctx.api.post('/api/auth/login').send({ username: 'admin', password })).status).toBe(200);
    expect(db.queryOne<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = 1')!.password_hash).toBe(legacy);
  } finally {
    if (before === undefined) delete process.env.DEPLOY_MODE; else process.env.DEPLOY_MODE = before;
  }
});
