/** A fresh non-test install must not silently create a known administrator password. */
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('default administrator bootstrap', () => {
  it('requires an environment password outside tests', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-admin-bootstrap-'));
    const prior = {
      DB_PATH: process.env.DB_PATH,
      NODE_ENV: process.env.NODE_ENV,
      ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
    };
    try {
      process.env.DB_PATH = path.join(dir, 'test.db');
      process.env.NODE_ENV = 'production';
      delete process.env.ADMIN_PASSWORD;
      vi.resetModules();
      const db = await import('../src/shared/db');
      expect(() => db.init()).toThrow(/ADMIN_PASSWORD/);
      db.closeAllConnections();
    } finally {
      for (const [name, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});


it.each([
  ['only-twelve!', false], ['PasswordPassword', false], ['x'.repeat(129), false],
  ['a unique lantern river phrase', true],
])('validates default-admin bootstrap policy (%s)', async (password, accepted) => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vds-bootstrap-policy-'));
  const prior={ DB_PATH:process.env.DB_PATH, NODE_ENV:process.env.NODE_ENV, ADMIN_PASSWORD:process.env.ADMIN_PASSWORD };
  let db: typeof import('../src/shared/db') | undefined;
  try {
    process.env.DB_PATH=path.join(dir,'test.db'); process.env.NODE_ENV='production';
    process.env.ADMIN_PASSWORD=password; vi.resetModules(); db=await import('../src/shared/db');
    if (accepted) { db.init(); expect(db.queryOne('SELECT username FROM users WHERE id=1')).toEqual({username:'admin'}); }
    else expect(()=>db!.init()).toThrow(/ADMIN_PASSWORD/);
  } finally {
    db?.closeAllConnections();
    for (const [key,value] of Object.entries(prior)) { if (value===undefined) delete process.env[key]; else process.env[key]=value; }
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
