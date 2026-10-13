# SaaS Operations

How to run the system for multiple companies (tenants). For the architecture and the
remaining phases, see [SAAS-READINESS.md](SAAS-READINESS.md). Single-tenant / self-hosted
installs can ignore this file entirely — with no `APP_DOMAIN` set, everything runs as the
one `default` tenant, exactly as before.

## Data model

- **One SQLite file per tenant.** The `default` tenant lives at `DB_PATH` (`db/data.db`);
  every other tenant is `DATA_DIR/<slug>.db` (`db/tenants/<slug>.db`), created on first use.
- **`platform.db`** (`PLATFORM_DB_PATH`) is the control plane — the `tenants` catalog and
  `provisioning_log`. It is **not** a tenant database and is never reachable from
  tenant-facing request code.
- Uploaded files: `UPLOAD_DIR` for `default`; `UPLOAD_DIR/<slug>/` per tenant (item images,
  form files, 201-file documents, AI reports — all resolved through `db.uploadDir()`).
  `tenant:purge` deletes the folder.

## Environment

| Var | Purpose | Default |
|---|---|---|
| `APP_DOMAIN` | Root domain for tenant sub-domains, e.g. `app.afkcube.com`. **Empty ⇒ single-tenant** (host is ignored; only the `default` tenant). | *(empty)* |
| `PLATFORM_DB_PATH` | The control-plane DB file. | `<root>/db/platform.db` |
| `DATA_DIR` | Where non-`default` tenant DB files live. | `<root>/db/tenants` |
| `DB_PATH` | The `default` tenant's DB file. | `<root>/db/data.db` |
| `UPLOAD_DIR` | Uploaded files. | `<root>/uploads` |
| `SIGNUPS_OPEN` | `"true"` makes `POST /api/signup` live (self-serve tenant creation). Anything else ⇒ 404; you provision manually. | *(off)* |
| `PLATFORM_CONSOLE` | `"true"` mounts the owner console at `/_platform`. Anything else ⇒ the whole path 404s. | *(off)* |
| `PLATFORM_HOST` | Dedicated console host, e.g. `admin.app.example.com`. When set, `/_platform` answers **only** there and every other path on that host redirects to `/_platform/` (no tenant app is served on it). | *(unset: apex/default host)* |
| `TZ` | Office time zone, e.g. `Asia/Manila`. Attendance/payroll dates and kiosk rules use server-local time (Node + SQLite `'localtime'`), so it must be set **before the process starts**. Required behind a proxy: the server refuses to start without it. | *(OS time zone)* |
| `BEHIND_PROXY` | `"true"` when a TLS-terminating proxy fronts the app: serve plain HTTP on `PORT`, trust `X-Forwarded-*`. Auto-on when `RAILWAY_ENVIRONMENT` is set. See [DEPLOY-RAILWAY.md](DEPLOY-RAILWAY.md). | *(off)* |
| `PLATFORM_ADMIN_USERNAME` / `PLATFORM_ADMIN_PASSWORD` | Bootstrap the first console operator on boot (only when there are none yet). Or use `npm run platform:user`. | *(unset)* |
| `PLATFORM_ADMIN_TOKEN` | Optional shared secret — when set, every `/_platform/api` request must also send `X-Platform-Token: <token>`. | *(unset)* |
| `APP_SECRET` / `MAIL_SECRET_KEY` | AES key for secrets at rest (SMTP password, etc.). **Set this in SaaS mode** so tenant DB files aren't self-decrypting. | auto-generated per DB |

## Tenant resolution

Each request is mapped to a tenant before auth:

1. **Non-production only:** an `X-Tenant` header or `?tenant=<slug>` query wins (for local
   dev / tests with no DNS).
2. **Sub-domain:** `acme.<APP_DOMAIN>` → tenant `acme`. The apex, `www`, an IP address,
   `localhost`, a reserved label, or any host when `APP_DOMAIN` is unset → the `default`
   tenant.
3. A non-`default` slug must exist in the catalog (else **404**) and not be
   `suspended`/`purged` (else **403**).

Wildcard DNS (`*.APP_DOMAIN → server`) and a wildcard TLS cert are an ops task, not code.
Custom domains (`inventory.acme.com`) are a later phase.

## Plans & quotas

Each tenant has a `plan` (`trial` / `starter` / `operations` / `complete`; the `default`
tenant is always `unlimited`). Limits — active users, inventory items, upload storage MB,
AI chats/month — are in `src/platform/plans.ts`. A `POST` that would exceed a limit gets a **402**
with an "upgrade the plan" message. `GET /api/tenant` returns the plan + limits + current
usage; the frontend shows a trial-countdown / past-due banner from it.

