# Provisioning/settings boundary — 19 October 2026

Base: b8e1a8bd6a7cd56f21ebc55f1115ef87f3a60564, production.

High scoped integrity finding: owner PATCH applied fields before validating all later fields,
so a rejected request could persist earlier settings. Creation also validated optional module
names after creating the account. Moderate scoped disclosure: catches trusted arbitrary status
properties or the word "module" in an exception message. Subscription errors included raw
storage/Zod messages. No live secret disclosure or production mutation was tested.

Resolution:
- Full PATCH validation before mutation: name, status, plan, payment lock, date, modules and
  retention values. Existing subscription restrictions retain the separate subscription screen.
- Catalog settings/subscription updates, audit entry and response preparation share a synchronous
  SQLite savepoint; storage or audit failures roll back those changes.
- Optional creation modules preflight before account creation. Create/import reject unknown plans.
- ControlPlaneError explicitly identifies authored 400/409 errors; unexpected owner-boundary
  exceptions are replaced before central handling, discarding raw message/status/expose.
- Import integrity-check feedback and migration-failure catalog logs omit raw database diagnostics.
  Subscriber input validation uses public ValidationError while stored quote parsing stays separate.

Tests force real SQLite failures containing "module" plus a synthetic private marker. They
verify generic correlated 500s, no marker in captured request logs, unchanged catalog/audit
state, invalid multi-field patches, no catalog creation for invalid options, duplicate conflict
feedback and valid settings/module dependency behavior. Audit faults cover PATCH and subscription.
The actual browser settings screen retains edits after a real fault and accepts corrected save.
The new test's initial null/undefined expectation was corrected to match getTenant's null contract;
that assertion error is not a product defect. Raw initial and final focused results are preserved.

Primary references accessed 19 October 2026:
- https://www.sqlite.org/lang_savepoint.html
- https://cheatsheetseries.owasp.org/cheatsheets/Error_Handling_Cheat_Sheet.html
- https://cwe.mitre.org/data/definitions/209.html
SQLite documents rollback-to/release and nesting semantics; the synchronous callback keeps the
catalog updates and audit in the same database transaction. Error guidance supports useful
public validation, generic internal failures and non-sensitive correlated logs.

Limits: this savepoint does not include tenant databases/files or post-create setup. Creation
and import still need compensating cleanup and restart recovery across those resources; import
file races and unsupported/corrupt SQLite handling also require a broader lifecycle review.
Signup/other arbitrary status/expose/503 trust, CSV adapters and legacy diagnostics stay open.
No whole-control PASS, release approval, schema/dependency change, hosted acceptance or deployment
is claimed by these local checks. Existing release blockers remain.
