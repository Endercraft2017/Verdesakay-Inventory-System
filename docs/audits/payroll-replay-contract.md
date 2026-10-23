# Cloud payroll replay: transaction and recovery contract

23 October 2026. Baseline production `a92de92c173c41280a52ed734bad913f441f68a5`.
This follow-up covers only cloud confirmation of an office's payroll GL posting.
Originating receipts/commands retain the prior contract. Other replay routes, site-host
acceptance, node rebase interruption, direct-cloud write capture and external effects
are separate boundaries, not implicitly repaired here.

## Demonstrated gaps before code changes

| Severity | Actual unchanged-source observation | Resolution |
|---|---|---|
| High | Failing the command-linked sync_effects INSERT leaves a committed payroll journal, no effect and a received/undecided command. | Journal, effect and final verdict share one synchronous transaction before confirmation. |
| High | Failing the confirmed verdict UPDATE leaves journal + effect committed, command still received. | Verdict persistence failure rolls back journal/effect; the original local command stays pending and retryable. |
| High | Actual cloud GET command requests report both a received command and an unknown ID as confirmed. | Return the stored verdict under ownership checks; unknown IDs return 404. |

The two baseline assertions fail; observations, source drivers and logs will be retained.
These synthetic failures prove a persistence boundary, not an actual customer incident.
Two additional status assertions failed before that endpoint was corrected. The
original persistence reproductions and the later status reproduction are distinguished.

## States, trust boundaries and requirements

1. **Office local:** accepted posting and durable originating command exist. Loss of a
   cloud connection or a cloud persistence fault must not invent a rejection or require
   the operator to create a new posting.
2. **Cloud inbox:** command and a server-created protocol marker are saved atomically.
   The marker binds immutable command data, including actor, allocation plan and context.
   Same-ID/different-command requests must conflict before business execution.
3. **Executing:** only the synchronous payroll GL route opts into a cloud transaction.
   Recheck the durable command after acquiring SQLite write authority. Execute the real
   handler under its existing tenant, actor, permission, plan, clock and D6 semantics.
   No open transaction is held across the loopback await in the orchestrator.
4. **Confirmed:** journal/reversal/lines/numbering, one command-linked effect and its
   confirmed verdict commit together. A lost HTTP response recovers that verdict without
   executing payroll again. This is scoped command application, not global exactly-once.
5. **Rejected:** a genuine validation/authorization refusal keeps no new payroll writes.
   The durable rejection is returned through the existing sync protocol. Infrastructure
   failures remain undecided/retryable and must not be published as rejection.
6. **Interrupted:** process death before commit leaves only the inbox/marker; retry may
   execute. Process death after commit leaves the complete decision; retry returns it.
   Persistence exceptions must obey the same all-or-none source/effect/verdict rule.
7. **Legacy undecided:** a received command without the new server-owned marker is
   uncertain: old code may already have posted it. Hold with explicit reconciliation
   feedback; preserve the node's local command and accounting evidence. Never manufacture
   marker/confirmation or blindly replay historical work to hide uncertainty.
8. **Recorder isolation:** flush unrelated earlier recorder changes before the bounded
   action; persist its own changeset inside the transaction. Discard its duplicate
   process-local recorder capture after commit/rollback so a later pull cannot publish it
   again or lose unrelated later work. Tests must inspect the pull stream and a replica,
   not only source rows or HTTP status.
9. **Status honesty:** a sync-enabled cloud can still have received/rejected commands.
   Its command-status read must use the actual stored row, enforce existing ownership/
   management authority and return 404 for unknown IDs. A non-sync install's legacy
   response remains outside this queued-command contract.
10. **Clock separation:** preserve the command's original business clock for payroll,
    but stamp new effect/verdict retention metadata with server confirmation time.
    A delayed command must not lose its new verdict immediately to age-based cleanup.

Boundaries: office credential→tenant inbox, immutable command→internal replay secret,
current replay actor/permissions→business route, business writes→durable sync effect and
verdict, and effect/verdict→existing node undo/apply/rerun behavior. The original office's
claim/main-host authority and accepted D6 decision are preserved. Full source-version
approval, independent verification of command origin and cross-process revocation
linearization are not established by these fixes.

## Verification and independent evidence

Use existing source/schema/trigger review, explicit SQL fault assertions, same-ID binding
and concurrency tests, real HTTP commands/pull/status, payroll journal/line comparisons,
normal office→cloud→LAN convergence, and actual SIGKILL/restart around effect/verdict/commit.
Reproduce on the unchanged baseline and retain failed experiments. Run focused and full
Vitest, Playwright regressions, TypeScript, schema generation as appropriate and secret
scans. Keep input hashes and record actual outcomes before commit/push.

Primary sources checked today: [SQLite transactions](https://www.sqlite.org/lang_transaction.html),
[savepoints](https://www.sqlite.org/lang_savepoint.html),
[session extension](https://www.sqlite.org/sessionintro.html), and
[HTTP retry semantics, RFC 9110 §9.2.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2).
They support shared commit boundaries, serialized write/recheck, compatible replica
changesets and conservative POST retry handling. Process interruption does not certify
physical power-loss, Windows/storage/hosting or backup-restore behavior. Independent
accounting/security review and real installation acceptance remain separate requirements.

## Additional implementation defect caught by the audit

After an intermediate complete suite passed, a delayed-clock reproduction exposed a
high retention violation in the first transaction implementation: SQLite's replay clock
backdated the new effect and verdict to 2010, and 30-day cleanup immediately deleted
that newly confirmed command. This was introduced by moving technical writes into the
business replay context; it is not attributed to the original baseline. The correction
binds an explicit server timestamp for effect/verdict metadata while the journal keeps
its original command time. The failing assertion, timestamps, passing reproduction and
intermediate green suite are retained. Final verification runs again after this change.
