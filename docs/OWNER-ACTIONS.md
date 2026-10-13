# Owner actions

Things only the owner can do: they need your phone, your password manager, or a dashboard
Claude has no access to (Cloudflare, Backblaze, the Railway web UI). Everything else is already
done in code or on the server.

Detailed click-by-click steps are in [DEPLOY-RAILWAY.md](DEPLOY-RAILWAY.md) (step numbers below).
To be walked through any item, ask Claude: "teach me owner action N".

Tick the box when done. Last reviewed 2026-10-13.

## Do soon (security)

### 1. [ ] Turn on two-step sign-in for your account (5 min, runbook step 21)
- **Why:** your admin account can see payroll and every employee record. A stolen password
  alone should not be enough to get in.
- **Needs:** your phone with an authenticator app (Google Authenticator, Microsoft
  Authenticator, Authy or 1Password).
- **Do:** company app → **Account** → **Two-step sign-in** → **Turn on** → scan the QR code →
  type the 6-digit code → **save the 10 recovery codes** in your password manager.
- **Done when:** the Account page shows two-step sign-in **On**.

### 2. [ ] Require two-step sign-in for admins and managers (1 min, step 21)
- **Why:** applies the same protection to everyone who manages accounts, payroll or accounting.
- **Do:** after action 1 → **Accounts & Roles** → **Sign-in security** → tick **Require
  two-step sign-in** → Save. Those people set it up at their next sign-in.
- **Done when:** the setting shows as required. (It refuses until action 1 is done, so you
  can't lock yourself out.)

### 3. [ ] Change the owner console password, then delete its Railway variables (5 min)
- **Why:** the console password is still the one typed into Railway at setup, stored there in
  plain text.
- **Do:**
  1. Open `otom.afkcube.com/_platform` and sign in. The current password is in Railway →
     app service → **Variables** → `PLATFORM_ADMIN_PASSWORD`.
  2. Top right → **Change password** → save the new one in your password manager.
  3. Railway → **Variables** → delete `PLATFORM_ADMIN_USERNAME` and `PLATFORM_ADMIN_PASSWORD`.
- **Done when:** you can sign in to the console with the new password, and neither variable
  is listed in Railway.
- **Forgot it later?** Add both variables back plus `PLATFORM_ADMIN_RESET=true`, let Railway
  redeploy, sign in, then delete all three.

### 4. [ ] Give the owner console its own address (10 min, step 20)
- **Why:** keeps the console's sign-in completely separate from the company app in the browser.
- **Already done by Claude:** `console.afkcube.com` is registered on Railway.
- **Do:** Cloudflare → `afkcube.com` → **DNS** → add these two records:

  | Type | Name | Value | Proxy |
  |---|---|---|---|
  | CNAME | `console` | `0xrsq6c7.up.railway.app` | on (orange cloud) |
  | TXT | `_railway-verify.console` | `railway-verify=7f92ea196b367a884d610e26e045f2289ada0c30d377a6b05bc66891f9a82685` | — |

- **Then tell Claude.** Claude checks that Railway shows the domain as verified and only then
  sets `PLATFORM_HOST`. Setting it before the domain works would lock you out of the console.
- **Done when:** `https://console.afkcube.com/_platform` opens the console, and
  `otom.afkcube.com/_platform` answers "Not found".

## Backups (do once)

### 5. [ ] Subscribe to backup alerts on your phone (3 min, step 15)
- **Why:** you hear about a failed backup the same day, not when you need a restore.
- **Already done by Claude:** the server sends alerts to an ntfy topic, and a test alert was
  delivered on 2026-10-12.
- **Do:** install the **ntfy** app → **+** → subscribe to the topic. Its name is the part after
  `ntfy.sh/` in Railway → **Variables** → `BACKUP_ALERT_WEBHOOK`. Treat it like a password.
- **Done when:** the test message ("Test alert from Verdesakay backups") shows in the app.

### 6. [ ] Lock the off-site copies against deletion (10 min, step 17)
- **Why:** if the server or the Railway account were ever taken over, the attacker could use
  the server's Backblaze key to delete the off-site backups too. Object Lock makes that
  impossible for 30 days.
- **Do:** Backblaze → **Buckets** → `afkcube-erp-backup` → **Bucket Settings** → **Object
  Lock** → Enable, **Compliance**, **30 days**. Then **Lifecycle Settings** → keep prior
  versions **30** days.
- **Then tell Claude,** who runs the off-site test and restore drill to confirm backups still work.
- **Careful:** Compliance mode can't be shortened later, even by you. Start with 30 days.

### 7. [ ] Save the backup key somewhere safe (2 min, step 18)
- **Why:** the off-site copies are encrypted with `BACKUP_KEY`. If Railway lost it, or you
  lost the account, the copies could never be opened.
- **Do:** Railway → **Variables** → `BACKUP_KEY` → reveal → copy into your password manager as
  "Verdesakay off-site backup key". Keep a second copy offline (printed, in a safe).
- **Never** paste it into a chat, an email or the repo.

### 8. [ ] Delete or encrypt the local cutover copies (5 min)
- **Why:** `D:\Kyle\Verdesakay\cutover-backups\` holds full copies of the company database
  (employees, payroll) as plain files on this PC. The live server keeps its own backups.
- **Do:** either delete the folder, or move it into an encrypted container (for example a
  password-protected 7-Zip archive with AES-256, or a BitLocker drive) and delete the original.

## Cloudflare settings (5 min)

### 9. [ ] Cache and SSL settings
- **Caching** → **Configuration** → **Browser Cache TTL** → **Respect existing headers**.
  Why: otherwise phones can keep an old copy of some scripts for up to 4 hours after an update.
- **SSL/TLS** → **Overview** → mode **Full (strict)**. Why: checks the certificate between
  Cloudflare and Railway, not only between your browser and Cloudflare.

## Decision waiting on you

### 10. [ ] How much data you can afford to lose
Today everything is backed up **once a day**, around midnight Manila time: the app's own
snapshot plus Railway's volume backup. A disaster at 11 pm would lose that day's punches,
stock movements and payroll edits. Choose one:
- **Hourly snapshots** (recommended now): worst case one hour lost. Claude can build it; the
  databases are small (about 6 MB), so each snapshot takes a moment and costs almost nothing.
- **Continuous replication** (later, with paying customers): every change streamed off-site
  within about a second, using Litestream, the standard tool for SQLite. More moving parts.
- **Keep daily:** fine only while losing a day's entries is acceptable.

## Before selling to other companies

### 11. [ ] Code-signing certificate for the desktop app
Without it, Windows shows "unknown publisher" warnings when customers install the app. Buy one
(an OV or EV code-signing certificate) once the business details are final. See OFFLINE-FIRST.md §17.

### 12. [ ] Business registration for online payments
PayMongo (card/GCash checkout) needs DTI and BIR registration. Until then, billing stays manual
(GCash or bank transfer, confirmed in the console).

## Already done (no action needed)
- Railway volume backups: daily (kept 6 days), weekly (27 days), monthly (89 days). Turned on 2026-10-12.
- Backup alerts wired to ntfy; test alert delivered.
- Off-site encrypted copies to Backblaze B2, restore drill every 30 days, hourly health check.
- Two-step sign-in, strict Content-Security-Policy, AI asks before changing data, hashed session
  tokens, console change-password: all live.
