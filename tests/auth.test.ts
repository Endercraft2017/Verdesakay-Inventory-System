/** Integration tests: authentication, current user, password change, and RBAC. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupApp();
});
afterAll(() => cleanup(ctx));

describe('auth', () => {
  it('logs in the seeded admin', async () => {
    const res = await ctx.api.post('/api/auth/login').send({ username: 'admin', password: 'admin123' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.role).toBe('admin');
  });

  it('is case-insensitive on username', async () => {
    const res = await ctx.api.post('/api/auth/login').send({ username: 'ADMIN', password: 'admin123' });
    expect(res.status).toBe(200);
  });

  it('rejects a wrong password', async () => {
    const res = await ctx.api.post('/api/auth/login').send({ username: 'admin', password: 'nope' });
    expect(res.status).toBe(401);
  });

  it('rejects a malformed body (zod 400)', async () => {
    const res = await ctx.api.post('/api/auth/login').send({ username: 'admin' });
    expect(res.status).toBe(400);
  });

  it('returns the current user from a token', async () => {
    const token = await login(ctx.api);
    const res = await ctx.api.get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe('admin');
  });

  it('rejects requests with no token', async () => {
    const res = await ctx.api.get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('logout invalidates the token', async () => {
    const token = await login(ctx.api);
    await ctx.api.post('/api/auth/logout').set('Authorization', `Bearer ${token}`);
    const res = await ctx.api.get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });
});

describe('rbac', () => {
  it('blocks employees from creating accounts', async () => {
    const adminToken = await login(ctx.api);
    const emp = await createEmployee(ctx.api, adminToken);
    const res = await ctx.api
      .post('/api/users')
      .set('Authorization', `Bearer ${emp.token}`)
      .send({ username: 'sneaky', full_name: 'X', password: 'secret1' });
    expect(res.status).toBe(403);
  });

  it('protects the last active administrator', async () => {
    const adminToken = await login(ctx.api);
    const me = await ctx.api.get('/api/auth/me').set('Authorization', `Bearer ${adminToken}`);
    const res = await ctx.api
      .put(`/api/users/${me.body.user.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: 'employee' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/last active administrator/i);
  });
});

describe('profile', () => {
  it('lets a user update their own display name', async () => {
    const adminToken = await login(ctx.api);
    const emp = await createEmployee(ctx.api, adminToken, { username: 'nameuser' });
    const res = await ctx.api
      .put('/api/auth/profile')
      .set('Authorization', `Bearer ${emp.token}`)
      .send({ full_name: 'Renamed Person' });
    expect(res.status).toBe(200);
    const me = await ctx.api.get('/api/auth/me').set('Authorization', `Bearer ${emp.token}`);
    expect(me.body.user.full_name).toBe('Renamed Person');
  });

  it('rejects an empty name', async () => {
    const token = await login(ctx.api);
    const res = await ctx.api.put('/api/auth/profile').set('Authorization', `Bearer ${token}`).send({ full_name: '  ' });
    expect(res.status).toBe(400);
  });
});

describe('change password', () => {
  it('lets a user change their own password and rejects the old one', async () => {
    const adminToken = await login(ctx.api);
    const emp = await createEmployee(ctx.api, adminToken, { username: 'pwuser', password: 'secret1' });
    const change = await ctx.api
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${emp.token}`)
      .send({ current_password: 'secret1', new_password: 'brandnew2' });
    expect(change.status).toBe(200);

    const oldLogin = await ctx.api.post('/api/auth/login').send({ username: 'pwuser', password: 'secret1' });
    expect(oldLogin.status).toBe(401);
    const newLogin = await ctx.api.post('/api/auth/login').send({ username: 'pwuser', password: 'brandnew2' });
    expect(newLogin.status).toBe(200);
  });
});
