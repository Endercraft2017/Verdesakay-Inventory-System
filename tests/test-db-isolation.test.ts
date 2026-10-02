/**
 * The safety net in tests/setup-safe-paths.ts: even a test that loads src/shared/db at the top
 * level (the mistake that wrote test rows into the real db/data.db twice) gets a throwaway folder.
 */
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { DB_PATH, DATA_DIR } from '../src/shared/db';

describe('test database isolation', () => {
  it('a top-level import of the database module never points at the real db/ folder', () => {
    const tmp = path.resolve(os.tmpdir()).toLowerCase();
    expect(path.resolve(DB_PATH).toLowerCase().startsWith(tmp)).toBe(true);
    expect(path.resolve(DATA_DIR).toLowerCase().startsWith(tmp)).toBe(true);
    expect(path.resolve(DB_PATH)).not.toBe(path.resolve('db', 'data.db'));
  });
});
