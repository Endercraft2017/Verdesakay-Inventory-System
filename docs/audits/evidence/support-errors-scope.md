# Support and owner-details errors — 19 October 2026

Base commit: d86c3c78e6f730e832d9e2b39f0d7b32dd72f328, production.

Scoped severity: Moderate. Tenant administrators and owner-console operators could receive
raw storage exception messages from six mutation catch blocks. Storage failures were labeled
400 instead of server failures; validation feedback was a serialized Zod exception. This is
part of the existing High API-06 whole-app control, which remains FAIL. No live exploit or
actual secret disclosure is claimed; disposable SQLite triggers prove the response boundary.

Resolution:
- Use the existing parseBody/ValidationError contract in support create/reply/status and
  owner-details service writes. Public validation retains field feedback and central request IDs.
- request-errors.ts forwards only authored ValidationError instances intact; unexpected errors
  become fresh generic errors, discarding message/status/expose before central 500 handling.
- Validate positive safe-integer ticket IDs in the service. Existing middleware already rejects
  several numeric bad IDs; nonnumeric IDs now fail validation before reaching SQLite.
- Keep tenant authentication, users.manage, online-only gates, company scoping and owner-only
  ticket visibility. Existing cross-tenant/private-note tests remain in the focused suite.

Failure injection covers tenant/owner create, tenant/owner reply, owner status and owner details.
Each real trigger failure returns generic 500 plus correlation ID, leaves the affected stored
records unchanged and omits the synthetic internal marker from captured request/error logs.
The actual browser uses a separate disposable tenant and narrowly scoped trigger; its failed
submission preserves the draft, enables retry, and succeeds after correcting the subject.
There are no live support messages, customer data or external database changes in these tests.

Primary references accessed 19 October 2026:
- https://cheatsheetseries.owasp.org/cheatsheets/Error_Handling_Cheat_Sheet.html
- https://cwe.mitre.org/data/definitions/209.html
Applied guidance: minimal useful audience-specific messages, internally handled exceptions,
server correlation, no sensitive exception text in responses or routine logs. These sources
do not certify this application or prescribe the scoped severity used in this audit.

Remaining: module/provisioning and CSV catches, central status/expose/503 trust, diagnostic
logging review, richer protected diagnostics and all other open handbook controls. Support
write/audit atomicity and duplicate submission guarantees require separate work; this change
does not promise all failures roll back every multi-statement operation. No schema, dependency,
mobile runtime, release policy, deployment or hosting configuration changed.

Baseline reproduction note: the initial new fault tests intentionally failed against the old
response boundary. Its tenant-reply probe initially used an owner-only ticket and correctly
received 404; the final test seeds a tenant-visible ticket to reach the storage fault. Early
new ID assertions also assumed all errors originate in the service; corrected expectations
retain the existing middleware's safe numeric-ID rejection. These fixture/assertion changes
are not reported as product defects. The final focused file covers all six real storage paths.

The initial full run also reported two existing mobile rendering-wait failures; the complete
mobile file passes after bounded expected-state waits replace the short delays in those cases.
Remaining short-delay tests are not certified deterministic by this targeted correction.
