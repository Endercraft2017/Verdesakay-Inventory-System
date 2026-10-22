# Reviewed payslip email release and recovery

This change addresses payslip email disclosure only. It does not lift the application's
broader production release hold. [Contract and findings](../audits/payroll-email-contract.md)
define the requirements; the verification manifest records the final checks.

## Staff procedure

1. Save payroll, resolve identity/cutoff conflicts, and mark the correct record Paid through
   the existing payroll workflow. Email cannot mark pay as settled or change its amounts.
2. In Payroll, choose **Email payslip**. Check the current saved revision, single recipient
   from the employee's linked active account, and previous attempts. A missing/invalid
   address or held payroll source must be corrected before review.
3. Choose **Review exact email**. Complete existing identity verification if requested.
   Review the sender, recipient, subject and rendered saved content. No new authentication
   factor or phone requirement is introduced by this change.
4. Choose **Confirm email release**. The server commits a durable queued intent before
   responding. **Queued is not delivered.** Use **Refresh status** to inspect its outcome.
   Closing an unconfirmed review never queues a send; its encrypted payload expires.
5. An approval and its sign-in proof must remain current, for at most five minutes.
   The review expiry is capped by the original verification time, rather than extending
   authentication by repeatedly opening reviews. Changed source, recipient/account, mail
   settings or operator authorization requires review again. Changes reverted to their
   former values still invalidate approval through monotonic database change markers.
6. **Cancel queued release** is available before a worker claims it. Sending cannot be
   recalled through this application. Close/Refresh does not cancel confirmed work.

The browser clears stale content on refusal and clears private review details after an
account/company/view change. The preview blocks scripts, forms and external resource loads;
trusted parent code provides Escape handling inside the frame. Email-client rendering and
externally loaded template assets may differ from this protected preview.

## Meaning of each state

| State | What is established | Staff action |
|---|---|---|
| review | Server prepared a bound preview; no send authorized | Review then confirm, or close and let it expire |
| queued | Confirmation and mandatory event committed | Refresh; cancellation remains possible before claim |
| sending | One durable claim committed; an SMTP attempt may be in progress | Wait; do not submit a replacement |
| accepted | The SMTP peer returned final success for the single reviewed recipient | Delivery remains unconfirmed; investigate bounces in the provider |
| not_accepted | A definite SMTP 4xx/5xx rejection was recorded for an identified command | Correct the reported problem and investigate before a reviewed retry |
| unknown | The application lacks a trustworthy final outcome | Follow the investigation procedure below; never blind-retry |
| cancelled | Work was stopped before sending, manually or by a changed approval/source | Inspect the reason; a new release needs fresh review |
| expired | Approval expired before sending | Review again if a send is still needed |

No provider delivery callback/DSN ingestion is implemented. API delivery_confirmation is
`unavailable`, including after acceptance. A client-generated Message-ID correlates attempts;
it is neither a provider delivery receipt nor a provider idempotency guarantee. SMTP does not
give this application exactly-once delivery.

## Lost response, failure and recovery

- If confirmation's response is lost, repeat **the same confirmation** or inspect history.
  Its review ID and proof acknowledge the existing intent; they cannot create another send.
  A new login cannot reuse the old session's proof. Reopen the record to inspect its history.
- The cloud worker submits each claimed attempt once. There are no automatic retries of
  rejected or uncertain SMTP attempts. At startup and on subsequent passes, a claim older
  than 120 seconds becomes unknown. It is never reclaimed for automatic sending.
- Provider acceptance followed by a database/outcome-event failure leaves a durable sending
  claim. It becomes unknown rather than disappearing or causing an automatic resend.
- Inspect the mail provider using the recorded Message-ID, time, recipient and reference.
  The provider may have accepted and later bounced the message. Absence from one search
  is not proof of non-delivery. A recipient's report alone cannot establish non-acceptance.
- For an interrupted/stalled worker, establish that the original process/connection cannot
  resume before considering another submission. If necessary, stop all old mail-worker
  instances, investigate, then restart. An old SMTP transaction cannot be recalled by
  changing a database status. A lease timeout alone does not prove the old process died.
- If another email is justified, reopen the record, record a recovery reason and provider
  investigation reference, and explicitly acknowledge duplicate risk. Review current
  recipient/content and confirm. The new attempt references the previous confirmed attempt;
  two concurrent recoveries cannot both consume that predecessor. The original outcome
  remains historical, including unknown. An accepted attempt also requires this explicit
  process before another email. This bounds application resends; it cannot prevent a
  provider/recipient system from duplicating or forwarding accepted mail.
- Historical mail_log entries predate reliable record/revision binding. Recognized subjects
  (current number/period and saved period history) require investigation and risk
  acknowledgement before a new release. Old missing logs, renamed record numbers, ambiguous
  subjects, and pre-upgrade crash windows cannot be reconstructed reliably. Review provider
  history independently; an empty application history is not proof no old email was sent.
- Never delete intent/event rows, rewrite unknown to failed, reuse a Message-ID as a claimed
  deduplication guarantee, or reset an intent to queued to force a retry.
- Before starting workers on a restored database, disable SMTP in that restored copy while
  it is offline, then reconcile its queued/sending attempts against provider history. A
  backup may predate an external acceptance; restoring it is not equivalent to a process
  restart with the latest database/WAL. Re-enabling SMTP changes the configuration binding;
  use fresh reviewed attempts after investigation. No exactly-once guarantee spans rollback
  to an older backup, provider behavior or a live worker resuming after a lease timeout.

