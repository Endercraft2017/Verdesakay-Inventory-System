# Register the original Verdesakay company without deleting its data

Target URL: **https://otom.afkcube.com/verdesakay**. This procedure needs the code
on `restructure/module-architecture` including the adoption and path-routing changes.

> **Status: completed on production 2026-10-09.** See [Cutover record](#cutover-record-2026-10-09)
> for what was actually run. Do **not** run the adoption again: Verdesakay is registered,
> and `/data/db/data.db` is now a recovery-only copy that the app never opens.

## Existing Railway paths

Keep these variables unchanged:

```text
DB_PATH=/data/db/data.db
DATA_DIR=/data/db/tenants
UPLOAD_DIR=/data/uploads
PLATFORM_DB_PATH=/data/db/platform.db
```

The registered tenant uses `/data/db/tenants/verdesakay.db` and
`/data/uploads/verdesakay/`. The original database and original uploads stay in
place. This is a copy, verification, and registration cutover; no source files or
business records are deleted. Keep `APP_SECRET`, encryption keys and integration
credentials unchanged so copied encrypted settings remain usable.

## Before cutover

1. Check that Railway is using the intended branch/revision and that the same
   persistent `/data` volume is attached to the process executing the commands.
   Do not run these commands in the Codex workspace expecting them to move Railway data.
2. Complete/sync queued browser and installed-PC work. Pause company activity and
   stop every server, worker, reminder process and scheduled writer using this data.
   The apply flag is an explicit assertion that these writers have stopped; the
   helper cannot stop Railway processes itself. Use a maintenance process attached
   to the existing volume, with the normal Railway variables and installed dependencies.
3. Take/retain the existing deployment and a volume backup. Ensure enough space
   for **two additional database and upload copies**, plus a platform DB snapshot.
   The helper retains its verified recovery snapshot as well as the original data.

## Preview and apply

From the repository root, with the existing Railway variables injected:

```sh
node --import tsx scripts/adopt-default-tenant.ts --slug verdesakay --name Verdesakay
```

Default mode reports the source/destination paths, user count, file count and bytes.
It does not create a tenant or copy the company database. It may initialize the
control-plane schema if needed. It refuses missing/corrupt source databases,
occupied destinations and upload symlinks.

After stopping all writers:

```sh
node --import tsx scripts/adopt-default-tenant.ts --slug verdesakay --name Verdesakay --apply --server-stopped
```

The helper creates a consistent SQLite snapshot (including committed WAL data),
copies documents/photos/sync blobs recursively, excludes other registered tenants'
upload directories, verifies file hashes and the target database bytes, and then
registers the tenant. All source tables, usernames/password hashes, sessions,
settings, employee records and business history are copied unchanged. No new
administrator replaces the company's existing accounts.

The default plan is `unlimited`, preserving this first company's existing feature
access and limits. Do not select a restricted plan during the move unless intended.
Recovery data is retained under `/data/db/tenants/.adopt-default-*/`, including the
source snapshot, platform snapshot, uploads and `verification.json`.

A repeated apply refuses to overwrite an existing tenant/destination. If a run
fails, keep the source and recovery files, inspect the failure, and do not blindly
delete partial destinations or retry over them. The helper never deletes them.

For the 24 October current-Node copy compatibility fix and interrupted/competing
destination review, see [adoption copy recovery](operations/adoption-copy-recovery.md).
This does not authorize repeating the completed historical cutover.

## Activate the new URL

Only after the helper succeeds, configure:

```text
TENANT_PATH_HOST=otom.afkcube.com
APP_DOMAIN=otom.afkcube.com
DEFAULT_TENANT_REDIRECT=verdesakay
PLATFORM_CONSOLE=true
TZ=Asia/Manila
```

Retain the existing Railway HTTPS proxy configuration (`BEHIND_PROXY=true` or its
Railway detection), port, volume mount and owner credentials. The existing domain
must already point to this service and have valid HTTPS; no wildcard DNS is needed.
`PLATFORM_HOST`, if set, may be this host or a separate owner-console host.

Start the normal server. Desktop, mobile, API, uploads, chat and offline queues use
the tenant path. The owner console stays at `/_platform`. It shows a tenant link.
The original company's API aliases are retired: the root now serves the public
customer website, while legacy mobile entries redirect,
old unprefixed company APIs are refused, and root `/api/health` remains available
for Railway. Background maintenance, backups and migration commands must not open
the retired original database. The original is recovery-only, not a second company.

## Verify before resuming company work

- Open `/verdesakay` and sign in using an **existing company account**.
- Check the company name, known inventory quantities, employees/payroll/history,
  uploaded documents, images and kiosk photos against the pre-cutover records.
- Check `/verdesakay/m`, chat, notifications, and a representative authorized action.
- Confirm the owner console lists Verdesakay with the expected users/items/modules.
- Confirm root `/api/health` works and the old company API cannot accept writes.
- Update installed phones' server URLs and installed PCs' cloud URLs to
  `https://otom.afkcube.com/verdesakay`, preserving their existing local data and
  enrollment credentials. Verify syncing before accepting new offline work.
- Reopen/install the PWA at the new URL and re-enable notifications as needed.
  Existing browser tokens, drafts and old offline queues are retained in the old
  namespace; they are not automatically reassigned to another tenant.

Path tenants share one browser origin. Namespaced sessions/queues prevent accidental
mixing, but paths are not browser security boundaries like separate origins. Keep
tenant-provided HTML and scripts subject to the application's existing sanitization
and permission checks.

## Recovery

If validation fails **before new tenant writes**, stop the service and restore its
previous code/configuration, removing the new routing/cutover variables. The
original database/uploads remain intact and can resume serving the old company.
Keep the registered copy and all recovery files for diagnosis.

After new writes have begun, do not simply revert to the older original: it would
omit those writes. Stop writers and reconcile or restore from the latest tenant
backup. Never purge Verdesakay or overwrite either copy to perform a rollback.

## Railway workflow when you do not have a service shell

The one-time launcher `scripts/start-verdesakay-cutover.ts` runs the same adoption
helper before starting any application server or background jobs. It retains all
source/recovery files, refuses occupied destinations, and starts the app only after
verification and registration succeed. It is not an automatic migration on ordinary
startup and must never be used while another writer is running.

> **Not used in the 2026-10-09 cutover.** On this service the start command is the
> service-level **Start Command** setting: Railway does not read `railway.json` here
> (the deployment's `fileServiceManifest` is empty), so editing `deploy.startCommand`
> in that file has no effect. A *Redeploy* of an existing deployment also reuses that
> deployment's old settings; start a fresh deployment (`serviceInstanceDeployV2` with
> the commit) after changing the Start Command. Railway SSH (`railway ssh`) is available,
> so the record below runs the helper over SSH instead.

1. Pause Verdesakay activity, sync pending device/browser work, retain a volume backup,
   and check enough free space as described above. Confirm this service has the
   existing persistent `/data` volume and the four existing data variables.
2. Ensure the deployment includes the launcher. Stop the current deployment and any
   other scheduled/background writers through Railway. **Do not delete the service
   or its volume.** If the UI only offers a deployment-removal operation, confirm it
   stops just the running deployment and retains the service, variables and volume.
3. Set the service's custom **Start Command** to:

   ```sh
   node --import tsx scripts/start-verdesakay-cutover.ts --writers-stopped
   ```

   The flag is your assertion that all old writers have stopped. The command cannot
   verify that remote workers or installed devices have been paused.
4. Deploy that revision against the same volume. Check logs for `applied: true`, the
   retained recovery directory and `Verdesakay registered`. This deployment then
   starts the normal app with tenant routing and owner console enabled.
5. Verify the existing company login/data/uploads at `/verdesakay`, and Verdesakay's
   row in `/_platform`, before resuming activity. The root serves the public customer website; legacy mobile entries redirect
   to Verdesakay.
6. **Immediately after success**, persist the five cutover routing variables shown
   above plus `DEPLOY_MODE=cloud` in Railway and restore **Start Command** to
   `npm start`. Save these settings together, then redeploy normally. Do not leave
   the one-time launcher as the regular restart command: a second attempt refuses
   the existing tenant and exits safely rather than overwriting it.

If the launcher fails, do not delete destination files or rerun it blindly. Preserve
logs, source files and recovery snapshots. A failure before registration leaves the
original source available for recovery; if registration succeeded but server startup
failed, switch to the normal command with the persistent cutover variables rather
than repeating adoption.

## Cutover record (2026-10-09)

Railway project `ERP` / `production`, service `Verdesakay-Inventory-System`, volume
`verdesakay-inventory-system-volume` at `/data` (one replica, no cron). All times UTC.

1. **Before:** deployed `3f06607`; tenant catalog empty; no destination or recovery files.
   Source: 115 tables, 14 users, 57 employees, 2 upload files (14,497 bytes).
2. **Writers stopped (05:35):** company activity paused by the owner. Start Command set
   to `node scripts/maintenance-server.mjs` (health 200, everything else 503, opens no
   database) and deployed fresh. Verified over SSH: only that process running, and
   `data.db`, `platform.db` and their WAL files unchanged (size, time, sha256) for 45 s.
3. **Backups (05:37–05:38):**
   - Railway volume backup `pre-verdesakay-cutover-2026-10-09`;
   - `/data/db/cutover-backup-2026-10-09T05-37-47-962Z/`: raw database/WAL/SHM files,
     `VACUUM INTO` snapshots, uploads, and `manifest.json` with sha256 hashes;
   - an off-site copy of that folder on the owner's PC, hash-checked against the manifest.
4. **Preview, then apply over SSH:**
   `node --import tsx scripts/adopt-default-tenant.ts --slug verdesakay --name Verdesakay`,
   then the same command with `--apply --server-stopped`. Result `applied: true`, recovery
   folder `/data/db/tenants/.adopt-default-gzDxtl`, registered 05:42:34 as `unlimited`/`active`.
5. **Independent verification:** every row of all 115 tables in `verdesakay.db` matches the
   source snapshot (accounts and password hashes included); integrity `ok`; uploads match
   by hash; the original `data.db` and WAL are byte-identical to the pre-cutover backup.
6. **Switch-over:** saved `TENANT_PATH_HOST`, `APP_DOMAIN`, `DEFAULT_TENANT_REDIRECT=verdesakay`,
   `PLATFORM_CONSOLE=true`, `DEPLOY_MODE=cloud`, `TZ=Asia/Manila`; Start Command back to
   `npm start`; deployed `81058a5`. The running server holds only `tenants/verdesakay.db`
   and `platform.db` open.
7. **Live checks:** `/` and `/m` redirect to `/verdesakay/` and `/verdesakay/m`; tenant shells,
   manifest and service worker are scoped to `/verdesakay`; both health endpoints return 200;
   the old company API answers 410; `/_platform` lists Verdesakay with 57 employees / 14 users.

Left to the owner before resuming work: sign in with an existing account, point phones
and the two kiosk PCs at `/verdesakay` (kiosks may need re-approval), and spot-check records.
