# Payroll release source checks: research and decisions

Retrieved 22 October 2026. This applies primary guidance to the narrow
[release contract](../operations/payroll-release.md), with no security/legal/accounting certification.

| Source | Applied principle | Decision and limits |
|---|---|---|
| [OWASP Authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html), per-request checks, default deny, ID access | Permissions and resource eligibility need enforcement at the point of use. | Recheck staff release/email and employee list/PDF/timekeeping. Staff source conflicts are bounded; held/foreign employee IDs share 404. Existing employee response fields are retained; this is not complete payroll export minimization. |
| [OWASP Transaction Authorization](https://cheatsheetseries.owasp.org/cheatsheets/Transaction_Authorization_Cheat_Sheet.html), 2.5–2.8 | Validate state transitions and have a final server execution gate. | Current-source validation before paid writes and dispatch; paid/history write is atomic. This does not implement one-use transaction authorization, reviewed recipient/source versions, fresh local proof or durable uncertain-send handling. |
| [NPC RA 10173](https://privacy.gov.ph/data-privacy-act/), section 11(c)–(d) | Accuracy and proportionate processing guide disclosure. | Withhold known conflicting/corrupt sources, preserve originals, and avoid staff diagnostic leakage to employees. Printed/email copies and lawful retention/rights/notification remain separate. No deletion rule is inferred. |
| [SQLite transactions](https://www.sqlite.org/lang_transaction.html), read/write transactions | Reads see a transaction snapshot, and writes have concurrency/rollback constraints. | Perform paid validation, conditional status change, history and applicable source-clash record inside one transaction. Concurrent normal submissions and injected history failure are tested. No new process-kill, Windows storage or power-loss proof is claimed. |

The NPC page retrieved successfully; an uppercase "Accurate" search did not match the page's
lowercase text. The section itself is the reference, not a successful search-match claim.

Paid-only email follows the app's existing employee-PDF finalization rule. A software Paid
marker remains distinct from actual settlement; no bank-only legal requirement or complete wage
timing policy is asserted. Unknown legacy cutoff linkage is retained as explicit compatibility,
not guessed. Current source checks can find known duplicates; they cannot prove every duplicate
or missing historical record exists in a replica.

The established offline D6 authority model requires keeping a previously accepted site payment
decision when the cloud differs. The new check flags that source clash and restricts current
issuance rather than rewriting payment history. Local/offline view convergence depends on sync;
this increment does not certify local factors, independent audit protection or malicious-node
resistance. These boundaries remain engineering work, with owner acceptance later.
