/* Otom desktop app — the installed, offline-capable PC (docs/OFFLINE-FIRST.md §17, phase 3d).

   This is only a shell. The real app is the same server the cloud runs (server.ts), started as a
   child process on Electron's bundled Node (ELECTRON_RUN_AS_NODE, TypeScript via tsx — proven in
   phase 0) with DEPLOY_MODE=node, and shown in a window.

   First start: a setup screen enrols the PC (scripts/sync-enrol.ts) — as its site's host, or as
   another PC of a site whose host it connects to. A site PC first downloads the host's site
   certificate over plain HTTP, shows its fingerprint to confirm, and pins it
   (NODE_EXTRA_CA_CERTS) so it can talk to the host over HTTPS with no internet.

   Data lives in the per-user app-data folder (no admin rights anywhere — decision D7).
   `--smoke` starts the server on a scratch folder, checks it answers, and exits (CI / packaging). */
const { app, BrowserWindow, ipcMain, shell, Menu, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { AUTOSTART_ARG, loginItemOptions, defaultAutostart } = require('./autostart.cjs');
const { bitlockerQuery, describeBitLocker } = require('./disk.cjs');

const APP_ROOT = path.join(__dirname, '..');
const SMOKE = process.argv.includes('--smoke');
const AUTOSTARTED = process.argv.includes(AUTOSTART_ARG); // started by Windows at sign-in
const DATA = process.env.VDS_DESKTOP_DATA
  || (SMOKE ? fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'vds-smoke-')) : path.join(app.getPath('userData'), 'workspace'));
const PATHS = {
  DB_PATH: path.join(DATA, 'data.db'),
  DATA_DIR: path.join(DATA, 'tenants'),
  UPLOAD_DIR: path.join(DATA, 'uploads'),
  BACKUP_DIR: path.join(DATA, 'backups'),
  LAN_TLS_DIR: path.join(DATA, 'tls'),
};
const CONFIG_FILE = path.join(DATA, 'desktop.json');
const HOST_CA_FILE = path.join(DATA, 'host-ca.crt'); // a site PC: its host's pinned site certificate
const PC_SECRET_FILE = path.join(DATA, 'pc-secret.bin'); // DPAPI-encrypted (safeStorage), §19
const PORT = 3000;

fs.mkdirSync(path.join(DATA, 'logs'), { recursive: true });
const readConfig = () => { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return null; } };

let server = null;
let win = null;

/** This PC's own secret (§19): random, kept on disk only encrypted by Windows DPAPI for this
 *  Windows user (Electron safeStorage), handed to the server process in memory. It seals the
 *  PC's sync credential and its site certificate keys at rest. */
function pcSecret() {
  if (!safeStorage.isEncryptionAvailable()) return null; // no DPAPI: credentials stay as before
  if (fs.existsSync(PC_SECRET_FILE)) return safeStorage.decryptString(fs.readFileSync(PC_SECRET_FILE));
  const s = crypto.randomBytes(32).toString('base64');
  fs.writeFileSync(PC_SECRET_FILE, safeStorage.encryptString(s));
  return s;
}

/** Run a TypeScript entry of the app on Electron's own Node. */
function runNode(script, args, extraEnv) {
  const env = { ...process.env, ...PATHS, ELECTRON_RUN_AS_NODE: '1', ...extraEnv };
  const secret = pcSecret();
  if (secret) env.VDS_PC_SECRET = secret;
  // Trust the site's certificate authority when talking to the site host: pinned at enrolment
  // (a site PC), or the site's own copy (any PC of the site keeps one, §30 — e.g. a former host).
  const siteCa = path.join(PATHS.LAN_TLS_DIR, 'ca.crt');
  if (fs.existsSync(HOST_CA_FILE)) env.NODE_EXTRA_CA_CERTS = HOST_CA_FILE;
  else if (fs.existsSync(siteCa)) env.NODE_EXTRA_CA_CERTS = siteCa;
  return spawn(process.execPath, ['--import', 'tsx', path.join(APP_ROOT, script), ...args], {
    cwd: APP_ROOT, env, windowsHide: true,
  });
}

