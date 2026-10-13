/**
 * Off-site backup copies: pushes the daily snapshots (src/platform/backups.ts) and the
 * uploads folder to one or more S3-compatible buckets, compressed and encrypted.
 *
 * Targets come from env — any number, each named by its prefix:
 *   BACKUP_S3_<NAME>_BUCKET      bucket name (its presence defines the target)
 *   BACKUP_S3_<NAME>_ENDPOINT    e.g. https://s3.us-east-005.backblazeb2.com
 *   BACKUP_S3_<NAME>_KEY_ID      access key id
 *   BACKUP_S3_<NAME>_SECRET      secret access key
 *   BACKUP_S3_<NAME>_REGION      optional; parsed from an `s3.<region>.` endpoint, else "auto"
 *   BACKUP_S3_<NAME>_KEEP_DAYS   optional; the app deletes this target's DB snapshots older
 *                                than N days. Leave unset when the bucket has its own
 *                                lifecycle rule (e.g. Backblaze).
 *   BACKUP_S3_<NAME>_PATH_STYLE  "true" for path-style addressing (MinIO / local fakes)
 *   BACKUP_KEY                   REQUIRED when any target is set — nothing leaves the
 *                                server unencrypted. Keep a copy somewhere safe: without it
 *                                the off-site copies cannot be read.
 *
 * Object layout per bucket:
 *   db/<name>/<name>-YYYY-MM-DD.db.gz.enc   one per daily snapshot (name = tenant slug,
 *                                           `default`, or `_platform`)
 *   uploads/<relative path>.gz.enc          mirror of UPLOAD_DIR: additive (never pruned),
 *                                           EXCEPT kiosk punch photos — when the app's photo
 *                                           retention deletes one, it's deleted here too
 *
 * Which files were already sent is tracked per target in `backupDir()/offsite/<name>.json`,
 * so every hourly run only sends what's new — and anything that failed is retried on the
 * next run. Delete that file to force a full re-send.
 *
 * Encrypted format: "VDSB1" | iv(12) | authTag(16) | AES-256-GCM(gzip(data)), key = SHA-256(BACKUP_KEY).
 */
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { UPLOAD_DIR } from '../shared/db';
import { backupDir, kindDir, isRetentionManagedUpload } from '../shared/backup';
import { S3Client } from '../shared/s3';

export interface OffsiteTarget {
  name: string;
  client: S3Client;
  keepDays: number | null;
}

export interface OffsiteResult {
  target: string;
  ok: boolean;
  dbSent: number;
  uploadsSent: number;
  pruned: number;
  photosRemoved: number;
  error?: string;
}

const MAGIC = Buffer.from('VDSB1');

export function offsiteTargets(env: NodeJS.ProcessEnv = process.env): OffsiteTarget[] {
  const out: OffsiteTarget[] = [];
  for (const k of Object.keys(env).sort()) {
    const m = /^BACKUP_S3_([A-Z0-9]+)_BUCKET$/.exec(k);
    if (!m || !env[k]) continue;
    const p = `BACKUP_S3_${m[1]}_`;
    const endpoint = env[`${p}ENDPOINT`] || '';
    const keyId = env[`${p}KEY_ID`] || '';
    const secret = env[`${p}SECRET`] || '';
    if (!endpoint || !keyId || !secret) {
      throw new Error(`Off-site target ${m[1]} is incomplete: set ${p}ENDPOINT, ${p}KEY_ID and ${p}SECRET.`);
    }
    const region = env[`${p}REGION`] || /(?:^|\/\/)s3\.([a-z0-9-]+)\./.exec(endpoint)?.[1] || 'auto';
    const keep = Number(env[`${p}KEEP_DAYS`]);
    out.push({
      name: m[1]!.toLowerCase(),
      client: new S3Client({
        endpoint, bucket: env[k]!, region, accessKeyId: keyId, secretAccessKey: secret,
        pathStyle: env[`${p}PATH_STYLE`] === 'true',
      }),
      keepDays: Number.isFinite(keep) && keep > 0 ? Math.floor(keep) : null,
    });
  }
  return out;
}

function backupKey(): Buffer {
  const k = process.env.BACKUP_KEY || '';
  if (k.length < 16) throw new Error('BACKUP_KEY must be set (16+ characters) before anything is sent off-site.');
  return crypto.createHash('sha256').update(k).digest();
}

