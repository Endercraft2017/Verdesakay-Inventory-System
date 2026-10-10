# Security audit — 2026-10-10

**Scope:** the deployed code (`restructure/module-architecture` @ `804bf12`) and the live site
`otom.afkcube.com` (Railway, Singapore, behind Cloudflare). Report only: no product code was changed.

**Standards:** OWASP ASVS 5.0 (Level 2: apps holding personal and payroll data), OWASP Top 10:2021,
OWASP API Security Top 10:2023, OWASP Top 10 for LLM Applications 2025 (AI assistant).

**Method:** code review of every route file, the auth, session, upload, file-serving, crypto,
logging, WebSocket, sync and AI code, the frontend HTML sinks (pattern scan), and the Electron shell.
`npm audit`. Suspected issues were reproduced against a throwaway local copy (temporary database,
synthetic users). Live checks on production were read-only: headers, Railway variable *names*, a
harmless HTML marker on one endpoint, and sign-in IPs from this morning's local backup copy.

## Summary

| Severity | Count | Items |
|---|---|---|
| High | 3 | H1 reflected XSS → account and owner-console takeover · H2 unauthenticated database creation · H3 vulnerable dependencies |
| Medium | 6 | M1 wrong client IP · M2 weak authentication · M3 missing CSP/HSTS · M4 AI agency · M5 AI key in audit log · M6 owner console on tenant origin |
| Low | 10 | L1–L10 |

Fix order: H1 and M6 first (one link click away from full takeover), then H2, H3 and M1, then M2 and M3.

## High

### H1 — Reflected XSS in the QuickBooks OAuth callback (confirmed on production)
`GET /<tenant>/api/quickbooks/callback?error=…` is public and writes `error` into an HTML page
unescaped (`src/modules/quickbooks/quickbooks.routes.ts:25-33`). On production,
`?error=AUDIT<b>marker</b>` came back as raw HTML. There is no Content-Security-Policy (M3).

**Impact:** anyone who gets a signed-in user to open a crafted link runs script on
`otom.afkcube.com`. That origin holds every company's bearer token *and* the owner-console token
in `localStorage` (M6), so one click by an admin or the owner gives full account or platform takeover.
OWASP A03 Injection; ASVS V1 encoding.

**Fix:** HTML-escape every value written into that page (or render a static page and pass the
message as text). Add a CSP (M3) and move the console to its own host (M6).

### H2 — Unauthenticated creation of tenant databases (confirmed locally)
The same callback takes the company slug from the `state` parameter and runs `withTenant(slug)` →
`getDb(slug)` *before* checking that the tenant exists. `getDb` creates, migrates and seeds a new
SQLite database (with an `admin` account) for any name. Confirmed locally: `state=auditprobe.nonce`
created `db/tenants/auditprobe.db`. Escaping the data folder is blocked (any `..` contains the `.`
the code splits on), but sub-folders can be created. Not reproduced on production, because doing so
would write to the production volume.

**Impact:** an anonymous attacker can create unlimited databases (~1 MB each, plus migration CPU)
on the same 50 GB volume as the live data. Filling it takes the whole service down. API4
Unrestricted Resource Consumption.

**Fix:** validate the slug with `isValidSlug()` and require `getTenant(slug)` to exist (and be
active) before opening anything. More generally, `getDb()` should never create a database for a
slug that the platform catalog doesn't know (only provisioning should).

### H3 — Known-vulnerable dependencies (`npm audit`, production deps: 1 critical, 4 high, 3 moderate)
| Package | Severity | Reachable here? |
|---|---|---|
| multer ≤2.3.0 (5 DoS / limit-bypass advisories) | high | **Yes, unauthenticated**: anonymous-report photo uploads use multer |
| nodemailer ≤10.0.5 (address-parser DoS, recipient-domain bypass) | high | Partly: addresses come from staff and admins |
| express 4.22.2 / body-parser / qs (DoS) | moderate | Yes, every request |
| proxy-addr (IP spoofing via IPv4-mapped IPv6 *trust subnet*) | critical | Not with the current hop-count `trust proxy` setting, but update anyway |
| ip-address (SSRF classifiers) | high | Indirect dependency; the link-preview guard uses its own classifier |
| node-forge (signature verification) | high, no fix | No: used only to *generate* LAN certificates |

**Fix:** `npm update multer nodemailer express` (all have fixes), re-run `npm audit`, run the suite.
Add `npm audit --omit=dev` to the release checklist.

