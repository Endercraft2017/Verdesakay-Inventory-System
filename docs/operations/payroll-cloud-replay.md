# Cloud confirmation of office payroll postings

23 October 2026. Applies only to payroll GL commands received by a cloud authority
running this build. The originating office's [posting/retry contract](payroll-post-retries.md)
continues to apply. [Audit requirements/evidence](../audits/payroll-replay-contract.md)
describe the tested boundary; this is not complete release approval.

## What operators should expect

The original office posting stays local until synchronization confirms it. Cloud
persistence failure does not mean the local posting failed, and does not authorize
another posting. Keep the original command and journal references; retry synchronization.
Do not open a new posting dialog to work around a sync error.

| Observed state | Meaning | Action |
|---|---|---|
| Local / host-confirmed | Accepted on the office PC/site, not finally confirmed by cloud | Keep that PC/data available and synchronize |
| Cloud temporarily unavailable / 503 | Cloud could not finish its transaction or return a decision | Retry synchronization; original command remains pending |
| Confirmed | Cloud journal, its stream effect and verdict committed together under the new protocol | Verify current payroll comparison separately; confirmation is not settlement |
| Rejected | Real validation/authorization refusal, with no new payroll posting from that replay | Review the original command, source and permissions through existing attention/reconciliation workflows |
| Undecided payroll needs reconciliation / 409 | Historical or inconsistent inbox/marker cannot prove safe execution | Stop automatic assumptions; preserve both databases and escalate the original command ID |
| HTTP connection loss / timeout | Caller lacks a response; commit may already exist | Repeat synchronization of the same command, not payroll posting |

The cloud's command-status endpoint now reads the stored state rather than assuming
everything is confirmed. It uses the existing own-command/management permission check;
unknown IDs return 404. Non-sync installations retain their legacy non-queued response.

The normal main-site claim, LAN host-confirmation and D6 decisions remain. The cloud
still executes the actual payroll route as its recorded actor, with its original clock
and allocation plan. This change does not add a cloud-only authenticator to offline
work or turn a sync verdict into source-version approval, bank payment or tax filing.

## Engineering recovery procedure

1. Identify the tenant, originating PC/site, command ID, cutoff/label, original journal
   and symptom. Obtain private backups of the cloud and originating office before any
   repair. Use the approved backup/restore process; do not copy an open SQLite main file
   without its WAL state. Never collect passwords, tokens or authenticator codes.
2. Inspect the existing sync error/command status and **Reconcile payroll** on the
   originating server. On a controlled copy, inspect the cloud's command, protocol
   marker, linked effects, all payroll journals (including reversals) and lines.
   One live journal alone cannot expose an unintended reversal/replacement sequence.
3. For a protocol-1 received command, a process interruption leaves no partially committed
   payroll transaction. The same immutable command may be synchronized again. If it still
   fails, retain correlated errors and investigate storage/validation/authorization;
   repeated infrastructure failure must not be converted to rejection by hand.
4. For an old received command without a marker, **do not insert a marker, delete the
   command/receipt, manufacture confirmation, or blindly replay it**. Previous code may
   have committed a journal without its effect/verdict. The original books and replica
   stream need case-specific engineering/accounting reconciliation. This change provides
   a safe hold; it does not automate ambiguous historical financial repair.
5. After a reviewed recovery, verify cloud journal/effect/verdict consistency, then verify
   the site's current comparison and replication on isolated restored copies before any
   approved live intervention. Record the evidence and accountant-approved decision.

Read-only inspection on the correct private tenant database can begin with:

```sql
SELECT c.id, c.state, c.authority_seq, c.response_status,
       p.protocol, p.request_hash
FROM sync_commands c LEFT JOIN sync_payroll_replays p ON p.command_id=c.id
WHERE c.id = :command_id;
SELECT authority_seq, command_id, length(changeset) AS bytes
FROM sync_effects WHERE command_id = :command_id ORDER BY authority_seq;
SELECT id, number, reverses_id, status, date
FROM journal_entries WHERE source_type='payroll_run' AND source_id=:cutoff_id
ORDER BY id;
```

These queries do not decide whether an uncertain historical posting should be repeated.
Do not publish private database contents in issue trackers. No generic repair command
is provided because absence of a stream effect does not prove absence of a financial write.

## Upgrade, retention and verification boundaries

`sync_payroll_replays` is a server-owned, node-local technical table added with
`CREATE TABLE IF NOT EXISTS` when sync schema is opened. No business column or global
schema-version change is needed. The inbox row and marker are inserted in one transaction.
The marker hashes immutable command fields; it is never trusted from a request body.
It is omitted from replicated data and scrubbed from actual node-download snapshots.

Markers are retained when old command rows are trimmed/deleted. A surviving marker
without its command holds rather than permitting the ID to execute again. Include this
small financial replay metadata in the approved retention/backup policy; do not purge it
as a retry fix. Existing decided legacy commands still return their stored verdict;
this does not retroactively certify their historical stream consistency.
New effects/verdicts use the actual server confirmation time for retention. Payroll
business rows still use the original command clock. An old offline event therefore
does not make a newly saved confirmation immediately eligible for age-based cleanup.

Only synchronous payroll cloud replay uses the new transaction. Site-host acceptance,
other routes, generic direct-cloud recorder flushing and interruption during node
undo/apply/rerun remain outside this guarantee. No SQLite transaction spans an awaited
loopback request. Unrelated changes are flushed before the bounded action; its own
changeset/verdict commit with it and duplicate recorder capture is discarded.

Independent review should assess recorder/transaction interaction, immutable command
binding, financial correction semantics and retention. Real Windows installations,
hosted storage/runtime, backup restore and mixed-build rollback need external acceptance.
Older cloud binaries do not implement this contract; avoid treating the guarantee as
portable across a downgrade or unverified rollout. The complete release hold remains open.

The process experiment also observed a schema/seed lock during simultaneous server
startup. Its final concurrency case uses two already-started processes and still sends
both command requests concurrently. Cold-start availability under shared-database
contention remains open; do not infer a supported multi-process deployment topology
from these command-request tests.
