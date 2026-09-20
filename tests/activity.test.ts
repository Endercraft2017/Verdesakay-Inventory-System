/** Activity log: middleware records mutations (not GETs), redacts secrets, and the
    read API is admin-only (audit.view). */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';

let ctx: TestContext;
let token: string;
const authHdr = () => ({ Authorization: `Bearer ${token}` });

/** The audit INSERT runs in the response 'finish' handler — let it settle. */
const tick = () => new Promise((r) => setTimeout(r, 30));

beforeAll(async () => {
  ctx = await setupApp();
  token = await login(ctx.api);
});
afterAll(() => cleanup(ctx));

describe('activity log', () => {
  it('records a mutating request with who / what / result', async () => {
    const created = await ctx.api
      .post('/api/inventory').set(authHdr())
      .send({ name: 'Audited Widget', quantity: 1 });
    expect(created.status).toBe(201);
    await tick();

    const res = await ctx.api.get('/api/activity?entity=inventory&action=create').set(authHdr());
    expect(res.status).toBe(200);
    // entity_id for a create comes from the JSON response's { id }.
    const row = res.body.rows.find((r: { entity_id: string }) => r.entity_id === String(created.body.id));
    expect(row).toBeTruthy();
    expect(row.method).toBe('POST');
    expect(row.path).toBe('/api/inventory');
    expect(row.status_code).toBe(201);
    expect(row.user_name).toBeTruthy();
    expect(row.summary).toContain('inventory');
  });

  it('does NOT record GET requests', async () => {
    await ctx.api.get('/api/inventory').set(authHdr());
    await ctx.api.get('/api/inventory/stats').set(authHdr());
    await tick();
    const res = await ctx.api.get('/api/activity?limit=500').set(authHdr());
    expect(res.body.rows.every((r: { method: string }) => r.method !== 'GET')).toBe(true);
  });

  it('records a failed login with the attempted username', async () => {
    await ctx.api.post('/api/auth/login').send({ username: 'nobody-here', password: 'wrong' });
    await tick();
    const res = await ctx.api.get('/api/activity?entity=auth').set(authHdr());
    const bad = res.body.rows.find((r: { user_name: string }) => r.user_name === 'nobody-here');
    expect(bad).toBeTruthy();
    expect(bad.status_code).toBe(401);
    expect(bad.summary).toMatch(/fail/i);
  });

  it('redacts passwords in the stored payload snapshot', async () => {
    const emp = await createEmployee(ctx.api, token, { username: 'audit_pw_user', password: 'sup3rsecret' });
    await tick();
    const res = await ctx.api.get('/api/activity?entity=users&action=create&limit=50').set(authHdr());
    const row = res.body.rows.find((r: { meta: string }) => (r.meta || '').includes('audit_pw_user'));
    expect(row).toBeTruthy();
    const meta = JSON.parse(row.meta);
    expect(meta.body.username).toBe('audit_pw_user');
    expect(meta.body.password).toBe('[redacted]');
    expect(row.meta).not.toContain('sup3rsecret');
    expect(emp.id).toBeTruthy();
  });

  it('is admin-only — a non-admin gets 403', async () => {
    const emp = await createEmployee(ctx.api, token);
    const res = await ctx.api.get('/api/activity').set('Authorization', `Bearer ${emp.token}`);
    expect(res.status).toBe(403);
  });

  it('/options returns filter values', async () => {
    const res = await ctx.api.get('/api/activity/options').set(authHdr());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.entities)).toBe(true);
    expect(res.body.entities).toContain('inventory');
    expect(Array.isArray(res.body.users)).toBe(true);
  });

  it('prunes entries older than a cutoff', async () => {
    await ctx.api.post('/api/inventory').set(authHdr()).send({ name: 'Prune Trigger', quantity: 1 });
    await tick();
    const before = await ctx.api.get('/api/activity?limit=1').set(authHdr());
    expect(before.body.total).toBeGreaterThan(0);

    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const pruned = await ctx.api.delete('/api/activity?before=' + tomorrow).set(authHdr());
    expect(pruned.status).toBe(200);
    expect(pruned.body.deleted).toBeGreaterThan(0);

    await tick();
    const after = await ctx.api.get('/api/activity?limit=1').set(authHdr());
    // only the prune action itself (logged after the delete) remains
    expect(after.body.total).toBeLessThan(before.body.total);
  });

  it('rejects a prune with no cutoff', async () => {
    const res = await ctx.api.delete('/api/activity').set(authHdr());
    expect(res.status).toBe(400);
  });

  it('auto-sweeps audit rows older than the retention window on housekeeping', async () => {
    const { run, queryOne, cleanupSessions, ACTIVITY_LOG_RETENTION_DAYS } = await import('../src/shared/db');
    run(
      `INSERT INTO activity_log (created_at, method, path, entity, action, summary)
       VALUES (datetime('now', '-${ACTIVITY_LOG_RETENTION_DAYS + 5} days'), 'POST', '/api/x', 'x', 'create', 'ancient')`
    );
    run(
      `INSERT INTO activity_log (created_at, method, path, entity, action, summary)
       VALUES (datetime('now', '-2 days'), 'POST', '/api/x', 'x', 'create', 'recent')`
    );
    cleanupSessions();
    expect(queryOne<{ n: number }>("SELECT COUNT(*) n FROM activity_log WHERE summary = 'ancient'")?.n).toBe(0);
    expect(queryOne<{ n: number }>("SELECT COUNT(*) n FROM activity_log WHERE summary = 'recent'")?.n).toBe(1);
  });
});
