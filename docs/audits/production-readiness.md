> Historical first-pass report. The current source reconciliation, additional defects, validation and release decision are in [second-pass-audit.md](second-pass-audit.md). Do not use the older totals below as final evidence.

# Production readiness audit — 16 October 2026

23 October dependency follow-up: the formatter advisory was withdrawn upstream.
Fresh runtime and explicit full-root npm scans return **one high / zero moderate**;
the earlier moderate counts were not cleared by a delivered fix. The candidate
parser override was discarded; original dependencies remain. See
[disposition](dependency-audit.md), [research/decision](dependency-parser-contract.md)
and [validation](validation-results.md). The overall release hold remains.

**Release decision: not yet approved for unrestricted production use.** This branch contains audited hardening and reproducible tests, not a certificate that all 233 controls are satisfied. Remaining security, operational and owner/legal decisions are listed explicitly in the scorecard. A passing test suite does not establish production readiness by itself.

## Scope and source

Repository: Endercraft2017/Verdesakay-Inventory-System. Audited source is local `restructure/module-architecture` at `ab1b682aa372dce1fae3c6af904116edded34c4a`. The fetched remote branch was `65ea5ff78bfc3efa631bf90938917aed172b0dbe`; the local branch also contains `8155440` and `ab1b682` (tenant-path/cutover/subscription work). Both local commits are deliberately preserved. The initially checked-out `work` branch was not the requested source and was not used as the audit base.

The supplied Production Readiness Audit Handbook was used as a checklist, with stack-specific translation. Its attached-agent instructions were reference material; the operator's request authorized the audit, fixes, testing and creation/push of a `production` branch. No production databases were opened for tests, no live service was scanned, and no hosting deployment or customer messages were performed. Dates in this report use Asia/Manila; raw tool timestamps may be UTC.

All 233 checks are individually recorded in [the scorecard](production-scorecard.md), with machine-readable [JSON](production-scorecard.json). Broad controls stay UNVERIFIED when only part is tested. FAIL entries include severity, evidence/location, a concrete scenario and a recommended fix. Enterprise/product recommendations are distinguished from directly exploitable defects; they do not all imply the same launch risk.

Second audit and newly found defects: [second-pass-audit.md](second-pass-audit.md). Current remediation details and owner handoff: [remediation-followup.md](remediation-followup.md) and [OWNER-ACTIONS.md](../OWNER-ACTIONS.md). The scorecard is updated conservatively; partial controls remain open.

## Application map

| Area | Observed implementation |
|---|---|
| Backend | Node.js, TypeScript/tsx, Express 4, Zod, Kysely helpers and synchronous node:sqlite |
| Data/tenancy | One SQLite database per tenant; separate platform catalog/operator DB; AsyncLocalStorage request scope; disk uploads; WAL and foreign keys |
| Authentication | bcryptjs passwords; opaque random DB-backed sessions; HttpOnly web cookies and native bearer compatibility; 12h ordinary sessions, 4h shared sessions with 30-minute idle limit; roles + permission overrides |
| Clients | Vanilla JS desktop web app, mobile PWA, partial Electron Windows server/client and partial Capacitor Android shell |
| Business modules | Inventory, orders/delivery, manufacturing/QC/repairs, purchasing, HR/timekeeping, payroll/PH statutory calculations, accounting, files/forms/templates, messaging/tasks/announcements |
| Integrations | Configurable OpenAI-compatible AI endpoint, tenant-scoped SQLite FTS retrieval, BYO SMTP, Web Push, QuickBooks OAuth/export, encrypted S3-compatible offsite backups |
| Billing | Owner-managed PHP monthly quotes, entitlement and tenant quotas; no payment gateway/card checkout/webhook processing |
| Deployment | Railway config and standalone HTTPS/LAN modes; persistent local storage; partial offline sync/site-host election. Actual hosting/account/volume/firewall settings not provided |
| Roles | Platform operator separately authenticated; tenant administrator and configurable staff/manager/warehouse/production/QC/QA/HR/payroll/delivery permission bundles |
| Tested runtime | Node 24.19.0 on Linux and installed Chromium. CI config also targets Node 22; Windows/Electron/Android/iOS binaries were not built or exercised here |

