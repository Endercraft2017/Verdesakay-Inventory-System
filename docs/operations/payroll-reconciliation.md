# Payroll source integrity and journal comparison

20 October 2026. Follow-up to [stable employee-ID reporting](payroll-report-identity.md).
This is source-integrity checking and a current payroll-to-journal comparison. It does
not confirm wage settlement, contribution remittance, tax filing or accounting-policy compliance.

## Reproduced gaps and resolution

| Severity | Gap | Resolution |
|---|---|---|
| High | Generation chose the first matching employee payslip; month-to-date deductions chose the newest; reports/journals could sum both. | One shared employee/cutoff index detects duplicate source slots. Generation, rate recomputation, matched monthly history, GL posting and scoped tax/agency/HR reports hold for review. No automatic deletion, newest-record choice or transfer of paid amounts. |
| High | A supplied label could select another cutoff's payroll for a journal. | Stamped cutoff IDs are authoritative. Label matching cannot adopt validly stamped records from another cutoff. A label claiming only another cutoff conflicts. Shared display labels are safe when stamps disambiguate them. |
| High | Re-post reversed the old journal before validating/saving a replacement, and ignored a refused reversal. | Build/validate first, then reverse and insert under one outer savepoint; failure rolls back entries, lines and sequence allocation. Closed original/new/reversal dates and refused reversals stop posting. |
| High | A reversal could itself be selected as the next live source entry. | Live originals exclude reversal rows and require no posted reversal. Multiple live payroll originals or an invalid prior journal require review. |
| Medium | No bounded comparison separated current payroll, journal state and payment evidence. | Read-only payroll/accounting endpoints and an HR dialog show source counts/totals, ledger comparison/holds and the explicit payment-evidence limit. |

## Source identity and holds

`payroll/payroll-source.ts` reads the tenant's payroll records and cutoffs once per
index. A present cutoff stamp must be a positive safe integer or canonical decimal
string referring to an existing cutoff. Invalid stamps do not fall back to labels.
Employee identity uses the existing strict resolver. Ordinary record editing preserves
the exact existing cutoff stamp, including text/invalid representations; it cannot
silently repair a stamp by converting it or add one to an unstamped record.

For legacy unstamped cutoffs, the label must identify one cutoff across attendance
periods and recorded valid stamped payroll aliases. Multiple claimants are ambiguous.
Unknown nonempty legacy labels can identify duplicate slots but cannot establish a
cutoff for posting. Empty labels cannot prove duplication: the same employee may
legitimately have different cutoffs with the same pay date. Missing historical identity
or label evidence is not reconstructed automatically.

A duplicate group is one resolved employee plus one resolved cutoff, or the same
otherwise-unlinked nonempty legacy label. All records in that group are held; differing
pay dates, draft/paid statuses and record order do not select a winner. Reports hold if
any selected record belongs to a duplicate group, including duplicates across pay years.
An invalid cutoff stamp makes an agency month unscopable and blocks conservatively.
Valid stamps now let agency schedules use cutoff end even under custom/reused labels.
This supersedes the earlier blanket duplicate-label limitation for valid stamped records.

Monthly contribution computation also holds unlinked legacy records whose pay date
(created-at fallback) is in that contribution month or cannot be scoped. Such records
must not disappear because a label has no match. This is conservative: a pay month does
not prove an unknown cutoff month; a correctly dated historical record may still need
review. Unknown older/differently paid legacy history is not certified complete.

Generation/GL/rate-change integrity conflicts return 409, with bounded numeric record
IDs and readable reasons. The existing generation `unresolved_record_ids` response is
retained for its ownership failure. A failed rate change rolls back employee/rate history
as well as recalculation. No partial generated payroll is saved. Matched cutoff actions
accept `draft` and `paid`; other source statuses require review. Tax-report filing
eligibility across all historical statuses remains a separate policy gap.

## Posting and comparison

`accounting/payroll-ledger-source.ts` builds one deterministic document for posting and
comparison. Amounts must be finite primitive numbers/numeric strings within safe cent
range; invalid objects/amounts are not replaced with zero. Dates must be real YYYY-MM-DD
dates and agree across the selected run. An empty pay date uses **cutoff end**, replacing
the previous volatile today fallback. Explicit pay dates remain the posting date. Review
the displayed date before posting, particularly across month/year boundaries. Separate
accrual versus payment dates and entity-specific recognition policy still need design.

Re-post validation precedes reversal. The outer `payroll_post` savepoint encloses nested
journal-write and reversal savepoints. A closed new date, closed original date, closed
reversal date, missing/refused reversal, invalid prior journal, multiple live originals
or failed SQL write cannot leave just a reversal or a second live original. The reversal
uses the ISO/UTC date from the sync business clock; company accounting-date policy remains
part of the outstanding date review. Original posted entries remain in history. The existing builder's one-cent balance tolerance
is retained; the comparison matches grouped cent values exactly, without certifying all
rounding/classification policies. The live-source
helper's reversal exclusion and nested savepoint behavior also apply to other auto-post
callers; the full suite covers their existing regressions, not every financial scenario.

