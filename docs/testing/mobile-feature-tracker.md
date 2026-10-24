# Mobile feature testing

Updated: 2026-10-24 (Asia/Manila). Desktop testing waits for explicit user instruction.

## Resume here

- Branch: `restructure/module-architecture`, now `8b86ddf` plus the Profile UI patch;
  initial checkout was `ab1b682`.
- Round: **M01 — sign-in, session persistence, sign-out**.
- Active change: F-004/F-005 implemented locally; 29 real-app Playwright checks, 165 focused
  checks, existing Profile interaction runner and typecheck pass. Final integrated full suite: **3,266 checks
  passed across 305 files** (564.40s).
  User approved publication, commit and push. Preserving upstream `8b86ddf` and using cache
  v150; final integration checks passed. Commit/push and live verification in progress.
- Prior hosted baseline: eight session cases and Show/Hide password passed at 390×844. Four relevant
  deployed assets matched the checkout and stayed unchanged across the final hosted run.
  User: switched to mobile and requested the footer action and form correction, with screenshots.
  Side-panel sign-out worked on desktop according to the user. Earlier local suite
  results below apply only to the archived baseline.
- User checkpoint: **M01, step 6 — Profile sign-out retest pending publication**.
  Prior steps have not been individually confirmed on mobile.
  Do not advance features until results are compared.
- User URL: `https://otom.afkcube.com/sandbox/m`; account `sandbox`, Administrator, **no employee link**.
  Password supplied privately for sign-in; not recorded in this tracker or committed evidence.
- Setup link: `https://otom.afkcube.com/sandbox/m?view=mobile` explicitly selects mobile and
  remembers that preference. Check for Home / Work / Clock / Inbox / Profile along the bottom.
- Current comparable evidence: `docs/testing/evidence/m01/hosted/`. Second account not supplied;
  cross-account isolation and hosted linked-employee identity remain unverified.

## Working agreement

Before each round: define acceptance from requirements/contracts, inspect implementation, run
Playwright, record actual evidence, then send the complete numbered manual checklist. Keep the
same build, account role, data and starting state for comparisons. Record defects before changing
code; retain before/after results. Mark complete only after manual results are reconciled and
open issues explicitly accepted or resolved. A matching result alone does not establish correctness.

Status: queued / testing / awaiting user / fixing / retesting / complete / blocked.
Each finding has an ID, defect/improvement type, reproduction, expected/actual, impact, evidence,
change, automated retest, user retest, and resolution. Questions retain the current step and
prompt a short answer plus the remaining instructions.

## Feature order (mobile only)

These are review-sized rounds; split a row into cases as it is reached, without testing all rows now.
The initial 42-route inventory was refreshed after fetching the current branch: 53 named routes
under `public/mobile/`, together with shell helpers. These are implementation inventory, not verified features.

