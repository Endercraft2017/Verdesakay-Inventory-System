# Deploying on Railway

This guide deploys the app as a multi-tenant SaaS on Railway under a sub-zone of your own
domain, leaving the main site alone. The worked example uses `afkcube.com`:

| Host | Serves |
|---|---|
| `afkcube.com`, `www.afkcube.com` | Your existing website — **not touched** |
| `admin.app.afkcube.com` | Owner console (you): create, import, suspend workspaces |
| `<slug>.app.afkcube.com` | Each customer's workspace, e.g. `verdesakay.app.afkcube.com` |

How the app supports this:

- **Proxy mode.** When `RAILWAY_ENVIRONMENT` is set (or `BEHIND_PROXY=true`), the server
  serves plain HTTP on `PORT` and trusts `X-Forwarded-*`, because Railway terminates HTTPS.
  Local installs keep their self-signed HTTPS.
- **Tenant hosts.** `APP_DOMAIN=app.afkcube.com` maps `<slug>.app.afkcube.com` to tenant `<slug>`.
- **Console host.** `PLATFORM_HOST=admin.app.afkcube.com` serves only the console, and the
  console is served nowhere else. (`admin` is a reserved slug, so no tenant can take it.)
- **Repo config.** `railway.json` sets the Railpack build, `npm start`, and a healthcheck on
  `/api/health`. `.node-version` pins Node 22 (`node:sqlite` needs ≥ 22.13).

---

## Part 1 — Deploy

### 1. Push the code
Commit and push the branch you want to run to GitHub.

### 2. Create the service
Railway → **New Project → Deploy from GitHub repo** → choose this repo, then under the
service's **Settings → Source** pick the branch.

**Region: Southeast Asia (Singapore, `asia-southeast1-eqsg3a`).** The users are in the
Philippines; every request pays the round trip to the server, and from the Philippines US West
cost 300–540 ms per request against ~100–170 ms for Singapore (measured 2026-10-10, when the
live service was moved there from `sfo`). The app itself answers in a few ms either way. A
service with a volume moves region only by migrating the volume (downtime while it copies):
take `npm run backup` + a Railway volume backup first, then change the region and redeploy.

Caching in front of the app: Cloudflare (orange cloud on `otom.afkcube.com`) compresses and,
for the desktop shell, caches the content-versioned `?v=<hash>` scripts/styles at its edge
(`src/shared/asset-version.ts`: those are `immutable`, everything else `no-cache`).

### 3. Add a volume (required)
SQLite lives on disk, so **without a volume every redeploy wipes all data.**
Service → right-click / **+ → Volume**, attach it to the service, mount path **`/data`**.

### 4. Set variables
Service → **Variables** → **Raw Editor**, paste, then fill in the `<…>` values:

```
NODE_ENV=production
TZ=Asia/Manila
DB_PATH=/data/db/data.db
DATA_DIR=/data/db/tenants
PLATFORM_DB_PATH=/data/db/platform.db
UPLOAD_DIR=/data/uploads
APP_SECRET=<long random string, keep it forever>
ADMIN_PASSWORD=<strong password>
PLATFORM_CONSOLE=true
PLATFORM_ADMIN_USERNAME=<your console username>
PLATFORM_ADMIN_PASSWORD=<strong console password>
APP_DOMAIN=app.afkcube.com
```

What each variable does:

- `TZ` is **required**. Railway servers run on UTC, but punches, late checks, payroll dates
  and the kiosk rules use the server's local time. Without `TZ`, the server refuses to start.
- `DB_PATH` / `DATA_DIR` / `PLATFORM_DB_PATH` / `UPLOAD_DIR` put every file on the volume.
  Backups land in `/data/db/backups` automatically.
- `APP_SECRET` encrypts saved SMTP/AI keys. Changing it later makes them unreadable.
- `ADMIN_PASSWORD` protects the unused `default` workspace, which is still reachable on the
  `*.up.railway.app` URL. Make it strong.
- `PLATFORM_ADMIN_*` create your console login on first boot. Setting them again later
  resets that password.
- Leave `PLATFORM_HOST` out for now. You add it in Part 2, once DNS works.
  Until then the console is at `https://<service>.up.railway.app/_platform`.
- Do **not** set `PLATFORM_ADMIN_TOKEN`; the console web page doesn't send it.

To generate a random secret: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

