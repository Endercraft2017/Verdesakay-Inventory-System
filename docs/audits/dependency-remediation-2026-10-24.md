# Dependency remediation — 24 October 2026

Baseline: `production` **06179a8fb022ef54bd45c1b9d88d140c1afdcf63**, confirmed against
the remote before this increment. This is a narrow dependency follow-up, not a new all-app
production-readiness assessment. Existing audit summaries were leads; the installed lockfile,
source, public upstream advisory/patch records, disposable processes and TLS SMTP peer are the
evidence. Only synthetic local traffic is authorized/used.

## Contract established before package changes

HTTP bytes cross the public boundary into Express's decompression/JSON parsing before tenant
authentication. A request can be accepted by the parser, refused by validation/authentication,
or aborted. None of these states authorizes an unhandled stream error to terminate the server.
A valid compressed request must retain its previous authentication response; a malformed request
may be refused. The next health request must succeed after the malformed stream settles.
The disposable app uses `NODE_ENV=test` and a throwaway database; the decompression middleware
is the application's same unconditional middleware. This is not a hosted-production experiment.

Multipart bytes cross a separate parser/storage/filter boundary. A pending filter can outlive
request teardown; resuming it must not crash the process or call the completion callback twice.
The dependency regression exercises that state directly. The application's four explicit filters
call their callback synchronously; other adapters use the default filter. An application exploit
of this advisory is not established by the dependency reproduction.

Untrusted collection members cross schema-validation boundaries. Where our schema supplies an
upper size bound, reject an oversized collection before visiting its members or accumulating
per-member issues. Preserve ordinary valid input and rejection of invalid in-range input. This
does not promise bounded work for unconstrained collections or protection against all memory DoS.

Address strings cross an RFC 5322 interpretation boundary into SMTP envelope recipients. The
initial experiment requires the exact mailbox for four independently specified comment/group/
quoted-angle cases. **The quoted-angle requirement is not met by the patched library**; see the
retained failed experiment below. Our reviewed payslip contract remains stricter: one plain mailbox,
server-owned reviewed recipient, explicit envelope. Complex input must stay refused by existing
reviewed/public-compose validation. SMTP acceptance still does not establish inbox delivery or
exactly-once delivery. These updates do not change payroll source authority, approval/retry states,
offline commands, schema, triggers, or synchronization.

## Demonstrated gaps and proposed resolutions (before remediation)

| Finding | Severity and demonstrated failure | Resolution and limits |
|---|---|---|
| body-parser 1.20.8, GHSA-27r3-jxmh-p828 | High. Actual app answers an unauthenticated compressed POST with 401, then exits 1 on an unhandled Gunzip `Z_DATA_ERROR`. | Resolve Express's compatible 1.20.x dependency to 1.20.9. Keep parser/auth behavior and prove health after the trailing bytes. |
| Zod 4.4.3, GHSA-mrhx-c7xc-m3w5 | High advisory. Actual attendance schema traverses an already oversized 1,000-day input and accumulates over 1,000 issues despite `.max(62)`. No OOM crash experiment claimed. | Update to 4.6.6; retain zero-member-traversal and valid/in-range-invalid controls. The upstream description mentions unconstrained arrays, but its linked patch/tests establish early size gating for constrained collections; do not claim all unbounded collections are fixed. |
| Multer 2.4.0, GHSA-q7qp-rjg7-q26m | High advisory. Disposable dependency reproduction exits 1 with unhandled `Unexpected end of form` after async filter resumes. Current app filters are synchronous/default. | Update to 2.5.0. Treat as package remediation; do not label a public application exploit reproduced. |
| Nodemailer 10.1.1, three active GHSAs | Moderate npm severity. Independent local TLS SMTP peer observes the outside domain for four RFC-valid addresses that name an approved-domain mailbox. Existing public compose/reviewed-payslip validators already refuse those inputs. | Update to 10.1.4; prove exact envelope against the same four cases and regress actual mail workflows. No public validation bypass has been demonstrated. |
| node-forge 1.4.0, GHSA-86w9-cpqp-85rv | High advisory, active; npm offers no fixed version. No application signature-verification exploit reproduced in this increment. | Remains open. Earlier limited reachability analysis is not an approved exception. |

Initial unchanged-package regression: **7 failures / 4 passes**, with process-crash diagnostics
and wrong SMTP recipients. Adding evidence output reproduced the same 7/4 result before package
changes. The first candidate used ranges and selected newer Nodemailer 10.2.1 / Zod 4.6.7; it
passed 10/11, leaving exact quoted-mailbox preservation failing. Those outputs remain retained.
The final candidate deliberately uses the first fixed releases: body-parser **1.20.9**, Multer
**2.5.0**, Zod **4.6.6**, Nodemailer **10.1.4**. Only four package entries and the root dependency
declarations differ in the lockfile; Express stays 4.22.3. No override, major upgrade, application
runtime source, schema, trigger, business permission, offline authority or retry policy changes.

