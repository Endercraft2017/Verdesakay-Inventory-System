# Compact Work implementation — 2026-10-25

Implements the approved MagicPath **Work · interactive Before & After** design in
the existing mobile Work route. Integration base: `5a4a990`; PWA cache: **v157**.
No production/sandbox operational records were changed by these checks.

## Result and boundaries

Work has a slim role context and oldest-first live categories with two previews
and full queue counts. Successfully checked empty desks share a native
**Other queues** disclosure. **Updates** is a separate, collapsed ledger grouped
by record identity, with three initial groups and an explicit expansion for the
remaining loaded groups. Repeated titles alone never merge notices. Live cards
show matching unread-event badges. **All queues & tools** preserves every prior
authorized operation, report/create entry, stock tool, and personal tool. Sales
follow-up remains available as tracking inside that directory.

Blocked inspections, RTS holds, unknown/stale queues and saved release/handoff
attempts remain visible. Existing counts that include saved approvals, holds or
RTS entries retain their original semantics; an extra review entry stays visible
when those counts exceed the live queue. Opening a record still checks the current
queue, and opening its workflow rechecks access and membership. Existing
workflow confirmations, physical identity/sticker checks and stock writes remain
in their original screens. Refresh/polling remains single-flight and scoped to
the visible route and signed-in employee.

## Defects demonstrated and fixed

- The release queue omitted its stored creation/update timestamps. Browser
  ordering initially put old release orders behind dated kit work. The response
  now includes those dates; database-derived dates and ordering are asserted.
- Filtering unread notices after fetching the latest 50 history rows hid an
  older unread notice. Work now requests unread rows before applying its bounded
  200-row window. Truncation is explicit; reading these notices makes room for
  older unread rows. This is not an assertion that the full history was fetched.
- Playwright then reproduced a broken destination for that older informational
  notice: Notifications could not find it in its recent-history window. The
  detail screen now fetches the exact caller-owned notice independently of the
  window. The same reproduction passes after the fix. Another employee's ID
  returns 404, and reads do not mark notices read.
- Failed queue counts cannot produce a stale positive review badge. They remain
  unknown. Saved recovery controls retain keyboard focus through refresh.
- Expanding a disclosure or refreshing does not mark anything read. Explicitly
  opening an update marks only that record's grouped notices; a failed read save
  retains unread state and offers the existing open-without-marking-read pattern.

## Executed verification

**13 Work Playwright scenarios** passed against disposable Express/SQLite records
in separate Chromium employee contexts, with network evidence and traces:

1. Empty administrator, mixed clerk, QC-only and basic-employee views.
2. Two oldest previews, full API/database counts and collapsed sales tracking.
3. Identity-based grouping, repeated titles and no read on disclosure toggling.
4. Update → current checked detail → exact existing releasing workflow.
5. Another employee completes the oldest order; refresh advances kit work.
6. Failed refresh retains stale-labelled records; 403 removes their content.
7. Older unread notice discovery and its exact history destination.
8. Independent QC/QA counts, visible parts blocker and exact unit action link.
9. Partial/full batch receipt, exact remaining-piece wording and visible RTS hold.
10. Effective custom permissions, isolated sessions and revoked duty removal.
11. Delayed response after leaving Work; return reloads current queues.
12. Saved original handoff remains discoverable after its sale leaves the queue.
13. Native keyboard disclosures, both themes, 320/390/768px layout, and targeted
    axe WCAG A/AA checks (zero detected violations in the tested Work states).

No JavaScript page errors were recorded. Preview/read/navigation cases assert
unchanged stock. The batch-receipt case intentionally posts two authorized
fixture receipts and verifies the exact corresponding stock increases.

The common Home helpers also passed **11 compact Home Playwright regressions**.
The existing notification browser fault/retry suite passed. TypeScript passed.
Six focused Vitest suites passed, totaling **218 tests** with the added Work
regressions; the changed Work suite was rerun after its final focus regression.

At 390×844, the empty administrator document measures **844px after versus
4,574px before** (`8c4d506`, identical empty employee fixture). Before had fourteen
empty attention sections plus expanded directories; after fits its clear message
and collapsed disclosures in the viewport. This measures layout, not demonstrated
human task success. An available update takes **two navigation taps** to its
existing workflow, plus **one disclosure expansion** when Updates is closed;
the former notice route took four navigation taps. A live card retains its
existing two navigation taps. Opening an existing clear desk adds one disclosure
tap, an intentional tradeoff for a shorter idle screen.

## Reproduce and inspect

```sh
WORK_LAYOUT_BASELINE=1 node scripts/test-mobile-work-layout.mjs
node scripts/test-mobile-work-layout.mjs
HOME_PREVIEW_LAYOUT=1 HOME_AUDIT_OUTPUT=work/work-layout/home-regression \
  CHROMIUM_PATH=/usr/bin/chromium node scripts/test-mobile-home-audit.mjs
CHROMIUM_PATH=/usr/bin/chromium node scripts/test-mobile-notification-ux.mjs
npm run typecheck
npx vitest run tests/frontend-mobile-work-navigation-ux.test.ts \
  tests/frontend-mobile.test.ts tests/notifications.test.ts \
  tests/release-slips.test.ts tests/frontend-mobile-item-setup.test.ts \
  tests/mobile-item-setup.test.ts
```

The new Work harness launches its own throwaway backend and deletes its database
at shutdown. It uses `/usr/bin/chromium`. Reports, screenshots, source hashes,
network responses and traces are in ignored `work/work-layout/{before,after}/`.
The deliberately failing older-notice run is retained locally as
`work/work-layout/older-notice-before-fix.json`. Use
`npx playwright show-trace work/work-layout/after/07-0.zip` for the fixed case.

These are local Chromium browser checks, including mobile viewport/touch
simulation. No physical phone, screen-reader session, printer, other browser,
representative employee usability session or deployed-site acceptance is claimed.