## Highest-priority remaining release work (updated after remediation)

1. **Protect money and business actions.** Production AI tool discovery and execution now block business mutations and outbound communications; authorized reads, generated reports and form proposals remain. Verify NODE_ENV=production on the real host. Shared optional AI token caps are not hard per-user spend reservations; confirm provider billing caps. No real provider spend settings were available.
2. **Protect employee/customer data.** Browser and console authentication now use HttpOnly cookies with CSRF checks; script CSP uses fresh nonces, and access/password changes revoke sessions. Native bearer credentials still need OS secure storage; ordinary sessions live 12 hours. Optional tenant authenticator MFA now exists; mandatory enrollment, owner-console MFA and fresh privileged step-up remain missing. Real-device/print/PDF coverage is incomplete. The historical token artifact needs an owner-verified invalidation/exposure assessment.
3. **Prove recovery and operations.** Establish separate staging, live encrypted offsite/immutable backups, named operators, acceptable RPO/RTO, a dated full restore/rollback drill, external uptime/error alerts, required CI checks/branch protection and target-volume load results. Repository features/configuration cannot prove these are actually enabled.
4. **Approve personal-data handling.** Public draft policies are now linked in both login shells; B2B contract templates, data inventory/rights/retention procedures, security ownership, recovery and incident runbooks are in docs/policies, docs/governance and docs/operations. The owner must fill jurisdictions, contacts, vendors, retention periods and commercial terms and obtain legal approval. Rights handling remains manual. Do not infer HIPAA/GDPR/SOC 2 compliance from code or draft documents.

These items prevent an unconditional production-ready statement. Other checklist gaps, including framework preference, opaque public IDs, CDN strategy, cohort analytics and API versioning, should be prioritized according to actual customer/release requirements rather than treated as equal-severity blockers.

## Verified defects fixed in this branch

| Finding | Before / concrete failure | Hardening and evidence |
|---|---|---|
| Critical response replay / account takeover path | An Idempotency-Key could retrieve another request's cached JSON before authentication, including a cached login token, or replay an unrelated route's response | Authentication precedes lookup; actor-scoped hashed key, method/URL/JSON/role/department/permission binding; no auth/signup/sync response caching; in-flight retry exclusion; legacy key conflicts prevent duplicate stock execution during upgrade. `tests/idempotency.test.ts` |
| Recovery enumeration/flooding/reuse | Recovery returned sent/reason account clues, used a 60-minute token and attacker-influenced Host/forwarded-proto links; sibling links survived | Generic body, 15-minute hashed single-use links, account/IP budgets retained through housekeeping (hashed attempts expire after one day), configured origins, invalidated sibling links on issuance/change/reset, reset password + token consumption + session revocation in a transaction. `tests/auth-reset.test.ts` |
| WebSocket session revocation | An authenticated socket could continue receiving after logout/session disable/expiry because auth was checked only at connection | Revalidate before inbound messages, outgoing delivery and heartbeat; close revoked sockets; bound frames to 64 KiB. `tests/production-security.test.ts`, `tests/tenant-path.test.ts` |
| Cross-tenant fallback encryption key | A process-global cached fallback key from the first tenant was reused for later tenants | Resolve the fallback key within the active tenant each time; no shared process cache of tenant-local keys. Cross-tenant decrypt regression in `tests/production-security.test.ts` |
| Link-preview SSRF rebinding | DNS was checked before fetch but fetch could resolve the hostname again; mapped IPv6/private ranges were incomplete; body timeout was incomplete | Resolve once per hop and pin the validated address in an undici Agent while retaining original-hostname TLS verification. Bound body/time, reject mixed private DNS, reserved/mapped-IP targets, URL credentials and oversized bodies; revalidate redirects. `tests/public-fetch.test.ts` |
| QuickBooks callback HTML / DB creation | Public callback reflected arbitrary error HTML and could open an unknown tenant DB from supplied state; nonce consumption occurred after async exchange | Generic escaped output, known valid workspace and nonce checks, consume state before async provider work, provider timeouts. `tests/quickbooks.test.ts` |
| Unsafe bootstrap and operator reset | Fresh production could seed admin/admin123 and startup could log its password; operator password reset did not invalidate sessions | Require a configured strong bootstrap password for fresh default production; random temporary seed for provisioned tenants; refuse production startup with known default admin credentials; remove password output; revoke operator sessions on reset |
| Unbounded provider calls / AI response shape | AI, SMTP, S3 and QuickBooks calls lacked explicit application time bounds; provider payload was trusted | Bounded network timeouts, no automatic credential-bearing redirects for HTTP providers, SMTP STARTTLS requirement, AI response schema/count/length bounds and per-tenant/user chat limiter. Total-loop budgets and full output policy remain open |
| Browser security/accessibility | Private API cache headers absent; frame protection weaker; malformed preference cookie could throw; login contrast insufficient, mobile zoom disabled and Quick Orbit role invalid | API no-store, frame DENY, HSTS behind TLS proxy, safe cookie decode; darker desktop accent, restored zoom, correct grouped-button role, mobile worker v69. Playwright/axe passes on tested login pages |
| Delivery gates | Only desktop release workflow existed; new subscription route missing sync-class exemption in static inventory | CI for typecheck/Vitest/browser/axe/advisories/secrets; weekly Dependabot; explicit cloud-only subscription exemption. Actual remote required-check enforcement remains to be verified |