**Lifecycle:** a `trial` whose `trial_ends_at` has passed, or a `past_due` tenant, becomes
**read-only** — reads and login still work, every write returns 402 until the status is
cleared. `suspended` / `purged` → the whole workspace 403s.

## Feature modules

Which capability *areas* a workspace has switched on, independent of the quota numbers.
The toggleable modules (`src/shared/modules.ts`): `inventory`, `manufacturing`, `purchasing`,
`hr`, `accounting`, `ai`, `mobile`, `email`, `quickbooks`. Everything else — Home &
dashboards, Documents & file storage, Templates, Messages, user Admin, the Activity log —
is the always-on **core** and can't be turned off.

- **Default set comes from the plan** (`PLAN_MODULES` in `src/platform/plans.ts`): `starter` =
  inventory + purchasing + mobile; `operations` adds manufacturing + hr + email;
  `complete` / `trial` / `unlimited` = everything.
- **Per-tenant override** (`tenants.modules`, a JSON array) beats the plan default. Set it
  for one-off deals — "this customer only wants HR". Clear it to fall back to the plan.
- **Dependencies** are unioned in automatically: `manufacturing` and `purchasing` both
  require `inventory`, so enabling either pulls `inventory` in.
- **Enforcement** is in two places: `requireModule()` 402s the whole API area server-side,
  and the desktop/mobile nav hides what's off (from `modules` on `GET /api/tenant` and the
  auth payloads). The `default` tenant has every module — self-hosted is unaffected.

```
npm run tenant:modules -- --slug acme                          # show enabled / disabled + where the set comes from
npm run tenant:modules -- --slug acme --set inventory,hr       # explicit override (deps auto-added)
npm run tenant:modules -- --slug acme --add ai --remove email  # delta against the current effective set
npm run tenant:modules -- --slug acme --reset                  # drop the override → back to the plan default
```

## Owner console (`/_platform`)

A small web app for managing every workspace from a browser — the primary interface; the
CLI below does the same things headless.

1. **Enable it:** run the server with `PLATFORM_CONSOLE=true`.
2. **Make an operator** (separate from every tenant's users — a `platform_users` row can
   never sign into a workspace and a tenant token is rejected by the console):
   ```
   npm run platform:user -- --username owner --password s3cret --name "System Owner"
   npm run platform:user -- --list
   ```
   Or set `PLATFORM_ADMIN_USERNAME` / `PLATFORM_ADMIN_PASSWORD` and the first one is seeded on boot.
3. **Open** `https://<your-apex-domain>/_platform` (or `http://localhost:3000/_platform`
   in dev) and sign in. The console only answers on the apex / default host — requests
   that resolved to a tenant sub-domain 404. With `PLATFORM_HOST` set, it answers only on
   that host instead, and the host's root opens the console directly.

From there: a table of all workspaces (status, plan, module chips, live user/item counts),
a **New workspace** form, and a per-workspace editor for name, plan, status (+ trial end
date), and feature modules (a "use plan default" toggle, or a custom checkbox set with
dependencies auto-selected). **Import workspace** adopts an existing install's database
snapshot (`npm run backup` on that install) as a new tenant: the file is integrity-checked,
its login sessions are dropped, and it migrates on first open. Users, passwords and records
carry over; uploaded files do not. A danger-zone **Purge** requires typing the slug back. Every
change is written to `provisioning_log` and shown in the editor's activity list.

Hardening options: `PLATFORM_ADMIN_TOKEN` (a shared secret required as an `X-Platform-Token`
header on every API call), and front it with an IP allow-list / VPN at the reverse proxy.

## Provisioning (CLI)

The headless equivalent of the console — for scripts and servers with no browser access.

```
npm run tenant:create  -- --slug acme --name "Acme Mfg" --admin owner --password s3cret [--plan starter]
npm run tenant:list
npm run tenant:status  -- --slug acme --status suspended      # active | suspended | trial | past_due
npm run tenant:plan    -- --slug acme --plan operations       # trial | starter | operations | complete
npm run tenant:modules -- --slug acme --set inventory,hr      # feature modules (see above)
npm run tenant:usage   -- --slug acme                         # current counts vs the plan limits
npm run tenant:purge   -- --slug acme                         # deletes the tenant DB + uploads — irreversible
```

`create` makes the catalog row, creates + seeds `DATA_DIR/<slug>.db`, and sets the admin
login to the credentials you pass (not `ADMIN_PASSWORD`). Slugs must be 2–31 chars — a
letter then letters/numbers/hyphens — and not a reserved word.

## Self-serve sign-up

