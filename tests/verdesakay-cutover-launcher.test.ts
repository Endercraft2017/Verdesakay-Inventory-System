import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, expect } from 'vitest';

const root = path.join(import.meta.dirname, '..');
describe('one-time Railway cutover launcher', () => {
  it('requires stopped writers, previews safely and refuses an existing tenant', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vds-cutover-launcher-'));
    const source = path.join(dir, 'data.db');
    const platform = path.join(dir, 'platform.db');
    const uploads = path.join(dir, 'uploads');
    const tenants = path.join(dir, 'tenants');
    mkdirSync(uploads);
    writeFileSync(path.join(uploads, 'document.txt'), 'existing company document');
    const db = new DatabaseSync(source);
    db.exec("CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT, password_hash TEXT); INSERT INTO users VALUES(1,'existing','original-hash')");
    db.close();
    const before = readFileSync(source);
    const env = { ...process.env, DB_PATH: source, PLATFORM_DB_PATH: platform,
      DATA_DIR: tenants, UPLOAD_DIR: uploads, DEPLOY_MODE: 'cloud', DEFAULT_TENANT_REDIRECT: '',
      PLATFORM_ADMIN_USERNAME: '', PLATFORM_ADMIN_PASSWORD: '' };
    const command = ['--import', 'tsx', 'scripts/start-verdesakay-cutover.ts'];
    try {
      const rejected = spawnSync(process.execPath, command, { cwd: root, env, encoding: 'utf8' });
      expect(rejected.status).toBe(1);
      expect(rejected.stderr).toContain('Stop the existing deployment');
      expect(existsSync(platform)).toBe(false);
      const preview = execFileSync(process.execPath, [...command, '--preview'], { cwd: root, env, encoding: 'utf8' });
      expect(JSON.parse(preview)).toMatchObject({ slug: 'verdesakay', applied: false, users: 1, files: 1 });
      expect(existsSync(path.join(tenants, 'verdesakay.db'))).toBe(false);
      const control = new DatabaseSync(platform);
      control.prepare('INSERT INTO tenants(slug,name) VALUES(?,?)').run('verdesakay', 'Verdesakay');
      control.close();
      const existing = spawnSync(process.execPath, [...command, '--writers-stopped'], { cwd: root, env, encoding: 'utf8' });
      expect(existing.status).toBe(1);
      expect(existing.stderr).toContain('Tenant already exists');
      expect(readFileSync(source).equals(before)).toBe(true);
      expect(readFileSync(path.join(uploads, 'document.txt'), 'utf8')).toBe('existing company document');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
