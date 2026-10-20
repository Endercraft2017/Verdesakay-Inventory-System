# Payroll source and journal integrity: research and decisions

20 October 2026. Base `91a66680f659ae3ef940e1de8287528d02ba4e69`. External sources,
engineering choices and remaining policy decisions are separated below. No certification
or tax/labor/accounting opinion is inferred from this implementation.

| Source retrieved | Finding used | Application / limit |
|---|---|---|
| [SQLite Savepoints](https://www.sqlite.org/lang_savepoint.html), sections 2–3 | Nested release does not make an outer transaction durable; outer rollback/process failure undoes it. | One payroll savepoint encloses reversal, replacement lines and numbering. Trigger faults and actual process termination test the integration. Assumes the configured one-authority SQLite topology/storage. |
| [SQLite Transactions](https://www.sqlite.org/lang_transaction.html), 2.1–2.2 and 3 | Read snapshots are stable; only one writer; BEGIN transactions do not nest; failure handling must roll back the full intended unit. | Use savepoints rather than nested BEGIN in the shared posting helpers, and a read snapshot for comparison. This does not prove remote storage, power-loss durability under arbitrary PRAGMAs or all concurrency modes. |
| [OWASP Transaction Authorization](https://cheatsheetseries.owasp.org/cheatsheets/Transaction_Authorization_Cheat_Sheet.html), 2.5–2.8 | Verify allowed transitions and significant source data at execution, rather than trusting client parameters. | Server-side cutoff/duplicate gates and atomic replacement. The read-only preview is not unique transaction authorization; version binding, recent local proof and retry-safe command execution remain. |
| [NPC RA 10173](https://privacy.gov.ph/data-privacy-act/), 11(c–d) | Accuracy and proportionate processing. | Restrict uncertain payroll processing, preserve originals, and return aggregate comparisons/limited record IDs rather than employee HR objects. Rights, retention, independent audit protection and notification procedures remain. |
| [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html#name-409-conflict), 15.5.10 | A resolvable state conflict can return 409 with explanatory information. | Duplicate/invalid source holds use 409; existing ledger-disabled/balance/write refusals remain 400. HTTP status is an API design choice, not a financial-rule mandate. |
| [Lawphil Labor Code](https://lawphil.net/statutes/presdecs/pd1974/pd_442_1974.html), Articles 102–105 | Wage payment and its timing/recipient are actual employer obligations. | A software Paid marker or journal is not treated as verified wage settlement. This reference alone is not a complete review of amendments, implementing rules, entity coverage or permitted payment channels. No bank-only legal requirement is asserted. |
| [IFRS Foundation IAS 19 overview](https://www.ifrs.org/issued-standards/list-of-standards/ias-19-employee-benefits/), About / short-term benefits | Recognition of employee-benefit expense/liability is distinct from later settlement. | Explicitly separate a journal comparison from payment evidence and flag accrual-date policy as unfinished. The existing explicit pay-date posting convention is not certified as complete IAS 19/PFRS/SME treatment; applicability needs the responsible accountant. |

An Official Gazette Labor Code URL and an attempted BIR eAFS page failed to retrieve;
neither is used as evidence. No current filing procedure is inferred from those attempts.

## Decisions

- Stable employee/cutoff IDs identify source slots. A unique recorded legacy label is
  compatibility evidence, not a replacement for missing historical proof. Valid stamps
  disambiguate reused display labels; ambiguous unstamped rows are held.
- Never choose newest/first duplicate payroll as an automatic correction. Preserve all
  originals; prohibit ambiguous generation/posting and hold affected report output.
- Validate the replacement before touching the prior journal, then commit both effects
  together. A reversal failure cannot be ignored. Reversal rows cannot become live originals.
- Compare current expected accounts, amounts, parties and date in one read snapshot.
  Matching aggregate balances do not prove employee-level correctness or money movement.
- Use a deterministic cutoff-end fallback when pay date is blank; display it. Explicit
  pay dates retain existing behavior. Separate accrual/payment dates and approved financial
  recognition policy remain necessary, particularly around year end.
- Keep existing offline authority and company claim classes. Do not introduce a cloud-only
  factor check that strands accepted office work. This does not complete local-factor or
  command-signing design, exactly-once HTTP retries or real office/device acceptance.

## Proof boundaries

Synthetic tests exercise duplicate slots, cross-year dates, custom/reused labels, missing
cutoff linkage, monthly history, rate-change rollback, raw stamp preservation, balance/
database/line failures, closed dates, invalid/multiple prior journals, reversal idempotence,
permissions and private projections. Playwright exercises the real comparison/posting,
duplicate hold, error/retry, request ordering and scoped accessibility. A real process is
killed after the inner reversal release; a real server restart verifies rollback and deliberate re-posting.

No live bank/provider/customer record is touched. No large-history capacity, all financial
classification/eligibility rules, end-to-end bank/remittance/filing model, independent audit,
hosted restore or native/physical-office acceptance is inferred. In-process office GL
post/re-post and cloud replay are explicitly verified, alongside existing D6 paid-clash checks. Exact completed and failed runs
are in the verification manifest; whole handbook controls remain unchanged.