## Strict failure kept open, not reclassified as a pass

The old library sends the quoted-angle input to the outside domain. Both tested patched releases
instead issue `RCPT TO:<"a@outside.example.test "@approved.example.test>`: the correct domain, but
`>` in the local part becomes a space. The upstream patch itself expects that substitution. The
initial exact-mailbox assertion therefore remains **failed**. A corrected capture observation
also matters: the existing peer's convenience `to` list splits at spaces, so it truncates this
quoted address. The peer now additionally retains complete SMTP command lines; no existing
capture behavior or assertions are removed. The standalone
[strict experiment](../../scripts/audits/nodemailer-mailbox-experiment.ts) compares complete RCPT
commands with the original exact mailbox and continues to exit 1 on 10.1.4. It is a research
experiment outside the ordinary Vitest file pattern, **not a passing regression or a resolved
exact-mailbox claim**. Its original and patched wire results and failure logs are retained.

This change in test scope is explicit: the original 11-case exploratory run is not claimed as
11 passing fixes. Its quoted-angle exact-envelope case is moved to the executable open experiment;
the application refusal for that input remains a permanent test. The other six failing
requirements and four already-passing validation controls form ten permanent regressions. A
clean install of the **exact original lockfile** gives **6 failures / 4 passes** on those final
tests; their assertion inputs are frozen unchanged for the fixed graph. No existing test
assertion, timeout, skip, production validation rule or unhandled-error policy is weakened.

RFC 5322 section 3.4 and RFC 5321 section 4.1.2 supply mailbox/path grammar. Python's independent
standard-library header parser identifies all four intended mailboxes with no reported defects,
including the original `>` inside the quoted local part. This supports the residual concern;
upstream's domain-only test is not proof of exact preservation. The app's `singleMailbox` and
`sendMailSchema` already refuse all four complex inputs before this update and still do afterward.
No public compose or reviewed-payslip bypass has been established, and this increment does not
expand supported address syntax. Other internal callers must not assume arbitrary RFC syntax
is preserved by Nodemailer. Existing real/legacy address data were not exhaustively inspected;
the refusal evidence applies to the tested application validators, not every possible caller.

## Reproductions and interpretation

| Requirement | Original graph | Fixed graph evidence | Remaining limit |
|---|---|---|---|
| Public compressed-body liveness | Actual app exits 1 after 401; unhandled Gunzip `Z_DATA_ERROR`. | Same child driver survives, preserves 401 for ordinary gzip, receives a bounded refusal for the adversarial body, then health is 200. | One bounded gzip/trailing-data shape; not a general DoS or capacity assessment. |
| Upper-bound validation work | 1,000 member visits, 1,002 issues on the real attendance schema. | Zero visits, one collection-bound issue; valid and invalid in-range controls retain their behavior. | No OOM is deliberately induced. Request/body/schema limits elsewhere still matter. |
| Async-filter teardown liveness | Dependency child exits 1 on unhandled Busboy `Unexpected end of form`. | One completion, no saved files, normal process exit with identical final driver. | Not an app-route reproduction: all four explicit app filters are synchronous; default filters cover the other adapters. |
| Three comment/group SMTP destinations | Independent TLS peer sees outside-domain RCPT for all three. | Complete RCPT commands and captured messages name the intended exact plain mailbox for all three. | Local SMTP acceptance, not external delivery or a public input-validation bypass. |
| Quoted-angle exact destination | Wrong-domain RCPT. | **Still fails exactness**; intended domain restored, local part substituted. | Open upstream formatting limitation; rejected by the app's tested public/reviewed validators. |

The source-reviewed upload adapters are in `src/core/`, `src/modules/inventory/`,
`src/modules/hr/`, and `src/platform/`; the explicit filters are attachments, bug reports,
inventory images and punch photos. Relevant mail code is `shared/mailer.ts`,
`shared/reviewed-smtp.ts`, `platform/platform-mail.ts`; ordinary public compose schema is in
`shared/validation.ts`. Existing reviewed-email tests exercise server-owned recipient/content,
explicit envelope, concurrent confirmations/claims, revocation, SMTP rejection/unknown results
and durable event rows against the actual upgraded transport.

Retained evidence (all traffic/data synthetic; none is an independent app audit):

