# M01 evidence — mobile sign-in and sessions

**Current comparison:** use [hosted evidence](hosted/README.md). The local baseline/retest
below is historical, from the initial older checkout; its code patch was archived before
fast-forwarding to `5b5830e`. These older suite totals do not describe the current branch.

Run date: 2026-10-24 Asia/Manila. Baseline: `restructure/module-architecture` at
`ab1b682`. Retest: same commit plus the local `selfServiceContext` fix and three
new auth regression tests. See [the tracker](../../mobile-feature-tracker.md) for
acceptance criteria, fixture setup, findings, case order and manual checkpoint.

Chromium 151.0.7922.173 via Playwright, touch/mobile emulation at 390×844, en-US,
Asia/Manila. The user agent identifies Android Chrome; this is emulation in Linux
Chromium, not a real Android or Safari result. Actual Express routes, SQLite,
static assets and service worker were used; no API response fixtures substituted.
Network disconnection was simulated only for M01-03. Existing office data was
unused: server state is under `/workspace/work/mobile-qa/runtime`.

- `baseline/results.json`: 7/8 passed; M01-04 captures the incomplete fresh identity.
- `baseline/fresh-signin.png` and `after-reload.png`: same account, approvals missing
  before reload and present afterwards.
- `baseline/vitest.txt`: 94 existing checks pass with local socket permissions.
- `baseline/regression-before.txt`: all three new cases fail before the fix.
- `retest/results.json`: all eight Playwright cases pass.
- `retest/fresh-signin.png` and `after-reload.png`: approvals visible in both states.
- `retest/typecheck.txt` and `focused-vitest.txt`: passing typecheck and 105 checks.
- `retest/full-vitest.txt`: 1,949 pass; one pre-existing subscription route guard failure.
- `baseline/existing-suite-failure.txt`: same failure reproduced from clean `ab1b682`
  source/config/test/setup extracted with `git archive`; the auth changes are absent.

Archived patch file identity (`git hash-object`, initial local run): auth route
`0ae27dee227f54ef1b39d097636a37920dae1271`; auth tests
`dfa1a4cdfcab0756e22d935cd58d96e92bb37c6c`. Patch retained under
`/workspace/work/mobile-qa/earlier-local-fix-ab1b682.patch`; not applied to the current branch.

Results omit tokens and credentials. The separate raw Playwright traces and all
intermediate screenshots remain under `/workspace/work/mobile-qa/evidence/`;
traces contain disposable local-session data and are intentionally outside source.
The reproduction runner is `/workspace/work/mobile-qa/session.mjs`, and fixture
creation is `/workspace/work/mobile-qa/seed.mjs`. The latter is for a fresh isolated
database, not an existing company database.

Captured browser-console failures are expected wrong-password, intentionally
disconnected login and ended-session probes. No uncaught JS errors were observed.
Manual/real-device results and user build/account comparison remain pending.
