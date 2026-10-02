/**
 * Safety net, run by Vitest before every test file's own imports (vitest.config.ts setupFiles):
 * point every database / upload path at a throwaway folder. A test that imports a module which
 * loads src/shared/db at the top level — before setupApp() sets these — would otherwise bind the
 * REAL development database (db/data.db) and write test rows into it. That happened twice
 * (2026-09-22, 2026-10-02). setupApp() still sets its own folder per file, as before.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-test-guard-'));
process.env.DB_PATH = path.join(dir, 'test.db');
process.env.DATA_DIR = path.join(dir, 'data');
process.env.UPLOAD_DIR = path.join(dir, 'uploads');
process.env.PLATFORM_DB_PATH = path.join(dir, 'platform.db');
process.env.BACKUP_DIR = path.join(dir, 'backups');