## Validation and practical limits

See [validation-results.md](validation-results.md) for recorded command results. All integration/browser fixtures use fresh temporary database/data/upload/backup paths, preserving the workspace's real data. No paid AI, live-provider email or QuickBooks calls were made. Provider integrations generally use mocks; the narrow payslip-email follow-up additionally uses real Nodemailer and a local TLS SMTP capture server with synthetic data. See [email contract](payroll-email-contract.md) and [recovery runbook](../operations/payroll-email-release.md). The load probe makes only local requests and has no remote-target option.

### Playwright and accessibility

Reproducible tests cover desktop wrong-password + keyboard sign-in, inventory creation with apostrophe/emoji, one-time stock retry, server-verified logout; 360px mobile Home/Work/Clock/Inbox/Profile navigation and offline reload; hostile CORS, SQL-like login, oversized username and malformed cookie; axe WCAG 2/2.1 A/AA scans of desktop and mobile login pages. Initial contrast/ARIA/zoom findings were fixed. This is not a complete WCAG certification or every-business-screen browser audit.

### OWASP ZAP

ZAP 2.17.0 standalone Java active scan completed against the isolated HTTP fixture and discovered 82 endpoints. The Docker image download first failed on daemon storage; using the standalone distribution completed the scan without changing runtime network policy.

Original pre-remediation results: one High `90034 Cloud Metadata Potentially Exposed`, one Medium `10038 CSP Header Not Set`, no Low and three Informational alert types. The High was a **confirmed false positive in this fixture**: `GET /metadata/instance?password=ZAP&username=ZAP` with `Host: 169.254.169.254` returns the same local HTML SPA shell as `/` after normalizing fresh script nonces, not cloud metadata. A regression test compares nonce-normalized bodies and checks known metadata fields. There is no nginx metadata proxy in this fixture. This does not prove a real deployment's proxy/origin configuration is safe.

The original missing-CSP gap is now resolved. The repeat scan flags two residual CSP Medium findings (broad HTTPS image sources and inline styles); the informational API comment is not a secret, mobile user-agent differences are intended, and the SPA notice correctly warns that a traditional spider does not cover authenticated JS business flows. Authenticated local APIs were tested separately by Supertest/Playwright. No external staging/production scan was authorized or run.

### Secret and dependency scans

Gitleaks 8.24.3 scanned 268 historical commits (~13.74 MB): 11 detections. Ten were reviewed synthetic push test credentials, a test password or the token alphabet; `.gitleaksignore` contains only their exact historical fingerprints. The remaining real bearer-token JSON artifact was committed on 20 July and removed later by `ec4ecbf`. It is not printed in reports. The original server's expiry/revocation/access records were not inspected; this remains a history/exposure finding, and a full-history CI scan can correctly fail on it until the owner resolves it.

