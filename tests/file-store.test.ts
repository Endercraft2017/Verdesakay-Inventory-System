/** Uploads stored in a bucket (src/shared/file-store.ts): new files are copied up, the disk is a
    cache that's trimmed and refilled on demand, explicit deletions reach the bucket, and a file
    lost from disk any other way is kept — against an in-process fake S3 server. The database
    side (no bytes in the database, moving old copies out) is tests/upload-offload.test.ts. */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';
import { fakeS3, listen } from './fake-s3';

const DAY = 86_400_000;
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a30000000049454e44ae426082', 'hex');

let ctx: TestContext;
let token: string;
let fake: ReturnType<typeof fakeS3>;
let store: typeof import('../src/shared/file-store');
let up: string;
const H = () => ({ Authorization: `Bearer ${token}` });
/** A sweep as if run `ms` from now (past the settle delay, or past the cache age). */
const sweepAt = (ms: number) => store.syncUploads(Date.now() + ms);
const waitFor = async (cond: () => boolean) => {
  for (let i = 0; i < 50 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
  return cond();
};

beforeAll(async () => {
  ctx = await setupApp();
  token = await login(ctx.api);
  fake = fakeS3();
  Object.assign(process.env, {
    FILES_S3_BUCKET: 'bk',
    FILES_S3_ENDPOINT: await listen(fake.server),
    FILES_S3_KEY_ID: 'id',
    FILES_S3_SECRET: 'secret',
    FILES_S3_PATH_STYLE: 'true',
    FILES_KEY: 'a-long-test-files-key-0123456789',
  });
  store = await import('../src/shared/file-store');
  up = process.env.UPLOAD_DIR!;
});
afterAll(() => {
  for (const k of Object.keys(process.env)) if (k.startsWith('FILES_S3_') || k === 'FILES_CACHE_DAYS' || k === 'FILES_KEY') delete process.env[k];
  fake.server.close();
  cleanup(ctx);
});

async function itemWithImage(): Promise<{ id: number; file: string }> {
  const id = (await ctx.api.post('/api/inventory').set(H()).send({ name: `Img ${Math.random()}`, quantity: 1 })).body.id as number;
  const res = await ctx.api.post(`/api/inventory/${id}/image`).set(H()).attach('image', PNG, 'photo.png');
  expect(res.status).toBe(200);
  return { id, file: res.body.image_path as string };
}

describe('file bucket', () => {
  it('keeps identified report evidence in the bucket and restores it only for case participants', async () => {
    const reporter = await createEmployee(ctx.api, token);
    const created = await ctx.api.post('/api/identified-reports').set({ Authorization: `Bearer ${reporter.token}` })
      .field('recipient_id', '1').field('category', 'Safety risk').field('subject', 'Warehouse hazard')
      .field('description', 'Evidence attached').attach('files', PNG, { filename: 'evidence.png', contentType: 'image/png' });
    expect(created.status).toBe(201);
    const { queryOne } = await import('../src/shared/db');
    const name = queryOne<{ stored_name: string }>('SELECT stored_name FROM identified_report_attachments WHERE report_id = ?', created.body.id)!.stored_name;
    expect(queryOne('SELECT 1 FROM durable_uploads WHERE name = ?', name)).toBeUndefined();
    expect(await waitFor(() => fake.objects.has(`files/${name}`))).toBe(true);
    fs.unlinkSync(path.join(up, name));
    const response = await ctx.api.get(`/api/identified-reports/${created.body.id}/attachments/${created.body.attachments[0].id}`).set({ Authorization: `Bearer ${reporter.token}` });
    expect(response.status).toBe(200);
    expect(Buffer.from(response.body).equals(PNG)).toBe(true);
  });
  it('copies an upload to the bucket, drops the unused disk copy, and fetches it back when asked for', async () => {
    const { id, file } = await itemWithImage();
    const r = await sweepAt(60_000);
    expect(r).toMatchObject({ ok: true });
    const stored = fake.objects.get(`files/${file}`)!.body;
    expect(stored.subarray(0, 5).toString()).toBe('VDSF1'); // encrypted before it leaves the server
    expect(stored.includes(PNG.subarray(8, 24))).toBe(false);

    const trimmed = await sweepAt(8 * DAY); // past the default 7-day cache
    expect(trimmed.dropped).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(path.join(up, file))).toBe(false);
    expect(store.bucketOnlyBytes(up)).toBeGreaterThanOrEqual(PNG.length); // still counted for the quota

    const img = await ctx.api.get(`/api/inventory/${id}/image`).set(H());
    expect(img.status).toBe(200);
    expect(Buffer.from(img.body).equals(PNG)).toBe(true);
    expect(fs.existsSync(path.join(up, file))).toBe(true);
    expect((await sweepAt(60_000)).sent).toBe(0); // the fetched copy isn't sent again
  });

  it('deleting an upload deletes the bucket copy, even when only the bucket had it', async () => {
    const { id, file } = await itemWithImage();
    await sweepAt(60_000);
    await sweepAt(8 * DAY);
    expect(fs.existsSync(path.join(up, file))).toBe(false);
    expect(fake.objects.has(`files/${file}`)).toBe(true);

    expect((await ctx.api.delete(`/api/inventory/${id}/image`).set(H())).status).toBe(200);
    expect(await waitFor(() => !fake.objects.has(`files/${file}`))).toBe(true);
    expect((await ctx.api.get(`/api/inventory/${id}/image`).set(H())).status).toBe(404);
  });

  it('keeps punch photos and text files on disk; only an explicit delete removes a bucket copy', async () => {
    const photos = path.join(up, 'acme', 'kiosk-punches');
    fs.mkdirSync(photos, { recursive: true });
    fs.writeFileSync(path.join(photos, 'p1.jpg'), 'face');
    fs.writeFileSync(path.join(up, 'acme', 'doc.txt'), 'doc');
    fs.writeFileSync(path.join(up, 'acme', 'scan.pdf'), 'pdf');
    await sweepAt(60_000);
    expect(fake.objects.has('files/acme/kiosk-punches/p1.jpg')).toBe(true);
    expect(fake.objects.has('files/acme/doc.txt')).toBe(true);

    await sweepAt(8 * DAY);
    expect(fs.existsSync(path.join(photos, 'p1.jpg'))).toBe(true); // retention owns this folder
    expect(fs.existsSync(path.join(up, 'acme', 'doc.txt'))).toBe(true); // the AI index reads text files
    expect(fs.existsSync(path.join(up, 'acme', 'scan.pdf'))).toBe(false);

    // Gone from disk outside the app (a replaced filesystem): kept, and fetched back on demand.
    fs.rmSync(path.join(photos, 'p1.jpg'));
    expect((await sweepAt(60_000)).lost).toBe(1);
    expect(fake.objects.has('files/acme/kiosk-punches/p1.jpg')).toBe(true);
    expect(await store.localCopy(path.join(photos, 'p1.jpg'))).toBe(true);

    // Retention deletes through forgetDurableUpload → forgetUpload: the bucket copy goes.
    fs.rmSync(path.join(photos, 'p1.jpg'));
    await store.forgetUpload(path.join(photos, 'p1.jpg'));
    expect(fake.objects.has('files/acme/kiosk-punches/p1.jpg')).toBe(false);
    expect((await sweepAt(60_000)).lost).toBe(0);
    expect(fake.objects.has('files/acme/scan.pdf')).toBe(true); // only in the bucket, not deleted
  });

  it('never sends dot-folders (sync blobs, its own manifest) or a file still being written', async () => {
    fs.mkdirSync(path.join(up, '.sync-blobs'), { recursive: true });
    fs.writeFileSync(path.join(up, '.sync-blobs', 'abc'), 'blob');
    fs.writeFileSync(path.join(up, 'fresh.txt'), 'x');
    await store.syncUploads(Date.now());
    expect([...fake.objects.keys()].some((k) => k.includes('.sync-blobs') || k.includes('.file-store'))).toBe(false);
    expect(fake.objects.has('files/fresh.txt')).toBe(false);
    await sweepAt(60_000);
    expect(fake.objects.has('files/fresh.txt')).toBe(true);
  });

  it('a lost manifest re-learns bucket-only files from a listing', async () => {
    fake.objects.set('files/acme/old.pdf', { body: store.seal(store.fileStore()!, Buffer.from('old-pdf')), at: new Date().toISOString() });
    fs.rmSync(path.join(up, '.file-store.json'));
    store._resetFileStore();
    await sweepAt(60_000);
    expect(store.bucketOnly(path.join(up, 'acme')).map((f) => f.name)).toContain('old.pdf');
    expect(await store.localCopy(path.join(up, 'acme', 'old.pdf'))).toBe(true);
    expect(fs.readFileSync(path.join(up, 'acme', 'old.pdf'), 'utf8')).toBe('old-pdf');
    expect(await store.localCopy(path.join(up, 'acme', 'never-existed.pdf'))).toBe(false);
  });

  it('purging a tenant deletes its files from the bucket, cached or not', async () => {
    fs.mkdirSync(path.join(up, 'gone'), { recursive: true });
    fs.writeFileSync(path.join(up, 'gone', 'a.txt'), 'a');
    fs.writeFileSync(path.join(up, 'gone', 'b.txt'), 'b');
    await sweepAt(60_000);
    await sweepAt(8 * DAY); // both only in the bucket now
    fs.mkdirSync(path.join(up, 'gone'), { recursive: true });
    fs.writeFileSync(path.join(up, 'gone', 'c.txt'), 'c'); // and one on disk only
    await store.removeUploadFolder(path.join(up, 'gone'));
    expect([...fake.objects.keys()].some((k) => k.startsWith('files/gone/'))).toBe(false);
    expect(fs.existsSync(path.join(up, 'gone'))).toBe(false);
    expect(store.bucketOnly(path.join(up, 'gone'))).toEqual([]);
  });

  it('a missing uploads folder (an unmounted volume) does not wipe the bucket', async () => {
    fs.writeFileSync(path.join(up, 'keep.txt'), 'k');
    await sweepAt(60_000);
    fs.renameSync(up, `${up}-away`);
    try {
      const r = await sweepAt(60_000);
      expect(r).toMatchObject({ ok: false, lost: 0 });
      expect(fake.objects.has('files/keep.txt')).toBe(true);
    } finally { fs.renameSync(`${up}-away`, up); }
  });

  it('reads its bucket from FILES_S3_* or reuses an off-site backup target', () => {
    expect(store.fileStore({})).toBeNull();
    expect(() => store.fileStore({ FILES_S3_BUCKET: 'b' })).toThrow(/incomplete/);
    const full = { FILES_S3_BUCKET: 'b', FILES_S3_ENDPOINT: 'https://x.example', FILES_S3_KEY_ID: 'k', FILES_S3_SECRET: 's' };
    expect(() => store.fileStore(full)).toThrow(/FILES_KEY/); // never unencrypted
    expect(() => store.fileStore({ FILES_S3_FROM: 'railway' })).toThrow(/BACKUP_S3_RAILWAY_BUCKET/);
    const s = store.fileStore({
      FILES_S3_FROM: 'railway', BACKUP_S3_RAILWAY_BUCKET: 'b', BACKUP_S3_RAILWAY_ENDPOINT: 'https://x.example',
      BACKUP_S3_RAILWAY_KEY_ID: 'k', BACKUP_S3_RAILWAY_SECRET: 's', FILES_CACHE_DAYS: '0',
      BACKUP_KEY: 'the-existing-backup-key-0123',
    });
    expect(s).toMatchObject({ prefix: 'files', cacheDays: 0 });
  });
});
