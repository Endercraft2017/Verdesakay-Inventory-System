# Public signup availability verification scope

19 October 2026. Base e28a9217082dcc44d96121011262511e3475bd0f; branch production.
The uploaded handbook is an audit reference; fixes are authorized by the user's instructions.

High scoped gap: public owner/receipt scrypt and redundant bootstrap hash could delay unrelated
requests. Implemented shared bounded asynchronous receipt/owner work, one-active/no-backlog
signup admission and trusted fresh initialization using the prepared hash. Current source,
receipt and catalog state are checked after awaits. Default bootstrap policy and existing
strong hash/receipt formats remain; CLI/console synchronous helpers remain supported.

Fifteen new focused cases cover keyed/no-key correct credentials without any synchronous hash,
health and competing requests during crypto wait, shared saturation/no source or file, real
publication failure/retry, competing catalog publication, four live replay invalidations,
mutable input snapshot/event-loop yield, fresh-only initialization guards, native async error
redaction/admission release, real process exit + old synchronous receipt compatibility, and
production ten/hour limiter including matching replays. Existing provisioning/crash/receipt/
billing/hash/policy/login-race suites supplement these. Typecheck is required. No schema or
stored-format change requires new generated tenant types or migration version.

Three new Playwright cases cover a real committed signup with response held beyond controlled
browser deadline followed by same-key replay/one invoice, a busy response preserving draft/key,
and null/HTML/wrong-status success refusal. Existing browser auth/passkey/MFA/recovery/signup/
mail/accounting/payment journeys run too. First checks passed; central encoded-format validation
was then reused from password-hash instead of duplicated in db.ts, with final expanded focused
and full browser verification on that runtime. No failures are silently reported as passes.

Actual server startup smoke performs HTTP signup/replay/owner login against disposable catalogs,
then observes one actual timer-driven synthetic acceptance and completed heartbeat. No real
provider, customer account/email/bank, deployment or hosted configuration was changed. NODE_ENV
production is exercised only with synthetic process/limiter fixtures, not real hosting.

Runtime/tests freeze before the completed full regression. Exact counts/durations/initial and
final evidence are in signup-budget-verification.json. Archived outputs may have trailing
whitespace normalized. Source hashes/credentials/receipts retain their prior interoperability.

Limits: signup still does synchronous SQLite/schema/file setup; no hosted event-loop latency,
memory/disk capacity, cross-process admission, bot/email ownership control, universal request
budget or full-app release assurance. Native KDF work is not cancelled by browser abort; same
page/key/details retry remains necessary. Reload/new key/legacy clients remain outside replay
coverage. Broader financial/privacy/authorization/AI/native/dependency/hosting/governance gates
remain. Whole-control counts unchanged; release hold remains. Owner participation comes last.
