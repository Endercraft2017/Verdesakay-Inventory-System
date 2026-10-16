# Second production-readiness audit — 16 October 2026

**Release decision: not an unconditional production sign-off.** This pass fixes additional exploitable
code paths and reconciles the newer application, but the full handbook still contains failed and
unverified controls. Passing automated tests does not establish legal approval, live recovery,
physical-device safety or every resource-level permission decision.

The [233-control scorecard](production-scorecard.md) is the complete checklist, with severity,
evidence, failure scenarios and resolutions. [Owner actions](../OWNER-ACTIONS.md) separates
account/business decisions from engineering work. [Validation results](validation-results.md)
records command outcomes and their limits.

## Scope and source

The starting `production` branch was `1815c8a`. Its earlier evidence covered an older source
snapshot. The requested `restructure/module-architecture` branch had meanwhile advanced by
hundreds of changed files, adding billing, the public website, file offload, forms/HR history,
MFA enforcement and many mobile warehouse workflows. Those changes were merged and their
security boundaries reconciled. A further sale-line allocation fix was included at
`495db101c3efbe4e4546221fed2db3af233b00aa`. This is the source cutoff for this audit; later source
commits require their own review. The audit branch retains both source history and audit fixes.

Stack: TypeScript/Express, Node's SQLite with a database per tenant and a separate platform DB,
Zod, bcrypt and hashed opaque sessions; desktop browser, warehouse PWA, Capacitor Android shell
and Electron/launcher distribution. Optional SMTP, Web Push, QuickBooks, an OpenAI-compatible AI
provider and S3-compatible storage are separate trust boundaries. Billing currently uses bank
transfer/GCash evidence and authenticated operator confirmation, without an automated payment
webhook. Custom roles and per-user grants are resolved from current server data.

Checks used throwaway databases, synthetic users/files and local servers. No production data was
changed, no live load/active scan was performed, and no live deployment settings were changed.
The handbook's embedded agent instructions were treated as reference material; the user's
explicit request authorized code fixes, testing, documentation and pushing `production`.

## Additional defects fixed

| Severity | Failure and concrete scenario | Resolution and regression evidence |
|---|---|---|
| Critical | An AI analytics user could issue custom SELECTs against settings or quoted credential tables, bypassing the intended predefined report boundary | Disable arbitrary SQL at discovery and execution; predefined permission-scoped reports remain. `src/modules/ai/ai-analytics.ts`, `tests/ai-analytics.test.ts` |
| High | A tenant-controlled AI base URL could receive the fallback platform provider key | Environment-key fallback is valid only for the canonical provider endpoint; tenant endpoints need tenant keys. `ai-config.ts`, `tests/ai-config.test.ts` |
| High | Credential-bearing AI requests could follow user-controlled destinations or wait on unbounded bodies; newer message previews reintroduced unpinned DNS lookups | Public-address DNS validation pinned to the actual connection, no redirects, bounded bytes, schema validation, 30-second calls and 120-second chat deadline. `shared/public-fetch.ts`, `ai.routes.ts`, AI/public-fetch tests plus `tests/message-preview-security.test.ts`, which exercises the actual preview route |
| High | `api_key` and deeply nested credentials could enter activity metadata; older plaintext metadata could be read back | Broaden redaction, stop at the depth bound, and redact legacy metadata on read without rewriting evidence. Existing keys/logs/backups still require exposure assessment and rotation. `shared/activity.ts`, `core/activity.routes.ts`, activity tests |
| High | A submitted push endpoint could make the server send to an arbitrary destination | Restrict to supported vendor HTTPS hosts on registration and delivery, cap subscriptions and bound send time. `push-endpoint.ts`, push security tests |
| High | A raster MIME with a JavaScript filename could be stored as a same-origin executable asset; arbitrary document MIME could be served as script | Canonical raster extensions and safe download MIME/disposition; unknown legacy attachments are non-executable downloads. Browser probes verify uploaded scripts do not execute. Attachment, HR, message and file-response paths |
| High | An old session could remain usable after a password or access change | Password replacement revokes all sessions and clears cookies. Role/permission changes revoke affected sessions. Browser/native sign-in flows handle reauthentication. Auth, sessions, access and Playwright tests |
| High | Pending MFA enrollment could be completed from another session or long after password confirmation | Preserve the source branch's challenge/recovery/enforcement UI; bind pending enrollment to its session, expire after ten minutes and limit confirmation attempts. New enrollment metadata never replicates to installed nodes. MFA tests plus desktop/mobile browser enrollment/recovery |
| High | A malformed workspace identifier could escape the intended database directory | Validate before opening any tenant connection. `shared/db.ts`, `tests/production-security.test.ts` |
| High | Public policies bypassed security middleware; unknown metadata-like URLs returned a 200 app shell | Mount policies after headers, apply deny framing, and return proper unknown-page/API 404s. ZAP before: 1 High/4 Medium/2 Low; after: 0 High/2 Medium/0 Low. Regression test verifies the metadata path and policy headers |
| Medium | Clearing AI conversation erased useful action context | Separate append-only hash audit events with actor, tool, phase, request ID and time; ordinary UPDATE/DELETE blocked. It is not an externally immutable full transcript. `ai-audit.ts`, `tests/ai-audit.test.ts` |
| Medium | Partial edits could silently clear department, supplier or job-order relationships | Preserve omitted optional IDs; explicit null still clears a permitted relationship. Schema and workflow regression tests |
| Medium | New form-record creation ran idempotency twice, refusing its first submission | Keep route access checks before a single deduplication boundary. Preserve local-only sync receipts and reject changed payloads/in-flight retries. Form sales, order, QA hold and idempotency tests |
| Medium | Strict operator reset validation rejected its legitimate owner ID; public company login passed an internal company ID into a strict credential schema | Validate the operator request as its own schema; resolve then remove the company routing field before normal authentication. Company/platform tests |
| Medium | Raw route-local 500 JSON could expose exception details; malformed view cookies caused a 500 | Generic correlated 500 responses, redacted structured request/error logs, safe cookie parsing and trusted reset-link origins. Remaining 400/503 paths remain separately tracked |
| Medium | Mobile recovery tests assumed IndexedDB/UI completion within 80 ms | Wait for observable saved/retry/confirmation states and close the recreated window. All mobile frontend tests rerun; no business assertion removed |

