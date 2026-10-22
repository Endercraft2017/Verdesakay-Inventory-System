/**
 * Files offline (docs/OFFLINE-FIRST.md §18, phase 3e). Uploads are files on disk under
 * `uploadDir()`, named by the route (multer) and referenced from database rows. Two lanes:
 *
 * 1. **A command carries its uploads.** A route opts in by wrapping its multer middleware in
 *    `syncUpload()`. While a command is recorded or replayed, each uploaded file is kept in the
 *    copy's blob store (content-addressed, SHA-256) and renamed after the command
 *    (`<prefix>-<commandId>-<n><ext>`), so the PC and the authority store the *same* name in the
 *    row. The command's body becomes `{ __multipart: 1, fields, files: [{ field, name, type, hash }] }`;
 *    the PC sends the blobs before the command (`PUT /api/sync/blobs/:hash`), and the replay
 *    rebuilds the multipart request from them.
 * 2. **Files made anywhere reach every copy.** An authority keeps a numbered list of the files in
 *    its uploads folder (rescanned, throttled — so every feature's uploads are covered, not just
 *    opted-in routes); each PC fetches the ones it lacks after every sync round. A site host does
 *    the same for its LAN PCs, listing what it fetched from the cloud.
 *
 * Endpoints (node token, mounted under /api/sync):
 *   PUT /blobs/:hash        store a blob (checked against its hash)
 *   GET /files?since=N      files listed after N: [{ seq, name, size }]
 *   GET /files/:seq         that file's bytes
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { activeDb, tenantStore, uploadDir, withTenant } from '../shared/db';
import { storeDurableUpload, resolveDurableUpload, resolveDurableUploadAsync } from '../shared/durable-uploads';
import { bucketOnly } from '../shared/file-store';
import { syncContext } from '../shared/sync-context';
import { isAuthority, syncConfigOf } from './node';
import { keepRequestContext } from '../shared/request-context';

const BLOB_DIR = '.sync-blobs';
/** Subfolders of a tenant's uploads that hold its files (others there are other tenants'). */
const FILE_SUBDIRS = ['kiosk-punches'];
const MAX_BLOB_BYTES = 50 * 1024 * 1024;

const slugOf = () => tenantStore.getStore()?.slug ?? 'default';
export const sha256File = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const isHash = (h: string) => /^[0-9a-f]{64}$/.test(h);

export function blobPath(slug: string, hash: string): string {
  const name = `${BLOB_DIR}/${hash}`;
  return withTenant(slug, () => resolveDurableUpload(name) || path.join(uploadDir(slug), BLOB_DIR, hash));
}

/** Put bytes into this copy's blob store (idempotent). */
export function storeBlob(slug: string, bytes: Buffer): string {
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const file = blobPath(slug, hash);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  }
  withTenant(slug, () => storeDurableUpload(`${BLOB_DIR}/${hash}`));
  return hash;
}

export interface CommandFile {
  field: string;
  name: string;
  type: string;
  hash: string;
}

type UploadedFile = Express.Multer.File;
type WithSyncFiles = Request & { syncFiles?: CommandFile[] };

function uploadedFiles(req: Request): UploadedFile[] {
  if (req.file) return [req.file];
  if (Array.isArray(req.files)) return req.files;
  if (req.files && typeof req.files === 'object') return Object.values(req.files).flat();
  return [];
}

/**
 * Wrap a route's multer middleware so its uploads can be part of a sync command. Outside a
 * command (a direct request to the cloud, a DB without sync) it is exactly the multer middleware.
 */
export function syncUpload(multerMw: RequestHandler): RequestHandler {
  const upload = keepRequestContext(multerMw);
  return (req, res, next) => {
    upload(req, res, (err?: unknown) => {
      if (err) return next(err);
      const ctx = syncContext();
      if (!ctx?.commandId || (ctx.mode !== 'record' && ctx.mode !== 'replay' && ctx.mode !== 'rebase')) return next();
      const slug = slugOf();
      const files: CommandFile[] = [];
      uploadedFiles(req).forEach((f, i) => {
        const bytes = f.buffer ?? fs.readFileSync(f.path);
        files.push({ field: f.fieldname, name: f.originalname, type: f.mimetype, hash: storeBlob(slug, bytes) });
        if (f.path) {
          // Named after the command: the same name on the PC and on the authority's replay.
          // (A multer name that starts with a timestamp differs per run, so it can't be the prefix.)
          const head = path.basename(f.filename).split('-')[0] ?? '';
          const prefix = head && !/^\d+$/.test(head) ? head : 'file';
          const name = `${prefix}-${ctx.commandId!.toLowerCase()}-${i}${path.extname(f.filename)}`;
          const target = path.join(path.dirname(f.path), name);
          if (target !== f.path) {
            fs.renameSync(f.path, target);
            f.path = target;
            f.filename = name;
          }
        }
      });
      (req as WithSyncFiles).syncFiles = files;
      next();
    });
  };
}

/**
 * Files a route itself hands to the command it is recording, in place of the raw uploads: the
 * anonymous channel passes its metadata-stripped photos, so the original bytes are never stored
 * or sent (§25). Only while a command is being recorded; a re-run already carries its files.
 */
export function attachCommandFiles(req: Request, files: Array<{ field: string; name: string; type: string; bytes: Buffer }>): void {
  const ctx = syncContext();
  if (!ctx?.commandId || ctx.mode !== 'record') return;
  const slug = slugOf();
  (req as WithSyncFiles).syncFiles = files.map((f) => ({ field: f.field, name: f.name, type: f.type, hash: storeBlob(slug, f.bytes) }));
}

