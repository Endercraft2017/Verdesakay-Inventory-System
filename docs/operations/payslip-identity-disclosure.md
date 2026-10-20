# Payslip ownership and ambiguous legacy identity

Follow-up: the [reviewed cloud repair workflow](payroll-identity-repair.md) is now implemented
for unresolved valid-JSON records. Resolved-owner transfers, malformed-data reconstruction
and broader operational acceptance remain open. [Stable-ID report grouping](payroll-report-identity.md)
is now implemented; financial/filing reconciliation remains. The original
increment and remaining issues below describe the earlier disclosure fix.

20 October 2026. High-severity scoped privacy fix. Release approval remains on hold.

## Reproduced gap

A renamed employee's old unstamped payslip could appear in both that employee's
self-service account and a new employee's account after reuse of the old name.
Both list and direct PDF/timekeeping access used the historical name as identity.
The email resolver instead preferred the current name holder, and could send the
old employee's pay to that person's linked mailbox. A payslip with a stamped ID
that no longer existed could also fall back to a matching name when emailing.
Tests used synthetic employees, and mocked email: no real email or customer data
was sent. Six of nine original reproduction cases failed before the fix. A later compatibility
regression also reproduced a 404 for a rightful owner with an imported text ID;
the candidate query now handles that representation without coercing invalid IDs.

## Implemented rule

`modules/payroll/payslip-owner.ts` provides one request-local ownership snapshot:

1. A present employee ID must be a positive safe integer or canonical decimal
   string identifying an existing employee. Invalid values and missing referenced
   employees resolve to no owner. They never fall back to a name. Historical
   absent/null IDs retain the legacy name path.
2. A legacy name is resolved only if all normalized current/former-name claims
   refer to one employee. Comparison trims and lowercases names. Reuse across a
   current employee and another person's history is ambiguous; neither wins.
   Repeated history entries for the same employee do not create ambiguity.
3. Stamped identity wins even when names have changed or overlap. A unique former
   name remains supported; the fix does not erase or rewrite stored payroll.

Self-service lists, PDF and timekeeping routes use this shared decision. SQL
candidate selection remains scoped by employee ID/unambiguous name, followed by
strict owner validation of each selected row. Numeric and canonical decimal-string
ID representations both match the SQL candidate query. Ambiguous legacy records are omitted
from the list and return the same 404 as a missing record at direct URLs. Existing
paid-only PDF and cache/audit behavior remains unchanged. Payroll email returns
400 with an ownership-review explanation before resolving a mailbox or sending.
The payroll management permission and online sync class are unchanged.

The prior rename regression's assumption that the current name holder wins was
changed deliberately: a name reused today does not prove ownership of an old slip.
Generation now returns 409, including `unresolved_record_ids`, before opening its
write transaction if any existing slip in the target cutoff/period has unresolved
identity. Both ambiguous legacy names and dangling stamped references are held
for payroll review; existing paid records and record counts are preserved. This
is a financial integrity refusal on the existing claim route, not automatic
reassignment. It applies at the executing authority, including replay; identity
conflicts require reconciliation rather than duplicate generation. No sync class
or new cloud-only authentication requirement was introduced.

No schema/version/dependency changes. No changes to mobile bundles or deployment.

## Payroll operations and remaining engineering

If an old slip disappears from employee self-service, payroll staff should inspect
its existing employee ID, record number, cutoff, employment records and name-change
history. Do not pick a person based only on the current matching name, resend it
manually, delete the record, or bypass the paid lock. Preserve the evidence and
withhold disclosure until ownership is established. Payroll-authorized staff retain
access to the underlying payroll form records under their existing permissions.

The original disclosure patch did not include identity-repair tooling. The subsequent
[reviewed cloud repair workflow](payroll-identity-repair.md) now supports unresolved
valid-JSON records with stable employee IDs, reasons and attributed revisions.
Resolved-owner transfers, malformed-data reconstruction and operational reconciliation remain separate work.
No broad SQL repair is authorized by this document. Owner participation is last.
Legacy name resolution can only check recorded identity history. Deleted/imported
history may be incomplete; this is not proof of historical ownership. Reviewed
stable-ID attribution/backfill remains necessary for those records.

Follow-up: `nameOf` retains its historical fallback for display only. Tax/agency/HR
reports now group by stable ID and block unresolved ownership rather than using that
fallback. See [report contract](payroll-report-identity.md). Duplicate/ledger/payment/filing
reconciliation remains. Generation continues to block unresolved cutoff slips before writes.

Other remaining work includes export/email action verification, reviewed recipient
changes, retry/uncertain-send handling, template variables, retention/erasure/legal
holds, tenant-isolation adversarial coverage and actual printer/client acceptance.
No whole handbook control is promoted by this increment.

## Verification and research

API regressions cover both accounts for reused names, PDF/timekeeping refusal,
stamped ownership, unique former-name downloads/email, missing stamped employee,
duplicate normalized current names, shared history aliases, invalid ID coercions,
and lack of ordinary employee email authority. The new browser cases sign in as
each employee separately and exercise list and direct routes. Actual server startup
checks confirm the protected behavior using temporary catalogs and no mail sends.

Validation also exposed an unrelated mobile test timing failure: a fixed 40 ms
navigation delay clicked a missing button under full-suite load. Another case
reported a location-picker failure during concurrent load; its 80 ms delay was
replaced with a wait for the rendered full-location label, preserving all capacity
and selectable/full-location assertions. Both cases passed in isolation before
the fixture fixes. Its test fixture
now waits for the rendered control, observes the rejected save and awaits recovery,
while preserving the zero-upload assertion. Mobile product code/design is unchanged.
The initial failed run and the final rerun are recorded separately.

Counts, logs and limitations: [validation results](../audits/validation-results.md)
and [verification manifest](../audits/evidence/payslip-identity-verification.json).
Research: [OWASP API1:2023](https://owasp.org/API-Security/editions/2023/en/0xa1-broken-object-level-authorization/),
retrieved 20 October 2026. It recommends server-side authorization for access to each
object and regression tests. Applying that principle to legacy identity ambiguity
is this project's engineering decision, not a claim of certification.