Original audit protections also remain: tenant-scoped HttpOnly browser cookies and CSRF checks,
nonsecret PWA metadata, authenticated/revocable WebSockets, actor-bound offline operations,
current-role permission checks, independent tenant fallback encryption keys, bounded provider
requests, one-use QuickBooks state consumed before provider exchange, and production HTTPS checks.
The public homepage now hands off a cookie/nonsecret marker rather than writing bearer credentials
to browser storage. Native bearer persistence remains a separate unresolved control.

## Read-only connected-service evidence

Railway project **ERP** matched this repository. At inspection, the app service had one production
environment, one replica in Singapore, `/api/health`, a persistent `/data` volume, and a successful
source deployment at `d3d54aa`. The source branch subsequently advanced to the cutoff above.
Variable **names** showed backup/encryption/offsite configuration and file offload; no secret
values were retrieved. Configuration presence does not prove successful backups or immutable storage.

Two concrete delivery gaps were verified: Railway follows `restructure/module-architecture` with
`checkSuites=false`, and GitHub reports `production` as unprotected with no required status checks.
The rulesets API reports a plan restriction for this private repository; detailed protection reads
also require unavailable administration permission. Do not publish the repository to bypass that
restriction. Railway tracing/auto-instrumentation were disabled at inspection.

Public domains were visible in Railway, but the workspace proxy refused the ordinary HTTPS checks.
That refusal is not evidence the app is down. Live TLS/headers, WAF, DNS proxy behavior, email DNS,
backup object locks and alert delivery therefore remain unverified. No URL or concurrency estimate
is needed to complete the code review; representative hosting/capacity and recovery checks remain
separate release evidence.

## Remaining release blockers and engineering limits

1. **Critical — exposed historical credentials:** a real removed bearer artifact remains in Git
   history, and earlier activity metadata could contain AI credentials. Revoke affected credentials,
   assess logs/backups and coordinate history cleanup. Removing current text alone is insufficient.
2. **High — release enforcement:** protect the branch and require checks before deployment; create
   a separate staging environment. The audited branch is not the live source. Promotion requires
   a deliberate cutover with a rollback/recovery rehearsal.
3. **High — recovery and operations:** verify a complete restore of platform/tenant data, durable
   and offloaded files, configuration and keys; measure recovery time/data loss. Confirm alert
   delivery, monitoring ownership, storage privacy and backup deletion protection.
4. **High — remaining application work:** native bearer credentials still lack an OS-backed vault;
   owner-console MFA and fresh privileged step-up are incomplete; API validation/error contracts
   are not complete across every route; privacy deletion/export across offline copies, integrations
   and retained records needs a tested lifecycle. These are engineering tasks, not tasks the owner
   should be expected to implement personally.
5. **High — AI and cost assurance:** production business mutations are blocked, but complete output
   privacy evaluation, scoped automation credentials, interrupted audit outcomes and atomic per-user
   spend allocation are not established. Keep AI disabled for regulated/sensitive use until the
   appropriate data/vendor and output controls are approved and tested.
6. **High — dependency/security gates:** compatible vulnerability fixes were applied. A node-forge
   verification advisory has no available fix; only local certificate creation/signing is used by
   this app, not the affected verification API. The raw npm gate remains red. Historical-secret
   scanning can also remain red. Do not call CI green or suppress these findings to ship.
7. **High — legal/business approval:** the policy and B2B contract pack is draft. Fill the actual
   legal entity, jurisdiction, contacts, vendors/regions, retention periods, refund rules and service
   commitments, obtain appropriate review and record approval/acceptance. No legal certification is
   supplied by generated templates.

Other failed handbook controls include complete API/version documentation, coverage thresholds,
query/cache instrumentation, uniform optimistic concurrency, circuit breakers/worker retries,
canary rollback and product activation metrics. Their concrete scenarios and resolutions are in
the scorecard. The handbook includes architectural and commercial maturity goals; a test count
cannot turn these missing controls into passes.

## Documentation coverage

Public drafts: privacy, terms, refunds, security/vulnerability reporting, data rights and AI notice. Links are available from tenant login, the public website/signup and Billing; tenant-prefixed policy routes are regression-tested.
Governance templates: DPA, MSA/order form, SLA, data inventory/retention/deletion process, acceptable
AI use, vendor/access/patch review and security questionnaire. Operations: incident/breach response,
backup/restore, rollback, overload, support escalation, release checklist and API compatibility.
Documents are linked from the product or repository index as appropriate. They deliberately expose
pending owner/legal approval instead of inventing guarantees.
