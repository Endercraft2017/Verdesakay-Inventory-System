# Payroll paid marking and employee issuance

22 October 2026. Follow-up to [source reconciliation](payroll-reconciliation.md) and
[cutoff recovery](payroll-cutoff-recovery.md). Current-source holds now cover paid marking,
payroll email and employee list/PDF/timekeeping reads. This is not payment verification.

## Findings, severity and resolution

| Severity | Reproduced gap | Resolution |
|---|---|---|
| High | Mark Paid accepted duplicate, unresolved, invalid-cutoff and unreadable source records even while generation/reporting held them. | Shared current-source check inside the paid/history transaction; normal/local conflicts return 409 without status/timestamp/history writes. |
| High | Email accepted drafts and checked only employee ownership. | Paid-only issuance plus the source check before recipient lookup/render/provider invocation. Staff email buttons remain disabled until Paid. |
| High | A previously paid duplicate could still appear in employee JSON and download as a final PDF. | Employee list, PDF and timekeeping reads use the shared source index and eligibility check; held records are withheld and direct reads return the same 404 as missing/foreign records. |
| Medium | An unrelated corrupt payroll JSON object could crash employee reads through SQLite json_extract. | Safely parsed shared index replaces the JSON-extract candidate query. No guessed ownership or corrupt record data is returned. |
| High | New source gates could discard a payment already accepted by the offline authority when cloud history differs. | Preserve the existing D6 site decision, atomically record a source-review clash with the paid/history write, and apply current-source issuance holds on each replica. No cloud-only proof requirement is added to company claims. |

## Eligibility contract

`payroll/payroll-release.ts` consumes one shared `payrollSourceIndex` per operation/read.
It does not create, delete, merge, recalculate or choose a winning payslip.

- The target must be readable, owned by a resolved stable employee and Draft or Paid.
  Existing duplicate, invalid-cutoff and ambiguous-label issues hold.
- For an identified cutoff, the selection's identity/cutoff/status issues hold issuance for
  that cutoff. Invalid/ambiguous records under any known alias are included, so checking only
  the canonical label cannot miss an invalid sibling. Valid stamps still disambiguate reused
  labels. Employee/cutoff duplicates are never selected by newest/first/paid status.
- Present scalar money fields used by the check must be finite numeric primitives/numeric
  strings within safe cent range. Objects, booleans, NaN/Infinity strings and unsafe magnitudes
  are refused. Blank/missing fields retain legacy compatibility. This is shape validation;
  it does not recompute arithmetic, contributions, deductions or balanced payroll totals.
  Other text/rendering fields and saved calculation contents are not comprehensively schema-
  validated by this monetary gate; malformed historical payload correction remains separate.
- A nonblank pay date must be a real YYYY-MM-DD date. This does not establish wage timing,
  accrual-date policy or accounting-period eligibility. Closed-period posting protections stay
  in the accounting workflow; this increment does not add a payment-period policy.
- Email and employee PDF issuance require Paid. Employee previews may still be Draft, provided
  the source has no current hold. Unsupported statuses are withheld.

**Legacy boundary:** an unstamped, uniquely owned record with an unknown/empty cutoff label
can remain eligible if no known issue is found. Imported historical payroll may have no
attendance cutoff at all. The check does not fabricate that link. Duplicate groups with a
nonempty shared legacy label still hold; empty labels cannot establish a duplicate slot.
This compatibility does not certify historical completeness. Unknown linkage, paid/draft
filing eligibility and reconstructed history remain separate work.

For staff, source holds return 409 with bounded numeric IDs and reasons. Unauthenticated and
non-payroll-manager callers retain 401/403. Payroll email's unresolved-owner failure now uses
the same 409 source conflict, replacing its earlier 400. Missing recipients/provider failures
retain their existing errors. The self-service projection retains only its existing top-level
fields: id, number, period, status, data, timestamps, finalization metadata and download URL.
The existing raw payslip data contract is not broadened or comprehensively minimized here.
Employee reads remain private/no-store, scoped to the linked employee in the active tenant.
Held and foreign IDs return the same 404; no staff diagnostics or other employees' IDs are sent.

## Offline authority and atomicity

`mark-paid` remains a payroll-management company claim. Source validation runs within the
existing transaction that writes Paid status and `payslip_paid_history`; the timestamp uses
the sync business clock. A history-write failure rolls the status/timestamp/revision back.
The update also conditions on the status observed at entry. Ordinary concurrent duplicate
submissions result in one successful transition/history row and one Already Paid refusal.

