# Dependency audit — second pass, 16 October 2026

Latest remediation: **24 October — one high runtime entry**, exit 1 (node-forge).
The separate complete-root scan has **two high / one moderate**, including Electron/fast-uri.
[Four compatible updates, original failures and limits](dependency-remediation-2026-10-24.md)
are documented separately from the [earlier same-day observation](runtime-advisories-2026-10-24.md).
All seven runtime primary advisory records remain active; this count reduction comes from the
package changes, not a withdrawal. Exact quoted-mailbox preservation still fails a retained
standalone experiment; public/reviewed validation refuses that syntax. The release remains held.
The 23 October formatter withdrawal and one-high/zero-moderate results below are historical.

The user explicitly approved npm advisory lookups. All three lockfiles were scanned again after
merging the newer source. Compatible patches were applied with `npm audit fix --ignore-scripts`;
no blanket forced major-version downgrade was accepted. In particular, npm's proposed old Mammoth
version would replace the new document conversion implementation and was not treated as a fix.

| Lockfile | Critical | High | Moderate | Result |
|---|---:|---:|---:|---|
| Root | 0 | 1 | 10 | Includes runtime advisory below and inherited desktop/build-tool chain |
| Root runtime only | 0 | 1 | 3 | node-forge plus Mammoth/argparse/sprintf propagated entries |
| Launcher | 0 | 0 | 8 | Electron builder download/logging chain |
| Mobile shell | 0 | 0 | 0 | No npm advisories at lookup time |

Counts are vulnerable-package entries, not unique vulnerabilities. Exact redacted npm JSON is
retained in `evidence/second-pass-npm-*.json`. Root compatible fixes removed additional High
findings in http-cache-semantics, nanoid, postcss and source-map-js. The test runner was patched
to Vitest 4.1.12. A lockfile scan does not cover every vendored browser library or native binary.

## Remaining runtime reachability

**High: node-forge GHSA-86w9-cpqp-85rv (RSA signature verification, <=1.4.0).** No fixed upstream
version was offered. Application use is limited to `src/desktop/lan-tls.ts`, which generates/parses
locally controlled certificates/keys and signs certificates; it does not invoke the vulnerable
signature-verification operation. This is a documented reachability assessment, not removal of
the dependency or an accepted release exception. Review again if this adapter or dependency
usage changes. The raw `npm audit --audit-level=high` CI step still fails; do not call it green.

**Moderate: sprintf-js GHSA-hp3w-g68c-fv3c**, through Mammoth's argparse dependency. The advisory
concerns unbounded precision format strings. The application uses Mammoth's programmatic DOCX
conversion API; it does not invoke Mammoth's CLI argument formatting. Document conversion still
needs hostile-file/resource testing independent of this npm advisory. Retain the finding and
monitor an upstream fix rather than accepting a destructive major-version downgrade.

Desktop build/download dependencies remain a separate supply-chain risk. Build in a controlled
environment, review downloaded artifacts and signing, and retest before distributing installers.
New High/Critical reachable findings must block release. Unpatched findings require an owner-
approved, time-bounded decision with compensating controls; none is silently approved here.

## Console passkey dependency follow-up — 2026-10-16

After installing pinned SimpleWebAuthn server 14.0.3/browser 14.0.0 and esbuild 0.28.1
(dev-only reproducible bundling), `npm audit --omit=dev --json` still reports **0 Critical,
1 High and 3 Moderate** vulnerable-package entries. No advisory entry names either passkey
package. Existing node-forge and Mammoth/argparse/sprintf findings and the reachability limits
above remain. Exact runtime JSON is `evidence/console-passkeys-npm-runtime.json`; the command
correctly exits nonzero. This increment did not revalidate launcher/mobile lockfiles or clear
all development-chain findings.

## Native vault dependency follow-up — 2026-10-16

The mobile lockfile now pins SecureStorage 8.0.1 and esbuild 0.28.1. After integration,
`npm audit --json` reports **0 Critical / 0 High / 0 Moderate / 0 Low** across that lockfile.
See `evidence/native-vault-npm-audit.json`. This does not clear the separate root/launcher
findings or attest the compiled native binary; the native bundle includes license notices.

## Current runtime recheck — 18 October 2026

A fresh authorized `npm audit --omit=dev --json` still returns **0 Critical / 1 High /
3 Moderate** vulnerable-package entries and correctly exits nonzero. Registry metadata still
lists node-forge 1.4.0 as latest with no advisory fix. The proposed Mammoth 0.3.29 replacement
remains an inappropriate old major-version downgrade; none was applied. No lockfile or dependency
was changed in the accounting lifecycle increment. Raw evidence is
`evidence/gaps-2026-10-18-npm-runtime.json`. Reachability limits and release disposition above
remain open. This does not revalidate launcher/dev/mobile lockfiles or clear historical secrets.

### 22 October 2026 — narrow payslip email follow-up

Refreshed `npm audit --omit=dev --json` under the user's existing advisory-API authorization.
Exit 1: node-forge high; mammoth, argparse and sprintf-js moderate (four total). Retained
[evidence](evidence/payroll-email-npm-runtime.json). Runtime dependency versions are unchanged;
these findings remain broader release blockers. The explicit axe-core 4.14.0 test dependency
points to the same previously installed transitive package; its lock edge was added offline
without installation scripts. This audit does not certify a clean dependency graph.

### 23 October 2026 — withdrawal verified; original dependencies retained

The formatter advisory GHSA-hp3w-g68c-fv3c was withdrawn upstream at 2026-10-22T19:21:04Z
(23 October, 03:21 Manila), verified against the primary notice and API on 23 October. Fresh npm lookups, including an
explicit full-root `--include=dev` scan and a fresh cache, now return **one high /
zero moderate**. The high node-forge finding remains; all scans correctly exit 1.

The prior 22 October raw snapshots are retained: original root runtime one high/three
moderate; original full root one high/ten moderate. A proposed parser override removed
Mammoth's formatter edge and the candidate full root then had one high/eight moderate.
Those eight build-tool entries disappeared from the feed after withdrawal, with no
build-tool fix. Counts must not be attributed to code when the advisory feed changed.

A harmless clean baseline probe reproduced sprintf-js's precision RangeError, but
source review demonstrated no application route supplying the affected format string.
A thrown library exception alone did not demonstrate an application vulnerability.
The candidate kept Mammoth 1.13.0 and selected argparse 2.0.1; real CLI/API and broad
regressions passed. Once its advisory rationale was withdrawn, the major override
was abandoned. **The final package.json and package-lock.json are identical to the
baseline, and the original installed dependency graph is verified.** No private
package patch, forced old Mammoth downgrade or advisory suppression is delivered.

See [decision/research and failed experiments](dependency-parser-contract.md),
[verification manifest](evidence/dependency-parser-verification.json) and
[installation/re-evaluation procedure](../operations/dependency-parser-upgrade.md).
The retained browser regression covers real malformed-file recovery, reviewed Word
conversion, local Apply and undo, with no premature template publication. Candidate
results and final restored-graph results are labeled separately.

node-forge still has no offered fixed version. Its limited observed certificate-generation
use remains a reachability assessment, not an approved risk exception. CI's actual
high-advisory gate stays enabled and failing. Launcher/mobile were not rescanned here;
this supersedes their old formatter severity interpretation only through the cited
upstream withdrawal, not a fresh scan of those lockfiles. Native/build-chain assurance,
historical secrets and all broader production gates remain open.
