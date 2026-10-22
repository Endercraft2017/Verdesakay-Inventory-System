# Payslip email release contract

Scope: tenant staff review through SMTP submission and recovery. Baseline production
commit e7cf902f2c225fe8bd1a7964d403c8647483eb37; observed 2026-10-22.
Existing audit reports are leads, not evidence. Broader release hold remains open.

## Requirements fixed before implementation

1. Only a current cloud session with payroll.manage and fresh verification can approve.
   Review binds tenant, actor, session digest, current credentials/permissions, record
   revision and complete saved source, strict employee/account identity, one recipient,
   rendered HTML, subject, sender and mail configuration. Never accept browser payroll HTML.
2. Review expires in five minutes. Confirmation and dispatch independently recheck source,
   recipient/account, authorization, live session and freshness. Any mismatch prevents
   submission and requires review again. The durable dispatch claim is the authorization
   boundary: later edits cannot recall an SMTP transaction already begun.
3. Confirmation commits a durable intent and mandatory event before acknowledging it.
   Repeating that confirmation returns the same intent. Competing confirmations for the
   same payslip cannot create independent first submissions. Recovery consumes one
   explicitly identified previous attempt, with reason, evidence reference and duplicate
   risk acknowledgement. New payroll versions do not erase previous submission history.
4. Each intent can be claimed once, atomically, before network I/O. No database transaction
   spans SMTP. Worker crash, timeout, lost final acknowledgement, or inability to persist an
   outcome yields unknown. Never reclaim or automatically resend an interrupted attempt.
5. States: review -> queued -> sending -> accepted | not_accepted | unknown.
   review and queued may become cancelled or expired. Terminal outcomes stay historical.
   accepted means the SMTP peer accepted responsibility, not mailbox delivery. There is no
   confirmed-delivery claim or exactly-once guarantee. Message-ID is correlation only.
6. Email is online only. Its intents, events, proofs and payloads do not replicate to office
   nodes. Existing payroll computation, paid marking and sync replay authority are unchanged.
7. Store payload encrypted using the application's existing secret facility; purge abandoned
   reviews on expiry and terminal payload after one day. Retain masked recipient, hashes,
   correlation and events for investigation. The database-generated fallback encryption key
   shares the database's compromise boundary; external key/backup policy remains an owner duty.

## Trust boundaries and independent oracles

Browser input is untrusted; the tenant-bound server generates the exact review payload.
Session state and permissions are reread rather than trusted from an old browser view.
Tenant SQLite is the durable acceptance authority; SMTP is an external, non-transactional
side effect. A mail server's acceptance cannot atomically commit with SQLite. Recovery
therefore favors visible uncertainty over silent loss or automatic duplication.

Tests derive expectations from these numbered rules, not from handler branches. Independent
observations: real TLS SMTP envelopes/MIME and final replies, direct database rows and
events, concurrent HTTP results, child-process termination/restart, actual browser behavior.
Local fixtures cannot prove a real provider's delivery, tenant backup persistence or live
multi-instance hosting behavior. Those require external verification and independent review.

## Baseline demonstrated gaps

Five deliberately failing reproductions use a TLS-verifying local SMTP capture, synthetic
identities and actual Nodemailer SMTP (not JSON transport). Raw evidence retained separately.
E1 has two reproductions; E5 is a source/SMTP-semantics finding, not a separate baseline browser test.

| Finding | Severity | Observation | Required repair |
|---|---|---|---|
| E1 missing review binding | High | POST {} sent; ignored old revision/recipient and sent changed pay to changed address | exact expiring review + final source checks |
| E2 duplicate submission | High | two concurrent POSTs produced two MIME messages | durable business deduplication + atomic claim |
| E3 dishonest uncertainty | High | peer stored DATA then disconnected; both retries logged failed and produced two messages | unknown outcome, explicit controlled recovery |
| E4 outcome lost after acceptance | High | peer accepted; injected mail_log failure returned 500 with zero log rows | persist before SMTP; mandatory atomic events |
| E5 acceptance labeled delivery | Medium | HTTP ok and UI 'Payslip emailed' after SMTP response alone | precise status and delivery unconfirmed |

Additional implementation checks found and corrected additional defects before delivery:

| Finding | Severity | Retained reproduction | Resolution |
|---|---|---|---|
| E6 domain normalization misclassified acceptance | Medium | reviewed Recipient@EXAMPLE.TEST, wire Recipient@example.test, final success incorrectly unknown | normalize domain before review/envelope; preserve local-part case (RFC 5321 2.4) |
| E7 installed process without enrollment accepted stranded work | High | DEPLOY_MODE=node with no sync_node: preflight/review 200, confirm 202, queued intent, worker false | explicit process-mode refusal on the entire email namespace, plus configured-node and worker checks |
| E8 actual node export failed or retained cloud markers | High availability; low metadata exposure | queued intent/events caused a foreign-key export failure; settings scrub recreated two marker rows | clear child events before parent intents in the private copy, then clear markers after settings scrub and VACUUM; assert file contents and preserve original queued work |

These findings describe the implementation under development, not unverified claims
about the original production code. Other development failures (fixture columns, tenant host,
modal API, focus handling, protected-frame scan and module import) are recorded in the
verification notes. Only final frozen-source runs count as delivery validation.

## Primary-source rationale (accessed 2026-10-22)

- [OWASP Transaction Authorization](https://cheatsheetseries.owasp.org/cheatsheets/Transaction_Authorization_Cheat_Sheet.html): significant data, enforced sequence, final control gate, limited validity and unique authorization. Applies to sensitive payroll disclosure, without claiming this is a banking authorization system.
- [RFC 5321](https://www.rfc-editor.org/rfc/rfc5321.html), 4.2.5, 4.5.3.2.6, 6.1: positive final DATA reply accepts responsibility; losing it can cause duplicates; later delivery failure remains possible.
- [Nodemailer SMTP connection](https://nodemailer.com/extras/smtp-connection) and [error reference](https://nodemailer.com/errors): accepted/rejected recipients, final response, command and responseCode. A transport exception alone does not establish rejection.
- [Nodemailer message configuration](https://nodemailer.com/message): explicit envelope, Message-ID, sender/reply-to and disabled file/URL access. [RFC 5322 3.6.4](https://www.rfc-editor.org/rfc/rfc5322.html#section-3.6.4) defines message identification, not a delivery or deduplication receipt.
- [SQLite transactions](https://www.sqlite.org/lang_transaction.html): one concurrent writer, snapshot reads, savepoints and rollback. Use short transactions and database uniqueness, never a network-spanning transaction.

Nodemailer /usage/ returned no readable content to the research tool; the connection and
error reference pages above supplied the relevant primary documentation instead.
