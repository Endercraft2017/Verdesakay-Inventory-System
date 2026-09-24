/** Off-site backups: the SigV4 signer (AWS's published examples), encryption, and the push
    job end-to-end against an in-process fake S3 server (src/shared/s3.ts, src/platform/offsite.ts). */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupApp, cleanup, login, type TestContext } from './helpers';
import { signV4 } from '../src/shared/s3';
import { isRetentionManagedUpload } from '../src/shared/backup';

const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const AWS = { region: 'us-east-1', accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', payloadHash: EMPTY };

describe('SigV4 signer (AWS S3 documentation examples)', () => {
  it('GET object with a Range header', () => {
    const auth = signV4({ ...AWS, method: 'GET', path: '/test.txt', query: {}, headers: {
      host: 'examplebucket.s3.amazonaws.com', range: 'bytes=0-9', 'x-amz-content-sha256': EMPTY, 'x-amz-date': '20130524T000000Z',
    } });
    expect(auth).toContain('Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  });
  it('GET bucket list with query parameters', () => {
    const auth = signV4({ ...AWS, method: 'GET', path: '/', query: { 'max-keys': '2', prefix: 'J' }, headers: {
      host: 'examplebucket.s3.amazonaws.com', 'x-amz-content-sha256': EMPTY, 'x-amz-date': '20130524T000000Z',
    } });
    expect(auth).toContain('Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
  });
});

/** A tiny path-style S3 fake: one bucket, objects in a Map. `deny` makes every call 403. */
function fakeS3() {
  const objects = new Map<string, { body: Buffer; at: string }>();
  const state = { deny: false };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    const [, bucket, ...rest] = url.pathname.split('/');
    const key = rest.map(decodeURIComponent).join('/');
    if (state.deny || bucket !== 'bk' || !String(req.headers.authorization || '').startsWith('AWS4-HMAC-SHA256')) {
      res.writeHead(403); res.end('<Error><Code>AccessDenied</Code><Message>nope</Message></Error>'); return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.method === 'PUT') { objects.set(key, { body: Buffer.concat(chunks), at: new Date().toISOString() }); res.end(); return; }
      if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204); res.end(); return; }
      if (req.method === 'GET' && !key) {
        const prefix = url.searchParams.get('prefix') || '';
        const items = [...objects].filter(([k]) => k.startsWith(prefix))
          .map(([k, o]) => `<Contents><Key>${k}</Key><Size>${o.body.length}</Size><LastModified>${o.at}</LastModified></Contents>`).join('');
        res.end(`<ListBucketResult><IsTruncated>false</IsTruncated>${items}</ListBucketResult>`); return;
      }
      const o = objects.get(key);
      if (!o) { res.writeHead(404); res.end('<Error><Code>NoSuchKey</Code></Error>'); return; }
      res.end(o.body);
    });
  });
  return { server, objects, state };
}

let ctx: TestContext;
let fake: ReturnType<typeof fakeS3>;
let offsite: typeof import('../src/platform/offsite');
let backups: typeof import('../src/platform/backups');

beforeAll(async () => {
  ctx = await setupApp();
  await login(ctx.api);
  fake = fakeS3();
  await new Promise<void>((r) => fake.server.listen(0, '127.0.0.1', r));
  const port = (fake.server.address() as AddressInfo).port;
  Object.assign(process.env, {
    BACKUP_S3_T1_BUCKET: 'bk',
    BACKUP_S3_T1_ENDPOINT: `http://127.0.0.1:${port}`,
    BACKUP_S3_T1_KEY_ID: 'id',
    BACKUP_S3_T1_SECRET: 'secret',
    BACKUP_S3_T1_REGION: 'us-east-005',
    BACKUP_S3_T1_PATH_STYLE: 'true',
    BACKUP_KEY: 'a-long-test-backup-key-0123456789',
  });
  offsite = await import('../src/platform/offsite');
  backups = await import('../src/platform/backups');
});
afterAll(() => {
  for (const k of Object.keys(process.env)) if (k.startsWith('BACKUP_S3_') || k === 'BACKUP_KEY') delete process.env[k];
  fake.server.close();
  cleanup(ctx);
});
beforeEach(() => { fake.state.deny = false; delete process.env.BACKUP_S3_T1_KEEP_DAYS; });

