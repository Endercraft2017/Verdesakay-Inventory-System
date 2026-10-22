# Staff payroll copies: research and decisions

Retrieved 22 October 2026, scoped to [staff print and Excel](../operations/payroll-staff-copies.md).
This applies primary guidance to repository behavior and makes no certification claim.

| Primary source | Applied decision | Limits |
|---|---|---|
| [OWASP Authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html), per-request permissions and default deny | Authenticated payroll-view read checks form/record scope and the shared source holds on every request, including Print rechecks. | UI checks cannot constrain an authorized hostile client or revoke a file already obtained. |
| [OWASP Transaction Authorization](https://cheatsheetseries.owasp.org/cheatsheets/Transaction_Authorization_Cheat_Sheet.html), 2.3/2.6/2.8 | Reload saved values and require an unchanged preview digest before the supported Print action. Failures erase the stale frame and hold the action. | This read-only equality precondition is not a transaction approval credential, factor, one-use intent, signed final artifact or payment execution gate. |
| [OWASP CSV Injection](https://owasp.org/www-community/attacks/CSV_Injection) (redirects to community.owasp.org) | Verify the existing typed-string XLSX output through the actual library and downloaded file, including formula-looking names/titles. | CSV escaping is a different contract. Excel re-save/re-open behavior, spreadsheet vulnerabilities, all generic CSV paths and application certification are not established by this XLSX test. |
| [NPC RA 10173](https://privacy.gov.ph/data-privacy-act/), section 11(c)–(d) | Restrict further supported output of known conflicted source data; omit unused calculation breakdown and avoid new HR-master disclosure. | Saved custom payroll fields remain for layouts. Lawful basis, rights, retention, disclosures and full historical data minimization remain separate. |
| [W3C WCAG 2.2 Label in Name](https://www.w3.org/WAI/WCAG22/Understanding/label-in-name.html), SC 2.5.3 | Editor text-button names include the visible labels; ribbon Hide/Show names match their text and style cards retain their complete visible names. | Automated checks do not substitute for real speech-input/screen-reader testing. Symbolic controls and comprehensive conformance need separate manual assessment. |
| [SQLite transactions](https://www.sqlite.org/lang_transaction.html), read transactions and savepoints | Form, selected records, cutoff/source checks and digest are captured in one read savepoint. | This protects the read view; later changes, stale replicas, physical print and filesystem/browser output are not part of that database transaction. |

The initially attempted OWASP `CSV_Injection_Prevention_Cheat_Sheet.html` URL was unavailable.
The official OWASP community attack page was retrieved and used instead. No recommendation is
attributed to the failed URL. The NPC accuracy text and the transaction final-control passage
were retrieved successfully. Repository editor UX guidance was read and applied to status,
persistent conflict recovery and accessible print-preview controls; its complete local browser
gate is included in verification. Automated scans do not establish WCAG conformance or user acceptance.

Retaining draft payroll copies is deliberate: staff need saved draft worksheets for review.
Drafts must be explicit, while known source conflicts block any supported print/export batch.
Making every copy Paid-only would remove that review workflow without proving settlement.
Existing local replica reads are preserved; no new cloud-only permission is imposed on offline
payroll authority. Operators must synchronize/review before issuing copies externally.
