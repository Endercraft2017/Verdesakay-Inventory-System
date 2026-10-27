# OTOM website inquiry notifications through SendFox

## Deeper work, same scope

1. A professional keeps an accepted inquiry safely stored even if notification fails, preserves existing alert preferences, and avoids duplicate provider sends.
2. Start from the validated public inquiry schema, actual owner notification code, encrypted mail settings and provider request/response contract.
3. Use native HTTPS with a ten-second timeout, explicit provider-queued validation, safe errors, and isolated Node/SQLite transport tests.
4. Request payload assertions, provider rejection/race/error tests, retained SMTP behavior and a real received test email substantiate the change. Provider acceptance alone does not prove inbox delivery.

Rewritten brief: Enable SendFox for OTOM website inquiry alerts using server-only configuration, retaining stored inquiry records, existing alert switches and all other mail transports. Carry the validated visitor email into Reply-To, prevent duplicate fallback sends, and verify the provider contract and compatibility before a live receipt test.

## Configuration and precedence

Set these on the existing OTOM Railway service; never put real values in source or client assets:

- `SENDFOX_API_KEY`: the native transactional API key. Its presence explicitly selects SendFox for website inquiries.
- `INQUIRY_FROM`: verified sender, for example `AFK3 Website <notifications@afkcube.com>`; required when the key is present.
- `INQUIRY_TO`: owner inquiry recipient; defaults to `contact@afkcube.com`.

The existing `alert_inquiry` switch remains authoritative. Setting it false suppresses the notification. A configured SendFox inquiry does not use the stored SMTP/Brevo recipient or transport. These stored settings remain unchanged for other alerts and for inquiries when no SendFox key is present. If SendFox rejects or times out, the attempt is logged once with a safe generic/status error; it is not retried through another provider.

The public route still persists the inquiry before firing its asynchronous owner notification and returns 201 for accepted storage. It passes the schema-validated visitor address as Reply-To. Payment, signup, tenant mail, login, payroll and inventory behavior are unchanged. No dependency or mail-settings UI was added.

The existing private mail log's `sent` status means the provider accepted the request, consistent with its existing API transports. For SendFox this requires an explicit queued status and nonempty message ID. It does not establish inbox delivery.

Runtime inquiry logs report the Boolean fields `enabled`, `sendfoxConfigured` and `testMode` before the transport decision, plus a fixed skip, queued or generic/HTTP-status failure reason. The diagnostic also runs in test mode so a live service accidentally using test mode can be identified. Test mode truthfully reports capture in the test outbox, never a provider queue. Logs omit recipients, subjects, message bodies, provider response bodies, tokens and message IDs.

## Verification

`OTOM_TEST_APP_ROOT=/absolute/path/to/full/app node --test tests/inquiry-sendfox.node.mjs tests/platform-inquiry-sendfox.node.mjs`

The optional test root supplies the app's existing esbuild and secrets helper when running this partial review checkout. A normal full checkout resolves both locally.

Fifteen focused tests pass: eight provider contract/privacy/validation/dry-run cases and seven real platform-mail/SQLite cases. Tests cover owner versus visitor addresses, Reply-To, escaped HTML, queued-ID acceptance, rejection without body logging, bounded payloads, empty/invalid values, network errors without retry, the inquiry switch, no SMTP fallback, preserved payment transport, preserved inquiry SMTP when no SendFox key exists, the existing test outbox contract, and safe configuration/skip diagnostics. SMTP and network transport fixtures prevent all external writes. No live email was sent by this implementation task. Live delivery verification belongs to the release test.
