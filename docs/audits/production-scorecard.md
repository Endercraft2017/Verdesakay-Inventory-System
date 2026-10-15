# Production audit scorecard

Date: 16 October 2026 (Asia/Manila). Source: `restructure/module-architecture` at `ab1b682`. All 233 handbook checks are accounted for. Status applies to the complete stated check: a partial test or a new configuration is not a PASS for a broader operational claim.

Counts: {'UNVERIFIED': 126, 'FAIL': 61, 'PASS': 27, 'N/A': 19}

PASS means verified within the stated adapted scope; FAIL is an evidenced remaining gap; N/A means the feature is absent; UNVERIFIED identifies missing evidence or incomplete coverage. The detailed narrative is in production-readiness.md.

| ID | Severity | Result | Requirement | Evidence / blocker |
|---|---|---|---|---|
| FRAME-01 | High | UNVERIFIED | Error handling exists beyond framework defaults: users see helpful, generic messages and fallback states; no white screens or stack traces. | Central generic error handler and API/offline tests exist; every route/database-failure/third-party-failure state was not exercised. Direct exception-return gap remains under API-06. |
| FRAME-02 | High | UNVERIFIED | Development, staging, and production are fully separated: different databases, different API keys, different configuration. | Tests use disposable SQLite/data/upload paths. No live development/staging/production configuration or credential separation evidence was supplied. |
| FRAME-03 | High | UNVERIFIED | Sensitive actions (plan changes, email/password changes, deletions, permission and role changes, admin actions) write an audit record with actor, target, timestamp, and before/after values. | Activity middleware captures actor/target/time and redacted submitted snapshot; login actor fixed. Before/after completeness, tamper resistance and all sensitive actions not fully established. |
| FRAME-04 | Medium | UNVERIFIED | A feature health inventory exists: what is live, what is broken, what is used. Broken-and-used items are prioritized ahead of new work. | docs/modules/catalog.md records real working/partial capabilities; no real usage/support telemetry to classify broken-and-used features was supplied. |
| FRAME-05 | Medium | UNVERIFIED | The product has been used by people who did not build it, without guidance, and "break it on purpose" inputs (blank forms, 10,000-character fields, repeated submits, phone screens) have been tried. | Automated edge tests were run, but they cannot establish usability by independent target users. No user-session notes supplied. |
| AUDIT-01 | High | UNVERIFIED | A dependency vulnerability scan has been run recently, and no critical or high vulnerabilities in reachable code remain unaddressed. | Live npm audit was blocked by automatic approval review pending explicit consent to send dependency metadata to registry.npmjs.org. CI/dependabot configs were added; no zero-vulnerability claim is made. |
| AUDIT-02 | Critical | UNVERIFIED | Horizontal authorization holds: user A cannot read or modify user B's resources by changing IDs in the URL path, query string, request body, or token claims. | Database-per-tenant isolation, route-gate source inventory and broad negative tests were reviewed; critical replay and crypto-scope defects were fixed. Every resource/method/owner combination and every external state has not been exhaustively proven. See tests/access-matrix.test.ts, tenant-path.test.ts, production-security.test.ts and idempotency.test.ts. |
| AUDIT-03 | High | UNVERIFIED | A DAST scan (OWASP ZAP or equivalent) has been run against staging, and high/critical findings are resolved or have documented exceptions. | OWASP ZAP 2.17.0 standalone active scan completed on local synthetic HTTP app (82 discovered endpoints). One High metadata alert reproduced as identical SPA fallback; one Medium missing-CSP gap remains. Authenticated business APIs tested separately; no production-like staging scan supplied. |
| AUDIT-04 | High | UNVERIFIED | CI runs dependency scanning, static analysis, and secret scanning on every pull request, and failures block the merge. | Production-checks.yml adds typecheck, Vitest, Playwright/axe, npm audit and Gitleaks jobs. New remote production branch/protection and required-check enforcement must be verified after push; writing YAML does not establish enforced controls. |
| AUDIT-05 | Medium | UNVERIFIED | Security-sensitive changes get an adversarial review, preferably from a different model or person than the author, before merging. | No live operational evidence was provided; repository/local tests cannot establish this complete control. |
| AUDIT-06 | Medium | UNVERIFIED | Security-questionnaire answers are prepared: encryption at rest and in transit, scan cadence, last pen-test date, incident response plan, data location, and a public security/vulnerability-disclosure page. | No live operational evidence was provided; repository/local tests cannot establish this complete control. |
| AUDIT-07 | Medium | UNVERIFIED | Every AI-generated change gets a short security pass before production (secret scan, auth review, permissions review). | No live operational evidence was provided; repository/local tests cannot establish this complete control. |
| WF-01 | Medium | UNVERIFIED | Code organization follows separation of concerns: no monolithic files mixing routes, business logic, data access, and UI; names describe behavior. | Module architecture exists, but db.ts and several routes exceed 500 lines and mix schema/seed or route/business logic. Size alone is not a sufficient finding; no indiscriminate refactor performed. |
| WF-02 | Low | UNVERIFIED | Dead code is removed: no unused exports, imports, components, or abandoned helper modules. | TypeScript passes; no complete unused-export/dead-code tool run performed across browser globals, Node, Electron and Capacitor build paths. |
| WF-03 | Medium | UNVERIFIED | Automated tests exist for core flows and run in CI; new features land with tests. | Core tests exist and CI workflow now runs them; remote CI execution and feature-PR discipline need independent evidence. |
| WF-04 | Medium | UNVERIFIED | Architecture decisions, local setup, and failure modes are documented and current. | CLAUDE.md, HANDOFF.md, claude_instruction.md and module/pipeline docs reviewed; some statements are stale (planned vs partial). Audit state persisted in work/AUDIT_STATE.md. Source/provenance and review process are not fully verified. |
| WF-05 | Low | UNVERIFIED | AI-assistant instructions, skills, and agent configs in the repo are current, scoped, and from trusted sources. | CLAUDE.md, HANDOFF.md, claude_instruction.md and module/pipeline docs reviewed; some statements are stale (planned vs partial). Audit state persisted in work/AUDIT_STATE.md. Source/provenance and review process are not fully verified. |
| WF-06 | Medium | UNVERIFIED | Long-running agent work uses a persistent state or handoff document and human checkpoints between chunks of work. | CLAUDE.md, HANDOFF.md, claude_instruction.md and module/pipeline docs reviewed; some statements are stale (planned vs partial). Audit state persisted in work/AUDIT_STATE.md. Source/provenance and review process are not fully verified. |
| AUTH-01 | High | FAIL | Authentication uses a vetted provider or framework; there is no custom password storage, token signing, or session crypto. | src/shared/auth.ts:23; custom DB-backed bearer-session implementation using bcryptjs and crypto.randomBytes. |
| AUTH-02 | Critical | PASS | Every token is verified (signature, `exp`, `iss`/`aud`) with a pinned algorithm; `alg: none` and algorithm confusion are rejected; claims are never read from an unverified token. | src/shared/auth.ts:95; translated to opaque random bearer tokens: SQL checks existence, expiry, ended state and active user. JWT claims are never used. |
| AUTH-03 | High | FAIL | Access tokens are short-lived (≤30 minutes); refresh tokens are HttpOnly, expire, rotate on every use, and reuse revokes the token family. | public/js/api.js:14; normal tokens in localStorage, borrowed sessions in sessionStorage; src/shared/auth.ts uses 12-hour ordinary sessions and no refresh-token family. |
| AUTH-04 | High | PASS | Logout invalidates the session server-side. | src/shared/auth.ts:73; tests/sessions-devices.test.ts; tests/e2e/readiness.spec.ts verifies replay after logout returns 401. |
| AUTH-05 | High | FAIL | Session IDs are regenerated on login and on privilege changes; session cookies set `Secure`, `HttpOnly`, and `SameSite`. | src/shared/auth.ts:48 creates a fresh token on login, but role changes do not rotate an existing session; browser tokens are not HttpOnly cookies. |
| AUTH-06 | High | FAIL | Web auth tokens are not stored in `localStorage` or `sessionStorage` or anywhere readable by JavaScript. | public/js/api.js:14; normal tokens in localStorage, borrowed sessions in sessionStorage; src/shared/auth.ts uses 12-hour ordinary sessions and no refresh-token family. |
| AUTH-07 | High | FAIL | Password change, password reset, and reported compromise revoke all of the user's active sessions and tokens immediately. | src/core/auth.routes.ts:135 keeps the current session during password change; reset ends all sessions and operators now revoke on reset. |
| AUTH-08 | High | PASS | Password-reset tokens expire within about 15 minutes, are single-use, and reset requests are rate-limited per email and per IP. | src/core/auth.routes.ts:26; tests/auth-reset.test.ts verifies 15-minute lifetime, sibling invalidation, single use and three requests/account/hour; tests/production-security.test.ts verifies IP throttling. |
| AUTH-09 | High | N/A | Magic-link tokens expire within about 10 minutes, are single-use, and requests are rate-limited per email and per IP. | No passwordless magic-link authentication; password-reset tokens are covered by AUTH-08. |
| AUTH-10 | Critical | UNVERIFIED | Every redirect target taken from user input (login, logout, magic link, OAuth, "return to") is validated against an allowlist after URL parsing, rejecting external, protocol-relative, backslash, and encoded variants. | App view redirects are fixed internal destinations and recovery links use configured origins; local HTTP listener still derives redirect host from Host. Full origin/redirect inventory and runtime settings need verification. |
| AUTH-11 | High | UNVERIFIED | OAuth/OIDC flows use exact registered redirect URIs, a verified `state` parameter, PKCE, and minimal scopes. | QuickBooks OAuth validates known tenant/state and consumes state before async exchange; tests/quickbooks.test.ts. Exact provider registration and PKCE support/configuration were not verified with current Intuit documentation or live account. |
| AUTH-12 | High | FAIL | Login, registration, and reset endpoints have brute-force protection (per-IP and per-account throttling, preferably at the edge). | src/app.ts:204 adds login account/IP and recovery IP limits; signup has only IP throttling; reset token consumption has only IP throttling. |
| AUTH-13 | Medium | UNVERIFIED | Session lifetime, idle timeout, and concurrent-session policy are deliberate and match data sensitivity; users are warned before expiry and their state is preserved on re-auth. | 12-hour ordinary / 4-hour shared / 30-minute shared-idle policies exist; pre-expiry warning, workflow preservation and concurrent-session policy need a complete UX review. |
| AUTH-14 | Medium | UNVERIFIED | If selling to enterprises: SAML 2.0/OIDC SSO is available with per-tenant IdP configuration, and the auth provider's compliance documentation is available. | No SAML/OIDC enterprise identity integration found; whether enterprise SSO is a launch requirement needs the customer profile. Do not claim enterprise readiness. |
| AUTHZ-01 | Critical | UNVERIFIED | Every server entry point (route, RPC procedure, server action, serverless/cloud function, GraphQL resolver) enforces authentication and authorization on the server, from a protected-by-default base. | Database-per-tenant isolation, route-gate source inventory and broad negative tests were reviewed; critical replay and crypto-scope defects were fixed. Every resource/method/owner combination and every external state has not been exhaustively proven. See tests/access-matrix.test.ts, tenant-path.test.ts, production-security.test.ts and idempotency.test.ts. |
| AUTHZ-02 | Critical | UNVERIFIED | Every endpoint that accepts a resource identifier (path, query, body, header) verifies the caller owns or may access that resource. | Database-per-tenant isolation, route-gate source inventory and broad negative tests were reviewed; critical replay and crypto-scope defects were fixed. Every resource/method/owner combination and every external state has not been exhaustively proven. See tests/access-matrix.test.ts, tenant-path.test.ts, production-security.test.ts and idempotency.test.ts. |
| AUTHZ-03 | Critical | UNVERIFIED | Row-level security (or an equivalent enforced data-access layer) is enabled on every table holding user or tenant data, with select/insert/update/delete policies scoped to the owner or tenant. | Database-per-tenant isolation, route-gate source inventory and broad negative tests were reviewed; critical replay and crypto-scope defects were fixed. Every resource/method/owner combination and every external state has not been exhaustively proven. See tests/access-matrix.test.ts, tenant-path.test.ts, production-security.test.ts and idempotency.test.ts. |
| AUTHZ-04 | Critical | UNVERIFIED | Privileged credentials (service-role keys, admin SDKs) are used only server-side, and every query they run is explicitly scoped to the authenticated user or tenant, with validated inputs. | Database-per-tenant isolation, route-gate source inventory and broad negative tests were reviewed; critical replay and crypto-scope defects were fixed. Every resource/method/owner combination and every external state has not been exhaustively proven. See tests/access-matrix.test.ts, tenant-path.test.ts, production-security.test.ts and idempotency.test.ts. |
| AUTHZ-05 | Critical | PASS | Realtime subscriptions, streams, and websockets filter data on the server by the authenticated user or tenant. | src/shared/ws.ts:59; tenant/user socket registry; auth rechecked before sends and inbound messages; tests/tenant-path.test.ts and tests/production-security.test.ts. |
| AUTHZ-06 | Critical | UNVERIFIED | Edge or framework middleware is not the only authorization layer: matchers cover API routes, path variations cannot bypass them, and every handler re-validates the session server-side. | Database-per-tenant isolation, route-gate source inventory and broad negative tests were reviewed; critical replay and crypto-scope defects were fixed. Every resource/method/owner combination and every external state has not been exhaustively proven. See tests/access-matrix.test.ts, tenant-path.test.ts, production-security.test.ts and idempotency.test.ts. |
| AUTHZ-07 | Critical | UNVERIFIED | Admin interfaces require an authenticated session with an explicit admin role on every route, are rate-limited at login, and log every admin action. | Platform auth, login limiter and provisioning log exist (src/platform/platform.routes.ts); MFA/edge configuration and every admin audit operation were not fully established. Tenant login actor attribution was fixed. |
| AUTHZ-08 | High | PASS | Elevated operations check the user's current role or permissions from the source of truth, not a possibly stale token claim. | src/shared/auth.ts:95 joins current users and role permissions on every authenticated request; tests/permissions.test.ts. |
| AUTHZ-09 | High | PASS | The permission model separates permissions from roles and supports scope (own/team/all), enforced at the API layer. | src/shared/roles.ts:73; tests/access-matrix.test.ts and tests/permissions.test.ts cover desk/own-record scopes. |
| AUTHZ-10 | Critical | UNVERIFIED | In multi-tenant systems, every tenant-owned row has a tenant ID, the tenant is resolved server-side from verified identity (never from client-supplied input alone), and every query is tenant-scoped. | Database-per-tenant isolation, route-gate source inventory and broad negative tests were reviewed; critical replay and crypto-scope defects were fixed. Every resource/method/owner combination and every external state has not been exhaustively proven. See tests/access-matrix.test.ts, tenant-path.test.ts, production-security.test.ts and idempotency.test.ts. |
| AUTHZ-11 | Critical | UNVERIFIED | Every shared layer is tenant- and user-scoped: cache keys, search indexes, job payloads, file paths, logs, and vector stores. | Database-per-tenant isolation, route-gate source inventory and broad negative tests were reviewed; critical replay and crypto-scope defects were fixed. Every resource/method/owner combination and every external state has not been exhaustively proven. See tests/access-matrix.test.ts, tenant-path.test.ts, production-security.test.ts and idempotency.test.ts. |
| AUTHZ-12 | High | PASS | An automated cross-tenant and cross-user access test runs in CI. | .github/workflows/production-checks.yml:1; tests/tenant-path.test.ts, tests/access-matrix.test.ts, tests/idempotency.test.ts are in npm test. Remote run still needs to finish after push. |
| AUTHZ-13 | Medium | UNVERIFIED | The tenant isolation model (shared + RLS, schema per tenant, database per tenant) is documented and matches customer contracts and regulatory requirements. | docs/modules/catalog.md documents database-per-tenant; no customer contracts or regulatory obligations were supplied to compare against the model. |
| AUTHZ-14 | Low | FAIL | Public identifiers are non-sequential (UUIDs or similar) to reduce enumeration, in addition to ownership checks. | src/shared/db.ts:326; REST resource paths generally use SQLite integer IDs. |
| AUTHZ-15 | Medium | FAIL | High-risk actions use step-up authentication or contextual signals (new device, unusual location, impossible travel). | src/core/auth.routes.ts:1 and src/platform/platform-users.ts:1 accept a current bearer session without MFA or fresh-password challenge for privileged operations. |
| SECRET-01 | Critical | FAIL | No secrets exist in the current source tree or anywhere in Git history. | Gitleaks history scan: 268 commits, 11 detections; ten exact fixture/alphabet false positives allowlisted. Real bearer artifact in July commit f7f644b, removed by ec4ecbf, remains in Git history. |
| SECRET-02 | Critical | PASS | No secrets are present in client-delivered code: the frontend bundle, public env-prefixed variables, server-component payloads, or mobile binaries. | Gitleaks 8.24.3 dir scans of public/ and web-console/ each returned an empty report. Native shell bundles public assets; compiled APK/EXE scans remain outside this source check. |
| SECRET-03 | Critical | UNVERIFIED | Every secret that was ever exposed (committed, shipped to a client, logged, or shared) has been rotated and the old value revoked. | Known July bearer artifact was removed in ec4ecbf; current source expires ordinary sessions in 12 hours, but original server token revocation, exposure-window access and rotation evidence were not provided. |
| SECRET-04 | High | PASS | `.env` files are ignored by Git; only a values-free example file is committed. | .gitignore:1 ignores .env; git ls-files contains no .env. No credential-bearing example env file was added. |
| SECRET-05 | High | FAIL | Secret scanning runs before code reaches the remote (pre-commit hook) and at the remote (push protection or CI). | .github/workflows/production-checks.yml adds remote Gitleaks scanning; no repository pre-commit secret hook exists and push-protection settings were not inspected. |
| SECRET-06 | High | PASS | Third-party APIs that need secret keys are called from the server (proxy route), never directly from the browser or app. | src/modules/ai/ai.routes.ts:195; src/shared/mailer.ts and src/modules/quickbooks/quickbooks.ts hold provider calls server-side. |
| SECRET-07 | Medium | UNVERIFIED | Production secrets are held in a secrets manager or platform secret store with access control and audit logging, not in committed files or shared documents. | No live operational evidence was provided; repository/local tests cannot establish this complete control. |
| SECRET-08 | Medium | UNVERIFIED | Keys are scoped to least privilege (restricted keys, IP or domain restrictions, per-service database users), and a rotation schedule exists. | No live operational evidence was provided; repository/local tests cannot establish this complete control. |
| SECRET-09 | Medium | PASS | Server-only code is guarded against client inclusion (for example the `server-only` import in Next.js), and server functions live in separate files from client components. | src/ and server.ts are outside express.static(public/); electron packaging explicitly includes backend for the local server, not for browser delivery. |
| SECRET-10 | Medium | FAIL | Secrets never appear in logs, error responses, or analytics events. | src/modules/ai/ai.routes.ts:226 includes provider response snippets in thrown errors; central handler logs Error details. Startup password logging was removed, but no central log redactor exists. |
| API-01 | Critical | FAIL | Every endpoint validates body, query, path params, and relevant headers on the server against an explicit schema with types, lengths, and ranges. | src/shared/validation.ts:1 has broad Zod body coverage, but many handlers use Number(req.params.id) or hand-parsed query parameters without a shared explicit schema. |
| API-02 | Critical | FAIL | Write endpoints accept only an allowlist of fields; unknown fields are rejected; privileged fields (role, plan, permissions, price, tenant, owner) cannot be set by users. | src/shared/validation.ts:1 uses ordinary z.object for most write bodies, which strips unknown fields; only selected schemas are strict. |
| API-03 | Critical | UNVERIFIED | No query is built by string concatenation or interpolation of user input (SQL, NoSQL operators, raw ORM calls, shell commands). | Parameterized helpers and server-side permissions/business logic were sampled; callback reflected HTML was fixed. Full dynamic SQL, per-field response/PII, every scheduled/internal entry and all HTML/email sink coverage require additional complete inventories. Existing suite is evidence of tested cases, not universal absence of defects. |
| API-04 | High | UNVERIFIED | Prices, discounts, entitlements, and other business rules are computed on the server from authoritative data, never taken from the client. | Parameterized helpers and server-side permissions/business logic were sampled; callback reflected HTML was fixed. Full dynamic SQL, per-field response/PII, every scheduled/internal entry and all HTML/email sink coverage require additional complete inventories. Existing suite is evidence of tested cases, not universal absence of defects. |
| API-05 | High | UNVERIFIED | Responses expose only fields the caller needs; no password hashes, tokens, internal flags, or other users' PII. | Parameterized helpers and server-side permissions/business logic were sampled; callback reflected HTML was fixed. Full dynamic SQL, per-field response/PII, every scheduled/internal entry and all HTML/email sink coverage require additional complete inventories. Existing suite is evidence of tested cases, not universal absence of defects. |
| API-06 | High | FAIL | Production error responses are generic (no stack traces, SQL, file paths, or versions), and full details are logged server-side with a correlation ID. | src/modules/ai/ai.routes.ts:40 directly returns an exception message on reindex failure. Central handler is generic for unexposed 5xx, but no correlation ID exists. |
| API-07 | Medium | FAIL | Custom error pages exist for 404, 500, and timeouts, giving users a next step without revealing internals. | src/app.ts:356 returns the shell for unknown non-API paths; unknown API paths can use framework 404 handling. |
| API-08 | High | N/A | GraphQL endpoints disable introspection and field suggestions in production and enforce depth and complexity limits. | No React server components, serialized hydration data, or GraphQL endpoint. App shells are HTML with a base-path setting; REST responses are audited separately. |
| API-09 | Critical | UNVERIFIED | Scheduled-job, webhook-like, and internal endpoints require a secret or signature and reject calls outside the expected cadence. | Parameterized helpers and server-side permissions/business logic were sampled; callback reflected HTML was fixed. Full dynamic SQL, per-field response/PII, every scheduled/internal entry and all HTML/email sink coverage require additional complete inventories. Existing suite is evidence of tested cases, not universal absence of defects. |
| API-10 | High | UNVERIFIED | All user-supplied content rendered into HTML pages or email templates is escaped or rendered as plain text. | Parameterized helpers and server-side permissions/business logic were sampled; callback reflected HTML was fixed. Full dynamic SQL, per-field response/PII, every scheduled/internal entry and all HTML/email sink coverage require additional complete inventories. Existing suite is evidence of tested cases, not universal absence of defects. |
| WEB-01 | Critical | PASS | CORS uses an explicit origin allowlist; wildcard is never combined with credentials; the `Origin` header is never reflected without validation. | src/app.ts:72; exact native-origin allowlist without cookies; tests/native-app-cors.test.ts and Playwright hostile-origin request. |
| WEB-02 | High | N/A | State-changing requests authenticated by cookies are protected against CSRF (`SameSite` cookies plus CSRF tokens or equivalent origin checks). | Tenant and platform authentication use explicit Bearer headers, not ambient auth cookies. vds_view is a non-auth preference. Reassess if auth moves to cookies. |
| WEB-03 | Medium | UNVERIFIED | Each endpoint allows only the HTTP methods and headers it needs. | No live operational evidence was provided; repository/local tests cannot establish this complete control. |
| WEB-04 | High | FAIL | Pages send `X-Frame-Options: DENY` and `CSP frame-ancestors 'self'` (or a deliberate per-route allowlist). | src/app.ts:116; X-Frame-Options DENY and proxy-only HSTS now exist, but enforced CSP/frame-ancestors is missing. ZAP rule 10038 confirms. |
| WEB-05 | High | FAIL | A Content Security Policy restricts script sources to an approved list and blocks inline scripts; it is enforced (not only report-only) after a reporting period. | src/app.ts:116; X-Frame-Options DENY and proxy-only HSTS now exist, but enforced CSP/frame-ancestors is missing. ZAP rule 10038 confirms. |
| WEB-06 | High | PASS | Third-party scripts are inventoried with a purpose for each, and none load on login, checkout, account, or admin pages. | public/index.html, public/mobile/index.html and web-console/index.html load local scripts; no third-party tracking/login scripts observed. Client bundle secret scan clean. |
| WEB-07 | Medium | FAIL | Baseline security headers are present on every response: HSTS, `X-Content-Type-Options`, `Referrer-Policy` (plus CSP and frame protection). | src/app.ts:116; X-Frame-Options DENY and proxy-only HSTS now exist, but enforced CSP/frame-ancestors is missing. ZAP rule 10038 confirms. |
| WEB-08 | High | N/A | Server-rendered components and page props serialize only the fields the UI renders; no sensitive fields reach the client payload. | No React server components, serialized hydration data, or GraphQL endpoint. App shells are HTML with a base-path setting; REST responses are audited separately. |
| EDGE-01 | Critical | FAIL | Rate limits protect AI/expensive endpoints, auth endpoints, and public data endpoints, per user and per IP. | src/app.ts:195 plus AI per-user limiter and signup/confidential-report limiters; no universal API/public-read budget or complete per-user+IP limiter coverage. |
| EDGE-02 | High | UNVERIFIED | A WAF filters traffic before the application (managed rules or ModSecurity + OWASP CRS in blocking mode), with bot management on high-value routes. | No live operational evidence was provided; repository/local tests cannot establish this complete control. |
| EDGE-03 | High | UNVERIFIED | The origin accepts traffic only from the CDN/WAF, the origin IP is not discoverable, and CDN-to-origin TLS is end-to-end (Full/strict). | No live operational evidence was provided; repository/local tests cannot establish this complete control. |
| EDGE-04 | Medium | UNVERIFIED | A DDoS/abuse response playbook exists, and alerts fire on spikes in WAF blocks or rate-limit hits. | No live operational evidence was provided; repository/local tests cannot establish this complete control. |
| EDGE-05 | Critical | UNVERIFIED | Object storage is private by default; public assets are separated; private files use expiring pre-signed URLs; no backups, exports, or configs are publicly readable; access logging is on. | No live operational evidence was provided; repository/local tests cannot establish this complete control. |
| EDGE-06 | High | UNVERIFIED | Self-managed servers enforce SSH key-only auth, no root login, default-deny inbound firewall (no public database ports), and automatic security updates. | No live operational evidence was provided; repository/local tests cannot establish this complete control. |
| EDGE-07 | Critical | UNVERIFIED | Server and database management panels are not reachable from the public internet (IP/VPN-restricted), require 2FA, and do not sit on default paths and ports. | No live operational evidence was provided; repository/local tests cannot establish this complete control. |
| EDGE-08 | High | FAIL | Internal tools and dev servers bind to localhost or private interfaces, validate the `Host` header, and require authentication. | server.ts:1 serves the standalone app on 0.0.0.0 and uses Host in local HTTP redirects; no general explicit accepted-host allowlist. Ordinary installed PCs bind localhost. |
| EDGE-09 | High | UNVERIFIED | Services are network-segmented, authenticate to each other (tokens or mTLS), and run with least-privilege credentials and egress. | No live operational evidence was provided; repository/local tests cannot establish this complete control. |
| EDGE-10 | High | N/A | Cache/Redis instances require authentication with a least-privilege ACL user, restrict commands, accept connections only from known IPs, and use TLS. | No PostgreSQL read replicas or Redis/Upstash service. Installed-PC sync is a separate authority/consistency model and is explicitly partial in the catalog. |
| EDGE-11 | Medium | UNVERIFIED | DNS records are audited for dangling targets, and cookie domain scope is no broader than needed. | No live operational evidence was provided; repository/local tests cannot establish this complete control. |
| EDGE-12 | Medium | UNVERIFIED | If the organization uses Microsoft 365/Entra or similar workforce identity, conditional access requires device compliance, uses sign-in risk policies, and tiers policies by application sensitivity. | No live operational evidence was provided; repository/local tests cannot establish this complete control. |
| EDGE-13 | Medium | FAIL | Rate limiting has adaptive behavior under load and plan-based tiers where the product is metered. | src/app.ts rate limiters use fixed windows and constants; tenant plan quotas exist separately in src/platform/quota.ts. |
| SUPPLY-01 | High | PASS | A lockfile is committed, and CI installs from it in frozen mode with integrity verification. | Root, launcher and mobile-app lockfiles are committed; production-checks.yml uses npm ci, which checks integrity. No lockfile was deleted. |
| SUPPLY-02 | High | UNVERIFIED | Automated dependency vulnerability scanning and update PRs are enabled, and the backlog is triaged. | Live npm audit was blocked by automatic approval review pending explicit consent to send dependency metadata to registry.npmjs.org. CI/dependabot configs were added; no zero-vulnerability claim is made. |
| SUPPLY-03 | Medium | UNVERIFIED | No deprecated or unmaintained packages are used in core functionality. | Direct names/lockfile metadata inspected; license inventory includes MPL-2.0 and unknown entries needing distribution review. No live maintainer/download/deprecation lookup or legal license approval. npm advisory query remains pending consent. |
| SUPPLY-04 | High | UNVERIFIED | Dependencies are screened for typosquatting, very low adoption, recent maintainer changes, and install scripts. | Direct names/lockfile metadata inspected; license inventory includes MPL-2.0 and unknown entries needing distribution review. No live maintainer/download/deprecation lookup or legal license approval. npm advisory query remains pending consent. |
| SUPPLY-05 | Medium | FAIL | Infrastructure versions (database, cache, base images, runtimes) are pinned and updated on a deliberate schedule, and infrastructure clients sit behind an adapter. | .node-version:1 is a major-only 22 and package.json permits >=22.13; CI pins versions but hosting runtime/installable artifacts are not fully pinned. |
| SUPPLY-06 | Low | UNVERIFIED | Dependency licenses are compatible with the product's distribution model. | Direct names/lockfile metadata inspected; license inventory includes MPL-2.0 and unknown entries needing distribution review. No live maintainer/download/deprecation lookup or legal license approval. npm advisory query remains pending consent. |
| SUPPLY-07 | Medium | FAIL | Each component receives only the secrets and configuration it needs, not the full environment. | electron/main.cjs and scripts launch server/child processes with inherited process.env; provider adapters read shared environment variables. |
| SUPPLY-08 | Medium | UNVERIFIED | Third-party prompts, skills, MCP servers, agent configs, and copied instructions are reviewed before use and never run with production access unvetted. | No live operational evidence was provided; repository/local tests cannot establish this complete control. |
| AISEC-01 | Critical | PASS | LLM features and tools can access only data the current user is authorized to see; scoping is enforced in code (queries and tool implementations), not in the prompt. | src/modules/ai/ai-tools.ts:614 rechecks permission per tool; own notes/tasks and messages scoped in queries; tests/ai.test.ts and ai-analytics.test.ts. Human confirmation is a separate failing check. |
| AISEC-02 | Critical | PASS | RAG retrieval filters by the requester's permissions using metadata attached at ingestion, and responses are checked so no chunk from an unauthorized source is used. | src/modules/ai/rag.ts:160; per-tenant FTS index and permission/department filter before returning chunks; tests/ai-rag.test.ts. No shared remote vector store. |
| AISEC-03 | High | FAIL | Untrusted content (user input, uploads, retrieved pages, repository text) cannot trigger privileged actions; injection patterns are screened at ingestion, and system instructions are separated from data. | src/modules/ai/ai-tools.ts:62 and executeTool contain writable inventory/order/user/message tools executed from model tool_calls without a separate action-approval record. |
| AISEC-04 | High | FAIL | Model outputs are screened before display for system-prompt leakage, other users' data, and internal details. | src/modules/ai/ai.routes.ts:309 returns model prose after schema/length validation, without prompt/PII leakage screening. |
| AISEC-05 | Critical | PASS | Any server-side fetch of user-influenced URLs (agents, previews, webhooks-to-URL, importers) blocks private, loopback, link-local, and metadata addresses, pins resolution, re-validates on redirects, and returns generic errors. | src/shared/public-fetch.ts:1 resolves once and pins validated public addresses into an undici Agent; every preview redirect calls it again. tests/public-fetch.test.ts covers mapped IPv6, metadata, mixed DNS and bounds. Admin-configured AI/SMTP endpoints are privileged configuration, not anonymous URL fetches. |
| AISEC-06 | High | FAIL | Each agent or automation uses its own scoped, short-lived credentials rather than a human's credentials or a broad shared key. | src/modules/ai/ai-tools.ts:614 executes with the human AuthUser and shared provider key; no dedicated scoped short-lived agent credential. |
| AISEC-07 | High | FAIL | Agent actions with production impact (writes, deletes, deploys, payments, outbound messages) pass automated policy gates and require human approval; egress is restricted. | src/modules/ai/ai-tools.ts:62 and executeTool contain writable inventory/order/user/message tools executed from model tool_calls without a separate action-approval record. |
| AISEC-08 | High | FAIL | Every agent tool call is recorded in an append-only audit log with inputs, outputs, actor, and timestamp. | src/modules/ai/ai.routes.ts:91 saves steps in ai_messages, but DELETE /messages clears them and calls are not an independent append-only audit stream. |
| AISEC-09 | Medium | UNVERIFIED | The organization has an AI acceptable-use policy, an inventory of approved AI tools, and controls against pasting sensitive data into unapproved tools. | No live operational evidence was provided; repository/local tests cannot establish this complete control. |
| AISEC-10 | Medium | PASS | AI coding assistants and CI agents do not auto-execute on untrusted repository content (forks, external PRs, issues) with access to secrets. | .github/workflows/production-checks.yml:1 uses pull_request with read-only repository permissions; no pull_request_target checkout or AI agent with secrets. |
| MOBILE-01 | High | FAIL | Mobile clients store tokens and credentials only in Keychain/Keystore-backed secure storage. | public/js/api.js:17; native Capacitor shell reuses browser storage, with no Keystore/Keychain storage adapter. |
| MOBILE-02 | Critical | PASS | No secret API keys are embedded in the app bundle; privileged calls go through the backend. | Gitleaks 8.24.3 dir scans of public/ and web-console/ each returned an empty report. Native shell bundles public assets; compiled APK/EXE scans remain outside this source check. |
| MOBILE-03 | High | UNVERIFIED | Deep links and auth callbacks are validated (verified universal/app links preferred), and parameters are checked before any action. | Native app is explicitly partial in catalog. No device builds, store listings, privacy manifests or universal/app-link association validation were performed. |
| MOBILE-04 | Medium | FAIL | Transport security is hardened (TLS everywhere; certificate or public-key pinning with a rotation plan where the risk justifies it). | mobile-app/android/app/src/main/AndroidManifest.xml and public/mobile/native.js permit configurable local HTTP server addresses; no server pin/rotation policy verified. |
| MOBILE-05 | Medium | UNVERIFIED | Store-submission requirements are met: privacy manifest, data-use and AI disclosures, and edge-case crash testing. | Native app is explicitly partial in catalog. No device builds, store listings, privacy manifests or universal/app-link association validation were performed. |
| MOBILE-06 | Low | UNVERIFIED | Universal/app links are configured with a web fallback so shared links open the app when installed. | Native app is explicitly partial in catalog. No device builds, store listings, privacy manifests or universal/app-link association validation were performed. |
| BACK-01 | High | PASS | Clients reach data through a backend that enforces auth, validation, and business rules; any direct client-to-database access is protected by row-level security on every table involved. | public/js/api.js calls Express REST; SQLite is server-only. src/app.ts mounts per-module gates and routers; route-permission and access-matrix tests run in full suite. |
| BACK-02 | High | FAIL | Every outbound call (HTTP, database, payment, AI provider) has a timeout, error handling, and a defined fallback; idempotent calls retry with exponential backoff and jitter. | AI/QBO/SMTP/S3 now have bounded timeouts; src/modules/ai/ai.routes.ts still allows up to 12 sequential model calls, with no shared request budget/circuit breaker or generalized 429 backoff. |
| BACK-03 | High | FAIL | Long-running work (exports, AI pipelines, bulk email, file processing) runs in background jobs with status tracking, retries, and user notification, not in the request cycle. | src/modules/ai/ai.routes.ts:255 runs the tool loop in the request; large exports and reindex are also synchronous/in-request work. |
| BACK-04 | High | UNVERIFIED | Create, charge, and job-start operations are idempotent (idempotency keys or natural unique constraints), so retries and double-clicks cannot duplicate effects. | Idempotency replay is now authenticated and bound to actor/method/path/JSON/access scope, with per-process in-flight exclusion; tests/idempotency.test.ts. Missing keys, multipart payload identity, persistence-failure atomicity and multiple processes still need a complete business-operation proof. |
| BACK-05 | Medium | FAIL | Failure isolation exists for critical dependencies: circuit breakers, per-dependency connection pools (bulkheads), and an overall request timeout budget. | AI/QBO/SMTP/S3 now have bounded timeouts; src/modules/ai/ai.routes.ts still allows up to 12 sequential model calls, with no shared request budget/circuit breaker or generalized 429 backoff. |
| BACK-06 | Medium | FAIL | Background queues have monitoring, failure alerts, and a dead-letter queue with replay. | server.ts:1 timers and src/platform/offsite.ts have logs/status files but no general dead-letter queue or operator alert/replay mechanism. |
| BACK-07 | Medium | PASS | Each third-party service is accessed through a single adapter module, and business-critical data is also stored in a database you control. | src/shared/mailer.ts, src/shared/s3.ts, src/modules/ai/ai-config.ts and src/modules/quickbooks/quickbooks.ts centralize their integrations. Local SQLite owns business records. |
| BACK-08 | Medium | FAIL | Provider rate limits (429) are handled with backoff, queuing for non-urgent work, and caching. | AI/QBO/SMTP/S3 now have bounded timeouts; src/modules/ai/ai.routes.ts still allows up to 12 sequential model calls, with no shared request budget/circuit breaker or generalized 429 backoff. |
| BACK-09 | Medium | FAIL | The public or partner API has a written contract, a version in the path or header, a changelog, and a deprecation policy with sunset headers. | src/app.ts:1 exposes unversioned /api routes; no OpenAPI contract or formal deprecation/sunset policy is present. |
| BACK-10 | Low | PASS | Machine-to-machine mutating endpoints verify request signatures (HMAC with a shared secret) where callers are systems, not browsers. | src/sync/transport.ts and tests/sync-transport.test.ts verify enrolled-node token and signed sync protocol. No unauthenticated scheduled HTTP job was found; server timers run in-process. |
| BACK-11 | Medium | PASS | Per-client variation is handled with tenant-scoped flags and configuration overrides, not repository forks or per-client branches. | src/shared/modules.ts, src/platform/plans.ts, src/platform/subscription.ts; per-tenant DB/settings/entitlements, not one repository fork per tenant. |
| BACK-12 | Medium | FAIL | Derived stores (search, analytics, caches, notifications) are updated through events or change data capture with failure handling, not ad-hoc polling. | src/modules/ai/rag.ts:16 refreshes search lazily every five minutes; multiple features poll for changes. |
| DATA-01 | Medium | PASS | The schema is normalized with explicit relationships and constraints (foreign keys, unique, not-null); there are no catch-all wide tables. | src/shared/db.ts:314; relational SQLite tables with FK, unique and not-null constraints; foreign_keys=ON in openConnection. Form-record JSON is deliberate extension data. |
| DATA-02 | High | UNVERIFIED | Hot queries use appropriate indexes; no full table scans on tables that grow with usage. | SQLite indexes exist and 100-item local reads were fast; no production query frequency/dataset or EXPLAIN evidence for every growing hot table was supplied. |
| DATA-03 | Medium | FAIL | Queries select only required columns, and list views do not issue N+1 queries. | src/core/auth.routes.ts:31 and many route lists use full-row queries; no query-count budget is enforced. |
| DATA-04 | High | N/A | Database connections are pooled; serverless runtimes use a transaction-mode pooler; per-instance pool size × instances stays under the database limit. | Persistent node:sqlite connections are cached per tenant; no PostgreSQL/serverless connection pool. Deployment must remain one authoritative process per SQLite store; production topology unverified. |
| DATA-05 | Medium | FAIL | Slow-query logging or `pg_stat_statements` (or equivalent) is enabled and reviewed. | src/shared/db.ts:1 helpers execute statements without a slow-query recorder; request logs report only whole-request elapsed time. |
| DATA-06 | High | UNVERIFIED | All schema changes are versioned migration files in source control; the database can be rebuilt from them; production is never altered by hand. | src/shared/db.ts versioned migrations and pre-migration snapshots; backup and adopt-default tests pass locally. No production schema comparison, full-size migration rehearsal or tested rollback timing supplied. |
| DATA-07 | High | UNVERIFIED | Migrations on live tables follow expand/contract, have a written rollback, and are rehearsed on staging with production-like data. | src/shared/db.ts versioned migrations and pre-migration snapshots; backup and adopt-default tests pass locally. No production schema comparison, full-size migration rehearsal or tested rollback timing supplied. |
| DATA-08 | High | UNVERIFIED | Bulk data imports and platform migrations are validated (row counts, field formats, dates, phone/country codes, duplicates), rehearsed at full scale, and reversible. | src/shared/db.ts versioned migrations and pre-migration snapshots; backup and adopt-default tests pass locally. No production schema comparison, full-size migration rehearsal or tested rollback timing supplied. |
| DATA-09 | Medium | FAIL | Concurrent edits to shared data use an explicit strategy (optimistic locking/version columns, CRDTs, or event sourcing), never silent last-write-wins. | src/core/users.routes.ts:102 and profile/settings edits do not require an expected version or If-Match. |
| DATA-10 | Medium | N/A | If read replicas are used, read-your-writes consistency is handled and replica lag is monitored with a reroute threshold. | No PostgreSQL read replicas or Redis/Upstash service. Installed-PC sync is a separate authority/consistency model and is explicitly partial in the catalog. |
| DATA-11 | Medium | FAIL | Uploaded files live in object storage (served through a CDN), with only keys or URLs in the database. | src/shared/db.ts uploadDir and diskStorage upload handlers use local files; DBs store paths, but serving is authenticated local disk rather than object storage/CDN. |
| DATA-12 | Medium | UNVERIFIED | Per-tenant custom data uses an extension layer rather than core-schema columns, and heavy tenant workloads are isolated. | Inventory attributes/form JSON and per-tenant databases avoid many shared-schema customizations; heavy tenant workloads still share a process and were not profiled with representative data. |
| DATA-13 | Low | UNVERIFIED | There is a documented, evidence-driven scaling path (indexes → partitioning → sharding / platform change) tied to monitoring thresholds. | No live operational evidence was provided; repository/local tests cannot establish this complete control. |
| CACHE-01 | High | UNVERIFIED | Every cached data type has a defined maximum staleness, and price, permission, entitlement, inventory, and account-status data is never served stale. | Stock/permission reads are server-authoritative; API responses now no-store and worker does not cache API. Idempotency cache fixed. Search ACL/source freshness, offline caches and every mutation/cache invalidation path were not fully proven. |
| CACHE-02 | High | UNVERIFIED | Writes to cached business or user data invalidate or update the affected keys across all cache layers. | Stock/permission reads are server-authoritative; API responses now no-store and worker does not cache API. Idempotency cache fixed. Search ACL/source freshness, offline caches and every mutation/cache invalidation path were not fully proven. |
| CACHE-03 | Medium | UNVERIFIED | Hot keys are protected against stampedes (single-flight/locking, stale-while-revalidate, or jittered TTLs). | Stock/permission reads are server-authoritative; API responses now no-store and worker does not cache API. Idempotency cache fixed. Search ACL/source freshness, offline caches and every mutation/cache invalidation path were not fully proven. |
| CACHE-04 | Medium | FAIL | Static assets are fingerprinted and served with long-lived cache headers through a CDN; safe public responses are edge-cached. | src/app.ts:314 applies no-cache to unversioned assets; service worker uses a manually versioned shell. |
| CACHE-05 | Medium | FAIL | Cache effectiveness is measured (hit rate, DB load before and after). | No cache hit/miss instrumentation in src/core/messages.routes.ts or src/modules/ai/rag.ts. |
| CACHE-06 | High | FAIL | A load test at realistic and peak concurrency has been run against a production-like environment, and the first bottleneck is known and addressed. | scripts/audit-load.mjs performed 450 local read requests at 5/15/30 clients over 100 items with no failures; no target peak or production-like dataset/hardware supplied. |
| CACHE-07 | Medium | UNVERIFIED | Scaling changes are made in order, on evidence (connections → queries → read/write split), with a written rationale. | No live operational evidence was provided; repository/local tests cannot establish this complete control. |
| CACHE-08 | Medium | FAIL | Repeated expensive computations and AI calls are cached with correct user/tenant scoping. | AI chat calls are not response/semantic cached or routed by complexity; a single configured model handles requests. |
| CACHE-09 | Low | UNVERIFIED | If users are global, latency is addressed with edge delivery, regional read replicas, and geo-aware routing. | Primary audience appears to be a Philippines office operation, but customer geography and regional latency requirements were not confirmed. |
| DR-01 | Critical | PASS | Automated backups cover every datastore holding business data (primary database, object storage, other stateful services). | src/platform/backups.ts:47 enumerates tenant DBs, control-plane DB and upload mirror; tests/backup.test.ts and tests/offsite-backup.test.ts. PASS covers implemented automated coverage, not live scheduler health. |
| DR-02 | High | UNVERIFIED | Backup frequency or point-in-time recovery meets the defined RPO; PITR is enabled for the primary database where available. | Daily snapshots and encrypted offsite S3 support exist; live backup destinations, least-privilege/immutability settings, RPO and actual recent successful transfers were not accessible. |
| DR-03 | High | UNVERIFIED | Backups are stored off the primary host, preferably cross-region, and cannot be deleted with the application's runtime credentials. | Daily snapshots and encrypted offsite S3 support exist; live backup destinations, least-privilege/immutability settings, RPO and actual recent successful transfers were not accessible. |
| DR-04 | High | FAIL | Restores are tested on a schedule (monthly to quarterly) into a clean environment, with data verification, an app smoke test, and a recorded duration. | tests/backup.test.ts verifies snapshot integrity and restore mechanics; docs/SAAS-OPERATIONS.md asks operators to test occasionally, but no dated production-size restore drill record/schedule is present. |
| DR-05 | Medium | FAIL | RTO and RPO are defined, documented, and consistent with the backup and failover design. | docs/SAAS-OPERATIONS.md:162 describes daily backups but no business-approved RTO/RPO. |
| DR-06 | Medium | UNVERIFIED | An incident runbook exists covering first checks, rollback, data restore, escalation, and customer communication. | No live operational evidence was provided; repository/local tests cannot establish this complete control. |
| DEPLOY-01 | High | UNVERIFIED | The production branch is protected: no direct pushes, required PR review, and required status checks. | Production-checks.yml adds typecheck, Vitest, Playwright/axe, npm audit and Gitleaks jobs. New remote production branch/protection and required-check enforcement must be verified after push; writing YAML does not establish enforced controls. |
| DEPLOY-02 | High | UNVERIFIED | CI runs build, tests, lint, and security scans on every PR, and failures block merge and deploy. | Production-checks.yml adds typecheck, Vitest, Playwright/axe, npm audit and Gitleaks jobs. New remote production branch/protection and required-check enforcement must be verified after push; writing YAML does not establish enforced controls. |
| DEPLOY-03 | High | UNVERIFIED | A staging environment mirrors production's shape (schema, services, config keys) with separate data and credentials; PRs get preview deployments or staging verification before production. | Tests use disposable SQLite/data/upload paths. No live development/staging/production configuration or credential separation evidence was supplied. |
| DEPLOY-04 | High | UNVERIFIED | Deployments are automated and reproducible from version control (infrastructure and configuration as code), with no manual server edits. | railway.json declares start/healthcheck/restart; no hosting account, automatic-deploy branch, volume attachment or live environment configuration was inspected. |
| DEPLOY-05 | High | UNVERIFIED | Rollback to the previous release is a single documented action, tested, and completes within minutes (including how to handle database migrations). | Repository backup/restore primitives and deployment documentation exist; no timed release rollback drill with production-compatible migrations was supplied. |
| DEPLOY-06 | Medium | UNVERIFIED | Changes ship in small, scoped PRs; large multi-concern commits to production are rare. | No live operational evidence was provided; repository/local tests cannot establish this complete control. |
| DEPLOY-07 | Medium | FAIL | Risky changes use progressive delivery (canary or percentage rollout) and/or feature flags with a kill switch, and rollback is automatic on an error-rate threshold. | railway.json:1 defines ordinary restart/healthcheck; module entitlements can disable modules but no canary/error-rate rollback controller exists. |
| DEPLOY-08 | Medium | UNVERIFIED | A pre-deploy checklist (secrets, fallbacks, cost caps, validation, error handling, CORS/rate limits, rollback, logging) is used for production releases. | No live operational evidence was provided; repository/local tests cannot establish this complete control. |
| DEPLOY-09 | Low | UNVERIFIED | The pipeline is efficient: parallel stages, dependency caching, path-based triggers, and CI usage alerts. | CI now splits jobs and caches npm; no hosted run duration, budget alert, branch filter behavior or efficiency history was inspected. |
| TEST-01 | High | UNVERIFIED | Automated tests cover the critical journeys: signup, login/logout, wrong password, lockout, password reset, the core value action, and checkout for every enabled payment method including confirmation. | Broad suite covers auth, tenant provisioning, inventory, orders, purchasing, manufacturing/QC, HR/payroll, accounting, email mocks and sync; Playwright covers login/stock/mobile. No all-feature browser journey coverage or live provider confirmation; payment checkout N/A. |
| TEST-02 | Medium | FAIL | A coverage threshold is enforced in CI; unit tests run on every push and integration/E2E tests on merge. | vitest.config.ts:1 has no coverage provider or enforced coverage threshold; CI runs tests and browser checks but no coverage gate. |
| TEST-03 | High | PASS | Negative and security tests exist: forbidden-field submission, cross-user/cross-tenant access attempts, and invalid input types on write endpoints. | tests/access-matrix.test.ts, permissions.test.ts, tenant-path.test.ts, validation.test.ts, idempotency.test.ts, public-fetch.test.ts and production-security.test.ts exercise negative security paths. |
| TEST-04 | Medium | PASS | Edge inputs are tested: empty required fields, maximum lengths, apostrophes, emoji, HTML, and repeated submissions. | tests/e2e/readiness.spec.ts exercises SQL-like username, 10,000-character input, apostrophe/emoji stock label, retries; existing validation and upload tests cover malformed fields. |
| TEST-05 | Medium | UNVERIFIED | The UI is tested on small screens, old devices/browsers, and slow networks; mobile layouts of core flows work. | Chromium Playwright covers 360px mobile navigation/offline login and desktop; axe login scans pass after contrast/ARIA/zoom fixes. No complete authenticated-view WCAG audit, old-browser/device matrix, screen-reader review or real-device tests. |
| TEST-06 | Medium | UNVERIFIED | Tests are hermetic and pass reliably in CI (no reliance on local env, shared state, test order, or timing). | Full suite uses isolated temporary DB paths and passed locally; first sandbox-only failures were socket-permission artifacts. Remote CI stability and random-order runs have not been observed. |
| TEST-07 | Low | UNVERIFIED | Usability has been tested with target users who did not build the product. | Automated edge tests were run, but they cannot establish usability by independent target users. No user-session notes supplied. |
| OBS-01 | High | FAIL | Application logs are structured (JSON), centralized, searchable, and include timestamp, level, request/correlation ID, user or tenant ID, and action. | src/app.ts:228 emits text request logs without generated correlation IDs or a structured trace context. |
| OBS-02 | High | UNVERIFIED | Errors are captured by an error-tracking service with alerting, release tags, and request/user context (without leaking secrets or PII beyond policy). | No live operational evidence was provided; repository/local tests cannot establish this complete control. |
| OBS-03 | High | UNVERIFIED | External uptime checks from more than one region alert a human (not just a dashboard) within minutes of an outage. | No live operational evidence was provided; repository/local tests cannot establish this complete control. |
| OBS-04 | High | UNVERIFIED | Business metrics (payments, signups, checkout completions, key job outcomes) are monitored against baselines, and drops trigger alerts. | No live operational evidence was provided; repository/local tests cannot establish this complete control. |
| OBS-05 | Medium | UNVERIFIED | Synthetic transactions exercise the critical path on a schedule. | No live operational evidence was provided; repository/local tests cannot establish this complete control. |
| OBS-06 | Medium | FAIL | Requests carry a correlation ID across services and logs; distributed tracing (OpenTelemetry or equivalent) is in place for multi-service paths. | src/app.ts:228 emits text request logs without generated correlation IDs or a structured trace context. |
| OBS-07 | Medium | UNVERIFIED | SLOs and error budgets exist for critical endpoints, with burn-rate alerts and a policy for slowing releases when budgets burn. | No live operational evidence was provided; repository/local tests cannot establish this complete control. |
| OBS-08 | Medium | UNVERIFIED | A status page runs on separate infrastructure, and there is a defined incident and maintenance communication workflow. | No live operational evidence was provided; repository/local tests cannot establish this complete control. |
| OBS-09 | Medium | UNVERIFIED | Incidents get blameless post-mortems within about 48 hours using a standard template, stored in a searchable incident library. | No live operational evidence was provided; repository/local tests cannot establish this complete control. |
| OBS-10 | Medium | UNVERIFIED | Support tickets are categorized by root cause and reviewed regularly, with repeated causes turned into engineering work. | No live operational evidence was provided; repository/local tests cannot establish this complete control. |
| OBS-11 | Low | UNVERIFIED | Session replay or equivalent UX telemetry is linked to errors, with sensitive fields masked. | No live operational evidence was provided; repository/local tests cannot establish this complete control. |
| OBS-12 | Low | UNVERIFIED | Operators have an admin view of key metrics, recent errors, logs, and system health. | No live operational evidence was provided; repository/local tests cannot establish this complete control. |
| PLAT-01 | High | UNVERIFIED | The workload fits the platform's documented limits (execution timeout, request/response size, concurrency, memory); long or large operations run on suitable compute. | No live operational evidence was provided; repository/local tests cannot establish this complete control. |
| PLAT-02 | Medium | UNVERIFIED | Workloads are split by type: request/response on serverless or web instances; long jobs, queue workers, websockets, and cron on persistent compute. | No live operational evidence was provided; repository/local tests cannot establish this complete control. |
| PLAT-03 | Medium | UNVERIFIED | Production does not run on hobby or free tiers that lack required limits, SLAs, backups, or support. | No live operational evidence was provided; repository/local tests cannot establish this complete control. |
| PLAT-04 | Medium | UNVERIFIED | Cloud costs are monitored with budgets and alerts; idle resources are cleaned up; instances are right-sized; egress is understood. | No live operational evidence was provided; repository/local tests cannot establish this complete control. |
| PLAT-05 | Medium | UNVERIFIED | Data platform choice matches the data shape and workload, and lock-in or exit cost is documented. | No live operational evidence was provided; repository/local tests cannot establish this complete control. |
| PLAT-06 | Medium | UNVERIFIED | The business knows its "customer ceiling": which enterprise requirements (SSO, SOC 2, data residency, VPC deployment, DPAs/BAAs) the current stack can and cannot meet. | No live operational evidence was provided; repository/local tests cannot establish this complete control. |
| PLAT-07 | Low | UNVERIFIED | Any self-hosted component has a named owner for patching, monitoring, backups, and uptime. | No live operational evidence was provided; repository/local tests cannot establish this complete control. |
| UX-01 | High | UNVERIFIED | Every data-driven view has explicit loading, error, empty, and success states, and error boundaries prevent one failing component from blanking the page. | Playwright wrong-password/offline behavior and core navigation pass; existing frontends have loading/error paths. Every route and every upstream outage state was not rendered and inspected. |
| UX-02 | High | UNVERIFIED | Failed payments and other failed external actions show a clear message and a retry path; the UI never freezes or goes blank. | Playwright wrong-password/offline behavior and core navigation pass; existing frontends have loading/error paths. Every route and every upstream outage state was not rendered and inspected. |
| UX-03 | Medium | UNVERIFIED | Core flows work at phone width, on slow networks, and on older devices/browsers; bundle size is monitored. | Chromium Playwright covers 360px mobile navigation/offline login and desktop; axe login scans pass after contrast/ARIA/zoom fixes. No complete authenticated-view WCAG audit, old-browser/device matrix, screen-reader review or real-device tests. |
| UX-04 | High | UNVERIFIED | The app meets WCAG 2.x AA basics: full keyboard operability, labelled controls and images, correct ARIA usage, and 4.5:1 text contrast. | Chromium Playwright covers 360px mobile navigation/offline login and desktop; axe login scans pass after contrast/ARIA/zoom fixes. No complete authenticated-view WCAG audit, old-browser/device matrix, screen-reader review or real-device tests. |
| UX-05 | Medium | FAIL | Dates, numbers, and currencies are locale-formatted, and scheduled communications use each user's stored timezone. | server.ts uses a required office TZ behind proxy; attendance is intentionally office-time-based, but user-level communication timezone preferences are absent. |
| UX-06 | Low | FAIL | Essential product pages and flows exist: password reset, terms, privacy policy, helpful error and empty states. | public/index.html and public/mobile/index.html have password recovery/login but no linked terms/privacy pages; no complete B2B contract set was found. |
| PAY-01 | Critical | N/A | Checkout sessions are created server-side from server-side or provider-side prices (Price IDs); no client-supplied amount, currency, or discount is trusted. | src/platform/subscription.ts:1 explicitly implements owner-managed PHP quotes without charging a payment method. No hosted card checkout/payment webhook/provider dunning exists. Accounting cash entries and QuickBooks export are not payment processing. |
| PAY-02 | Critical | N/A | Access and entitlements are granted only after a verified payment webhook (with amount and product checked), never from the success redirect. | src/platform/subscription.ts:1 explicitly implements owner-managed PHP quotes without charging a payment method. No hosted card checkout/payment webhook/provider dunning exists. Accounting cash entries and QuickBooks export are not payment processing. |
| PAY-03 | Critical | N/A | Every incoming webhook (payments, auth provider, email provider, source control, others) has its signature verified against the raw body with the provider's SDK before processing. | src/platform/subscription.ts:1 explicitly implements owner-managed PHP quotes without charging a payment method. No hosted card checkout/payment webhook/provider dunning exists. Accounting cash entries and QuickBooks export are not payment processing. |
| PAY-04 | High | N/A | Webhook processing is idempotent: event IDs are persisted before processing, duplicates return 2xx without side effects, and stale events outside a replay window are rejected. | src/platform/subscription.ts:1 explicitly implements owner-managed PHP quotes without charging a payment method. No hosted card checkout/payment webhook/provider dunning exists. Accounting cash entries and QuickBooks export are not payment processing. |
| PAY-05 | High | N/A | A successful payment reliably triggers every downstream step (invoice, subscription, access, receipt, CRM), with retries and alerts when a step fails. | src/platform/subscription.ts:1 explicitly implements owner-managed PHP quotes without charging a payment method. No hosted card checkout/payment webhook/provider dunning exists. Accounting cash entries and QuickBooks export are not payment processing. |
| PAY-06 | High | N/A | Card data never touches application servers (hosted checkout, elements, or billing portal). | src/platform/subscription.ts:1 explicitly implements owner-managed PHP quotes without charging a payment method. No hosted card checkout/payment webhook/provider dunning exists. Accounting cash entries and QuickBooks export are not payment processing. |
| PAY-07 | Medium | N/A | Failed subscription payments trigger smart retries, a customer email sequence, and a grace period before cancellation. | src/platform/subscription.ts:1 explicitly implements owner-managed PHP quotes without charging a payment method. No hosted card checkout/payment webhook/provider dunning exists. Accounting cash entries and QuickBooks export are not payment processing. |
| PAY-08 | Medium | N/A | A product-specific refund policy is published and linked at checkout; dispute-rate alerts and a dispute evidence template exist. | src/platform/subscription.ts:1 explicitly implements owner-managed PHP quotes without charging a payment method. No hosted card checkout/payment webhook/provider dunning exists. Accounting cash entries and QuickBooks export are not payment processing. |
| PAY-09 | Medium | UNVERIFIED | Sales-tax/VAT obligations are assessed by customer location, and tax is collected and filed where required. | No live operational evidence was provided; repository/local tests cannot establish this complete control. |
| PAY-10 | Medium | N/A | Metered or credit billing reads from a dedicated usage-event table that billing and analytics share. | src/platform/subscription.ts:1 explicitly implements owner-managed PHP quotes without charging a payment method. No hosted card checkout/payment webhook/provider dunning exists. Accounting cash entries and QuickBooks export are not payment processing. |
| PAY-11 | Medium | N/A | Webhook endpoints use non-guessable paths and, where supported, restrict source IPs to the provider's published ranges. | src/platform/subscription.ts:1 explicitly implements owner-managed PHP quotes without charging a payment method. No hosted card checkout/payment webhook/provider dunning exists. Accounting cash entries and QuickBooks export are not payment processing. |
| MAIL-01 | High | UNVERIFIED | Transactional email is authenticated (SPF, DKIM, DMARC), sent from a domain or subdomain separate from marketing, and monitored for delivery, bounces, and complaints. | No live operational evidence was provided; repository/local tests cannot establish this complete control. |
| PAY-12 | Low | N/A | International customers see local currency (and optionally purchasing-power-adjusted pricing). | src/platform/subscription.ts:1 explicitly implements owner-managed PHP quotes without charging a payment method. No hosted card checkout/payment webhook/provider dunning exists. Accounting cash entries and QuickBooks export are not payment processing. |
| LEGAL-01 | High | UNVERIFIED | The privacy policy accurately reflects the data actually collected (including logs, analytics, device data) and every third party it flows to. | No owner/counsel jurisdiction, approved policies, data-subject request process, medical-data applicability, legal retention, consent, insurance or compliance records were supplied. App handles employee/payroll/contact/location/photo data. No HIPAA/GDPR/SOC 2 certification is asserted. |
| LEGAL-02 | High | FAIL | Required legal documents exist and are linked in the product: terms of service, privacy policy, refund policy; plus DPA and MSA/SLA for B2B. | public/index.html and public/mobile/index.html have password recovery/login but no linked terms/privacy pages; no complete B2B contract set was found. |
| LEGAL-03 | High | UNVERIFIED | Users can export and delete their data on request, within the legally required deadline, and can opt out where required. | No owner/counsel jurisdiction, approved policies, data-subject request process, medical-data applicability, legal retention, consent, insurance or compliance records were supplied. App handles employee/payroll/contact/location/photo data. No HIPAA/GDPR/SOC 2 certification is asserted. |
| LEGAL-04 | High | FAIL | Account deletion follows a documented cascade across all tables and systems (including analytics, logs, third parties, and backup expiry), with soft delete then scheduled hard delete. | src/core/users.routes.ts deactivates accounts; no complete user-data cascade across employee files, messages, logs, backups and third parties exists. |
| LEGAL-05 | Medium | UNVERIFIED | A retention schedule reconciles legal retention requirements with deletion requests (anonymize versus retain), with an audit trail. | No owner/counsel jurisdiction, approved policies, data-subject request process, medical-data applicability, legal retention, consent, insurance or compliance records were supplied. App handles employee/payroll/contact/location/photo data. No HIPAA/GDPR/SOC 2 certification is asserted. |
| LEGAL-06 | Medium | UNVERIFIED | Consent for non-essential tracking is obtained in plain language before data flows to third parties. | No owner/counsel jurisdiction, approved policies, data-subject request process, medical-data applicability, legal retention, consent, insurance or compliance records were supplied. App handles employee/payroll/contact/location/photo data. No HIPAA/GDPR/SOC 2 certification is asserted. |
| LEGAL-07 | Critical | UNVERIFIED | If the product handles health data: PHI is encrypted at rest and in transit (including backups, logs, exports), every PHI access is audit-logged, and BAAs cover every vendor that can access PHI. | No owner/counsel jurisdiction, approved policies, data-subject request process, medical-data applicability, legal retention, consent, insurance or compliance records were supplied. App handles employee/payroll/contact/location/photo data. No HIPAA/GDPR/SOC 2 certification is asserted. |
| LEGAL-08 | High | UNVERIFIED | A breach response plan defines notification obligations and timelines by jurisdiction and regulation, owners, and evidence sources. | No owner/counsel jurisdiction, approved policies, data-subject request process, medical-data applicability, legal retention, consent, insurance or compliance records were supplied. App handles employee/payroll/contact/location/photo data. No HIPAA/GDPR/SOC 2 certification is asserted. |
| LEGAL-09 | Medium | UNVERIFIED | AI-generated content shown to users is disclosed or labeled where regulations (for example the EU AI Act) or app-store rules require. | No owner/counsel jurisdiction, approved policies, data-subject request process, medical-data applicability, legal retention, consent, insurance or compliance records were supplied. App handles employee/payroll/contact/location/photo data. No HIPAA/GDPR/SOC 2 certification is asserted. |
| LEGAL-10 | Medium | UNVERIFIED | If selling to enterprises: SOC 2 readiness evidence is being collected (access reviews, patch SLAs, restore tests, incident procedures, vendor management), ideally automated. | No owner/counsel jurisdiction, approved policies, data-subject request process, medical-data applicability, legal retention, consent, insurance or compliance records were supplied. App handles employee/payroll/contact/location/photo data. No HIPAA/GDPR/SOC 2 certification is asserted. |
| LEGAL-11 | Low | UNVERIFIED | A recurring compliance review (for example quarterly) tracks regulatory changes for each jurisdiction where users live. | No owner/counsel jurisdiction, approved policies, data-subject request process, medical-data applicability, legal retention, consent, insurance or compliance records were supplied. App handles employee/payroll/contact/location/photo data. No HIPAA/GDPR/SOC 2 certification is asserted. |
| LEGAL-12 | Low | UNVERIFIED | Cyber liability insurance is in place or consciously declined, and platform liability terms are understood. | No owner/counsel jurisdiction, approved policies, data-subject request process, medical-data applicability, legal retention, consent, insurance or compliance records were supplied. App handles employee/payroll/contact/location/photo data. No HIPAA/GDPR/SOC 2 certification is asserted. |
| AIQ-01 | High | FAIL | Every model response passes validation (schema, length, content rules) before it reaches users or downstream systems, with bounded retries and a graceful fallback. | src/modules/ai/ai.routes.ts now validates provider schema, tool counts, argument sizes and reply length; no semantic content policy, bounded repair retry or evaluated fallback. |
| AIQ-02 | High | UNVERIFIED | Model calls have timeouts and a fallback path (alternate model or provider, cached response, or graceful message) when the provider is down or slow. | AI calls now time out after 30 seconds and central 5xx is generic; actual provider outage UX, model alternatives and full-loop deadline behavior were not verified against a live/synthetic failing provider. |
| AIQ-03 | Critical | FAIL | AI endpoints require authentication and enforce per-user rate limits, request-size limits, and token or spend caps by plan. | AI route has auth, message bounds, ten requests/minute per tenant/user, tenant call quotas and an optional tenant token cap; no hard per-user daily/monthly spend allocation or atomic reservation exists. |
| AIQ-04 | High | UNVERIFIED | Provider accounts have billing limits and spend alerts configured. | No live operational evidence was provided; repository/local tests cannot establish this complete control. |
| AIQ-05 | Medium | FAIL | An evaluation suite scores AI outputs against thresholds in CI, including a regression set built from real failures, and is used to compare prompts and models. | tests/ai*.test.ts verify deterministic tool/API behavior; no scored model-output evaluation dataset or quality/cost canary gate exists. |
| AIQ-06 | Medium | FAIL | Prompt or model changes are checked for cost impact before release, and canary releases are gated on quality metrics. | tests/ai*.test.ts verify deterministic tool/API behavior; no scored model-output evaluation dataset or quality/cost canary gate exists. |
| AIQ-07 | Medium | FAIL | Cost controls are in place where they fit: response or semantic caching, provider prompt caching, complexity-based model routing, batch processing for non-urgent work, and debouncing of interactive calls. | AI chat calls are not response/semantic cached or routed by complexity; a single configured model handles requests. |
| AIQ-08 | Medium | UNVERIFIED | AI token usage and cost are attributed per feature, user or tenant, and workflow, and reviewed against budgets regularly. | src/modules/ai/ai-config.ts records tenant token totals and platform/quota.ts monthly calls; per-user/feature/workflow financial attribution and recurring budget review not established. |
| AIQ-09 | Low | UNVERIFIED | Multi-agent and memory designs are deliberate: orchestrator by default, memory limited to behavior-relevant facts, with retrieval tested. | Assistant uses one bounded orchestrator and per-user saved conversations plus FTS retrieval; no long-term behavior-memory quality evaluation was performed. |
| OPS-01 | Medium | FAIL | Product analytics track core-feature usage events and cohort retention, not only total signups. | src/core/analytics.routes.ts exposes operational business metrics, not product cohort retention/activation analysis. |
| OPS-02 | Medium | UNVERIFIED | An activation event is defined and measured (completion within the first session or day), with automated nudges for users who do not activate. | No live operational evidence was provided; repository/local tests cannot establish this complete control. |
| OPS-03 | Low | UNVERIFIED | Drop-off detection compares users against their own activity baseline and triggers personalized re-engagement. | No live operational evidence was provided; repository/local tests cannot establish this complete control. |
| OPS-04 | Medium | UNVERIFIED | Support playbooks exist for each core feature, with defined automated, assisted, and incident tiers and human escalation for billing disputes and ambiguous reports. | No live operational evidence was provided; repository/local tests cannot establish this complete control. |
| OPS-05 | Medium | N/A | Any AI support agent connected to production uses scoped, read-mostly access, logs every action, and cannot perform refunds, deletions, or account changes without human approval. | No autonomous support/refund agent. The interactive AI Assistant has separate risks under AISEC-03/07/08. |
| OPS-06 | Low | UNVERIFIED | Onboarding delivers the core value quickly (templates or defaults) and discloses complexity progressively. | No live operational evidence was provided; repository/local tests cannot establish this complete control. |

