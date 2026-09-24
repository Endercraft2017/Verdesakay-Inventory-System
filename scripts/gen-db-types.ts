/**
 * Regenerate src/shared/db-types.ts from a fresh, fully-migrated throwaway database.
 *
 *   npm run db:types
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-dbtypes-'));
process.env.DB_PATH = path.join(tmp, 'schema.db');
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');
process.env.DATA_DIR = path.join(tmp, 'tenants');
process.env.PLATFORM_DB_PATH = path.join(tmp, 'platform.db');

// Dynamic imports: db.ts must see the env above before it resolves DB_PATH.
const { getDb } = await import('../src/shared/db');
const { renderDbTypes } = await import('../src/shared/db-types-codegen');

const conn = getDb();
const target = path.join(import.meta.dirname, '..', 'src', 'shared', 'db-types.ts');
fs.writeFileSync(target, renderDbTypes(conn));
conn.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`Wrote ${path.relative(process.cwd(), target)}`);
