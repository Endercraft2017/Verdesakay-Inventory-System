# Real-code UI scratch preview

Run from the repository root after `npm ci`:

```sh
npm run ui:scratch
npm run ui:scratch:serve
npm run test:ui:scratch
```

The builder recreates `work/ui-scratch/index.html` from the current app source.
The server serves those same bytes on workspace loopback port 4178. That address
is not reachable at localhost on a remote user's computer. Deliver the owner-only
HTTPS Site specified in AGENTS.md and docs/design/ui-scratch-hosting.json.
This workspace's managed Chromium blocks direct `file://` previews; verification
uses loopback. Opening a downloaded file in another browser is not covered by
that loopback test.

Only `work/ui-scratch/` is disposable. Cleanup requires its matching ownership
manifest and refuses symbolic links and unknown files or empty folders. Keep
user files and retained investigation evidence elsewhere. The builder constructs
the new payload before clearing owned output. Templates, adapters and review
notes live here, outside generated output. A clean build removes old verification
evidence; the verification command generates and embeds fresh evidence.

For the current three Chunk 28 views, app scripts are copied verbatim and hashed.
The current list and optional photo presentations run against the same shared
shell/styles and row handlers for comparison. Update the selected sources, fixtures and notes
when reviewing a different chunk; no parallel hand-styled phone mock is used.

Preview adapters isolate transport, profile, stock records and storage in memory.
The actual picker, queue, saved-request model, handlers and Quick Orbit run in
the frames. Unsupported routes are explicitly labeled. Fixture reset and reload
start fresh sessions; they do not prove crash persistence. CSP forbids external
connections. No real account token or production record is embedded.

`test:ui:scratch` needs installed Chromium (`CHROME_PATH` can override its path)
and local process/network permission. It runs Playwright, axe, geometry/source
checks, guarded rebuild cases, then the actual app against an automatically
created and removed SQLite backend. The latter uses native IndexedDB to check
reload/replay, partial correction, competing tabs and authenticated image reads. Results and screenshots are
inside the generated HTML and `evidence/`. Physical devices, cameras, actual site
synchronization and observed employee task performance require separate checks.

The approved Batch Stock In/Out list/photo changes are registered in the mobile
bootstrap and v162 shell cache. The SO/CKD/JO preparation examples remain draft-only
review helpers; they are not imported into production routes and do not post stock.
Publishing this scratch Site never deploys the application. The original shared
Work review helper remains available through the ui:scratch:shared commands.

The default review now compares the actual native SO/JO screens with the
preparation integration proposal. Only the prototype helper changes; native
production routes are not registered to it. `?review=batch` retains the batch
regression fixture profile.

```sh
# Capture fictional requirements and assert reservation/stock behavior in SQLite
node scripts/ui-scratch/capture-preparation.mjs
npm run ui:scratch
# Verify current generated proposal and embed its screenshots/evidence
node scripts/ui-scratch/verify-preparation.mjs
```

The left comparison uses unchanged SO/kit-release source with business writes
disabled. The right simulates reviewed SO incremental allocations and JO total
picked quantities, with the existing sticker verifier and an explicitly fictional
reader. It covers unbatched bulk stock. Serialized/batched identity selection,
final release, and durable uncertain-response recovery remain native integration
requirements. No simulation posts a physical adjustment or calls production.

The current default (`notes.review = so-release`) reviews only native SO
authorization and picking. It executes edited real `so.js` and shared RoleUI/CSS,
with frozen pre-redesign SO/RoleUI/mobile-v2 source for the optional Original
comparison. Read-only context now supplies the existing stock SKU/unit; no stock
write rules change. Acceptance/allocation and camera acquisition are isolated
simulations that still exercise native idempotent attempts and sticker gates.

```sh
npm run ui:scratch
node scripts/ui-scratch/verify-release.mjs
```

Use `?review=preparation` for the previous three-path proposal, or
`?review=batch` for the approved batch regression profile. Prior validation may
require its own capture/report prerequisites; do not treat old artifact evidence
as a new verification. The release verifier includes real-backend reports from
`test-mobile-ckd-release.mjs` and `verifyBackend()` plus the separately run API
tests/typecheck, and clearly distinguishes those from fixture interactions.

### SO picking consolidation (current review)

The release profile now opens accepted orders directly in the picking workspace.
Scan lookup, exact commercial-line choice and quantity allocation stay inline.
The previous green workflow is frozen in `baselines/*before-simplification*` for
matching-size comparisons. The original blue snapshots remain retained separately.

