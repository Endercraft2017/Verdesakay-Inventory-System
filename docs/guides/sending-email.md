# Sending email from the system

Send a plain email — a note to a customer, a payslip, a purchase order — through your
company's mailbox, and keep a log of what went out.

## What it's for

- Quick messages to customers or suppliers without switching to Outlook/Gmail
- Letting the AI Assistant email a report on your behalf
- A record: every send (and every failure) is logged

## Before you start

- Open the **Email** tool from the right-hand tools rail.
- You need the **Send email** permission. If you only see a greyed-out panel, ask an
  admin.
- An admin must have connected the company mailbox first — see
  [../EMAIL-SETUP.md](../EMAIL-SETUP.md). Until then, sending returns
  "Email is not configured".

## Steps

1. Open the **Email** tool.
2. Fill in **To**, **Subject**, and the **message**.
3. Click **Send**.
4. You'll get a success or failure notice. Either way it's recorded in the log
   (admins can view it under Email → Settings → log).

## Tips & gotchas

- **One recipient at a time** in the compose box. For a batch, send individually or use
  the AI Assistant.
- The **From** address is the company mailbox your admin set up — replies come back there
  (or to the reply-to address they configured), not to your personal inbox.
- Attachments aren't added from this box yet; the AI Assistant can attach a report it
  generated.
- Sending limits are set by your mail provider (e.g. Gmail ~500/day). Hitting the limit
  shows as a failure in the log.

## If something goes wrong

| Message | Meaning / fix |
|---|---|
| "Email is not configured" | Admin hasn't set up the mailbox yet — point them at EMAIL-SETUP.md. |
| "Invalid login" / auth error in the log | Wrong mailbox password or an app password is needed — admin fixes this in Email → Settings. |
| Message sent but bounced | Bad recipient address, or the recipient's server rejected it — check the address; the log shows the provider's reason. |
| You don't see the Email tool | You lack the Send email permission. |
