# Browser audit startup and clean-checkout verification

The browser audit starts `tests/e2e/server.ts`, which creates private temporary
tenant/catalog/upload data and a loopback TLS SMTP peer. Its SMTP capture lives
under the checkout's ignored `work/` directory. On a fresh checkout that directory
does not exist; the fixture must create it before starting the capture timer.
No production database or real provider is used by this procedure.

The pre-fix failure is `ENOENT` opening `work/payroll-email-browser-wire.json`.
Node exits before Playwright's health prerequisite, so no browser cases run.
Playwright can subsequently create the report directory while recording that
failure. A later run in the same directory can therefore hide the original defect.

To validate a release candidate, use a fresh checkout/source snapshot of the pinned
commit, a supported actual Node runtime and the matching lockfile dependencies.
Use the repository commands:

```sh
npm ci --no-audit
npm run runtime:check
npx playwright install --with-deps chromium
npm run test:e2e
```

The official Playwright command installs the browser and supported OS dependencies;
on Windows, native installer/host acceptance remains a separate check. Do not add
`mkdir work` as an undocumented prerequisite or treat an earlier failed run's
capture as current evidence. Check the process exit, JSON global errors, scenario
counts and capture timestamps/content together. A startup failure with zero cases
is not evidence for the 78 browser scenarios.

After the fix, the fixture initializes the existing diagnostic directory itself.
Existing unrelated files are retained. If a regular file occupies the `work`
path, initialization fails visibly and preserves it. Inspect that path and keep
the failure log; if it is your disposable diagnostic output, move it aside for
review before a fresh run. No automatic deletion, collision bypass, retry masking
or cleanup of private application data is provided.

On CI, inspect the browser job's web-server stderr and the existing `browser-audit`
artifact. The built-in GitHub reporter identifies startup exit codes; it may not
include the underlying stderr error. Record inaccessible logs as missing evidence,
and keep the gate open until the exact candidate's fresh-checkout CI job succeeds.
The local [contract/evidence](../audits/browser-startup-contract.md) distinguishes
demonstrated `ENOENT` from the original remote stderr that was unavailable.

The first run after fixing startup exposed a separate MFA prompt focus race:
a queued 50 ms focus reset redirected the entered recovery code into the password
field, and the server correctly rejected the empty code. The client now relies
on the shared modal's existing initial focus and preserves later user movement.
Do not compensate with test sleeps, reduced factor validation or retries until
green. Keep the failed HTTP/input trace separate from later successful evidence;
public extracts use lengths/status, while complete authenticated traces stay local.

Passing this gate verifies the tested synthetic flows. It does not approve the
broader production release, confirm real email delivery, certify Windows/Electron,
or replace independent host/storage/restore/security/accounting review.