Separate scans of `public/` and `web-console/` returned no detections. Pattern scans cannot establish that no unknown secret has ever existed. Lockfile license metadata was inventoried; MPL-2.0 and unknown entries need distribution-context review, not an automatic licensing conclusion.

The operator subsequently approved npm metadata transmission. All three lockfiles were scanned and fixed: root is now 0 Critical / 1 High / 8 Moderate, launcher 0 Critical / 0 High / 8 Moderate, and mobile has 0 advisories. The root runtime-only scan reports one unpatched node-forge signature-verification advisory; application call-site inspection finds only local certificate creation/signing, not the affected verification operation. See [dependency-audit.md](dependency-audit.md) for before/after counts, reachability reasoning, exact versions, build-tool findings and the nonzero raw CI advisory gate. No zero-vulnerability claim is made.

### Local capacity probe

450 mixed authenticated read requests over 100 synthetic stock items, at 5/15/30 concurrent clients, returned zero errors. Recorded p95 latency was approximately 9/28/65 ms; p99 approximately 10/34/112 ms. This short Linux local-loopback read probe runs with test-mode rate limits disabled and does **not** establish production capacity. Realistic large HR/payroll/manufacturing datasets, writes, exports, upstream outages, production limits and expected peak demand remain to be measured.

## Reproduction

```sh
npm ci --no-audit
npm run typecheck
npm test
npx playwright install chromium
npm run test:e2e
npm run test:load
```

On hosts with a system browser, `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium npm run test:e2e` selects it. Browser artifacts/reports go to ignored `work/`. Socket/network permissions are needed for local HTTP/WebSocket/UDP tests. Network-denied sandbox results must not be mistaken for product failures. Native/Windows/real-device testing requires those platforms.

## Deployment compatibility notes

- Set `NODE_ENV=production`. For a fresh default workspace, set a unique `ADMIN_PASSWORD` of at least 12 characters before first startup. Existing active `admin/admin123` credentials cause production startup to fail until changed. Never use the development login outside disposable test/development fixtures.
- Configure `PUBLIC_APP_URL` for a single-tenant reset link origin, or valid `TENANT_PATH_HOST`/`APP_DOMAIN` for registered tenants. Without a trusted origin, recovery returns the generic response but does not send a link. An SMTP/configuration failure must be investigated by an administrator through logs/settings.
- For installations without MAIL_SECRET_KEY/APP_SECRET, secrets previously encrypted through the cross-tenant cached fallback key may require administrator re-entry from the original secret store after this fix. Do not guess or copy another tenant's key. Installations with a configured shared master key retain that key; plan any key rotation/migration separately.
- SMTP now requires encrypted transport (implicit TLS or STARTTLS); plaintext-only SMTP servers must be upgraded.
- An idempotency key written before this hardening produces a safe 409 instead of re-executing or replaying an unbound response. Check the original action's status before deciding whether to submit a genuinely new action. JSON replays must use the same body/URL and current access scope; multipart keys identify the whole upload, without content comparison at pre-parser middleware.
- In-flight deduplication is scoped to one process. Do not run multiple authoritative app processes against the same SQLite files. This audit does not approve the partial sync/failover/Electron/native feature set for customer rollout.
- Back up databases and uploads before introducing the security branch. No schema migration was required by these fixes. Keep the pre-upgrade snapshot and recorded release rollback procedure; no automatic destructive cleanup or history rewrite is performed.
- Publishing a Git branch is not a deployment verification. No Railway resource/domain/variable configuration was changed. Required checks, branch protection, a staging release and owner signoff remain release gates.

## Module and pipeline records

Shared/auth/idempotency/crypto/network infrastructure, core authentication/messaging, platform operator authentication, AI and QuickBooks adapters, and client shell accessibility changed. No new business module or business-process stage was introduced. The catalog and account-session pipeline describe the new recovery/replay/socket contracts; the public-fetch helper remains shared technical infrastructure.
