# Email Setup (BYO-SMTP)

> **Audience:** the admin who runs the system for a company.
> **Last updated:** 2026-08-28

The system does not run its own mail server. It sends through **your own mailbox**
over SMTP — the same account you'd log into in Outlook or the Gmail web app. Nothing
is sent until an admin fills this in, and the SMTP password is encrypted at rest.

- **Who can configure it:** a user with the `users.manage` permission (admins by default).
- **Where:** open the **Email** tool in the right-hand rail → **Settings** (the ⚙ button).
- **Who can then send:** a user with the `mail.send` permission (admins and `admin_staff`
  by default; grant it to others under **Admin → Users → Permissions → "Messages & Email"**).
  The AI assistant's `send_email` tool follows the same permission.

---

## The settings fields

| Field | What to put |
|---|---|
| **Transport** | `SMTP` to turn email on; `Off` to disable all sending. |
| **From name** | Display name recipients see, e.g. `Otom`. Optional. |
| **From email** | The address mail is sent *as*, e.g. `office@yourcompany.com`. Usually the same as the SMTP username. |
| **Reply-to** | Where replies should go if different from *From*. Optional. |
| **SMTP host** | Your provider's outgoing server (see table below). |
| **SMTP port** | `587` for STARTTLS (normal) or `465` for implicit TLS. |
| **Use TLS (secure)** | **Leave unchecked for port 587.** Check it only for port 465. |
| **SMTP username** | Usually your full email address. |
| **SMTP password** | Your mailbox password, or an **app password** (Gmail/M365 with 2FA — see below). Write-only: once saved it shows as `••••••••` and is never sent back to the browser. Leave it blank on later edits to keep the stored one; clear it to remove it. |

After saving, click **Save & test** — it opens a real connection, checks the
credentials, and sends one test message to an address you choose. Every send
(tests included) is recorded in the **log** under the same Email panel.

---

## Provider quick reference

| Provider | SMTP host | Port | Secure | Username | Password |
|---|---|---|---|---|---|
| **Gmail / Google Workspace** | `smtp.gmail.com` | 587 | off | full Gmail address | **App password** (16 chars) — requires 2-Step Verification |
| **Microsoft 365 / Outlook** | `smtp.office365.com` | 587 | off | full address | account password, or **app password** if MFA is on |
| **Zoho Mail** | `smtp.zoho.com` | 587 | off | full address | account or app password |
| **Fastmail** | `smtp.fastmail.com` | 465 | on | full address | **app password** |
| **Brevo** (transactional relay) | `smtp-relay.brevo.com` | 587 | off | Brevo login | SMTP key from the Brevo dashboard |
| **SendGrid** | `smtp.sendgrid.net` | 587 | off | the literal word `apikey` | your SendGrid API key |
| **Resend** | `smtp.resend.com` | 465 | on | the literal word `resend` | your Resend API key |
| **Your web host's mailbox** | check the host's control panel (often `mail.yourdomain.com`) | 587 | off | full address | mailbox password |

### Gmail app password (most common setup)

1. The Google account needs **2-Step Verification** turned on
   (`myaccount.google.com` → Security).
2. Go to `myaccount.google.com/apppasswords`, create one named "Otom",
   and copy the 16-character code.
3. In Email → Settings: host `smtp.gmail.com`, port `587`, secure **off**,
   username = the Gmail address, password = that 16-character code (spaces optional).

> Free Gmail sends up to ~500 recipients/day; Google Workspace ~2,000/day.
> These are generous for order confirmations and reports but not for bulk mail.

---

## "I have a domain name — does that work?"

Yes — a domain **helps**, but a domain by itself is not a mail server. What matters
is having a mailbox/SMTP service *for* that domain. Three situations:

### 1. Domain + a mailbox provider (recommended)

If your domain's email is on **Google Workspace, Microsoft 365, Zoho, Fastmail**,
your web host, etc., you already have SMTP. Use that provider's row from the table
above, with a *From* address like `office@yourcompany.com`. This gives the best
deliverability because the provider already publishes the DNS records that prove
the mail is really from you.

### 2. Domain, but no mailbox yet

A registered domain with no email service can't send on its own. Pick one:

- **Add a mailbox provider** (Google Workspace ~$6/user/mo, Zoho has a free tier for
  one domain, etc.), then follow situation 1.
- **Use a transactional relay** — Brevo (300 emails/day free), Resend (3,000/mo free),
  SendGrid (100/day free). You verify the domain by adding the DNS records they give
  you, then use their SMTP row from the table above with a `you@yourdomain.com`
  *From* address. This is the case where owning the domain genuinely pays off: you
  get authenticated sending from your own address without buying mailboxes.

### 3. Using your domain's *From* address through an unrelated mailbox

You *can* set *From* to `office@yourcompany.com` while sending through, say, a Gmail
account — the system allows it — but most inbox providers will put that mail in
**spam** or rewrite the sender, because Gmail isn't authorized to send for your
domain. Only do this if the *From* domain's DNS authorizes the sending service.

### Deliverability checklist (situations 2 and 3)

For mail from `@yourcompany.com` to land in inboxes, your domain's DNS needs:

- **SPF** — a TXT record listing the services allowed to send for the domain.
- **DKIM** — a signing key published as a DNS record (your provider generates this).
- **DMARC** — a TXT record at `_dmarc.yourcompany.com` telling receivers what to do
  with mail that fails the above.

Your mailbox or relay provider gives you the exact records to paste into your
domain registrar's DNS panel. Send a test to a Gmail address and use
**Show original** to confirm SPF and DKIM both say `PASS`.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `Invalid login` / `535` on Save & test | Wrong password, or the provider needs an **app password** and you used the account password. |
| `Connection timeout` | Wrong host/port, or the office firewall blocks outbound 587/465. |
| `self signed certificate` | Host name doesn't match the cert — double-check the SMTP host spelling. |
| Test succeeds but real mail lands in spam | Missing SPF/DKIM for the *From* domain — see the checklist above. |
| `Email is not configured` | Transport is still `Off`, or *SMTP host* / *From email* is blank. |

The **log** under Email → shows every attempt with its status (`sent` / `failed`)
and the provider's error text, which is the fastest way to see what a receiver rejected.

## Tenant-visible guide and assisted setup

The in-app guide is served at `/guides/email-setup.html` and linked from the tenant
Email drawer and Email settings. It is public, contains no credentials, and can
be shared with a company's email/DNS administrator.

An authenticated operator can open `/_platform`, select a workspace, and use
**Tenant email / assisted setup** to read/update that tenant's SMTP configuration
or **Save & send test**. Blank password preserves the saved secret; the explicit
clear checkbox removes it. Settings changes and test outcomes record the operator
in the provisioning log, without credentials. Tests also appear in the tenant's
mail log without attributing them to a tenant user.

Agree any assisted-setup fee separately before service. This feature does not
invoice or charge customers. Tenant provider costs remain separate. Never ask
customers to send credentials over email/chat; arrange secure entry. Platform
Brevo credentials must not be copied into tenant settings.