| Evidence | What it establishes |
|---|---|
| [Installed graph](evidence/runtime-deps-installed-graph.json), [exact lockfile delta](evidence/runtime-deps-lockfile-diff.json), [clean-install commands/exits](evidence/runtime-deps-clean-install-commands.json) | Original baseline and four final version changes; both exact graphs installed successfully. Install lifecycle/native binaries are outside this check. |
| [Original 11-case source](evidence/runtime-deps-original-exploratory-tests.txt), [pre-update input hashes](evidence/runtime-deps-original-input-hashes.json), [original 7/4 result](evidence/runtime-deps-captured-exploratory-tests.json), [superseded candidate](evidence/runtime-deps-superseded-candidate-tests.json) | The stronger original quoted-angle assertion failed and is not erased by the green permanent gate. Original source restored and verified against its pre-update SHA-256. |
| [Final tests on original graph](evidence/runtime-deps-exact-baseline-tests.json), [original fatal HTTP process](evidence/runtime-deps-before-http.json), [fixed surviving HTTP process](evidence/runtime-deps-after-http.json) | The permanent gate detects the actual public app crash before and observes health afterward. HTTP status observations and generated payload recipe, not a packet-capture claim. |
| [Original validator measurements](evidence/runtime-deps-before-zod.json), [fixed measurements](evidence/runtime-deps-after-zod.json) | 1,000→0 member visits, 1,002→1 issues. |
| [Original multipart process](evidence/runtime-deps-before-multer.json), [fixed multipart process](evidence/runtime-deps-after-multer.json) | Dependency teardown crash→one clean completion; not a reproduced app route. |
| [Original nested-comment SMTP](evidence/runtime-deps-before-smtp-nested-comment.json), [fixed nested-comment SMTP](evidence/runtime-deps-after-smtp-nested-comment.json), [fixed group-comment](evidence/runtime-deps-after-smtp-group-comment.json), [fixed quoted-group](evidence/runtime-deps-after-smtp-quoted-group.json) | Actual local TLS SMTP envelope and message captures for three preserved plain mailboxes. |
| [Original strict quoted wire](evidence/runtime-deps-quoted-original-quoted-mailbox-experiment.json), [patched strict quoted wire](evidence/runtime-deps-quoted-fixed-quoted-mailbox-experiment.json), [patched failure log](evidence/runtime-deps-quoted-fixed.log.gz), [independent parser](evidence/runtime-deps-independent-mailbox-parser.json) | Wrong-domain behavior improves, exact local-part preservation still fails; complete command lines avoid the convenience capture's whitespace truncation. |
| [Focused 121 tests](evidence/runtime-deps-focused-tests.json), [Node 22 ten tests](evidence/runtime-deps-node22-tests.json), [assertion integrity](evidence/runtime-deps-assertion-integrity.json) | Local functional/adversarial coverage and unchanged existing `.test.ts` files/final permanent drivers. |
| [Runtime before](evidence/runtime-deps-npm-runtime-before.json), [runtime after](evidence/runtime-deps-npm-runtime-after.json), [root before](evidence/runtime-deps-npm-root-before.json), [root after](evidence/runtime-deps-npm-root-after.json), [primary records](evidence/runtime-deps-primary-summary.json) | Version-based advisory counts, active records and remaining nonzero gates. Not a reachability/host exploit verdict. |

Full regression: [raw JSON](evidence/runtime-deps-full-tests.json),
[process/input-integrity receipt](evidence/runtime-deps-full-run.json),
[original complete console log, gzip](evidence/runtime-deps-full-tests.log.gz).
Browser evidence: [complete Playwright JSON](evidence/runtime-deps-playwright.json),
[process/input-integrity receipt](evidence/runtime-deps-playwright-run.json),
[actual browser-driven SMTP messages](evidence/runtime-deps-browser-smtp-wire.json),
[email review/content accessibility observations](evidence/runtime-deps-browser-email-axe.json).
Final [verification receipt](evidence/runtime-deps-verification.json),
[artifact SHA-256 manifest](evidence/runtime-deps-artifact-hashes.json),
[secret scans](evidence/runtime-deps-secret-scans.json).

## Experiments not counted as final verification

- First candidate 10.2.1/4.6.7: superseded, 10/11 exploratory cases pass; strict quoted mailbox fails.
- A temporary `npm install --no-save --package-lock=false` comparison changed unrelated installed
  packages. Its 6/4 result is retained but is **not** the exact-baseline comparison. Both sides
  were subsequently installed with `npm ci --ignore-scripts --no-audit` from the respective exact
  lockfiles. The final tracked candidate manifests were restored afterward.
- A local attempt to read the permanent JSON report before its process finished produced
  `FileNotFoundError`; it is not a test result. A default-sandbox Node/git child diagnostic also
  reported EPERM; subsequent normal Git and escalated clean-install verification supersede it.
