# Durable automatic exports

Implemented 18 October 2026. This extends the [connection/write safety](quickbooks-lifecycle.md)
controls. Provider sandbox acceptance and remaining release gates are still required.

## Save and dispatch

The existing order create, header/items edit, sale-status and release-slip paths now write
`qbo_export_jobs` inside the same SQLite transaction as the order change. Enqueue failure rolls
back that save; no provider request is sent from the save handler. Intent is created only when
the integration is licensed, automatic export is enabled, a verified connection exists, and this
is the cloud copy. An offline node never stores or executes this queue; its accepted commands
can create cloud intent when replayed. Other order-changing paths are not newly certified here.

Each row binds the original connection ID, environment/company, order ID and saved version. Later
edits coalesce into that row. An edit during an active export increments the desired version;
completion records only the captured version, leaving newer work queued. A save is not a remote
export confirmation. It is not a complete event-history stream of every intermediate edit.

`server.ts` starts a cloud-only worker on startup and every 15 seconds. Passes do not overlap;
a pass processes at most one job per eligible tenant, sequentially. Processing duration extends
actual latency; this is not a throughput or delivery-time promise. A persisted atomic claim
prevents another worker from taking the same row. This is not support for separate SQLite
replicas or a distributed global provider-concurrency limit.

## Failure states and retry policy

- `queued`: committed work waiting for processing.
- `running`: claimed work, which may still be active or may have been interrupted. No timer or
  age-based lease stealing resets it. Investigate persistent claims using the lifecycle runbook.
- `retry`: a potentially transient failure without a known ambiguous financial write. The next
  attempt is persisted with exponential delay (15 seconds doubled per failure, capped at 900)
  plus 0–9 seconds of jitter. Five failed attempts stop automatic retries.
- `blocked`: connection changed, automatic export disabled, order removed, provider rejected,
  retry limit reached or a sent write has an unknown outcome. A fresh save cannot bypass it.
- `succeeded`: the captured saved version was exported; a newer saved version remains queued.

Connection changes never retarget old intent. Underlying write receipts and locks remain the
financial authority: pending/unknown writes are never blindly resubmitted. Turning auto-export
off stops new job starts; it cannot undo a provider write already submitted.

Queued/retry work survives process restart. An in-flight interrupted claim remains visible for
reconciliation, rather than automatically duplicating a possible remote invoice. Automated
reconciliation/legacy-adoption tooling is still unfinished; no claim of unattended recovery of
all interrupted writes or provider-side exactly-once behavior is made.

## Administrator status and safe resume

Desktop Orders → **Export status** shows the original company, saved/exported versions, state
and a safe reason. Counts cover the queue; the list shows up to 100 rows, attention first.
Refresh handles loading, empty and server-error states. Old-company records are labelled rather
than shown as proof of export to the current company. No raw provider body or credential is shown.

**Retry automatic export** appears only for disabled-auto-export, retry-limit or definite-provider-
rejection cases. Correct the problem and enable automatic export first. The endpoint requires
`users.manage`, cloud execution and recent password/enabled-factor verification; it requires the
original current connection. It does not clear provider receipts or locks. Unknown outcomes,
interrupted claims, removed orders and changed connections cannot be resumed through it.

The auto-export checkbox also restores its previous value if saving/verification is cancelled or
fails. Closing/refreshing the status view cannot trigger an export. Ordinary order editors do not
receive administrator-wide job listings; the API enforces this independently of hidden buttons.

## Storage, release and rollback

The new table is created idempotently, without changing existing columns or schema version.
Generated types are updated. It is cloud-only and stripped from effects/sanitized node snapshots.
Rows store non-secret connection/company IDs, order IDs, version/claim/attempt state, safe error
codes and times; no bearer tokens, request payloads or raw errors. Approve retention alongside
accounting reconciliation duties; do not clear blocked rows as routine housekeeping.

Old pending work is not backfilled by guessing intent. Before deployment, exercise the real
provider and expected workload in staging, observe worker progress/queue growth, and rehearse
interruption/reconciliation and compatible rollback. Older code does not consume these jobs or
understand the underlying company-bound receipts: pause exports before rollback and reconcile
already accepted remote writes. Monitoring/alert delivery, supported rollout and complete
financial/tax mapping acceptance remain release work.

## Validation and design reference

Focused tests use real save transactions, failure injection, actual edit requests during delayed
exports, persisted retry limits, unknown outcomes, reconnects, role/fresh-proof boundaries,
node exclusion and sanitized snapshots. Playwright exercises the actual status screen, server
error/refresh recovery, absence of an unsafe retry button and an axe scan. `node scripts/test-qbo-worker.mjs` is a separate disposable
server-startup smoke that checks that committed pending intent is consumed after launch, using the
adapter's test provider. None of these uses a live Intuit account.

The local design follows the atomic intent/idempotent-consumer principles in
[AWS Prescriptive Guidance: transactional outbox](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html),
reviewed 18 October 2026. The application uses SQLite, not AWS messaging infrastructure, and
makes no claim that a broker or local queue can guarantee exactly-once remote financial effects.