| ID | Feature/functions | Dependencies and correctness evidence | Status |
|---|---|---|---|
| M01 | Sign-in, own/borrowed session, reopen, sign-out | Auth/session contract; token storage, server session lifecycle, identity consistency | awaiting user |
| M02 | Home, stable dock, Work hub, Quick Orbit, guides, back/deep links, permission visibility | M01; correct employee/role destinations, denied routes stay denied | queued |
| M03 | Profile: personal details, approved edits vs HR-controlled details, appearance/accessibility | M01–02; API profile and saved values after reopen | queued |
| M04 | Account security: recovery, username/password changes, MFA, other-device sessions | M01; delivery/reset/2FA and session revocation verified; do not enable MFA or send recovery mail during M01 | queued |
| M05 | Schedule and Clock: valid actions, QR/location/photo, attendance history | Linked employee, configured schedule/office; actual punch and duplicate rules | queued |
| M06 | Time corrections | M05; own correction, withdrawal, resulting attendance after decision | queued |
| M07 | Request center: configured forms, details, drafts, submission, cancellation | Linked employee/form configuration; own persisted records/status | queued |
| M08 | Approvals: request/time-fix decisions, own-item exclusion, leave balance | M06–07; authorized decision and resulting balance/attendance | queued |
| M09 | Payslips: preview, final details and downloads | Seeded draft/final pay; ownership, finalization and PDF agree | queued |
| M10 | Inbox/conversations and directory: compose, reply, edit, reactions, attachments, unread | Two test accounts; recipient, message persistence and access | queued |
| M11 | Notifications and announcements; push opt-in separately | M10 and seeded events; correct recipient, unread, destination | queued |
| M12 | Personal tasks and notes | M01–02; own saved task/status/note | queued |
| M13 | Identified problem reporting | M10; correct recipient, evidence and saved report | queued |
| M14 | Anonymous reporting, access-code follow-up, authorized report inbox | Separate test channel; anonymity and access contract | queued |
| M15 | Inventory lookup/scan, item details, locations, low stock, recent movement log | Warehouse role + fixture stock; quantities/API permissions agree | queued |
| M16 | New item and stock actions: in/out, damage, transfer, batch, stock counts/tasks, allocation | M15; per-location totals, movement history and duplicates | queued |
| M17 | Purchase requests, receiving and order picking | M16 + prepared orders; expected quantities/status/movements | queued |
| M18 | Manufacturing: job orders, parts-kit release and acceptance, production/unit recording, semi finishing | Relevant desk accounts + prepared JO; SOP stage order and evidence | queued |
| M19 | QC, repair loop/parts requests, QA, held-unit decisions and unit issues | M18; desk permissions, inspections and allowed transitions | queued |
| M20 | RTS receiving, QR assignment and unit record | M19; unit stage and final stock accepted by authority | queued |
| M20a | Mobile sales intake and order detail | M15 + sales permission; saved order, ownership and availability | queued |
| M21 | Sales release: authorization, scan/package, handoff evidence, release slip | M20 + prepared SO; stock deducted once at valid handoff | queued |
| M22 | Delivery and proof of delivery | M21; assigned access, signature/photo/location and final status | queued |
| M22a | Returns and sales service | M21–22; authorized return/service record and resulting stock/status | queued |
| M23 | Offline queue: eligible writes, retry, conflict, duplicate/account isolation | Relevant earlier write; pending vs confirmed and persisted authority result | queued |
| M24 | Browser installation/update and native phone connection where available | Browser rounds; real-device install, permission prompts and native behavior | queued |

Inventory: core routes `home`, `settings`, `inbox`, `tasks`, `announcements`, `notifications`,
`report-problem`, `anonymous-report`, `confidential-reports`; HR `work`, `clock`, `schedule`,
`time-fix`, `requests`, `approvals`, `payslips`, `directory`, `my-log`; inventory `scan`, `item`,
`location`, `low-stock`, `new-item`, `stock-move`, `transfer`, `damage`, `batch`, `cycle-count`,
`allocate`, `receive`, `pick`, `so`, `deliveries`, `queue`; manufacturing `production`,
`job-orders`, `kit-release`, `qc`, `repairs`, `receiving`, `assign-qr`, `record`.

Additional current routes: `guides`, `notes`, `purchase-requests`, `returns`, `sales-new`,
`sales-order`, `sales-service`, `semi-finishing`, `stock-count-tasks`, `stock-counts`, `unit-issues`.

## M01 acceptance and archived local test cases

Sources: `docs/modules/pipelines.md` Account session; `src/core/auth.routes.ts`,
`src/shared/auth.ts`, `src/shared/validation.ts`, `public/js/api.js`, `public/mobile/app.js`.
The newer mobile handoff overrides the older role-UX document's obsolete dock description.

Acceptance: empty/invalid credentials cannot enter or create an authenticated session;
connection failure remains retryable; valid sign-in immediately supplies the correct identity,
employee link, modules and approval access; own session survives reload/new tab; borrowed session
is tab-scoped, marked shared and has no persistent token; sign-out clears browser auth and ends
the server session; another account cannot inherit the previous person's cached data.

| Case | Action and independent oracle | Assistant baseline | Retest | User |
|---|---|---|---|---|
| M01-01 | Empty username/password: browser prevents submission, no login request/session | pass | pass | pending |
| M01-02 | Wrong password: generic rejection, no usable session; button retryable | pass | pass | pending |
| M01-03 | Interrupted sign-in: network error, no authenticated UI; retry succeeds | pass | pass | pending |
| M01-04 | Fresh linked approver sign-in: identity/link/approval access matches authenticated `/auth/me` and DB role/link | fail F-001 | pass | pending |
| M01-05 | Own-phone reload and new tab retain same account/controls | pass | pass | pending |
| M01-06 | Sign out then back/reload/deep link: login required; old token receives 401 and DB records logout | pass | pass | pending |
| M01-07 | Borrowed phone: banner, sessionStorage only, reload retained, independent tab and closed/reopened tab require login | pass | pass | pending |
| M01-08 | Borrowed sign-out and account switch: prior vds_* personal cache removed; new identity only | pass | pass | pending |

