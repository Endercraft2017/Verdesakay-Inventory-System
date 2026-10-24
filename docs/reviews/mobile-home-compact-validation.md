# Approved compact Home pending-work preview

2026-10-25, Asia/Manila. Implements the approved MagicPath component
`464796866123558912`, revision `464802428995375104`, within the existing Home
preview. The concept's surrounding Home excerpt and sample-completion controls
are not production features.

## Final behavior

- Verified clear queues share one native disclosure with direct links to their
  existing queues. Only the employee's authorized desks are included.
- All-clear requires every authorized read to succeed and no pending work or RTS
  holds. Loading, malformed, failed or timed-out responses cannot count as clear.
- Work and holds stay visible, ordered by the oldest outstanding workflow date.
  Each category shows one oldest-record preview while counts cover all records.
  Existing complete-queue links expose the rest; the details/actions remain guarded.
- New or changed work opens its category. Unchanged refreshes retain a manual
  collapse. Completion moves a clear category into the shared menu; new work
  moves it out again. Focus is kept visible through loading and regrouping.
- The full count still distinguishes jobs, requests, units, batches and remaining
  pieces. Blocked inspections and RTS holds remain visible even when another
  record is the oldest preview. Preview reads never move stock.
- Existing refresh, independent bounded reads, late-response guards and 30-second
  polling remain. The earlier v149 timestamp addition to the RTS batch response
  is additive and reads the batch's stored creation date, without schema changes.

## Verification and evidence

```sh
HOME_PREVIEW_LAYOUT=1 HOME_AUDIT_OUTPUT=work/home-compact/verified node scripts/test-mobile-home-audit.mjs
HOME_AUDIT_OUTPUT=work/home-compact/regression-final node scripts/test-mobile-home-audit.mjs
WAREHOUSE_UX_TASKS=1 WAREHOUSE_UX_OUTPUT=work/home-compact/warehouse-tasks node scripts/test-warehouse-ux.mjs
npx vitest run tests/frontend-mobile.test.ts tests/rts.test.ts tests/access-matrix.test.ts tests/frontend-mobile-work-navigation-ux.test.ts
npm run typecheck
```

Before upstream integration, all 11 compact cases, 14 existing Home cases,
7 complete warehouse tasks and 183 focused regressions pass. The cases use
disposable local Express/SQLite fixtures and separate employee browser contexts.
They verify oldest-first order, complete counts with one preview, unchanged and
changed refreshes, other-employee completion, partial/full receipts, held-only RTS,
direct clear-queue links, late/failed reads, no false all-clear, new work arriving
while clear, and permission revocation while the clear menu is open.

`work/home-compact/verified/report.json` records source hashes and database
oracles; case traces, screenshots and sanitized network JSON are alongside it.
Opening an archive with `npx playwright show-trace <case.zip>` shows the browser
and network sequence. Existing tests now use the full queue when deliberately
selecting a record beyond Home's single preview. The default fixture separates
serial and batch ages rather than assuming an order when SQLite timestamps tie
to the second. Hidden clear-menu counts are checked as text content; actual menu
visibility and navigation are tested separately.

The all-empty visual fixture mocks queue reads. Real empty behavior is also
verified after completing a disposable parts request. At 390px, the real component
measures **142 CSS px** with clear queues collapsed, versus **421px** in the prior
iteration (about **66% less height**). Expanding its six queue links measures 430px.
This is component-height evidence, not a human task-time result. Both themes pass
targeted contrast, button-name, ARIA-value and summary-name checks. 375px/390px
portrait, 844px landscape, keyboard and reduced-motion toggling were checked.

Four browser-only faults independently fail their targeted assertion; source
files on disk remain unchanged:

```sh
HOME_PREVIEW_LAYOUT=1 HOME_AUDIT_ONLY='All-clear waits' HOME_AUDIT_MUTATION=false-all-clear HOME_AUDIT_OUTPUT=work/home-compact/mutations/false-clear node scripts/test-mobile-home-audit.mjs
HOME_PREVIEW_LAYOUT=1 HOME_AUDIT_ONLY='One compact all-clear' HOME_AUDIT_MUTATION=keep-empty-expanded HOME_AUDIT_OUTPUT=work/home-compact/mutations/expanded-clear node scripts/test-mobile-home-audit.mjs
HOME_PREVIEW_LAYOUT=1 HOME_AUDIT_ONLY='Active categories' HOME_AUDIT_MUTATION=home-newest-first HOME_AUDIT_OUTPUT=work/home-compact/mutations/newest-first node scripts/test-mobile-home-audit.mjs
HOME_PREVIEW_LAYOUT=1 HOME_AUDIT_ONLY='Active categories' HOME_AUDIT_MUTATION=home-many-previews HOME_AUDIT_OUTPUT=work/home-compact/mutations/many-previews node scripts/test-mobile-home-audit.mjs
```

These commands intentionally exit with a failed assertion. Their reports confirm
the mutation was applied and there was no unrelated fatal error. Normal sources pass.

## Integration and limits

Merged upstream through `292049f`, preserving its seven newer commits for stock
screens, personal shortcuts and recovery. The only conflict was the cache version;
the combined shell uses v155 above upstream v154 and retains the full upstream
asset list. Shared styles merged without losing either change.

The actual merged tree passes all **11 compact cases, 14 Home regression cases,
7 complete warehouse tasks and 253 focused tests**, plus TypeScript. The focused
run adds shortcut and service-worker regressions to cover the upstream integration.
Reproduction commands above remain valid; merged evidence is under
`work/home-compact/merged-layout/`, `merged-regression/`, and `merged-tasks/`.
Logs are `work/home-compact-merged-unit.log` and
`work/home-compact-merged-typecheck.log`. Both Home reports' source hashes were
compared with the final production files and match. The merged layout still
measures 142px in its all-empty presentation fixture.

This is browser simulation against disposable local data. No physical phone,
screen reader, printer or representative employee usability session was available.
Passing targeted accessibility checks does not establish whole-app conformance.
The MagicPath concept remains a design example, not evidence of live workflow
completion. A Git push does not itself prove that a deployed phone has refreshed
its installed cache.
