# Release decision record

Release/commit [OWNER]; date/time [OWNER]; operator/reviewer [OWNER]; environment and customer scope [OWNER]. Keep this record with the deployment evidence. An unchecked applicable blocker means hold release or record an explicit approved risk exception with expiry.

- [ ] Confirm exact source commit, approved PR and required CI results; investigate dependency/security failures separately from passing application tests.
- [ ] Confirm NODE_ENV=production, supported Node version, private environment secrets, fresh bootstrap password and distinct staging/production credentials.
- [ ] Verify external HTTPS, trusted proxy hops, Secure/HttpOnly/SameSite cookies, CSP/HSTS and blocked direct storage/DB access; test owner-console restrictions.
- [ ] Verify tenant isolation and least-privilege access with actual supported clients; record MFA/native storage disposition and historical credential revocation.
- [ ] In staging, verify recent password + enabled-factor confirmation for tenant account/role/policy, office-PC trust and integration settings; cancellation must leave the action unsaved. Verify console passkeys with a separate backup before requiring enrollment. See [tenant-step-up.md](tenant-step-up.md).
- [ ] If enabling QuickBooks, verify reconnect/environment scope, reconcile legacy unbound links and interrupted/uncertain writes, and exercise real provider acceptance and company-switch races in sandbox. Verify adapter rollback compatibility with retained receipts and already accepted remote writes. Keep the integration disabled until its applicable blockers have evidence; see [quickbooks-lifecycle.md](quickbooks-lifecycle.md).
- [ ] Confirm provider billing caps, alerts and approved data-processing terms before enabling AI/integrations; verify production AI cannot mutate business records.
- [ ] Capture encrypted recoverable backup of every affected DB and uploads; verify offsite copy/key availability and a recent successful full restore drill.
- [ ] Review schema compatibility, tenant migration plan, write/sync reconciliation and rollback trigger. Record the compatible rollback application/data snapshot.
- [ ] Run staging critical workflows: account login/logout/revocation, inventory receipt/adjustment, orders/production/QC/release, HR/payroll review, upload/download/print and offline replay under the correct actor, as applicable to licensed modules.
- [ ] Review target-volume latency/error/capacity results and representative devices. Do not substitute the small local read probe for a live capacity commitment.
- [ ] Fill and approve legal/privacy/refund/AI/security documents; execute applicable B2B agreements; establish rights-request and breach contacts/deadlines.
- [ ] If enabling signup alerts, verify real provider acceptance, recipients/TLS, interrupted-send review, worker/backlog monitoring and restore reconciliation. Test disabled-alert and mailbox-change behavior; see [owner-alert-outbox.md](owner-alert-outbox.md).
- [ ] Test external alert delivery, backup failure/disk alerts, on-call/deputy access and customer support/status communication.
- [ ] Confirm native/Electron signing/install/update/certificate/device testing if distributing those artifacts.
- [ ] Record go/hold decision, known limitations, explicit exceptions, customer/maintenance communication and next verification time.

After deployment: verify health plus authenticated business smoke, request IDs/errors, queue/sync lag, disk growth and backup schedule. Stop/rollback on tenant leakage, credential compromise, financial/stock corruption or unacceptable error/latency; invoke incident lead and preserve accepted writes. Record actual outcome and retrospective actions.


### Inquiry/payment queue upgrade acceptance

- [ ] Verify a compatible worker handles platform_business_outbox; older signup-only workers
  ignore it. Do not downgrade without keeping compatible processing/monitoring or stopping and
  reconciling the queue. Older request servers keep their immediate behavior until upgraded.
- [ ] Exercise source/report rollback, pending/reviewed source checks, configuration changes,
  real provider acceptance and backlog escalation without sending customer test messages.
- [ ] Restore catalog and durable proof bytes through supported backup operations, reconcile
  later provider/bank/send evidence before reopening processing, and verify proof downloads.
- [ ] Approve financial versus email retention; complete upload-content and broader financial
  lifecycle acceptance. Do not resend unknown jobs or treat separate POSTs as deduplicated.

See business-alerts.md. These are rollout gates, not completed deployment evidence.


### Payment-report receipt rollout

- [ ] Verify lost-response replay, current permissions, proof binding, known legacy-cache refusal,
  expiry and current Billing review state with synthetic data before enabling production writers.
