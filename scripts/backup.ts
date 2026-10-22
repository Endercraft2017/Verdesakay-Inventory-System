/**
 * Backup CLI — see src/platform/backups.ts.
 *
 *   npm run backup                                    snapshot every DB + uploads now
 *   npm run backup:list                               list snapshots on disk
 *   npm run backup:restore -- <name> <file> --yes     restore one DB (STOP THE SERVER FIRST)
 *   npm run backup:drill                              restore every off-site copy into a temp file + check it
 *   npm run backup:health                             list backup problems; alerts BACKUP_ALERT_WEBHOOK if any
 *   npm run backup:health -- --test-alert             send a test message to BACKUP_ALERT_WEBHOOK
 *
 * <name> is `default` (data.db), a tenant slug, or `_platform` (platform.db).
 */
import { runManualBackup, listBackups, restoreBackup, liveFileFor } from '../src/platform/backups';
import { runRestoreDrill, checkBackupHealth, sendBackupAlert } from '../src/platform/backup-health';
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
} else if (cmd === 'drill') {
  const run = await runRestoreDrill();
  if (!run.results.length) console.log('No off-site target is configured (BACKUP_S3_<NAME>_*), so there is nothing to drill.');
  for (const r of run.results) {
    if (r.ok) console.log(`  ✓ ${r.target}: ${r.key} restored, integrity ok, ${r.tables} tables`);
    else console.error(`  ✗ ${r.target}/${r.name}: ${r.error}`);
  }
  process.exit(run.ok ? 0 : 1);
} else if (cmd === 'health') {
  if (args.includes('--test-alert')) {
    const sent = await sendBackupAlert('Test alert from Verdesakay backups', 'If you can read this, backup alerts reach you.', false);
    console.log(sent ? 'Test alert sent.' : 'Not sent — set BACKUP_ALERT_WEBHOOK (see docs/DEPLOY-RAILWAY.md Part 5).');
    process.exit(sent ? 0 : 1);
  }
  const state = await checkBackupHealth();
  console.log(state.ok ? 'Backups are healthy.' : state.problems.map((p) => `  ✗ ${p}`).join('\n'));
  process.exit(state.ok ? 0 : 1);
} else {
  console.error(`Unknown command "${cmd}". Use: now | list | restore | drill | health`);
  process.exit(2);
}
