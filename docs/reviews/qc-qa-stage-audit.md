# QC/QA stage audit — implementation plan

**Branch:** `restructure/module-architecture`. **Reviewed:** 2026-10-14. **Scope:** recorded unit → QC → QA → pass, rework, reject or hold → Products In eligibility. This file records the original findings; backend and desktop fixes followed in the same stage. Mobile source is owned separately; its actions are in the root `MOBILE-INVENTORY-HANDOFF.md`.

## Resolution status

- Fixed: duplicate labels are refused on checklist save; colliding QC/QA labels block a new single-stage kit release and legacy collisions block inspection. Mixed-stage inspection calls are refused. Stable item IDs remain a later contract migration for mobile and historical records.
- Fixed: desktop false-empty inspection loading, caller-specific ready counts, QA hold queue and checklist input parity; server-required readings for passed measured checks.
- Fixed: new kit releases freeze QC/QA checklist snapshots. Older released jobs have no recoverable historical snapshot and retain live checklist resolution.
- Fixed: inspector accounts require evidence even without an app header; privileged `inventory.adjust` integrations without an app header retain an audited correction path. Changed-body JSON idempotency-key reuse now returns 409, protecting the current phone hold workflow until its key generation is fixed.
- Improved: hold records appear in findings and the displayed percentage is labeled per recorded outcome; it is not a unit-level yield metric.
- Still open: mobile UI changes, unit-level quality yield metrics, queue pagination/batched reads, and abandoned evidence cleanup.

## Controls already present

- `POST /job-orders/:id/units/inspect` enforces stage-specific QC/QA permissions, checks required items on a pass, blocks reinspection while parts requests remain open, and updates units and counts in one transaction. A final pass makes a unit `passed`, **not** `in_stock`; Products In remains the stock-entry gate.
- Failed/held results from desktop and phone need a photo belonging to each unit and uploaded by the inspector. QA holds have a separate decision endpoint, required reason, audit record and notification.
- Mobile presents a guided checklist, photo evidence, recheck history and a queued-versus-recorded distinction for ordinary pass submissions. The desktop can inspect multiple units and review findings.

## Fix first — correctness and operator confidence

| Priority | Finding and code evidence | Improvement / acceptance criterion |
|---|---|---|
| **High** | `job-orders.routes.ts` verifies required checklist items with a `Map` keyed only by label; `qcChecklistSchema` permits duplicate labels. Mobile answers also use labels as keys. On a single-stage job, the QC and QA lists are combined, so one answer can satisfy two distinct checks with the same label. | Use stable, stage-qualified check identifiers in assigned checklists and result payloads, or reject duplicate labels across lists used together until migration is ready. Verify two identically named QC/QA requirements cannot pass with one answer. Preserve old QC snapshots for historical display. |
| **High** | The inspection route accepts a set of units at different stages and computes one union of QC/QA items, then writes that same checklist JSON to every unit. Desktop selection can include both passes. | Require one pass/stage per inspection request, or split a bulk action by stage with a separate checklist confirmation for each. Test mixed-stage selection, role permission and per-unit snapshots. |
| **High** | `production-qc.js` turns a failed `/job-orders` fetch into an empty array and shows “Nothing waiting for inspection.” Its detail refresh turns failed unit/QC reads into empty arrays. Mobile `qc.js` similarly turns a failed `/qc/holds` read into an empty hold list. | Show **Unable to load / Retry** instead of a false empty queue; keep counts/status unknown until a successful refresh. Test offline, 403, 500 and timeout states on desktop and phone. |
| **High** | Desktop `production-qc.js` has pending/rework and findings screens, but no cross-job QA hold queue; hold decisions are discoverable only inside a known job order. | Add a permissioned **On hold** queue using `GET /qc/holds`, with reason, evidence, age and a direct decision path. Clearly separate holds from units ready for QA or Products In. |
| **Medium** | `GET /job-orders` supplies caller-specific `units_actionable`, but the desktop QC overview counts every pending/rework unit. A QC-only inspector can see QA-only work in the apparent ready total. | Use `units_actionable` for the overview and preserve stage-specific counts in detail. An inspector should see only work their role can act on as ready. |
| **High** | Mobile `qc.js` uses `Idempotency-Key: hold-${record_id}` for every decision on a hold. The shared idempotency store checks user/method/path, not payload. A changed pass/rectify/fail decision can replay an earlier response while the screen labels the new choice as saved. | Generate a key for the exact immutable decision payload, retain it only for retrying that payload, and require a fresh review/key when the choice changes after a definitive response. Read back the unit/hold record after an uncertain response before showing the outcome. |

## Improve the workflow and traceability

| Priority | Finding and code evidence | Improvement / acceptance criterion |
|---|---|---|
| **Medium** | Desktop inspector form uses one checkbox per checklist item; it cannot capture mobile's Pass / Issue / N/A, measurement reading or per-item note. | Give desktop equivalent inputs and show the configured hint/measurement unit. Keep required items blocked on N/A or Issue. Review the modal at narrow desktop/browser widths. |
| **Medium** | `checklistForProduct()` resolves current product/default checklists at inspection time. Editing a checklist while a job is in progress changes what its remaining units must pass. Only submitted `qc_records` have a snapshot. | Decide whether to freeze the applicable checklist and version at job release or explicitly require re-review when it changes. Show the version used for each recorded result. |
| **Medium** | The API checks required status but does not require a reading for an item configured with `measure`; mobile checks reading locally. No numeric bounds are modeled. | Enforce nonempty readings server-side for measured checks, then consider configured numeric range/unit and an exception reason. Test API-only, desktop and phone callers equally. |
| **Medium** | Evidence enforcement depends on self-declared `X-Client: desktop|mobile`; an authenticated API caller without that header can fail/hold without photos. | If evidence is a business rule for every inspection, enforce it for all human/API calls or define a narrow, audited integration exemption. Do not rely on the client header as an authority signal. |
| **Medium** | `/qc/records` filters and summary count pass/fail only; QA holds are absent from the findings summary, and repeat inspections count as extra passes. | Include hold/decision history and label pass rate as **inspection attempts**. Add separate unit-level first-pass yield and final disposition metrics so rework does not distort quality reporting. |
| **Medium** | `GET /qc/queue` returns all eligible units and issues three per-unit lookups (last failure, last pass, open parts). | Batch those reads and paginate or bound queue results. Test a realistic backlog so the phone queue remains responsive. |
| **Low** | Evidence photos upload before the inspection mutation; a later 409 leaves unclaimed photos attached to the unit. | Keep evidence pending until claimed, reuse it on a safe retry, and offer cleanup or expiry for abandoned uploads without deleting evidence tied to a QC record. |

## Recommended order for the implementation step

1. Prove the label collision and mixed-stage problems with integration tests, then fix checklist identity and stage grouping without changing historical records.
2. Fix false-empty loading states and give desktop a QA hold queue and decision path. Bring desktop checklist inputs to parity with the phone.
3. Validate evidence and readings on the server, then cover pass, fail, repair, hold, retry and Products In boundaries end to end.
4. Hand the mobile owner the retry-key, queue-state and checklist contract changes; verify both phone roles and offline/pending states before marking QC/QA complete.

This stage ends at a recorded final pass or terminal failure. Repair parts and Products In each receive their own connected audit afterward; accounting posting is outside this inventory/production pass.
