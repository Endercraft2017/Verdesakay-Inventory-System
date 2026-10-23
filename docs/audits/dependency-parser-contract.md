# Runtime dependency review and Word conversion evidence — 23 October 2026

This bounded follow-up started from the four runtime package findings recorded on
22 October, on production `212ff016a87849541b1a05b317b7e431a89eef10`.
The final result changes **no dependencies, application source or database schema**.
It adds a real Word-import browser regression and corrects dependency disposition.
The complete production release remains on hold.

## Demonstrated findings and final disposition

| Lead | Evidence / severity | Final resolution |
|---|---|---|
| Mammoth → argparse → sprintf-js | The 22 October npm snapshot reports three moderate package entries. A clean baseline install reproduces a RangeError for `%.101f`. Source review finds only programmatic DOCX conversion/raw-text use, not attacker-controlled CLI format strings. No application HTTP exploit was demonstrated. | **Advisory withdrawn upstream**, verified 23 October. A thrown formatter exception alone is not an app vulnerability. Drop the proposed major parser override; preserve original dependencies and retain the experiment evidence. |
| node-forge 1.4.0 RSA verification | One high finding remains in fresh runtime and full-root audits. No fixed version is offered. The app import is confined to desktop/lan-tls.ts, which parses controlled keys/certificates and signs certificates. Node performs TLS verification. No app signature-forgery exploit was demonstrated. | Open dependency/release gate. Restricted observed use is a reachability assessment, not an approved risk exception. No private crypto fork or new certificate implementation is justified by this evidence. |

The [upstream withdrawal notice](https://github.com/advisories/GHSA-hp3w-g68c-fv3c)
records withdrawal at 2026-10-22T19:21:04Z (23 October, 03:21 Manila), because
applications must handle exceptions appropriately.
It was still present in our earlier 22 October registry lookup, then absent in the
23 October fresh-cache lookup. Counts are point-in-time package entries, not a count
of independent remotely exploitable application defects.

## Contract, boundaries and expected behavior

1. An advisory is a lead to investigate against the installed source and actual
   caller. A package exception is not proof that a remote user can crash the app.
   A feed withdrawal must not be credited as an engineering fix.
2. The delivered package.json and package-lock.json remain byte-identical to the
   baseline. No node_modules patch, override, advisory suppression or forced downgrade
   is delivered. npm ci must reproduce the original graph.
3. Existing permission and size gates precede untrusted DOCX conversion; converted
   HTML uses the existing sanitizer. A malformed conversion must preserve the draft
   and permit a valid retry. Preview must not replace content or publish the saved
   template. Apply changes the local draft and remains undoable; publication is explicit.
4. Chat attachment previews remain participant-scoped text. Existing regression tests
   cover conversion, malformed/oversized input, authorization and exception redaction.
   No new hostile-archive, resource-containment or complete parser-safety guarantee
   follows from these tests.
5. Tenant, payroll, session, email-release and offline authority remain unchanged.
   The earlier payslip-email contract and all broader production gates remain in force.

## Primary-source research and the abandoned candidate

Research on 22 October used the [formatter advisory](https://github.com/advisories/GHSA-hp3w-g68c-fv3c),
[Forge advisory](https://github.com/advisories/GHSA-86w9-cpqp-85rv),
[Mammoth CLI/API/security documentation](https://github.com/mwilliamson/mammoth.js#usage),
[actual CLI](https://github.com/mwilliamson/mammoth.js/blob/master/bin/mammoth),
[argparse 2.0.1 source](https://raw.githubusercontent.com/nodeca/argparse/2.0.1/argparse.js),
[package metadata](https://raw.githubusercontent.com/nodeca/argparse/2.0.1/package.json),
[substitution helper](https://raw.githubusercontent.com/nodeca/argparse/2.0.1/lib/sub.js),
[changelog](https://github.com/nodeca/argparse/blob/master/CHANGELOG.md) and
[npm override documentation](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#overrides).
Two guessed upstream migration-document URLs returned 404 and were not relied on.

A candidate pinned Mammoth 1.13.0 and overrode only its parser to argparse 2.0.1,
which retains the v1 calls used by Mammoth and omits the formatter. Source review
and real CLI/API tests established compatibility for the exercised cases. npm initially
rejected mismatched parent specs, then reported success while retaining an invalid
old nested parser. Invalidating only the two stale lock entries and letting npm resolve
them produced a clean, reproducible candidate graph. No other locked version changed.

Both clean baseline/candidate production-only installs performed real HTML/raw-text/CLI
conversion. The candidate passed 96 focused tests, 72 Playwright scenarios, 94 editor
scans/15 workflows and a complete 322-file/3477-test Vitest run. These are retained as
**candidate evidence**, not final-tree test totals. Fixture corrections (Markdown
emphasis, usage stream/wording, and ambient development-module resolution) and a
sandbox-denied process run are retained separately from product findings.

On 23 October the final full-root audit returned only the Forge finding. Explicit
`--include=dev` and a fresh npm cache gave the same result. Checking the primary advisory
confirmed withdrawal, explaining the missing eight propagated build-tool entries.
Their disappearance was a feed change, not a repair of those packages. The major parser
override was therefore removed rather than shipped without its original justification.
Original manifests and installed graph were restored; the candidate test requiring
dependency removal was discarded. Its source, lock delta, hashes and results remain evidence.

## Verification, accessibility and limits

Final restored-graph verification passed: 321 Vitest files/3467 tests (642.90 seconds),
4 focused files/86 tests, all 72 Playwright scenarios and TypeScript, each with retained
exit status 0. The final evidence manifest and validation-results.md distinguish these
results from the abandoned candidate. The local suite uses Node 24.19.0; Node 22 CI
and Windows/native acceptance are not established by this run. The first candidate full run was interrupted
by an environment restart before totals; no pass is claimed for it. The completed
candidate run has its full totals, but its execution-session handle was unavailable
when revisited, so no independently retained process exit code is claimed.

The editor gate's candidate run found no automated violations, retaining contrast
incompletes in 90 scans/512 nodes and label-name incompletes in 55 scans/358 nodes.
Samples concern gradient Save buttons, custom-select backgrounds and symbolic B/I/U
buttons. Eight actual-app viewport/theme screenshots were reviewed: Save/Close stayed
within the viewport; narrow layouts wrapped controls. No UI bytes changed. This visual
review does not resolve all contrast/speech-input/assistive-technology questions or
establish WCAG conformance. Authenticated trace ZIPs and temporary databases are excluded.

Final npm reports still exit 1 for node-forge. Independent code/security review and
any explicit expiring risk decision remain outstanding; none is silently approved.
Launcher/mobile were not rescanned here. Live provider/hosting/restore, mixed-build/native
acceptance, historical-secret revocation, legal/accountant approval and wider scorecard
requirements remain open. The historical 233-control totals are unchanged.