## Remaining verified gaps

### AIQ-03 — Critical

Location/evidence: AI route has auth, message bounds, ten requests/minute per tenant/user, tenant call quotas and an optional tenant token cap; no hard per-user daily/monthly spend allocation or atomic reservation exists.

Failure scenario: Concurrent requests can overshoot a shared optional token cap, especially on the unlimited/default tenant.

Recommended fix: Reserve token/spend budgets atomically per user/tenant/plan before provider calls, settle actual usage, and set provider billing hard caps.

### API-01 — Critical

Location/evidence: src/shared/validation.ts:1 has broad Zod body coverage, but many handlers use Number(req.params.id) or hand-parsed query parameters without a shared explicit schema.

Failure scenario: Malformed IDs or unbounded query parameters can reach handlers inconsistently; protections differ across endpoints.

Recommended fix: Inventory each route and add typed path/query/header schemas with bounded values and negative tests; do not globally coerce arbitrary objects.

### API-02 — Critical

Location/evidence: src/shared/validation.ts:1 uses ordinary z.object for most write bodies, which strips unknown fields; only selected schemas are strict.

Failure scenario: Forbidden extra fields can be silently ignored rather than explicitly rejected, masking client misuse and creating risk when schemas later expand.

Recommended fix: Use strict allowlists on security-sensitive writes first; audit current clients for legitimate fields before making all schemas strict.

