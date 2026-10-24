# Profile footer sign-out and account-form UI

2026-10-24 Asia/Manila. Initial source: `a115f0d`; publication integrates `8b86ddf` on `restructure/module-architecture` plus this patch.
Findings F-004/F-005 and the current user checkpoint are in the testing tracker.

The user requested Sign out at the end of Profile and supplied a Change username screenshot
whose action touched the password input and whose autofill colors differed from the theme.
The older Figma Profile reference (`quipCMr7ChPNSYpzFQCM50`, `46:953`) was read with its screenshot;
the new footer follows the user's requested extension. Existing mobile buttons/forms/tokens reused.

Changes: Profile footer delegates to the existing guarded `MApp.signOut`; 48px minimum target;
16px account-form gaps; empty status messages do not reserve space; theme-aware autofill;
service-worker cache v150 (publication integrates upstream `8b86ddf`'s v149 first).
No new backend APIs or changes to credentials/permissions.

`baseline.json`: 13 failed assertions and seven passed on the unchanged UI. The failed matrix
repeats two findings: absent footer and zero-pixel username field/action gap. `verified.json`:
29 passing checks. Screenshots show the local sample tenant, never live account credentials.

Runner: `node --import tsx scripts/test-mobile-profile-layout.mjs` (set `CHROMIUM_PATH` when
using system Chromium; `QA_OUTPUT_DIR` selects the evidence folder). It starts the actual app
with a disposable path-tenant database; no mocked auth/API responses. The runtime DB is removed
after closing its connections. No external requests or real-account changes are needed.

Playwright Chromium: 320×844, 390×844, 658×844; touch/mobile and both themes. Checks include:
footer reachability above dock, form gaps/overflow, exact autofill token colors via Chromium's
forced `:autofill` state, genuine offline queued-action cancellation retaining account/action,
one server logout request and old-token 401, borrowed personal-cache cleanup, and local password
mismatch rejection. Real phone password-manager rendering remains a user retest item.

`profile-interactions.txt`: existing Profile runner passes (late responses, drafts, saves,
password validation and session controls). `focused.txt`: 165 checks across mobile, auth,
shared-phone and PWA files pass. `typecheck.txt`: passed. `full-suite.txt`: all 305 files and
3,266 checks pass after upstream integration (564.40s). `asset-hashes.txt` identifies the final source assets for comparison
after publication. `git diff --check` also passes.

The patch is published as **`2d4c865`** and Railway reports SUCCESS. See `live/` for five passing
release checks, including update of an existing cached session. The user remains at M01,
step 6, awaiting manual comparison. Other mobile/desktop features were not advanced.

`publication.json` and `publication-typecheck.txt` repeat the focused release checks after
upstream integration. `full-suite-pre-integration.txt` retains the earlier 3,220-check result.
