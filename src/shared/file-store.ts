/**
 * Uploaded files in object storage. With a bucket configured, the bucket is where uploads live:
 * every file under UPLOAD_DIR is copied up within a minute of being written, the server's own
 * folder becomes a cache (a copy not used for FILES_CACHE_DAYS is removed from disk), and a file
 * that isn't on disk is fetched back the first time it's asked for. Without a bucket (installed
 * PCs, local dev, tests) nothing changes: the database copies in durable-uploads.ts stay.
 *
 * The bucket takes the place of those database copies: with a bucket, storeDurableUpload() sends
 * the file here (`sendNow`) instead of writing its bytes into the tenant database,
 * resolveDurableUploadAsync() fetches a dropped file back (`localCopy`), forgetDurableUpload()
 * deletes the bucket copy (`forgetUpload`), and offloadDatabaseCopies() moves bytes the databases
 * already hold into the bucket. Object keys mirror the folder — `<prefix>/<path under
 * UPLOAD_DIR>` — so a tenant's files are all under `<prefix>/<slug>/`.
 *
 * Deletes reach the bucket only through those explicit calls. A file that disappears from disk
 * any other way (a replaced filesystem, an emptied folder) counts as dropped from the cache, not
 * deleted: the bucket copy stays and is fetched back when asked for.
 *
 * Always kept on disk: punch photos (their retention reads and caps that folder; it deletes
 * through forgetDurableUpload), plain-text files (the AI knowledge index rebuilds from them
 * synchronously, see TEXT_EXT) and dot-folders (`.sync-blobs`, which keep their database copies,
 * and this manifest).
 *
 * Env (one bucket):
 *   FILES_S3_FROM        name of an off-site backup target whose credentials to reuse, e.g.
 *                        `railway` → BACKUP_S3_RAILWAY_* (src/platform/offsite.ts). Or set:
 *   FILES_S3_BUCKET / FILES_S3_ENDPOINT / FILES_S3_KEY_ID / FILES_S3_SECRET
 *   FILES_S3_REGION      optional; parsed from an `s3.<region>.` endpoint, else "auto"
 *   FILES_S3_PATH_STYLE  "true" for path-style addressing (MinIO / local fakes)
 *   FILES_S3_PREFIX      key prefix (default `files`) — keeps live files apart from a backup
 *                        target's `db/` and `uploads/` when they share a bucket
 *   FILES_CACHE_DAYS     drop local copies unused for this many days (default 7; 0 = keep all)
 *   FILES_KEY            encryption key for the bucket copies; defaults to BACKUP_KEY. Required —
 *                        nothing leaves the server unencrypted (same rule as the off-site backups).
 *                        Lose it and the bucket copies are unreadable.
 *
 * What was copied up is tracked in `UPLOAD_DIR/.file-store.json` (path → size, the sent copy's
 * size:mtime, last use, whether it's only in the bucket). Losing it is safe: the next sweep
 * re-sends what's on disk and re-learns the rest from a bucket listing.
 *
 * Bucket format: "VDSF1" | iv(12) | authTag(16) | AES-256-GCM(file), key = SHA-256(FILES_KEY).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { UPLOAD_DIR } from './db';
import { S3Client, type S3Config } from './s3';
import { isRetentionManagedUpload } from './backup';

const MANIFEST = '.file-store.json';
const DAY = 86_400_000;
/** A file written this recently may still be mid-upload (or a temp name about to be renamed). */
const SETTLE_MS = 10_000;
const SWEEP_MS = 60_000;
/** Plain-text uploads whose contents the AI knowledge index reads (modules/ai/rag.ts). Kept on
 *  disk — the index is rebuilt from scratch every few minutes and can't fetch from the bucket. */
export const TEXT_EXT = new Set(['.txt', '.md', '.csv', '.json', '.log']);

interface Entry {
  size: number;
  /** `size:mtime` of the local copy that was sent (absent while only in the bucket). */
  sig?: string;
  /** Last time a route asked for it (ms). */
  used?: number;
  /** Only in the bucket — the local copy was dropped from the cache. */
  evicted?: true;
}
interface Manifest { files: Record<string, Entry> }

export interface FileStore { client: S3Client; prefix: string; cacheDays: number; key: Buffer }

