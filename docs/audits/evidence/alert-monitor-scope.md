# Owner-alert monitoring verification scope

Date: 19 October 2026. Base: 488d413d780b4b6d754fb9998b784d4d9c47787c; branch production.

Medium scoped gap: latest-thirty visibility could obscure old delivery warnings; no persisted
worker observation distinguished idle/unobserved/stale/failure. Implemented queue-wide counts,
filtered mixed-queue keyset history and guarded singleton heartbeat; actual server wrapper
records each pass. No automatic resend/requeue/provider lookup, incident resolve, host change
or external monitor provisioning. See operations/owner-alert-monitoring.md for API/data/
retention/triage/rollback and research references in standards-research.md.

Focused cases cover old warnings beyond thirty, due/retry/stale/expired/future records,
read-only state, equal timestamp/ID pagination across queues, future-date cursors, invalid
queries/cursor/filter bounds, console auth/no-store/redaction, generic unexpected failures,
heartbeat persistence across reopen, overlapping passes, start/finish failures, successful
acceptance before failed heartbeat acknowledgement and no duplicate send afterward, disabled/
unobserved/clock/malformed observations. Existing outbox/provider transport and mail snapshot
regressions also run. Synthetic acceptance is not real provider/inbox validation.

Playwright adds old-history traversal, failed filter reads preserving list/health/cursor and
restoring filter, and a real held request aborted after controlled twenty-second clock
advancement with retry. Existing auth/passkey/mail/payment/signup/inquiry/browser checks run.
Initial browser expected raw state 'Unobserved', but screen correctly says 'Not yet observed';
only that assertion changed. Initial results and JSON retained; transient trace/screenshot
attachments named in logs are not archived. No product defect was inferred from this mismatch.

Actual server.ts smoke uses NODE_ENV=test transport and disposable catalogs. Startup/timer
process committed signup/inquiry/payment intents once, observe both stale claims as unknown,
retain durable proof and receipt tombstones and persist completed worker heartbeat. Script
and safe output retained; no provider call or hosted mutation. Typecheck and db:types required;
no generated tenant-type change. Exact final counts/durations are in verification.json.

History membership remains live; captured cursor time only fixes warning thresholds. Counts
scan retained metadata, and no production-sized capacity claim is made. Singleton heartbeat
does not validate each replica. UI is manual refresh, not external paging. Provider review,
controlled recovery, external alert routing/escalation, real-host staging/restore/load/rollback,
Windows/native-device and broader scorecard controls remain. Whole-control statuses unchanged;
release is on hold. No owner action is needed to complete this local implementation increment.

Final commit scanning initially flagged two SHA-256 artifact digests because their JSON property
names included “secrets”. These were file checksums, not credentials. The manifest now puts
artifact names and digests on separate fields/lines; no scan rule was disabled or allowlisted.
Trailing blank lines were removed from evidence outputs. Runtime/tests did not change.
