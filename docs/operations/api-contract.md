# API compatibility and inventory

The current protocol is the existing `/api` REST interface. Desktop, mobile and installed-PC
sync clients share it. There is no complete OpenAPI specification yet; the per-module references
in `docs/reference/backend/` and registered-route security regression test are the current
inventory. Do not describe that inventory as a complete machine-readable contract.

Preserve field meaning and existing routes when adding features. Validate writes on the server;
never rely on UI permissions. Additive fields must not expose credentials or personal data to
new readers. For incompatible changes, introduce an explicitly versioned route, support old
installed clients through a documented migration period, and obtain an owner-approved retirement
date before removing the old route. The release checklist must identify affected offline clients,
rollback limitations and database migration requirements.

Before claiming contract completeness, generate an OpenAPI inventory from actual registrations,
attach real request/response schemas and permission requirements, and validate it against route
coverage. Do not manufacture permissive schemas merely to reach a documentation percentage.

## Creation retries (19 October 2026)

POST /api/signup and authenticated POST /_platform/api/tenants optionally accept an
Idempotency-Key UUID v4. The updated forms send one random key per page/modal and reuse it on
retry. Same scope/key/parsed body returns the original completed 201 with Idempotency-Replayed:
true for 24 hours, behind the current route gates. Different details, expired keys or unavailable
workspaces return 409; invalid key format returns 400. Errors are not cached. No-key clients
retain the existing behavior and must reconcile uncertain acknowledgements before creating again.
This is not a general API idempotency/OpenAPI completeness claim. The full storage, password
verifier, competing-writer, retention and recovery contract is in workspace-onboarding.md.

## Owner alert status (19 October 2026)

The authenticated console mail responses add outbox: up to 30 recent event IDs, kind
(signup/inquiry/payment), source_id (null for signup), tenant slugs (empty for inquiry),
state/attempt counts, safe error codes and timestamps. Queued message/recipient/credential
binding is omitted. Console API responses use Cache-Control: no-store, including errors/auth
denial. Existing auth/fresh-proof policies apply; no new mutating retry/resend route is added.
Signup 201 means catalog/local setup/eligible alert intent committed, not provider/inbox delivery.
An enqueue write failure rolls creation back; notification uncertainty after commit never rolls
the workspace back. See owner-alert-outbox.md for exact scope, states and limitations.


Public inquiry and tenant payment-report 201s commit source and eligible alert intent together.
Payment proof/2307 bytes, reporting audit, derived invoice state and response preparation are
included; an enqueue/storage failure rolls everything back and returns the correlated generic
error. Existing schema/auth/tenant/users.manage/online gates still apply. Disabled/off/recipientless
alerts do not block a valid source and create no later backlog. Payment reporting is pending
review, not payment confirmation. Requests outside covered inquiry/payment keyed contracts
can create separate sources; reconcile after a lost response outside the keyed payment contract below.
See business-alerts.md and payment-report-retries.md.


## Keyed tenant payment reports (19 October 2026)

The online payment-report POST optionally accepts a random UUID-v4 Idempotency-Key. After current
tenant authentication/users.manage and upload parsing, it compares normalized report fields and
proof/2307 MIME+bytes. Same tenant/actor/key/details returns original 201 with Idempotency-Replayed:
true and no-store. A successful receipt shares the source/proof/audit/invoice/alert transaction.
Changed details/invoice, expired tombstone, unavailable source or known old generic cache entry
returns 409; validation fails without saving a receipt. Replay is the original snapshot; GET
Billing returns current review/payment state. No-key behavior is unchanged. This supersedes the
preceding payment no-receipt limitation only for covered keyed requests. See payment-report-retries.md.


## Keyed public website inquiries (19 October 2026)

POST /site/inquiry optionally accepts a random UUID-v4 Idempotency-Key after current host,
schema, honeypot and rate-limit gates. Parsed normalized details bind source/eligible alert/
receipt in one catalog transaction. Exact matching retry returns only 201 {ok:true}, no-store
and Idempotency-Replayed: true; changed/expired/unavailable source conflicts with 409 and no
private echo. Saturated asynchronous verifier budget returns authored 503/Retry-After: 5 without
a source write. No-key/new-key/new-page requests can still duplicate. The five/hour per-IP
limiter counts replay attempts. Website retains one key even after an edit/error; restore
original details after an uncertain committed mismatch. See inquiry-retries.md. This supersedes
earlier no-receipt inquiry limitations for covered keyed requests only.

Website inquiry attempts additionally abort fetch/body reading on a 20-second application timer.
The browser retains the key/draft and offers retry; abort never means the server rolled back.
Browser suspension can delay timers. This does not add deadlines to other public forms.
