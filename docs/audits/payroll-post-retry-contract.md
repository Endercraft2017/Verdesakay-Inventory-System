# Payroll GL posting: durable retries and local commands — 23 October 2026

Baseline: production `0de7c12021c16b17499a03d6535c4269d299a4aa`.
Scope is the explicit payroll-to-GL POST's retry receipt and originating office
command persistence. Source-version approval, offline factor design, recognition
policy, settlement and broader sync resilience remain separate open work.

## Demonstrated gaps before application changes

| Severity | Reproduction | Required resolution |
|---|---|---|
| High | A trigger rejects idempotency receipt insertion. HTTP still returns 201 and one payroll journal commits. | Journal and success receipt must commit together; failure cannot acknowledge success. |
| High | Retrying that same key after the failed receipt creates three journal rows: original, reversal, replacement. | A committed keyed attempt returns its recorded acknowledgement without another posting; inability to save its receipt rolls back its journal. |
| High | At the disconnected authorized main host, a trigger rejects sync_commands insertion. HTTP returns 201 plus a command ID, one journal exists, but that command does not. | For this route only, local journal, optional keyed receipt and durable command must commit before success; command-record failure rolls them back. |

The isolated baseline fixtures/logs and observations are retained as
`evidence/payroll-post-baseline-*`. These are three failing assertions on
the unchanged source, not inferred vulnerabilities or accounting-policy judgments.

## States and boundaries

- Before execution: authenticated request, current payroll management permission,
  existing module/tenant/claim authority checks. An optional key identifies one
  attempt on this originating server; it does not confer authority.
- Executing: source validation and reversal/replacement remain the existing bounded,
  synchronous operation. A keyed receipt shares its transaction. At an installed
  office, its business writes and sync command share an outer transaction.
- Committed: acknowledgement can be sent. A lost response leaves a durable receipt
  for the same key. Failure before commit leaves no journal/receipt/command for that
  attempt. An HTTP timeout/connection loss alone does not prove rollback.
- Office acknowledgement: saved locally, pending cloud confirmation. Receipt replay
  refers to the same command, never generates another one, and checks its current
  state. Missing/rejected/conflicting commands hold rather than re-execute.
- Confirmed command: the existing sync protocol supplies confirmation. An old posting
  acknowledgement is historical evidence, not proof that current payroll still
  matches that journal. Reconciliation remains the current-source read.

Trust boundaries are browser→tenant/session/permissions; handler→SQLite; office
database→durable command; office→existing authorized sync replay; and browser
context changes. No cloud-only MFA requirement is added to accepted offline work.
Internal replay remains subject to the existing actor/permission and D6 rules.

## Testable rules and implementation limits

1. Updated browser submissions use one cryptographically random key per modal
   attempt. Errors/uncertain responses retain that key and submitted label. A changed
   actor/company/view invalidates the open action and ignores late output.
2. A keyed receipt is tenant-database/actor/key scoped and method/path/body/access
   bound. Current route permission checks run before lookup. Known generic legacy
   receipts conflict for reconciliation instead of being executed again.
3. Receipt insertion is mandatory for keyed success and atomic with posting. The
   existing idempotency table is reused with a dedicated versioned namespace; these
   financial acknowledgements are excluded from the generic seven-day deletion.
   No raw key/password/session bearer is added to receipt storage.
4. The generic HTTP cache must not intercept this route (including Express path
   aliases) before its permission and durable-receipt checks.
5. Only this synchronous JSON route opts into atomic local command capture. It keeps
   its claim class and main-host authority. Other route capture behavior is unchanged.
   Recheck live authentication/permissions after waiting for the local capture lock.
6. Same-key concurrent/lost-response/restart retries must not create another journal
   or command. A different key remains an explicit separate re-post under existing
   rules. Keyless old clients/accepted old commands remain compatible and do not gain
   retry guarantees. Unknown already-expired legacy keys cannot be reconstructed.
7. Receipts are node-local, as before. No cross-server/global exactly-once guarantee,
   automatic recovery after moving to another server, power-loss/storage durability
   certification or full cloud effect-stream crash guarantee is claimed.

Source review also identifies separate orchestration boundaries: authority dispatch,
effect-stream flush and command verdict persistence are separate operations in the
existing sync engine. This opt-in capture does not make those paths atomic. Replay/
rebase interruption and full authority-to-replica recovery remain explicit engineering
work, not a reason to describe this limited fix as complete payroll/sync readiness.

## Research basis

Primary sources accessed 23 October 2026:
[HTTP RFC 9110 §9.2.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2)
explains why non-idempotent retries need supporting semantics;
[SQLite atomic commit](https://www.sqlite.org/atomiccommit.html) explains why related
durable writes must share a transaction, subject to storage assumptions;
[OWASP transaction authorization](https://cheatsheetseries.owasp.org/cheatsheets/Transaction_Authorization_Cheat_Sheet.html)
supports current server authority and significant-data review. Retry receipts do
not implement that separate reviewed one-use/source-version-bound approval control.

Final verification must include database assertions, receipt/command faults,
same-key and changed-input/access tests, concurrency, lost-response browser recovery,
real process termination/restart, and offline post/re-post/replay checks. Retain
failures and exact source hashes. Keep the overall release hold open.

## Additional demonstrated failure and results

The real browser operator-change test initially failed on the new guard: `App.user`
is not an exposed account accessor. That comparison could remain undefined across
an operator change. It now uses `App.getMe()`. The failing browser run is retained;
the corrected operator/company/view scenarios pass. This is a high stale-context
submission defect, not proof that the server accepted an unauthorized posting.

A two-process experiment forces both servers to observe a receipt miss before the
first server commits. The unchanged baseline creates original/reversal/replacement;
the fix rechecks under `BEGIN IMMEDIATE` and returns one entry to both requests.
The permanent focused regression passes 65 tests across six files, including tenant
isolation with identical IDs/key, session revocation, permission changes while waiting
for capture, original-command conflicts and healthy offline post/re-post/cloud replay.

Five real-process experiments run on both graphs: SIGKILL before/after receipt insert,
after commit before HTTP emission, two concurrent server processes, and SIGKILL at
originating-node command insert. Baseline violates four cases; the already-committed
receipt case passes on both graphs. Fixed source satisfies all five. The isolated
baseline drill deliberately expects known violations, so its exit zero is not a
baseline correctness pass. WAL and `synchronous=2` were observed. Process death does
not model power loss. The node experiment uses the real capture with a node-role
database, not a real Windows/LAN installation.

Six new Playwright scenarios cover real committed-response loss, response deadline,
actor/company/view invalidation and eight width/theme accessibility scans. Initial
failures include two test assumptions (toast selector and navigation closes modals)
and a theme-transition contrast observation; awaiting the actual background transition
settles the theme without suppressing any axe rule. Earlier failures are retained.
Automated axe results do not replace keyboard/assistive-technology review.

See the [recovery procedure](../operations/payroll-post-retries.md), final dated
[validation record](validation-results.md) and `evidence/payroll-post-verification.json`
for final regression results, source/evidence hashes and remaining uncertainty.
The [research and reproduction guide](payroll-post-research.md) maps six primary
sources to requirements and preserves manual accessibility/runtime limitations.