- [ ] Keep compatible request-serving versions for uncertain keyed retries. Before downgrade or
  catalog restore, stop reporting and reconcile later payment/receipt/bank/provider evidence.
- [ ] Approve receipt/tombstone retention and explain no-key/new-modal/different-actor limits to
  support; never delete duplicate evidence to force a retry. See payment-report-retries.md.


### Inquiry receipt rollout

- [ ] Exercise synthetic lost-response/edit/conflict/original replay, source/alert rollback, expiry
  and site-host/honeypot/rate controls with compatible writers before live rollout.
- [ ] Measure combined login/inquiry memory/latency and saturation under representative hardware
  and edge limits; per-process queue/rate checks are not distributed load acceptance.
- [ ] Approve marker/verifier retention and reconcile before restoring older catalogs/downgrading
  writers. Do not delete markers or blindly resend unknown alerts. See inquiry-retries.md.


## Delivery monitoring follow-up — 19 October 2026

Queue-wide counts, filtered keyset history and durable worker observations are implemented.
The latest-thirty view no longer defines the scope of review. See
[owner-alert monitoring](owner-alert-monitoring.md) for API parameters, thresholds, redaction, read failures,
triage and rollback. Unknown delivery remains no-resend; provider reconciliation, reviewed
recovery, external watchdog/escalation and real-host acceptance remain release gates.
Monitoring is scoped local evidence, not closure of a whole production control.

- [ ] Verify cloud startup/timer updates the owner-alert heartbeat, fresh vs stale/failed/disabled
  observations, old warning pagination and failed-refresh evidence retention on the target host.
- [ ] Establish and test an independent watchdog destination/incident escalation; demonstrate
  a stopped worker/API outage reaches the responsible operator without relying on queued mail.
- [ ] Reconcile uncertain/restored delivery records with provider evidence; record the decision
  before any separately authorized manual recovery. Do not use dashboard counts as inbox proof.


## Public signup availability — 19 October 2026

One active public signup per process, with no signup backlog. Busy/full/expired shared crypto
work returns 503, Retry-After: 5, and safe registration wording. Existing ten/hour/IP controls
count replays and busy attempts. Receipt and owner hashing are bounded/asynchronous, with
live state checks after awaits. Signup browser fetch/body timeout is twenty seconds and retains
its key/draft; navigation requires a valid 201 acknowledgement. See
[public signup budget](public-signup-budget.md) for exact API, support and rollback limits.
Synchronous schema/file initialization, mixed workload capacity and distributed abuse remain
release gates. No complete-control status is promoted by these scoped changes.

- [ ] Verify mixed signup/login/inquiry saturation, safe 503/retry, health during hashing, stale
  replay rejection, owner login and committed-response timeout retry on the target host.
- [ ] Measure synchronous tenant setup/event-loop delay and memory/disk growth before selecting
  supported signup traffic targets; retain independent incident detection and edge controls.


## Manual export security follow-up — 20 October 2026

Manual exports now require recent identity proof and JSON connection_id from the reviewed
status response; stale/missing binding fails closed. Export-authorized staff may read target
metadata but do not acquire administrator settings access. The displayed target/generation
comes from one SQLite snapshot. Actor/session/credential/order changes during awaited work
stop further provider calls; already accepted receipts are preserved. Shared adapter excludes
CKD component rows to avoid duplicate commercial pricing. See
[manual QuickBooks exports](manual-quickbooks-exports.md) for API, legacy-client update,
partial-write recovery and rollback limits. Offline financial claims remain unchanged and need
a dedicated verification design; broader controls and real provider/accountant acceptance remain.

- [ ] Deploy compatible manual-export clients/server in isolated staging; verify required target
  generation, stale/same-company reconnect rejection, permission-first proof, cancellation,
  actor/order changes across provider waits and accepted receipt preservation.
- [ ] Confirm CKD totals, target currency, Invoice/Bill mapping and tax settings with the real
  Intuit sandbox/company and accountant before enabling production exports. Never clear an
  uncertain journal merely to force retry. Offline financial verification remains a separate gate.

The final contract additionally requires order_stamp from the read-only current-order preview.
The desktop reviews the preview total/target and refuses account/company/view changes before
sending. A changed source version after review is rejected before provider work; the stamp is
a precondition, not a one-use authorization credential. An interrupted preliminary full run
was stopped to include these confirmation safeguards; only the final completed run counts.