## Server and database contract

Schema 85 adds cloud-only `payroll_email_releases`, `payroll_email_events` and
`payroll_email_versions`, uniqueness indexes and a state-transition trigger. Existing schema
upgrade snapshots and form revision triggers remain in place. Change-marker triggers watch
payroll records, relevant user/employee fields, roles, MFA, templates, variables and settings.
These are technical invalidation markers, not an alternative payroll revision history. The
private node export clears child events before parent intents and clears markers again after
settings scrub, then VACUUMs; actual export-file tests verify zero cloud email rows and no
retained proof/payload bytes. Cloud intent/history and queued work remain unchanged.
Address domains are normalized to lowercase before review; mailbox local-part case is preserved.

The intent contains encrypted content plus digests of its review proof, source, recipient,
credentials and session; raw session bearer tokens and SMTP passwords are not stored in it.
The content hash is SHA-256 of the reviewed UTF-8 HTML after normalizing line endings to LF.
SMTP MIME uses CRLF/transfer encoding; decode and normalize before comparing the hash.
Sender settings/password ciphertext are included in source binding. The worker captures the
validated configuration and uses an explicit one-recipient envelope, verified TLS and
disabled file/URL attachment access. Operational SMTP I/O is bounded by a 30-second deadline
and shorter connection/greeting/socket timeouts; its owned socket is closed on completion.

Confirmation, claim and each outcome commit together with their mandatory state event in
short synchronous SQLite savepoints. Network I/O never spans a database transaction. Database
uniqueness enforces one confirmed first attempt per record and one successor per predecessor.
The dispatch claim is the final authorization boundary: changes after submission begins
cannot recall the message. A second process cannot claim the same queued row.

The real cloud entry point runs one bounded email pass at startup and every five seconds,
one intent per tenant per pass, with a local overlap guard. Every pass checks tenant context,
module/write eligibility, current operator permissions, credentials, live session/idle expiry,
fresh proof and source binding. It also refuses a configured office-node database, independent
of the process environment. Busy/error passes leave durable work for inspection/recovery.
Queue capacity/latency under real tenant counts remains unmeasured; serial SMTP latency and
the five-minute approval window can cause visible expirations. No throughput promise is made.

All email endpoints require payroll.manage and are online-only. Review, confirm and cancel
also require fresh verification. Responses use private, no-store caching.

| Endpoint under /api/hr/payroll/:recordId/email | Behavior |
|---|---|
| GET / | Current record/revision, full authorized recipient, source stamp, up to 20 masked confirmed attempts; recoverable history even if source is now unavailable |
| POST /review | Strict source_stamp, optional explicit recovery details; server-created content and one-use proof |
| POST /confirm | Strict review_id + review_token; durable acknowledgement, including safe replay of that confirmation |
| POST /:releaseId/cancel | Strict empty body; stop review/queued work only |
| POST / (legacy) | Refuses direct sending and requires updated review UI |

Generic HTTP idempotency receipts are bypassed for this namespace, including old cached
successes, so they cannot bypass fresh authorization or retain review proofs. The durable
intent owns confirmation replay. Existing generic mail sending/log semantics for other
features remain unchanged; payslip outcomes are inspected in payroll release history.

Office payroll computation, paid marking, D6 site authority, source revisions and normal
offline replay remain unchanged. Email release intents, events, invalidation markers and
their encrypted payloads never enter node snapshots or replicated effects.

## Retention, observability and independent acceptance

Abandoned reviews lose their payload on expiry. Terminal payloads are logically purged after
one day by maintenance passes; outcome metadata/events remain for investigation. This is not
secure erasure from WAL, backups, exports or provider mailboxes. Approve a retention policy
and independently review backup/key arrangements. The existing fallback encryption key is
stored in the database unless an external application/mail key is configured; it does not
protect against a complete database compromise.

For a read-only operational inspection, use the correct tenant database:

```sql
SELECT id,record_id,revision,state,recipient_mask,message_id,outcome_code,
       confirmed_at,claimed_at,finished_at
FROM payroll_email_releases ORDER BY seq DESC LIMIT 20;
SELECT release_id,state,code,actor_id,created_at
FROM payroll_email_events ORDER BY id DESC LIMIT 50;
```

Worker errors deliberately omit payroll content, SMTP responses and credentials. Persistent
queued/sending states or repeated worker errors need investigation; no external monitoring
service or provider callback was configured by this task.

Before operational acceptance, obtain independent code/security review of the transaction
and tenant boundaries; verify actual provider rejection/bounce behavior, mailbox delivery,
SPF/DKIM/DMARC and authorized recipient setup; test persistent-disk/backup restore and worker
operation on the hosting platform; confirm recovery ownership and retention/legal policy.
Legal compliance and payroll accuracy are not certified by these software experiments.

Schema/rollout acceptance: tests use schema 85 and upgraded code on all simulated sites.
Mixed-build sync and actual Windows client rollout/update remain unverified. Review that rollout
before operational acceptance; this change does not certify old native packages.

Cutover/rollback: drain and stop cloud instances that still expose the old direct-send handler
before enabling the reviewed workflow. Do not run both versions against the same tenant or
roll back to direct sending with SMTP enabled. Disable SMTP and reconcile provider history
before an old-build rollback or restoring a backup; review/confirm again on the supported build.