function configFromEnv(p: string, env: NodeJS.ProcessEnv): S3Config | null {
  const bucket = env[`${p}BUCKET`];
  if (!bucket) return null;
  const endpoint = env[`${p}ENDPOINT`] || '';
  const accessKeyId = env[`${p}KEY_ID`] || '';
  const secretAccessKey = env[`${p}SECRET`] || '';
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error(`File storage is incomplete: set ${p}ENDPOINT, ${p}KEY_ID and ${p}SECRET.`);
  }
  const region = env[`${p}REGION`] || /(?:^|\/\/)s3\.([a-z0-9-]+)\./.exec(endpoint)?.[1] || 'auto';
  return { endpoint, bucket, region, accessKeyId, secretAccessKey, pathStyle: env[`${p}PATH_STYLE`] === 'true' };
}

let cached: { sig: string; store: FileStore | null } | null = null;

/** The configured bucket, or null when uploads stay on disk only. Throws on a broken config. */
export function fileStore(env: NodeJS.ProcessEnv = process.env): FileStore | null {
  const from = env.FILES_S3_FROM?.trim();
  const p = from ? `BACKUP_S3_${from.toUpperCase()}_` : 'FILES_S3_';
  const cfg = configFromEnv(p, env);
  if (from && !cfg) throw new Error(`FILES_S3_FROM=${from}, but ${p}BUCKET is not set.`);
  const prefix = (env.FILES_S3_PREFIX || 'files').replace(/^\/+|\/+$/g, '');
  const days = Number(env.FILES_CACHE_DAYS ?? 7);
  const secret = env.FILES_KEY || env.BACKUP_KEY || '';
  if (cfg && secret.length < 16) throw new Error('File storage needs FILES_KEY (or BACKUP_KEY), 16+ characters — files are encrypted before they leave the server.');
  const sig = JSON.stringify([cfg, prefix, days, secret]);
  if (cached?.sig !== sig) {
    cached = {
      sig,
      store: cfg ? {
        client: new S3Client(cfg), prefix, cacheDays: Number.isFinite(days) && days > 0 ? days : 0,
        key: crypto.createHash('sha256').update(secret).digest(),
      } : null,
    };
  }
  return cached.store;
}

/** For request paths: a broken config logs once and behaves as "no bucket". */
function storeOrNull(): FileStore | null {
  try { return fileStore(); } catch (e) { warnOnce((e as Error).message); return null; }
}

/** True when uploads go to a bucket (a broken config counts as no bucket). */
export function bucketEnabled(): boolean {
  return !!storeOrNull();
}

const warned = new Set<string>();
function warnOnce(msg: string): void {
  if (warned.has(msg)) return;
  warned.add(msg);
  console.error(`[files] ${msg}`);
}

// ---- encryption ----

const MAGIC = Buffer.from('VDSF1');

export function seal(s: FileStore, data: Buffer): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', s.key, iv);
  const body = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

function unseal(s: FileStore, blob: Buffer): Buffer {
  if (!blob.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not a file-bucket object (bad header)');
  const decipher = crypto.createDecipheriv('aes-256-gcm', s.key, blob.subarray(5, 17));
  decipher.setAuthTag(blob.subarray(17, 33));
  try {
    return Buffer.concat([decipher.update(blob.subarray(33)), decipher.final()]);
  } catch {
    throw new Error('could not decrypt — wrong FILES_KEY, or the object is damaged');
  }
}

// ---- paths ----

const root = () => path.resolve(UPLOAD_DIR);

/** `a/b.jpg` for a file under UPLOAD_DIR; null outside it or inside a dot-folder. */
function relOf(abs: string): string | null {
  const rel = path.relative(root(), path.resolve(abs));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  return parts.some((s) => s.startsWith('.')) ? null : parts.join('/');
}

const keyOf = (s: FileStore, rel: string) => `${s.prefix}/${rel}`;
const sigOf = (st: fs.Stats) => `${st.size}:${Math.floor(st.mtimeMs)}`;

/** Whether this upload's durable copy lives in the bucket (else: the database). Dot-folders and
 *  paths outside UPLOAD_DIR never do. */
export function bucketManages(abs: string): boolean {
  return bucketEnabled() && relOf(abs) !== null;
}

// ---- manifest ----

let manifest: Manifest | null = null;
let manifestFresh = false; // no manifest file existed: learn bucket-only files from a listing

function load(): Manifest {
  if (manifest) return manifest;
  try {
    const m = JSON.parse(fs.readFileSync(path.join(root(), MANIFEST), 'utf8')) as Partial<Manifest>;
    manifest = { files: m.files || {} };
  } catch {
    manifest = { files: {} };
    manifestFresh = true;
  }
  return manifest;
}

function save(): void {
  if (!manifest) return;
  const f = path.join(root(), MANIFEST);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(manifest));
  fs.renameSync(`${f}.tmp`, f);
}