/** The body a command records: plain JSON, or — with uploads — fields plus file references. */
export function commandBody(req: Request): string {
  const files = (req as WithSyncFiles).syncFiles;
  if (!files?.length) return JSON.stringify(req.body ?? {});
  return JSON.stringify({ __multipart: 1, fields: req.body ?? {}, files });
}

export interface MultipartBody {
  __multipart: 1;
  fields: Record<string, unknown>;
  files: CommandFile[];
}

export function parseMultipart(body: string): MultipartBody | null {
  try {
    const v = JSON.parse(body) as Partial<MultipartBody>;
    return v && v.__multipart === 1 && Array.isArray(v.files) ? (v as MultipartBody) : null;
  } catch {
    return null;
  }
}

/** Rebuild the multipart request of a recorded command from this copy's blob store. */
export function multipartForm(slug: string, m: MultipartBody): FormData {
  const form = new FormData();
  for (const [k, v] of Object.entries(m.fields)) {
    for (const item of Array.isArray(v) ? v : [v]) form.append(k, typeof item === 'string' ? item : JSON.stringify(item));
  }
  for (const f of m.files) {
    const file = blobPath(slug, f.hash);
    if (!fs.existsSync(file)) throw new Error(`File ${f.hash} of this command has not arrived yet.`);
    form.append(f.field, new Blob([fs.readFileSync(file)], { type: f.type }), f.name);
  }
  return form;
}

/** Blob hashes the given commands need on their authority. */
export function blobsOf(commands: Array<{ body: string }>): string[] {
  const out = new Set<string>();
  for (const c of commands) for (const f of parseMultipart(c.body)?.files ?? []) out.add(f.hash);
  return [...out];
}

// ---- the authority's file list ----

const lastScan = new WeakMap<DatabaseSync, number>();

/** Bring the file list up to date with the uploads folder (at most every few seconds). */
export function indexFiles(conn: DatabaseSync, slug: string, force = false): void {
  const now = Date.now();
  if (!force && now - (lastScan.get(conn) ?? 0) < 5000) return;
  lastScan.set(conn, now);
  const root = uploadDir(slug);
  const known = new Set((conn.prepare('SELECT name FROM sync_files').all() as Array<{ name: string }>).map((r) => r.name));
  const add = conn.prepare('INSERT OR IGNORE INTO sync_files (name, size) VALUES (?, ?)');
  const scan = (dir: string, prefix: string) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isFile() || e.name.startsWith('.')) continue;
      const name = prefix + e.name;
      if (!known.has(name)) add.run(name, fs.statSync(path.join(dir, e.name)).size);
    }
  };
  scan(root, '');
  for (const sub of FILE_SUBDIRS) scan(path.join(root, sub), `${sub}/`);
  // With a file bucket, files the server's disk cache dropped are listed too (GET /files/:seq
  // fetches them back).
  for (const f of bucketOnly(root)) if (!known.has(f.name)) add.run(f.name, f.size);
}

/** Register a file this copy just received (a host passes what it fetched on to its LAN). */
export function registerFile(conn: DatabaseSync, name: string, size: number): void {
  conn.prepare('INSERT OR IGNORE INTO sync_files (name, size) VALUES (?, ?)').run(name, size);
}

/** Where a listed file lives, refusing anything that would leave the uploads folder. */
export function filePath(slug: string, name: string): string | null {
  if (name.includes('\\') || name.split('/').some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) return null;
  const root = path.resolve(uploadDir(slug));
  const full = path.resolve(root, name);
  return full.startsWith(root + path.sep) ? full : null;
}

// ---- endpoints ----

export function fileRoutes(nodeAuth: RequestHandler): Router {
  const router = Router();
  const authorityOnly = (_req: Request, res: Response, next: NextFunction) => {
    if (!isAuthority(syncConfigOf(activeDb()))) {
      res.status(404).json({ error: 'Not a sync authority.' });
      return;
    }
    next();
  };

  router.put('/blobs/:hash', nodeAuth, authorityOnly,
    express.raw({ type: () => true, limit: MAX_BLOB_BYTES }), (req, res) => {
      const hash = String(req.params.hash);
      const body = req.body as Buffer;
      if (!isHash(hash) || !Buffer.isBuffer(body)) {
        res.status(400).json({ error: 'Bad blob' });
        return;
      }
      if (crypto.createHash('sha256').update(body).digest('hex') !== hash) {
        res.status(400).json({ error: 'The file does not match its hash.' });
        return;
      }
      storeBlob(slugOf(), body);
      res.json({ ok: true });
    });

  router.get('/files', nodeAuth, authorityOnly, (req, res) => {
    const conn = activeDb();
    indexFiles(conn, slugOf());
    const since = Math.max(0, Number(req.query.since) || 0);
    res.json(conn.prepare('SELECT seq, name, size FROM sync_files WHERE seq > ? ORDER BY seq LIMIT 500').all(since));
  });

  router.get('/files/:seq', nodeAuth, authorityOnly, async (req, res) => {
    const row = activeDb().prepare('SELECT name FROM sync_files WHERE seq = ?').get(Number(req.params.seq)) as { name: string } | undefined;
    const full = row ? filePath(slugOf(), row.name) : null;
    if (!full || !(await withTenant(slugOf(), () => resolveDurableUploadAsync(row!.name)))) {
      res.status(404).json({ error: 'No such file' });
      return;
    }
    res.sendFile(full);
  });

  return router;
}
