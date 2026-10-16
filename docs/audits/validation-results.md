# Second-pass validation — 16 October 2026

Source cutoff: `restructure/module-architecture` at
`495db101c3efbe4e4546221fed2db3af233b00aa`, merged into `production` with the audit fixes.
Earlier reports describe older trees. The verification summary in
`evidence/second-pass-verification.json` describes the original second-pass run.

## Standards follow-up

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
