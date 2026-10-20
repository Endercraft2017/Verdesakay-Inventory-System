# Research and decisions: stable payroll report identity

Sources retrieved 20 October 2026. Scope: the next attribution gap after
`1b394dd2768d1dd58b9b63338ff7f9a6c6cab2e3`. These are external requirements/guidance
and documented engineering decisions, not a legal opinion, tax certification or a
claim that every later agency issuance has been reviewed.

## Source review

| Primary source | Relevant finding | Application and limit |
|---|---|---|
| [BIR 2316 September 2021 ENCS](https://bir-cdn.bir.gov.ph/local/pdf/2316%20Sep%202021%20ENCS_Final_corrected.pdf), Part I and IVA/IVB | Employee identity/TIN and compensation/withholding belong on the same certificate. The form contains an accuracy declaration. | Detail aggregates by the requested employee ID. Same-name employees retain their own amounts and identifiers. Existing app template/calculation coverage is not certified as the complete current form. |
| [BIR Alphalist format, Annex A](https://bir-cdn.bir.gov.ph/local/pdf/1604C%20Alphalist%20Format%20-%20final.pdf), Schedule 1 and continuation | Employee-level compensation, prior-employer fields, annual adjustments and 2316 figures are related. | Separate ID groups before tax calculation and sorting. Current columns remain; no claim that Schedule 2, all employee categories, prior-employer adjustments or portal validation are complete. |
| [SSS R-3 instructions](https://www.sss.gov.ph/wp-content/uploads/2022/03/SSSForms_Contribution_Collection_List.pdf), page 2 | Correct employee SS numbers are needed to credit contributions to the right member; remuneration is per employee. | Resolve agency IDs and bases through the same stable employee. This legacy form's rates, deadlines and paper-submission directions are not adopted as current rules. |
| [SSS Pay Contributions](https://www.sss.gov.ph/pay-contribution/), Employers / e-CS | Employers generate, review and edit their electronic collection list and PRN through My.SSS. | App CSV remains a worksheet for review/conversion; the change neither submits a return nor proves agency acceptance. Portal format/amount validation remains. |
| [NPC: RA 10173](https://privacy.gov.ph/data-privacy-act/), 11(c–d) | Accurate, relevant, proportionate information; inaccurate/incomplete data needs rectification or restriction. | Stop uncertain attribution, expose bounded numeric diagnostic IDs, preserve source records and reuse the reviewed correction. This does not implement all rights, legal retention or recipient notifications. |
| [OWASP Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html), least privilege / every request / safe failures / testing | Enforce authority on the server, handle failures safely and test it. | Keep accounting/payroll permission boundaries, bound projections, negative API tests and visible blocked states. Report identity checks are additional financial integrity checks, not a new permission system. |
| [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html#name-409-conflict), 15.5.10 | 409 describes a request conflicting with current resource state that a user may resolve and retry. | A report with unresolved source identity returns 409 and a useful bounded explanation. Status selection is a project API decision, not a tax/legal prescription. |

An initially attempted January-2018 BIR CDN path returned an error and was not used;
the official September-2021 PDF above was successfully read. No commercial audit,
provider filing, customer-data upload or external scanning was conducted.

## Decisions and alternatives

- **IDs for identity, labels for display.** A government ID or employee name is not
  substituted as the application's grouping key. Current/former-name resolution
  remains a strict compatibility path for uniquely attributable legacy data.
- **Block the requested report rather than omit unknown rows.** Silent omission
  understates totals; guessing can disclose/misfile another person's pay. Even a
  single-employee detail is held because an unresolved record could be theirs.
  Known other periods remain usable. Unscopable/corrupt records block conservatively.
- **No partial-filing override.** Returning guessed totals with a warning or a UI-only
  block would still permit direct API/CSV output. The shared reader enforces the hold
  for all callers. There is no automatic identity backfill or bulk acceptance checkbox.
- **No join on a non-unique label.** A referenced duplicate cutoff can multiply
  contributions. Read each payslip once, detect possible months and block the
  ambiguous schedule. A schema migration to unique labels could destroy/merge
  legitimate historical periods and needs separate reconciliation.
- **No destructive cleanup.** Existing identity-only repair preserves money, paid
  time and revision history. Unreadable-data reconstruction and resolved transfers
  require a separate reviewed workflow; this patch does not fabricate payroll.
- **Visible errors and request ordering.** Clear cached report state before fetching,
  disable export while pending/failed and ignore late responses. Keep existing
  permissions/projections and avoid adding employee-private fields to report output.

## Evidence boundaries

Reproductions use synthetic same-name employees, different IDs and values; API and
real-browser checks include certificate printing/CSV, fund settings, unique former
names, unresolved/corrupt data, cutoff-vs-pay scope, duplicate labels, reviewed repair
and permission failures. The manifest records exact completed checks and failed runs.
No production customer dataset, actual filing, bank/GL reconciliation, full legal
classification review, large-dataset capacity, independent audit or real-device/office
acceptance is inferred. Existing formulas, payroll eligibility and manual adjustments
are separate remaining work. Whole handbook control states remain unchanged.
