/**
 * Enrol this PC as an installed, offline-capable copy of a cloud workspace
 * (docs/OFFLINE-FIRST.md §12, phase 3a).
 *
 *   SYNC_ENROL_PASSWORD=… npm run sync:enrol -- --cloud https://acme.app.afkcube.com \
 *       --user admin --name "Warehouse desk"
 *
 * Downloads the workspace (credentials stripped) into DB_PATH (default db/data.db), which must
 * not exist yet, and makes it this PC's copy. Then start the server with DEPLOY_MODE=node and it
 * syncs in the background. The admin account needs `users.manage`; the password comes from
 * SYNC_ENROL_PASSWORD (or --password) so it isn't left in shell history.
 */
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { adoptSnapshot, enrolNode } from '../src/sync/client';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const cloudUrl = arg('cloud');
  const username = arg('user');
  const name = arg('name');
  const password = process.env.SYNC_ENROL_PASSWORD ?? arg('password');
  if (!cloudUrl || !username || !name || !password) {
    console.error('Usage: SYNC_ENROL_PASSWORD=… npm run sync:enrol -- --cloud <https://workspace-url> --user <admin> --name "<PC name>"');
    process.exit(2);
  }
  const file = process.env.DB_PATH || path.join(import.meta.dirname, '..', 'db', 'data.db');
  console.log(`Enrolling "${name}" against ${cloudUrl} into ${file} …`);
  const id = await enrolNode({ cloudUrl, username, password, name, file });
  const conn = new DatabaseSync(file);
  try {
    adoptSnapshot(conn, { ...id, cloudUrl });
  } finally {
    conn.close();
  }
  console.log(`Done: this PC is node ${id.nodeNo}. Start it with DEPLOY_MODE=node.`);
}

main().catch((e: unknown) => {
  console.error(`Enrolment failed: ${(e as Error).message}`);
  process.exit(1);
});
