# Owner actions

Owner actions need your accounts, business decisions, phone or password manager. Engineering
work also remains; this is not a claim that every other control is complete. The second audit
below supersedes earlier completion claims where evidence is missing.

- Tick a box (`[x]`) when you finish an item.
- Menu names are as of October 2026. If a dashboard looks a little different, look for the
  closest match.
- To be walked through any item, ask Claude: **"teach me owner action N"**.
- Items marked **Tell Claude** have a follow-up step Claude does after you.
- More background for each step is in [DEPLOY-RAILWAY.md](DEPLOY-RAILWAY.md).

Last reviewed 2026-10-16. Start with this release gate:

Assisted MFA recovery now has a [controlled recovery procedure](operations/assisted-account-recovery.md).
Solo support uses advance notice, owner cancellation and a 24-hour wait. Approve your identity-verification process
and verify existing customer email delivery in staging. No operator accounts or live email
configuration were changed automatically. Console passkeys and five-minute verification for
console writes are implemented; enroll Windows Hello and a separate backup **after engineering
and staging checks**, using the [console passkey runbook](operations/console-passkeys.md).
No phone is required for this owner-console option. Unenrolled operators remain password-only
until the require-passkeys policy is enabled.

- [ ] Revoke exposed historical sessions and rotate AI keys that may have entered older activity logs; review logs/backups and coordinate history cleanup.
- [ ] Require branch reviews/status checks. GitHub currently reports `production` unprotected; the private-repository plan restricts rulesets.
- [ ] Create separate staging and require CI before deployment. Railway currently follows `restructure/module-architecture` with checks disabled; do not switch the live service just because this audit branch exists.
- [ ] Approve an outage/data-loss target and witness a full isolated restore with files, keys and configuration; record duration and alert delivery.
- [ ] Enroll your MFA and enable the privileged-user policy using steps 1–2 below. Enroll and test owner-console passkeys plus a separate backup, then enable the console policy.
- [ ] Approve the actual privacy/terms/refund/security/AI notices and DPA/MSA/SLA with the correct entity, contacts, vendors, regions, retention and support commitments. Drafts do not authorize regulated-data use.
- [ ] After engineering, help validate the native vault/upgrade on physical devices using [the runbook](operations/native-credential-storage.md). Broader tenant step-up, API/error contracts, privacy lifecycle and AI assurance remain engineering work; they are not tasks for the owner to code.
- [ ] Review the dependency and historical-secret gate failures; do not bypass them or describe the release as fully green.

No production hosting, data, DNS or deployment changes were made in this audit. Older items marked
already done below are historical notes, not newly verified service evidence. For example, variable
names and a bucket exist, but object-lock and recovery/alert behavior still need proof.