When an authoritative accepted site decision replays on the cloud and current sources now
conflict, the payment decision stands under D6. The same transaction saves a
`site_decision_clashes` source-review record; its response includes `clash` and `release_held`.
The flag is not a durable per-record quarantine column. Eligibility is recomputed from current
replica sources: a replica that has not received a conflict can still show its locally valid
record. Cloud email and synchronized employee reads hold while the source conflict remains.
Already-Paid cloud/site clashes retain their existing behavior. Operational clash resolution
alone does not repair source data or clear an actual duplicate.

The regression checks local duplicate refusal without queueing a command, then a valid offline
paid decision, a newly introduced cloud duplicate, confirmed replay with the paid state kept,
a recorded clash and refused cloud email. These in-process replicas do not establish real
office/device/network acceptance or instant revocation of an already downloaded copy.

## Operator procedure

1. Review payroll calculations, source records and the existing cutoff reconciliation before
   marking Paid. Verify actual settlement through the company's approved process. **Do not mark
   a draft Paid merely to enable email.** A Paid flag is still an operator assertion; this app
   does not link bank settlement/remittance/filing receipts.
2. A 409 source hold requires payroll review of the listed records. Preserve originals and
   restricted evidence. Use the existing identity or consistent-label cutoff recovery only
   when its documented conditions apply. Do not delete or relabel a duplicate to clear a hold.
3. If a site decision was retained with a clash, review the sync clash and the actual source
   records. Do not mark/unmark repeatedly as an attempted reconciliation. A historic payment
   and an inaccurate source require a reviewed adjustment, not erasing the payment.
4. Rerun staff reconciliation/reports and the employee read after a supported correction.
   Validate the intended linked recipient before sending. An employee missing an expected slip
   should contact payroll; absence from the list is not proof the payroll record was deleted.
5. Preserve evidence of previously issued copies and accepted filings. This gate cannot recall
   PDFs/printouts/email already received or establish whether a third party used them.

Staff preview/print and payroll Excel summary paths retain their existing behavior; this
gate does not yet turn those exports into reviewed final issuance. Restrict their use to
approved review while sources are held. Extending final-release controls to those paths
remains engineering work. Already issued copies cannot be recalled by a source check.

The desktop disabled email action communicates the Paid requirement. Source conflicts from
Mark Paid/email open a persistent, escaped, dismissible review dialog rather than a short
toast, so record IDs and preservation instructions remain readable. Backend checks remain
authoritative for direct API calls and stale browser state. Email stays online. Mark Paid has
no new recent-factor or version-bound review; the sensitive-action work remains open.
Email dispatch captures the validated current payload before transport starts; later changes
cannot retract a submitted message. No new durable email intent/outbox, recipient approval,
unknown-send reconciliation or exactly-once provider delivery is implemented. Existing HTTP
receipts remain historical outcomes; after correcting a cached refusal, use a new action key.

## Verification and remaining work

From an installed checkout:

```sh
npm run typecheck
npx vitest run tests/payroll-release.test.ts tests/payslip-disclosure.test.ts tests/me-payslip-pdf.test.ts tests/me.test.ts tests/payroll-permission.test.ts tests/sync-payroll.test.ts tests/hr-workflow.test.ts tests/hr.test.ts tests/payroll-cutoff-recovery.test.ts
npm run test:e2e
npm test -- --fileParallelism --maxWorkers=2
```

See [research](../audits/payroll-release-research.md) and
[verification](../audits/evidence/payroll-release-verification.json). The earlier cutoff-recovery
browser stale-state test now uses a normal financial edit; the newly protected Mark Paid route
correctly refuses its invalid-stamp fixture. Paid-history refusal remains covered at the API.

Tests use synthetic catalogs; the API email transport is mocked and browser cases do not send
mail. No live employee/provider writes or deployment commands were performed. Schema/dependencies
are unchanged and no fresh advisory scan was run. A branch push does not establish deployment. True duplicate disposition, actual cutoff transfers, complete
calculation/filing policy, issued-copy adjustments, recipient/fresh-proof/durable email review,
independent audit protection, settlement evidence, native Windows and hosted/office acceptance
remain in the [handoff](../audits/engineering-handoff.md). Whole-control statuses and release hold
remain unchanged. A local passing suite is not production certification.
