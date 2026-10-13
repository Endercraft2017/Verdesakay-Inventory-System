/** With a file bucket (src/shared/file-store.ts) the bucket replaces the database copies of
    uploads (src/shared/durable-uploads.ts): new uploads never put their bytes in the database,
    and src/platform/upload-offload.ts moves the bytes a database already held into the bucket —
    without replicating that cleanup to installed PCs — then compacts the database. The default
    tenant plays a sync cloud here, so the replication check is real. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';
import { fakeS3, listen } from './fake-s3';

let ctx: TestContext;
let token: string;
let alice: { id: number; token: string };
let fake: ReturnType<typeof fakeS3>;
let up: string;
let db: typeof import('../src/shared/db');
let store: typeof import('../src/shared/file-store');
let offload: typeof import('../src/platform/upload-offload');
let authority: typeof import('../src/sync/authority');
const H = (t = token) => ({ Authorization: `Bearer ${t}` });
const conn = () => db.getDb('default');
const waitFor = async (cond: () => boolean) => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
  return cond();
};
async function download(url: string, t = token): Promise<{ status: number; body: Buffer }> {
  const res = await ctx.api.get(url).set(H(t)).buffer(true)
    .parse((r, done) => { const parts: Buffer[] = []; r.on('data', (c: Buffer) => parts.push(c)); r.on('end', () => done(null, Buffer.concat(parts))); });
  return { status: res.status, body: res.body as Buffer };
}

beforeAll(async () => {
  ctx = await setupApp();
  token = await login(ctx.api);
  alice = await createEmployee(ctx.api, token, { username: 'offload_alice' });
  fake = fakeS3();
  Object.assign(process.env, {
    FILES_S3_BUCKET: 'bk',
    FILES_S3_ENDPOINT: await listen(fake.server),
    FILES_S3_KEY_ID: 'id',
    FILES_S3_SECRET: 'secret',
    FILES_S3_PATH_STYLE: 'true',
    FILES_KEY: 'a-long-test-files-key-0123456789',
  });
  db = await import('../src/shared/db');
  store = await import('../src/shared/file-store');
  offload = await import('../src/platform/upload-offload');
  authority = await import('../src/sync/authority');
  const sync = await import('../src/sync');
  sync.enableSync(conn(), { role: 'cloud', nodeNo: 0 });
  up = process.env.UPLOAD_DIR!;
});
afterAll(() => {
  for (const k of Object.keys(process.env)) if (k.startsWith('FILES_S3_') || k === 'FILES_KEY') delete process.env[k];
  fake.server.close();
  cleanup(ctx);
});

describe('uploads with a file bucket', () => {
  it('sends a new upload to the bucket straight away and keeps no bytes in the database', async () => {
    const id = (await ctx.api.post('/api/inventory').set(H()).send({ name: 'Bucket item', quantity: 1 })).body.id as number;
    const res = await ctx.api.post(`/api/inventory/${id}/image`).set(H()).attach('image', Buffer.from('item-photo'), 'p.png');
    expect(res.status).toBe(200);
    const file = res.body.image_path as string;
    expect(await waitFor(() => fake.objects.has(`files/${file}`))).toBe(true); // no sweep needed
    expect(conn().prepare('SELECT COUNT(*) AS c FROM durable_uploads WHERE name = ?').get(file)).toEqual({ c: 0 });

    const send = await ctx.api.post('/api/messages').set(H())
      .field('recipient_id', String(alice.id))
      .attach('files', Buffer.from('chat-photo'), 'chat.jpg');
    expect(send.status).toBe(201);
    const att = conn().prepare('SELECT id, stored_name, data FROM message_attachments WHERE message_id = ?').get(send.body.id) as
      { id: number; stored_name: string; data: Uint8Array | null };
    expect(att.data).toBeNull();
    expect(await waitFor(() => fake.objects.has(`files/${att.stored_name}`))).toBe(true);

    // Lost from disk outside the app: still served, from the bucket.
    fs.unlinkSync(path.join(up, att.stored_name));
    expect((await store.syncUploads(Date.now() + 60_000)).lost).toBeGreaterThanOrEqual(1);
    const dl = await download(`/api/messages/${send.body.id}/attachments/${att.id}`, alice.token);
    expect(dl.status).toBe(200);
    expect(dl.body.toString()).toBe('chat-photo');

    // Unsending deletes the bucket copy too.
    expect((await ctx.api.delete(`/api/messages/${send.body.id}`).set(H())).status).toBe(200);
    expect(await waitFor(() => !fake.objects.has(`files/${att.stored_name}`))).toBe(true);
  });

  it('moves bytes the database already held into the bucket, without replicating that, then compacts', async () => {
    const c = conn();
    // What a database looks like after the pre-bucket schema-66 copy: a big file only in
    // durable_uploads, a chat photo kept with its row, and a sync blob (which stays).
    const big = crypto.randomBytes(9 * 1024 * 1024);
    const blobName = '.sync-blobs/' + 'a'.repeat(64);
    c.prepare('INSERT INTO durable_uploads (name, data, size_bytes) VALUES (?, ?, ?)').run('legacy-scan.pdf', big, big.length);
    c.prepare('INSERT INTO durable_uploads (name, data, size_bytes) VALUES (?, ?, ?)').run(blobName, Buffer.from('blob'), 4);
    const send = await ctx.api.post('/api/messages').set(H())
      .field('recipient_id', String(alice.id))
      .attach('files', Buffer.from('old-chat-photo'), 'old.jpg');
    const att = c.prepare('SELECT id, stored_name FROM message_attachments WHERE message_id = ?').get(send.body.id) as { id: number; stored_name: string };
    // Make it predate the bucket: bytes only with the row, nothing on disk or in the bucket.
    await waitFor(() => fake.objects.has(`files/${att.stored_name}`));
    await store.forgetUpload(path.join(up, att.stored_name));
    c.prepare('UPDATE message_attachments SET data = ? WHERE id = ?').run(Buffer.from('old-chat-photo'), att.id);
    fs.unlinkSync(path.join(up, att.stored_name));

    authority.flushEffects(c, null); // start from a clean recorder
    const effectsBefore = (c.prepare('SELECT COUNT(*) AS n FROM sync_effects').get() as { n: number }).n;

    const r = await offload.offloadDatabaseCopies('default');
    expect(r).toMatchObject({ moved: 2, remaining: 0, vacuumed: true });
    expect(c.prepare('SELECT name FROM durable_uploads').all()).toEqual([{ name: blobName }]);
    expect(c.prepare('SELECT data FROM message_attachments WHERE id = ?').get(att.id)).toEqual({ data: null });
    expect((c.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count).toBe(0);
    // The cleanup isn't an effect PCs would replay: they keep their own copies.
    authority.flushEffects(c, null);
    expect((c.prepare('SELECT COUNT(*) AS n FROM sync_effects').get() as { n: number }).n).toBe(effectsBefore);

    // Both are now served from the bucket, byte for byte.
    expect(await store.localCopy(path.join(up, 'legacy-scan.pdf'))).toBe(true);
    expect(fs.readFileSync(path.join(up, 'legacy-scan.pdf')).equals(big)).toBe(true);
    const dl = await download(`/api/messages/${send.body.id}/attachments/${att.id}`, alice.token);
    expect(dl.body.toString()).toBe('old-chat-photo');

    // Nothing left: the next run does nothing.
    expect(await offload.offloadDatabaseCopies('default')).toMatchObject({ moved: 0, remaining: 0, vacuumed: false });
  });

  it('counts a file once for the storage quota, wherever it is', async () => {
    const { tenantUsage } = await import('../src/platform/quota');
    const before = tenantUsage('default').storage_mb;
    const bytes = crypto.randomBytes(2 * 1024 * 1024);
    fs.writeFileSync(path.join(up, 'quota-a.bin'), bytes);
    conn().prepare('INSERT INTO durable_uploads (name, data, size_bytes) VALUES (?, ?, ?)').run('quota-a.bin', bytes, bytes.length);
    expect(tenantUsage('default').storage_mb - before).toBeCloseTo(2, 0); // on disk and in the database: once
    await offload.offloadDatabaseCopies('default');
    await store.syncUploads(Date.now() + 8 * 86_400_000); // past the cache: only the bucket has it
    expect(fs.existsSync(path.join(up, 'quota-a.bin'))).toBe(false);
    expect(tenantUsage('default').storage_mb - before).toBeCloseTo(2, 0);
  });
});