function logTo(child, file) {
  const out = fs.createWriteStream(path.join(DATA, 'logs', file), { flags: 'a' });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
}

function waitForHealth(url, ms) {
  const lib = url.startsWith('https') ? https : http;
  const until = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = lib.get(url, { rejectUnauthorized: false, timeout: 2000 }, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else retry();
      });
      req.on('error', retry);
      req.on('timeout', () => req.destroy());
    };
    const retry = () => (Date.now() > until ? reject(new Error('The app did not start in time.')) : setTimeout(attempt, 500));
    attempt();
  });
}

/** Exit code of a server that changed role (took over as site host, or stepped down — §30). */
const ROLE_CHANGE_EXIT = 75;
const ROLE_FILE = path.join(DATA, 'desktop-role.json');

async function startServer(isHost) {
  server = runNode('server.ts', [], { DEPLOY_MODE: 'node', PORT: String(PORT) });
  logTo(server, 'server.log');
  server.on('exit', (code) => {
    server = null;
    if (code === ROLE_CHANGE_EXIT && !app.isQuitting) {
      // Restart in the new role: HTTPS for the site's LAN as host, this PC only otherwise.
      let next = !isHost;
      try { next = JSON.parse(fs.readFileSync(ROLE_FILE, 'utf8')).isHost === true; } catch { /* keep the flip */ }
      fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...(readConfig() || {}), isHost: next }));
      startServer(next).then((url) => { if (win) win.loadURL(url); }).catch((e) => {
        require('electron').dialog.showErrorBox('Otom stopped', String(e && e.message || e));
        app.quit();
      });
      return;
    }
    if (!app.isQuitting && !SMOKE) {
      require('electron').dialog.showErrorBox('Otom stopped', `The app stopped (code ${code}). See ${path.join(DATA, 'logs', 'server.log')}.`);
      app.quit();
    }
  });
  const base = `${isHost ? 'https' : 'http'}://localhost:${PORT}`;
  await waitForHealth(`${isHost ? 'https' : 'http'}://127.0.0.1:${PORT}/api/health`, 60_000);
  return base;
}

/* The window trusts the host's own site certificate on this PC (localhost only). */
app.on('certificate-error', (event, _wc, url, _err, certificate, callback) => {
  try {
    const u = new URL(url);
    const ca = fs.readFileSync(path.join(PATHS.LAN_TLS_DIR, 'ca.crt'), 'utf8');
    const norm = (s) => String(s).replace(/\s+/g, '');
    if ((u.hostname === 'localhost' || u.hostname === '127.0.0.1') && certificate.issuerCert
        && norm(certificate.issuerCert.data) === norm(ca)) {
      event.preventDefault();
      callback(true);
      return;
    }
  } catch { /* not ours */ }
  callback(false);
});

/* ---------- open when Windows starts ---------- */

function setAutostart(on) {
  app.setLoginItemSettings(loginItemOptions({
    on, isPackaged: app.isPackaged, execPath: process.execPath, mainScript: path.join(__dirname, 'main.cjs'),
  }));
}
function getAutostart() {
  const o = loginItemOptions({ on: true, isPackaged: app.isPackaged, execPath: process.execPath, mainScript: path.join(__dirname, 'main.cjs') });
  return app.getLoginItemSettings({ path: o.path, args: o.args }).openAtLogin;
}
ipcMain.handle('autostart:get', () => getAutostart());
ipcMain.handle('autostart:set', (_e, on) => { setAutostart(!!on); return getAutostart(); });

