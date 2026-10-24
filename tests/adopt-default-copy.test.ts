import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DB_PATH, DATA_DIR, UPLOAD_DIR } from '../src/shared/db';
import { adoptDefaultTenant } from '../src/platform/adopt-default';
import { getTenant } from '../src/platform/platform';

let original: Buffer;
const first = Buffer.from([0, 255, 16, 9]);
const second = Buffer.from('synthetic nested upload');
beforeAll(() => {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const source = new DatabaseSync(DB_PATH);
  source.exec("CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT, password_hash TEXT); INSERT INTO users VALUES(1,'synthetic-existing-owner','synthetic-existing-hash');");
  source.close();
  fs.mkdirSync(path.join(UPLOAD_DIR, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(UPLOAD_DIR, 'a.bin'), first);
  fs.writeFileSync(path.join(UPLOAD_DIR, 'nested', 'b.bin'), second);
  original = fs.readFileSync(DB_PATH);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const slug of ['competing-root', 'competing-file', 'copy-interrupted']) {
    fs.rmSync(path.join(UPLOAD_DIR, slug), { recursive: true, force: true });
  }
});

function apply(slug: string) {
  return adoptDefaultTenant({ slug, name: 'Synthetic offline adoption', apply: true, serverStopped: true });
}
function assertUnpublished(slug: string) {
  expect(getTenant(slug)).toBeNull();
  expect(fs.existsSync(path.join(DATA_DIR, `${slug}.db`))).toBe(false);
  expect(fs.readFileSync(DB_PATH)).toEqual(original);
  expect(fs.readFileSync(path.join(UPLOAD_DIR, 'a.bin'))).toEqual(first);
  expect(fs.readFileSync(path.join(UPLOAD_DIR, 'nested', 'b.bin'))).toEqual(second);
}
function recoveryDirectories() {
  return new Set(fs.existsSync(DATA_DIR) ? fs.readdirSync(DATA_DIR).filter(n => n.startsWith('.adopt-default-')) : []);
}
function assertRecoveryRetained(before: Set<string>) {
  const added = [...recoveryDirectories()].filter(n => !before.has(n));
  expect(added).toHaveLength(1);
  const recovery = path.join(DATA_DIR, added[0]!);
  const snapshot = new DatabaseSync(path.join(recovery, 'source.db'), { readOnly: true });
  try {
    expect(snapshot.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
    expect(snapshot.prepare('SELECT * FROM users').get()).toMatchObject({ username: 'synthetic-existing-owner', password_hash: 'synthetic-existing-hash' });
  } finally { snapshot.close(); }
  expect(fs.existsSync(path.join(recovery, 'platform.db'))).toBe(true);
  expect(fs.readFileSync(path.join(recovery, 'uploads', 'a.bin'))).toEqual(first);
  expect(fs.readFileSync(path.join(recovery, 'uploads', 'nested', 'b.bin'))).toEqual(second);
  expect(fs.existsSync(path.join(recovery, 'verification.json'))).toBe(false);
}

describe('offline adoption keeps exclusive destination ownership on copy failure', () => {
  it('refuses a directory claimed after preview without deleting the competing contents', () => {
    const slug = 'competing-root', target = path.join(UPLOAD_DIR, slug);
    const before = recoveryDirectories(), mkdir = fs.mkdirSync;
    let injected = false;
    vi.spyOn(fs, 'mkdirSync').mockImplementation(((directory: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
      if (String(directory) === target && !options?.recursive && !injected) {
        injected = true;
        mkdir(target);
        fs.writeFileSync(path.join(target, 'competing.txt'), 'competing directory owner');
      }
      return mkdir(directory, options);
    }) as typeof fs.mkdirSync);
    expect(() => apply(slug)).toThrow(expect.objectContaining({ code: 'EEXIST' }));
    expect(injected).toBe(true);
    expect(fs.readFileSync(path.join(target, 'competing.txt'), 'utf8')).toBe('competing directory owner');
    assertUnpublished(slug);
    assertRecoveryRetained(before);
  });

  it('refuses a file appearing during destination copy without overwriting it or registering', () => {
    const slug = 'competing-file', target = path.join(UPLOAD_DIR, slug, 'nested', 'b.bin');
    const before = recoveryDirectories(), copy = fs.copyFileSync;
    let injected = false;
    vi.spyOn(fs, 'copyFileSync').mockImplementation((source, destination, mode) => {
      if (String(destination) === target && !injected) {
        injected = true;
        fs.writeFileSync(target, 'competing file owner', { flag: 'wx' });
      }
      copy(source, destination, mode);
    });
    expect(() => apply(slug)).toThrow(expect.objectContaining({ code: 'EEXIST' }));
    expect(injected).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('competing file owner');
    assertUnpublished(slug);
    assertRecoveryRetained(before);
  });

  it('keeps recoverable partial output and refuses retry after an injected second-file failure', () => {
    const slug = 'copy-interrupted', target = path.join(UPLOAD_DIR, slug);
    const before = recoveryDirectories(), copy = fs.copyFileSync;
    let injected = false;
    vi.spyOn(fs, 'copyFileSync').mockImplementation((source, destination, mode) => {
      if (String(destination) === path.join(target, 'nested', 'b.bin')) {
        injected = true;
        throw Object.assign(new Error('Synthetic destination copy failure'), { code: 'ENOSPC' });
      }
      copy(source, destination, mode);
    });
    expect(() => apply(slug)).toThrow(expect.objectContaining({ code: 'ENOSPC' }));
    expect(injected).toBe(true);
    expect(fs.readFileSync(path.join(target, 'a.bin'))).toEqual(first);
    expect(fs.existsSync(path.join(target, 'nested', 'b.bin'))).toBe(false);
    assertUnpublished(slug);
    assertRecoveryRetained(before);
    expect(() => apply(slug)).toThrow('Destination already exists');
    expect(fs.readFileSync(path.join(target, 'a.bin'))).toEqual(first);
    expect(recoveryDirectories().size).toBe(before.size + 1);
  });
});