### EDGE-01 — Critical

Location/evidence: src/app.ts:195 plus AI per-user limiter and signup/confidential-report limiters; no universal API/public-read budget or complete per-user+IP limiter coverage.

Failure scenario: A bot can hammer expensive read/export or public endpoints without reaching the specific auth/AI limiters.

Recommended fix: Add endpoint-specific and tenant/user/IP budgets plus edge limits; test expected workload so sync and legitimate office traffic are not throttled.

### SECRET-01 — Critical

Location/evidence: Gitleaks history scan: 268 commits, 11 detections; ten exact fixture/alphabet false positives allowlisted. Real bearer artifact in July commit f7f644b, removed by ec4ecbf, remains in Git history.

Failure scenario: Anyone able to read that historical commit could have replayed its bearer token while it was live; current expiration/revocation in the original server was not inspected.

Recommended fix: Verify the original session is invalid, investigate access during exposure, and decide on coordinated history cleanup. Do not rewrite shared history automatically. Keep this detection visible to CI until resolved.

### AIQ-01 — High

Location/evidence: src/modules/ai/ai.routes.ts now validates provider schema, tool counts, argument sizes and reply length; no semantic content policy, bounded repair retry or evaluated fallback.

Failure scenario: A schema-valid hallucination or sensitive answer can still reach a user or generate a misleading business report.

