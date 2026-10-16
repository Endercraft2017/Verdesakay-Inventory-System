# Dependency audit — second pass, 16 October 2026

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
