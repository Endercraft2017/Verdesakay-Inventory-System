# Reviewed recovery of a missing payroll cutoff ID

20 October 2026. Follow-up to [source integrity and journal comparison](payroll-reconciliation.md).
This narrowly recovers an ID from consistent existing labels. Actual transfers between cutoffs,
duplicate disposition, paid/posted adjustments and unknown historical reconstruction remain open.

## Gaps, severity and resolution

| Severity | Gap | Delivered resolution / remaining boundary |
|---|---|---|
| High | An invalid cutoff stamp blocks generation/reporting, and ordinary editing deliberately preserves it. | Payroll managers can review a missing/invalid stamp online, verify original records, supply a case reference and confirm the server-selected cutoff. |
| High | Choosing another cutoff could attach old money/calculation history to different attendance. | Only the uniquely identified existing label destination is eligible. Valid stamps cannot be transferred. Conflicting current/calculation labels and known conflicting historical stamps/labels require separate review. All financial fields and snapshots are preserved. |
| High | Review could become stale or be reused for another operator/company/record. | Five-minute encrypted intent binds purpose, tenant, actor, session, credential state, record, destination and a fingerprint of all current tenant payroll rows/cutoffs plus bounded employee identity. Confirmation checks freshness, state and eligibility again inside the correction savepoint. |
| High | Recovery could change released or booked history or suppress a duplicate. | Draft-only; paid markers, paid history/revisions, duplicate/unresolved destination sources, any journal history and closed cutoff/pay dates hold. No winning duplicate is selected. |
| Medium | An emailed draft might already have left the app. | Matching legacy mail subjects of any outcome hold conservatively. The operator must check other issued copies/filings. Legacy mail has no record foreign key; printed/downloaded drafts and external filings cannot be established by this check. |

## Eligibility

All of the following must hold at review and confirmation:

- The record is a readable `hr_payroll` JSON object, currently Draft, with resolved employee
  ownership and no paid status in its retained revisions or `payslip_paid_history`.
- The current cutoff stamp is missing/null/invalid. An existing positive safe integer or
  canonical numeric string that references a real cutoff is already valid and cannot be changed.
- The existing primary label (`form_records.period`, falling back to `data.payroll_period`)
  has exactly one claimant in the shared source index. Attendance labels and valid stamped
  payroll aliases participate. A reused/unknown label is held.
- Any other nonempty stored payroll label and any existing calculation snapshot's period label
  identify that same cutoff uniquely. A supplied snapshot must be a readable object. Known
  historical stamps or payroll labels identifying another cutoff are held. This is consistency
  checking, not independent verification that old attendance, money or external evidence is true.
- The cutoff has real ordered dates. Its selected source records contain no duplicate employee,
  unresolved identity/data/cutoff or unsupported status. Another selected source's paid status,
  paid history or paid revision also holds the run.
- There is no `payroll_run` journal for that cutoff, including draft, posted or reversed history.
  The cutoff date range overlaps no closed accounting period. A nonblank pay date must be real
  and outside closed periods. Recovery does not open periods or create adjustments.
- No legacy mail log has the subject that the existing payslip email route would use. A failed
  or uncertain attempt and a different slip with the same subject also hold conservatively.

An unstamped but uniquely resolved legacy record can receive a durable ID. An invalid stamp can
be replaced even if its old value was a string/object/noncanonical number; the prior JSON remains
in revision history. Unknown/missing labels, malformed data, a valid wrong ID, duplicates and
previously paid records require further engineering and accountant review. Do not change labels,
delete records or alter history to make this workflow accept a case.

## Operator procedure

1. Use the cloud/online payroll workspace. Open the target draft payslip's **Recover missing
   cutoff ID** row action. A hold explains why this case needs a separate correction.
2. Check original attendance/payroll records and a restricted case. Check for emailed, printed
   or otherwise issued copies and filings. The checklist records your attestation; software
   cannot verify unrecorded external facts. Arrange accountant/privacy review where necessary.
3. Explicitly select the offered cutoff, enter a reason (10–200 characters) and an evidence
   reference (3–120 characters), then attest that you checked the original records and copies.
   Store sensitive documents in their approved restricted system; enter only the reference.
4. Complete the app's recent sign-in verification if requested. Read the authoritative second
   screen: employee, original stamp, cutoff ID/label/date range, reason and case reference.
   Confirm separately within five minutes. Cancel leaves the record unchanged.