With `SIGNUPS_OPEN=true`, `POST /api/signup` (`{company_name, slug, admin_username,
admin_password, admin_email?}`) creates a `trial` tenant and returns
`{ slug, url }`. It's rate-limited (10/hour/IP). Leave it off to keep provisioning manual.

## Deploys

Each tenant DB migrates itself on first open after a release (a `schema_version` stamp
in `settings` skips the work when it's already current). To apply schema changes up front
across every tenant instead of on the first request:

```
npm run migrate:all
```

Run it as part of the deploy, after pulling the new release.

Migrations never wipe data. They add columns and tables, or rebuild a table by copying every row into it first. Before any database that already has data is migrated, it is snapshotted to
`BACKUP_DIR/<slug>/pre-migrate/<slug>-v<old>-to-v<new>-<timestamp>.db`. If that snapshot
can't be written, the migration **refuses to run** and the server doesn't start, so a release never
upgrades a database it can't roll back. (`BACKUP_BEFORE_MIGRATE=off` overrides this. Not
recommended.)

## Backups

Automatic (src/shared/backup.ts + src/platform/backups.ts). Nothing to set up for the defaults.

| What | When | Where (under `BACKUP_DIR`) | Kept |
|---|---|---|---|
| Every tenant DB (`default` = data.db) + `platform.db` (`_platform`) | Daily: at boot, then the first hourly check after midnight | `<name>/daily/<name>-YYYY-MM-DD.db` | Newest `BACKUP_KEEP_DAILY` (14) + the last one of each month for `BACKUP_KEEP_MONTHLY` (12) months |
| Same | Right before a schema migration | `<name>/pre-migrate/` | `BACKUP_KEEP_PREMIGRATE` (10) per DB |
| Same | `npm run backup` (manual) | `<name>/manual/` | 20 per DB |
| `UPLOAD_DIR` (images, attachments, photos) | With each daily/manual run | `uploads/` | Additive mirror; files deleted in the app are **not** deleted here, **except kiosk punch photos** (`kiosk-punches/`): when the app's photo retention deletes one, the backup copy goes too, locally and off-site, so employee photos never outlive the retention policy |

Snapshots use `VACUUM INTO`, which gives a consistent copy while the server is running, and
each one is integrity-checked before it's kept. `BACKUP_DIR/status.json` records the last run
and `last_success_at`. Failures are logged as `[backup] FAILED …`.

**Default location:** `db/backups/`, on the **same disk** as the live data. That protects
against bad migrations, mistakes, and corruption, **not** against losing the disk or the machine. For real
redundancy, set one or both:

- `BACKUP_DIR`: put the backups on another drive.
- `BACKUP_MIRROR_DIR`: a **second copy** of every snapshot and upload, for example a USB/NAS
  share or a folder synced by OneDrive / Google Drive / Dropbox, so a copy leaves the building.

- **Off-site buckets** (src/platform/offsite.ts): set `BACKUP_S3_<NAME>_BUCKET/_ENDPOINT/_KEY_ID/_SECRET`
  (+ optional `_REGION`, `_KEEP_DAYS`) for any number of S3-compatible buckets (Backblaze B2,
  Railway Buckets, R2, S3), plus `BACKUP_KEY`. Every daily snapshot and every upload is gzipped,
  AES-256-GCM encrypted with `BACKUP_KEY`, and sent hourly-if-new; failures are retried on the next
  run and recorded under `offsite` in `status.json`. **Lose `BACKUP_KEY` and the off-site copies
  are unreadable.** Setup walkthrough: [DEPLOY-RAILWAY.md](DEPLOY-RAILWAY.md) Part 4.

```
npm run backup                 # snapshot everything now
npm run backup:list            # what's on disk
npm run backup:restore -- default db/backups/default/daily/default-2026-09-23.db --yes
npm run backup:offsite -- test                     # prove each bucket + BACKUP_KEY work
npm run backup:offsite -- list b2 db/verdesakay/   # off-site snapshots of one tenant
npm run backup:offsite -- fetch b2 db/verdesakay/verdesakay-2026-09-23.db.gz.enc restored.db
npm run backup:offsite -- fetch-uploads b2 ./uploads-restored
```

**Restore:** stop the server first. The restore command checks the backup's integrity, snapshots the
current file to `<name>/pre-restore/` (so the restore can be undone), copies the backup over the live file, and removes the stale
`-wal`/`-shm` files. `<name>` is `default`, a tenant slug, or `_platform`. Restoring an
older-schema backup is fine: it's migrated (and snapshotted again) when the server starts.
Uploads are restored by copying files back from `BACKUP_DIR/uploads/`.

Test a restore now and then. A backup you've never restored from hasn't been proven to work.
