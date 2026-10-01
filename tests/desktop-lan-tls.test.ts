/**
 * Site host HTTPS for the LAN (src/desktop/lan-tls.ts + phone-setup.ts; docs/OFFLINE-FIRST.md
 * D5, §17): a per-host certificate authority, the server certificate it issues for the host's
 * LAN addresses, and the plain-HTTP phone-setup page. The decisive check is a real TLS handshake
 * that trusts only the site authority — what a phone does after installing it.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ensureLanTls } from '../src/desktop/lan-tls';
import { phoneSetupHandler } from '../src/desktop/phone-setup';

let dir: string;
beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-tls-')); });
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('the site certificate authority', () => {
  it('issues a server certificate for the host\'s LAN addresses, signed by the site authority', () => {
    const t = ensureLanTls(dir, { ips: ['192.168.1.20'], org: 'Acme Plant' });
    const ca = new crypto.X509Certificate(t.caCert);
    const server = new crypto.X509Certificate(t.cert);
    expect(ca.ca).toBe(true);
    expect(ca.subject).toMatch(/O=Acme Plant/);
    expect(server.ca).toBe(false);
    expect(server.checkIssued(ca)).toBe(true);
    expect(server.verify(ca.publicKey)).toBe(true);
    expect(server.subjectAltName).toContain('IP Address:192.168.1.20');
    expect(server.subjectAltName).toContain('IP Address:127.0.0.1');
    expect(server.subjectAltName).toContain('DNS:localhost');
    // iPhones refuse private-authority server certificates valid for more than 825 days.
    expect((Date.parse(server.validTo) - Date.parse(server.validFrom)) / 86_400_000).toBeLessThan(825);
    expect(t.caFingerprint).toBe(ca.fingerprint256);
  });

  it('keeps the same certificate while nothing changed, and re-issues — same authority — when the address changes', () => {
    const a = ensureLanTls(dir, { ips: ['192.168.1.20'] });
    const b = ensureLanTls(dir, { ips: ['192.168.1.20'] });
    expect(b.cert).toBe(a.cert);
    const c = ensureLanTls(dir, { ips: ['192.168.1.44'] }); // DHCP gave the host a new address
    expect(c.cert).not.toBe(a.cert);
    expect(c.caCert).toBe(a.caCert); // phones keep trusting it
    expect(new crypto.X509Certificate(c.cert).subjectAltName).toContain('IP Address:192.168.1.44');
  });

  it('a client that trusts only the site authority completes a real HTTPS handshake', async () => {
    const t = ensureLanTls(dir, { ips: ['192.168.1.44'] });
    const server = https.createServer({ key: t.key, cert: t.cert }, (_req, res) => res.end('ok')).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as AddressInfo).port;
    const get = (ca: string | undefined) => new Promise<string>((resolve, reject) => {
      https.get({ host: '127.0.0.1', port, path: '/', ca, servername: 'localhost' }, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve(body));
      }).on('error', reject);
    });
    try {
      expect(await get(t.caCert)).toBe('ok');
      await expect(get(undefined)).rejects.toThrow(); // without the site authority: not trusted
    } finally {
      server.close();
    }
  });
});

describe('the phone-setup page (plain HTTP)', () => {
  it('serves the steps, the certificate, and sends everything else to HTTPS', async () => {
    const t = ensureLanTls(dir, { ips: ['192.168.1.44'] });
    const server = http.createServer(phoneSetupHandler({ caCert: t.caCert, fingerprint: t.caFingerprint, httpsPort: 3000, org: 'Acme Plant' }))
      .listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const page = await fetch(`${base}/`);
      const html = await page.text();
      expect(html).toContain('Set up this phone for Acme Plant');
      expect(html).toContain(t.caFingerprint);
      expect(html).toContain('href="https://127.0.0.1:3000/m"');
      const crt = await fetch(`${base}/site-certificate.crt`);
      expect(crt.headers.get('content-type')).toBe('application/x-x509-ca-cert');
      expect(await crt.text()).toBe(t.caCert);
      const other = await fetch(`${base}/m/#/home`, { redirect: 'manual' });
      expect(other.status).toBe(301);
      expect(other.headers.get('location')).toBe('https://127.0.0.1:3000/m/');
    } finally {
      server.close();
    }
  });
});
