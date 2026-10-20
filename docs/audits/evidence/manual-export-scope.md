# Manual accounting export security verification scope

20 October 2026; production base affa182adba8ea3b66cd63b484fca7d21a68ae2a.
User authorized continued audit/fixes/research/documentation and production-branch push.
Attached guide remains an audit reference, not authority for live financial/provider changes.

Two High scoped product gaps were reproduced before code changes: stale-session HTTP export
returned 200 instead of requiring proof, and a priced CKD component produced a second line.
Both failing reproduction cases are retained. Further review added mandatory reviewed
connection generation and one-SQL target/status snapshot to prevent old displayed-company
metadata pairing with a newer target. Export roles gain only needed destination metadata;
configuration and management stay administrator-only.

Manual exports capture current actor/session/credential and order/items, rechecking before each
new provider request, including after refresh and before 401 resend. Known accepted party/
financial receipts are preserved after actor revocation; later calls stop. Already-sent writes
cannot be recalled. Shared adapter filters commercial lines for all callers. Existing automatic
intent policy and offline accounting/payroll claims remain unchanged.

Twenty-eight new focused cases cover freshness, valid CKD parent/component projection, seven
actor/source mutations during a held lookup, known party/financial acceptance after revocation,
refresh/401 races, object permission order, purchase/job identity verification, tenant-bound
sessions, different/same-company reconnect rejection, malformed/missing target, least-privilege
status access status-snapshot interleaving, missing source precondition and source/line changes after preview. Existing lifecycle/cache/automatic-job/MFA/
client retry/offline-accounting tests supplement these. Existing HTTP cache fixtures initially
failed after the required body contract changed; they were updated to carry the original
reviewed generation. Those two fixture failures are retained separately from reproduced bugs.
A TypeScript null-body fixture issue was corrected with explicit malformed JSON; compiler
output retained. Final type/focused/browser/full checks use final runtime/tests.

Five final Playwright cases cover explicit order/company/environment/total review, cancellation before
HTTP, cancelled reauthentication with no link, successful password reauthentication/export,
real server rejection of a stale displayed generation, and account/company/view changes during confirmation. Initial thirty-case browser results
before final binding, the thirty-one-case pre-context run, and final thirty-four-case output/metadata are distinguished. No OTP or
recovery code is requested from the owner. Screenshots are synthetic local evidence only.

Actual server.ts smoke rejects stale proof and missing target, accepts fresh bound export,
replays its exact HTTP receipt and verifies its stored payload hash matches only the commercial
CKD parent. It uses disposable SQLite files and NODE_ENV=test Intuit transport; no real money,
provider, customer account, deployment or hosted configuration was changed. No schema,
migration-version, dependency or stored receipt/credential format change.

One preliminary full regression was stopped with exit 130 to add the missing pre-confirmation
actor/company/view guard. The next browser startup was interrupted with exit 130 while adding
current-order preview/source preconditions; its startup-exited output is not a completed test
pass or a product-failure diagnosis. The final contract requires the preview's source hash and
destination, not stale list data. Runtime/tests freeze before the final completed full regression. Exact counts/timings are in
manual-export-verification.json. Intuit search/direct retrieval failed; OWASP Authentication/
Transaction Authorization and HTTP RFC 9110 were retrieved. No new claim about remote dedupe
window or provider reconciliation follows. No one-use signed transaction approval is claimed.

Offline local-factor/command binding, broader export/field minimization, provider/accountant
currency/tax/company acceptance, uncertain-write repair, native/Windows/hosting/restore/load,
external alerting and other scorecard controls remain. Whole-control counts unchanged; release
hold remains. Action-family inventory documents engineering work still owed, not owner coding.


The first full-preview browser run had 33 passes and one fixture failure: navigation correctly
closed the confirmation, while the test tried to click the removed dialog. The fixture now
asserts cancellation/no POST. A rerun was accidentally started before that run released its
server; its port-in-use startup failure is not counted as a test pass. The shared text output
was combined with the prior finishing process and contained NUL padding. The archived combined
text is explicitly marked non-standalone with padding removed; failed-run JSON and partial
original text are retained. A clean serial 34-case run passed afterward. Transient failure
trace/screenshot paths in logs are not archived; the successful synthetic screenshot is.
