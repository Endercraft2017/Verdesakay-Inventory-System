import { pruneCreationReceipts } from './src/platform/onboarding-receipts';
import {processOneExport} from './src/modules/quickbooks/export-jobs';
import { requireProductionTransport } from './src/shared/hosting';
/** Server entry point: initialize the database, then start listening.
 *
 * Serves over HTTPS so the mobile app's camera (QR scanning) works — browsers only
 * allow getUserMedia on a secure origin. A self-signed certificate is generated on
 * first run (via `openssl`); if that isn't possible the server falls back to plain
 * HTTP and the camera scanner degrades to manual code entry. */
import os from 'node:os';
import { verifyPassword } from './src/shared/password-hash';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { spawnSync } from 'node:child_process';
import { init, cleanupSessions, getDb, DB_PATH, withTenant } from './src/shared/db';
import { snapshotTenantUsage } from './src/platform/owner-analytics';
import { retiredDefaultTenant, listTenants } from './src/platform/platform';
import { createApp, BEHIND_PROXY } from './src/app';
import { sendDueTaskReminders } from './src/shared/push';
import { cleanupPlatformSessions } from './src/platform/platform-users';
import { attachWebSocket } from './src/shared/ws';
import { runDailyBackups, runHourlyBackups } from './src/platform/backups';
import { pushOffsite } from './src/platform/offsite';
import { backupHealthTick } from './src/platform/backup-health';
import { startFileStore } from './src/shared/file-store';
import { offloadAllDatabaseCopies } from './src/platform/upload-offload';
import { DEPLOY_MODE, startSyncLoop, syncConfigOf } from './src/sync';
import { roleChange } from './src/sync/failover';
import { startSiteElection } from './src/sync/site-election';
import { ensureLanTls, lanAddresses } from './src/desktop/lan-tls';
import { phoneSetupHandler } from './src/desktop/phone-setup';

// Attendance, payroll dates and the kiosk rules use the server's local time (see
// src/modules/hr/clock.ts localParts and SQLite 'localtime'). On-site that is the office clock;
// a cloud host runs on UTC, which would silently date punches 8 hours off. TZ must be set in
// the environment before the process starts (SQLite does not pick up a runtime change).
if (BEHIND_PROXY && !process.env.TZ) {
  console.error('\nRefusing to start: set the TZ variable to the office time zone (e.g. TZ=Asia/Manila).\n' +
    'Cloud servers run on UTC, which would record attendance and payroll dates on the wrong day.\n');
  process.exit(1);
}

const retired = DEPLOY_MODE === 'cloud' ? retiredDefaultTenant() : null;
if (retired) getDb(retired); else init();
const backgroundTenants = () => DEPLOY_MODE === 'cloud'
  ? [...(retired ? [] : ['default']), ...listTenants().filter(t => t.status === 'active' || t.status === 'trial' || t.status === 'past_due').map(t => t.slug)]
  : ['default'];
if (process.env.NODE_ENV === 'production') {
  for (const slug of backgroundTenants()) withTenant(slug, () => {
    const admin = getDb(slug).prepare("SELECT password_hash FROM users WHERE username = 'admin' AND active = 1").get() as { password_hash: string } | undefined;
    if (admin && verifyPassword('admin123', admin.password_hash)) {
      throw new Error(`Refusing production startup: change the default administrator password for ${slug}.`);
    }
  });
}

// One global sequential pass: bounded provider concurrency and no overlapping timer passes.
let exportPassRunning=false;
async function exportPass(){
  if(DEPLOY_MODE!=='cloud'||exportPassRunning)return;
  exportPassRunning=true;
  try {for(const slug of backgroundTenants()){
    try {await withTenant(slug,processOneExport);}
    catch {console.error('[qbo] export worker failed; inspect durable job state');}
  }} finally {exportPassRunning=false;}
}
if(DEPLOY_MODE==='cloud'){
  setInterval(()=>{void exportPass();},15_000).unref();
  setImmediate(()=>{void exportPass();});
}