Recommended fix: Add domain/schema/content evaluation and safe fallback; keep policy checks outside the model and prevent unapproved tool writes.

### AISEC-03 — High

Location/evidence: src/modules/ai/ai-tools.ts:62 and executeTool contain writable inventory/order/user/message tools executed from model tool_calls without a separate action-approval record.

Failure scenario: A prompt injection in retrieved text can ask a privileged user's assistant to send a message, change stock or delete records using that user's rights.

Recommended fix: Disable mutating AI tools for launch or implement server-side proposed actions requiring explicit user confirmation, revalidated permissions and transaction/idempotency support. A prompt-only instruction is insufficient.

### AISEC-04 — High

Location/evidence: src/modules/ai/ai.routes.ts:309 returns model prose after schema/length validation, without prompt/PII leakage screening.

Failure scenario: A manipulated prompt can cause internal instructions or sensitive authorized context to be echoed into a response or shared report.

Recommended fix: Add output policy checks and a safe fallback; evaluate extraction, injection and PII cases without treating the filter as authorization.

### AISEC-06 — High

Location/evidence: src/modules/ai/ai-tools.ts:614 executes with the human AuthUser and shared provider key; no dedicated scoped short-lived agent credential.

Failure scenario: Compromise of the assistant path inherits the full effective permission bundle of the requesting human.

