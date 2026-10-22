# Payslip email verification notes — 22 October 2026

Scope is [the release contract](payroll-email-contract.md). [Operational recovery](../operations/payroll-email-release.md)
is part of the result. Whole-application release controls remain open; this follow-up does not
convert partial controls to PASS. Base commit: e7cf902f2c225fe8bd1a7964d403c8647483eb37.

## Evidence and independent observations

| Requirement | Method and oracle | Evidence |
|---|---|---|
| Exact tenant/recipient/revision/content | HTTP review/confirm; real TLS SMTP envelope, Message-ID and decoded MIME compared to reviewed HTML; direct revision/content hashes | payroll-email.test.ts; before-wire.json; browser-wire.json; crash-results.json |
| Invalidate stale approval | Pay, status, metadata, recipient, linked account, account activation, templates, globals, company/mail settings, password, MFA, permissions/roles, session expiry/revocation/idle, freshness; reverted edits; checks both before confirm and before dispatch | focused-final.txt and tests/payroll-email.test.ts |
| Strict boundaries | Forged token/record, other session, real other tenant with identical record ID, extra browser HTML/recipient fields, multi-recipient/header-shaped address, old HTTP receipt | focused-final.txt; new input/state schemas |
| Durable acceptance and no blind replay | Same review/different HTTP keys; competing reviews; three workers; two independent server processes; lost committed confirmation response | focused-final.txt; crash-results.json; playwright-final.json |
| Honest states | 64 database state pairs against the declared transition rules; explicit RCPT/DATA 550 and RCPT 451, lost final reply, stalled peer/socket cleanup, claim/outcome event failures, expiry/cancellation | tests/payroll-email.test.ts; focused-final.txt |
| Crash recovery | Real server.ts and actual SQLite/WAL; SIGKILL before greeting, after DATA/before 250, after 250/before outcome commit; restart queued and accepted intents | crash-results.json; schema.sql; crash-final.txt |
| Preserve offline authority | Actual site/PC/cloud sync, D6 conflicts and payroll replay; cloud-only snapshots/effects; an offline unmark synchronizes and invalidates cloud email; unenrolled installed process refuses all email stages | sync-payroll.test.ts; payroll-email-node.test.ts; focused-final.txt |
| Browser recovery | Exact preview and explicit confirmation; close without confirmation; source/recipient/context changes; repeated same confirmation after response loss; unknown history and explicit recovery form | seven email journeys within playwright-final.json |

Filenames in the evidence column are under evidence/ with prefix payroll-email-. The source
freeze hashes every changed application/test/tool/package file; final focused/browser/crash/full
checks run against the recorded tested bytes; the sole post-test whitespace-only delta is
recorded below with both hashes. The shared editor UX gate covers identical UI/editor
files before the final snapshot-only fix; their source hashes match both freezes. Form history and new email DDL are exercised on actual initialized databases,
not a handwritten substitute. New email tables/markers are excluded by the actual node-local
table/snapshot/effect policy. The frozen source and final command evidence are indexed in
[the verification manifest](evidence/payroll-email-verification.json).

The crash driver uses the real server entry point and production-mode SMTP adapter. Its peer
is an independent parent process that retains MIME when the child dies. Stale-claim age is
accelerated through a fixture timestamp after killing the worker; these cases do not wait
120 wall-clock seconds. A separate test observes real greeting timeout and socket closure.
The HTTP-loss hook destroys the actual response socket after the queue commit; the retry
acknowledges the same ID. Test kill/drop hooks exist only in the isolated drill workspace;
there is no production kill-switch endpoint or environment flag added to the application.

SQLite in the final drill reports WAL and synchronous=2 (FULL). Process-kill results establish
the tested local commit/restart behavior. They do not establish filesystem durability on the
hosting platform, recovery from old backups, arbitrary network partitions or all possible
interleavings. Two/three-worker cases and database uniqueness are evidence, not a capacity
benchmark or a formal proof of the whole application.

## Retained failures and corrections

- Original production baseline: five tests fail intentionally. Two show absent/stale review
  binding, one shows concurrent duplicates, one loses the SMTP final reply and resends, and
  one accepts mail then loses its mail_log write. E5's UI wording is verified in original
  source against SMTP semantics. These failures preceded application changes.
- Focused iteration 1: two fixture SQL errors (missing global-variable label, wrong audit
  column). Corrected the fixture; no product claim is based on those failed assertions.
- Iteration 2: two old tests expected immediate email/HTTP 400. Updated for the explicit
  review requirement; real successful SMTP release is covered by the new integration suite.
- Iterations 3–4: fixture idle state was not fully reset and the foreign tenant host was not
  configured. Fixed isolation and used the real tenant-path resolver. Those were test errors.
- Iteration 5: switching through a node fixture exposed an implementation error from passing
  the shared DB proxy to a per-connection configuration cache. The worker now passes activeDb().
  The cloud-after-node and real offline synchronization tests retain this regression coverage.
- Iteration 7 and the dedicated uppercase-domain reproduction: the SMTP envelope normalized
  the domain while the result check did not. Retained reviewed/wire/outcome values, then
  normalized domain case before review/submission, preserving local-part case per RFC 5321 2.4.
- Unconfigured-node reproduction: three tests fail; a valid local review/confirmation returned
  200/202 while the node worker refused to submit its queued intent. Added an explicit process
  mode gate in addition to the configured-node and worker guards. All three now pass.
- Actual sanitized-snapshot reproduction: queued intent/events made export fail on its
  restrictive foreign key; an empty intent history still exported two recreated technical
  marker rows after settings cleanup. Child events are now cleared before parent intents
  in the private copy, and markers after all settings cleanup. Both standalone reproductions
  now export zero private rows. Integration tests inspect actual database/file contents,
  verify original queued work survives, and submit that original intent once.