const housekeeping = () => {
  for (const slug of backgroundTenants()) withTenant(slug, cleanupSessions);
  cleanupPlatformSessions();
  pruneCreationReceipts();
};
const usageSnapshots = () => {
  if (DEPLOY_MODE !== 'cloud') return;
  for (const t of listTenants().filter(t => t.status !== 'purged')) {
    try { snapshotTenantUsage(t.slug); } catch (e) { console.error('[analytics] snapshot failed:', t.slug, (e as Error).message); }
  }
};
usageSnapshots();
setInterval(usageSnapshots, 60 * 60 * 1000).unref();
housekeeping(); // sweep stale sessions / old audit-log rows once at boot, then hourly
setInterval(housekeeping, 60 * 60 * 1000).unref(); // hourly
// Push reminders are an outside side effect: only the cloud sends them (OFFLINE-FIRST §7.8).
if (DEPLOY_MODE === 'cloud') setInterval(() => {
  for (const slug of backgroundTenants()) {
    void withTenant(slug, sendDueTaskReminders).catch(e => console.error(`[push] reminders failed for ${slug}: ${(e as Error).message}`));
  }
}, 60 * 1000).unref();
// An installed PC syncs with its cloud in the background (docs/OFFLINE-FIRST.md §12).
if (DEPLOY_MODE === 'node') {
  startSyncLoop('default');
  // Sites with 3+ voting PCs elect a new host by themselves when theirs is lost (§31).
  startSiteElection('default');
}
// DB snapshots: at boot, then hourly — today's daily once the date rolls over (a no-op for
// any DB that already has one) and this hour's snapshot of every DB that changed since the
// last one. Never let a backup error crash the server.
const dailyBackup = () => {
  try { runDailyBackups(); } catch (e) { console.error(`[backup] daily run failed: ${(e as Error).message}`); }
  try { runHourlyBackups(); } catch (e) { console.error(`[backup] hourly run failed: ${(e as Error).message}`); }
  // Then copy anything new (or previously failed) to the off-site buckets, if configured, and
  // check the result: restore drill when due, alert on failures (src/platform/backup-health.ts).
  void pushOffsite().catch(() => [] as unknown[]).then(() => backupHealthTick());
};
dailyBackup();
setInterval(dailyBackup, 60 * 60 * 1000).unref();
// With a bucket configured (FILES_S3_*), uploads live there and the disk is a cache.
startFileStore(offloadAllDatabaseCopies);

const app = createApp();
const PORT = Number(process.env.PORT) || 3000;
const HTTP_PORT = PORT + 1; // plain-HTTP listener that redirects to HTTPS

const CERT_DIR = path.join(import.meta.dirname, 'certs');
const KEY_FILE = path.join(CERT_DIR, 'key.pem');
const CERT_FILE = path.join(CERT_DIR, 'cert.pem');