5. Reopen revision history, rerun the affected payroll/contribution reports and read-only
   reconciliation, and have the responsible accountant review the result before release/filing.
   A cleared ID hold does not certify the calculation, settlement, remittance or filing.

Only `data.cutoff_id` changes. Status, labels, amounts, pay date, calculation snapshot,
`updated_at`, creator and definition remain unchanged. The revision increases and mandatory
history records actor, before/after data and a reason containing the case and old/new ID.
Failure to persist that history rolls the data change back. No payroll generation, journal,
email, payment or filing is initiated. The current generic editor continues to preserve the
stored cutoff exactly; it cannot perform this recovery or a transfer.

## API and security contract

All routes require authenticated `payroll.manage` and `syncClass('online')`:

- `GET /api/hr/payroll/:recordId/cutoff-recovery`: bounded record summary, one eligible cutoff
  or null, and a hold string. No raw payroll JSON, money, government IDs, rates or account email.
- `POST .../review`: strict `cutoff_id`, `expected_revision`, `reason`, `evidence_reference`,
  `verified_records: true`; recent identity verification required. The response adds bounded
  employee ID/number/name and an encrypted review credential.
- `POST .../confirm`: strict `review_token` only; recent verification required again.

Reads use private no-store responses. Permission checks run on each request. Intents cannot
cross identity-repair purpose, tenant, actor, session or record. Account credential changes,
expiry and any current payroll/cutoff/selected-employee state change invalidate the intent.
New journal, paid, closed-period and mail history is checked even when it is outside the source
fingerprint. Conditional revision/data update and mandatory history make a successful review
single-use; concurrent confirmation accepts one. Retrying after a lost successful response
returns a conflict: inspect the saved record/history before starting another review.

The shared HTTP retry cache excludes these routes, including tenant-prefixed paths, so it
cannot persist review credentials or replay a successful response ahead of fresh verification.
Request activity redacts `review_token`. Reason/reference are retained audit data: do not put
secrets or unnecessary personal information there. A failed request can still have its normal
redacted activity entry. Database administrators can alter local history; independent audit
immutability and malicious-insider protection remain incomplete.

Installed office nodes refuse the new workflow with 503/online and enqueue no repair. Existing
payroll company claims and paid-clash handling remain. Real office synchronization/restore
acceptance of a cloud repair is not established by the local node-refusal test.

The desktop review refuses submission after its originating payroll view, account, company
or session changes. It preserves the shared accessible modal error area. A stale/held review
stays open with an error; dismiss and reopen after resolving the cause. The review is browser
bound and is not a signature from a trusted external device. A compromised manager/browser
and dishonest evidence attestation remain risks; solo operation has no independent approver.

## Evidence and remaining work

From an installed checkout, run the focused/API and browser checks before the full suite:

```sh
npm run typecheck
npx vitest run tests/payroll-cutoff-recovery.test.ts tests/payroll-identity-repair.test.ts tests/payroll-reconciliation.test.ts tests/payroll-report-identity.test.ts tests/sync-payroll.test.ts tests/idempotency.test.ts
npm run test:e2e
npm test -- --fileParallelism --maxWorkers=2
```

The tests create isolated synthetic catalogs and need no live customer/provider credentials.
The retained run used the managed Linux environment; native Windows results are not inferred.

See [five-source research](../audits/payroll-cutoff-research.md) and
[verification manifest](../audits/evidence/payroll-cutoff-verification.json). API tests cover
successful report recovery, unchanged money/timestamps, permissions, stale/tampered/foreign
reviews, histories, race/retry/rollback and installed-node refusal. Playwright exercises the
actual desktop review, cancel, stale paid state, detached view and scoped axe.

No schema/dependency change, live customer/provider change or deployment is part of this work.
Tenant-wide source fingerprints favor safety over concurrent review throughput; large-history
capacity is unmeasured. Actual cutoff transfers need versioned recalculation and adjustment
policy. Duplicate disposition, malformed histories, payroll release/email/issued-copy controls,
filing eligibility, accounting dates, source snapshots, retry-safe posting and settlement/
remittance/filing evidence remain in the [handoff](../audits/engineering-handoff.md). Native
Windows/device, independent-user and hosted recovery acceptance also remain. Release hold and
whole-control statuses are unchanged.