An explicit successful re-post still creates a reversal/replacement pair even if totals
are unchanged. This is **not exactly-once HTTP retry handling** or one-use transaction
authorization. The operation keeps its existing company `claim` sync class and payroll
management permission. A dedicated regression posts and re-posts at the offline main host,
then verifies confirmed cloud replay, identical current comparison and exactly three
journal rows (original, reversal, replacement). Existing paid-clash D6 checks also run. Cloud-only factor checks were not added to accepted offline claims.

Endpoints:

- `GET /api/hr/periods/:id/payroll-reconciliation`: `payroll.view`.
- `GET /api/accounting/payroll-reconciliation/:periodId`: `accounting.view`, without
  general HR access. Optional `payroll_period` diagnoses the selected label; it does not
  authorize another cutoff's sources.

Both return a read-only database snapshot with private no-store responses. They expose
cutoff metadata, counts, bounded issue IDs, aggregate source/journal totals and at most
20 live journal identifiers. No employee object, names, government identifiers, rates,
photos or raw payslip JSON is returned. Error diagnostics remain bounded.

| Ledger state | Meaning |
|---|---|
| `blocked` | Selected source records need review; source money is unavailable, not zero. |
| `empty` / `ledger_off` | No source records / ledger disabled; not an assertion of reconciliation. |
| `missing` | Valid current sources have no live original payroll journal. |
| `unpostable` | Existing payroll formula/rule configuration cannot build a balanced entry. |
| `multiple_live_journals` / `invalid_journal` | Preserve the prior records and require accountant review. Invalid actual totals are unavailable. |
| `matches` / `differs` | Current posting date, book and grouped account/debit/credit/party allocations match or differ. Aggregate money is compared in cents. |

The HR cutoff's **Cutoff tools → Reconcile payroll** dialog shows these states, marked-paid
counts, posting date and totals. Refresh is read-only. Failed loads remain visible and
can be retried; late results after a label/context/session change or dismissal are ignored.
An explicit **Post to GL** remains a separate write. A comparison is informational and
does not bind a later posting to a reviewed source version.

`payment_verification: "not_linked"` is intentional. The current app has no payroll-specific
bank settlement or statutory filing receipt link. Marked Paid is an operator decision.
Journal payables are not proof of payment. A matched aggregate can also hide offsetting
per-employee mistakes; it is not a historical source snapshot or a calculation certification.

## Operator procedure and remaining work

1. Open the comparison before issuing/filing/re-posting. Review the posting date, source
   counts, draft/marked-paid split, journal identifiers and any hold. Never delete a record
   or change money merely to clear a hold.
2. Preserve a restricted case and original evidence. Use the existing
   [identity-only review](payroll-identity-repair.md) for ordinary unresolved employee
   identity. Duplicate disposition, malformed data, resolved-owner transfers and cutoff
   reconstruction require a separately reviewed workflow; this increment supplies no
   automatic merge, paid-record rewrite or closed-period override.
3. Have the responsible accountant determine corrections and period treatment. Re-post only
   an eligible open run after review; retain original/reversal/replacement references.
4. Verify bank/payment evidence, agency remittances and accepted filings separately.
   Preserve their receipts and assess corrections/recipient notification before reissuing.

Remaining engineering includes reviewed duplicate/cutoff reconstruction, release/email and
existing-issued-copy handling, paid/draft/void filing eligibility, explicit accrual/payment
date policy, prior-source snapshots, reviewed version-bound/retry-safe posting, payroll
settlement/remittance/filing evidence models and full historical reconciliation. Current
comparison reads scan tenant payroll history; large-dataset capacity is not established.
Offline comparisons use the local replica and do not prove cloud synchronization. Real
restore/office/device/provider acceptance and the wider scorecard remain open.

No live employee, bank or provider was changed. Release hold and whole-control counts remain.
See [research](../audits/payroll-reconcile-research.md) and
[verification](../audits/evidence/payroll-reconcile-verification.json).


## Reproducing the process-interruption evidence

From an installed repository checkout on Linux/WSL, copy the archived fault helper to
`work/`, then run the archived driver from the repository root:

```sh
mkdir -p work
cp docs/audits/evidence/payroll-reconcile-crash-child.ts work/payroll-reconcile-crash-child.ts
python3 docs/audits/evidence/payroll-reconcile-startup-smoke.py
```

The driver starts the actual server against new temporary synthetic catalogs, kills only
its disposable posting child, restarts the server, verifies rollback/re-post/holds and
removes the temporary data. The child refuses non-test catalogs. This POSIX process-kill
proof does not substitute for supported Windows/Electron/device or storage power-loss testing.


## Consistent-label cutoff recovery follow-up — 20 October 2026

A [reviewed ID recovery](payroll-cutoff-recovery.md) now handles a limited subset of missing/
invalid cutoff stamps: consistent unique existing labels, draft/never-paid sources and no
journal/closed-period/known-mail history. Only the stamp changes, with mandatory revision
history and fresh online review. This narrows the earlier blanket reconstruction gap.
Actual transfers, duplicate disposition, malformed/unknown history, released/posted adjustments
and settlement/remittance/filing acceptance remain. No source totals or release status are
certified by recovering an ID.