export function pack(data: Buffer): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', backupKey(), iv);
  const body = Buffer.concat([cipher.update(zlib.gzipSync(data)), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

export function unpack(blob: Buffer): Buffer {
  if (!blob.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Not an off-site backup file (bad header).');
  const iv = blob.subarray(5, 17);
  const tag = blob.subarray(17, 33);
  const decipher = crypto.createDecipheriv('aes-256-gcm', backupKey(), iv);
  decipher.setAuthTag(tag);
  try {
    return zlib.gunzipSync(Buffer.concat([decipher.update(blob.subarray(33)), decipher.final()]));
  } catch {
    throw new Error('Could not decrypt — wrong BACKUP_KEY, or the file is damaged.');
  }
}

interface Manifest { db: Record<string, true>; uploads: Record<string, string>; photoSweepDay?: string }

function manifestFile(target: string): string {
  return path.join(backupDir(), 'offsite', `${target}.json`);
}
function readManifest(target: string): Manifest {
  try {
    const m = JSON.parse(fs.readFileSync(manifestFile(target), 'utf8')) as Partial<Manifest>;
    return { db: m.db || {}, uploads: m.uploads || {}, photoSweepDay: m.photoSweepDay };
  } catch {
    return { db: {}, uploads: {} };
  }
}
function writeManifest(target: string, m: Manifest): void {
  const f = manifestFile(target);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(m));
  fs.renameSync(`${f}.tmp`, f);
}

const DAY_RE = /-(\d{4}-\d{2}-\d{2})\.db/;
function dayOf(file: string): number | null {
  const d = DAY_RE.exec(file)?.[1];
  return d ? Date.parse(`${d}T00:00:00Z`) : null;
}

/** Local daily snapshot files, as object key → path. */
function localDailySnapshots(): Map<string, string> {
  const out = new Map<string, string>();
  const root = backupDir();
  if (!fs.existsSync(root)) return out;
  for (const name of fs.readdirSync(root)) {
    if (name === 'uploads' || name === 'offsite') continue;
    const dir = kindDir(name, 'daily');
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => DAY_RE.test(x) && x.endsWith('.db'))) {
      out.set(`db/${name}/${f}.gz.enc`, path.join(dir, f));
    }
  }
  return out;
}

function walk(dir: string, rel = ''): Array<{ rel: string; abs: string; sig: string }> {
  if (!fs.existsSync(dir)) return [];
  const out: Array<{ rel: string; abs: string; sig: string }> = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(abs, r));
    else if (e.isFile()) {
      const st = fs.statSync(abs);
      out.push({ rel: r, abs, sig: `${st.size}:${Math.floor(st.mtimeMs)}` });
    }
  }
  return out;
}

async function pushTarget(t: OffsiteTarget, now: Date): Promise<OffsiteResult> {
  const r: OffsiteResult = { target: t.name, ok: true, dbSent: 0, uploadsSent: 0, pruned: 0, photosRemoved: 0 };
  const m = readManifest(t.name);
  const cutoff = t.keepDays ? now.getTime() - t.keepDays * 86_400_000 : null;
  try {
    for (const [key, file] of localDailySnapshots()) {
      if (m.db[key]) continue;
      const day = dayOf(file);
      if (cutoff !== null && day !== null && day < cutoff) continue; // would be pruned right away
      await t.client.put(key, pack(fs.readFileSync(file)));
      m.db[key] = true;
      r.dbSent++;
      writeManifest(t.name, m);
    }
    const local = walk(UPLOAD_DIR);
    for (const f of local) {
      if (m.uploads[f.rel] === f.sig) continue;
      await t.client.put(`uploads/${f.rel}.gz.enc`, pack(fs.readFileSync(f.abs)));
      m.uploads[f.rel] = f.sig;
      r.uploadsSent++;
      if (r.uploadsSent % 25 === 0) writeManifest(t.name, m);
    }
    writeManifest(t.name, m);

    // Punch photos the app's retention deleted: remove them here too. The manifest covers
    // what this server sent; a once-a-day listing also catches anything it doesn't know
    // about (a lost manifest, a copy sent from another machine).
    const localRels = new Set(local.map((f) => f.rel));
    const gone = new Set(Object.keys(m.uploads).filter((rel) => isRetentionManagedUpload(rel) && !localRels.has(rel)));
    const today = now.toISOString().slice(0, 10);
    if (m.photoSweepDay !== today) {
      for (const o of await t.client.list('uploads/')) {
        const rel = o.key.slice('uploads/'.length).replace(/\.gz\.enc$/, '');
        if (isRetentionManagedUpload(rel) && !localRels.has(rel)) gone.add(rel);
      }
    }
    for (const rel of gone) {
      await t.client.delete(`uploads/${rel}.gz.enc`);
      delete m.uploads[rel];
      r.photosRemoved++;
    }
    m.photoSweepDay = today;
    writeManifest(t.name, m);
    if (cutoff !== null) {
      for (const o of await t.client.list('db/')) {
        const day = dayOf(o.key);
        if (day !== null && day < cutoff) {
          await t.client.delete(o.key);
          delete m.db[o.key];
          r.pruned++;
        }
      }
      writeManifest(t.name, m);
    }
  } catch (e) {
    writeManifest(t.name, m); // keep whatever did get sent
    r.ok = false;
    r.error = (e as Error).message;
  }
  return r;
}