### Current hosted comparison

| Case | Current sandbox observation | User |
|---|---|---|
| M01-01 | Pass: empty fields blocked; no login request | pending |
| M01-02 | Pass: wrong password gives `Invalid username or password`; remains signed out | pending |
| M01-03 | Pass: offline gives `You appear to be offline. Reconnect and try again. Your details are still here.`; retry succeeds | pending |
| M01-04 | Pass for Admin/unlinked: fresh UI identity and approvals match `/auth/me`; approvals visible without reload. Linked-employee case not run live | pending |
| M01-05 | Pass: own session survives reload and independent tab | pending |
| M01-06 | Pass: sign-out requires login after Back/reload/deep link; old token 401; own ended-session history says `logout`. Targeted path recheck also passes; scroll required in Account & security | desktop mix-up confirmed by user; mobile retest pending |
| M01-07 | Pass: borrowed banner and server shared flag; token only in tenant-scoped sessionStorage; independent/reopened tab signed out | pending |
| M01-08a | Pass: borrowed logout removes disposable local personal-cache marker and token | pending |
| M01-08b | Not tested: second hosted account unavailable | pending |
| M01-09 | Pass: Show changes password input to text; Hide restores password type (dummy text used) | pending |

No business data, account credentials, employee links or permissions were changed. Only the
run's own sessions were logged out. No other sessions were revoked. Hosted credentials and
tokens were excluded from evidence; no raw hosted trace was captured.

## Archived local reproduction environment

- Local server: `http://localhost:3000/m`, Node 24.19.0, `TZ=Asia/Manila`.
- All runtime data isolated under `/workspace/work/mobile-qa/runtime`; existing `db/` and uploads unused.
- Chromium mobile emulation, 390×844, touch enabled; no real-device results claimed.
- Scripts, screenshots, traces and sanitized network/console results: `/workspace/work/mobile-qa/`.
- Test credentials are disposable fixtures, never reuse them for real accounts.
- Local fixtures: `qa_mobile` (HR, linked `QA-M01`) and `qa_other` (Admin Staff, linked
  `QA-M02`), both password `MobileTest123!`. These exist only in the isolated local database.
- Existing relevant tests: auth, sessions-devices, mobile-shared-phone, frontend-mobile, me.
- Native keyboard, OS app lifecycle/session restore, installation, camera/GPS and push need
  real-device verification in their relevant rounds. Tab-scoping is not proof of server revocation
  on app close: server shared-session expiry/idle rules still apply.

## Findings and changes

### F-001 — fresh sign-in loses employee/approval context (defect, medium)

- Recorded before fix, starting commit `ab1b682`; M01-04 failed, the other seven cases passed.
- Reproduce: fresh sign-in as linked HR `qa_mobile`; Home has no "Review pending approvals".
  Reload: the button appears. Fresh `MApp.getMe()` lacks `employee` and `can_approve`, while
  authenticated `/auth/me` returns employee `QA-M01` and `can_approve: true`.
- Expected: the same account has the same employee identity and authorized controls immediately
  after sign-in and after reload. Oracle: stored employee link + role permissions + `/auth/me`.
- Impact: approvers miss their entry point; other employee-gated UI can misclassify a linked user.
- Cause: `/auth/login` builds a shorter user response than `/auth/me`.
- Evidence: `evidence/baseline/results.json`, `fresh-signin.png`, `after-reload.png`, `trace.zip`
  under `/workspace/work/mobile-qa/` (test fixtures only).
- Fix: both endpoints reuse `selfServiceContext` in `src/core/auth.routes.ts`; no permission,
  module or stage rules changed. API map/reference updated. Catalog and pipeline map reviewed;
  their existing responsibility/interface/stage descriptions remain accurate, so no edits needed.
- Regression: three new API tests reproduced the bug before the fix (3 failed, 15 passed),
  then passed with the fix. Covers linked HR, department head without HR rights, and unlinked
  non-approver. Playwright M01-04 now passes and fresh/reloaded Home both show approvals.
