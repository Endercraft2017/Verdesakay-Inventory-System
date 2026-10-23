# Payroll cloud replay: research, methods and evidence limits

Primary sources checked 23 October 2026; existing audit prose supplied leads, not proof.

| Source | Decision informed | Limit |
|---|---|---|
| [SQLite transactions](https://www.sqlite.org/lang_transaction.html) | Recheck immutable command/verdict under write authority; serialize competing processes | SQLITE_BUSY and I/O failures still require honest pending/retry handling |
| [SQLite savepoints](https://www.sqlite.org/lang_savepoint.html) | Keep the handler's nested payroll savepoints inside one cloud commit; roll back refused business writes before a rejection | Releasing an inner savepoint does not make business writes durable |
| [SQLite session extension](https://www.sqlite.org/sessionintro.html) | Capture the real route/trigger writes as a compatible changeset, then assert replica convergence | A process-local recorder is not itself a durable stream/outbox |
| [SQLite WAL](https://www.sqlite.org/wal.html) | Test actual commit/restart on the same filesystem; retain WAL and observe synchronous setting | No network filesystem or physical-power-loss certification follows |
| [RFC 9110 §9.2.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2) | Lost POST responses need explicit replay semantics; retry the command ID rather than invent another financial operation | A command ID/header alone provides no exactly-once guarantee |

A Node 24 API documentation URL was not retrievable with the research tool. This is
not counted as a successful source read. Installed types, actual runtime behavior and
SQLite's primary session/transaction documentation supply the API evidence here.

## Reproduction methods

Use a disposable checkout with dependencies installed; all fixtures are synthetic.

```sh
npm run typecheck
npm run db:types
npx vitest run tests/payroll-replay.test.ts tests/payroll-post-sync.test.ts tests/sync-payroll.test.ts tests/sync.test.ts
npx tsx scripts/payroll-replay-crash-drill.ts
npx playwright test
```

The process drill launches real `server.ts` children on loopback ports 4391/4392.
External preload hooks terminate them at SQLite effect/verdict statements, internal
HTTP response emission and outer command response emission. No production crash hook
is introduced. A deterministic two-process gate pauses both after reading the same
received command, then releases them in order to test a stale lookup. Assertions
inspect committed journals/effects/verdicts and the office replica after restart.

Set `PAYROLL_REPLAY_SERVER_ROOT` to an unchanged checkout of baseline
`a92de92c173c41280a52ed734bad913f441f68a5` and
`PAYROLL_REPLAY_EXPECT_BASELINE=1` to reproduce the original behavior. Baseline mode
reports actual violations and does not claim an exit-zero drill means correctness.
`PAYROLL_REPLAY_ONLY_CASE=4` runs the already-complete-decision/lost-response control
on fresh data. Archive results before repeating; work directories are disposable.
The baseline controller creates a received inbox/marker before the two-process case;
old server code ignores that marker. The test does not claim this marker existed in
old deployments. The other baseline faults use the old server's ordinary inbox path.

The baseline sequence's broken earlier effects contaminate later replica pulls. Its
already-committed-response control preserves one journal/effect/verdict; run that
control independently before interpreting a later replica failure as another defect.
The retained observations distinguish source persistence from replica convergence.

## Failures retained, rather than hidden

- Two initial SQL-fault assertions fail on unchanged production: source journal survives
  effect or verdict persistence failure. Matching post-fix assertions pass.
- Two real HTTP assertions expose false cloud status for received/unknown commands.
  The corrected endpoint reads actual state and enforces existing ownership checks.
- A changed-method reuse case failed on the first implementation because policy selection
  looked only at the incoming route. The fix also follows stored commands/markers;
  changed methods/paths cannot escape the payroll binding policy.
- The first process harness supplied a tenant string to a connection-taking helper. No
  command was sent, so this was not crash coverage. The corrected script asserts its
  enrolled connection and is checked with the full project type context plus the script.
- The outer-response kill hook initially tested a router-relative URL as if it were an
  original URL. Four earlier cases completed; the missing termination failed the run.
  The hook now uses the actual original URL, and the whole drill is rerun.
- A later repeat reached five passing cases, then one of two simultaneously booted
  servers exited on a schema/seed `database is locked` error. The raw startup failure
  is retained. The final request-concurrency experiment waits for each server to finish
  starting before releasing both command requests through the same barrier. Concurrent
  cold-start availability is a separate observed open boundary, not a repaired or tested
  guarantee of this payroll transaction change.
- The first narrow script-only typecheck omitted the project's other type context and
  exposed an unrelated existing QuickBooks inference error, alongside a script closure
  nullability error. The closure is corrected; the final script check includes the
  existing project inputs. It does not change QuickBooks code or weaken TypeScript flags.
- An initial schema generator launch was denied its local tsx IPC socket by the sandbox;
  it was rerun with execution access. The generator writes no business schema type change
  because optional sync technical tables are outside its ordinary tenant schema.
- The first complete regression reports 323 passing files/3,503 passing tests and one
  tenant-migration integration test timing out at the shared 20-second limit. Isolated
  runs pass on both baseline and updated branches, close to that limit. Only that test's
  budget is raised to 60 seconds: its two real CLIs, integrity/copy checks and backup
  assertions remain intact. This is a test-runtime correction, not a claimed production
  performance fix. The entire suite is rerun and the failed first run remains evidence.
- An intermediate 325-file/3,510-test green run did not cover delayed-clock retention.
  A subsequent explicit reproduction found that replay's business clock backdated
  technical effect/verdict timestamps, allowing immediate command cleanup. Explicit
  server confirmation timestamps fix this while preserving journal business time.
  The failed before/after observations, intermediate run and final reruns are retained.

Full results, source hashes and raw/normalized artifacts are recorded in the dated
[validation](validation-results.md) and `evidence/payroll-replay-verification.json`.
Authenticated traces, node tokens, private databases and keys are excluded. Independent
review, historical financial repair, broader replay/rebase interruption, real devices,
hosting/storage/restore and complete release authorization remain open.
