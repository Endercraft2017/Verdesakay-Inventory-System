# Concurrent SQLite initialization contract

24 October 2026. Increment baseline: `production` at
`0c2ed900239ce50db297ebd957d9f34b6ec0b0cc`, matched to the live remote before edits.
Scope: cold tenant/control-plane initialization by updated processes using the same configured
local file paths. The [verification manifest](evidence/sqlite-startup-verification.json) binds
results, input hashes and retained artifacts; [operations](../operations/sqlite-startup.md)
describes recovery. This is not complete application release approval.

## Demonstrated gaps and requirements

| Priority | Original failure | Correctness requirement / resolution |
|---|---|---|
| High availability | A second cold initializer exits with SQLite error 5 during the real studio-trigger rebuild under a controlled short writer. | Acquire bounded initialization ownership before schema/migration/seed work. |
| Medium–high availability | Two first-run processes both read zero users; one later exits with extended error 2067, `users.username`. | Serialize the read-before-insert seed decision with the complete initialization sequence. Statement-level busy waiting alone cannot do this. |

These are synthetic local failures, not customer incident reports. Original reproductions did
not demonstrate duplicate administrators or lost payroll. The diagnostic barriers are in
independent test drivers, never in application startup. The DDL driver holds a transaction around
one real startup batch; the seed driver pauses after the real empty-user read and before insert.
Both collisions were reproduced before runtime changes.

## States, boundaries and rules

1. **Unopened:** validate the tenant/path and check the existing connection cache.
2. **Waiting:** obtain `BEGIN IMMEDIATE` ownership on a separate adjacent technical SQLite file,
   with a ten-second busy budget. Private `:memory:` connections skip filesystem coordination.
3. **Initializing:** hold that ownership over the existing backup/schema/migration/history/seed
   sequence. Keep business migration transactions, foreign-key toggles and `VACUUM INTO` valid;
   there is no new outer business transaction or awaited network operation.
4. **Ready:** finish initialization, restore the previous business `busy_timeout=0`, release
   ownership and return. Cached ordinary requests bypass acquisition.
5. **Failed:** propagate the error, close/evict failed initialization and release the gate;
   a later cold attempt can retry. Do not advertise readiness after initialization throws.
6. **Interrupted:** SQLite/OS releases the dead process's file lock. Keep the technical path in
   place; never unlink/rename a live gate to bypass it. Re-run the existing initializer on retry.

The trusted boundary is the validated server-configured path plus local OS/SQLite locking.
Cooperating processes must resolve to the same gate path. Different symlink/hard-link aliases,
old builds, arbitrary raw writers and a party with filesystem write control can bypass this
application protocol. Explicit maintenance/lifecycle operations remain under their existing
stop/backup/restore procedures. General runtime writes are not coordinated by this gate.

The ten seconds applies to acquisition and each initializing SQLite busy operation, not total
startup. SQLite calls are synchronous: a lazy tenant open during HTTP use can block the process
event loop, including other requests/health probes. No request-latency/capacity SLA is certified.
Arbitrary historical migration interruption, physical power loss and mixed-version/shared-storage
operation remain separate acceptance boundaries.

## Delivered application change and evidence chain

`src/shared/sqlite-initialization.ts` owns the technical gate. Tenant/catalog initializers hold
it over their existing sequence and use temporary business-connection busy waiting. Returned
connections retain the original zero-wait policy. Failed catalog setup now closes/evicts its
incomplete cached handle. No package, business schema/version or offline payroll authority changed.

| Requirement | Original → corrected observation | Retained evidence / limit |
|---|---|---|
| Wait before competing initialization DDL | Second process exits 1/error 5 → both exit 0; the saved synthetic paid payslip/revision and sentinel setting identical, integrity `ok`, foreign-key check empty, no open transaction, runtime timeout zero. | [Before](evidence/sqlite-startup-before.json), [after](evidence/sqlite-startup-after.json), identical driver SHA-256. Controlled local writer only. |
| Serialize empty-user seed decisions | Both read empty and one exits 1/error 2067 → only holder reads empty, both exit 0, exactly one administrator. | [Before](evidence/sqlite-startup-seed-before.json), [after](evidence/sqlite-startup-seed-after.json), identical driver SHA-256. No original duplicate-user/data-loss claim. |
| Close/evict incomplete catalog setup | Original retry returns zero operators after refused seed → updated retry seeds one. | [Old-source fault check](evidence/sqlite-startup-baseline-catalog-failure.json). This additional check was retrospective after the candidate, not a pre-edit reproduction. |
| Real servers become ready | Each of three baseline pairs loses one process to a database lock → all six final processes pass HTTP health checks, one administrator/operator each, integrity `ok`. | [Baseline](evidence/sqlite-startup-server-baseline.json), [final](evidence/sqlite-startup-server-final.json), actual unmodified `server.ts` and logs. Local schedules, not capacity certification. |
| Preserve schema/private-memory behavior | Final server schema equals baseline at 413 tenant / 33 catalog objects; technical gate has zero objects/bytes. Private memory creates no gate file. | [Exact schema query/result](evidence/sqlite-startup-schema-final.json), [driver](evidence/sqlite-startup-schema-driver.py.txt), [memory result](evidence/sqlite-startup-memory-fixed.json). |

