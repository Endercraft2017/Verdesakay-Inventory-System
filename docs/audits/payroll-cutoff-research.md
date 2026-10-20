# Payroll cutoff recovery: primary-source decisions

Retrieved 20 October 2026. These sources guide the limited correction in
[the operator/API contract](../operations/payroll-cutoff-recovery.md); they do not certify
the app, an entity's accounting policy or legal compliance. The supplied audit guide remains
an audit reference; the user's request authorizes implementation and pushing the branch.

| Primary source | Relevant principle | Application and limit |
|---|---|---|
| [OWASP Transaction Authorization](https://cheatsheetseries.owasp.org/cheatsheets/Transaction_Authorization_Cheat_Sheet.html), 1.1, 1.5 and 2.5–2.10 | Show significant details, enforce ordered review/execution, reject changed data, expire and consume authorizations. | Server-created, purpose/session/company/actor/state-bound intent; fresh proof at both writes; separate authoritative confirmation; atomic revision guard. Browser review is not an external trusted display or an independent approver. Successful retry returns a conflict rather than a cached success. |
| [OWASP Authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html), least privilege, default deny, every request | Authentication alone does not grant authority over every resource. | Require payroll management on each endpoint and tenant-scoped data access. Test unauthenticated, clerk, alternate operator/session, foreign company and installed-node requests. This is scoped endpoint coverage, not a complete privilege review. |
| [OWASP Logging](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html), event attributes, excluded data and verification | Attributed events need useful context, credential protection and failure testing. | Mandatory attributed before/after revision with reason/reference; token redaction and no HTTP receipt persistence; injected history failure rolls back the stamp. Reasons remain restricted audit data. Independent log protection, retention and all sensitive routes remain broader work. |
| [National Privacy Commission: RA 10173](https://privacy.gov.ph/data-privacy-act/), section 11(c)–(e) | Accuracy, proportionality and justified retention guide processing. | Correct a supported reference while preserving original financial history; expose bounded identity and case references. This does not authorize deleting payroll history or prove lawful processing, retention or notification policy for a customer. |
| [SQLite savepoints](https://www.sqlite.org/lang_savepoint.html), section 2 | Nested correction and history writes can roll back together; releasing an inner savepoint does not independently commit. | Reuse `correctRecord` and perform final eligibility/state checks and conditional update inside its savepoint. API fault injection proves rollback on history failure. This increment adds no new process-kill or storage power-loss proof. |

The research supports restricting the recovery to a consistent existing destination. A
metadata transfer can change contribution scope while preserving a calculation from the old
attendance period; it needs a separate recalculation/adjustment design. Choosing a duplicate
winner from order, pay status or date also lacks evidence. Both remain held.

Known paid/journal/closed-period/mail history is treated conservatively. Failed mail attempts
can have uncertain external outcomes; matching subjects cannot prove the exact source record.
Unrecorded print copies and accepted filings need human/source evidence. No official source
requires this exact application's label rule, five-minute window or choice to hold every
journal status; those are conservative engineering decisions within the authorized scope.

The workflow supports a solo authorized payroll manager. It does not solve insider fraud,
compromised-browser confirmation, independent audit retention or all payroll legal obligations.
No banking action, provider email, customer mutation, new dependency, certification or live
release is inferred from research retrieval or green local tests.
