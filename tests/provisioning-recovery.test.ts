import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { setupApp, cleanup, login, type TestContext } from './helpers';
let ctx: TestContext, snapshot: string;
let provision: typeof import('../src/platform/provisioning'), platform: typeof import('../src/platform/platform'), db: typeof import('../src/shared/db');
const input = (slug: string) => ({ slug, name: 'Recovery fixture', admin_username: 'chosen-owner', admin_password: 'Synthetic recovery fixture password', plan: 'complete' });
beforeAll(async () => {
  ctx = await setupApp(); await login(ctx.api);
  provision = await import('../src/platform/provisioning'); platform = await import('../src/platform/platform'); db = await import('../src/shared/db');
  snapshot = path.join(ctx.tmpDir, 'source.db');
  db.getDb().exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
});
afterAll(() => cleanup(ctx));
const exists = (slug: string) => fs.existsSync(path.join(db.DATA_DIR, slug + '.db'));
describe('prepare database before catalog publication', () => {
  it.each(['create', 'import'])('keeps unregistered existing databases untouched during %s', kind => {
    const slug = 'existing-' + kind, target = path.join(db.DATA_DIR, slug + '.db');
    fs.mkdirSync(db.DATA_DIR, { recursive: true }); fs.copyFileSync(snapshot, target);
    const before = fs.readFileSync(target);
    expect(() => kind === 'create' ? provision.createTenant(input(slug)) : provision.importTenant({ slug, name: 'Existing', sourceFile: snapshot })).toThrow(/already exists/);
    expect(fs.readFileSync(target)).toEqual(before); expect(platform.getTenant(slug)).toBeNull();
  });
  it.each(['create', 'import'])('rolls back catalog and removes owned database on %s audit failure, then permits retry', kind => {
    const slug = 'audit-' + kind;
    platform.platformDb().exec(`CREATE TRIGGER recovery_audit_failure BEFORE INSERT ON provisioning_log WHEN NEW.slug='${slug}' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END`);
    const execute = () => kind === 'create' ? provision.createTenant(input(slug)) : provision.importTenant({ slug, name: 'Import', sourceFile: snapshot });
    try { expect(execute).toThrow('synthetic audit failure'); } finally { platform.platformDb().exec('DROP TRIGGER recovery_audit_failure'); }
    expect(platform.getTenant(slug)).toBeNull(); expect(exists(slug)).toBe(false);
    expect(platform.listProvisioningLog(slug)).toEqual([]);
    expect(execute().slug).toBe(slug); expect(platform.getTenant(slug)?.status).toBe('active');
  });
  it('prepares the chosen owner before catalog publication and cleans up a failed publication', () => {
    const slug = 'failed-owner';
    // Reject the catalog only after the chosen owner must already be installed.
    let seen = '';
    platform.platformDb().function('inspect_owner', () => {
      seen = db.withTenant(slug, () => db.queryOne<{username:string}>('SELECT username FROM users ORDER BY id LIMIT 1')!.username);
      expect(platform.getTenant(slug)).toBeNull();
      throw new Error('Publication blocked after owner preparation');
    });
    platform.platformDb().exec(`CREATE TRIGGER owner_publication_probe BEFORE INSERT ON tenants WHEN NEW.slug='${slug}' BEGIN SELECT inspect_owner(); END`);
    try { expect(() => provision.createTenant(input(slug))).toThrow(); } finally { platform.platformDb().exec('DROP TRIGGER owner_publication_probe'); }
    expect(seen).toBe('chosen-owner'); expect(platform.getTenant(slug)).toBeNull(); expect(exists(slug)).toBe(false);
  });
  it('clears failed initialization from the connection registry before a later retry', () => {
    const slug = 'failed-schema';
    const file = path.join(db.DATA_DIR, slug + '.db');
    const broken = new DatabaseSync(file); broken.exec('CREATE VIEW users AS SELECT 1 AS id'); broken.close();
    expect(() => db.getDb(slug)).toThrow();
    fs.rmSync(file, { force: true });
    // A stale cached connection would return without initializing the new database.
    expect(db.withTenant(slug, () => db.queryOne<{n:number}>('SELECT COUNT(*) n FROM users')!.n)).toBeGreaterThan(0);
    db.closeTenantConnection(slug);
  });
  it('rejects an import migration failure without publishing or changing the source', () => {
    const slug = 'bad-migration', corrupt = path.join(ctx.tmpDir, 'incompatible.db');
    const conn = new DatabaseSync(corrupt);
    conn.exec('CREATE TABLE users(id INTEGER PRIMARY KEY); INSERT INTO users DEFAULT VALUES'); conn.close();
    const before = fs.readFileSync(corrupt);
    expect(() => provision.importTenant({ slug, name: 'Broken', sourceFile: corrupt })).toThrow();
    expect(platform.getTenant(slug)).toBeNull(); expect(exists(slug)).toBe(false);
    expect(fs.readFileSync(corrupt)).toEqual(before);
    expect(fs.readdirSync(db.DATA_DIR).filter(name => name.startsWith('.import-'))).toEqual([]);
  });
});


