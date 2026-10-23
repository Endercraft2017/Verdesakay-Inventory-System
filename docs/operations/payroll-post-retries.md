# Payroll General Ledger posting retries and recovery

23 October 2026. Applies to the updated desktop Cutoff tools → Post payroll to GL
and `POST /api/hr/periods/:id/post-payroll-gl`. This is a bounded retry/persistence
fix; the complete release remains on hold. See the
[contract and demonstrated defects](../audits/payroll-post-retry-contract.md).

## Operator contract

Review payroll and the read-only **Reconcile payroll** comparison before posting.
Posting books an aggregate journal; it is not bank payment, remittance, statutory
filing or evidence that an employee received money. A deliberate new posting can
reverse the previous journal and save a replacement under the existing rules.

The updated dialog assigns a random reference on its first submission. While that
dialog remains open, retries retain the same reference and submitted label. A
successful retry says **Recovered the original posting** and identifies the original
journal. It does not assert that payroll edited afterward matches that journal.
Use reconciliation to inspect the current source.

If saving times out or the response is lost, the app releases the button after its
20-second deadline. The outcome is unconfirmed in that browser. **Retry the same
open attempt.** Aborting an HTTP request does not roll back server work. Do not close
and reopen the dialog merely to retry: a new dialog creates a new reference.

Changing account, company or cutoff invalidates the open dialog. Review again in
the correct context. A current permission/session check still runs on the server;
an old success receipt is not authorization.

## Originating-server states

| Observation | Meaning | Operator action |
|---|---|---|
| Validation refusal | This request did not create a new posting | Correct/review the source; check reconciliation before a new attempt |
| 201 on the cloud | Posting and its supplied-key receipt committed in this tenant database | Record journal number; verify current comparison separately |
| 201, `X-Sync-State: local` | Local posting, keyed receipt if supplied, and command committed on this PC | Keep the PC/database available; monitor synchronization |
| Same-key 201, `Idempotency-Replayed: true` | Historical acknowledgement recovered, no new posting | Keep original journal/command reference; inspect current comparison |
| `X-Sync-State: confirmed` | Existing sync protocol marks that original command confirmed | Verify cloud journal/current comparison; this is not settlement evidence |
| HTTP timeout, connection loss or 500 | Browser has no success confirmation; a commit may already exist | Retry the same attempt; reconcile before any different attempt |
| 409 reconciliation hold | Request binding, legacy/corrupt receipt, or original command cannot safely be reused | Stop; follow reconciliation below |

Office authority remains the existing company claim/main-host decision. This route
does not add cloud-only MFA to accepted offline work. Internal replay uses existing
actor/permission and D6 semantics. Normal offline post, explicit re-post and cloud
replay are tested. The subsequent [cloud payroll protocol](payroll-cloud-replay.md)
commits that route's source, effect and verdict together. Other authority routes/
site-host acceptance and node rebase interruption remain unfinished engineering work.

## Reconciliation and exceptional recovery

1. Identify the company, originating PC/server, operator, cutoff, submitted label,
   journal number and any sync command ID. Keep backups/logs private. Never request
   passwords, bearer tokens or authenticator codes for troubleshooting.
2. On that same server, open **Reconcile payroll**. Compare saved payroll with the
   journal; inspect original, reversal and replacement entries and dates. Review
   closed periods and multiple live originals with the accountant. A single live
   entry does not prove there were no extra reversal/replacement rows.
3. For local commands, inspect sync status and the original command. A missing,
   rejected or conflicting command blocks cached acknowledgement. Do not delete a
   receipt/command, mark it confirmed manually, or invent another reference as a
   shortcut. Preserve a database backup and escalate to engineering for the specific
   sync recovery; this change does not implement automatic repair of that boundary.
4. If the page/key was lost, the server changed, or an older/keyless client was used,
   do not assume another submission is a retry. Establish whether the journal exists
   and whether the cloud has the original command before authorizing a new posting.
5. If a real correction requires a separate posting, review the current source and
   journal first, then deliberately open a new attempt. Existing reversal, balanced
   source and closed-period controls still apply. Do not rewrite historical receipts.

There is no generic automatic reconciliation script because a new journal can have
accounting consequences. The read-only comparison and retained records support a
reviewed decision. Record the decision, evidence and any authorized correction.

## Maintenance and engineering limits

The route uses the existing node-local `idempotency_keys` table with namespace
`payroll-gl:v1:`. It stores a hashed actor/key reference, request/access digest,
original response and optional command ID, without the raw retry key or bearer.
These financial acknowledgements are exempt from generic seven-day cleanup. They
can contain financial journal metadata: restrict database/backups and include them
in the organization's approved financial-record retention policy. There is no new
purge endpoint. Deleting receipts can turn old retries into new financial postings.

Known legacy generic receipts hold for reconciliation. Unknown previously expired
keys cannot be reconstructed. Keys are actor- and tenant-database-scoped, not global;
different operators, keys, new dialogs and keyless clients can intentionally submit
separate postings. No exactly-once business operation across devices/servers is claimed.
Node-local receipt tables are not part of replicated business state. Do not move a
retry to a new server or infer portable retry protection from snapshot enrollment.

Only this synchronous JSON route opts into atomic originating-node capture. Source,
receipt and command commit before JSON is emitted. Cloud payroll replay has its own
bounded transaction; other capture/replay routes and node rebase retain their existing
behavior. This route
does not yet bind a one-use approval to a reviewed source version. SQLite process
termination tests use WAL/FULL on this Linux filesystem; they do not certify storage
power-loss behavior, Windows packaging, backup restore or mixed-version deployment.

Independent review should examine transaction/capture interaction, accountant-approved
re-post semantics, receipt retention and offline authority/replay recovery. Hosting,
actual Windows/device rollout, real backups and organizational acceptance require
separate verification. The owner has no new engineering task for this increment.
