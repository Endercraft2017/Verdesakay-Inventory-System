import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const bucket = vi.hoisted(() => ({ bucketManages: vi.fn(), sendNow: vi.fn() }));
vi.mock('../src/shared/file-store', () => ({ ...bucket, localCopy: vi.fn(), forgetUpload: vi.fn() }));
vi.mock('../src/shared/db', () => ({ queryOne: vi.fn(), run: vi.fn(), uploadDir: vi.fn(), tenantStore: { getStore: vi.fn() }, DEFAULT_TENANT: 'default' }));
vi.mock('../src/shared/backup', () => ({ backupDir: vi.fn(), mirrorDir: vi.fn() }));
import { messageBytesToKeep } from '../src/shared/durable-uploads';

beforeEach(() => vi.clearAllMocks());
describe('message attachment durability', () => {
  it('keeps bytes available until the bucket has accepted the upload', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'message-upload-'));
    const file = path.join(dir, 'clip.mp4');
    fs.writeFileSync(file, 'video-bytes');
    let complete!: (ok: boolean) => void;
    bucket.bucketManages.mockReturnValue(true);
    bucket.sendNow.mockReturnValue(new Promise<boolean>(resolve => { complete = resolve; }));
    const clear = vi.fn();
    try {
      expect(messageBytesToKeep(file, clear).toString()).toBe('video-bytes');
      expect(clear).not.toHaveBeenCalled();
      complete(true);
      await Promise.resolve();
      expect(clear).toHaveBeenCalledWith(null);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('retains the database bytes when the bucket upload fails', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'message-upload-'));
    const file = path.join(dir, 'clip.mp4');
    fs.writeFileSync(file, 'video-bytes');
    bucket.bucketManages.mockReturnValue(true);
    bucket.sendNow.mockResolvedValue(false);
    const clear = vi.fn();
    try {
      expect(messageBytesToKeep(file, clear).toString()).toBe('video-bytes');
      await Promise.resolve();
      expect(clear).not.toHaveBeenCalled();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