- Current status: superseded by upstream. After the user supplied the real URL, fetching found
  257 newer commits on this branch. The current client fetches `/auth/me` before entering the
  app; the hosted approval entry works immediately. The earlier helper/test/docs patch was
  preserved at `/workspace/work/mobile-qa/earlier-local-fix-ab1b682.patch` and removed before
  fast-forwarding to `5b5830e`; it was not deployed or reapplied over the newer implementation.
  Archived before/after evidence remains intact. User comparison pending.

### I-001 — Quick Orbit placement near Home actions (improvement candidate)

- The M01 screenshot shows the floating Orbit overlapping the right edge of the approvals
  row. Its text is readable. Review tap access and drag placement during M02, not this round.
- Evidence: retest `fresh-signin.png`. No change made; no confirmed functional failure.

### F-002 — existing subscription route absent from sync guard exception list (test defect)

- Found by the required full regression run: 187 files pass; `tests/sync-route-classes.test.ts`
  fails for `src/platform/platform.routes.ts:put /tenants/:slug/subscription`.
- Reproduced independently with original `ab1b682` source/config/test/setup extracted by
  `git archive` to `/workspace/work/mobile-qa/baseline-check`, without the auth fix. Same sole
  guard failure. Neither the platform route nor the guard was modified in this task.
- Existing cloud-console routes are exempt from workspace sync classification; the new
  subscription route is absent from that test's exception inventory. No subscription UI or
  offline behavior was exercised in this mobile round.
- Evidence: `baseline/existing-suite-failure.txt`, `retest/full-vitest.txt` in the evidence folder.
- Impact: full suite is not green; does not invalidate the passing M01 cases.
- Current status: resolved upstream, not an open failure on the current checkout. The same
  sync-route guard passes at `5b5830e` (one check). The previous full suite totals apply to
  `ab1b682` plus the archived fix only; no current full-suite claim is made.

### F-003 — sign-out instruction mismatch caused by desktop layout (test setup mismatch)

- User report: cannot find `Profile → Account & security → Sign out`; can sign out through the
  persistent right-side panel. Supplied screenshot shows the desktop icon rail, including help,
  theme and sign-out at the bottom; it matches `public/index.html`, not the mobile dock.
- Current user URL/device/browser not supplied; do not infer why desktop was selected.
- User subsequently confirmed they were testing desktop and will switch to mobile. The
  layout mismatch is confirmed; no mobile app failure was reported or reproduced.
- Targeted Playwright recheck at 390×844: explicit mobile URL renders the bottom Profile tab
  even after a saved desktop preference. Profile contains Account & security; its Sign out is
  below the initial viewport (y=1226), becomes visible after scrolling, and works. Old token
  receives 401. Profile asset unchanged throughout; no uncaught browser errors.
- Read-only shell check: desktop preference serves the shell containing `#logout-btn` and no
  mobile dock. No desktop feature testing performed; user's side-panel sign-out is recorded
  as user-reported only.
- Resolution: use `https://otom.afkcube.com/sandbox/m?view=mobile`, confirm the five bottom tabs,
  and explicitly scroll in Account & security. No app defect reproduced; no application code
  change. Manual results remain open. Evidence: `evidence/m01/signout-path/`.
- User checkpoint was step 6; restart at step 1 on the correct layout so results are comparable.

### F-004 — direct sign-out missing from Profile (requested improvement)

- User is now in mobile and explicitly requested Sign out below the Profile menu, above the
  bottom dock. Their screenshot shows Account & security followed by unused space and no direct action.
- Existing implementation offers sign-out only inside Account & security; earlier Playwright
  confirmed that button is below the initial security viewport. This is a separate improvement
  from the earlier desktop/mobile setup mismatch F-003.
- Expected: a distinct, full-width Sign out at the end of Profile; calls the existing
  `MApp.signOut()` flow, including queued-action warnings, push cleanup and server-session ending.
- Change: added a 48px-tall, theme-aware footer action below the Profile menu, using the same
  `MApp.signOut()` guard. Existing Account & security sign-out remains available. Service-worker
  cache bumped to v150 after preserving upstream v149 so installed browser apps receive the updated assets.
- Automated: passes in light/dark at 320, 390 and 658px; action above dock and hit-testable;
  one logout request, cleared browser token and old server token rejected with 401. Borrowed
  sign-out clears personal cache. Cancelling the genuine offline unsent-action dialog retains
  both the session and action. Only disposable local test data used.
- Status: fixed locally; all automated checks, including the full suite, passed. Publication
  and user retest pending. Publishing affects the shared app for all workspaces.

