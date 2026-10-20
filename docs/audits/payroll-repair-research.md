# Research and decisions: reviewed payroll identity repair

20 October 2026. Source review for the repair following commit
937ef3835386ddf044267152b17ff584ae9fb017. This document separates external guidance,
project decisions and remaining operational/legal work. It is not an assurance certificate.

## Sources checked

| Source and relevant section | Finding used | Application / limit |
|---|---|---|
| [OWASP Transaction Authorization](https://cheatsheetseries.owasp.org/cheatsheets/Transaction_Authorization_Cheat_Sheet.html), functional 1.1 and nonfunctional 2.1, 2.3, 2.5–2.10 | Review significant details, enforce authorization on the server, protect review state and prevent replay | Five-minute encrypted review bound to operator/session, tenant, record and employee state. Final revision compare/update makes confirmation single-use. Fresh sign-in proof is separate from the explicit repair confirmation. This is not hardware transaction signing. |
| [OWASP Authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html), least privilege / every request / testing | Check authority on each access path, not just UI visibility | Payroll management on all repair routes, fresh proof on issuance/confirmation, plus ordinary-editor owner-change refusal. Negative API tests cover method authority and scoped context. Other privileged payroll actions remain separately scoped work. |
| [OWASP Logging](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html), event attributes / data to exclude / protection | Record actor, action, object, result and reason; avoid raw tokens and unnecessary personal data | Existing payroll revision history stores old/new data, actor, reason and reference atomically. `review_token` is redacted from generic request metadata. Evidence references, not identity-document uploads. Existing DB history is not independent, tamper-proof storage. |
| [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html#name-if-match), 13.1.1 | Conditional state changes prevent lost updates | Explicit revision and full record fingerprint, then conditional SQL update. This API uses a body review credential and 409 conflicts; it does not claim to implement the HTTP If-Match header contract or its 412 status. |
| [SQLite savepoints](https://www.sqlite.org/lang_savepoint.html) | Roll back a group of writes together | Reuse `correctRecord`; identity update and revision history succeed together. An audit-write failure rolls back attribution. Assumes the project's one-authoritative-process SQLite topology. |
| [National Privacy Commission: RA 10173](https://privacy.gov.ph/data-privacy-act/), sections 11(c–d), 16(d), 20 | Accuracy, proportionate processing, correction history and safeguards matter | Preserve original/new identity evidence in restricted history and limit employee-picker fields. This feature does not complete all data-subject rights or recipient-notification obligations. Employment/privacy-law applicability and approved process remain owner/counsel work. |
| [RA 11976](https://lawphil.net/statutes/repacts/ra2024/ra_11976_2024.html), section 33 amending NIRC section 235 | Covered tax-accounting records have a five-year preservation rule with a defined starting point | Do not delete historical payroll as a repair shortcut. This is not a universal five-year payroll deletion schedule; employment rules, proceedings, legal holds and other jurisdictions need separate review. No automatic retention/deletion change is made. |

All seven sources were retrieved on the date above. Findings are bounded to the
identified sections; current web pages may change. Tax/privacy provisions do not
by themselves prescribe this specific UI, five-minute window, token format or role.
Those are engineering choices below. No two-operator legal mandate is asserted.

## Threat model and decisions

The privileged action changes who can see a historical payslip. It must not become
a new route to edit paid amounts, transfer a resolved record, or silently guess
that a reused name refers to a particular employee. A payroll manager with access
to the underlying data is trusted to review employment evidence; technical controls
cannot establish that their claimed evidence is true or remove insider risk.

- **No bulk backfill by name.** A current/former-name collision is precisely why
  disclosure was withheld. Select a stable employee ID after reviewing original
  employment/cutoff records. There is no automatic best-match choice in the picker.
- **New exceptional online workflow.** Normal payroll remains under existing
  offline company-claim authority. A repair must use the cloud workspace and fresh
  cloud proof; installed-node calls return 503 and are not queued. Credentials and
  review state are not copied to nodes. This does not add cloud-only proof to
  existing payroll generation/payment routes.
- **No unmark/edit/re-mark shortcut.** Updating only employee_id preserves paid
  status, amounts, calculation snapshot, original updated/finalization timestamp,
  record identity and definition version. Revision history carries the repair time.
- **Bound review before execution.** A server-created encrypted intent includes
  purpose, company, actor/session/credential fingerprint, record fingerprint,
  selected employee/account fingerprint, reason, reference and expiry. The browser
  renders the returned details. Client-supplied extra confirmation fields are refused.
- **One confirmation per record version.** The existing revision is the shared
  unused-state precondition. Conditional update plus revision trigger consumes it;
  multiple issued reviews/concurrent confirmations cannot apply twice. Replays
  return conflict. There is no new approval-token table or schema migration.
- **Mandatory business history.** The write is rolled back if the attributed
  revision cannot be persisted. Generic request logging is additional observability,
  not the sole business audit record. History is available through the existing
  payroll Change history control, with its existing access policy.
- **Close the normal-editor alternate path.** Generic updates cannot change the
  resolved owner of an existing payroll record. Resolved-owner transfers and
  malformed-record reconstruction need a separately reviewed workflow; this repair
  does not allow a manager to override them with a checkbox.
- **Solo operation is supported.** No second operator is required by this patch.
  Fresh proof, narrow authority, reason/reference, explicit disclosure confirmation,
  concurrency checks and attributable history compensate in part. An independent
  second review is a useful organizational option, not implemented dual control.

## Alternatives considered

| Alternative | Decision |
|---|---|
| Edit the live database or disable paid locks | Rejected: bypasses normal validation and attributed correction history. |
| Reuse the general form editor | Rejected for attribution changes; does not bind a fresh reviewed recipient and can alter unrelated values. |
| Require a second support operator | Not assumed: the owner operates support alone; tenant staffing varies. Does not justify dropping technical controls. |
| Make all payroll actions cloud-only | Rejected: contradicts the accepted offline authority model. Only this new exceptional repair is online. |
| New durable approval queue/table | Deferred: current request-local review plus authoritative revision supports single-use confirmation without a new sync/security-state lifecycle. Independent approvals would require a different design. |
| Change existing paid record updated_at | Rejected: self-service PDFs currently use it as the finalization time. Preserve it and use revision-history timestamps for repair time. |
| Automatically resend payslips, rebuild journals or amend returns | Rejected: identity correction is not authorization for those financial/external actions. |

## Verification and remaining work

API checks cover authorization, fresh proof, explicit evidence assertion, exact
paid-row preservation, attributed audit history and rollback, stale/tampered/expired
reviews, different actor/session/tenant, changed employee account, concurrency,
ordinary-editor bypass and office-node refusal. Browser checks cover the actual
operator journey, accessibility, cancellation and an actual stale-record rejection.
Actual-server and full regression results are recorded in validation-results.md.

This does not prove historical evidence is complete. Payroll staff must review
same-cutoff duplicate records, tax/statutory attribution, journals, filings and
prior recipients after a correction. Name-grouped statutory reporting is still
separate engineering work. A correction cannot recall a previously downloaded or
emailed copy. Notification/rights requests follow an approved privacy process;
this patch sends no email or notification to prior recipients.

Operating acceptance still includes production keys/HTTPS, protected backup/history,
supported device/operator testing, sync/restore reconciliation, lawful retention
and legal review. No retention timer, legal approval, independent review or hosted
acceptance is inferred from passing tests. Whole-control scorecard statuses remain.

## Credential-cache and legacy serialization safeguards

The new identity routes bypass general HTTP idempotency response storage. Each
request still reaches fresh-proof validation; encrypted review credentials are not
stored in response receipts, even if a caller supplies an Idempotency-Key. The
record's conditional revision update supplies single-use execution instead.

Ordinary payroll editing retains the original employee_id representation, including
invalid legacy values. Ownership comparison uses the JSON representation actually
written, preventing a numeric coercion from turning an invalid ID into null and
reviving name fallback. A regression reproduced that conversion before correction.
