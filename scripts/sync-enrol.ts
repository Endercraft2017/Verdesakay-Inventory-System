/**
 * Enrol this PC as an installed, offline-capable copy of a cloud workspace
 * (docs/OFFLINE-FIRST.md §12, phase 3a).
 *
 *   SYNC_ENROL_PASSWORD=… npm run sync:enrol -- --cloud https://acme.app.afkcube.com \
 *       --user admin --name "Warehouse desk" [--as-host | --host https://192.168.1.20:3000]
 *
 *   --as-host   this PC becomes its site's host: the authority for the PCs on its LAN
 *   --host URL  this PC is on a site's LAN: it syncs with that host (whose server must be running)
 *   (neither)   a single-PC site: it syncs with the cloud directly
 *
 * Downloads the workspace (credentials stripped) into DB_PATH (default db/data.db), which must
 * not exist yet, and makes it this PC's copy — a LAN PC gets it from its host. Then start the
 * server with DEPLOY_MODE=node and it syncs in the background. The admin account needs
 * `users.manage`; the password comes from SYNC_ENROL_PASSWORD (or --password) so it isn't left
 * in shell history.
 */
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { adoptSnapshot, downloadSnapshot, hostNodeNo, registerNode } from '../src/sync/client';

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
  const asHost = process.argv.includes('--as-host');
  const hostUrl = arg('host');
  if (asHost && hostUrl) {
    console.error('Use either --as-host or --host, not both.');
    process.exit(2);
  }
  const file = process.env.DB_PATH || path.join(import.meta.dirname, '..', 'db', 'data.db');
  const role = asHost ? 'site host' : hostUrl ? `PC of the site host at ${hostUrl}` : 'PC';
  console.log(`Enrolling "${name}" as a ${role} against ${cloudUrl} into ${file} …`);
  const hostNo = hostUrl ? await hostNodeNo(hostUrl) : null;
  const id = await registerNode({ cloudUrl, username, password, name, asHost, hostNodeNo: hostNo });
  if (hostUrl) console.log('Waiting for the site host to learn about this PC (its next sync with the cloud) …');
  await downloadSnapshot({ fromUrl: hostUrl ?? cloudUrl, nodeToken: id.nodeToken, file, waitMs: hostUrl ? 5 * 60_000 : 0 });
  const conn = new DatabaseSync(file);
  try {
    adoptSnapshot(conn, { ...id, cloudUrl: hostUrl ?? cloudUrl, isHost: asHost, hostNodeNo: hostNo });
  } finally {
    conn.close();
  }
  console.log(`Done: this PC is node ${id.nodeNo}${asHost ? ' (site host)' : ''}. Start it with DEPLOY_MODE=node.`);
}

main().catch((e: unknown) => {
  console.error(`Enrolment failed: ${(e as Error).message}`);
  process.exit(1);
});
