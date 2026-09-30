/** Server entry point: initialize the database, then start listening.
 *
 * Serves over HTTPS so the mobile app's camera (QR scanning) works — browsers only
 * allow getUserMedia on a secure origin. A self-signed certificate is generated on
 * first run (via `openssl`); if that isn't possible the server falls back to plain
 * HTTP and the camera scanner degrades to manual code entry. */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { spawnSync } from 'node:child_process';
import { init, cleanupSessions } from './src/shared/db';
import { createApp, BEHIND_PROXY } from './src/app';
import { sendDueTaskReminders } from './src/shared/push';
import { cleanupPlatformSessions } from './src/platform/platform-users';
import { attachWebSocket } from './src/shared/ws';
import { runDailyBackups } from './src/platform/backups';
import { pushOffsite } from './src/platform/offsite';
import { DEPLOY_MODE } from './src/sync';

// Attendance, payroll dates and the kiosk rules use the server's local time (see
// src/modules/hr/clock.ts localParts and SQLite 'localtime'). On-site that is the office clock;
// a cloud host runs on UTC, which would silently date punches 8 hours off. TZ must be set in
// the environment before the process starts (SQLite does not pick up a runtime change).
if (BEHIND_PROXY && !process.env.TZ) {
  console.error('\nRefusing to start: set the TZ variable to the office time zone (e.g. TZ=Asia/Manila).\n' +
    'Cloud servers run on UTC, which would record attendance and payroll dates on the wrong day.\n');
  process.exit(1);
}

init();
const housekeeping = () => { cleanupSessions(); cleanupPlatformSessions(); };
housekeeping(); // sweep stale sessions / old audit-log rows once at boot, then hourly
setInterval(housekeeping, 60 * 60 * 1000).unref(); // hourly
// Push reminders are an outside side effect: only the cloud sends them (OFFLINE-FIRST §7.8).
if (DEPLOY_MODE === 'cloud') setInterval(() => { void sendDueTaskReminders(); }, 60 * 1000).unref();
// Daily DB snapshots: at boot, then an hourly check that takes today's once the date rolls
// over (a no-op for any DB that already has one). Never let a backup error crash the server.
const dailyBackup = () => {
  try { runDailyBackups(); } catch (e) { console.error(`[backup] daily run failed: ${(e as Error).message}`); }
  // Then copy anything new (or previously failed) to the off-site buckets, if configured.
  void pushOffsite();
};
dailyBackup();
setInterval(dailyBackup, 60 * 60 * 1000).unref();

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
          '-subj', '/CN=Verdesakay Office System',
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
  console.log(`\nVerdesakay Office System is running (${scheme.toUpperCase()}):`);
  console.log(`   Local:   ${scheme}://localhost:${PORT}`);
  for (const ip of lanIps()) {
    console.log(`   Network: ${scheme}://${ip}:${PORT}  (for other office devices)`);
  }
  if (scheme === 'https') {
    console.log(`   (plain http://…:${HTTP_PORT} redirects here; accept the certificate warning once per device)`);
  }
  console.log('');
}

// Behind a TLS-terminating proxy (e.g. Railway) the proxy owns HTTPS and forwards plain
// HTTP to PORT — serving our own self-signed cert there would break every request.
const creds = BEHIND_PROXY ? null : loadOrCreateCert();

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