Recommended fix: Give agent execution an explicit reduced capability identity; bind tool calls to approved actions and short-lived grants.

### AISEC-07 — High

Location/evidence: src/modules/ai/ai-tools.ts:62 and executeTool contain writable inventory/order/user/message tools executed from model tool_calls without a separate action-approval record.

Failure scenario: A prompt injection in retrieved text can ask a privileged user's assistant to send a message, change stock or delete records using that user's rights.

Recommended fix: Disable mutating AI tools for launch or implement server-side proposed actions requiring explicit user confirmation, revalidated permissions and transaction/idempotency support. A prompt-only instruction is insufficient.

### AISEC-08 — High

Location/evidence: src/modules/ai/ai.routes.ts:91 saves steps in ai_messages, but DELETE /messages clears them and calls are not an independent append-only audit stream.

Failure scenario: A destructive tool action can occur and its detailed tool transcript can subsequently be removed with chat history.

Recommended fix: Write redacted tool audit events before/after execution to an append-only store with actor, tenant, request ID, approval ID and retention controls.

### API-06 — High

Location/evidence: src/modules/ai/ai.routes.ts:40 directly returns an exception message on reindex failure. Central handler is generic for unexposed 5xx, but no correlation ID exists.

Failure scenario: A reindex filesystem/SQL error can reveal paths or schema details to an authorized caller and cannot be correlated with one request ID.

