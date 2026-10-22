# Home pending-work preview: focused audit

2026-10-22. Branch: `restructure/module-architecture`. Candidate cache v141.
Scope: Home preview, its existing Work detail links and destination guards. No
new workflows, backend policy changes, commit, push or deployment.

## Evidence, rather than the previous completion claim

The fixture creates actual jobs, units, inspection results, requested repair parts,
QA holds, an RTS product-data mismatch hold and a partially received batch. A
read-only `node:sqlite` connection independently reads the disposable database.
Expected record IDs and quantities are compared with real authenticated API
responses and visible Home records. Test users have individual custom grants;
completion races use different employee accounts, not just two tabs for one user.

The initial four focused assertions failed against the previous preview. Their
report is retained at ignored `work/home-preview-audit/baseline-report.json`, and
the prior Home/Work source is archived in that directory's `baseline/` folder.
Harness readiness errors were corrected before that baseline was recorded. A
separate deterministic reproduction with the original receiving code also failed;
`late-rts-baseline.json` and `baseline/receiving.js` preserve that evidence.

## Findings and fixes

| Finding | Demonstrated behavior before fix | Result after fix |
| --- | --- | --- |
| Ambiguous batch counts | One eligible serial and a batch with seven pieces remaining displayed `2 pending`. | `1 unit · 1 batch (7 pcs)`. Batch identity and remaining pieces are visible; detail also states remaining quantity. Jobs and requests have explicit count nouns. |
| Blocked inspection not identified | Rework with an unresolved part request looked like ordinary pending inspection. | The count includes `1 blocked`; the card puts “Waiting for parts” before truncatable product detail. Work detail explains the blocker. The existing inspection screen and API still refuse the inspection. |
| One slow desk hid every desk | Home awaited all desk reads before displaying any result. | Each desk resolves separately. A held QC response does not hide a completed RTS read. Reads time out after 12 seconds and show Unknown; late responses cannot overwrite a newer refresh. |
| Employee-summary failure hid operational work | A failed `/me/today` replaced Home with an error and no work preview. | The work preview starts independently. Attendance and employee updates show unavailable states, without inventing missing HR linkage. The preview is preserved when the employee summary finishes. |
| Late RTS callback could replace Home | A delayed failing unit read cleared the reused view after navigation back to Home. | The existing RTS unit loader checks route, owner and render instance before painting either success or error. |

Additional corrections within the same feature: a malformed successful queue
response is Unknown instead of an apparent zero; Refresh also checks updated
access; kit labels describe kit acceptance/preparation rather than sales handoff;
part previews identify the requested component/quantity. RTS mismatch holds remain
excluded from the ready count and have a separate link to the existing issues
queue. No-ready wording explicitly distinguishes eligible receipt work from holds.

## Verified expectations

- **Kit release:** only `production.kit_release` with Manufacturing enabled;
  approved draft manufacturing jobs, excluding legacy intakes. The existing kit
  workflow retains acceptance, preparation and release validation.
- **Parts release:** only `production.repairs` in this preview; requested repair
  parts, regardless of whether the part can immediately be issued. Home promises
  review, not automatic issue or stock availability. Actual issue remains guarded
  by request state, stock, source location and revision checks.
- **QC / QA:** each inspection grant selects its own unfinished pass. Units under
  rework remain pending but are labelled blocked while requested parts remain.
  QA may go first. QA holds are separate work for QA inspection/review authority.
- **RTS:** count eligible serialized units separately from unreceived batches and
  remaining batch pieces. Mismatch-held serials are not ready. Completed batch
  receipts disappear; full unit receipt removes the unit. Both required passes,
  holds, duplicate protection and receipt posting remain server-controlled.
- Basic employees make no operational queue reads. Narrow employee grants do not
  expose other Home desks. Module-profile changes and actual permission revocation
  remove the preview through the real Refresh button.

## Fresh Playwright re-verification with captured evidence

