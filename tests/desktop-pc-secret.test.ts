/**
 * Phase 3f (docs/OFFLINE-FIRST.md §19): an installed PC's credentials at rest. With the desktop
 * shell's DPAPI-held secret (VDS_PC_SECRET) the sync token and the site certificate's private keys
 * are encrypted on disk; without it nothing changes. Plus the disk-encryption check's mapping.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openForPc, sealForPc, isSealed } from '../src/desktop/pc-secret';
import { ensureLanTls } from '../src/desktop/lan-tls';
import { adoptSnapshot, remoteOf } from '../src/sync/client';

const require = createRequire(import.meta.url);
const { describeBitLocker, bitlockerQuery } = require('../electron/disk.cjs') as {
  describeBitLocker: (raw: unknown) => string; bitlockerQuery: (drive: string) => string;
};

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-pcsecret-'));
  process.env.VDS_PC_SECRET = 'test-pc-secret';
});
afterEach(() => {
  delete process.env.VDS_PC_SECRET;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the PC secret', () => {
  it('seals a credential so it can only be opened with the same secret', () => {
    const sealed = sealForPc('node-token-123');
    expect(isSealed(sealed)).toBe(true);
    expect(sealed).not.toContain('node-token-123');
    expect(openForPc(sealed)).toBe('node-token-123');
    process.env.VDS_PC_SECRET = 'another PC';
    expect(() => openForPc(sealed)).toThrow();
    delete process.env.VDS_PC_SECRET;
    expect(() => openForPc(sealed)).toThrow(/desktop app/);
  });

  it('leaves values alone without a secret (a developer running the server directly)', () => {
    delete process.env.VDS_PC_SECRET;
    expect(sealForPc('plain')).toBe('plain');
    expect(openForPc('plain')).toBe('plain');
  });

  it('the sync token is stored sealed and read back in the clear', () => {
    const conn = new DatabaseSync(':memory:');
    adoptSnapshot(conn, { nodeNo: 4, cloudUrl: 'https://cloud.example', nodeToken: 'tok-secret-value' });
    const stored = (conn.prepare('SELECT node_token FROM sync_remote').get() as { node_token: string }).node_token;
    expect(isSealed(stored)).toBe(true);
    expect(remoteOf(conn)).toMatchObject({ cloudUrl: 'https://cloud.example', nodeToken: 'tok-secret-value' });
  });
});

describe('site certificate keys at rest', () => {
  it('are encrypted on disk with the PC secret — and still serve a real TLS handshake', async () => {
    const t = ensureLanTls(dir, { ips: ['10.0.0.5'] });
    for (const f of ['ca.key', 'server.key']) {
      const raw = fs.readFileSync(path.join(dir, f), 'utf8');
      expect(raw).toContain('ENCRYPTED PRIVATE KEY');
      expect(() => crypto.createPrivateKey(raw)).toThrow(); // useless without the passphrase
    }
    const server = https.createServer({ key: t.key, cert: t.cert }, (_q, r) => r.end('ok')).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    try {
      const body = await new Promise<string>((resolve, reject) => {
        https.get({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, ca: t.caCert, servername: 'localhost' }, (res) => {
          let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve(b));
        }).on('error', reject);
      });
      expect(body).toBe('ok');
    } finally {
      server.close();
    }
  });

  it('keys written before the PC had a secret are encrypted on the next start', () => {
    delete process.env.VDS_PC_SECRET;
    ensureLanTls(dir, { ips: ['10.0.0.5'] });
    expect(fs.readFileSync(path.join(dir, 'ca.key'), 'utf8')).not.toContain('ENCRYPTED');
    process.env.VDS_PC_SECRET = 'test-pc-secret';
    const t = ensureLanTls(dir, { ips: ['10.0.0.6'] }); // reads the CA key, issues a new server cert
    expect(fs.readFileSync(path.join(dir, 'ca.key'), 'utf8')).toContain('ENCRYPTED PRIVATE KEY');
    expect(new crypto.X509Certificate(t.cert).verify(new crypto.X509Certificate(t.caCert).publicKey)).toBe(true);
  });
});

describe('disk encryption check', () => {
  it('maps Windows’ BitLocker states; anything unconfirmed still warns', () => {
    expect(['1', '3', '6'].map(describeBitLocker)).toEqual(['on', 'on', 'on']);
    expect(['2', '4', '5'].map(describeBitLocker)).toEqual(['off', 'off', 'off']);
    expect(['0', '', null, 'garbage'].map(describeBitLocker)).toEqual(['unknown', 'unknown', 'unknown', 'unknown']);
    expect(bitlockerQuery("C:'; rm -rf")).toContain("NameSpace('C:')"); // no injection through the drive
  });
});