Recommended fix: Return a stable generic error code; redact server details and add generated request IDs to logs and response headers.

### AUTH-01 — High

Location/evidence: src/shared/auth.ts:23; custom DB-backed bearer-session implementation using bcryptjs and crypto.randomBytes.

Failure scenario: A future custom-session lifecycle bug affects every module without a maintained auth framework providing its guardrails.

Recommended fix: Adopt a maintained auth/session framework in a compatibility migration; preserve native/installed-node support and test expiry/recovery/revocation end to end.

### AUTH-03 — High

Location/evidence: public/js/api.js:14; normal tokens in localStorage, borrowed sessions in sessionStorage; src/shared/auth.ts uses 12-hour ordinary sessions and no refresh-token family.

Failure scenario: Any script injection can read a bearer token and reuse it until expiry or revocation.

Recommended fix: Move web sessions to Secure HttpOnly SameSite cookies with CSRF protection and rotation. Use secure platform storage for native clients; explicitly design offline-PC credentials.

### AUTH-05 — High

Location/evidence: src/shared/auth.ts:48 creates a fresh token on login, but role changes do not rotate an existing session; browser tokens are not HttpOnly cookies.

Failure scenario: A stolen pre-promotion token gains the newly granted permissions because the session is retained.

Recommended fix: Revoke or rotate sessions on privilege changes, reauthenticate for elevation, and complete the web-cookie/native-storage migration.

