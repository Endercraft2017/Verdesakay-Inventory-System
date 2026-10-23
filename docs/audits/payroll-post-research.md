# Payroll posting retry research and independent reproduction

Primary sources checked 23 October 2026. Existing audit documents supplied leads;
source, SQL faults, real HTTP traffic, journal rows and actual process exits supply
the demonstrated findings. No external production target was scanned.

| Primary source | Requirement or decision informed | Limit |
|---|---|---|
| [RFC 9110 §9.2.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2) | A lost POST response alone cannot justify an unprotected repeat. The updated browser retains an attempt key; the server supports its repeat semantics. | The header alone supplies no guarantee. Different/keyless attempts remain separate operations. |
| [SQLite transaction control](https://www.sqlite.org/lang_transaction.html) | Acquire write authority and recheck the receipt inside the transaction; test two processes that both saw a cache miss. | One writer can encounter SQLITE_BUSY; a failure is not permission to invent a new attempt. |
| [SQLite savepoints](https://www.sqlite.org/lang_savepoint.html) | An inner posting/receipt savepoint joins the originating-node source/command transaction. Only the outer release commits it. | An inner RELEASE is not an independent durable commit. Replay/rebase paths retain their existing orchestration. |
| [SQLite atomic commit](https://www.sqlite.org/atomiccommit.html) | Journal, receipt and command must share the relevant transaction. Test interruption around persistence, not just thrown exceptions. | Storage/flush/locking assumptions matter; SIGKILL is not power loss. |
| [SQLite WAL](https://www.sqlite.org/wal.html) | Preserve WAL state during real restart tests; inspect WAL/FULL, use the same local filesystem for competing processes. | This is not a network-filesystem or physical disk certification. The documented WAL-reset fix is in 3.51.3 and later; this test runtime reports SQLite 3.53.3. Installed/hosted runtime versions still need verification. |
| [OWASP Transaction Authorization §§1.1, 2.1, 2.5, 2.6, 2.8](https://cheatsheetseries.owasp.org/cheatsheets/Transaction_Authorization_Cheat_Sheet.html) | Review significant data, enforce current server authorization, test stale context and allowed state transitions. | A repeat receipt is historical acknowledgement, not one-use authorization of the current source. Source-version approval and offline factor/origin binding remain open. |

The application-specific requirements and limits are in the
[contract](payroll-post-retry-contract.md); operator recovery is in the
[runbook](../operations/payroll-post-retries.md). Standards do not select the
organization's recognition, reversal, settlement or retention policy.

## Reproduce without trusting the reported conclusion

Use a disposable checkout and supported Node runtime with dependencies installed.
The tests create synthetic isolated databases and loopback servers, not real payroll.

```sh
npm run typecheck
npx vitest run tests/payroll-post-retries.test.ts tests/payroll-post-sync.test.ts tests/payroll-reconciliation.test.ts tests/idempotency.test.ts tests/sync-payroll.test.ts tests/sync-route-classes.test.ts
npx playwright test tests/e2e/payroll-post-retries.spec.ts
npx tsx scripts/payroll-post-crash-drill.ts
```

Archive `work/payroll-post-crash/` before repeating a drill: results and gate files
are disposable. The script launches and kills real `server.ts` processes on ports
4381/4382, using test-only external preload hooks; production source contains no
crash hook. Assertions inspect journal rows and durable command existence, including
after a fresh process opens the database. It records five cases. Passing means
`contract_satisfied: true` in every case, not merely an exit-zero console line.

For a comparison, point `PAYROLL_POST_SERVER_ROOT` at a disposable unchanged checkout
of `0de7c12021c16b17499a03d6535c4269d299a4aa` with the same dependencies, and set
`PAYROLL_POST_EXPECT_BASELINE=1` when invoking the current drill script. Its baseline
mode deliberately expects the old violations. Four false correctness flags reproduce
defects; the already-committed receipt case passes on both graphs. The retained
baseline Vitest drivers/config are text artifacts under `evidence/payroll-post-baseline-*`;
the unchanged baseline failed all three required correctness assertions. Application
and test input hashes are retained in `evidence/payroll-post-source-freeze.json`.

Independent reviewers should compare observable source/journal/receipt/command state,
not only HTTP status or live journal count. A reversal/replacement sequence still
has one live entry; total rows and original entry identity expose unintended repeats.
Normal cloud replay is tested separately from originating-node crash atomicity.

## Failed experiments and uncertainty

- The first production-mode crash harness refused to boot without `TZ=Asia/Manila`.
  The harness was corrected; the startup guard was kept. This is not a product bypass.
- The first new TypeScript run found test-only possibly undefined header arguments.
  The tests now assert/return a command ID before SQL binding; the failed log is retained.
- Browser testing found the incorrect `App.user` guard. The actual accessor fixes
  account-context invalidation. Separate wrong toast/navigation assumptions were
  corrected in tests, not counted as application defects.
- A contrast scan during a theme switch observed old button backgrounds with newly
  switched text. The final scans await actual transition completion without disabling
  axe rules. All eight scans have no violations but retain **incomplete color-contrast
  checks**; gradient/visual contrast and assistive-technology review remain manual.
- The baseline two-process barrier forces both receipt misses before either write;
  releases are then ordered to expose the check-before-write race deterministically.
  This is not arbitrary load or independent availability/performance certification.
- Secrets scans cover delivered staged files/evidence and the commit hook; they do
  not close historical-secret findings. Authenticated traces, private databases and
  private keys are excluded from published evidence.
- The first evidence scan flagged 36 source-checksum map entries as generic keys.
  Every flagged value was verified against the actual file's SHA-256. The retained
  manifest now separates `path` and `sha256` fields; raw/retained hashes record the
  representation change. Staged and exported-directory scans then passed without
  scanner exceptions. The initial result and per-finding verification are retained.

Cloud authority dispatch, effect-stream flush and verdict persistence remain separate
writes. Their interruption/rebase recovery is not established by these tests. A
reviewed-source approval design and real runtime/restore/device acceptance are still
required before describing the complete payroll workflow as production-ready.
