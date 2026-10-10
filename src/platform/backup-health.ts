/**
 * Backup health: proves the off-site copies can actually be restored, and tells the operator when
 * any backup step fails or goes stale. Called after every hourly backup check (server.ts) and by
 * `npm run backup:drill` / `npm run backup:health`.
 *
 *  - Restore drill: for every off-site target, download the newest snapshot of every database,
 *    decrypt it into a temp file, run SQLite's integrity check, then delete it. Runs every
 *    BACKUP_DRILL_DAYS (default 30) days, and again the next day after a failed drill.
 *  - Health check: the last daily run or off-site run failed, a database has no daily snapshot in
 *    BACKUP_STALE_HOURS (default 26), no off-site success in that time, or the drill failed.
 *  - Alerts: problems are POSTed to BACKUP_ALERT_WEBHOOK (ntfy, Discord, Slack / Google Chat
 *    style) once, repeated every BACKUP_ALERT_REPEAT_HOURS (default 12) while unresolved, plus one
 *    "recovered" message. Every result is also kept in status.json for the owner console.
 */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { backupDir } from '../shared/backup';
import { offsiteTargets, unpack, type OffsiteTarget } from './offsite';
import { backupNames } from './backups';

export interface DrillResult { target: string; name: string; key: string | null; ok: boolean; tables?: number; error?: string }
export interface DrillRun { at: string; ok: boolean; results: DrillResult[] }
interface HealthState { at: string; ok: boolean; problems: string[]; alerted_at?: string; alerted_key?: string }

const hours = (name: string, fallback: number) => Math.max(1, Number(process.env[name]) || fallback);

function statusFile(): string { return path.join(backupDir(), 'status.json'); }

function readStatus(): Record<string, unknown> {
  try { return JSON.parse(fs.readFileSync(statusFile(), 'utf8')) as Record<string, unknown>; } catch { return {}; }
}

function writeStatus(patch: Record<string, unknown>): void {
  try {
    fs.mkdirSync(path.dirname(statusFile()), { recursive: true });
    fs.writeFileSync(statusFile(), JSON.stringify({ ...readStatus(), ...patch }, null, 2));
  } catch { /* informational only */ }
}

/** The last restore drill, or null if none has run. */
export function lastDrill(): DrillRun | null {
  return (readStatus().restore_drill as DrillRun | undefined) ?? null;
}

/** Restore one off-site object into a temp file and check it opens clean. */
async function drillOne(t: OffsiteTarget, name: string, key: string): Promise<DrillResult> {
  const tmp = path.join(os.tmpdir(), `vds-drill-${crypto.randomBytes(6).toString('hex')}.db`);
  try {
    fs.writeFileSync(tmp, unpack(await t.client.get(key)));
    const conn = new DatabaseSync(tmp, { readOnly: true });
    try {
      const verdict = String(Object.values(conn.prepare('PRAGMA integrity_check').get() ?? {})[0]);
      const tables = Number((conn.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number }).n);
      if (verdict !== 'ok') return { target: t.name, name, key, ok: false, tables, error: `integrity check: ${verdict}` };
      if (!tables) return { target: t.name, name, key, ok: false, tables, error: 'the restored database is empty' };
      return { target: t.name, name, key, ok: true, tables };
    } finally { conn.close(); }
  } catch (e) {
    return { target: t.name, name, key, ok: false, error: (e as Error).message };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Download, decrypt and check the newest off-site snapshot of every database on every target. */
export async function runRestoreDrill(now = new Date()): Promise<DrillRun> {
  const results: DrillResult[] = [];
  for (const t of offsiteTargets()) {
    for (const name of backupNames()) {
      try {
        const objects = await t.client.list(`db/${name}/`);
        const newest = objects.map((o) => o.key).filter((k) => k.endsWith('.db.gz.enc')).sort().pop();
        results.push(newest
          ? await drillOne(t, name, newest)
          : { target: t.name, name, key: null, ok: false, error: 'no off-site snapshot found' });
      } catch (e) {
        results.push({ target: t.name, name, key: null, ok: false, error: (e as Error).message });
      }
    }
  }
  const run: DrillRun = { at: now.toISOString(), ok: results.length > 0 && results.every((r) => r.ok), results };
  writeStatus({ restore_drill: run });
  return run;
}

/** A drill is due every BACKUP_DRILL_DAYS, or a day after a failed one; never without a target. */
export function drillDue(now = new Date()): boolean {
  if (!offsiteTargets().length) return false;
  const last = lastDrill();
  if (!last) return true;
  const ageMs = now.getTime() - Date.parse(last.at);
  return ageMs >= (last.ok ? hours('BACKUP_DRILL_DAYS', 30) * 24 : 24) * 3_600_000;
}

/** Newest daily snapshot time for one backup name, or null. */
function newestDaily(name: string): number | null {
  const dir = path.join(backupDir(), name, 'daily');
  if (!fs.existsSync(dir)) return null;
  let newest: number | null = null;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.db')) continue;
    const t = fs.statSync(path.join(dir, f)).mtimeMs;
    if (newest === null || t > newest) newest = t;
  }
  return newest;
}