/** IPv4 addresses of this machine on the LAN (for the banner and the cert's SAN list). */
function lanIps(): string[] {
  const out: string[] = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

/** Ensure certs/key.pem + certs/cert.pem exist, generating a self-signed pair with
 *  openssl if needed. Returns the loaded credentials, or null if HTTPS isn't possible. */
function loadOrCreateCert(): { key: Buffer; cert: Buffer } | null {
  if (!fs.existsSync(KEY_FILE) || !fs.existsSync(CERT_FILE)) {
    try {
      fs.mkdirSync(CERT_DIR, { recursive: true });
      const sans = ['DNS:localhost', 'IP:127.0.0.1', ...lanIps().map((ip) => `IP:${ip}`)];
      const res = spawnSync(
        'openssl',
        [
          'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3650',
          '-keyout', KEY_FILE, '-out', CERT_FILE,
          '-subj', '/CN=Otom',
          '-addext', `subjectAltName=${sans.join(',')}`,
        ],
        { stdio: 'ignore' }
      );
      if (res.status !== 0) throw new Error(`openssl exited ${res.status ?? '(not found)'}`);
      console.log('Generated a self-signed certificate under certs/.');
    } catch (e) {
      console.warn(
        `\nCould not generate an HTTPS certificate (${(e as Error).message}).` +
        '\nFalling back to plain HTTP — the mobile QR scanner will need manual code entry.' +
        '\nInstall openssl (or drop your own certs/key.pem + certs/cert.pem) to enable HTTPS.\n'
      );
      return null;
    }
  }
  try {
    return { key: fs.readFileSync(KEY_FILE), cert: fs.readFileSync(CERT_FILE) };
  } catch {
    return null;
  }
}

function banner(scheme: string): void {
  console.log(`\nOtom is running (${scheme.toUpperCase()}):`);
  console.log(`   Local:   ${scheme}://localhost:${PORT}`);
  for (const ip of lanIps()) {
    console.log(`   Network: ${scheme}://${ip}:${PORT}  (for other office devices)`);
  }
  if (scheme === 'https') {
    console.log(`   (plain http://…:${HTTP_PORT} redirects here; accept the certificate warning once per device)`);
  }
  console.log('');
}

// An installed PC (DEPLOY_MODE=node, docs/OFFLINE-FIRST.md §17). A site host serves its LAN —
// phones included — over HTTPS with its own site certificate (D5), and the phone-setup page on
// plain HTTP; any other installed PC serves only itself, on this machine.
/** Exit code that asks the desktop app to restart the server: this PC changed role (it took over
 *  as its site's host, or stepped down — docs/OFFLINE-FIRST.md §30). */
export const ROLE_CHANGE_EXIT = 75;

function startInstalledPc(): void {
  const conn = getDb();
  // Where the site's PCs can reach this one on the LAN — needed if it ever takes over as host.
  const ip = lanAddresses()[0];
  if (ip && syncConfigOf(conn)) conn.prepare('UPDATE sync_node SET lan_url = ? WHERE k = 1').run(`https://${ip}:${PORT}`);
  roleChange.onChange = (isHost) => {
    console.log(`[sync] this PC is now ${isHost ? 'the site host' : 'an ordinary PC of its site'}; restarting`);
    // The desktop app reads this to restart the server in the new role (electron/main.cjs).
    fs.writeFileSync(path.join(path.dirname(DB_PATH), 'desktop-role.json'), JSON.stringify({ isHost }));
    setTimeout(() => process.exit(ROLE_CHANGE_EXIT), 500).unref(); // let the response go out first
  };
  const isHost = syncConfigOf(conn)?.isHost === true;
  if (!isHost) {
    const local = http.createServer(app).listen(PORT, '127.0.0.1', () => {
      console.log(`\nVerdesakay (installed PC) is running for this PC only: http://localhost:${PORT}\n`);
    });
    attachWebSocket(local);
    return;
  }
  const tls = ensureLanTls(process.env.LAN_TLS_DIR || path.join(path.dirname(DB_PATH), 'tls'));
  const lan = https.createServer({ key: tls.key, cert: tls.cert }, app).listen(PORT, '0.0.0.0', () => {
    console.log(`\nVerdesakay site host is running: https://localhost:${PORT}`);
    for (const ip of lanAddresses()) {
      console.log(`   Office devices: https://${ip}:${PORT}   ·   set up a phone: http://${ip}:${HTTP_PORT}`);
    }
    console.log('');
  });
  attachWebSocket(lan);
  http.createServer(phoneSetupHandler({ caCert: tls.caCert, fingerprint: tls.caFingerprint, httpsPort: PORT }))
    .listen(HTTP_PORT, '0.0.0.0');
}

if (DEPLOY_MODE === 'node') {
  startInstalledPc();
} else {
  // Behind a TLS-terminating proxy (e.g. Railway) the proxy owns HTTPS and forwards plain
  // HTTP to PORT — serving our own self-signed cert there would break every request.
  const creds = BEHIND_PROXY ? null : loadOrCreateCert();
  requireProductionTransport(!!creds);

  if (creds) {
    const httpsServer = https.createServer(creds, app).listen(PORT, '0.0.0.0', () => banner('https'));
    attachWebSocket(httpsServer);

    // Redirect any plain-HTTP request to the HTTPS origin on the canonical port.
    http
      .createServer((req, res) => {
        const host = (req.headers.host || `localhost:${HTTP_PORT}`).replace(/:\d+$/, '');
        res.writeHead(301, { Location: `https://${host}:${PORT}${req.url || '/'}` });
        res.end();
      })
      .listen(HTTP_PORT, '0.0.0.0');
  } else {
    const httpServer = http.createServer(app).listen(PORT, '0.0.0.0', () => banner('http'));
    attachWebSocket(httpServer);
  }
}