Run `node scripts/ui-scratch/verify-release-live.mjs` for the new workspace against
a disposable real server, then `node scripts/ui-scratch/verify-release-simplified.mjs`
for the current hosted-review scenarios and embedded evidence. The latter performs
a clean rebuild and reads the current live, CKD and shared regression reports.
`verify-release.mjs` describes the preceding two-screen revision, not this one.

Physical scan evidence is memory-only and scoped to order/context, account/server,
warehouse, requirements/held snapshot, route and a five-minute lifetime. Camera
source is distinct from manual entry. Native serial/batch identities remain required.
The hosted reader is simulated; native acquisition metadata also has an injected
BarcodeDetector check. Neither is physical-device evidence.

`prepared-kit-review.js` is preview-only and is not registered in the production
shell. `DEMO:KIT` identities and `/__review/prepared-kits/*/allocate` demonstrate a
missing authoritative package/manifest capability. The fixture models verified,
sealed non-serialized contents, version/location checks, shared pools and idempotent
consumption. It cannot certify actual contents or substitute for required production
serial/batch assignments. `largekit` uses explicitly synthetic 2,000-component data.

The current release profile also offers **SO · unique unit QRs** and **SO · batch
quantity QRs**. `qr-fixtures.mjs` creates real received units, two separate lots
of the same product and named SO reservations in a disposable backend. Captured
lookups are replayed in the hosted reader; writes remain isolated simulations.
Run `node scripts/ui-scratch/verify-release-qr-live.mjs` for the actual API/browser
unit auto-add, duplicate/other-SO refusal and batch quantity-race checks. Its camera
callbacks are injected; it is not physical-camera evidence. The current browser
verifier embeds that report separately from simulated hosted behavior.

**SO · package checklist** opens the native package check with already reserved
stock, two required items (Power adapter, Mounting hardware) and an optional
Printed installation guide. Direct link: `?review=release&example=checklist`.
The real disposable API seeds the product configuration and independently refuses
a slip missing a required item with no physical stock deduction. Browser checks
cover premature continuation, optional items, unchecking, keyboard focus/state,
returning from handoff, both themes and phone widths. The hosted example ends at
handoff; it does not simulate a valid recipient token or enable warehouse-out.

**SO · internal staff handoff** uses a real Sales-issued active staff assignment,
with a package checklist and no release-code field. Direct link:
`?review=release&example=internal`. Native photo/signature capture is included;
final hosted uploads and warehouse-out stay disabled. External pickup/third-party
collection retains its existing recipient code and supervisor exception rules.

Backend v98 defaults old records to external. Internal signature staging uses
`release_acknowledgment` with `ref_id=authorization.id`; an exact active receiver,
explicit acknowledgment and signed image are required server-side. Final dispatch
moves the image to immutable slip evidence in the same transaction. The existing
company opt-out for orders without an authorization is preserved. Issued internal
authorizations cannot use token overrides.

Run `node scripts/ui-scratch/verify-release-internal-live.mjs` for native mobile
handoff against disposable real handlers, including signature invalidation after
authorization replacement and lost-response reload/retry. Run the main release
verifier, then `node scripts/ui-scratch/verify-release-internal-preview.mjs` to add
current internal preview evidence. API evidence is produced by the focused Vitest
suite with JSON output to `work/internal-api-tests.json`; it is not staff validation.

**Remaining Sales-to-Releasing review (2026-10-26).** New direct examples:
`example=salesauth`, `queue`, `partial`, `handoff`, `receipt`, `exceptions`, all
with `?review=release&example=…`. Their before components were frozen at the start
of this iteration; `styles-before-handoff-consolidation.css` is the exact CSS
payload from the previously published private Site source commit
`d6f231a6b212ba38ca31d40f584916e20fe872bb`. Its SO source was checked byte for byte
against the before component. Existing picking baselines remain separate.

`flow-fixtures.mjs` creates a real one-of-six signed partial trip, preserves five
held units on two exact sale lines, and captures its historical receipt. Hosted
Sales authorization/report responses are isolated simulations in `flow-adapter.js`.
The external preview code is explicitly `DEMO-CODE`; no production code is included.
The receipt's image viewer shows a labelled fictional evidence placeholder.

Use `verify-sales-release-flow-live.mjs` for real mobile Sales authority, repeated
activation, permissions and partial-order progress. Use `verify-release-internal-live.mjs`
for the real combined handoff, assignment invalidation and same-key recovery.
After the main release verifier's clean rebuild, run
`verify-release-internal-preview.mjs` and `verify-sales-release-flow.mjs` to embed
current checks. The latter compares five versus three screens, checks both themes
and narrow widths, focus at keyboard height, 2,000-component review, touch targets,
reduced motion, receipt details and durable exception handling. These checks do
not substitute for physical camera/packing or staff validation.
