# QuickBooks connection and financial-write safety

Implemented 18 October 2026. Local engineering safeguards are tested; real Intuit sandbox and
production acceptance are still required. No customer connection, remote record or live setting
was changed during this work. QuickBooks remains a beta integration.

## Confirmed defects and resolution

| Severity | Failure before the fix | Delivered protection |
|---|---|---|
| High | An old asynchronous refresh could restore credentials after disconnect or overwrite a reconnect | Durable connection generation; original tenant/company/environment checks after awaits; atomic credentials/config/generation commits and conditional token replacement |
| High | Concurrent expired-token requests could rotate the same refresh token independently | Per-tenant single-flight admission, SQLite refresh lock across processes sharing the same DB, and re-read after admission. A late 401 uses a newer token without clearing it |
| High | Record IDs from company A could be reused for company B; an old response could attach to the new connection | Links and write receipts keyed by environment plus Intuit realm ID; an export carries one captured connection throughout party lookup, invoice/bill submission and link persistence |
| High | Concurrent exports or retries after an uncertain timeout could create duplicate financial records | Persistent per-order export exclusion and a durable pre-send write record; ambiguous outcomes block blind retries; known completed writes can recover a missing local link before applying an edited order |
| Medium–High | Provider faults or malformed responses could expose provider data or be mistaken for success/no party found | Generic errors without raw provider bodies; token/write/party-lookup validation; malformed or ambiguous lookups never create a new party |

## Connection lifecycle

A successful OAuth exchange commits encrypted tokens, environment, realm and a fresh connection
ID together under a SQLite writer lock. A failed commit rolls all of them back. The optional
company-name lookup cannot change a newer connection. Disconnect atomically invalidates the
connection ID, clears local tokens and pending OAuth state, and removes obsolete refresh locks.
It stops future local use; it does not undo an already submitted remote write or claim that the
provider grant was remotely revoked. Review grant revocation separately through Intuit.

An in-flight request always uses its captured realm, tenant DB and connection ID. It checks those
again before sending, after provider response and after JSON parsing. A disconnect/reconnect
rejects old results. A write already sent can still complete remotely; the journal retains its
uncertain outcome in the original company scope. It cannot become a link in the new company.

The refresh map shares one promise within a process; the durable refresh lock refuses duplicate
refreshes in another process sharing this DB. A crashed refresh lock has no automatic timeout
that could admit another request while the old one is still running. Investigate and reconnect
to establish a fresh generation. This does not create a supported multi-replica deployment with
separate SQLite files or establish live provider availability.

## Durable write state

- `pending`: a request has been reserved before submission. Another write using this operation
  key is refused. An interrupted `pending` row is not automatically treated as failed.
- `uncertain`: timeout/network failure, 5xx, ambiguous throttling, malformed success or connection
  invalidation after submission. The remote system may already have accepted it. Reconcile before
  retrying; restart, reconnect and elapsed time do not clear this state.
- `failed`: no request was sent, or a definite non-timeout/non-throttling 4xx rejection was received.
  A later corrected attempt may proceed.
- `succeeded`: retain the minimal validated remote ID, SyncToken and optional document number.
  The provider's raw business response is not stored. A lost local link can be reconstructed from
  this scoped receipt, including when the local order was edited after the accepted write.

A UUID request ID is stored before each POST and sent to Intuit. Safety does not depend on an
unverified provider deduplication window: there is no automatic timeout/5xx retry of financial
writes and no exactly-once guarantee across arbitrary remote failures. Known-completed write
receipts support recovery; conflicting/unknown outcomes require reconciliation.

`qbo_export_locks` protects the entire order operation, including party lookup and link creation,
so simultaneous different payloads cannot both take the create path. A normal completion/failure
releases its own lock. A process crash retains it for investigation; age alone does not unlock it.
The existing accounting mapping/tax/default-account beta limitations still apply. Background
auto-push is best effort: the order-save response does not confirm remote export, and failures
(including an active-export conflict) are logged. Durable scheduling/coalescing of later edits,
user-visible export failure status and operational alert acceptance remain engineering work.

## HTTP retry-cache boundary

The general idempotency cache includes the accounting connection ID, saved company/environment
and runtime environment in its fingerprint. An old connection's success cannot be replayed as a
current-company export; old unbound cache entries fail closed on fingerprint mismatch. Accounting
409 responses are not cached, so a genuinely temporary lock conflict can be retried with the same
key after resolution. This cache is separate from the durable financial-write journal: it cannot
clear an uncertain remote outcome or replace its reconciliation requirement.