### AUTH-06 — High

Location/evidence: public/js/api.js:14; normal tokens in localStorage, borrowed sessions in sessionStorage; src/shared/auth.ts uses 12-hour ordinary sessions and no refresh-token family.

Failure scenario: Any script injection can read a bearer token and reuse it until expiry or revocation.

Recommended fix: Move web sessions to Secure HttpOnly SameSite cookies with CSRF protection and rotation. Use secure platform storage for native clients; explicitly design offline-PC credentials.

### AUTH-07 — High

Location/evidence: src/core/auth.routes.ts:135 keeps the current session during password change; reset ends all sessions and operators now revoke on reset.

Failure scenario: A shared or compromised current session remains valid after a password change, contrary to the strict all-session handbook requirement.

Recommended fix: Revoke all sessions and return the user through a deliberate reauthentication flow; update desktop, mobile and offline UX together.

### AUTH-12 — High

Location/evidence: src/app.ts:204 adds login account/IP and recovery IP limits; signup has only IP throttling; reset token consumption has only IP throttling.

Failure scenario: A distributed attacker can probe signup/reset attempts across many IPs without an account-wide attempt budget.

Recommended fix: Add persistent account/identifier throttles and abuse controls covering signup and reset consumption, with careful lockout policy and alerts.

### BACK-02 — High

Location/evidence: AI/QBO/SMTP/S3 now have bounded timeouts; src/modules/ai/ai.routes.ts still allows up to 12 sequential model calls, with no shared request budget/circuit breaker or generalized 429 backoff.

Failure scenario: An upstream outage occupies request slots for many sequential timeouts and can repeatedly trigger expensive retries by users.

Recommended fix: Set an overall request deadline, per-provider concurrency/circuit-breaker controls and bounded jittered retries for idempotent calls; queue unsafe retries.

### BACK-03 — High

Location/evidence: src/modules/ai/ai.routes.ts:255 runs the tool loop in the request; large exports and reindex are also synchronous/in-request work.

Failure scenario: Slow AI or a large export ties up requests or the SQLite event loop, delaying ordinary office actions.

Recommended fix: Move long work to durable jobs with progress/status, cancellation, bounded retries and per-tenant concurrency.

### CACHE-06 — High

Location/evidence: scripts/audit-load.mjs performed 450 local read requests at 5/15/30 clients over 100 items with no failures; no target peak or production-like dataset/hardware supplied.

Failure scenario: Payroll/export/stock workloads on real office data can saturate the single SQLite process even though a tiny local read probe passes.

Recommended fix: Agree peak concurrent users and dataset sizes, seed representative staging data, run mixed reads/writes/exports and establish latency/error/resource thresholds.

### DR-04 — High

Location/evidence: tests/backup.test.ts verifies snapshot integrity and restore mechanics; docs/SAAS-OPERATIONS.md asks operators to test occasionally, but no dated production-size restore drill record/schedule is present.

Failure scenario: A real disaster can expose missing upload/config/key recovery despite unit-level restore passing.

Recommended fix: Run and time a clean staging restore of DBs, uploads, configuration and keys, verify the app, record duration and schedule recurring drills.

### EDGE-08 — High

Location/evidence: server.ts:1 serves the standalone app on 0.0.0.0 and uses Host in local HTTP redirects; no general explicit accepted-host allowlist. Ordinary installed PCs bind localhost.

Failure scenario: A hostile Host can influence redirects or DNS-rebinding access to an on-site service; credentials remain required but network position alone is insufficient.

Recommended fix: Configure and validate explicit cloud/LAN hostnames and redirect origins; allow deliberate office IPs and test native/phone setup paths.

### LEGAL-02 — High

Location/evidence: public/index.html and public/mobile/index.html have password recovery/login but no linked terms/privacy pages; no complete B2B contract set was found.

Failure scenario: A new customer signs up or submits employee data without accessible product-specific terms and privacy disclosures.

Recommended fix: Have the owner/counsel approve documents based on actual data flows and link them in signup/login/help; do not fabricate legal guarantees.

### LEGAL-04 — High

Location/evidence: src/core/users.routes.ts deactivates accounts; no complete user-data cascade across employee files, messages, logs, backups and third parties exists.

Failure scenario: Deleting or disabling a login leaves personal records and uploads indefinitely without a tracked erasure decision.

Recommended fix: Design a retention-aware export/erasure workflow with record mapping, legal holds, approval/audit, third-party tasks and backup expiry.

### MOBILE-01 — High

Location/evidence: public/js/api.js:17; native Capacitor shell reuses browser storage, with no Keystore/Keychain storage adapter.

Failure scenario: A rooted/forensically accessed device can recover a long-lived bearer token from app storage.

Recommended fix: Add a platform-backed secure-storage adapter and migration/clear-on-signout tests on real Android/iOS devices.

### OBS-01 — High

Location/evidence: src/app.ts:228 emits text request logs without generated correlation IDs or a structured trace context.

Failure scenario: Operators cannot connect one failed action across requests, provider calls and sync replay quickly.

Recommended fix: Add generated request IDs, structured redacted JSON logs, tenant/actor context and trace propagation; connect to an approved central sink.

### SECRET-05 — High

Location/evidence: .github/workflows/production-checks.yml adds remote Gitleaks scanning; no repository pre-commit secret hook exists and push-protection settings were not inspected.

Failure scenario: A developer can commit a new credential locally; remote scanning catches it only after the push has already disclosed it.

Recommended fix: Add a documented local staged-file secret hook and enable provider push protection; verify it blocks a synthetic secret.

### WEB-04 — High

Location/evidence: src/app.ts:116; X-Frame-Options DENY and proxy-only HSTS now exist, but enforced CSP/frame-ancestors is missing. ZAP rule 10038 confirms.

Failure scenario: An HTML injection has no CSP script boundary; proxy framing protection depends on one header; the complete prescribed header set is absent.

Recommended fix: Inventory inline handlers, generated print windows and workers; migrate to nonce/hash scripts and deploy an enforced CSP including frame-ancestors, object-src and base-uri. Keep LAN/native compatibility verified.

### WEB-05 — High

Location/evidence: src/app.ts:116; X-Frame-Options DENY and proxy-only HSTS now exist, but enforced CSP/frame-ancestors is missing. ZAP rule 10038 confirms.

Failure scenario: An HTML injection has no CSP script boundary; proxy framing protection depends on one header; the complete prescribed header set is absent.

Recommended fix: Inventory inline handlers, generated print windows and workers; migrate to nonce/hash scripts and deploy an enforced CSP including frame-ancestors, object-src and base-uri. Keep LAN/native compatibility verified.

### AIQ-05 — Medium

Location/evidence: tests/ai*.test.ts verify deterministic tool/API behavior; no scored model-output evaluation dataset or quality/cost canary gate exists.

Failure scenario: A prompt/model change can double cost or degrade answers while deterministic API tests still pass.

Recommended fix: Create versioned synthetic/regression evaluation datasets with quality/safety/cost thresholds and controlled model comparisons before rollout.

### AIQ-06 — Medium

Location/evidence: tests/ai*.test.ts verify deterministic tool/API behavior; no scored model-output evaluation dataset or quality/cost canary gate exists.

Failure scenario: A prompt/model change can double cost or degrade answers while deterministic API tests still pass.

Recommended fix: Create versioned synthetic/regression evaluation datasets with quality/safety/cost thresholds and controlled model comparisons before rollout.

### AIQ-07 — Medium

Location/evidence: AI chat calls are not response/semantic cached or routed by complexity; a single configured model handles requests.

Failure scenario: Repeated questions incur repeated provider spend and consume concurrency during spikes.

Recommended fix: Measure workload first; cache only safe tenant/user-scoped results, use provider prompt caching and evaluate smaller-model routing without caching stale business facts.

### API-07 — Medium

Location/evidence: src/app.ts:356 returns the shell for unknown non-API paths; unknown API paths can use framework 404 handling.

Failure scenario: A typo or missing route appears as a successful shell or generic framework page with no clear recovery action.

Recommended fix: Define explicit API JSON 404 and useful app not-found/timeout views without breaking legitimate SPA deep links.

### AUTHZ-15 — Medium

Location/evidence: src/core/auth.routes.ts:1 and src/platform/platform-users.ts:1 accept a current bearer session without MFA or fresh-password challenge for privileged operations.

Failure scenario: A stolen admin session can change accounts, permissions or exports without a second authentication step.

Recommended fix: Add step-up authentication and MFA for platform operators and high-value tenant actions.

### BACK-05 — Medium

Location/evidence: AI/QBO/SMTP/S3 now have bounded timeouts; src/modules/ai/ai.routes.ts still allows up to 12 sequential model calls, with no shared request budget/circuit breaker or generalized 429 backoff.

Failure scenario: An upstream outage occupies request slots for many sequential timeouts and can repeatedly trigger expensive retries by users.

Recommended fix: Set an overall request deadline, per-provider concurrency/circuit-breaker controls and bounded jittered retries for idempotent calls; queue unsafe retries.

### BACK-06 — Medium

Location/evidence: server.ts:1 timers and src/platform/offsite.ts have logs/status files but no general dead-letter queue or operator alert/replay mechanism.

Failure scenario: Repeated backup, reminder or external-job failures can continue silently between manual checks.

Recommended fix: Persist failed jobs, alert a named operator and provide safe replay with idempotent processing.

### BACK-08 — Medium

Location/evidence: AI/QBO/SMTP/S3 now have bounded timeouts; src/modules/ai/ai.routes.ts still allows up to 12 sequential model calls, with no shared request budget/circuit breaker or generalized 429 backoff.

Failure scenario: An upstream outage occupies request slots for many sequential timeouts and can repeatedly trigger expensive retries by users.

Recommended fix: Set an overall request deadline, per-provider concurrency/circuit-breaker controls and bounded jittered retries for idempotent calls; queue unsafe retries.

### BACK-09 — Medium

Location/evidence: src/app.ts:1 exposes unversioned /api routes; no OpenAPI contract or formal deprecation/sunset policy is present.

Failure scenario: A response or route change breaks installed clients without a parallel compatibility version.

