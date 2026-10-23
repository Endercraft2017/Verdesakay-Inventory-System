# Mobile Work navigation recovery

Chunk 22 covers four existing surfaces: Work hub, Attention item detail, Work Guide,
and staff directory. The context card, queue rows, role detail frame, workflow
explanations, department groups, header and bottom navigation remain in place.

## Reads and navigation

`mobile/lib/read-scope.js` binds bounded reads, timers and controls to a visible
view, hash, server and sign-in, including the account's permissions/modules. The
existing API lifecycle guard checks this ownership before interpreting a late 401.
Leaving or changing account aborts owned reads, cancels polling and clears the old
view. Returning from the browser's back-forward cache rebuilds the screen.

Work resolves each attention queue independently. A refresh shares each raw API
response between records and badges, while preserving the badge's own existing
selector and saved-local-work semantics. Refresh is single-flight; all reads and
local draft count checks are bounded to 12 seconds. The existing 30-second polling
cadence resumes after a settled refresh and stops on departure.

Ordinary refresh failures retain last-loaded records with a stale label. Unverified
counts say Unknown; malformed successful responses never produce Clear. Permission
refusals clear affected cached records. Personal-only users retain direct access to
their own tasks and their task-specific Guide explanations, without duplicate rows.

Attention details show when the record has finished checking. Open shares one fresh
access/status verification; the button says Checking access while pending. Failures
keep the known identity with inline Retry. Fresh moved or unauthorized results remove
the Open action. Existing source selectors, exact record links, permission checks,
stock rules and backend actions remain authoritative.

The shared access refresh now joins concurrent checks for the same sign-in, uses
bounded API lifecycle guards, and lets Work require a successful fresh check before
opening its workflow. Ordinary background failures still retain the scoped offline
profile. No backend permission or workflow rules changed.

## Guide and directory

The Work Guide remains read-only and modeless, with its existing explanations,
Jump picker, minimize, Back/Skip/Next and Escape behavior. It closes when its owner
is hidden, replaced or signed out. Detached coach controls cannot affect a newer
coach. Its long instructions support keyboard scrolling; touch targets and dark
primary-button contrast are improved.

Directory excludes self and inactive accounts from management-capable payloads;
ordinary staff payloads that omit `active` remain supported. Department grouping
is retained. Refresh/Retry preserves the search and last-loaded colleagues on
ordinary failures, while authorization loss clears private records. Counts and Clear
help distinguish an empty directory from a search with no matches. Repeated person
taps open one existing conversation; they never send a message.

The mobile service-worker cache is v145 and includes the new read helper.

## Verification

Focused source regressions cover shared queue reads, independent resolution,
timeouts, retained results, invalid responses, local draft counts, exact workflow
navigation, strict access checks, cross-account 401 suppression, personal tasks,
directory recovery and guide ownership. Existing mobile and desktop Guide runtime
checks remain applicable.

Actual-source Chromium passed 54 checks and 12 targeted axe scans without violations:
all four surfaces in light/dark themes, failure states, five viewport widths, long
names/metadata and a short-screen Guide. A disposable server browser run passed four
account/permission checks and explained all 42 displayed admin entries without
JavaScript errors. Source-only checks used fictional data; the server run created
only disposable fixture accounts. No live business records or messages were changed.

Final verification: `npm run check` passed TypeScript and all 3,163 tests across
301 files. The final focused run passed 200 tests across four files, including the
new navigation regressions, mobile bootstrap/personal behavior and Guide runtime.
