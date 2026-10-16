/** Full cold-start restore into new directories; synthetic records and no live integrations. */
import { it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import supertest from 'supertest';
import { setupApp, cleanup, login, createEmployee } from './helpers';
it('restores databases and attachments into a clean app with business data and permissions intact', async () => {
  const source = await setupApp();
  let closeRestored: (() => void) | undefined;
  try {
    const token = await login(source.api);
    const header = { Authorization: `Bearer ${token}` };
    const staff = await createEmployee(source.api, token, { username: 'restore-staff', role: 'warehouse' });
    const item = await source.api.post('/api/inventory').set(header).send({ name: 'Restore drill item', quantity: 23 });
    const form = await source.api.post('/api/forms').set(header).field('title', 'Restored attachment').attach('file', Buffer.from('restore-integrity-probe'), 'restore.txt');
    expect(item.status).toBe(201); expect(form.status).toBe(201);
    const { runManualBackup } = await import('../src/platform/backups');
    const backup = runManualBackup(); expect(backup.every(b => b.ok)).toBe(true);
    const uploadSnapshot = path.join(process.env.BACKUP_DIR!, 'uploads');
    source.closeDb?.();
    const recovery = path.join(source.tmpDir, 'recovery');
    fs.mkdirSync(recovery);
    Object.assign(process.env, { DB_PATH: path.join(recovery, 'app.db'), PLATFORM_DB_PATH: path.join(recovery, 'platform.db'), DATA_DIR: path.join(recovery, 'data'), UPLOAD_DIR: path.join(recovery, 'uploads'), BACKUP_DIR: path.join(recovery, 'backups') });
    vi.resetModules();
    const started = performance.now();
    const { restoreBackup } = await import('../src/platform/backups');
    for (const result of backup.filter(b => b.file)) restoreBackup(result.name, result.file!);
    fs.cpSync(uploadSnapshot, process.env.UPLOAD_DIR!, { recursive: true });
    const db = await import('../src/shared/db'); db.init();
    const platform = await import('../src/platform/platform');
    closeRestored = () => { db.closeAllConnections(); platform._resetPlatformDb(); };
    expect(Object.values(db.queryOne<Record<string, unknown>>('PRAGMA integrity_check')!)).toEqual(['ok']);
    const { createApp } = await import('../src/app');
    const recovered = supertest(createApp());
    const newToken = await login(recovered);
    const fresh = { Authorization: `Bearer ${newToken}` };
    expect((await recovered.get(`/api/inventory/${item.body.id}`).set(fresh)).body.quantity).toBe(23);
    const download = await recovered.get(`/api/forms/${form.body.id}/download`).set(fresh);
    expect(download.status).toBe(200); expect(download.text).toBe('restore-integrity-probe');
    const staffToken = await login(recovered, staff.username, staff.password);
    expect((await recovered.post('/api/users').set('Authorization', `Bearer ${staffToken}`).send({})).status).toBe(403);
    expect((await recovered.get('/api/auth/me').set(fresh)).body.user.role).toBe('admin');
    console.log(JSON.stringify({ drill: 'isolated synthetic cold restore', elapsed_ms: Math.round(performance.now() - started), verified: ['database integrity', 'inventory balance', 'attachment bytes', 'sign-in', 'least-privilege'] }));
  } finally { closeRestored?.(); cleanup(source); }
});