Recommended fix: Document the existing REST contract, introduce backward-compatible API versioning and a client upgrade/deprecation policy.

### BACK-12 — Medium

Location/evidence: src/modules/ai/rag.ts:16 refreshes search lazily every five minutes; multiple features poll for changes.

Failure scenario: A record or ACL/source change may remain stale in the search index until a reindex, and failed derived updates lack durable replay.

Recommended fix: Define freshness requirements, invalidate affected retrieval chunks on writes/permission changes, and persist retryable derived-update events.

### CACHE-04 — Medium

Location/evidence: src/app.ts:314 applies no-cache to unversioned assets; service worker uses a manually versioned shell.

Failure scenario: Large clients revalidate many assets and depend on manual cache-version bumps after updates.

Recommended fix: Fingerprint immutable assets and deploy matching HTML/worker manifests; keep private API responses no-store.

### CACHE-05 — Medium

Location/evidence: No cache hit/miss instrumentation in src/core/messages.routes.ts or src/modules/ai/rag.ts.

Failure scenario: A cache change can add complexity without demonstrating reduced upstream or DB cost.

Recommended fix: Record hit/miss and refill timing per cache type with tenant-safe aggregation.

### CACHE-08 — Medium

Location/evidence: AI chat calls are not response/semantic cached or routed by complexity; a single configured model handles requests.

Failure scenario: Repeated questions incur repeated provider spend and consume concurrency during spikes.

Recommended fix: Measure workload first; cache only safe tenant/user-scoped results, use provider prompt caching and evaluate smaller-model routing without caching stale business facts.

### DATA-03 — Medium

Location/evidence: src/core/auth.routes.ts:31 and many route lists use full-row queries; no query-count budget is enforced.

Failure scenario: Growing records or a newly added sensitive column can increase payload/query cost or exposure unless each response is rechecked.

Recommended fix: Select explicit response columns on hot paths and add measured query-count budgets for representative list screens.

### DATA-05 — Medium

Location/evidence: src/shared/db.ts:1 helpers execute statements without a slow-query recorder; request logs report only whole-request elapsed time.

Failure scenario: A slow SQL query under load cannot be identified from SQL-level latency statistics.

Recommended fix: Add bounded, redacted slow-query timing and review it using production-like data and SQLite EXPLAIN QUERY PLAN.

### DATA-09 — Medium

Location/evidence: src/core/users.routes.ts:102 and profile/settings edits do not require an expected version or If-Match.

Failure scenario: Two administrators editing the same record can silently overwrite the earlier administrator's changes.

Recommended fix: Add optimistic version checks to collaborative business edits and return a conflict with reload/merge UX; retain atomic stock transitions.

### DATA-11 — Medium

Location/evidence: src/shared/db.ts uploadDir and diskStorage upload handlers use local files; DBs store paths, but serving is authenticated local disk rather than object storage/CDN.

Failure scenario: A single application volume is a storage and scaling bottleneck; losing it requires restoring both databases and uploads.

Recommended fix: For cloud scale, add a private object-storage adapter and authorized expiring downloads; keep deliberate offline/local storage for installed PCs.

### DEPLOY-07 — Medium

Location/evidence: railway.json:1 defines ordinary restart/healthcheck; module entitlements can disable modules but no canary/error-rate rollback controller exists.

Failure scenario: A bad release reaches all users before a person notices and rolls it back.

Recommended fix: Define staging promotion and canary/kill-switch policy plus observed automatic rollback thresholds; verify against actual hosting topology.

### DR-05 — Medium

Location/evidence: docs/SAAS-OPERATIONS.md:162 describes daily backups but no business-approved RTO/RPO.

Failure scenario: Daily snapshots may lose nearly 24 hours of work even if the business assumes minutes.

Recommended fix: Obtain explicit acceptable outage/data-loss targets and configure/test backup frequency and failover against those targets.

### EDGE-13 — Medium

Location/evidence: src/app.ts rate limiters use fixed windows and constants; tenant plan quotas exist separately in src/platform/quota.ts.

Failure scenario: A traffic spike is handled only by static limits; all plans share those limits regardless of cost or current overload.

Recommended fix: Add load-aware concurrency budgets and plan-specific admission policies once target traffic and production metrics are known.

### MOBILE-04 — Medium

Location/evidence: mobile-app/android/app/src/main/AndroidManifest.xml and public/mobile/native.js permit configurable local HTTP server addresses; no server pin/rotation policy verified.

Failure scenario: An employee configuring an HTTP endpoint can send a bearer session over an unencrypted network.

Recommended fix: Require TLS for production/native endpoints, retain explicit safe development exceptions, and validate certificate trust/rotation on devices.

### OBS-06 — Medium

Location/evidence: src/app.ts:228 emits text request logs without generated correlation IDs or a structured trace context.

Failure scenario: Operators cannot connect one failed action across requests, provider calls and sync replay quickly.

Recommended fix: Add generated request IDs, structured redacted JSON logs, tenant/actor context and trace propagation; connect to an approved central sink.

### OPS-01 — Medium

Location/evidence: src/core/analytics.routes.ts exposes operational business metrics, not product cohort retention/activation analysis.

Failure scenario: The team can see stock totals while missing that new customers stop using the app after onboarding.

Recommended fix: Define privacy-conscious product events and cohort views with clear purpose, retention and access controls.

### SECRET-10 — Medium

Location/evidence: src/modules/ai/ai.routes.ts:226 includes provider response snippets in thrown errors; central handler logs Error details. Startup password logging was removed, but no central log redactor exists.

Failure scenario: A provider error echoing request content or a credential can be persisted in deployment logs.

Recommended fix: Redact structured logs and provider errors at the boundary; retain status/request IDs, not raw response bodies or secrets.

### SUPPLY-05 — Medium

Location/evidence: .node-version:1 is a major-only 22 and package.json permits >=22.13; CI pins versions but hosting runtime/installable artifacts are not fully pinned.

Failure scenario: A rebuild can silently pick a different major runtime and change SQLite/native behavior.

Recommended fix: Pin and record supported production runtime versions and maintain a scheduled upgrade policy; verify Node 22, Node 24 and Electron separately.

### SUPPLY-07 — Medium

Location/evidence: electron/main.cjs and scripts launch server/child processes with inherited process.env; provider adapters read shared environment variables.

Failure scenario: A compromised subprocess/dependency receives credentials unrelated to the operation it performs.

Recommended fix: Pass minimum explicit environment/configuration to subprocesses and components; retain required runtime proxy/identity bindings in managed environments.

### TEST-02 — Medium

Location/evidence: vitest.config.ts:1 has no coverage provider or enforced coverage threshold; CI runs tests and browser checks but no coverage gate.

Failure scenario: A newly untested critical path can merge even while existing tests remain green.

Recommended fix: Collect measured coverage for critical security/business modules, establish an honest baseline, and ratchet meaningful branch coverage instead of inventing a percentage.

### UX-05 — Medium

Location/evidence: server.ts uses a required office TZ behind proxy; attendance is intentionally office-time-based, but user-level communication timezone preferences are absent.

Failure scenario: A remote user receives scheduled notifications on office time and may misunderstand date boundaries.

Recommended fix: Keep payroll in the configured office zone; add explicit user display/notification timezone preferences where remote users are supported.

### WEB-07 — Medium

Location/evidence: src/app.ts:116; X-Frame-Options DENY and proxy-only HSTS now exist, but enforced CSP/frame-ancestors is missing. ZAP rule 10038 confirms.

Failure scenario: An HTML injection has no CSP script boundary; proxy framing protection depends on one header; the complete prescribed header set is absent.

Recommended fix: Inventory inline handlers, generated print windows and workers; migrate to nonce/hash scripts and deploy an enforced CSP including frame-ancestors, object-src and base-uri. Keep LAN/native compatibility verified.

### AUTHZ-14 — Low

Location/evidence: src/shared/db.ts:326; REST resource paths generally use SQLite integer IDs.

Failure scenario: An authenticated caller can enumerate identifiers more cheaply, increasing pressure on every object-level permission check.

Recommended fix: Use opaque public IDs where enumeration matters; keep existing server authorization and add compatibility lookup/migration tests.

### UX-06 — Low

Location/evidence: public/index.html and public/mobile/index.html have password recovery/login but no linked terms/privacy pages; no complete B2B contract set was found.

Failure scenario: A new customer signs up or submits employee data without accessible product-specific terms and privacy disclosures.

Recommended fix: Have the owner/counsel approve documents based on actual data flows and link them in signup/login/help; do not fabricate legal guarantees.

## PASS check IDs

AUTH-02, AUTH-04, AUTH-08, AUTHZ-05, AUTHZ-08, AUTHZ-09, AUTHZ-12, SECRET-02, SECRET-04, SECRET-06, SECRET-09, WEB-01, WEB-06, SUPPLY-01, AISEC-01, AISEC-02, AISEC-05, AISEC-10, MOBILE-02, BACK-01, BACK-07, BACK-10, BACK-11, DATA-01, DR-01, TEST-03, TEST-04

## FAIL check IDs

AUTH-01, AUTH-03, AUTH-05, AUTH-06, AUTH-07, AUTH-12, AUTHZ-14, AUTHZ-15, SECRET-01, SECRET-05, SECRET-10, API-01, API-02, API-06, API-07, WEB-04, WEB-05, WEB-07, EDGE-01, EDGE-08, EDGE-13, SUPPLY-05, SUPPLY-07, AISEC-03, AISEC-04, AISEC-06, AISEC-07, AISEC-08, MOBILE-01, MOBILE-04, BACK-02, BACK-03, BACK-05, BACK-06, BACK-08, BACK-09, BACK-12, DATA-03, DATA-05, DATA-09, DATA-11, CACHE-04, CACHE-05, CACHE-06, CACHE-08, DR-04, DR-05, DEPLOY-07, TEST-02, OBS-01, OBS-06, UX-05, UX-06, LEGAL-02, LEGAL-04, AIQ-01, AIQ-03, AIQ-05, AIQ-06, AIQ-07, OPS-01

## N/A check IDs

AUTH-09, API-08, WEB-02, WEB-08, EDGE-10, DATA-04, DATA-10, PAY-01, PAY-02, PAY-03, PAY-04, PAY-05, PAY-06, PAY-07, PAY-08, PAY-10, PAY-11, PAY-12, OPS-05

## UNVERIFIED check IDs

FRAME-01, FRAME-02, FRAME-03, FRAME-04, FRAME-05, AUDIT-01, AUDIT-02, AUDIT-03, AUDIT-04, AUDIT-05, AUDIT-06, AUDIT-07, WF-01, WF-02, WF-03, WF-04, WF-05, WF-06, AUTH-10, AUTH-11, AUTH-13, AUTH-14, AUTHZ-01, AUTHZ-02, AUTHZ-03, AUTHZ-04, AUTHZ-06, AUTHZ-07, AUTHZ-10, AUTHZ-11, AUTHZ-13, SECRET-03, SECRET-07, SECRET-08, API-03, API-04, API-05, API-09, API-10, WEB-03, EDGE-02, EDGE-03, EDGE-04, EDGE-05, EDGE-06, EDGE-07, EDGE-09, EDGE-11, EDGE-12, SUPPLY-02, SUPPLY-03, SUPPLY-04, SUPPLY-06, SUPPLY-08, AISEC-09, MOBILE-03, MOBILE-05, MOBILE-06, BACK-04, DATA-02, DATA-06, DATA-07, DATA-08, DATA-12, DATA-13, CACHE-01, CACHE-02, CACHE-03, CACHE-07, CACHE-09, DR-02, DR-03, DR-06, DEPLOY-01, DEPLOY-02, DEPLOY-03, DEPLOY-04, DEPLOY-05, DEPLOY-06, DEPLOY-08, DEPLOY-09, TEST-01, TEST-05, TEST-06, TEST-07, OBS-02, OBS-03, OBS-04, OBS-05, OBS-07, OBS-08, OBS-09, OBS-10, OBS-11, OBS-12, PLAT-01, PLAT-02, PLAT-03, PLAT-04, PLAT-05, PLAT-06, PLAT-07, UX-01, UX-02, UX-03, UX-04, PAY-09, MAIL-01, LEGAL-01, LEGAL-03, LEGAL-05, LEGAL-06, LEGAL-07, LEGAL-08, LEGAL-09, LEGAL-10, LEGAL-11, LEGAL-12, AIQ-02, AIQ-04, AIQ-08, AIQ-09, OPS-02, OPS-03, OPS-04, OPS-06
