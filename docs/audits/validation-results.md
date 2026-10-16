# Second-pass validation — 16 October 2026

Source cutoff: `restructure/module-architecture` at
`495db101c3efbe4e4546221fed2db3af233b00aa`, merged into `production` with the audit fixes.
Earlier reports describe older trees. The verification summary in
`evidence/second-pass-verification.json` describes the original second-pass run.

## Assisted recovery follow-up

Final schema-84 implementation supports a solo provider operator: fresh password and documented
verification, advance notice/cancellation to the existing owner email, a server-enforced
24-hour wait, then fresh verification and a fifteen-minute single-use recovery link. Requests
expire after 48 hours. A different operator cannot bypass the waiting period. Verified tenant
peer recovery instead requires the assisting administrator's password and existing factor.
Ordinary password resets preserve MFA and invalidate pending MFA login challenges.

- **Full regression: 286 files / 2,881 tests passed**, 527.39 seconds
  ([log](evidence/recovery-regression.txt)). This is the completed run after the solo-support,
  cancellation and final synchronized restriction changes.
- **Focused: 8 files / 54 tests passed**, 43.42 seconds
  ([log](evidence/recovery-focused.txt)): fresh proof, early approval denial, later solo approval,
  cross-tenant denial, cancellation/reuse, expiry, changed contact, failed send, stale challenges,
  mandatory re-enrollment, site-mode restriction and schema-83 migration column order.
- **Playwright: 10 scenarios passed**, 36.8 seconds
  ([log](evidence/recovery-playwright.txt)). New scenarios cover actual reset-link UI and forced
  enrollment, plus inert cancellation GET previews and explicit single-use confirmation. The
  browser recovery cases use disposable preapproved/cancellation fixtures; the request/approval
  API tests use mocked email, not a real provider or a wall-clock 24-hour wait.
- Typecheck and delivered JS syntax checks passed ([TypeScript log](evidence/recovery-typecheck.txt)).
  Database types regenerated successfully ([generator log](evidence/recovery-dbtypes.txt)).
- Staged Gitleaks passed ([log](evidence/recovery-secrets.txt)); the commit hook scans final staged
  content again. This does not close historical-secret findings or dependency advisories.

Earlier runs were interrupted to incorporate review findings and the user's solo-support
constraint. One broad run exposed an existing mobile handoff test's fixed-delay assumption;
that test now waits for the actual package control before checking the required-item behavior.
The complete final run includes that correction. No application handoff behavior was changed.

The [operational runbook](../operations/assisted-account-recovery.md) covers manual identity
verification, notices, cancellation, expiry, legal/process approval, and release limits.
The non-secret recovery restriction synchronizes to updated office hosts; a disconnected host
cannot receive a cloud revocation until reconnection. Real email delivery, device acceptance,
console Windows Hello/passkeys, multi-replica limits and externally immutable/retention-complete
audit storage remain unverified or unfinished. No live account, email or hosting settings
were changed. These results establish this increment's tests, not a full production sign-off.

## Earlier password storage follow-up

Versioned scrypt storage replaces all application bcrypt writers; bounded bcrypt verification
remains for legacy credentials. No dependency or database-schema change was needed.

- Full regression: **285 files / 2,872 tests passed**, 498.47 seconds
  ([log](evidence/password-regression.txt)). This run started before the final installed-site
  migration guard/test was added and is broad regression evidence, not an exact-final-tree run.
- Final focused regression: **2 files / 9 tests passed**, 45.19 seconds
  ([log](evidence/password-focused.txt)), including that site credential-ownership guard,
  both account stores, long Unicode input, legacy truncation rejection, malformed hashes,
  failed-login non-migration and every configured role's credential-change workflow.
- Final Playwright: **8 scenarios passed**, 27.1 seconds
  ([log](evidence/password-playwright.txt)). The MFA scenario now creates and signs into the
  account with a 100-character password through both desktop and mobile UIs.
- Final TypeScript check passed ([log](evidence/password-typecheck.txt)).
- Staged secret scan passed ([log](evidence/password-secrets.txt)); commit hook scans the
  final staged content again. No historical-secret or advisory finding is closed by this.

The initial focused all-role workflow exceeded its 20-second test timeout under the stronger
derivation cost. Only that test's timeout was extended to 60 seconds; no test-only hash cost
or production policy bypass was introduced. The final focused run passes at real parameters.

The [migration runbook](../operations/password-migration.md) describes old-site compatibility,
rollback restrictions, recovery for legacy long passwords, and synchronous CPU/memory limits.
Password minimum policy, console MFA, fresh privileged verification and native vault storage
remain open. Live rollout, real-device/installed-host acceptance and representative sign-in
load were not performed. This is a tested password-storage increment, not release sign-off.

## Earlier standards follow-up

The [standards research increment](standards-research.md) adds account-scoped MFA failure
limits and revocation of other sessions when disabling MFA. Validation after these changes:

- Full regression: **284 files / 2,867 tests passed**, 277.78 seconds, using
  `npm test -- --fileParallelism --maxWorkers=2` ([log](evidence/standards-regression.txt)).
- Playwright: **8 scenarios passed**, 17.6 seconds, including the expanded desktop factor-disable
  flow and revoked mobile browser session ([log](evidence/standards-playwright.txt)).
