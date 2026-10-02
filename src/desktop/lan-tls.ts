/**
 * HTTPS for a site host's LAN (docs/OFFLINE-FIRST.md §5, decision D5). Phones need a trusted
 * HTTPS origin for the camera and the service worker, with no internet. So each site has its own
 * small **certificate authority**: created once on the site's first host, installed once on each
 * phone (the host's phone-setup page), and used to issue the host's server certificate for its
 * current LAN addresses. The site's other PCs get a copy of the authority from the host (phase 5,
 * §30), so whichever PC takes over as host issues its certificate from the same authority and
 * nothing that trusts the site has to be set up again. Its key never leaves the site's PCs and is
 * kept encrypted on each. When the addresses change (DHCP) or the
 * certificate nears expiry, a new one is issued at the next start — phones keep trusting it,
 * because they trust the authority, not the certificate.
 *
 * Node can make keys but not certificates; node-forge (pure JS) builds and signs them.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import forge from 'node-forge';
import { keyPassphrase } from './pc-secret';

export interface LanTls {
  key: string;
  cert: string;
  caCert: string;
  /** SHA-256 of the authority's certificate, as Node's X509Certificate prints it. */
  caFingerprint: string;
}

const CA_YEARS = 10;
/** Apple refuses TLS server certificates from private authorities valid for more than 825
 *  days; stay well inside it and renew automatically. */
const SERVER_DAYS = 397;
const RENEW_WITHIN_DAYS = 30;

function newKeyPair(): { privateKey: forge.pki.rsa.PrivateKey; publicKey: forge.pki.rsa.PublicKey; pem: string } {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }); // native: fast
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  const key = forge.pki.privateKeyFromPem(pem) as forge.pki.rsa.PrivateKey;
  return { privateKey: key, publicKey: forge.pki.setRsaPublicKey(key.n, key.e), pem };
}

function serial(): string {
  return '01' + crypto.randomBytes(15).toString('hex'); // positive, unique
}

/** Write a private key — encrypted (PKCS#8, AES-256) when this PC has its DPAPI-held secret
 *  (§19), so a copied tls folder is useless elsewhere. */
function writePrivate(file: string, pem: string): void {
  const passphrase = keyPassphrase();
  const out = passphrase
    ? crypto.createPrivateKey(pem).export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase }).toString()
    : pem;
  fs.writeFileSync(file, out, { mode: 0o600 });
}

/** Read a private key as plain PKCS#1 PEM (in memory only). A key still stored in the clear is
 *  re-written encrypted once this PC has a secret. */
function readPrivate(file: string): string {
  const raw = fs.readFileSync(file, 'utf8');
  const passphrase = keyPassphrase();
  const encrypted = raw.includes('ENCRYPTED');
  const key = crypto.createPrivateKey(encrypted ? { key: raw, passphrase: passphrase ?? '' } : raw);
  const pem = key.export({ type: 'pkcs1', format: 'pem' }).toString();
  if (!encrypted && passphrase) writePrivate(file, pem);
  return pem;
}