| # | Action | Time | Status |
|---|---|---|---|
| 1 | Turn on two-step sign-in for your account | 5 min | [ ] |
| 2 | Require it for admins and managers | 1 min | [ ] |
| 3 | Change the console password, delete its Railway variables | 5 min | [ ] |
| 4 | Cloudflare DNS for `console.afkcube.com` (then tell Claude) | 5 min | [ ] |
| 5 | Subscribe to backup alerts in the ntfy app | 3 min | [ ] |
| 6 | Backblaze Object Lock (then tell Claude) | 10 min | [ ] |
| 7 | Save `BACKUP_KEY` in your password manager | 2 min | [ ] |
| 8 | Delete or encrypt `D:\Kyle\Verdesakay\cutover-backups\` | 5 min | [ ] |
| 9 | Cloudflare cache and SSL settings | 3 min | [ ] |
| 10 | Backup frequency | — | [x] hourly, done 2026-10-13 |
| 11 | Code-signing certificate (before selling) | days | [ ] |
| 12 | DTI and BIR registration (before online payments) | weeks | [ ] |

---

## 1. Turn on two-step sign-in (5 min)
**Why:** your admin account can see payroll and every employee record. A stolen password alone
should not be enough to get in.

1. On your phone, install **Google Authenticator** or **Microsoft Authenticator**.
2. On your computer, sign in to the company app → **Account** → **Two-step sign-in** → **Turn on**.
3. Enter your password. A QR code appears.
4. In the phone app tap **+** → **Scan a QR code** → point it at the screen.
5. Type the 6-digit code the phone shows → confirm.
6. You'll see **10 recovery codes**. Save them in your password manager or print them. Each
   works once if you ever lose your phone.
7. Sign out and back in: after your password it now asks for the code.

**Done when:** the Account page shows two-step sign-in **On**.

## 2. Require it for admins and managers (1 min)
**Why:** the same protection for everyone who manages accounts, payroll or accounting.

1. Do action 1 first. The setting refuses until your own account has it, so you can't lock
   yourself out.
2. **Accounts & Roles** → **Sign-in security** → tick **Require two-step sign-in** → **Save**.

Those people set it up at their next sign-in (desktop or phone). If someone loses their phone,
use a saved recovery code first. Another MFA-enrolled administrator can use **Accounts & Roles**
→ **Recover 2-step**, verify identity and send a controlled link to the existing account email.
A sole tenant administrator who also lost recovery codes contacts support for the documented
24-hour solo-support recovery process. There is no immediate session-only bypass.

## 3. Console password (5 min)
**Why:** a password used for initial provisioning may remain in hosting variables. Verify the
current setup; audit code does not prove those variables or the original password are still active.

1. **Find the current password:** railway.com → project **ERP** → the app service →
   **Variables** → click the eye on `PLATFORM_ADMIN_PASSWORD`.
2. **Sign in:** open `otom.afkcube.com/_platform` and sign in with that username and password.
3. **Change it:** top right → **Account & security** → enter a new strong password → save it in
   your password manager.
4. **Delete the variables:** back in Railway → **Variables**, delete `PLATFORM_ADMIN_USERNAME`
   and `PLATFORM_ADMIN_PASSWORD` (⋮ menu → Delete). Railway restarts the app for about a minute.
5. **Check:** sign in to the console again with the **new** password.

**Forgot the password later?** A hosting administrator can deliberately reset the console
password through the documented bootstrap mechanism, then remove the temporary variables.
This does **not** remove enrolled passkeys: the operator still needs Windows Hello or the tested
backup key. Do not use a hosting password reset as an authenticator bypass. Complete the
[console passkey rollout](operations/console-passkeys.md) only after engineering/staging checks.

## 4. Cloudflare DNS for the console (5 min), then tell Claude
**Why:** gives the owner console its own address, so its sign-in is completely separate from the
company app in the browser.

Already done by Claude: `console.afkcube.com` is registered on Railway.

1. dash.cloudflare.com → **afkcube.com** → **DNS** → **Records** → **Add record**.
2. Type **CNAME**, Name `console`, Target `0xrsq6c7.up.railway.app`, proxy **on** (orange
   cloud) → **Save**.
3. **Add record** again: Type **TXT**, Name `_railway-verify.console`, Content
   `railway-verify=7f92ea196b367a884d610e26e045f2289ada0c30d377a6b05bc66891f9a82685` → **Save**.
4. **Tell Claude.** Claude waits until Railway confirms the domain, then switches the console
   over (`PLATFORM_HOST`). Switching too early would lock you out of the console, which is why
   Claude does that step.

**Done when:** `https://console.afkcube.com/_platform` opens the console, and
`otom.afkcube.com/_platform` answers "Not found".

## 5. Backup alerts on your phone (3 min)
**Why:** you hear about a failed backup the same day, not when you need a restore.

Already done by Claude: the server sends alerts to a private ntfy topic.

1. Railway → **Variables** → reveal `BACKUP_ALERT_WEBHOOK`. Copy the part after
   `https://ntfy.sh/` (it starts with `vds-backups-`). Treat it like a password.
2. Install **ntfy** (Play Store or App Store) → tap **+** → paste the topic name → **Subscribe**.
3. Ask Claude to send a test alert. ntfy keeps messages for about 12 hours, so the first test
   has expired.

**Done when:** the test message ("Test alert from Verdesakay backups") appears on your phone.

## 6. Backblaze Object Lock (10 min), then tell Claude
**Why:** if the server or the Railway account were ever taken over, the attacker could use the
server's Backblaze key to delete the off-site backups too. Object Lock makes that impossible
for 30 days.

1. backblaze.com → sign in → **Buckets** → `afkcube-erp-backup` → **Bucket Settings** (or
   **Object Lock** on the bucket card).
2. **Enable Object Lock** → default retention **Compliance**, **30 days** → Save.
   Compliance mode can't be shortened later, even by you, so start with 30 days.
3. Same bucket → **Lifecycle Settings** → **Keep prior versions for this number of days: 30**
   → Save. This lets old copies really disappear once their lock ends.
4. **Tell Claude.** Claude runs the off-site upload test and the restore test to confirm
   backups still work with the lock on.

## 7. Save `BACKUP_KEY` (2 min)
**Why:** the off-site copies are encrypted with this key. If you lost the Railway account, the
copies could never be opened without it.

