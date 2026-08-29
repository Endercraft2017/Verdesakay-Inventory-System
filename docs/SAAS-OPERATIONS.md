# SaaS Operations

How to run the system for multiple companies (tenants). For the architecture and the
remaining phases, see [SAAS-READINESS.md](SAAS-READINESS.md). Single-tenant / self-hosted
installs can ignore this file entirely — with no `APP_DOMAIN` set, everything runs as the
one `default` tenant, exactly as before.

## Data model

- **One SQLite file per tenant.** The `default` tenant lives at `DB_PATH` (`data.db`);
  every other tenant is `DATA_DIR/<slug>.db`, created on first use.
- **`platform.db`** (`PLATFORM_DB_PATH`) is the control plane — the `tenants` catalog and
  `provisioning_log`. It is **not** a tenant database and is never reachable from
  tenant-facing request code.
- Uploaded files: `UPLOAD_DIR` for `default`; `UPLOAD_DIR/<slug>/` per tenant (rolling out
  with SAAS-READINESS phase 3).

## Environment

| Var | Purpose | Default |
|---|---|---|
| `APP_DOMAIN` | Root domain for tenant sub-domains, e.g. `verdesakay.app`. **Empty ⇒ single-tenant** (host is ignored; only the `default` tenant). | *(empty)* |
| `PLATFORM_DB_PATH` | The control-plane DB file. | `<root>/platform.db` |
| `DATA_DIR` | Where non-`default` tenant DB files live. | `<root>/data` |
| `DB_PATH` | The `default` tenant's DB file. | `<root>/data.db` |
| `UPLOAD_DIR` | Uploaded files. | `<root>/uploads` |
| `SIGNUPS_OPEN` | `"true"` makes `POST /api/signup` live (self-serve tenant creation). Anything else ⇒ 404; you provision manually. | *(off)* |
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

## Provisioning (CLI)

```
npm run tenant:create -- --slug acme --name "Acme Mfg" --admin owner --password s3cret [--plan starter]
npm run tenant:list
npm run tenant:status -- --slug acme --status suspended       # active | suspended | trial | past_due
npm run tenant:purge  -- --slug acme                          # deletes the tenant DB + uploads — irreversible
```

`create` makes the catalog row, creates + seeds `DATA_DIR/<slug>.db`, and sets the admin
login to the credentials you pass (not `ADMIN_PASSWORD`). Slugs must be 2–31 chars — a
letter then letters/numbers/hyphens — and not a reserved word.

## Self-serve sign-up

With `SIGNUPS_OPEN=true`, `POST /api/signup` (`{company_name, slug, admin_username,
admin_password, admin_email?}`) creates a `trial` tenant and returns
`{ slug, url }`. It's rate-limited (10/hour/IP). Leave it off to keep provisioning manual.

## Backups

Per-tenant and trivial because each tenant is a file:

```
sqlite3 DATA_DIR/acme.db "VACUUM INTO 'backups/acme-$(date +%F).db'"
```

Snapshot `platform.db` the same way. Then push `backups/` to object storage. Restoring one
tenant = swap its file.
