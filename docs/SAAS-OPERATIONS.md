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
| `APP_DOMAIN` | Root domain for tenant sub-domains, e.g. `verdesakay.app`. **Empty ⇒ single-tenant** (host is ignored; only the `default` tenant). | *(empty)* |
| `PLATFORM_DB_PATH` | The control-plane DB file. | `<root>/db/platform.db` |
| `DATA_DIR` | Where non-`default` tenant DB files live. | `<root>/db/tenants` |
| `DB_PATH` | The `default` tenant's DB file. | `<root>/db/data.db` |
| `UPLOAD_DIR` | Uploaded files. | `<root>/uploads` |
| `SIGNUPS_OPEN` | `"true"` makes `POST /api/signup` live (self-serve tenant creation). Anything else ⇒ 404; you provision manually. | *(off)* |
| `PLATFORM_CONSOLE` | `"true"` mounts the owner console at `/_platform`. Anything else ⇒ the whole path 404s. | *(off)* |
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
   that resolved to a tenant sub-domain 404.

From there: a table of all workspaces (status, plan, module chips, live user/item counts),
a **New workspace** form, and a per-workspace editor for name, plan, status (+ trial end
date), and feature modules (a "use plan default" toggle, or a custom checkbox set with
dependencies auto-selected). A danger-zone **Purge** requires typing the slug back. Every
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

## Backups

Per-tenant and trivial because each tenant is a file:

```
sqlite3 DATA_DIR/acme.db "VACUUM INTO 'backups/acme-$(date +%F).db'"
```

Snapshot `platform.db` the same way. Then push `backups/` to object storage. Restoring one
tenant = swap its file.