## Upgrade and company changes

New `qbo_company_links`, `qbo_write_attempts`, `qbo_export_locks` and `qbo_refresh_locks` tables are
created idempotently; no existing table/column is rewritten or schema-version bump needed.
Generated DB types are updated. All four tables are cloud-only, excluded from sync effects and
sanitized office-PC snapshots; the legacy `qbo_links` table remains excluded too.

An old connection without a saved environment must reconnect before exports. Old `qbo_links`
rows lack reliable company provenance: preserve them, hide them as current-company links and
block affected exports before any external write. Do not guess their realm from the current
configuration or delete them merely to make a push succeed. Existing legacy records need a
reviewed company reconciliation/migration before this integration is enabled after upgrade.
There is no new public endpoint to clear locks, adopt legacy IDs or bypass an uncertain result.

Switching company creates a separate link namespace; returning to an already known company
reuses its scoped IDs. Reconnect to the same company retains its receipts and ambiguous outcomes.
No provider/customer record is deleted on disconnect or company change.

## Rollback restriction

Do not run the older QuickBooks adapter against these new exports while financial writes remain
enabled. It does not understand company-bound links or durable write outcomes and could submit a
new create for a record the newer adapter already exported. A schema that still opens is not proof
of safe behavioral rollback. Pause exports, preserve all receipts/links, reconcile accepted remote
writes, and use a verified compatible application/data snapshot or a forward fix. Rehearse the
plan on an isolated restore before a live rollback; remote invoices/bills are not undone by a DB
restore.

## Engineering reconciliation procedure

This is a restricted operator procedure, not an instruction for the owner to edit SQL. Rehearse
on an isolated restore and record evidence before authorizing a live repair:

1. Pause automatic exports and identify the tenant, environment, realm, order/party key,
   connection generation, request ID and attempt/lock timestamps. Verify no active worker still
   owns the operation. Take a compatible DB/upload/config backup.
2. Inspect the matching company in Intuit using authorized accounting access. Check request ID,
   document number, amount, party, timestamps and remote ID/SyncToken; names or document numbers
   alone may be non-unique. Establish whether a record exists, was rejected or remains unknown.
3. If accepted, prepare a narrowly scoped repair that binds the verified remote record to the
   correct company and retains the accepted receipt. If definitely not accepted, prepare a
   reviewed transition permitting a new attempt. Leave genuinely unknown outcomes blocked.
4. Validate the repair on the isolated restore; record before/after values and the approval/case
   reference. Apply only the reviewed tenant/company/operation change, then verify a controlled
   export and restore automatic work deliberately. Do not broadly clear journals or locks.

Automated repair/adoption tooling, actual provider sandbox behavior, real network cancellation,
long-running outage/capacity tests and accountant reconciliation acceptance remain engineering/
release work. This increment fails closed rather than inventing those approvals or transferring
implementation work to the owner.

## Data and validation

Company keys, operation identifiers, payload hashes, request IDs and lifecycle timestamps are
security/accounting metadata. Receipts include minimal remote identifiers/optional document
numbers. They contain no access/refresh token or raw provider body. Tokens remain encrypted in
settings. Retention and erasure must preserve financial/audit and duplicate-prevention duties;
there is no automatic journal cleanup policy in this increment.

`tests/quickbooks-lifecycle.test.ts` exercises delayed refresh/401/query/write results, parallel
exports, pre-existing durable refresh-lock admission, credential CAS, transaction rollback, company switches,
interrupted locks, uncertain outcomes, legacy quarantine, receipt recovery, malformed responses,
separate tenant DBs and actual sanitized snapshots. Network responses are simulated at the
adapter boundary; real SQLite, connection guards and journal logic execute. This is not a live
Intuit test or evidence that every financial operation in the app is idempotent.

Sources reviewed 18 October 2026:
[Intuit's official OAuth Node client](https://github.com/intuit/oauth-jsclient#refresh-access_token)
requires saving/using the latest returned refresh token. Intuit's
[OAuth guide](https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0)
and [REST features](https://developer.intuit.com/app/developer/qbo/docs/develop/rest-api-features)
were opened, but the research tool only received their JavaScript loading pages. Provider request-ID
and concurrency behavior must therefore be confirmed in sandbox; no detailed contract is inferred
from unreadable pages. Locks, generation checks and conservative reconciliation are local design
choices, not claims of provider certification.