/** IPv4 addresses of this machine on the LAN. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const n of nets ?? []) if (n.family === 'IPv4' && !n.internal) out.push(n.address);
  }
  return out;
}

function createAuthority(dir: string, org: string): void {
  const kp = newKeyPair();
  const cert = forge.pki.createCertificate();
  cert.publicKey = kp.publicKey;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + CA_YEARS * 365 * 86_400_000);
  const attrs = [
    { name: 'commonName', value: `${org} site certificate (${os.hostname()})` },
    { name: 'organizationName', value: org },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(kp.privateKey, forge.md.sha256.create());
  writePrivate(path.join(dir, 'ca.key'), kp.pem);
  fs.writeFileSync(path.join(dir, 'ca.crt'), forge.pki.certificateToPem(cert));
}

function issueServerCert(dir: string, names: string[], ips: string[]): void {
  const caCert = forge.pki.certificateFromPem(fs.readFileSync(path.join(dir, 'ca.crt'), 'utf8'));
  const caKey = forge.pki.privateKeyFromPem(readPrivate(path.join(dir, 'ca.key')));
  const kp = newKeyPair();
  const cert = forge.pki.createCertificate();
  cert.publicKey = kp.publicKey;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + SERVER_DAYS * 86_400_000);
  cert.setSubject([{ name: 'commonName', value: names[0] ?? 'localhost' }]);
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    {
      name: 'subjectAltName',
      altNames: [
        ...names.map((value) => ({ type: 2, value })), // DNS
        ...ips.map((ip) => ({ type: 7, ip })), // IP
      ],
    },
    { name: 'subjectKeyIdentifier' },
    { name: 'authorityKeyIdentifier', keyIdentifier: caCert.generateSubjectKeyIdentifier().getBytes() },
  ]);
  cert.sign(caKey, forge.md.sha256.create());
  writePrivate(path.join(dir, 'server.key'), kp.pem);
  fs.writeFileSync(path.join(dir, 'server.crt'), forge.pki.certificateToPem(cert));
  fs.writeFileSync(path.join(dir, 'server.json'), JSON.stringify({ names, ips }));
}

function serverCertCurrent(dir: string, names: string[], ips: string[]): boolean {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'server.json'), 'utf8')) as { names: string[]; ips: string[] };
    const same = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);
    if (!same(meta.names, names) || !same(meta.ips, ips)) return false;
    const cert = new crypto.X509Certificate(fs.readFileSync(path.join(dir, 'server.crt')));
    return Date.parse(cert.validTo) - Date.now() > RENEW_WITHIN_DAYS * 86_400_000;
  } catch {
    return false;
  }
}

/**
 * The host's TLS material in `dir`, creating the authority on first use and (re)issuing the
 * server certificate whenever its names / addresses changed or it is near expiry.
 */
export function ensureLanTls(dir: string, opts: { org?: string; ips?: string[]; names?: string[] } = {}): LanTls {
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, 'ca.key')) || !fs.existsSync(path.join(dir, 'ca.crt'))) {
    createAuthority(dir, opts.org ?? 'Verdesakay');
  }
  const names = [...new Set(['localhost', os.hostname().toLowerCase(), ...(opts.names ?? [])])];
  const ips = [...new Set(['127.0.0.1', ...(opts.ips ?? lanAddresses())])];
  if (!serverCertCurrent(dir, names, ips)) issueServerCert(dir, names, ips);
  const caCert = fs.readFileSync(path.join(dir, 'ca.crt'), 'utf8');
  return {
    key: readPrivate(path.join(dir, 'server.key')),
    cert: fs.readFileSync(path.join(dir, 'server.crt'), 'utf8'),
    caCert,
    caFingerprint: new crypto.X509Certificate(caCert).fingerprint256,
  };
}

/** The site's certificate authority, to hand to another PC of the same site (phase 5, §30), or
 *  null when this PC has none. The key is returned in the clear: send it only over the site's
 *  own HTTPS to an enrolled PC of the site. */
export function exportSiteAuthority(dir: string): { cert: string; key: string } | null {
  const crt = path.join(dir, 'ca.crt');
  const key = path.join(dir, 'ca.key');
  if (!fs.existsSync(crt) || !fs.existsSync(key)) return null;
  return { cert: fs.readFileSync(crt, 'utf8'), key: readPrivate(key) };
}

/** Keep the site's certificate authority on this PC (encrypted like its own keys). Any server
 *  certificate from another authority is dropped, so the next start issues one from the site's. */
export function importSiteAuthority(dir: string, ca: { cert: string; key: string }): void {
  new crypto.X509Certificate(ca.cert); // throws on garbage
  crypto.createPrivateKey(ca.key);
  fs.mkdirSync(dir, { recursive: true });
  const current = path.join(dir, 'ca.crt');
  if (fs.existsSync(current) && fs.readFileSync(current, 'utf8').trim() === ca.cert.trim()) return;
  writePrivate(path.join(dir, 'ca.key'), ca.key);
  fs.writeFileSync(current, ca.cert);
  for (const f of ['server.key', 'server.crt']) fs.rmSync(path.join(dir, f), { force: true });
}
