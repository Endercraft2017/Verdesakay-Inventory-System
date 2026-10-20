# Payroll report identity and blocking conditions

20 October 2026. This contract closes name-based statutory attribution after the
[reviewed identity repair](payroll-identity-repair.md). It does not establish that
all payroll amounts, tax classifications, bank payments or filed returns reconcile.

Follow-up: [source/journal integrity](payroll-reconciliation.md) now holds duplicate slots
across reports, generation, monthly history and GL. Valid cutoff stamps disambiguate agency
scope under reused labels. Current payroll-to-journal comparison is implemented; reviewed
reconstruction and bank/remittance/filing evidence remain separate.

## Behavior

The shared report reader groups by stable `employees.id`, using the strict
`payslipOwnerResolver.idOf` contract. Names are display values. A present employee
stamp must be valid and refer to an existing employee; it cannot fall back to a
name. A legacy missing/null stamp resolves only when its current/former name has
exactly one claimant. Two employees with the same name remain two people, with
their own TIN, agency identifiers, contribution settings and tax brackets.

| Report | Identity and scope |
|---|---|
| BIR 2316 list/detail, Alphalist, 1604-C | Employee ID; calendar pay year. Detail reads its ID, not its name. |
| BIR 1601-C | Distinct employee IDs per pay month; existing withholding arithmetic retained. |
| SSS / PhilHealth / Pag-IBIG schedule and CSV | Employee ID; cutoff end month, falling back to pay date when no cutoff matches. Fund opt-outs and identifiers come from that ID. |
| HR 13th month / final pay | Employee ID; calendar pay year, with the final-pay year derived from separation date as before. |

The 2316 list/CSV includes employee number alongside name. The HR 13th-month
list/CSV includes employee ID. Agency and Alphalist exports keep their existing
layouts; internal database IDs are not inserted into official-layout columns.
Current identity/agency settings are used, as before; historical government-ID and
opt-out snapshots are not introduced here. Existing draft/paid inclusion, formulas,
date fallback and manual query adjustments are not changed into a filing approval.

## Report blocking

All affected endpoints return HTTP **409**, JSON with an explanatory error and
request ID, and the existing private `no-store` cache policy, when a relevant
payslip cannot be assigned safely, its legacy name is not a string, or its cutoff
label is ambiguous. There are no partial rows, amounts or downloadable
CSV in that response. It reports the total blocker count and at most ten numeric
record IDs; it does not echo names, amounts, government IDs or raw payroll JSON.
Permissions are checked before the report reader runs.

- An unresolved record in a known different pay year/month does not block the
  requested scope. Agency scope follows cutoff end, independently of annual pay date.
- Invalid JSON, non-object payroll data or a date whose scope cannot be established
  blocks conservatively, including otherwise unrelated requested periods. It cannot
  be assumed to belong outside the requested scope. Date checking establishes a
  year/month prefix; it is not complete historical calendar/data validation.
- Duplicate attendance-period labels are not unique keys. Contribution reads process
  each form record once and block any possible month of a referenced duplicate label,
  even if both cutoff ends match. Other known months stay usable. Annual pay-year
  reports do not join attendance periods and are not multiplied by duplicate labels.
- An employee-specific 2316/final-pay request also blocks if that year's unresolved
  data could belong to that employee. Missing employees still return 404.
- These are read-only checks: no history, status, money, identity or mail is changed.

Accounting report dialogs display the actual failure and disable CSV while loading
or blocked. They clear the previous result immediately, ignore older request responses
and reject results after actor/session/company changes or dialog dismissal. HR's
13th-month dialog does the same using its existing error/retry display. Certificate
printing re-fetches detail and checks the selected report/context before opening its
preview. Previously downloaded or printed copies cannot be recalled by this code.

## Operator response

1. Stop issuing or filing the affected report. Preserve existing records and record
   the request/record IDs in a restricted support case. Do not delete a blocker or
   alter money merely to make an export succeed.
2. A payroll manager opens Payroll Records and uses **Review owner** for an ordinary
   valid-object unresolved slip with readable string identity fields. Non-string or
   otherwise malformed fields belong in step 3. Verify original employment evidence and the linked destination
   account, then follow the [fresh-proof review/confirmation procedure](payroll-identity-repair.md).
   It changes only the employee stamp and retains mandatory revision history.
3. Malformed data, incorrect existing stamps and ambiguous cutoff labels need a
   separately reviewed reconstruction/cutoff correction. This increment does not
   supply a paid-record rewrite or an arbitrary owner-transfer bypass. Preserve a
   backup and evidence; escalate the engineering case rather than editing SQLite.
4. Retry the report. Compare both employees' amounts, TIN/agency identifiers and
   payroll source totals. Reconcile to the ledger, payments and submitted returns;
   assess correction/recipient notification with the responsible accountant/privacy
   contact before reissuing. A successful HTTP response is not evidence of filing.

No live records were repaired or reports submitted for this increment. A solo operator
can use the existing reviewed repair; an independent review remains an organizational
safeguard. Local/offline reads still use their local data, without proving that all
cloud records have synchronized. No mutation sync classes or schema were changed.

## Remaining engineering and acceptance

Duplicate payslip source slots now hold rather than aggregate; reviewed disposition remains.
High-priority reconciliation still includes cancelled/draft/paid filing eligibility,
historical source snapshots, payment/filing linkage and reviewed correction history.
The current source-to-journal comparison is documented in the follow-up above.
An identity stamp does not establish that the amounts or legal treatment are correct.
Missing/invalid TINs, agency identifiers and classifications are not a complete filing
validation; the portal/accountant must still validate the official submission.
Historical effective settings, full period/date validation and a reviewed reconstruction
workflow remain. Broader export freshness, retention, legal holds, rights/recipient
procedures, independent audit protection, native/device and real restore/office-sync
acceptance remain in the handoff. Release hold and whole-control counts are unchanged.

See [research and decisions](../audits/payroll-reports-research.md) and
[verification manifest](../audits/evidence/payroll-reports-verification.json).
