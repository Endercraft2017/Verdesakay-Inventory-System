# Runtime findings observed 24 October 2026

This is the **pre-remediation observation** from the SQLite startup increment. The subsequent
[dependency remediation](dependency-remediation-2026-10-24.md) installs four compatible fixes
and reduces the runtime gate to **one high / zero moderate**, still exit 1. The table below
retains the original installed versions and findings; it is not the final dependency graph.

The runtime npm audit performed during SQLite startup verification exits **1** and reports
**4 high / 1 moderate / 0 critical vulnerable-package entries**. There are seven linked advisory
records because three affect Nodemailer. Package manifests and lockfiles are unchanged by the
startup fix. Earlier one-high/zero-moderate results are dated snapshots; the newer remediation
record identifies the current gate.
The installed runtime graph was also read with `npm ls --omit=dev` (exit 0); its
[selected actual versions](evidence/sqlite-startup-installed-runtime-versions.txt) match the
affected versions below, including Express's transitive body-parser.

Public GitHub advisory API records were fetched directly and all seven have `withdrawn_at: null`.
This establishes active package-version findings, not a reproduced exploit of every application
path. Do not attribute the count change to this code change or assume all advisories were newly
published: the Zod record predates this lookup. No dependency update, risk exception or package
remediation is included in the startup increment.

| Package / locked version | npm severity | Primary advisory | Reported first fixed version |
|---|---|---|---|
| body-parser 1.20.8 | High | [GHSA-27r3-jxmh-p828](https://github.com/advisories/GHSA-27r3-jxmh-p828): trailing bytes after compressed request bodies can cause denial of service | 1.20.9 on the installed 1.x line |
| multer 2.4.0 | High | [GHSA-q7qp-rjg7-q26m](https://github.com/advisories/GHSA-q7qp-rjg7-q26m): pending asynchronous fileFilter after request teardown | 2.5.0 |
| zod 4.4.3 | High | [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5): oversized constrained collections can exhaust memory | 4.6.6 |
| nodemailer 10.1.1 | Moderate | [Nested comments](https://github.com/advisories/GHSA-8c8m-p3m8-cjg8), [quoted semicolon/group](https://github.com/advisories/GHSA-m943-m63m-w62w), [quoted local part/angle address](https://github.com/advisories/GHSA-85x2-q946-cp5h): address parsing can reinterpret recipients | 10.1.4 |
| node-forge 1.4.0 | High | [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv): RSA PKCS#1 v1.5 verification accepts extra nested DigestAlgorithm elements | No fixed version reported |

## Separate engineering follow-up

Use bounded disposable-process/HTTP tests to reproduce relevant parser/upload/validation
conditions before upgrading the compatible affected packages. Repeat functional, malformed-input,
resource-bound and browser regressions against the final dependency graph. For Nodemailer, retain
actual captured SMTP envelope/header behavior and test the reviewed payslip recipient boundary;
existing normal-address tests do not establish the absence of these newly checked edge cases.

Source leads are global Express request parsing (`src/app.ts`), multipart upload adapters,
route/service Zod schemas (`src/shared/validation.ts` and callers), and tenant/platform/reviewed
mail adapters. Authenticated access, request limits and single-mailbox checks may constrain
specific paths but are not an app-wide vulnerability disposition. The existing node-forge
reachability analysis remains a limited assessment, not an approved exception.

These package fixes are engineering work; the owner is not being asked to implement them.
Keep the dependency and overall release holds open. Raw npm output and the primary advisory
summary are retained in the SQLite startup evidence group; no real provider or customer traffic
was used to investigate these records.
