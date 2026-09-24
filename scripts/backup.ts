/**
 * Backup CLI — see src/platform/backups.ts.
 *
 *   npm run backup                                    snapshot every DB + uploads now
 *   npm run backup:list                               list snapshots on disk
 *   npm run backup:restore -- <name> <file> --yes     restore one DB (STOP THE SERVER FIRST)
 *
 * <name> is `default` (data.db), a tenant slug, or `_platform` (platform.db).
 */
import { runManualBackup, listBackups, restoreBackup, liveFileFor } from '../src/platform/backups';
import { backupDir } from '../src/shared/backup';

const [cmd = 'now', ...args] = process.argv.slice(2);

function mb(n: number): string { return `${(n / 1024 / 1024).toFixed(2)} MB`; }

if (cmd === 'now') {
  console.log(`Backing up to ${backupDir()} …`);
  const results = runManualBackup();
  for (const r of results) {
    if (!r.ok) console.error(`  ✗ ${r.name}: ${r.error}`);
    else if (r.name === 'uploads') console.log(`  ✓ uploads (${r.copied} new/changed file(s) copied)`);
    else console.log(`  ✓ ${r.name} → ${r.file} (${mb(r.bytes ?? 0)})`);
    if (r.mirrorError) console.error(`    ! not mirrored: ${r.mirrorError}`);
  }
  process.exit(results.every((r) => r.ok) ? 0 : 1);
} else if (cmd === 'list') {
  const files = listBackups();
  if (!files.length) console.log(`No backups under ${backupDir()}`);
  for (const f of files) console.log(`${new Date(f.modified).toLocaleString()}  ${f.name.padEnd(12)} ${f.kind.padEnd(12)} ${mb(f.bytes).padStart(10)}  ${f.file}`);
} else if (cmd === 'restore') {
  const [name, file] = args.filter((a) => !a.startsWith('--'));
  if (!name || !file) {
    console.error('Usage: npm run backup:restore -- <name> <backup-file> --yes');
    process.exit(2);
  }
  if (!args.includes('--yes')) {
    console.error(
      `This REPLACES ${liveFileFor(name)} with\n  ${file}\n` +
      'Stop the server first. The current file is snapshotted to pre-restore/ before it is replaced.\n' +
      'Re-run with --yes to proceed.'
    );
    process.exit(2);
  }
  try {
    const r = restoreBackup(name, file);
    console.log(`Restored ${r.restored}`);
    if (r.safetyCopy) console.log(`Previous version kept at ${r.safetyCopy}`);
    console.log('Start the server again; if the backup is on an older schema it is migrated (and snapshotted) on open.');
  } catch (e) {
    console.error(`Restore failed: ${(e as Error).message}`);
    process.exit(1);
  }
} else {
  console.error(`Unknown command "${cmd}". Use: now | list | restore`);
  process.exit(2);
}