Eight permanent startup tests cover the two races, SIGKILL ownership release, the saved fixture data,
independent paths, persistent ten-second refusal/retry, catalog failure recovery and private
memory. The real-wait test retains its explicit 35-second harness budget. The two original-race
tests fail on the pinned old app source with both the original and enlarged harness budgets,
on their intended state assertions: [original detector](evidence/sqlite-startup-baseline-permanent-tests.txt)
and [enlarged-budget detector](evidence/sqlite-startup-baseline-budget-tests.txt). Deliberately
deselected cases in those small baseline experiments remain enabled in the complete suite.

## Validation corrections, separately from application improvements

Final canonical `npm test`: **326 files / 3,519 tests passed**, exit 0, 1,910.00 seconds
Vitest / 1,910.66 seconds wrapper. All 872 selected frozen input hashes remain unchanged.
The retained Playwright run passes 78 cases with no skips, unexpected results or flakes;
its runtime/e2e inputs are byte-identical after the validation-only changes.

The original twenty-second Vitest execution budget interrupted different real integration
sequences: restore, signup replays, QA setup and MFA enrollment. Isolated unchanged baseline and
candidate checks pass the original budgets. Removing concurrent audit work did not eliminate
an MFA timeout. No timing root cause or production performance fix is established.

The default test/hook harness budgets are explicitly relaxed from 20 to 60 seconds. This is an
engineering choice for execution of real-KDF integration flows, not an industry-mandated value
or acceptable product response time. Application deadlines, password cost, existing explicit
`it` budgets and business elapsed-time assertions stay intact. Authenticated requests of
11.785/15.545 seconds were observed on this test host; their cause and production relevance
remain unresolved release evidence.

A subsequent complete run exposed premature accesses after fixed 40–120 ms mobile test sleeps.
Controlled 250 ms delays of real storage promise acknowledgements reproduce the failures without
changing the app, persisted values, keys or expected results. Local state waits alone exposed
further fixture races. The final shared fixture waits for its supplied cached actor, tracks
only draft-storage promises, polls their quiescence for at most five seconds, and closes each
window after the case. Values/errors are forwarded to the app; the poll never consumes a
rejection or waits on network requests. Bounded state waits remain at demonstrated transitions.

Nine selected delayed-storage cases pass, including two intentionally stuck-network controls.
An unhandled-storage negative control still yields **one error / exit 1 while its normal test
assertions pass**. The full mobile file passes all 130 cases. A typed object-URL mock supplies
one missing JSDOM primitive; a local Chromium probe confirms native API availability and Blob
round-trip behavior. No production mobile file, role rule or global promise/error handler changed.

A TypeScript parser/printer compares all **625 original matcher/helper expressions in order**:
[comparison](evidence/sqlite-startup-frontend-assertion-integrity.json). Their expressions and
expected values are identical. Temporal fixture semantics did change, as disclosed above;
expression identity alone does not prove semantic equivalence. Of 363 existing test/config files,
361 remain byte-identical; the changed files are the mobile fixture and Vitest budgets:
[comparison](evidence/sqlite-startup-test-integrity-final.json). No test registration/skip was removed.

## Failed/intermediate experiments and provenance

- First two new-driver typechecks failed and were corrected without compiler-flag changes.
- The first runtime candidate incorrectly created `:memory:.startup-lock`. Baseline/candidate/final
  probes distinguish that patch-introduced regression; the memory guard/eighth test correct it.
- The first full run passed 3,517 tests and failed an unchanged restore test at 20 s. Isolated
  baseline/candidate restore checks pass in 9.96/8.48 wrapper seconds. The failure is retained.
- A parallel attempt hit signup's 20 s limit and was stopped incomplete (143). Standard serial
  verification passed 3,512 tests but skipped seven QA cases after a 20 s setup failure. Baseline
  and candidate QA/signup repetitions both pass their original budgets. Another attempt hit
  MFA's budget at 22.449 s and was stopped incomplete. None is relabeled a completed green run.
- A heartbeat during protected Git staging found no scheduling gap above 200 ms over 22 seconds;
  that limited experiment did not support a tooling-pause explanation.
