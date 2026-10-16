import bcrypt from 'bcryptjs';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { setupApp, cleanup, login, type TestContext } from './helpers';
let ctx: TestContext;
let db: typeof import('../src/shared/db');
let operators: typeof import('../src/platform/platform-users');
beforeAll(async () => {
  process.env.PLATFORM_CONSOLE = 'true';
  ctx = await setupApp();
  await login(ctx.api);
  db = await import('../src/shared/db');
  operators = await import('../src/platform/platform-users');
});
afterAll(() => { delete process.env.PLATFORM_CONSOLE; cleanup(ctx); });
const bearer = (token: string) => ({ Authorization: 'Bearer ' + token });
const current = 'Current-pass-2468';
const next = 'Changed-pass-1357';
function addUser(name: string, role = 'employee') {
  return Number(db.run('INSERT INTO users (username, full_name, password_hash, role, password_change_required) VALUES (?, ?, ?, ?, 0)', name, name, bcrypt.hashSync(current, 4), role).lastInsertRowid);
}

describe('tenant self-service credentials', () => {
  it('allows every configured role to change their own username and password', async () => {
    const { listRoles } = await import('../src/shared/roles');
    const roles = listRoles();
    expect(roles.length).toBeGreaterThan(1);
    for (const [index, role] of roles.entries()) {
      const oldName = 'credential-' + index;
      const newName = 'renamed-' + index;
      addUser(oldName, role.key);
      const token = await login(ctx.api, oldName, current);
      const other = await login(ctx.api, oldName, current);
      const renamed = await ctx.api.post('/api/auth/change-username').set(bearer(token)).send({ new_username: ' ' + newName.toUpperCase() + ' ', current_password: current });
      expect(renamed.status, role.key).toBe(200);
      expect(renamed.body.username).toBe(newName);
      expect((await ctx.api.get('/api/auth/me').set(bearer(token))).body.user.username).toBe(newName);
      expect((await ctx.api.get('/api/auth/me').set(bearer(other))).status).toBe(401);
      expect((await ctx.api.post('/api/auth/login').send({ username: oldName, password: current })).status).toBe(401);
      const updated = await ctx.api.post('/api/auth/change-password').set(bearer(token)).send({ current_password: current, new_password: next });
      expect(updated.status, role.key).toBe(200);
      expect((await ctx.api.post('/api/auth/login').send({ username: newName, password: current })).status).toBe(401);
      expect((await ctx.api.post('/api/auth/login').send({ username: newName, password: next })).status).toBe(200);
    }
  }, 60000); // Exercises every role with production-strength password derivations.
  it('requires a session and current password, rejects duplicates, and only edits the caller', async () => {
    const own = addUser('credential-owner');
    const target = addUser('credential-target');
    const token = await login(ctx.api, 'credential-owner', current);
    const request = (body: object) => ctx.api.post('/api/auth/change-username').set(bearer(token)).send(body);
    expect((await ctx.api.post('/api/auth/change-username').send({ new_username: 'name', current_password: current })).status).toBe(401);
    expect((await request({ new_username: 'different', current_password: 'wrong' })).status).toBe(400);
    expect((await request({ new_username: 'CREDENTIAL-TARGET', current_password: current })).status).toBe(409);
    for (const name of ['x', 'invalid name', 'x'.repeat(31)]) expect((await request({ new_username: name, current_password: current })).status).toBe(400);
    const result = await request({ new_username: 'credential-self', current_password: current, user_id: target });
    expect(result.status).toBe(200);
    expect(db.queryOne<{ username: string }>('SELECT username FROM users WHERE id = ?', own)?.username).toBe('credential-self');
    expect(db.queryOne<{ username: string }>('SELECT username FROM users WHERE id = ?', target)?.username).toBe('credential-target');
  });
});

describe('owner-console credentials', () => {
  it('changes operator usernames with password confirmation and preserves only the current session', async () => {
    operators.upsertPlatformUser('operator-old', current);
    operators.upsertPlatformUser('operator-taken', current);
    const start = async (name: string, password = current) => ctx.api.post('/_platform/api/login').send({ username: name, password });
    const token = (await start('operator-old')).body.token;
    const other = (await start('operator-old')).body.token;
    const rename = (name: string, password = current) => ctx.api.post('/_platform/api/username').set(bearer(token)).send({ new_username: name, current_password: password });
    expect((await ctx.api.post('/_platform/api/username').send({ new_username: 'new', current_password: current })).status).toBe(401);
    expect((await rename('operator-new', 'wrong')).status).toBe(400);
    expect((await rename('OPERATOR-TAKEN')).status).toBe(409);
    expect((await rename('invalid space')).status).toBe(400);
    const response = await rename(' OPERATOR-NEW ');
    expect(response.status).toBe(200);
    expect(response.body.username).toBe('operator-new');
    expect((await ctx.api.get('/_platform/api/me').set(bearer(token))).body.user.username).toBe('operator-new');
    expect((await ctx.api.get('/_platform/api/me').set(bearer(other))).status).toBe(401);
    expect((await start('operator-old')).status).toBe(401);
    expect((await start('operator-new')).status).toBe(200);
    expect((await ctx.api.post('/_platform/api/password').set(bearer(token)).send({ current_password: current, new_password: next })).status).toBe(200);
    expect((await start('operator-new')).status).toBe(401);
    expect((await start('operator-new', next)).status).toBe(200);
  });
});
