/**
 * The desktop installer download (docs/OFFLINE-FIRST.md §17), mounted at /api/desktop.
 * **Work in progress:** nothing is published yet — the button shows as "coming soon" until an
 * installer is placed in DESKTOP_INSTALLER_DIR (the newest `*.exe` there is served). Admin-only
 * (`users.manage`): setting up a PC is an admin's job.
 *
 *   GET /installer/info   { available: false } or { available: true, file, size, built_at }
 *   GET /installer        the installer itself (404 while unpublished)
 */
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { requireAuth, requirePermission } from '../shared/auth';

const router = Router();
router.use(requireAuth, requirePermission('users.manage'));

/** The newest installer in DESKTOP_INSTALLER_DIR, or null when none is published. */
export function publishedInstaller(dir = process.env.DESKTOP_INSTALLER_DIR): { file: string; size: number; mtime: Date } | null {
  if (!dir || !fs.existsSync(dir)) return null;
  const exes = fs.readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.exe'))
    .map((f) => ({ file: path.join(dir, f), stat: fs.statSync(path.join(dir, f)) }))
    .filter((e) => e.stat.isFile())
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  const top = exes[0];
  return top ? { file: top.file, size: top.stat.size, mtime: top.stat.mtime } : null;
}

router.get('/installer/info', (_req, res) => {
  const inst = publishedInstaller();
  if (!inst) {
    res.json({ available: false });
    return;
  }
  res.json({ available: true, file: path.basename(inst.file), size: inst.size, built_at: inst.mtime.toISOString() });
});

router.get('/installer', (_req, res) => {
  const inst = publishedInstaller();
  if (!inst) {
    res.status(404).json({ error: 'The desktop app is not published yet.' });
    return;
  }
  res.download(inst.file, path.basename(inst.file));
});

export default router;