- `npm run typecheck` passed; MFA and route-class focused run: 9 tests passed.
  After replacing the two new tests' fixed passwords with runtime-generated values,
  the MFA file was rechecked: 8 tests passed. Application behavior was unchanged.
- Staged Gitleaks scan passed with no findings ([log](evidence/standards-staged-secrets.txt)).
  A first scan used multiple positional paths incorrectly and scanned wider local artifacts;
  it is not the staged-source result. Reviewed fixed synthetic passwords in the new tests were
  replaced rather than added to the secret scanner's ignore list.
- The sandbox initially prevented temporary HTTP listeners; API/browser tests were rerun
  successfully with local-server execution permitted. No live target was tested.

No new ZAP, capacity or dependency scan was performed for this bounded authentication change;
their earlier scopes and unresolved findings below still apply. Research identifies additional
open gaps; these results are not a production sign-off or standards certification.

## Earlier second-pass results

| Check | Scope and result |
|---|---|
| TypeScript | `npm run typecheck` passed after latest source merge |
| Database types | Regenerated from a disposable database; no live migration/data changes |
| JavaScript parse | 171 delivered JS files across public, website and owner console passed syntax checks |
| Full regression | **284 files / 2865 tests passed**; `npm test -- --fileParallelism --maxWorkers=2`, isolated fixture paths |
| Latest source delta | 4 files, 153 tests passed: mobile frontend, order release, QA hold and registered-route boundary |
| Playwright + axe | 8 scenarios passed on final merged source, 17.1 seconds; no Serious/Critical axe findings on the two tested login pages |
| ZAP 2.17.0 | Disposable local unauthenticated scan: 0 High, 2 Medium, 0 Low, 2 Informational; 109 discovered endpoints, all GET |
| Local capacity probe | 450 synthetic read requests, 5/15/30 clients, zero failures; p95 approximately 17/54/124 ms |
| npm | Root 0 Critical/1 High/10 Moderate; launcher 0/0/8; mobile 0/0/0. Runtime reachability and unresolved gate described in dependency-audit.md |
| Gitleaks | Current src/public/tests/website/console and staged changes scanned with redaction; reviewed synthetic fixtures only. Historical credential finding remains |
| Connected service | Read-only Railway/GitHub metadata inspected; no production scan/load/deployment or data mutation |

The 8 browser scenarios exercise wrong-password/keyboard login, idempotent stock adjustment,
server logout revocation, 360/390 px mobile navigation, offline failure, cookie WebSockets, null
PWA bearer metadata, hostile CORS/oversized inputs, cross-user notes/access revocation, policy
links, inert uploaded scripts/message HTML, desktop authenticator enrollment and one-use recovery
codes across desktop/mobile sign-in. Browser screenshots/traces use synthetic data and are
retained as CI artifacts. These are selected workflows, not complete cross-browser or all-screen
accessibility certification. Native Android/iOS, Windows installer/signing and physical devices
were not validated by Playwright.

The first combined regression run was invalidated by dependency changes. Subsequent runs found
actual merge issues and stale expectations around stricter session revocation, OAuth state and
generic server errors; those were corrected and focused tests rerun. One mobile recovery test
used an 80 ms IndexedDB timing assumption; it now awaits the actual saved/retry/confirmed state.
Tests do not permit old sessions to remain valid merely to retain previous assertions.

The tenant-prefixed policy links, public website cookie handoff, Billing and preview route wiring also passed a 28-test focused run after their final changes.

The initial ZAP High metadata alert was a 200 SPA fallback at `/metadata/instance`, not an observed
metadata proxy. Unknown paths now return 404, with a direct regression test. Missing headers on
public policy pages were real and fixed. Remaining Medium findings are the deliberate inline
style policy and HTTPS image sources. No authenticated ZAP crawl or live-edge test is claimed;
ZAP reported add-on age/warnings. Its scanner snapshot preceded the last small sale-line allocation merge and final policy-link/preview wiring changes; the later changes have direct API/browser regression coverage. This scan supplements those tests and does not replace an exact-release authenticated scan or a current independent penetration test.

The local load probe uses 100 items, read-only traffic and test-mode rate limits. It does not test
large payroll/exports, sustained writes, failover, production hardware, representative datasets
or a promised user ceiling. A complete live-size restore with keys/files, actual alert delivery,
WAF/email DNS/private-object policies and legal approvals remain release evidence gaps.

## Console passkeys — 2026-10-16

Full regression: **287 files / 2,887 tests passed** (525.80 seconds). Playwright: **11 scenarios
passed** (37.4 seconds), including real WebAuthn enrollment/login, replay rejection, mandatory
policy activation, last-key protection and rejection of a signed assertion without user
verification. TypeScript, frontend/script syntax, schema-type generation and staged Gitleaks
checks passed. The pinned browser bundle reproduced without a diff. Evidence:
`evidence/console-passkeys-{full,playwright,typecheck,staged-secrets}.txt`.

Runtime npm audit remains nonzero (0 Critical / 1 High / 3 Moderate); see the dependency report.
Physical Windows Hello/security-key behavior, production origin/proxy/cookie enforcement,
external access restrictions and mandatory enrollment are unverified rollout checks. This
increment does not close broader tenant step-up, password-policy or native-vault findings.
