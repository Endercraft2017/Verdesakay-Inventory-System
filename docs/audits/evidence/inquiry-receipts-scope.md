# Inquiry retry follow-up — 19 October 2026

Base a2a92cc6e49aab8752a923449aaf1a1c5b302d21, production.

Medium scoped duplicate inquiry/owner-alert gap after response loss: updated website now keeps one
UUID-v4 key across the form's retries and edits. Matching committed key/details returns only
201 {ok:true}; changed details conflict without echoing private source information. No new key
is silently assigned on failure. Source, enabled alert and successful receipt share the existing
catalog savepoint. Stale candidate/receipt/alert failure rolls all local writes back. Generic
/api idempotency is not involved in this public site route.

New table stores hashed key, salted verifier, source ID and expiry, not raw request/contact/key
or private response. One shared bounded asynchronous native scrypt queue handles new bindings
and verification outside transactions. It uses the existing one-active/eight-waiting/ten-second
budget and returns safe 503/Retry-After on saturation. Native crypto yields to the event loop.
Receipt/verifier/source/expiry are rechecked after waiting so stale work cannot acknowledge a
deleted source or expired receipt. The production five-per-hour limiter still counts replays.

Twenty-seven new inquiry cases cover replay/reopen/normalization, seven changed fields, host/
schema/honeypot, invalid keys, no-key/new-key behavior, case/slash aliases, source/receipt/alert
faults, stale and real concurrent HTTP candidates, expiry/source removal, validation correction,
two child exits, queue saturation, source/expiry change during awaited work and actual production
rate limiting. One additional shared-helper case verifies real event-loop progress and retained
salted format. Focused runs progressed from four files/53 passed to six/67 passed as asynchronous
admission was added, then six/70 passed with race/event-loop cases. No runtime test failure in
these runs. An intermediate typecheck found generic SQLite row fields inferred as possibly
undefined in fixtures; explicit String/Number SQL parameters fixed it. Initial compiler output
is retained, followed by successful typechecking. This was fixture typing, not a runtime defect.

Chromium drops a real committed inquiry response, edits the same request and gets 409, restores
original details and replays. Restricted owner APIs verify one source and one alert. An additional browser check rejects null JSON and HTML fallback success responses while
retaining draft/key until a real acknowledgement. Existing browser pre-commit enqueue failure still retains draft and accepts correction with the same key.
A 20-second contact abort timer now releases pending networking/body reads, preserves key/draft
and offers uncertain same-key retry. A browser clock advances after a real server commit whose
response is withheld, then verifies replay. This is controlled timer evidence, not a wall-clock
network/hosting SLA. A preliminary full regression was stopped with exit 130 to include this
missing client deadline; its output is retained as incomplete. Actual server startup prunes expired inquiry verifier while retaining its marker/source, and
continues safe processing of three synthetic owner-alert kinds and stale claim uncertainty.
No provider/customer email/bank/deployment action; synthetic data only. Exact final results,
failures if any, browser JSON and startup script are inquiry-receipts-* evidence.

Research reviewed today: Stripe idempotency, SQLite savepoints and OWASP DoS Cheat Sheet.
Own contract differs from Stripe API-v1 error caching and pruned-key reuse: successful receipt
only, public constant acknowledgement and expired tombstones. Limits do not certify distributed
abuse/load resilience; inquiry work shares login capacity. Local process/browser tests do not
establish power-loss/Windows/hosting/provider acceptance. No raw data is newly encrypted.

No-key/new-page/new-key/legacy duplicates, other API/import receipts, reconciliation/reviewed
resend/backlog escalation, public signup's synchronous work and broader financial/security/
upload/governance/device/hosted acceptance remain. Compatible request writers are needed for
rollback; old catalog restores can lose duplicate evidence and require reconciliation. Legal
retention remains unapproved. No dependency/advisory snapshot or tenant schema bump. Complete
controls remain 36 PASS/58 FAIL/126 UNVERIFIED/13 N/A; no production-ready/CI-green/full-control
PASS claim, and release hold is unchanged. Runtime/tests frozen before final full regression.
