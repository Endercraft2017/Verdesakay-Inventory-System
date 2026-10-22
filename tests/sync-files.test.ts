/**
 * Offline-first sync, phase 3e (docs/OFFLINE-FIRST.md §18): files offline. A photo taken on a PC
 * travels with its command and ends up under the same name on the host and the cloud; files made
 * anywhere (the website, before sync existed, other features' subfolders) reach every PC.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cleanup } from './helpers';
import { setupSiteTrio, type SiteTrio } from './sync-helpers';
import { blobPath, storeBlob } from '../src/sync/files';
import { resolveDurableUpload } from '../src/shared/durable-uploads';

let T: SiteTrio;
let itemA: number; // photo added on the LAN PC
let itemB: number; // photo added on the website
let itemOld: number; // photo added before sync existed
let oldImage: string;
const api = () => T.ctx.api;
// A tiny valid PNG (1×1), plus a marker so each test's bytes differ.
const png = (marker: string) => Buffer.concat([
  Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex'), Buffer.from(marker),
]);
const uploads = (slug: string) => T.dbmod.uploadDir(slug);
const imageOf = (conn: import('node:sqlite').DatabaseSync, id: number) =>
  (conn.prepare('SELECT image_path FROM inventory_items WHERE id = ?').get(id) as { image_path: string | null }).image_path;

beforeAll(async () => {
  T = await setupSiteTrio(async ({ api: a, cloudHdr }) => {
    itemA = (await a.post('/api/inventory').set(cloudHdr()).send({ name: 'Photo on desk', quantity: 0 })).body.id;
    itemB = (await a.post('/api/inventory').set(cloudHdr()).send({ name: 'Photo on web', quantity: 0 })).body.id;
    itemOld = (await a.post('/api/inventory').set(cloudHdr()).send({ name: 'Photo from before', quantity: 0 })).body.id;
    const r = await a.post(`/api/inventory/${itemOld}/image`).set(cloudHdr()).attach('image', png('old'), { filename: 'old.png', contentType: 'image/png' });
    oldImage = r.body.image_path;
  });
  // Company-wide records (item photos) are decided offline by the main site: the trio's host.
  await api().put('/api/sync/sites').set(T.cloudHdr()).send({ main_host: T.hostNo });
  await T.hostRound();
  await T.lanRound();
});
afterAll(() => {
  T.close();
  cleanup(T.ctx);
});

describe('files made before sync existed', () => {
  it('reach the host and its LAN PC', () => {
    expect(fs.readFileSync(path.join(uploads(T.hostSlug), oldImage))).toEqual(png('old'));
    expect(fs.readFileSync(path.join(uploads(T.lanSlug), oldImage))).toEqual(png('old'));
  });
});

describe('a photo taken on a site PC', () => {
  it('is named after its command and lands under the same name on the host and the cloud', async () => {
    const r = await api().post(`/api/inventory/${itemA}/image`).set(T.lanHdr())
      .attach('image', png('desk'), { filename: 'shelf.png', contentType: 'image/png' });
    expect(r.status).toBe(200);
    expect(r.headers['x-sync-state']).toBe('local');
    const cmd = String(r.headers['x-sync-command']).toLowerCase();
    expect(r.body.image_path).toBe(`item-${cmd}-0.png`);
    expect(fs.readFileSync(path.join(uploads(T.lanSlug), r.body.image_path))).toEqual(png('desk'));

    await T.lanRound(); // the blob goes to the host first, then the command; the host replays the upload
    expect(imageOf(T.hostDb(), itemA)).toBe(r.body.image_path);
    expect(fs.readFileSync(path.join(uploads(T.hostSlug), r.body.image_path))).toEqual(png('desk'));

    await T.hostRound(); // and on to the cloud
    expect(imageOf(T.cloudDb(), itemA)).toBe(r.body.image_path);
    const served = await api().get(`/api/inventory/${itemA}/image`).set(T.cloudHdr()).buffer(true)
      .parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect(served.body).toEqual(png('desk'));
    await T.lanRound();
    expect(imageOf(T.lanDb(), itemA)).toBe(r.body.image_path);
  });
});

describe('a photo uploaded on the website', () => {
  it('reaches the host and the LAN PC with the row that points at it', async () => {
    const r = await api().post(`/api/inventory/${itemB}/image`).set(T.cloudHdr())
      .attach('image', png('web'), { filename: 'web.png', contentType: 'image/png' });
    expect(r.status).toBe(200);
    await T.hostRound();
    await T.lanRound();
    expect(imageOf(T.lanDb(), itemB)).toBe(r.body.image_path);
    expect(fs.readFileSync(path.join(uploads(T.lanSlug), r.body.image_path))).toEqual(png('web'));
  });

  it('files in a feature\'s subfolder (kiosk punch photos) travel too', async () => {
    const dir = path.join(uploads('default'), 'kiosk-punches');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'punch-test.jpg'), 'punch bytes');
    await new Promise((r) => setTimeout(r, 5100)); // the cloud rescans its uploads at most every 5 s
    await T.hostRound();
    await T.lanRound();
    expect(fs.readFileSync(path.join(uploads(T.lanSlug), 'kiosk-punches', 'punch-test.jpg'), 'utf8')).toBe('punch bytes');
  });
});

describe('the file endpoints', () => {
  it('restores an offline command blob and a downloaded file after their working copies disappear', () => {
    const bytes = Buffer.from('offline command bytes');
    const hash = storeBlob(T.lanSlug, bytes);
    fs.unlinkSync(blobPath(T.lanSlug, hash));
    expect(fs.readFileSync(blobPath(T.lanSlug, hash))).toEqual(bytes);

    const downloaded = path.join(uploads(T.lanSlug), oldImage);
    fs.unlinkSync(downloaded);
    const restored = T.dbmod.withTenant(T.lanSlug, () => resolveDurableUpload(oldImage));
    expect(restored).toBe(downloaded);
    expect(fs.readFileSync(downloaded)).toEqual(png('old'));
  });

  it('refuse a blob that does not match its hash, and anything outside the uploads folder', async () => {
    const token = T.sync.remoteOf(T.hostDb())!.nodeToken;
    const bad = await api().put(`/api/sync/blobs/${'a'.repeat(64)}`).set('X-Sync-Node-Token', token)
      .set('Content-Type', 'application/octet-stream').send(Buffer.from('not that'));
    expect(bad.status).toBe(400);
    const seq = Number(T.cloudDb().prepare("INSERT INTO sync_files (name, size) VALUES ('../../outside.txt', 1) RETURNING seq").get()!.seq);
    const esc = await api().get(`/api/sync/files/${seq}`).set('X-Sync-Node-Token', token);
    expect(esc.status).toBe(404);
    expect((await api().get('/api/sync/files').set('X-Sync-Node-Token', 'nope')).status).toBe(401);
  });
});