it.each(['create', 'import'])('fails closed after a real process exit during %s publication and refuses automatic reuse', kind => {
  const root = path.join(ctx.tmpDir, 'crash-' + kind); fs.mkdirSync(root);
  const slug = 'crash-' + kind, directory = path.join(root, 'tenants');
  const env = { PATH: process.env.PATH, NODE_ENV: 'test', DEPLOY_MODE: 'cloud', ADMIN_PASSWORD: 'Synthetic crash bootstrap password',
    DB_PATH: path.join(root, 'default.db'), DATA_DIR: directory, PLATFORM_DB_PATH: path.join(root, 'platform.db'),
    UPLOAD_DIR: path.join(root, 'uploads'), BACKUP_DIR: path.join(root, 'backups') };
  const imports = `import { platformDb } from './src/platform/platform.ts'; import { createTenant, importTenant } from './src/platform/provisioning.ts';`;
  const execute = kind === 'create' ? `createTenant(${JSON.stringify(input(slug))});` : `importTenant(${JSON.stringify({slug,name:'Crash import',sourceFile:snapshot})});`;
  const crashed = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', imports + `const d=platformDb(); d.function('crash_probe',()=>process.exit(73)); d.exec('CREATE TRIGGER crash_probe BEFORE INSERT ON tenants BEGIN SELECT crash_probe(); END');` + execute], { cwd: process.cwd(), env, encoding: 'utf8', timeout: 15000 });
  expect(crashed.status, crashed.stderr).toBe(73);
  const target = path.join(directory, slug + '.db'), before = fs.readFileSync(target);
  const catalog = new DatabaseSync(env.PLATFORM_DB_PATH);
  expect(catalog.prepare('SELECT COUNT(*) n FROM tenants').get()).toMatchObject({ n: 0 }); catalog.close();
  const retry = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', imports + `platformDb().exec('DROP TRIGGER crash_probe'); try { createTenant(${JSON.stringify(input(slug))}); process.exit(1); } catch(error) { if(error.status!==409) throw error; }`], { cwd: process.cwd(), env, encoding: 'utf8', timeout: 15000 });
  expect(retry.status, retry.stderr).toBe(0);
  expect(fs.readFileSync(target)).toEqual(before);
});


it('preserves a replacement database if file ownership changes before cleanup', () => {
  const slug = 'changed-ownership', target = path.join(db.DATA_DIR, slug + '.db');
  const preserved = path.join(ctx.tmpDir, 'preserved-owned.db');
  platform.platformDb().function('replace_owned_file', () => {
    db.closeTenantConnection(slug); fs.renameSync(target, preserved); fs.writeFileSync(target, 'Replacement must survive');
    throw new Error('Synthetic replacement before failed publication');
  });
  platform.platformDb().exec(`CREATE TRIGGER replace_owned_probe BEFORE INSERT ON tenants WHEN NEW.slug='${slug}' BEGIN SELECT replace_owned_file(); END`);
  try { expect(() => provision.createTenant(input(slug))).toThrow(); }
  finally { platform.platformDb().exec('DROP TRIGGER replace_owned_probe'); }
  expect(fs.readFileSync(target, 'utf8')).toBe('Replacement must survive');
  expect(fs.existsSync(preserved)).toBe(true); expect(platform.getTenant(slug)).toBeNull();
});

it('does not turn a successful import into failure when private staging cleanup fails', () => {
  const original = fs.rmSync, slug = 'staging-cleanup';
  const remove = vi.spyOn(fs, 'rmSync').mockImplementation((file, options) => {
    if (path.basename(String(file)).startsWith('.import-')) throw new Error('Synthetic staging cleanup failure');
    return original(file, options);
  });
  try {
    expect(provision.importTenant({ slug, name: 'Cleanup fixture', sourceFile: snapshot }).slug).toBe(slug);
    expect(platform.getTenant(slug)?.status).toBe('active');
  } finally { remove.mockRestore(); }
});


it('refuses dangling recovery-file symlinks without creating or following them', () => {
  const slug = 'dangling-recovery', target = path.join(db.DATA_DIR, slug + '.db-wal');
  const outside = path.join(ctx.tmpDir, 'must-not-be-created'); fs.symlinkSync(outside, target);
  expect(() => provision.createTenant(input(slug))).toThrow(/already exists/);
  expect(fs.lstatSync(target).isSymbolicLink()).toBe(true); expect(fs.existsSync(outside)).toBe(false);
  expect(platform.getTenant(slug)).toBeNull(); expect(exists(slug)).toBe(false);
});