/** Everything wrong with the backups right now, in plain sentences (empty = healthy). */
export function backupProblems(now = new Date()): string[] {
  const status = readStatus() as {
    last_run?: { kind?: string; results?: Array<{ name: string; ok: boolean; error?: string; mirrorError?: string }> };
    offsite?: { last_run?: { ok: boolean; results?: Array<{ target: string; ok: boolean; error?: string }> }; last_success_at?: string };
    restore_drill?: DrillRun;
  };
  const problems: string[] = [];
  const staleMs = hours('BACKUP_STALE_HOURS', 26) * 3_600_000;

  for (const r of status.last_run?.results ?? []) {
    if (!r.ok) problems.push(`Snapshot of "${r.name}" failed: ${r.error ?? 'unknown error'}`);
    else if (r.mirrorError) problems.push(`Snapshot of "${r.name}" was not mirrored: ${r.mirrorError}`);
  }
  for (const name of backupNames()) {
    const t = newestDaily(name);
    if (t === null || now.getTime() - t > staleMs) {
      problems.push(`"${name}" has no daily snapshot in the last ${Math.round(staleMs / 3_600_000)} hours`);
    }
  }
  if (offsiteTargets().length) {
    for (const r of status.offsite?.last_run?.results ?? []) {
      if (!r.ok) problems.push(`Off-site copy to "${r.target}" failed: ${r.error ?? 'unknown error'}`);
    }
    const lastOk = status.offsite?.last_success_at ? Date.parse(status.offsite.last_success_at) : null;
    if (lastOk === null || now.getTime() - lastOk > staleMs) {
      problems.push(`No successful off-site copy in the last ${Math.round(staleMs / 3_600_000)} hours`);
    }
  }
  const drill = status.restore_drill;
  if (drill && !drill.ok) {
    const bad = drill.results.filter((r) => !r.ok).map((r) => `${r.target}/${r.name}: ${r.error}`);
    problems.push(`Restore drill failed (${drill.at.slice(0, 10)}): ${bad.join('; ') || 'no databases checked'}`);
  }
  return problems;
}

/** POST a message to BACKUP_ALERT_WEBHOOK in the shape its service expects. False if not sent. */
export async function sendBackupAlert(title: string, message: string, urgent: boolean): Promise<boolean> {
  const url = process.env.BACKUP_ALERT_WEBHOOK;
  if (!url) return false;
  let host = '';
  try { host = new URL(url).hostname; } catch { return false; }
  const text = `${title}\n${message}`.slice(0, 1900);
  const init: RequestInit = host.startsWith('ntfy.') || host.includes('.ntfy.')
    ? { headers: { Title: title, Priority: urgent ? 'high' : 'default', Tags: urgent ? 'warning' : 'white_check_mark' }, body: message.slice(0, 3900) }
    : /(^|\.)discord(app)?\.com$/.test(host)
      ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: text }) }
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) };
  try {
    const res = await fetch(url, { ...init, method: 'POST', signal: AbortSignal.timeout(10_000) });
    if (!res.ok) console.error(`[backup] alert webhook answered ${res.status}`);
    return res.ok;
  } catch (e) {
    console.error(`[backup] alert webhook failed: ${(e as Error).message}`);
    return false;
  }
}

/** Check health, record it, and alert on new / still-open problems and on recovery. */
export async function checkBackupHealth(now = new Date()): Promise<HealthState> {
  const problems = backupProblems(now);
  const prev = (readStatus().health as HealthState | undefined) ?? null;
  const where = process.env.TENANT_PATH_HOST || process.env.APP_DOMAIN || os.hostname();
  const state: HealthState = { at: now.toISOString(), ok: problems.length === 0, problems };
  const key = problems.join('\n');
  if (problems.length) {
    for (const p of problems) console.error(`[backup] PROBLEM: ${p}`);
    const repeatMs = hours('BACKUP_ALERT_REPEAT_HOURS', 12) * 3_600_000;
    const alertedRecently = !!prev && prev.alerted_key === key && !!prev.alerted_at
      && now.getTime() - Date.parse(prev.alerted_at) < repeatMs;
    if (alertedRecently) {
      state.alerted_at = prev!.alerted_at;
      state.alerted_key = prev!.alerted_key;
    } else if (await sendBackupAlert(`Backup problem on ${where}`, problems.map((p) => `• ${p}`).join('\n'), true)) {
      state.alerted_at = now.toISOString();
      state.alerted_key = key;
    }
  } else if (prev && !prev.ok && prev.alerted_at) {
    await sendBackupAlert(`Backups recovered on ${where}`, 'All snapshots, off-site copies and the last restore drill are healthy again.', false);
  }
  writeStatus({ health: state });
  return state;
}

/** The hourly step after the backup run: a drill when one is due, then the health check. */
export async function backupHealthTick(now = new Date()): Promise<void> {
  try {
    if (drillDue(now)) {
      const drill = await runRestoreDrill(now);
      console.log(`[backup] restore drill ${drill.ok ? 'passed' : 'FAILED'}: ${drill.results.length} database copy(ies) checked`);
    }
    await checkBackupHealth(now);
  } catch (e) {
    console.error(`[backup] health check failed: ${(e as Error).message}`);
  }
}