let running: Promise<OffsiteResult[]> | null = null;

/** Send everything new to every configured target. Never throws; one run at a time. */
export function pushOffsite(now = new Date()): Promise<OffsiteResult[]> {
  if (running) return running;
  running = (async () => {
    let targets: OffsiteTarget[];
    try {
      targets = offsiteTargets();
      if (!targets.length) return [];
      backupKey(); // fail fast, once, instead of per file
    } catch (e) {
      console.error(`[backup] off-site copy skipped: ${(e as Error).message}`);
      return [{ target: '*', ok: false, dbSent: 0, uploadsSent: 0, pruned: 0, photosRemoved: 0, error: (e as Error).message }];
    }
    const results: OffsiteResult[] = [];
    for (const t of targets) results.push(await pushTarget(t, now));
    for (const r of results) {
      if (!r.ok) console.error(`[backup] off-site "${r.target}" FAILED: ${r.error}`);
      else if (r.dbSent || r.uploadsSent || r.pruned || r.photosRemoved) {
        console.log(`[backup] off-site "${r.target}": ${r.dbSent} snapshot(s), ${r.uploadsSent} upload(s) sent, ${r.pruned} old snapshot(s) + ${r.photosRemoved} expired punch photo(s) removed`);
      }
    }
    writeOffsiteStatus(results);
    return results;
  })().finally(() => { running = null; });
  return running;
}

function writeOffsiteStatus(results: OffsiteResult[]): void {
  try {
    const statusFile = path.join(backupDir(), 'status.json');
    const prev = fs.existsSync(statusFile) ? JSON.parse(fs.readFileSync(statusFile, 'utf8')) : {};
    const allOk = results.every((r) => r.ok);
    fs.mkdirSync(path.dirname(statusFile), { recursive: true });
    fs.writeFileSync(statusFile, JSON.stringify({
      ...prev,
      offsite: {
        ...(prev.offsite || {}),
        last_run: { at: new Date().toISOString(), ok: allOk, results },
        ...(allOk ? { last_success_at: new Date().toISOString() } : {}),
      },
    }, null, 2));
  } catch { /* informational only */ }
}

export function findTarget(name: string): OffsiteTarget {
  const t = offsiteTargets().find((x) => x.name === name.toLowerCase());
  if (!t) throw new Error(`No off-site target "${name}". Configured: ${offsiteTargets().map((x) => x.name).join(', ') || '(none)'}`);
  return t;
}

/** Round-trip a small object through a target to prove the credentials and key work. */
export async function testTarget(t: OffsiteTarget): Promise<void> {
  const key = `_selftest/${Date.now()}.txt.gz.enc`;
  const payload = Buffer.from(`Otom offsite self-test ${new Date().toISOString()}`);
  await t.client.put(key, pack(payload));
  const back = unpack(await t.client.get(key));
  if (!back.equals(payload)) throw new Error('Downloaded copy did not match what was uploaded.');
  await t.client.delete(key).catch(() => { /* a write-only key may not delete; the test already passed */ });
}
