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
  `/api/health`. `.node-version` recommends Node 24.22.1. Compatibility floors are
  22.22 within 22.x or 24.19 within 24.x, with required SQLite capabilities checked before
  app data access. Run `npm run runtime:check` on the built host; this file does not prove the
  host selected the pin. See [runtime support](operations/runtime-support.md).

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
  Backups land in `/data/db/backups` automatically. Part 6 moves uploads into a bucket, with
  `UPLOAD_DIR` as a cache.
- Accepted uploads and offline sync blobs also keep a recoverable copy in the tenant database
  (billing proofs and the GCash QR in `platform.db`). If an upload file disappears, the
  authorized download restores it from the database or upload backup. The v66 migration copies surviving
  older files into those databases; bytes missing from both the upload folder and backups
  cannot be reconstructed. Budget volume and backup capacity for both file and database
  copies, and keep the database backup schedule enabled — or turn on the file bucket (Part 6),
  which holds that copy instead and moves the existing ones out of the databases.
- `APP_SECRET` encrypts saved SMTP/AI keys. Changing it later makes them unreadable.
- `ADMIN_PASSWORD` protects the unused `default` workspace, which is still reachable on the
  `*.up.railway.app` URL. Make it strong.
- `PLATFORM_ADMIN_*` create your console login on first boot. After that they're ignored, so a
  password you change in the console (**Change password**, top right) sticks. To reset a forgotten
  one, also set `PLATFORM_ADMIN_RESET=true` and redeploy, then remove it again.
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

## Part 5 — Backup safety settings (do once)

The app already snapshots daily, copies off-site, runs a restore drill every 30 days and checks
backup health every hour (`src/platform/backup-health.ts`). These settings live outside the
code, in the Railway and Backblaze dashboards. Do them in this order.