### F-005 — account form controls visually run together (UI defect)

- User screenshot: Change username's Update username action touches the Current password input;
  autofilled inputs have an inconsistent dark background.
- Implementation: username/password forms do not use the existing `.m-form` spacing primitive;
  adjacent label/button elements have no separating layout gap.
- Expected: clear gaps between labels, fields, helper text and actions; autofill uses Profile's
  active-theme colors; no overflow or dock-covered actions at mobile widths in either theme.
- Scope: Profile root sign-out and Account & security forms only. No credential/permission/API changes.
- Baseline: username input/action gap measured **0px** at all three widths in both themes.
- Change: reused `.m-form` with a scoped 16px gap for the username/password forms, removed
  extra empty-status spacing, and styled autofill with the existing Profile theme tokens.
- Automated: 16px username gap, no horizontal overflow at 320/390/658px in both themes;
  browser-forced autofill pseudo-state resolves to the exact light/dark Profile background
  and text colors. Password mismatch remains client-side with no credential-change request.
- Status: fixed locally; all automated checks, including the full suite, passed. Publication,
  real-phone autofill and user retest pending.

Current validation evidence: `docs/testing/evidence/m01/profile-ui/`; repeat with
`CHROMIUM_PATH=/usr/lib/chromium/chromium node --import tsx scripts/test-mobile-profile-layout.mjs`.
The runner uses real Express/API handlers and a disposable path-tenant DB, not mocked auth.
Figma Profile `46:953` was inspected; the user's requested footer extends that older reference.
No design assets were added. Catalog/architecture and the account-session entry point were updated;
no new business module, backend route or pipeline stage was introduced.

## M01 manual checklist — paused for Profile UI fix, then resume step 6

Setup: open `https://otom.afkcube.com/sandbox/m?view=mobile` in a mobile browser, using `sandbox` and
the supplied password. Start online and signed out. This account is an Administrator without
an employee link; **Employee record needed** is expected. Confirm the five bottom tabs after
sign-in; the desktop right-side toolbar is a different layout. User device/browser still unreported.

Happy path (M01-04, 05, 06):

1. Open the mobile URL above; leave **I'm using someone else's phone** unticked.
2. Enter the supplied credentials. Tap **Show**, then **Hide**. Expect visible, then hidden password. Tap **Sign in**.
3. Expect Home with **Administrator** and **Employee record needed**. Scroll down: **Review pending approvals** is present without refreshing.
4. Refresh. Expect the same account and approval button.
5. Open the mobile URL in a fresh tab. Expect the same signed-in account. Close that tab.
6. After publication, tap bottom **Profile**, scroll to the end of its menu, then tap **Sign out**. Expect sign-in. The Account & security path remains a supported alternative.
7. Use Back, then refresh. Expect sign-in, with no usable account screen.

Edge cases (M01-01, 02, 03, 07, 08):

8. Clear both fields and tap **Sign in**. Expect a required-field prompt.
9. Enter only the username and tap **Sign in**. Expect a password-required prompt.
10. Enter a wrong password and tap **Sign in**. Expect **Invalid username or password**; stay signed out.
11. Enter the correct password, disconnect Wi-Fi and mobile data, then tap **Sign in**. Expect the offline message; stay signed out.
12. Reconnect and tap **Sign in**. Expect Home. Sign out again using step 6.
13. Tick **I'm using someone else's phone** and sign in. Expect the **Borrowed phone** banner.
14. Refresh. Expect to remain signed in with the banner.
15. Open the mobile URL in a fresh tab manually (do not duplicate the tab). Expect sign-in. Close that new tab.
16. Close the borrowed-phone tab; open the mobile URL in a fresh tab. Expect sign-in.
17. Sign in as borrowed again; sign out through the banner. Expect sign-in.

Assistant result: all listed hosted checks passed. Cross-account identity isolation waits for a
second test account; linked-employee behavior waits for appropriate test data. Physical-phone
keyboard, OS tab restoration and app-close behavior remain to compare on the user's device.
Report pass or the first mismatching step number and visible result; retain M01 until compared.

## Check history

- Initial checkout `work` (`bf703f4`) was clean. Switched to requested local branch `ab1b682`,
  two commits ahead of `origin/restructure/module-architecture` (`65ea5ff`); no fetch/deploy/push.
