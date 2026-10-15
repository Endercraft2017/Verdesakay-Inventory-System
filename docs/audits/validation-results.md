# Audit validation results — 16 October 2026

Results apply to isolated local fixtures, not live production.

| Check | Result | Scope / limit |
|---|---|---|
| TypeScript | PASS | `npm run typecheck`; final run recorded locally |
| Full Vitest suite | PASS | Final release run: 190 files, 1,964 tests, 274.23 seconds. Later legacy-retry/bootstrap regressions are verified separately below |
| Focused final security | PASS | Latest additional run: 2 files, 18 tests (includes legacy retry and fresh production bootstrap); preceding run: 5 files, 46 tests covering DNS pinning, messaging, auth/recovery, replay, crypto/tenant, rate limits and operator sessions |
| Playwright + axe | PASS | Final run: 4 scenarios, 8.4 seconds; desktop login/stock/logout, 360px mobile/offline, login accessibility, API abuse/header checks |
| Local mixed read load | PASS, limited | 450 requests, 0 failures, 100 fixture items; 5/15/30 clients; p95 ~9/28/65 ms; not production-scale capacity evidence |
| OWASP ZAP 2.17.0 | COMPLETED, gaps recorded | 82 discovered endpoints; 1 High confirmed local SPA false positive; 1 Medium missing CSP; 3 Informational types. No authenticated staging certification |
| Gitleaks 8.24.3 history | FINDING | 268 commits; 10 reviewed exact false positives; 1 removed historical bearer artifact requiring owner invalidation/exposure evidence |
| Gitleaks public/console | PASS | Both source-client scans returned 0 detections; binaries not scanned |
| npm advisory audit | UNVERIFIED | Automatic approval review blocked metadata transmission pending explicit user consent |
| Node 22 / Electron / Android / iOS | UNVERIFIED locally | CI matrix added for Node 22/24; physical platforms and remote job outcomes not established |
| Live WAF/TLS/backups/alerts/branch protection | UNVERIFIED | No production configuration evidence supplied |

All 233 individual control results and remaining failure scenarios are in
[production-scorecard.md](production-scorecard.md). Raw reports and screenshots
are delivered separately; they contain only synthetic test data or redacted findings.
