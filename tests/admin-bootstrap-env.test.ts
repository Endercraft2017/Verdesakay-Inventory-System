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
      expect(() => db.init()).toThrow('ADMIN_PASSWORD is required');
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
