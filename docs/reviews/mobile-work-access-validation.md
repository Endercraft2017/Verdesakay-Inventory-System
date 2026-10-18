# Mobile Work custom-access check — 18 October 2026

## Findings and candidate fix

- Work previously rendered only the first four authorized queues by default. A
  clerk with additional inventory permissions could lose the parts/RTS entries
  behind an All role queues link below personal tools.
- Read-only inventory access had no stock-search entry on Work; stock adjustment,
  transfer and other existing inventory tools also lacked direct Work links.
- Permission refresh ran on focus/foreground/reconnect, but not Work entry.
- Broad warehouse stock adjustment could use releasing APIs but its Work release
  tile still required the narrower `orders.release` permission.

The local fix exposes every authorized queue and a separate Inventory tools list,
refreshes effective access on Work entry, and filters inventory-detail mutation
buttons by their route permissions. Existing primitives/Figma Work frame 46:548
are reused. No backend grant or role is expanded. Cache version is v111.

## Validation

134 mobile frontend tests and TypeScript checking passed. Five real-backend
Playwright checks passed using the actual desktop Access for this person drawer:

1. A custom clerk role starts with only `production.repairs` plus baseline access.
2. Per-person RTS/releasing/inventory grants appear without changing the role or
   dispatching a focus event; the phone is 390×844 and has no horizontal overflow.
3. The Work entries open the actual parts, RTS and releasing desks, with HTTP 200
   queue responses and rendered desk pages.
4. Removing stock adjustment/RTS/releasing grants hides them and a stock write
   receives HTTP 403; retained clerk and read-only inventory access remain visible.
5. Removing the remaining operational grants leaves only personal employee tools.

The full regression ran 2,860 tests across 283 files: 2,858 passed and two failed.
Both were corrected in test code: the personal-tools app mock lacked the newly
exposed `refreshAccess` method, and the scheduling fixture's generated date fell
on a rest day/holiday. The fixture now explicitly publishes a working day; no
HR production policy was changed. The affected scheduling, personal-tools and
mobile frontend files then passed **146 tests across three files**. The full
suite was not repeated after those test-only corrections. Type checking and
JavaScript syntax/whitespace checks passed. No real stock,
orders, employees or existing accounts were modified by the disposable test.

## Actual sandbox verification

The sandbox administrator explicitly supplied the sandbox test login and authorized
this test. Playwright opened `https://otom.afkcube.com/sandbox/` and used the real
desktop Edit account → Access for this person drawer over its parent edit modal.
No API responses were mocked and no existing employee or role was changed.

The deployed mobile build reproduced the reported problem: the desktop saved
custom grants, but RTS recording did not appear in Work. The candidate browser
then uncovered another cause of confusing screens: a delayed `/me/today` response
could overwrite Work with Home contents after navigation, while the header/dock
still indicated Work. Home success and error callbacks now check their generation,
route and account before painting. Tapping the already-selected Work tab also
refreshes effective access.

With local mobile candidate assets loaded only in the test browser against the
actual sandbox backend, **all five checks passed with zero browser exceptions**.
The clerk's role stayed unchanged throughout; only per-person overrides changed.
The grants included parts requests, RTS recording, releasing, inventory viewing
and stock adjustment. Repeating the Home/Work/desk navigation no longer replaced
Work with stale Home content. This test is candidate acceptance, not proof that
the fixed assets have been deployed to the sandbox.

Audit-only sandbox accounts 7–12 were cleared of custom overrides and disabled,
including accounts from corrected/failed audit attempts. Their uniquely named
custom role records remain for audit history; existing company records were not
modified. No stock, orders, attendance or payroll were changed. The final passing
candidate run used account 12. Screenshots and the machine-readable report remain
under `work/mobile-work-access-audit/sandbox-candidate/` (ignored test artifacts).

The reusable audit command supports explicit sandbox mode with
`MOBILE_WORK_TEST_BASE` and either `MOBILE_WORK_TEST_TOKEN_FILE` or the test
username/password environment variables. Optional `MOBILE_WORK_CANDIDATE=1`
serves local mobile assets to that browser against the actual sandbox API;
it does not deploy those assets or mock API responses. Credentials are never
written into the script or this report.

## Shared-branch integration

The full regression above used baseline `26a54ff` plus the mobile candidate.
Before publishing, the incoming stock-count review update `b50236b` was retained.
Its affected stock-count/release files passed 27 tests and final type checking
passed. No new full-suite pass is claimed after that integration.