Optional variables: `AI_API_KEY` / `AI_BASE_URL` / `AI_MODEL`, `QBO_*` (QuickBooks). See
[SAAS-OPERATIONS.md](SAAS-OPERATIONS.md).

### 5. Get a Railway URL and check it
**Settings → Networking → Generate Domain.** Railway gives you a `https://<service>.up.railway.app` URL.

- `https://<service>.up.railway.app/api/health` should return `{"ok":true,…}`.
- `https://<service>.up.railway.app/_platform` should show the console login. Sign in with
  `PLATFORM_ADMIN_USERNAME` / `PLATFORM_ADMIN_PASSWORD`.

If the deploy fails, open **Deployments → View logs**. A healthcheck failure there usually
means the app crashed on boot, and the error is in the log just above.

---

## Part 2 — Connect the domain

Do this at whoever hosts DNS for `afkcube.com` (your registrar, or Cloudflare). **Leave the
existing `@` and `www` records alone.** Those keep pointing at your website.

### 6. Add the two custom domains in Railway
Service → **Settings → Networking → Custom Domain**, add each one:

1. `admin.app.afkcube.com`
2. `*.app.afkcube.com` (wildcard: every tenant)

For each one, Railway shows the DNS records it needs. They are typically:

| Type | Name (host) | Value |
|---|---|---|
| CNAME | `admin.app` | `<something>.up.railway.app` (as shown) |
| CNAME | `*.app` | `<something>.up.railway.app` (as shown) |
| CNAME | `_acme-challenge.app` | `authorize.railwaydns.net` (the wildcard's certificate check, if shown) |
| TXT | as shown | as shown (domain ownership check, if shown) |

Copy exactly what Railway displays; the table above only shows the typical shape.

**Using Cloudflare:** set these records to **DNS only** (grey cloud). Cloudflare's free
certificate doesn't cover two-level wildcards like `*.app.afkcube.com`, and proxying also
blocks Railway's own certificate.

Wait until Railway shows both domains as verified with a certificate issued. That usually
takes minutes, but DNS can take longer.

### 7. Lock the console to its host
Add the variable `PLATFORM_HOST=admin.app.afkcube.com`, then redeploy.

- `https://admin.app.afkcube.com` now opens the console.
- `/_platform` returns 404 on every other host, including the `up.railway.app` URL.

---

## Part 3 — Move your own company in as a tenant

### 8. Take a clean snapshot locally
On the office PC, in the project folder:

```
npm run backup
```

It prints the file it wrote, under `db/backups/default/…`. Use that file, not the live
`db/data.db`: the snapshot is a single self-contained file.

Before uploading, check the local data for leftover test records (fake employees, users or
payslips from test runs). An import copies everything.

### 9. Import it in the console
`https://admin.app.afkcube.com` → **Import workspace** → choose the snapshot file.
Fill in:
- slug: `verdesakay`
- company name
- plan: `complete`

Then click **Import**.

The file is integrity-checked, old login sessions are cleared, and the database migrates to
the current schema. Everyone keeps their usernames and passwords.

### 10. Use it
Open `https://verdesakay.app.afkcube.com` and log in as usual. Phones use
`https://verdesakay.app.afkcube.com/m`. This is real HTTPS, so the QR camera works with no
certificate warning.

What doesn't carry over:
- **Uploaded files** (attachments, item images, form files). They live in `uploads/`, not
  the database. Re-attach the ones you need.
- **Saved SMTP / AI keys.** They were encrypted with the local install's key, and the
  server uses `APP_SECRET`. Re-enter them in the workspace settings.

## New customers
In the console, use **New workspace**. Pick a slug, such as `acme`, and the customer's
workspace is live at `https://acme.app.afkcube.com` right away. The wildcard DNS already
covers it, so there's nothing to add per customer.

---

## Part 3b — Time-in on the internet

On the office network, the kiosk and phone time-in could only be used at the office. Once the
app is on the internet, two things keep it that way:

1. **Approve the kiosk PC.** On the office PC that runs the Time-in Kiosk, sign in as an HR
   manager and open HR → Time Keeping → Time-in Kiosk. It asks you to **approve this PC**.
   Until you do, the kiosk won't show its QR or accept typed employee numbers. That's the
   default on a hosted server, so nobody can clock people in from home. You can review and
   revoke PCs in Time Keeping → Policy Settings → Kiosk devices.
2. **Lock phone time-in to the office.** Time Keeping → Policy Settings → **Set office
   locations**: stand in the office and press "Use this device's location" (or paste
   coordinates from Google Maps), keep the radius around 150 m, and tick "Only allow phone
   time-in at an office location".
3. **Mark field staff.** On each driver's or sales rep's Employee record (Rules → Exemptions),
   tick **Can time in outside the office**. They get a "Clock in here" button that works
   without the QR and saves their location.

Review punches any time in Time Keeping → **Punch Log**. It shows each phone punch's office
or distance, with a map link.

### Cutting over
Once your company is imported, stop using the office server. Nothing merges data back from
it. Point every PC to `https://<slug>.app.afkcube.com`, and on phones open
`https://<slug>.app.afkcube.com/m` and add it to the home screen again.

---

## Part 4 — Off-site backups (Railway bucket + Backblaze B2)

The server already snapshots every database daily to `/data/db/backups`, but that's on the
same volume as the live data. These steps add encrypted copies in two buckets:

| Bucket | Purpose | Old snapshots removed by |
|---|---|---|
| Railway bucket | Fast copy next to the app | the app (`KEEP_DAYS=30`) |
| Backblaze B2 (free 10 GB) | Copy outside Railway | B2's lifecycle rule (90 days) |

Each daily snapshot and each uploaded file is compressed and encrypted with `BACKUP_KEY` before
it leaves the server. New files are sent within the hour, and anything that failed is retried
on the next hourly run.

Uploaded files are kept in the buckets even if they're deleted in the app, so a mistake can
be undone. The exception is kiosk punch photos: when the app's photo retention deletes one
(default 60 days / 300 MB per tenant), its bucket copies are deleted too.

### 11. Backblaze B2
1. Bucket `afkcube-erp-backup`: private, default encryption on, Object Lock off.
2. **Lifecycle Settings → custom rule with file name prefix `db/`**: hide after 90 days,
   delete 1 day after hiding. The `db/` prefix matters. Without it, uploaded files, which
   are sent only once, would be deleted after 90 days too.
3. **Application Keys → Add a New Application Key**: allow access to this bucket only,
   Read and Write. Copy the **keyID** and **applicationKey** (it's shown once).

### 12. Railway bucket
In the project: **+ New → Bucket**. Open it → **Credentials** tab for the endpoint, bucket
name, region, access key and secret.

### 13. Variables on the app service
```
BACKUP_KEY=<long random string: save it in your password manager>

BACKUP_S3_B2_BUCKET=afkcube-erp-backup
BACKUP_S3_B2_ENDPOINT=https://s3.us-east-005.backblazeb2.com
BACKUP_S3_B2_KEY_ID=<B2 keyID>
BACKUP_S3_B2_SECRET=<B2 applicationKey>

BACKUP_S3_RAILWAY_BUCKET=<bucket name from Credentials>
BACKUP_S3_RAILWAY_ENDPOINT=<endpoint from Credentials>
BACKUP_S3_RAILWAY_REGION=<region from Credentials>
BACKUP_S3_RAILWAY_KEY_ID=<access key id>
BACKUP_S3_RAILWAY_SECRET=<secret access key>
BACKUP_S3_RAILWAY_KEEP_DAYS=30
```
**`BACKUP_KEY` is the only way to read these backups.** If it's lost, so are the off-site
copies. Keep it outside Railway too.

### 14. Check it works
After the redeploy, the deploy log should show a line like
`[backup] off-site "b2": 2 snapshot(s), … sent`. Then check that the B2 bucket shows files
under `db/`. From the service shell (`railway ssh`) you can also run
`npm run backup:offsite -- test`, which round-trips a test file through each bucket.

### Restoring from off-site
In the service shell:
```
npm run backup:offsite -- list b2 db/verdesakay/
npm run backup:offsite -- fetch b2 db/verdesakay/verdesakay-2026-09-30.db.gz.enc /data/restore.db
```
Then stop the app and swap the file in with `npm run backup:restore -- verdesakay /data/restore.db --yes`.
Uploaded files: `npm run backup:offsite -- fetch-uploads b2 /data/uploads-restored`.
You can do the same from a PC by setting the same `BACKUP_S3_*` and `BACKUP_KEY` variables
there first.
