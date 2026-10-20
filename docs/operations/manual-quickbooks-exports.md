# Manual QuickBooks export verification and recovery

Implemented 20 October 2026. High scoped gaps reproduced locally: an old session could initiate
an export without recent proof, and manual exports included CKD component prices while automatic
exports excluded them. Review also found missing destination binding and post-await actor checks.
This increment closes those scoped gaps; it does not certify the integration for real accounting.

## Export contract

`GET /api/quickbooks/status` now permits users.manage, orders.edit or purchasing.manage. It
returns existing connection metadata plus a non-secret connection_id for the current generation.
Company/environment/generation/credential availability are observed from one SQLite statement,
so a concurrent change cannot pair a displayed old company with a newer generation. Tokens,
secrets and provider responses are not returned. Connection settings/connect/disconnect and
retry management retain their existing administrator permissions and fresh-verification checks.
Read-only warehouse users do not acquire status/export access.

`GET /api/quickbooks/order/:id/preview` requires order-type edit authority and online execution.
It reads source/order items and destination under one short SQLite read transaction, returning
number, total, Invoice/Bill type, company/environment, connection_id and order_stamp. No provider
call occurs. The stamp is a non-secret source-version hash, not an authorization token. Preview
requires no new identity proof because it only reads already-authorized review data.

`POST /api/quickbooks/push/order/:id` requires:

1. A live authenticated cloud session, the existing online-only sync gate, and the appropriate
   permission for that order type (orders.edit for sale/job; purchasing.manage for purchase).
2. Existing recent identity proof: current password and enabled factor, under the five-minute
   session/credential/policy-bound verification window. A missing proof returns the existing
   403 step_up_required challenge; successful verification retries the original action once.
3. JSON `{ "connection_id": "<reviewed UUID>", "order_stamp": "<reviewed 64-hex version>" }`
   from the preview. Missing/malformed bindings return 400. A changed order or connection,
   including reconnecting the same realm, returns 409 before any provider export call.

Older callers must obtain a preview and supply both fields; they fail closed until updated.
A connection ID is a destination/version condition, not authentication or a secret. Existing
accounting HTTP idempotency keys also bind company/generation and body; a cached receipt is
not proof that a new provider mutation occurred. Settings remain restricted to administrators.

The desktop confirmation displays the order number, connected company, sandbox/production,
current preview total and Invoice/Bill action. It binds the reviewed source version and
destination, and checks the original actor/server/token/view before and after review. It also
uses existing expected-user/server request guards. Cancelling sends no export POST; the preview
itself is a read-only API request. If recent
proof is missing, the existing shared identity dialog follows; its generic account-change label
is unchanged. Cancelling that verification sends no provider mutation. This is recent identity
verification plus a user review, not a signed, one-use authorization of every financial detail.
The preview refreshes an older list, and a source change after preview must be reviewed again.
This conditional source-version check is not cryptographic transaction signing or a one-use
authorization credential. Provider currency/tax interpretation still needs accountant acceptance.

## During provider work

The manual route captures its live actor/credential stamp, session and full current order/item
snapshot. Before each new provider request, including after token refresh and before a 401
retry, the adapter rechecks current connection, live fresh proof, credential/policy fingerprint
and unchanged order/items. Revocation, expiry, role/account/password changes or any order/line
change causes 409 and stops further provider calls. Even benign order edits can conflict.
These snapshots/callbacks are memory-only; no password, OTP, raw session or order snapshot is
added to durable accounting receipts. Original DB tenancy is preserved across awaited work.

A provider write already sent cannot be cancelled by revoking the session. Valid accepted
responses are still recorded as succeeded with their existing minimal receipt/link; do not
replace known acceptance with an invented unknown outcome. If a customer/vendor was accepted
but the actor then changed, preserve that party receipt and stop the subsequent invoice/bill.
Token rotation already in flight may finish and persist the service credential; the revoked
actor still cannot send the next export call. This prevents losing a rotating refresh token.

Failures before send remain safe failed attempts; sent/ambiguous outcomes remain uncertain.
A revoked actor before a retry after a sent 401 can conservatively leave the old attempt
uncertain. The existing no-blind-resend policy remains. Automatic workers use their existing
connection-bound durable intent and policy; they do not borrow an interactive user session.

## Commercial lines

The shared adapter excludes fulfillment_mode=ckd_component for all callers. A priced CKD parent
is exported once; fulfillment components are not separately charged. Existing no-item fallback
and sale/job → Invoice, purchase → Bill mapping remain. This is not approval of every accounting
mapping, tax, rounding or currency configuration. Verify those with the real company/accountant.

## Recovery and release

For 400, reload and obtain a new order preview using an updated client. For authorization/order 409, review
the current source, session and destination, and check any prior provider receipts before
starting again. Do not automatically repeat an entire multi-step export after a partial write.
For unknown/interrupted outcomes, preserve journals/locks and inspect provider records with an
authorized accountant/operator. Do not delete attempts, change operation IDs or reconnect merely
to make an uncertain financial write resend. See quickbooks-lifecycle.md and quickbooks-auto-exports.md.

No automatic reconciliation, write repair, manual bypass, provider acceptance or host rollout
was performed here. Intuit documentation retrieval attempts failed in this research session;
no new claim about provider deduplication duration or request-ID guarantees was adopted. The
conservative local policy remains, informed by HTTP non-idempotent retry semantics and OWASP
server-side reauthentication/transaction-state guidance.

No schema/version/dependency or offline accounting classification changes. Existing credential,
link and receipt formats remain. Previously exported CKD invoices are not automatically corrected; review them with the
accountant before any financial adjustment. Old server versions restore the authorization/component-line
gaps; old clients lack required destination binding. Roll out a compatible server/client pair
in staging first. Supported Windows/native devices, real Intuit sandbox/currency/tax mappings,
provider reconciliation, hosted capacity/restore/rollback and external alerts remain release gates.
Full-control AUTHZ-15 and financial/operational assessments remain open; see the action inventory
and docs/audits/evidence/manual-export-verification.json for exact local evidence and limitations.