- First complete Vitest run: 321 files, 3465 tests, 318 files/3462 tests passed and three
  failures. Updated the migration target assertion to SCHEMA_VERSION; preserved former-name
  recipient checks through preflight while refusing direct send; added explicit
  syncClass('online') to every email route rather than exempting the route-class gate.
  No runtime source changed while that full run was active. Its complete failed output
  and first source freeze are retained. The final source freeze/reruns are separate.
- Crash experiment 1: four completed crash/restart cases were retained, then the intended
  lost-response hook failed to drop a response because Express shortens req.url in a mounted
  router. Corrected the test hook to originalUrl and repeated all six successfully. The final
  frozen-source experiment is a separate retained run.
- Browser iteration 1: wrong UI.modal body option/return type. Corrected integration.
- Browser iteration 2: focus could remain in the preview; a fixture tried editing Paid payroll
  directly; an assertion expected an emptied frame instead of its removal; identity changes
  had already disabled confirmation. Corrected focus/context handling and used legitimate
  Unmark/Edit/Mark steps. Updated assertions to the required cleared-content/no-request outcomes.
- Browser iteration 3: automated axe traversal of the script-blocked preview did not complete.
  Iteration 4 repeated that attempt with iframes=false, but the Playwright wrapper still
  recursed into frames. It was deliberately interrupted (exit 130), not counted as a pass.
- Browser iteration 5: CommonJS named-import error in the test tool. Fixed the default import.
- Browser iteration 6: all scoped accessibility scans completed, but Escape after Refresh
  exposed focus loss when replacing the clicked button. Explicitly restored focus to the new
  refresh control. Iteration 7 passed all seven journeys; final complete browser regression
  independently repeated them. Development browser files were edited between experiments;
  only the later frozen-source runs are delivery evidence.

Failed test output and completed browser reports/screenshots are retained, with raw and
normalized checksums. Authentication-bearing browser trace archives, generated private TLS
keys and temporary databases are excluded. All captured mail and identities are synthetic.

## Accessibility and visual limits

Eight viewport/theme combinations (1440, 1024, 768, 390px; light/dark) have dialog scans plus
isolated scans of the exact captured email HTML. The current axe-core engine runs on dialog
chrome with iframe traversal disabled; no accessibility rule is disabled. The original frame
keeps its script sandbox/CSP. Captured HTML is scanned separately on an isolated unauthenticated
page with network requests blocked. The scan wrapper's protected-frame incomplete result is
retained, not silently treated as tested. axe-core 4.14.0 was already installed transitively;
its direct test dependency is now explicit. No runtime dependency version changes.

Automated violations are zero. Gradient/overlap color-contrast results and frame-tested remain
incomplete on dialog chrome. All eight images were visually inspected: labels, recipient,
content and footer controls are visible and readable; no obvious overlapping control/content
was observed. Screenshots do not certify gradient contrast or all rendering. Separate HTML
scans have zero violations/incomplete results. Real keyboard tests cover dismissal, focus return,
stale-error recovery and response-loss retry. Screen readers, zoom/text enlargement, all email
clients, native Windows behavior and complete WCAG conformance remain independent acceptance.

The unchanged editor UX gate also runs because the record screen is shared with print/editor
workflows. Its existing manual-review results remain open; passing the gate is not a claim
that every app screen or assistive-technology journey has been evaluated.

## What the evidence does not establish

- Real provider SMTP authentication/STARTTLS behavior, provider rewriting/forwarding, bounces,
  spam filtering or mailbox delivery. Local wire tests use verified implicit TLS with a
  generated test CA and synthetic recipients; no live-provider credentials or messages.
- Exactly-once delivery. Confirmed delivery is unavailable in this integration. Unknown is
  preserved, and another attempt requires explicit investigation and duplicate-risk consent.
- Trustworthiness of arbitrary database administrators or compromised browser/server runtimes.
  The tenant database is a trust boundary; events are mandatory transactional records, not an
  independently anchored tamper-proof ledger. Existing fallback key storage shares that boundary.
- Operational worker monitoring, throughput under real tenant/SMTP latency, hosting storage,
  backup/rollback safety, provider retention or legal/accountant approval. Restoring an older
  database can repeat outside effects unless SMTP is held and provider history reconciled.
- Mixed-version/native rollout. Schema 85 and authority tests use upgraded code on both
  sides. The Windows installation/update and mixed-build rollout need independent acceptance;
  no claim is made about every previously shipped desktop build.
- Historical unlogged/pre-upgrade mail. Recognized legacy subjects trigger investigation, but
  missing logs and renamed numbers prevent a complete reconstruction.
- Full payroll arithmetic, actual payment/remittance, complete-control audit closure or
  unrestricted production readiness. Existing broader blockers and advisory findings remain.

Runtime advisory refresh: npm audit --omit=dev on 22 October still returns exit 1: node-forge
(high), mammoth, argparse and sprintf-js (moderate). They remain broader release blockers;
this task changes no runtime dependency version. The direct axe-core test edge points to the
same already-installed 4.14.0 package and was updated offline without install scripts.

Final staged whitespace gate caught one empty line after the final function brace in
payroll-email-schema.ts. It was removed after the passing full run; rstrip byte equality
was asserted and both tested/committed hashes are recorded in the source freeze. This is
the only post-test source change. Typecheck and staged whitespace/secret gates were repeated;
no executable code or SQL changed and the full suite was not repeated for this formatting fix.
