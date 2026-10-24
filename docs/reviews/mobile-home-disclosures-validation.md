# Home pending-work space and age ordering

2026-10-25, Asia/Manila. Scope: the existing Home preview for kit release, parts,
QC, QA, QA holds and RTS. No additional workflow or redesigned Home sections.
Historical local iteration v149. The approved compact implementation supersedes
this presentation; see `mobile-home-compact-validation.md` for the current result.

## Behavior

- Each category uses native `details`/`summary`, with a visible count and chevron.
  Empty queues collapse to one row; pending records and RTS holds open automatically.
- Manual collapse remains during unchanged refreshes. A changed membership,
  status, quantity, blocker or workflow update reopens the category. Completing
  the last record collapses the now-empty category.
- Known pending categories sort by their oldest outstanding record. Each category's
  two preview records also sort oldest first. Ties retain stable source/record order.
- Failed queues say Unknown and open an explanation; they sort after known work
  and before unchecked/empty queues. Missing ages are explicitly labelled and
  sort after dated work, without guessing a date.
- Existing Refresh, 30-second polling and return-to-Home reads recalculate order.
  Asynchronous responses remain independent and cannot replace newer reads.
  Manual focus stays with the same summary when categories move.
- Detail/action destinations, permissions, count nouns, batch-piece quantities
  and backend action checks remain unchanged. Preview reads never post stock.

Age comes from raw workflow fields, interpreted as UTC when the server supplies
a zone-less SQLite timestamp:

| Category | Age used |
| --- | --- |
| Kit release | Approval date, then job creation/modification fallback |
| Parts request | Request creation, then modification fallback |
| QC / QA | Latest failure date for rework; otherwise unit creation, then modification fallback |
| QA hold | Hold date |
| RTS serial | Open mismatch hold date or final pass date, then available record-date fallback |
| RTS batch | Batch creation |

`GET /api/rts/queue` now exposes the existing `production_batches.created_at`.
No schema, stock rule or access grant was added. Home's age ordering does not
replace operational priority sorting on inspection/action screens.

## Evidence and reproduction

```sh
HOME_PREVIEW_LAYOUT=1 HOME_AUDIT_OUTPUT=work/home-disclosures/accepted node scripts/test-mobile-home-audit.mjs
HOME_AUDIT_OUTPUT=work/home-disclosures/regression node scripts/test-mobile-home-audit.mjs
npx vitest run tests/frontend-mobile.test.ts tests/rts.test.ts \
  tests/access-matrix.test.ts tests/frontend-mobile-work-navigation-ux.test.ts
npm run typecheck
```

The eight new scenarios use disposable real jobs, inspections, repair requests,
receipts and separate employee sessions. Fixture dates deliberately disagree with
modification dates. SQLite expectations, API fields and browser ordering agree.
They cover native keyboard toggling, unchanged/changed refreshes, completion by
another employee, automatic polling, focus retention, partial/full batch receipt,
RTS holds, failed/delayed queues, missing dates and return-to-Home ordering. The
existing 14 Home cases pass, including exact links, permission revocation, stale
responses and no stock writes. Focused tests pass 183 assertions/tests; TypeScript
passes.

The all-empty visual fixture mocks only queue reads. A separate real completed
parts request verifies actual empty behavior. At 390px, its six collapsed
categories use **421 CSS px** compared with **949.75 CSS px** with the same
categories expanded (about **56% less height**). This compares disclosure states
in the new layout, not task speed or an old-source usability benchmark.
Both themes pass targeted contrast, button-name, ARIA-value and summary-name
checks within the preview. 375px and 390px portrait, 844px landscape and reduced
motion toggling are checked. This does not establish whole-app WCAG conformance.

`work/home-disclosures/accepted/report.json` records source hashes, raw database
oracles and before/after snapshots. Case traces, screenshots and sanitized network
JSON are saved alongside it. `compact-empty-light.png` and
`compact-empty-dark.png` are presentation fixtures; `oldest-first-active.png` and
`oldest-completed-next-first.png` use actual workflow records.
Open an archive with `npx playwright show-trace <case.zip>`.

Two browser-only injected defects independently challenge the regressions:

```sh
HOME_PREVIEW_LAYOUT=1 HOME_AUDIT_ONLY='Active categories' HOME_AUDIT_MUTATION=home-newest-first HOME_AUDIT_OUTPUT=work/home-disclosures/mutations/newest-first node scripts/test-mobile-home-audit.mjs
HOME_PREVIEW_LAYOUT=1 HOME_AUDIT_ONLY='Empty categories' HOME_AUDIT_MUTATION=keep-empty-expanded HOME_AUDIT_OUTPUT=work/home-disclosures/mutations/expanded-empty node scripts/test-mobile-home-audit.mjs
```

Both commands intentionally fail their relevant assertion; the report confirms
the fault was applied. Production source files remain unchanged. Normal sources
pass. The first draft of the automatic-poll test installed its clock after Home
had created timers; it observed the old view without a new queue request. The
fixture now installs the clock before reloading Home, waits for the completed
request count, and verifies the actual poll response and order.

## Limits

These are Chromium browser simulations against a local disposable backend.
No physical phone, screen reader or employee usability session was available.
Native disclosure behavior on a physical iPhone/Android phone and comprehension
of the age labels remain to be verified. Work completed elsewhere appears after
the next poll or manual refresh, not through a new real-time subscription. Manual
collapse preferences apply to the current Home visit; a new visit uses current
work to choose the defaults. No notification policy, hardware integration or
unrelated Home section was changed.