- Typecheck: passed before changes.
- Missing global `~/.claude/CLAUDE.md`: used repository `CLAUDE.md` and `claude_instruction.md`.
- Sandbox blocked server sockets; app started with approved local execution permissions.
- Initial sandboxed Supertest run was invalid because local sockets were blocked. Reran with
  local execution permissions: existing baseline 94/94 passed across four relevant files.
- After fix: typecheck passed; 105/105 checks across auth, devices/sessions, shared phone,
  mobile routes and approvals passed. Full suite: 1,949 passed, 1 failed across 188 files
  (258.46 s). The sole failure is independently reproduced before the change (F-002).
- Playwright baseline: 7/8 passed. Retest: 8/8 passed, no uncaught browser errors and no
  horizontal overflow (390px document/viewport). Recorded console errors correspond to the
  deliberate wrong-password/offline/ended-session probes; the latter produced a protected
  `/me/today` 401 while navigating back, with sign-in remaining visible.
- User supplied hosted URL and `sandbox` login. Mobile redirect verified to `/sandbox/m`.
  The account is Administrator, department Administration, no linked employee.
- Fetched branch: `5b5830e`, 257 commits beyond initial `ab1b682`. Preserved the earlier
  local patch, restored only our four old tracked modifications, then fast-forwarded the
  branch. No user modifications were present or removed; all testing docs/evidence retained.
- Hosted app.js changed during initial inspection. Repeated the session run with four
  before/after asset fingerprints: stable and matching `5b5830e` client files. Eight session
  cases plus the separately tested Show/Hide control passed. Second-account check remains
  pending; no linked-employee live result is claimed. No uncaught browser errors.
- Cleaned up only the test-created hosted sessions. Stopped the earlier isolated local QA
  server to prevent using old backend code with newer static assets. No deployment made.
- Refreshed the mobile inventory to 53 named routes and placed the additional implemented
  routes in the existing workflow order. This is planning only; no later feature tested.
- No current application code change made. Current sync-route guard passes; prior full-suite
  totals are archived baseline evidence. User checkpoint remains setup/step 1.
- User later reported missing Profile path at M01 step 6 and provided a desktop rail screenshot.
  Recorded F-003 before changing the checklist. Rechecked mobile Profile/security/sign-out:
  passes after scrolling; ended token rejected (401), test session cleaned up, profile asset
  stable. Updated setup to force mobile and added explicit scrolling to step 6. Request a
  mobile-layout restart without treating earlier unconfirmed steps as passed. Still M01.
- User confirmed the desktop/mobile mix-up and will switch. Current checkpoint: M01 mobile,
  restart step 1. User-reported desktop sign-out kept separate; mobile results still pending.
- User then supplied mobile screenshots and requested a direct Profile footer Sign out and
  form UI correction. F-004/F-005 recorded before changing source. Fetched/fast-forwarded three
  upstream commits to `a115f0d` first; no uncommitted user source changes were present.
- Installed locked dependencies without install scripts; no manifest/lockfile changes.
- Actual-app baseline: 13 failed assertions across the matrix (missing footer and 0px username
  action gap), seven existing checks passed. This represents two findings, not 13 separate defects.
- Profile UI patch: 29 Playwright assertions pass across three widths and both themes, with no
  uncaught browser errors. Includes exact autofill token colors, pending-write cancel protection,
  single-request server logout, borrowed data cleanup and password mismatch without mutation.
- Existing Profile interaction runner passes; four focused Vitest files pass (165 checks);
  typecheck passes. Full suite: **304/304 files, 3,220/3,220 checks passed**, 560.99s.
  Source/UI patch has not been deployed; M01 stays open at step 6, awaiting publication and
  the user's retest. No unrelated feature or desktop testing round started.
- User approved publication and explicitly requested commit/push. Railway MCP reported an expired
  connection; the user saw a reconnect `invalid_request` / invalid `id_token_hint` error. Git
  publication and direct live verification can continue independently of that connector.
- Fetched newer upstream stock commit `8b86ddf`; preserved our changes in a named stash,
  fast-forwarded and reapplied them without conflicts. Upstream uses cache v149; our release
  advances to v150 so the Profile assets cannot remain behind the stock release's cache.

- Publication checks on `8b86ddf` plus Profile patch: typecheck passed, all 29 Playwright cases passed,
  and **3,266/3,266 checks across 305 files passed** (564.40s). Reconnected Railway account
  successfully verified the correct production service and watched source branch; no staged changes.