- With the 60 s budget, a complete run passed 3,517 tests and failed two mobile null-field accesses.
  Subsequent focused attempts exposed four release renders, then one RTS render, before the
  shared fixture correction. Their assertion failures and immutable delayed inputs are retained.
- The first shared-fixture candidate duplicated two constants: zero tests ran. Its initial
  rejection control was therefore invalid, not evidence of successful rejection detection.
  The corrected control produces the expected unhandled error. An initial assertion-comparator
  Git child call failed `EPERM`; only the later pure parser from a saved Git blob establishes
  expression preservation. That first tool failure is available in the session transcript.
- The failed run's metadata described isolation as an intention; bounded diagnostics ran after
  its first failure. Do not interpret that entire failed interval as isolated. Final verification
  uses the canonical serial command without further experiments or Git operations.
- An early 822-file extension-filtered freeze omitted 50 unchanged inputs; its supplemental
  comparison remains. Final verification freezes all 872 selected code/assets/test/script/config
  inputs. [Delta](evidence/sqlite-startup-freeze-delta.json) permits reuse of earlier browser/server/
  schema/Node 22 results because only test timing/fixture files differ; runtime/e 2 e/package inputs
  are identical. Source snapshots distinguish the earlier variants.

The manifest records commands/exits and raw versus retained hashes. Text exports remove ANSI,
trailing whitespace/extra EOF blank lines. Inert diagnostic patches retain exact whitespace in
JSON line arrays for reconstruction. Private databases, credentials/keys, authenticated browser
traces and downloaded binaries are excluded. Script wrapper exits are distinguished from nested
Vitest results, including intentionally failing controls.

## Independent repetition

Use disposable baseline/current checkouts and the same locked dependency graph with a tested
patched Node runtime. Copy the new startup test/worker into the pinned baseline without changing
its application source. Select the two original-race tests: both must fail on their state
assertions; the current eight-case startup file must pass. If copying the enlarged harness
configuration too, identify that separately from baseline application code, as the retained
budget-detector metadata does. The existing safety setup assigns throwaway database paths.

The retained diagnostic generators recreate the controlled storage delays against baseline
mobile code. Their recorded nested Vitest exits, selected/deselected counts and immutable input
hashes are the evidence; a successful Python wrapper alone is not a passing control. Diagnostic
trace locations can differ between machines. JSON patch arrays reconstruct the exact retained
UTF-8 diff; their raw hash must match before use. The rejection control must remain exit 1 with
one normal test passing and one unhandled error. A reviewer should assess the transitions and
database observations independently, then obtain representative hosted/Windows/restore evidence
before accepting deployment claims.

## Primary sources and open findings

[SQLite busy timeout](https://www.sqlite.org/c3ref/busy_timeout.html),
[transactions](https://www.sqlite.org/lang_transaction.html),
[locking](https://www.sqlite.org/lockingv3.html) and
[Node 22 SQLite](https://nodejs.org/docs/latest-v22.x/api/sqlite.html) support the lock/wait design.
Direct TLS-verified captures were used after the web connector returned an empty error; an
optional HTML parser was absent, so standard-library extraction was used. The implementation
uses the established PRAGMA instead of the constructor timeout option added in Node 22.16.
Official Vitest [test](https://vitest.dev/config/testtimeout.html)/
[hook](https://vitest.dev/config/hooktimeout.html) budgets and
[waitFor](https://vitest.dev/api/vi.html#vi-waitfor) define harness behavior. Installed JSDOM's
README recommends window closure to terminate timers; this supports fixture cleanup only.

The baseline advertises Node `>=22.13` while existing payroll/sync guards use `isTransaction`,
added in 22.16. The [official 22.13 probe](evidence/sqlite-startup-runtime-api-probe.json) observes
it as undefined/false during a real open transaction; 22.22/24.19 report true. The startup gate
callback works on all three. [Unchanged source leads](evidence/sqlite-startup-runtime-api-source-leads.json)
bind this mismatch to pre-existing code. End-to-end financial impact is not reproduced. Aligning
supported patched runtimes, declarations and CI, then testing affected guards, remains high-priority
engineering work. Full-app 22.13 compatibility is not claimed.

The [fresh runtime advisory snapshot](runtime-advisories-2026-10-24.md) reports four high and one
moderate package findings, seven active primary records. No package remediation/exception is
included. Earlier advisory withdrawals/count reductions are separate historical observations.

The gate is **implemented**. The reproduced state transitions, data/schema checks, process
recovery and validation controls are **locally demonstrated**. No independent review is claimed.
Actual hosting/storage/Windows, long migrations, physical power loss, arbitrary historical
migration crashes, aliases/mixed builds, real-backup restore, production latency/capacity and
independent security/operations review remain **unverified**. The broader release hold and
historical 233-control totals stay open; there is no new owner engineering task for this increment.