## Medium

### M1 — The app records Railway's edge, not the user, as the client IP (confirmed from data)
`trust proxy` is `1`, but production has two proxy hops (Cloudflare, then Railway's edge). Every
sign-in in the last 10 days, across three accounts and both desktop and Android, recorded one of a few
Datacamp addresses in Singapore and Hong Kong (152.233.x / 79.127.228.x), which are Railway's edge locations.
**Impact:** the login limiter (20 tries / 15 min) and the anonymous-report limiters are shared by
*everyone*: one person can lock all users out of sign-in for 15 minutes. Sign-in history and the
audit log show the wrong IPs. **Fix:** log `X-Forwarded-For` once on production, then set the
correct hop count (likely `2`), or take the client IP from Cloudflare's `CF-Connecting-IP` when the
request comes from Cloudflare.

### M2 — Authentication below ASVS 5.0 Level 2 (confirmed)
- Minimum password length is 6 (ASVS: ≥ 8, 15 recommended); no check against breached or common
  passwords (`123456` was accepted).
- No multi-factor authentication for anyone, including admins, payroll and the owner console
  (required at ASVS L2).
- No per-account throttling, only the per-IP limiter (which M1 breaks).
- A new database's `admin` gets `ADMIN_PASSWORD`, or `admin123` when it isn't set (self-hosted PCs),
  with no forced change at first sign-in.
**Fix:** 8+ characters and a top-10k common-password block now; TOTP for admin, payroll and
owner-console accounts next; force a password change for seeded accounts.

### M3 — No Content-Security-Policy, HSTS or Permissions-Policy
Helmet runs with `contentSecurityPolicy: false, hsts: false`. Present and good: `X-Frame-Options`,
`nosniff`, `Referrer-Policy: no-referrer`, COOP and CORP. Without CSP, any injection (H1) runs
freely. **Fix:** HSTS on the cloud host (or at Cloudflare). CSP needs the inline scripts moved to
files first: start with a report-only policy, then enforce. Add a minimal `Permissions-Policy`.

### M4 — AI assistant can act without confirmation (LLM01 prompt injection, LLM06 excessive agency)
Tools are correctly limited to the caller's own permissions, but data-changing tools
(`delete_inventory_item`, `adjust_stock`, `delete_order`, `create_user`, `update_user`,
`send_message`) execute immediately. Text the assistant reads (messages, item descriptions, notes)
can carry instructions it then acts on with the user's rights. **Fix:** show the user a
confirm-before-run card for any data-changing tool. Keep delete and user tools behind it always.

### M5 — The AI provider key is written to the activity log in plain text (confirmed)
The key is encrypted where it is stored (`ai-config.ts`), but `PUT /api/ai/config` is recorded with
its body, and the redaction pattern (`/pass|password|token|secret|hash|otp|\bpin\b/`) misses
`api_key`. Anyone with `audit.view`, and every backup, sees it. **Fix:** add `key` and `api_key` to the
pattern, scrub existing `activity_log` rows, and rotate the key.

### M6 — Owner console shares the tenants' origin
`PLATFORM_HOST` is not set, so `/_platform` runs on `otom.afkcube.com` and keeps its token in the
same `localStorage` as every tenant. Any script injection in any tenant reaches the platform
token. Password-only sign-in, 12-hour session, optional `PLATFORM_ADMIN_TOKEN` not set.
**Fix:** set `PLATFORM_HOST` to a separate sub-domain (already supported by `src/app.ts`), set
`PLATFORM_ADMIN_TOKEN` or a Cloudflare Access rule in front of it, add MFA (M2).

## Low

| # | Finding | Evidence | Fix |
|---|---|---|---|
| L1 | "Forgot password" reveals whether an account exists, and isn't rate limited (account discovery, email flooding) | Confirmed: different `reason` for existing vs. missing accounts | Same answer for both; add a limiter |
| L2 | Session tokens are stored unhashed (a database copy = live sessions) | Confirmed. Sync tokens *are* hashed | Store SHA-256 of the token, as `sync_nodes` does |
| L3 | Reset link built from the request `Host` header; lacks the tenant path; tokens not invalidated together; check-then-use not atomic | Code (`auth.routes.ts`) | Build from configured base URL + tenant; single `UPDATE … WHERE used = 0` |
| L4 | Chat attachments: any file type, served `inline` with the uploader's MIME type (HTML came back as `text/html`) | Confirmed. Not exploitable through the UI (downloads only) or by URL (needs the auth header) | Allow-list types; `Content-Disposition: attachment` for non-images |
| L5 | Idempotency replay is keyed by key alone and runs before auth | Code (`idempotency.ts`) | Scope to user + method + path; check after auth |
| L6 | WebSocket token travels in the URL (`?token=`), so it can appear in proxy logs | Code (`ws.ts`) | Short-lived one-time ticket from an authed call |
| L7 | No idle timeout for normal sessions (12 h absolute only) | Code | Idle timeout (e.g. 60 min) for desk sessions with payroll/admin rights |
| L8 | Link-preview SSRF guard misses 100.64.0.0/10 and is open to DNS rebinding (resolve, then fetch) | Code (`messages.routes.ts:536`) | Add the range; connect to the resolved IP |
| L9 | 10 MB JSON bodies accepted before auth on every route | `app.ts` | Small default limit; raise per route |
| L10 | Desktop app opens any non-local link with `shell.openExternal` (any URL scheme) | `electron/main.cjs:169` | Only `https:`/`http:`; add a `will-navigate` guard |

Also noted, by design: template bodies are raw HTML written by template managers (stored HTML from
a privileged role), and login timing differs slightly for unknown usernames.

## Passed (checked and found sound)
- **Secrets in the repo:** none tracked or in history; `api_key.md`, `.env`, `certs/`, databases
  ignored. The only key-like string is AWS's documented example in a test.
- **Password storage:** bcrypt, cost 10.
- **Access control:** a blanket `requireAuth` on every router. Server-side permission checks
  (45 route files). Ownership checks on payslips, notes, tasks and notifications (others' payslips
  return 404, so their existence doesn't leak). No self-approval. The sync admin routes need
  `users.manage`. Unauthenticated routes are only the intended ones (login, reset, anonymous reports, the
  QuickBooks callback, sign-up when open, owner-console login, health).
- **Company isolation:** one database per company; tokens are rejected across companies; WebSocket
  checks token and company.
- **Injection:** 159 validation schemas; all 748 queries parameterized; no request input inside
  SQL text; no `eval` or `new Function` on user data.
- **Frontend XSS:** shared helpers escape (`UI.esc`, `confirmDialog`, `showErr`, document
  templates escape merged values). The pattern scan found no unescaped user field. *Partial:*
  886 HTML sinks were scanned by pattern, not each read by hand.
- **CSRF:** not applicable; auth is a bearer header, not a cookie.
- **Encryption:** HTTPS only (HTTP redirects), AES-256-GCM for stored SMTP, AI and QuickBooks
  secrets with `APP_SECRET` set; off-site backups encrypted with `BACKUP_KEY`.
- **OAuth:** QuickBooks `state` carries a 10-minute nonce (CSRF-safe), apart from H1 and H2.
- **Uploads:** size limits everywhere; image-only allow-lists for photos; stored names are random.
  File serving resolves names from the database (no user path input).
- **Errors and logging:** 5xx messages hidden; the audit log redacts passwords, tokens and secrets
  (apart from M5). The anonymous-report path keeps no identity.
- **Desktop app:** `contextIsolation` on, narrow preload bridge, certificate pinned for localhost.
- **Hosting:** only the custom domain is public (no `*.up.railway.app` bypass); sign-up is closed.

## Not tested
- **Cloudflare settings** (SSL mode "Full (strict)", WAF, Bot Fight): no dashboard access. Check
  that SSL/TLS mode is **Full (strict)**.
- **Live attacks:** login lockout, H2 and upload DoS were not run on production, to avoid harming it.
- **Business-logic races** (stock, payroll double-posting), the Android/iOS app builds, a backup
  restore drill, and a line-by-line review of every frontend HTML sink.

## Backups, data security and integrity (added 2026-10-10)

**Live checks:** backup folders and the Backblaze B2 bucket were listed on production (read-only).
**Restore drill:** last night's off-site copy (`db/verdesakay/verdesakay-2026-10-10.db.gz.enc`) was
downloaded on the server, decrypted into `/tmp` and checked (integrity `ok`, 114 tables, 57
employees, same latest time punch as live), then deleted.

### Working
- **Daily snapshots** of every database (`VACUUM INTO`, consistent while the app runs), each
  integrity-checked before it's kept; 14 daily + 12 month-end copies. Pre-migration snapshots, and
  a migration refuses to run if its snapshot fails. Manual snapshots via `npm run backup`.
- **Off-site:** gzip + AES-256-GCM copies to Backblaze B2 every day (databases) plus the uploads
  folder; present for every database and all 4 upload files. **The restore works.**
- **Restore tool:** checks the backup's integrity and snapshots the current file before replacing it.
- **Crash safety:** SQLite runs in WAL mode with `synchronous = FULL` (the safest setting);
  foreign keys on.
- **Atomic changes:** 85 explicit transactions. Every stock change goes through one helper that
  keeps the item total, per-location stock and the movement ledger in step, and stock can't go
  negative (except an offline-synced stock-out, which is flagged for review).
- **Tamper-resistant records:** a posted journal entry can't be edited or deleted (void/reverse
  only); HR requests can't be deleted; mobile retries can't double-post (idempotency keys).

### Gaps
| # | Severity | Finding | Fix |
|---|---|---|---|
| B1 | Medium | **Up to 24 h of data can be lost.** Snapshots are daily, and the on-volume copies sit on the same disk as the live data. Railway's own scheduled volume backups are **off** (only 2 manual ones exist). | Turn on Railway scheduled backups (daily + weekly). Send off-site every 1–4 h, or stream changes continuously (Litestream, the standard tool for SQLite) for minutes of loss instead of a day. |
| B2 | Medium | **Off-site copies can be deleted by anyone who gets the server's B2 key** (the runbook leaves Object Lock off). A compromised server or Railway account could wipe live data *and* backups. | B2 application key without `deleteFiles`; enable Object Lock (or a 30-day lifecycle "hide, then delete") on the bucket. |
| B3 | Medium | **Audit trail kept only 31 days, and erasable by anyone with `audit.view`** (a view permission) via `DELETE /api/activity`. PH record-keeping for payroll and books runs for years (BIR: 5 years; DOLE employment records: 3 years; confirm with your accountant). | Keep ≥ 5 years (archive old rows monthly into compressed files that are backed up); make deletion owner-only or remove it. |
| B4 | Low | **A paid payslip can be un-marked and then deleted**; the only trace is the 31-day audit log. | Finalized or paid payslips: void with a reason, never delete. |
| B5 | Low | **No alert when a backup fails.** Status is only shown in the owner console. | Email or push the owner when a daily or off-site run fails, or when no snapshot has been taken in 26 h. |
| B6 | Low | **Restore drills aren't scheduled** (today's was the first verified one). | Monthly automatic drill: fetch, decrypt, integrity check, record the result. |
| B7 | Check | **`BACKUP_KEY` custody:** without it the off-site copies can't be read. | Confirm it's saved outside Railway (password manager / printed in a safe). |
| B8 | Info | Databases and on-volume snapshots are plaintext on the Railway volume (provider disk encryption not verified). Data lives in Singapore (Railway) and the US (Backblaze `us-east`). | Note the cross-border storage in your privacy notice (PH Data Privacy Act: the company stays accountable). |

### Status (updated 2026-10-10)
- **B3 fixed in code:** the audit trail is kept 5 years (`ACTIVITY_LOG_RETENTION_DAYS`, default
  1827) and `DELETE /api/activity` plus the Prune button are gone. Kept in the database rather
  than archived: ~60 MB per busy company-year at current volumes.
- **B4 fixed in code:** Mark / Unmark Paid is logged to `payslip_paid_history`; a payslip that was
  ever paid can't be deleted, only unmarked and corrected.
- **B5 fixed in code:** hourly health check with alerts to `BACKUP_ALERT_WEBHOOK`
  (`src/platform/backup-health.ts`). Needs the webhook set (runbook step 15).
- **B6 fixed in code:** automatic restore drill every 30 days; results in the owner console;
  `npm run backup:drill` on demand.
- **B1, B2, B7 are dashboard settings:** step-by-step in `docs/DEPLOY-RAILWAY.md` Part 5 (steps 16–18).
  Continuous streaming (Litestream) for B1 is not done.

## Housekeeping
Local unencrypted database copies made during the 2026-10-09/10 work, holding payroll and personal
data, are in `D:\Kyle\Verdesakay\cutover-backups\`. Keep that folder on an encrypted drive or
delete it once the cloud backups are verified.
