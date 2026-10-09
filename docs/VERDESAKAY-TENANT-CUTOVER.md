# Register the original Verdesakay company without deleting its data

Target URL: **https://otom.afkcube.com/verdesakay**. This procedure needs the code
on `restructure/module-architecture` including the adoption and path-routing changes.
It has been exercised on isolated fixtures, not on the Railway production volume.

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
The original company's root/API aliases are retired: root/mobile entries redirect,
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
   row in `/_platform`, before resuming activity. The root redirects to Verdesakay
   for now; the public marketing landing page is a separate next change.
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
