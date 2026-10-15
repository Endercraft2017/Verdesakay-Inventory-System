# Audit validation results — 16 October 2026

Results apply to isolated local fixtures, not live production.

| Check | Result | Scope / limit |
|---|---|---|
| TypeScript | PASS | `npm run typecheck`; final run recorded locally |
| Full Vitest suite | PASS | Dependency-updated final run: 190 files, 1,966 tests, 269.60 seconds |
| Focused final security | PASS | Latest additional run: 2 files, 18 tests (includes legacy retry and fresh production bootstrap); preceding run: 5 files, 46 tests covering DNS pinning, messaging, auth/recovery, replay, crypto/tenant, rate limits and operator sessions |
| Playwright + axe | PASS | Final run: 4 scenarios, 8.4 seconds; desktop login/stock/logout, 360px mobile/offline, login accessibility, API abuse/header checks |
| Local mixed read load | PASS, limited | 450 requests, 0 failures, 100 fixture items; 5/15/30 clients; p95 ~9/28/65 ms; not production-scale capacity evidence |
| OWASP ZAP 2.17.0 | COMPLETED, gaps recorded | 82 discovered endpoints; 1 High confirmed local SPA false positive; 1 Medium missing CSP; 3 Informational types. No authenticated staging certification |
| Gitleaks 8.24.3 history | FINDING | 268 commits; 10 reviewed exact false positives; 1 removed historical bearer artifact requiring owner invalidation/exposure evidence |
| Gitleaks public/console | PASS | Both source-client scans returned 0 detections; binaries not scanned |
| npm advisory audit | COMPLETED after user consent | Root: 0 Critical/1 High/8 Moderate; launcher: 0 Critical/0 High/8 Moderate; mobile: 0. Runtime root only High is the unreachable node-forge verification path. See dependency-audit.md |
| Node 22 / Electron / Android / iOS | UNVERIFIED locally | CI matrix added for Node 22/24; physical platforms and remote job outcomes not established |
| Live WAF/TLS/backups/alerts/branch protection | UNVERIFIED | No production configuration evidence supplied |

All 233 individual control results and remaining failure scenarios are in
[production-scorecard.md](production-scorecard.md). Raw reports and screenshots
are delivered separately; they contain only synthetic test data or redacted findings.

Dependency-updated TypeScript, full Vitest (1,966 tests) and Playwright (4 scenarios) passed. Mobile build:web and xcode UUID compatibility passed. Recovery cleanup retention was then verified with focused auth/session/mail/LAN-TLS tests so housekeeping cannot reset the per-account recovery throttle.
