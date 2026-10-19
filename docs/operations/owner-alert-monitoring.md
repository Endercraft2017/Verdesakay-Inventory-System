# Owner-alert monitoring and review

Implemented 19 October 2026 on `production`. Open owner console → Email alerts. This is
read-only delivery observation, not release approval or a guarantee that email arrived.

## What the screen measures

The summary counts every retained signup and business queue record, rather than only the
latest thirty. It displays all seven states, due pending/retry work, the oldest queued creation
time, review count, worker state and observation time. Refresh is manual; the displayed time
matters. The existing recent list remains, with a separate filtered, paginated history.

“Needs review” includes blocked/unknown records, cancellation for event expiry, inflight claims
missing or older than two minutes, and pending/retry records with five attempts, more than
five minutes overdue, more than seven days old, or created over one minute in the future.
These are stored warning records, including history: review outside the app does not clear
them. They are not a count of independently confirmed unresolved incidents. Expected
configuration-change cancellations alone are not warnings. The thresholds are engineering
defaults, not a customer SLA. No worker state implies inbox delivery.

The cloud worker persists its latest start, finish, outcome and last successful pass in the
platform catalog. A run ID prevents an older pass overwriting a newer observation. Worker
states distinguish unobserved, disabled on installed nodes, running, idle, processed, failed,
stale (two minutes), invalid timestamps and malformed records. “Successful” means the pass
completed, including processing a blocked/cancelled result; it does not mean provider acceptance.
`clear` only means no defined warning and a current observation, not app health certification.
The singleton describes the shared catalog worker, not individual replicas or multi-host health.

## Review procedure

1. Refresh. If reads fail or time out, keep the existing evidence and retry; do not interpret a
   failed refresh as a clean queue. Reads abort after twenty seconds; this does not stop server work.
2. Use Needs review first, then Queued or sending and All delivery records. Load older records
   to inspect history beyond the first page. Record queue, event ID, state, creation time and code.
3. For unknown/stale inflight, inspect the existing provider records through the authorized
   provider account before considering recovery. Never infer non-delivery from a timeout or
   resend blindly. This screen does not resend, resolve or requeue records.
4. For blocked/configuration errors, inspect the mailbox configuration without sharing secrets.
   Correct configuration through the existing protected settings flow; historical events remain
   evidence and are not automatically replayed under a new configuration.
5. For stale/failed/unobserved worker, inspect safe server logs, cloud deployment mode, process
   lifetime and catalog availability. If the API itself fails, use a separate host monitor. Do not
   delete claims or restore an old catalog to make the display appear healthy.
6. For future/invalid clocks, correct host time and investigate ordering before interpreting ages.
   Preserve evidence and follow incidents.md and owner-alert-outbox.md.

An external watchdog, its notification destination, incident ownership, acknowledgement and
escalation test are still required before release. A dashboard that requires someone to watch
it is not operational paging. No external alert service was provisioned by this increment.

## API and data boundaries

Authenticated, no-store `GET /_platform/api/mail/delivery` accepts `filter=all|attention|queued`,
`limit` integer 1–50 (default thirty), and an optional bounded base64url cursor. Response has
`health`, `filter`, threshold time `at`, `rows` and `next_cursor`. Rows expose queue, event ID,
source kind/ID, tenant slug, state, attempts, safe code and creation/update timestamps. Message
body, subject, recipients, event key, configuration stamp, worker run ID and secrets are omitted.
The existing authenticated `/mail` response also includes `delivery_health`; its pre-existing
mail settings/log access is unchanged. Old provider log entries are not retroactively scrubbed.
Invalid parameters return authored 400s; unexpected read failures return generic correlated 500s.

History orders creation descending, queue ascending, ID descending. The queue tie-break handles
equal IDs/timestamps across tables. Cursor parameters are validated and bound, including filter;
the cursor is navigation, not a signed authorization token. Every request still requires owner
console authentication. Its captured time stabilizes attention thresholds only. State membership
and records remain live; refresh to see additions or changed states. Summary counts and heartbeat
are read in one SQLite statement; history is a separate statement, not an immutable snapshot.

The frontend retains the last successful list/health/filter on failed refresh, aborts active reads
when closed, and disables concurrent navigation. It does not poll automatically. Stored text is
rendered through textContent. Monitoring reads do not run maintenance or change delivery state.

## Persistence, failure and rollback

Additive platform schema: singleton `platform_owner_alert_worker` and two recent-history indexes.
No tenant schema version change or dependency was added. Heartbeat metadata has no provider
payload or recipient address. Queue metadata remains subject to the existing retention/review
policy; this change does not introduce automatic metadata deletion.

Failure to persist a start prevents processing that pass. Failure to persist a finish may leave
an incomplete heartbeat, eventually stale, but cannot requeue a completed provider acceptance.
The existing worker still owns provider deadlines, stale-claim conversion and conservative
unknown/no-resend policy. A failed pass stores no raw exception. Restoring a catalog can lose
claim/acceptance evidence; reconcile provider results before resuming, as in the outbox runbook.
Old code can ignore the additive table, but will no longer update its heartbeat: expect stale
observations after rollback, not healthy status. There is no per-replica heartbeat registry.

Summary/attention queries scan retained metadata; recent indexes assist ordering but do not
establish capacity at arbitrary history sizes. Local synthetic tests do not certify hosted load,
provider acceptance, delivery/bounce handling, real notification routing or end-to-end SLOs.
See `docs/audits/evidence/alert-monitor-verification.json` for exact local checks and limits.