describe('encryption', () => {
  it('round-trips, and a different BACKUP_KEY cannot read it', () => {
    const blob = offsite.pack(Buffer.from('payroll secrets'));
    expect(blob.includes(Buffer.from('payroll'))).toBe(false);
    expect(offsite.unpack(blob).toString()).toBe('payroll secrets');
    const saved = process.env.BACKUP_KEY;
    process.env.BACKUP_KEY = 'some-other-key-entirely-123456';
    try { expect(() => offsite.unpack(blob)).toThrow(/wrong BACKUP_KEY/); }
    finally { process.env.BACKUP_KEY = saved; }
  });
});

describe('pushOffsite', () => {
  it('sends each daily snapshot + uploads once, encrypted, and they restore to a valid DB', async () => {
    backups.runDailyBackups();
    const up = process.env.UPLOAD_DIR!;
    fs.mkdirSync(path.join(up, 'acme'), { recursive: true });
    fs.writeFileSync(path.join(up, 'acme', 'photo.txt'), 'hello');

    const [r] = await offsite.pushOffsite();
    expect(r).toMatchObject({ target: 't1', ok: true });
    expect(r!.dbSent).toBeGreaterThanOrEqual(2); // default + _platform
    const keys = [...fake.objects.keys()];
    const dbKey = keys.find((k) => /^db\/default\/default-\d{4}-\d{2}-\d{2}\.db\.gz\.enc$/.test(k))!;
    expect(dbKey).toBeTruthy();
    expect(keys.some((k) => k.startsWith('db/_platform/'))).toBe(true);
    expect(keys).toContain('uploads/acme/photo.txt.gz.enc');

    const restored = path.join(ctx.tmpDir, 'restored.db');
    fs.writeFileSync(restored, offsite.unpack(fake.objects.get(dbKey)!.body));
    const conn = new DatabaseSync(restored, { readOnly: true });
    expect((conn.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c).toBeGreaterThan(0);
    conn.close();

    const again = await offsite.pushOffsite();
    expect(again[0]).toMatchObject({ ok: true, dbSent: 0, uploadsSent: 0 });

    fs.writeFileSync(path.join(up, 'acme', 'photo.txt'), 'hello, changed');
    const changed = await offsite.pushOffsite();
    expect(changed[0]!.uploadsSent).toBe(1);
  });

  it('a failing target is reported, not thrown, and retried on the next run', async () => {
    fs.writeFileSync(path.join(process.env.UPLOAD_DIR!, 'late.txt'), 'x');
    fake.state.deny = true;
    const [bad] = await offsite.pushOffsite();
    expect(bad).toMatchObject({ ok: false });
    expect(bad!.error).toMatch(/403 AccessDenied/);
    fake.state.deny = false;
    const [good] = await offsite.pushOffsite();
    expect(good).toMatchObject({ ok: true, uploadsSent: 1 });
    expect(fake.objects.has('uploads/late.txt.gz.enc')).toBe(true);
  });

  it('KEEP_DAYS prunes old DB snapshots but never uploads', async () => {
    fake.objects.set('db/default/default-2020-01-01.db.gz.enc', { body: Buffer.from('old'), at: '2020-01-01T00:00:00Z' });
    fake.objects.set('uploads/2020-01-01.db-looking-name.gz.enc', { body: Buffer.from('keep'), at: '2020-01-01T00:00:00Z' });
    process.env.BACKUP_S3_T1_KEEP_DAYS = '30';
    const [r] = await offsite.pushOffsite();
    expect(r).toMatchObject({ ok: true, pruned: 1 });
    expect(fake.objects.has('db/default/default-2020-01-01.db.gz.enc')).toBe(false);
    expect(fake.objects.has('uploads/2020-01-01.db-looking-name.gz.enc')).toBe(true);
  });

  it('refuses to send anything without BACKUP_KEY', async () => {
    const saved = process.env.BACKUP_KEY;
    delete process.env.BACKUP_KEY;
    fs.writeFileSync(path.join(process.env.UPLOAD_DIR!, 'unsent.txt'), 'x');
    try {
      const [r] = await offsite.pushOffsite();
      expect(r).toMatchObject({ ok: false });
      expect(fake.objects.has('uploads/unsent.txt.gz.enc')).toBe(false);
    } finally { process.env.BACKUP_KEY = saved; }
  });

  it('testTarget round-trips and cleans up after itself', async () => {
    await offsite.testTarget(offsite.findTarget('t1'));
    expect([...fake.objects.keys()].some((k) => k.startsWith('_selftest/'))).toBe(false);
  });

  it('an incomplete target config is an error, not a silent skip', () => {
    expect(() => offsite.offsiteTargets({ BACKUP_S3_X_BUCKET: 'b' })).toThrow(/incomplete/);
    const [t] = offsite.offsiteTargets({
      BACKUP_S3_B2_BUCKET: 'b', BACKUP_S3_B2_ENDPOINT: 'https://s3.us-east-005.backblazeb2.com', BACKUP_S3_B2_KEY_ID: 'k', BACKUP_S3_B2_SECRET: 's',
    });
    expect(t!.name).toBe('b2');
  });
});

describe("punch photos follow the app's retention into the backups", () => {
  it('recognises punch photos for the default tenant and for tenants, either slash style', () => {
    expect(isRetentionManagedUpload('kiosk-punches/a.jpg')).toBe(true);
    expect(isRetentionManagedUpload('acme/kiosk-punches/a.jpg')).toBe(true);
    expect(isRetentionManagedUpload('acme\\kiosk-punches\\a.jpg')).toBe(true);
    expect(isRetentionManagedUpload('acme/photo.jpg')).toBe(false);
    expect(isRetentionManagedUpload('kiosk-punches')).toBe(false);
    expect(isRetentionManagedUpload('acme/docs/kiosk-punches/a.jpg')).toBe(false); // only the real folder
  });

  it('a deleted punch photo is removed from the local backup mirror and off-site; other uploads are kept', async () => {
    const up = process.env.UPLOAD_DIR!;
    const photos = path.join(up, 'acme', 'kiosk-punches');
    fs.mkdirSync(photos, { recursive: true });
    fs.writeFileSync(path.join(photos, 'p1.jpg'), 'face-1');
    fs.writeFileSync(path.join(photos, 'p2.jpg'), 'face-2');
    fs.writeFileSync(path.join(up, 'acme', 'item.png'), 'item');
    backups.runManualBackup();
    await offsite.pushOffsite();
    const shared = await import('../src/shared/backup');
    const localMirror = path.join(shared.backupDir(), 'uploads', 'acme');
    expect(fs.existsSync(path.join(localMirror, 'kiosk-punches', 'p1.jpg'))).toBe(true);
    expect(fake.objects.has('uploads/acme/kiosk-punches/p1.jpg.gz.enc')).toBe(true);

    // The app's retention deletes p1; someone deletes the item image by mistake.
    fs.rmSync(path.join(photos, 'p1.jpg'));
    fs.rmSync(path.join(up, 'acme', 'item.png'));
    backups.runManualBackup();
    const [r] = await offsite.pushOffsite();

    expect(fs.existsSync(path.join(localMirror, 'kiosk-punches', 'p1.jpg'))).toBe(false);
    expect(fs.existsSync(path.join(localMirror, 'kiosk-punches', 'p2.jpg'))).toBe(true);
    expect(fs.existsSync(path.join(localMirror, 'item.png'))).toBe(true); // still recoverable
    expect(r).toMatchObject({ ok: true, photosRemoved: 1 });
    expect(fake.objects.has('uploads/acme/kiosk-punches/p1.jpg.gz.enc')).toBe(false);
    expect(fake.objects.has('uploads/acme/kiosk-punches/p2.jpg.gz.enc')).toBe(true);
    expect(fake.objects.has('uploads/acme/item.png.gz.enc')).toBe(true);
  });

  it('the daily sweep removes stray punch photos the manifest never knew about', async () => {
    fake.objects.set('uploads/kiosk-punches/orphan.jpg.gz.enc', { body: Buffer.from('x'), at: new Date().toISOString() });
    fake.objects.set('uploads/orphan-doc.pdf.gz.enc', { body: Buffer.from('x'), at: new Date().toISOString() });
    const tomorrow = new Date(Date.now() + 86_400_000); // a new day ⇒ the listing sweep runs
    const [r] = await offsite.pushOffsite(tomorrow);
    expect(r).toMatchObject({ ok: true });
    expect(fake.objects.has('uploads/kiosk-punches/orphan.jpg.gz.enc')).toBe(false);
    expect(fake.objects.has('uploads/orphan-doc.pdf.gz.enc')).toBe(true);
  });

  it("a purged tenant's whole photo folder disappears from the local mirror too", () => {
    const up = process.env.UPLOAD_DIR!;
    fs.mkdirSync(path.join(up, 'gone', 'kiosk-punches'), { recursive: true });
    fs.writeFileSync(path.join(up, 'gone', 'kiosk-punches', 'x.jpg'), 'face');
    backups.runManualBackup();
    fs.rmSync(path.join(up, 'gone'), { recursive: true });
    backups.runManualBackup();
    const root = path.join(process.env.DB_PATH!, '..', 'backups', 'uploads', 'gone', 'kiosk-punches', 'x.jpg');
    expect(fs.existsSync(root)).toBe(false);
  });
});