- The strict quoted-mailbox experiment intentionally remains exit 1 on both old and patched
  graphs; never summarize all exploratory assertions as green.
- Initial staged and decompressed-export Gitleaks checks each exit 1 with 36 flags, all in
  the source-freeze hash map. Every flagged value is verified as the actual SHA-256 of its named
  file; no credentials are found. A digest-first `sha256`/`path` record representation preserves
  every value and can reconstruct the exact original bytes. The unchanged default scanner then
  exits 0 with zero findings on both gates. [Initial redacted findings](evidence/runtime-deps-initial-secret-scan-findings.json)
  and [classification/round-trip proof](evidence/runtime-deps-secret-scan-classification.json)
  remain retained. No allowlist, scanner suppression or test assertion change is used.
- Git's whitespace gate flags blank context lines in the imported raw upstream patch files.
  All six patches are consequently retained as JSON line arrays with original byte length and
  raw SHA-256; concatenating `lines` reconstructs each original patch exactly. The content is
  not trimmed or rewritten, and the normal whitespace gate remains enabled.

## Validation, evidence and remaining release hold

Focused functional/adversarial validation: **121 tests pass in 8 files**. The ten permanent
regressions also pass using the checksum-verified Node **22.22.0** binary; the default runtime
is **24.19.0**. TypeScript passes. Full serial `npm test` passes **327 files / 3,529 tests**,
zero failed/pending tests, **1,933.64 seconds** reported by Vitest (**1,934.388 seconds** wrapper).
All **879 selected source/test/config/package inputs remain unchanged**. No full-suite retry,
test-budget change or assertion relaxation is used in this increment. Playwright passes
**78 cases**, zero unexpected/flaky/skipped, **294.812 seconds** wrapper, with the same 879
inputs unchanged. All seven payslip email browser scenarios pass: review/content/envelope,
cancel, stale saved pay, changed recipient, changed identity, lost confirmation response and
unknown-outcome recovery. Actual browser-driven TLS SMTP captures are retained. Scoped axe
observations do not establish all-screen/manual accessibility. Final secret scans, evidence
hashes are retained above. Gitleaks **8.24.3**, default rules, passes staged and exported-content
checks with **zero findings**; all seven compressed logs are explicitly decompressed for the
export scan. The receipt describes its exact index snapshot; final metadata is also subject to
the staged scan and mandatory commit hook. This does not close historical-secret findings.
All artifact hashes are verified before publication. A branch push does not establish deployment.

Fresh final runtime npm scan: **1 high / 0 moderate / 0 critical**, exit 1, solely node-forge.
The complete root scan is separately **2 high / 1 moderate / 0 critical**, exit 1: node-forge,
Electron and fast-uri. Electron's certificate-chain mitigation and fast-uri's URI interpretation
records are separate unremediated desktop/build findings; this increment does not resolve their
reachability or native binary effects. Advisory counts are vulnerable-package entries. All seven
reviewed runtime advisory records remain active, so the four runtime entries removed by these
package changes are remediation credit, **not withdrawn-advisory credit**. No clean-audit or risk
acceptance claim is made.

Claims here are **implemented** and, where linked observations show it, **locally demonstrated**.
Public upstream records and Python's second parser are independent reference inputs, not an
independent security review of our app. Hosted/runtime/native Windows testing, real provider/inbox
observations, independent security review, existing Node minimum mismatch and observed auth
latency remain open. Historical whole-control totals are unchanged; the release remains held.

Primary sources read 24 October 2026:

- [body-parser advisory and patch](https://github.com/expressjs/body-parser/security/advisories/GHSA-27r3-jxmh-p828)
- [Multer advisory and patch](https://github.com/expressjs/multer/security/advisories/GHSA-q7qp-rjg7-q26m)
- [Zod advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) and [collection-gate patch/tests](https://github.com/colinhacks/zod/commit/a0ebf970f2d752e5f58527cd2942ff48be4f46bd)
- Nodemailer [nested comments](https://github.com/advisories/GHSA-8c8m-p3m8-cjg8), [group delimiters](https://github.com/advisories/GHSA-m943-m63m-w62w), [quoted angle](https://github.com/advisories/GHSA-85x2-q946-cp5h), [patch/tests including local-part substitution](https://github.com/nodemailer/nodemailer/commit/1cd57d2b8c49dff048c21cdbafdb54439a7f07e2)
- [Open node-forge advisory](https://github.com/advisories/GHSA-86w9-cpqp-85rv)
- [SMTP path/mailbox grammar](https://www.rfc-editor.org/rfc/rfc5321.html#section-4.1.2), [message address grammar](https://www.rfc-editor.org/rfc/rfc5322.html#section-3.4)