A subsequent run started from the current uncommitted sources and new disposable
records, rather than accepting the earlier reports. **14/14 scenarios passed**,
including exact Home → Work detail → existing action destinations for all six
narrow desk grants and a real Playwright browser-offline/reconnect transition.
Every desk's navigation was checked for correct record/role parameters, no browser
write requests, and unchanged stock/workflow snapshots. Existing race, hold,
partial/full receipt, empty, revocation and unavailable-response cases also passed.

The run saved **29 Playwright traces, 29 sanitized network JSON files and 36
screenshots** in `work/home-preview-verification/current/`. `report.json` contains
read-only database snapshots, effective profiles, source SHA-256 hashes, expected
IDs/quantities and per-case artifact names. Queue responses and failures are
captured in both the traces and sanitized logs; authorization headers and login
bodies are not copied into the JSON logs. Trace archives may include disposable
fixture session data; these accounts and their database are deleted at teardown.
The trace ZIP structure was verified, including trace and network entries. Tested
production-source hashes still matched after the run.

Five browser-only mutations deliberately reintroduced ambiguous counts, hidden
blocking, coupled queue loading, lost preview on employee-summary failure, and
late RTS repaint. **All five corresponding regression tests failed as expected**;
normal code passed. This checks that these assertions detect the intended defects,
not just the happy path. No source file on disk is replaced by the mutations.
The matrix, exact failures, mutated asset hashes and trace names are saved in
`work/home-preview-verification/mutations/summary.json`.

Reproduce the fresh checks:

```sh
HOME_AUDIT_OUTPUT=work/home-preview-verification/recheck node scripts/test-mobile-home-audit.mjs
node scripts/test-mobile-home-mutations.mjs
```

Inspect an individual archive with `npx playwright show-trace <trace.zip>`.
No additional product-code defect was found in this re-verification. Changes in
this verification round are test/evidence tooling and documentation only; no commit
or push occurred during verification. The user subsequently requested committing
and pushing the reviewed changes. Service workers are blocked to test the source under review, so this
run does not verify installed-PWA cache/update behavior, OS push delivery, physical
hardware or site-PC synchronization.

## Reproduction and results

Run `node scripts/test-mobile-home-audit.mjs` with Chromium available at
`/usr/bin/chromium`. It starts the existing disposable fixture server, opens only
its temporary SQLite file read-only, creates test records via authenticated APIs,
and tears the server/database down. No operational sandbox records are changed.

Result: **12/12 focused scenarios passed**, with no browser JavaScript errors.

The focused suite has twelve scenarios: database/API/UI agreement; blocked inspection;
slow-queue isolation; employee-summary failure; grant/module/revocation boundaries;
a different QC employee completing a card; a different parts employee completing
an open detail; partial/full batch and unit receipt; late RTS error after leaving its action link; out-of-order refresh and
navigation; malformed/timeout/retry behavior and unchanged stock on reads; and
multiple batches with a correctly totalled remaining quantity.

Additional checks: existing `scripts/test-mobile-attention.mjs` (19 scenarios),
165 focused Vitest tests covering mobile, personal behavior, RTS and independent
QC/QA, plus TypeScript and JavaScript syntax checking.

Local evidence: ignored `work/home-preview-audit/report.json`, independent oracle
IDs/quantities in that report, and `counts-and-blocked.png`. The existing broader
suite writes `work/mobile-attention/report.json` and its screenshots. These are
local evidence, not published links or deployment confirmation.

## Limits

Network delay, HTTP failure, malformed responses and timeouts are controlled in
Playwright. The module-disable test supplies a restricted authenticated profile;
actual backend permission refusals are checked separately. SQLite assertions check
real workflow state and stock, while API calls simulate another employee's actions.
Browser and API tests do not establish physical camera, printer, installed-phone,
site-PC synchronization or operating-system notification behavior. None of those
systems was changed by this audit.

The 12-second deadline bounds UI reads; it does not cancel an already sent HTTP
request. Its late result is ignored. Pending figures are refreshed snapshots, not
stock reservations or a promise that another employee cannot act meanwhile; the
detail and destination workflow must continue to verify current state.
