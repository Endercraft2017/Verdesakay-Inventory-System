# Staff payroll print and Excel copies

22 October 2026. Follow-up to [payroll release](payroll-release.md). This covers the supported
staff payroll print/export actions. Whole-app production readiness remains on hold.

## Findings before correction

| Severity | Gap | Resolution |
|---|---|---|
| High | Row, visible/selected and cutoff-bundle printing, summary printing and Excel used the older browser list without the current-source holds. A hidden duplicate sibling could be omitted from the selection and its counterpart printed. | One authenticated payroll-view read reloads every selected saved record and checks the shared source index, including unselected siblings. Any missing/held item refuses the entire batch. |
| High | A valid preview could be printed after saved money or source eligibility changed. | The Print action repeats the server read with an equality precondition. Source conflicts or changed saved output disable Print, erase the old print frame, and show persistent recovery guidance. |
| Medium | Unrelated corrupt saved JSON crashed staff name searches, preventing source review. | Guard JSON extraction in the existing record query; retain number-based review and hold corrupt copies. |
| Medium | Detail printing could issue unsaved deduction calculations without clearly distinguishing them from saved payroll. | Unsaved changes remain open and must be saved before printing. Valid saved draft copies have a draft banner and prominent per-copy wordmark. |
| Medium | Export/preview completion could arrive after leaving payroll or switching account/company. | Check account object, session token, company-server scope, form-view owner and live toolbar before and after reads and before printing/downloading. Late responses cannot reopen output in the supported flow. |
| Medium | The mandatory broader editor gate found visible button text absent from accessible names in 52 scans, affecting voice-control recognition. Its old setup also assumed a revoked session and obsolete URL. | Preserve visible text in button names, match Hide/Show ribbon labels, let style cards expose their text; refresh audit authentication and use the current cookie login/entry URL. Full gate rerun without exclusions. |
| Reviewed risk | Spreadsheet text can be interpreted as formulas by spreadsheet applications. | Existing XLSX cell writer uses explicit string types and no user-provided formula field. An actual vendored-library XLSX round trip and browser download verify inert spreadsheet-looking text/no formula cells. This does not certify the spreadsheet library or generic CSV exports. |

## Operator workflow

1. Review payroll and resolve source holds. Preserve duplicates and financial history; do not
   delete or select a preferred duplicate to make totals look correct. Use the reviewed identity
   or cutoff recovery workflow only when its existing conditions apply.
2. Save any deduction changes. Print and Excel use saved values reloaded at the time of the
   action, so an older visible list does not control the amounts in the copy.
3. Select up to **200 payslips** for each copy. Row, visible/selected and cutoff-bundle actions
   all use the same read. Filter/select smaller batches if more are needed. A batch is never
   silently truncated or partially exported.
4. Review the preview. Draft/mixed batches are marked **DRAFT — NOT FINAL**. Each draft payslip
   also has a prominent wordmark inside its rendered tile; summary/Excel carry the batch notice.
   Preview tiles refit when the open dialog is resized; a blocked preview moves keyboard focus
   to its persistent explanation and Escape returns to the invoking control.
   Paid-only copies say **PAID RECORD COPY — payment evidence is separate**. A software Paid
   marker does not establish bank payment, statutory remittance or tax filing.
5. Press Print. If saved payroll changed or a source hold appeared, close the blocked preview,
   review current payroll and reopen it. Print remains disabled in that preview. Excel creates
   a saved-value snapshot immediately after its validated read.

Do not issue copies from an installed PC until its accepted payroll changes and relevant
sources have synchronized and conflicts have been reviewed. A current local replica can lack
later cloud conflicts. This change does not alter company/site authority or D6 decisions.

## API and consistency contract

`GET /api/hr/payroll/copy?form_id=<id>&ids=<comma-separated IDs>[&expected=<SHA256>]`
requires authentication, the HR module and `payroll.view`. Payroll managers retain their
existing permissions; HR/forms access alone is insufficient. The tenant connection comes from
the authenticated request. No cross-tenant ID lookup occurs.

Strict query validation accepts 1–200 distinct positive safe canonical IDs, one payroll form
and an optional lowercase 64-character digest; repeated/unknown parameters are refused.
Errors are 400 invalid request, 401/403 access, 404 missing/wrong-form record, or 409 source/
preview conflict. No partial `records` payload accompanies a refusal. Responses are private
and no-store. No mutation, print audit receipt or sync command is created.

One synchronous SQLite read savepoint contains the form, source index, eligibility checks and
copy construction. The shared release gate checks identity, cutoff, duplicate, status, known
money/date-shape issues and known alias siblings. It preserves the existing explicit unknown
legacy-link compatibility; it does not infer a cutoff, recompute pay or verify all historic data.

Successful responses contain form ID/name/slug/fields; selected record ID/number/period/status/
data/created and updated times/revision; resolved cutoff metadata; a notice and snapshot digest.
The saved calculation breakdown is omitted. Saved custom payroll fields remain for existing
layouts; this is not a complete schema/minimization review of arbitrary historical fields.
No HR master/contact/rate-setting query is added.

The digest covers the ordered selected records (including original saved data), current form
fields/name and selected cutoff metadata. It is an **equality precondition**, not an authorization
credential, signed artifact, expiring one-use approval or evidence of payment. Every recheck still
requires authentication, payroll permission and source eligibility. Changing the requested set/order
changes the digest. A transaction gives a consistent local database view, not a lock on future events.

The displayed layout, company header and global variables are captured for the preview. Print
rechecks saved payroll/form/cutoff state, not subsequent template/global-setting changes. Copies
already downloaded, printed, captured or manually edited cannot be revoked. Native print dialogs,
Ctrl+P, developer tools, direct authorized record reads and a hostile client are outside this UI
control; no digital-rights-management or unforgeable final-document claim is made.

## Verification and remaining work

See [research](../audits/payroll-copy-research.md),
[verification manifest](../audits/evidence/payroll-copy-verification.json) and
[validation results](../audits/validation-results.md). Tests use isolated synthetic data, actual
HTTP/browser actions and the vendored XLSX writer/reader. No real payroll, mail, bank or provider
transaction is performed.

Follow-up: reviewed recipient/version binding and durable uncertain email intent are implemented
and locally tested in [payroll email release](payroll-email-release.md); real provider and hosting
acceptance remain open.

Still open: true duplicate
adjustments/valid cutoff transfers/malformed history recovery; full pay/contribution arithmetic and
historical settings acceptance; settlement/remittance/filing receipts; replica/fresh-proof authority;
large-history capacity; native Windows/Android and hosted checks; manual assistive-technology and
operator print/paper acceptance. The existing dependency advisory finding is not cleared by these tests.
