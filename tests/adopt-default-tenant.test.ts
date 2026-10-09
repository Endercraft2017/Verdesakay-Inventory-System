import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, expect } from 'vitest';
import { DB_PATH, DATA_DIR, UPLOAD_DIR } from '../src/shared/db';
import { adoptDefaultTenant } from '../src/platform/adopt-default';
import { getTenant, createTenantRow } from '../src/platform/platform';

describe('adopt the original company without deleting its data', () => {
  it('previews, requires stopped writers, verifies files, and preserves all rows and passwords', () => {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    const source = new DatabaseSync(DB_PATH);
    source.exec("CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT, password_hash TEXT); INSERT INTO users VALUES(1,'existing-admin','existing-hash'); CREATE TABLE records(id INTEGER PRIMARY KEY, data TEXT); INSERT INTO records VALUES(1,'company-history');");
    source.close();
    fs.mkdirSync(path.join(UPLOAD_DIR, 'kiosk-punches'), { recursive: true });
    fs.writeFileSync(path.join(UPLOAD_DIR, 'document.pdf'), 'existing document');
    fs.writeFileSync(path.join(UPLOAD_DIR, 'kiosk-punches', 'photo.jpg'), 'existing photo');
    createTenantRow({ slug: 'otherco', name: 'Other Company' });
    fs.mkdirSync(path.join(UPLOAD_DIR, 'otherco'));
    fs.writeFileSync(path.join(UPLOAD_DIR, 'otherco', 'private.txt'), 'not Verdesakay');
    const original = fs.readFileSync(DB_PATH);
    const input = { slug: 'verdesakay', name: 'Verdesakay' };
    expect(adoptDefaultTenant(input)).toMatchObject({ applied: false, users: 1, files: 2 });
    expect(getTenant('verdesakay')).toBeNull();
    expect(() => adoptDefaultTenant({ ...input, apply: true })).toThrow('Stop all server');
    const result = adoptDefaultTenant({ ...input, apply: true, serverStopped: true });
    expect(result.applied).toBe(true);
    expect(getTenant('verdesakay')).toMatchObject({ plan: 'unlimited', status: 'active' });
    expect(fs.readFileSync(DB_PATH)).toEqual(original);
    const target = new DatabaseSync(path.join(DATA_DIR, 'verdesakay.db'), { readOnly: true });
    expect(target.prepare('SELECT * FROM users').get()).toMatchObject({ username: 'existing-admin', password_hash: 'existing-hash' });
    expect(target.prepare('SELECT data FROM records').get()?.data).toBe('company-history');
    target.close();
    expect(fs.readFileSync(path.join(UPLOAD_DIR, 'verdesakay', 'document.pdf'), 'utf8')).toBe('existing document');
    expect(fs.readFileSync(path.join(UPLOAD_DIR, 'verdesakay', 'kiosk-punches', 'photo.jpg'), 'utf8')).toBe('existing photo');
    expect(fs.existsSync(path.join(UPLOAD_DIR, 'verdesakay', 'otherco'))).toBe(false);
    expect(fs.readFileSync(path.join(UPLOAD_DIR, 'document.pdf'), 'utf8')).toBe('existing document');
    expect(() => adoptDefaultTenant({ ...input, apply: true, serverStopped: true })).toThrow('already exists');
  });

  it('refuses unknown plans, collisions and symbolic links before registering a tenant', () => {
    expect(() => adoptDefaultTenant({ slug: 'newco', name: 'New', plan: 'missing' })).toThrow('Unknown plan');
    fs.mkdirSync(path.join(UPLOAD_DIR, 'collision'));
    expect(() => adoptDefaultTenant({ slug: 'collision', name: 'Collision' })).toThrow('Destination already exists');
    fs.symlinkSync(path.join(UPLOAD_DIR, 'document.pdf'), path.join(UPLOAD_DIR, 'link.pdf'));
    expect(() => adoptDefaultTenant({ slug: 'newco', name: 'New' })).toThrow('symbolic link');
    expect(getTenant('newco')).toBeNull();
  });
});