1. Railway → **Variables** → reveal `BACKUP_KEY` → copy it.
2. In your password manager (Bitwarden, 1Password, or Google Password Manager's notes) create
   an entry **"Verdesakay off-site backup key"** and paste it.
3. Also write or print it and keep it somewhere physical and safe.
4. **Never** send it in a chat or email, including to Claude.

## 8. Local copies in `cutover-backups` (5 min)
**Why:** `D:\Kyle\Verdesakay\cutover-backups\` holds full copies of the company database
(employees, payroll) as ordinary files on this PC. The live server keeps its own backups.

Deleting the folder is fine. If you'd rather keep it, encrypt it:
1. Install **7-Zip** (7-zip.org).
2. Right-click the `cutover-backups` folder → **7-Zip** → **Add to archive…**
3. Archive format **7z**, Encryption method **AES-256**, a strong password, tick **Encrypt
   file names** → OK. Save the password in your password manager.
4. Open the new `.7z` once with the password to check it works.
5. Delete the original folder, then empty the Recycle Bin.

## 9. Cloudflare cache and SSL (3 min)
1. **Cache:** Cloudflare → **afkcube.com** → **Caching** → **Configuration** → **Browser
   Cache TTL** → **Respect existing headers**. Without this, phones can keep an old copy of
   some scripts for up to 4 hours after an update.
2. **SSL:** **SSL/TLS** → **Overview** → **Configure** → **Full (strict)** → Save. This checks
   the certificate between Cloudflare and Railway too, not only between your browser and
   Cloudflare.
3. Open `otom.afkcube.com` once to confirm it still loads. If you get an SSL error page,
   switch back to **Full** and tell Claude.

## 10. Backup frequency: done (hourly)
Decided 2026-10-13: **hourly snapshots**.
- **How it works:** every hour, each database that changed gets a snapshot. The last 48 are
  kept on the server and copied encrypted to Backblaze. Daily, weekly and monthly backups
  continue as before.
- **Worst case:** about one hour of work lost.
- **Health check:** if hourly snapshots stop working for 3 hours, you get an ntfy alert
  (action 5).

**Later option, Litestream (before your first paying customer):** an open-source tool that
copies every change to off-site storage within about a second, so you can restore the
database as it was at any moment ("today at 2:14 pm, just before the wrong delete").
Setting it up takes about a day:
- add it to the server build, and run it alongside the app;
- make sure each new company's database is picked up automatically;
- keep the off-site copies encrypted;
- connect it to the restore test and the alerts.

Ask Claude when you want it.

## 11. Code-signing certificate (before selling)
**Why:** without it, Windows shows "Unknown publisher" and blue SmartScreen warnings when
customers install the desktop app.

- **Cheapest:** Microsoft's **Azure Trusted Signing**, a monthly subscription, if it's
  offered for businesses in the Philippines when you apply.
- **Otherwise:** buy a code-signing certificate from SSL.com, Sectigo or DigiCert. The private
  key now comes on a USB token or a cloud signing service.
- **Order:** an organization certificate needs your registered business, so do action 12 first.
- **Then:** give Claude access to the signing service, and Claude wires it into the desktop
  build. See OFFLINE-FIRST.md §17.

## 12. DTI and BIR (before online payments)
**Why:** PayMongo (card and GCash checkout) needs a registered business. Until then, billing
stays manual: GCash or bank transfer, confirmed in the console.

Usual order for a sole proprietorship:
1. **DTI business name:** online at bnrs.dti.gov.ph (about ₱500, takes minutes).
2. **Barangay clearance**, then **Mayor's/business permit** at your city hall.
3. **BIR registration:** Form 1901 through BIR's online registration (ORUS) or your local RDO.
   You get **Form 2303** (Certificate of Registration), register your books, and set up
   invoices.
4. **PayMongo:** sign up and submit the DTI certificate, BIR 2303, a valid ID and your
   business bank account.

Fees and requirements change. A local bookkeeper or accountant can do steps 2–3 for a small fee
and make sure your tax type (8% vs graduated rates) is set correctly, which is worth it for a
software business.

---

## Already done by Claude (no action needed)
- Railway volume backups: daily (kept 6 days), weekly (27 days), monthly (89 days).
- App snapshots: hourly (last 48) and daily, copied encrypted to Backblaze B2. Restore test
  every 30 days, health check every hour.
- Backup alerts sent to your ntfy topic.
- `console.afkcube.com` registered on Railway; waiting on action 4.
- Security: two-step sign-in, strict Content-Security-Policy, the AI asks before changing data,
  hashed login tokens, a console Change password button.