function openWindow(url) {
  if (!win) {
    win = new BrowserWindow({
      width: 1400, height: 900, title: 'Otom', show: false,
      webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'preload.cjs') },
    });
    // Started by Windows at sign-in: stay out of the way (minimized) until someone needs it.
    win.once('ready-to-show', () => {
      if (!AUTOSTARTED) return win.show();
      win.showInactive();
      win.minimize();
    });
    win.webContents.setWindowOpenHandler(({ url: target }) => {
      if (!target.startsWith(`http://localhost:${PORT}`) && !target.startsWith(`https://localhost:${PORT}`)) {
        // Only web links go to the default browser: any other scheme (file:, ms-*, custom
        // protocol handlers) could start a program on this PC.
        if (/^https?:\/\//i.test(target)) shell.openExternal(target);
        return { action: 'deny' };
      }
      return { action: 'allow' };
    });
  }
  win.loadURL(url);
}

/* ---------- first-start setup ---------- */

ipcMain.handle('disk-encryption', async () => {
  const drive = path.parse(DATA).root.slice(0, 2); // e.g. "C:"
  const out = await new Promise((resolve) => {
    let text = '';
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', bitlockerQuery(drive)], { windowsHide: true });
    ps.stdout.on('data', (d) => (text += d));
    ps.on('error', () => resolve(''));
    ps.on('exit', () => resolve(text));
  });
  return { drive, state: describeBitLocker(out) };
});

ipcMain.handle('host-certificate', async (_e, hostAddress) => {
  const host = String(hostAddress).trim().replace(/^https?:\/\//, '').replace(/[:/].*$/, '');
  const pem = await new Promise((resolve, reject) => {
    http.get(`http://${host}:${PORT + 1}/site-certificate.crt`, { timeout: 8000 }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => (res.statusCode === 200 ? resolve(body) : reject(new Error(`The host answered ${res.statusCode}.`))));
    }).on('error', () => reject(new Error(`Cannot reach a site host at ${host}. Is its app running?`)));
  });
  const fingerprint = new crypto.X509Certificate(pem).fingerprint256;
  return { host, pem, fingerprint };
});

ipcMain.handle('enrol', async (event, form) => {
  const send = (line) => event.sender.send('enrol-log', line);
  const args = ['--cloud', form.cloudUrl, '--user', form.username, '--name', form.name];
  if (form.role === 'host') args.push('--as-host');
  else {
    fs.writeFileSync(HOST_CA_FILE, form.hostCertificate); // pinned after the person confirmed it
    args.push('--host', `https://${form.hostAddress}:${PORT}`);
  }
  const child = runNode('scripts/sync-enrol.ts', args, { SYNC_ENROL_PASSWORD: form.password });
  logTo(child, 'enrol.log');
  child.stdout.on('data', (d) => send(String(d)));
  child.stderr.on('data', (d) => send(String(d)));
  const code = await new Promise((r) => child.on('exit', r));
  if (code !== 0) {
    if (form.role !== 'host') fs.rmSync(HOST_CA_FILE, { force: true });
    return { ok: false };
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ isHost: form.role === 'host', enrolledAt: new Date().toISOString() }));
  setAutostart(defaultAutostart(form.role)); // the site's main PC starts with Windows by default
  openWindow(await startServer(form.role === 'host'));
  return { ok: true };
});

/* ---------- start ---------- */

if (!SMOKE && !app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('before-quit', () => { app.isQuitting = true; if (server) server.kill(); });
app.on('window-all-closed', () => app.quit());

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  if (SMOKE) {
    try {
      const url = await startServer(false);
      console.log(`SMOKE OK ${url}`);
      app.isQuitting = true;
      server.kill();
      app.exit(0);
    } catch (e) {
      console.error(`SMOKE FAILED ${e.message}`);
      app.exit(1);
    }
    return;
  }
  const cfg = fs.existsSync(PATHS.DB_PATH) ? readConfig() : null;
  if (cfg) openWindow(await startServer(cfg.isHost));
  else {
    win = new BrowserWindow({
      width: 640, height: 760, title: 'Set up Otom',
      webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'preload.cjs') },
    });
    win.loadFile(path.join(__dirname, 'setup.html'));
  }
});