// ---- what routes call ----

const inflight = new Map<string, Promise<boolean>>();

/**
 * Make sure an upload is on disk before serving it: true if it is (fetched back from the bucket
 * when the cache had dropped it), false if it exists nowhere. Never throws.
 */
export function localCopy(abs: string): Promise<boolean> {
  const rel = relOf(abs);
  if (fs.existsSync(abs)) {
    const e = rel && storeOrNull() ? load().files[rel] : undefined;
    if (e) e.used = Date.now();
    return Promise.resolve(true);
  }
  const s = storeOrNull();
  if (!s || !rel) return Promise.resolve(false);
  let p = inflight.get(rel);
  if (!p) {
    p = fetchBack(s, rel, abs).finally(() => inflight.delete(rel));
    inflight.set(rel, p);
  }
  return p;
}

async function fetchBack(s: FileStore, rel: string, abs: string): Promise<boolean> {
  try {
    const blob = await s.client.getIfExists(keyOf(s, rel));
    if (!blob) return false;
    const bytes = unseal(s, blob);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${process.pid}.part`);
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, abs);
    // Record the fetched copy as already sent, so the sweep doesn't upload it again.
    load().files[rel] = { size: bytes.length, sig: sigOf(fs.statSync(abs)), used: Date.now() };
    return true;
  } catch (e) {
    console.error(`[files] could not fetch ${rel} from the bucket: ${(e as Error).message}`);
    return false;
  }
}

/** Whether the bucket holds this file's current bytes (as sent, or only there). */
export function hasBucketCopy(abs: string): boolean {
  const rel = relOf(abs);
  if (!rel || !storeOrNull()) return false;
  const e = load().files[rel];
  if (!e) return false;
  if (e.evicted) return true;
  try { return e.sig === sigOf(fs.statSync(abs)); } catch { return false; }
}

/** Send one upload to the bucket now (the sweep would within a minute). True once it's there;
 *  false with no bucket, if the file is gone, or if the upload failed (the sweep retries). */
export async function sendNow(abs: string): Promise<boolean> {
  const s = storeOrNull();
  const rel = relOf(abs);
  if (!s || !rel) return false;
  try {
    const st = fs.statSync(abs);
    if (load().files[rel]?.sig === sigOf(st)) return true;
    await s.client.put(keyOf(s, rel), seal(s, fs.readFileSync(abs)));
    load().files[rel] = { size: st.size, sig: sigOf(st), used: Date.now() };
    save();
    return true;
  } catch (e) {
    console.error(`[files] could not send ${rel} to the bucket: ${(e as Error).message}`);
    return false;
  }
}

/** Put bytes the server holds elsewhere (a database copy) into the bucket as this upload. True
 *  once stored. A file that isn't on disk (or differs) is recorded as bucket-only. */
export async function putBytes(abs: string, bytes: Buffer): Promise<boolean> {
  const s = storeOrNull();
  const rel = relOf(abs);
  if (!s || !rel) return false;
  try {
    await s.client.put(keyOf(s, rel), seal(s, bytes));
    let st: fs.Stats | null = null;
    try { st = fs.statSync(abs); } catch { /* not on disk */ }
    load().files[rel] = st && st.size === bytes.length
      ? { size: st.size, sig: sigOf(st), used: Date.now() }
      : { size: bytes.length, evicted: true };
    save();
    return true;
  } catch (e) {
    console.error(`[files] could not store ${rel} in the bucket: ${(e as Error).message}`);
    return false;
  }
}

/** Delete an upload's bucket copy (the caller removes the local file). Never throws. */
export async function forgetUpload(abs: string): Promise<void> {
  const s = storeOrNull();
  const rel = relOf(abs);
  if (!s || !rel) return;
  delete load().files[rel];
  save();
  try { await s.client.delete(keyOf(s, rel)); } catch (e) {
    console.error(`[files] could not delete ${rel} from the bucket: ${(e as Error).message}`);
  }
}

/** Delete an upload: the local file and, with a bucket, its bucket copy. Never throws. */
export async function removeUpload(abs: string): Promise<void> {
  await fs.promises.unlink(abs).catch(() => { /* not on disk (or already gone) */ });
  const s = storeOrNull();
  const rel = relOf(abs);
  if (!s || !rel) return;
  delete load().files[rel];
  try { await s.client.delete(keyOf(s, rel)); } catch (e) {
    console.error(`[files] could not delete ${rel} from the bucket: ${(e as Error).message}`);
  }
}

/** Delete a whole folder of uploads (a purged tenant), on disk and in the bucket. Never throws. */
export async function removeUploadFolder(absDir: string): Promise<void> {
  try { fs.rmSync(absDir, { recursive: true, force: true }); } catch { /* best effort */ }
  const s = storeOrNull();
  const rel = relOf(absDir);
  if (!s || !rel) return;
  const m = load();
  for (const k of Object.keys(m.files)) if (k.startsWith(`${rel}/`)) delete m.files[k];
  try {
    for (const o of await s.client.list(`${keyOf(s, rel)}/`)) await s.client.delete(o.key);
    save();
  } catch (e) {
    console.error(`[files] could not delete ${rel}/ from the bucket: ${(e as Error).message}`);
  }
}

/** Files directly in `dir` that are only in the bucket (the cache dropped them). */
export function bucketOnly(dir: string): Array<{ name: string; size: number }> {
  if (!storeOrNull()) return [];
  const rel = path.resolve(dir) === root() ? '' : relOf(dir);
  if (rel === null) return [];
  const out: Array<{ name: string; size: number }> = [];
  for (const [k, e] of Object.entries(load().files)) {
    if (!e.evicted) continue;
    const slash = k.lastIndexOf('/');
    if ((slash < 0 ? '' : k.slice(0, slash)) === rel) out.push({ name: k.slice(slash + 1), size: e.size });
  }
  return out;
}

/** Bytes under `dir` (and its subfolders) that are only in the bucket: what a disk-size count
 *  misses. 0 without a bucket. */
export function bucketOnlyBytes(dir: string): number {
  if (!storeOrNull()) return 0;
  const rel = path.resolve(dir) === root() ? '' : relOf(dir);
  if (rel === null) return 0;
  let total = 0;
  for (const [k, e] of Object.entries(load().files)) {
    if (e.evicted && (rel === '' || k.startsWith(rel + '/'))) total += e.size;
  }
  return total;
}

// ---- the sweep ----

/** `lost`: files that vanished from disk outside the app, now served from the bucket. */
export interface SweepResult { ok: boolean; sent: number; lost: number; dropped: number; error?: string }

function walk(dir: string, rel = ''): Array<{ rel: string; abs: string; st: fs.Stats }> {
  if (!fs.existsSync(dir)) return [];
  const out: Array<{ rel: string; abs: string; st: fs.Stats }> = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const abs = path.join(dir, e.name);
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(abs, r));
    else if (e.isFile()) {
      try { out.push({ rel: r, abs, st: fs.statSync(abs) }); } catch { /* raced a delete */ }
    }
  }
  return out;
}

async function sweep(s: FileStore, now: number): Promise<SweepResult> {
  const r: SweepResult = { ok: true, sent: 0, lost: 0, dropped: 0 };
  // No upload folder at all (a volume that isn't mounted): touch nothing.
  if (!fs.existsSync(root())) return { ...r, ok: false, error: `${UPLOAD_DIR} does not exist.` };
  const m = load();
  try {
    const local = walk(root());
    const onDisk = new Set(local.map((f) => f.rel));

    // A lost (or first) manifest: learn which bucket files aren't on disk, so they're counted.
    if (manifestFresh) {
      for (const o of await s.client.list(`${s.prefix}/`)) {
        const rel = o.key.slice(s.prefix.length + 1);
        if (rel && !onDisk.has(rel) && !m.files[rel]) m.files[rel] = { size: o.size, evicted: true };
      }
      manifestFresh = false;
    }

    // 1. Send what's new or changed.
    for (const f of local) {
      if (now - f.st.mtimeMs < SETTLE_MS) continue;
      const sig = sigOf(f.st);
      const e = m.files[f.rel];
      if (e?.sig === sig) continue;
      await s.client.put(keyOf(s, f.rel), seal(s, fs.readFileSync(f.abs)));
      m.files[f.rel] = { size: f.st.size, sig, used: e?.used };
      r.sent++;
      if (r.sent % 25 === 0) save();
    }

    // 2. Gone from disk without an explicit delete (a replaced filesystem, an emptied folder):
    //    the bucket copy is the file now. Deletes reach the bucket only through forgetUpload /
    //    removeUpload, so a lost disk can never read as "everything was deleted".
    for (const rel of Object.keys(m.files)) {
      const e = m.files[rel]!;
      if (e.evicted || onDisk.has(rel)) continue;
      m.files[rel] = { size: e.size, used: e.used, evicted: true };
      r.lost++;
    }

    // 3. Drop cached copies nobody has used for cacheDays (they're safe in the bucket).
    if (s.cacheDays > 0) {
      const cutoff = now - s.cacheDays * DAY;
      for (const f of local) {
        const e = m.files[f.rel];
        if (!e || e.sig !== sigOf(f.st) || isRetentionManagedUpload(f.rel)) continue;
        if (TEXT_EXT.has(path.extname(f.rel).toLowerCase())) continue;
        if (Math.max(f.st.mtimeMs, e.used ?? 0) >= cutoff) continue;
        try { fs.unlinkSync(f.abs); } catch { continue; }
        m.files[f.rel] = { size: e.size, used: e.used, evicted: true };
        r.dropped++;
      }
    }
  } catch (e) {
    r.ok = false;
    r.error = (e as Error).message;
  }
  save();
  return r;
}

let running: Promise<SweepResult> | null = null;

/** Copy new uploads up, note files lost from disk, trim the cache. One run at a time; never throws. */
export function syncUploads(now = Date.now()): Promise<SweepResult> {
  if (running) return running;
  let s: FileStore | null;
  try { s = fileStore(); } catch (e) {
    return Promise.resolve({ ok: false, sent: 0, lost: 0, dropped: 0, error: (e as Error).message });
  }
  if (!s) return Promise.resolve({ ok: true, sent: 0, lost: 0, dropped: 0 });
  running = sweep(s, now).finally(() => { running = null; });
  return running;
}

/** Tests: forget the loaded manifest (as if the server restarted). */
export function _resetFileStore(): void {
  manifest = null;
  manifestFresh = false;
  cached = null;
}

/** Start the background sweep (every minute) when a bucket is configured. `afterSweep` runs after
 *  each successful sweep (server.ts: durable-uploads.ts offloadDatabaseCopies). */
export function startFileStore(afterSweep?: () => Promise<void>): void {
  let s: FileStore | null;
  try { s = fileStore(); } catch (e) { console.error(`[files] ${(e as Error).message} Uploads stay on disk only.`); return; }
  if (!s) return;
  console.log(`[files] uploads are stored in the bucket under "${s.prefix}/"${s.cacheDays ? `, cached on disk for ${s.cacheDays} day(s)` : ''}`);
  const tick = async () => {
    const r = await syncUploads();
    if (!r.ok) { console.error(`[files] sync FAILED: ${r.error}`); return; }
    if (r.sent || r.dropped) console.log(`[files] ${r.sent} sent, ${r.dropped} dropped from the disk cache`);
    if (r.lost) console.warn(`[files] ${r.lost} file(s) disappeared from disk outside the app; serving them from the bucket`);
    if (afterSweep) await afterSweep().catch((e) => console.error(`[files] ${(e as Error).message}`));
  };
  void tick();
  setInterval(() => { void tick(); }, SWEEP_MS).unref();
}