### 15. Get backup alerts on your phone (5 min)
Uses [ntfy](https://ntfy.sh): free, no account needed.
1. Install the **ntfy** app (Play Store / App Store).
2. In the app tap **+** and subscribe to a topic with a long random name nobody can guess,
   e.g. `vds-backups-7f3k9q2m8x`. Anyone who knows the name can read it, so treat it like a password.
3. Railway → the app service → **Variables** → **New Variable**:
   `BACKUP_ALERT_WEBHOOK` = `https://ntfy.sh/vds-backups-7f3k9q2m8x` (your topic). Railway redeploys.
4. Test it: in a terminal in this repo, `railway ssh`, then
   `npm run backup:health -- --test-alert`. Your phone should buzz within seconds.

Discord or Slack work too: paste the channel's *incoming webhook* URL instead. You'll get one
message when something breaks (repeated every 12 h while it stays broken) and one when it recovers.

### 16. Turn on Railway's own volume backups (2 min)
These snapshot the whole volume (databases and uploads) on Railway's side, separate from the app.
1. Railway → project **ERP** → click the **volume** under the app service
   (`verdesakay-inventory-system-volume`) → **Backups** tab.
2. Under the schedule, tick **Daily**, **Weekly** and **Monthly** → save.
3. A manual backup is also there (**Backup now**). Take one before any risky change, e.g. moving
   region. To restore: pick a backup → **Restore** (the app goes down briefly; restoring replaces
   the volume's current contents, so take a fresh manual backup first).

### 17. Protect the off-site copies from deletion (10 min)
The server holds a Backblaze key. If the server or the Railway account were ever compromised,
whoever has that key could delete the off-site copies too. Object Lock stops that: locked copies
can't be deleted by anyone until their lock runs out.
1. Backblaze → **Buckets** → `afkcube-erp-backup` → **Bucket Settings** → **Object Lock** →
   **Enable**, default retention **Compliance**, **30 days** → save.
   (Compliance can't be shortened later, even by you. Start with 30 days.)
2. Same bucket → **Lifecycle Settings** → **Keep prior versions for this number of days**: `30`.
   This removes old and hidden versions after the lock ends, so storage doesn't grow forever and
   deleted punch photos really go away (30 days later than in the app).
3. Check it still works: `railway ssh`, then `npm run backup:offsite -- test` and
   `npm run backup:drill`. Both should finish with ✓.

Optional, stronger: replace the app's key with one that can't delete at all. The Backblaze website
can't create that kind of key; the `b2` command-line tool can:
`b2 key create --bucket afkcube-erp-backup vds-app listBuckets,listFiles,readFiles,writeFiles`.
Put the new key ID and key in `BACKUP_S3_B2_KEY_ID` / `BACKUP_S3_B2_SECRET`, then delete the old
key in Backblaze → **Application Keys**.

### 18. Keep the backup key somewhere safe (2 min)
Without `BACKUP_KEY`, the off-site copies can never be decrypted, and if you lost the Railway
account you'd lose the key with it.
1. Railway → app service → **Variables** → `BACKUP_KEY` → reveal and copy it.
2. Save it in your password manager as "Verdesakay off-site backup key", and keep a second copy
   offline (printed, in a safe). Never put it in the repo or a chat.

### 19. Check everything (1 min)
`railway ssh`, then:
```
npm run backup:health     # "Backups are healthy." or a list of problems
npm run backup:drill      # restores every off-site copy into a temp file and checks it
```
The owner console (`/_platform`) shows each workspace's last backup and whether its last restore
drill passed.

### 20. Give the owner console its own address (10 min)
Today the console runs at `otom.afkcube.com/_platform`, the same site as every company, so its
sign-in sits in the same browser storage as theirs. On its own sub-domain the browser keeps the two
completely apart.
1. Railway → app service → **Settings** → **Networking** → **Custom Domain** → add
   `console.afkcube.com`. Railway shows a **CNAME target**; copy it.
2. Cloudflare → `afkcube.com` → **DNS** → **Add record**: type **CNAME**, name `console`,
   target = the value from Railway, proxy **on** (orange cloud) → save. Wait until Railway shows the
   domain as active.
3. Railway → **Variables** → add `PLATFORM_HOST` = `console.afkcube.com` → Railway redeploys.
4. Open `https://console.afkcube.com/_platform` and sign in again. `otom.afkcube.com/_platform`
   now answers "Not found", which is intended.

### 21. Turn on two-step sign-in (5 min)
1. Sign in to the company app → **Account** → **Two-step sign-in** → **Turn on**. Scan the QR code
   with an authenticator app (Google Authenticator, Microsoft Authenticator, Authy, 1Password),
   type the code, and **save the 10 recovery codes** (password manager or printed).
2. **Accounts & Roles** → **Sign-in security** → tick **Require two-step sign-in** → Save. From
   then on every admin and anyone who manages accounts, payroll or accounting must set it up at
   their next sign-in (on desktop or phone) before they can use the app. You can only switch this on
   after step 1, so you can never lock yourself out.
3. Lost phone: an admin opens **Accounts & Roles**, finds the person (badge **2-step**) and clicks
   **Reset 2-step**; they sign in with their password and set it up again. A recovery code also works.

Installed office PCs sign in with the password alone; two-step sign-in applies online.

Owner console password: sign in to the console → **Change password** (top right). That signs out
your other console sessions. `PLATFORM_ADMIN_USERNAME` / `PLATFORM_ADMIN_PASSWORD` only create the
first login and no longer overwrite it, so once you've changed it, delete both from Railway: they
still hold your old password in plain text.

### Settings you can change
| Variable | Default | What it does |
|---|---|---|
| `BACKUP_ALERT_WEBHOOK` | none | Where problem / recovery alerts go (ntfy, Discord, Slack) |
| `BACKUP_DRILL_DAYS` | 30 | Days between restore drills (a failed drill retries the next day) |
| `BACKUP_STALE_HOURS` | 26 | Alert when a database has no snapshot / no off-site copy for this long |
| `BACKUP_KEEP_HOURLY` | 48 | Hourly snapshots kept per database (also off-site); `0` turns them off |
| `BACKUP_HOURLY_STALE_HOURS` | 3 | Alert when hourly snapshots haven't succeeded for this long |
| `BACKUP_ALERT_REPEAT_HOURS` | 12 | Repeat an unresolved alert this often |
| `ACTIVITY_LOG_RETENTION_DAYS` | 1827 (5 years) | How long the audit trail is kept (minimum 31) |
| `CLIENT_IP_HEADER` | `x-real-ip` on Railway, none elsewhere | Header holding the visitor's IP (rate limits, sign-in history). Only set it to a header your edge proxy overwrites |
| `CSP_MODE` | `enforce` | Content-Security-Policy: `report` only logs violations in the browser, `off` removes it. Emergency switch if a screen ever breaks |

---

## Part 6 — Uploaded files in the Railway bucket

Without this, every uploaded file (item photos, punch photos, 201 documents, attachments, chat
files) is on the volume twice: the file itself, and a recoverable copy inside the company's
database (which every hourly backup then copies again). With it, the bucket holds the
recoverable copy instead, and the volume only keeps a short-term cache.

- New uploads go to the bucket straight away, encrypted. Their bytes no longer go into the
  database.
- Copies the databases already hold move to the bucket in batches, a minute apart. Then each
  database is compacted once, so the volume and the backups get smaller. Installed PCs keep
  their own copies.
- A file nobody opened for `FILES_CACHE_DAYS` (default 7) is removed from the volume. The next
  time someone opens it, the server fetches it back from the bucket. The same applies if a
  file disappears from the volume for any other reason: the bucket copy is kept.
- Deleting a file in the app deletes it from the bucket too.
- Punch photos always stay on the volume as well: their retention (60 days / 300 MB per
  company) needs them there. When retention deletes one, the bucket copy goes too.
- Plain-text files (`.txt`, `.md`, `.csv`, `.json`, `.log`) also stay on the volume, so the AI
  assistant can always search their contents. They're small.

### 22. Variables on the app service
This reuses the Railway bucket from step 12:
```
FILES_S3_FROM=railway
```
- That's all you need. It uses the `BACKUP_S3_RAILWAY_*` credentials. Files go under `files/`
  in that bucket, apart from the backups' `db/` and `uploads/`.
- Files are encrypted with `BACKUP_KEY`. To use a separate key, set
  `FILES_KEY=<long random string>`, and keep it in your password manager like `BACKUP_KEY`.
  **If the key is lost, the files in the bucket can't be read.**
- To use a different bucket instead, set `FILES_S3_BUCKET`, `FILES_S3_ENDPOINT`,
  `FILES_S3_KEY_ID`, `FILES_S3_SECRET` (and `FILES_S3_REGION` if needed) in place of
  `FILES_S3_FROM`.
- With this on, the daily backup stops copying uploads to `/data/db/backups/uploads`, which
  would only fill the volume again. The off-site copies (`uploads/` in each backup bucket) keep
  files deleted in the app recoverable.

### 23. Check it works
After the redeploy, the deploy log shows
`[files] uploads are stored in the bucket under "files/", cached on disk for 7 day(s)`.
Within a minute you should also see `[files] N sent, …` (the first run copies every existing
upload), then `[files] <company>: moved N file(s) (… MB) from the database to the bucket` until
it's done, and `[files] <company>: database compacted`. If it says `[files] sync FAILED`, the
message says why (usually a credential), and the next minute retries.
