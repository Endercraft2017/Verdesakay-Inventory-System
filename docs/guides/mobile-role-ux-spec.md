# Mobile app — role-based UX specification (parts release → releasing)

**Audience:** UI/UX designer redesigning the phone app's shop-floor screens.
**Scope:** the 7 roles in the production-to-release pipeline — warehouse (parts
release), production lead, QC inspector, QA inspector, parts clerk, product
(receiving) clerk, releasing clerk. Delivery/driver is a later pipeline stage and is
out of scope here (see `shop-floor-to-delivery-sop.md`, Stage 7, if it's picked up
later).

This document describes **current, built functionality** — screens, elements, data,
actions, and states that already exist in the app today (`public/mobile/`) — as a
base for redesign, not a proposal for new features. Where a design opportunity is
worth flagging, it's called out explicitly in a **Design note**.

For the plain-language "how do I do my job" version of the same material, see
`shop-floor-to-delivery-sop.md`. For the underlying business-process map, see
`docs/modules/pipelines.md` ("Production / manufacturing run").

---

## 1. The pipeline, at a glance

```
[Warehouse]         [Production Lead]           [QC Inspector]        [Parts Clerk]
Release parts  ──►  Accept kit, build,     ──►  Pass/fail units  ──►  Accept/reject
to production       record each unit            (technical /          repair parts
                     (serial + photo)             performance)         requests
                            │                          │ fail → repair?     ▲
                            │                          ▼                    │
                            │                    [rework loop] ─────────────┘
                            │                          │ re-inspect
                            ▼                          ▼
                                                 [QA Inspector]
                                                 Pass/fail units
                                                 (appearance, final)
                                                        │
                                                        ▼
                                                [Product/Receiving Clerk]
                                                Products In — post to stock
                                                        │
                                                        ▼
                                                [Releasing Clerk]
                                                Release units to a sale order
```

Each role holds exactly one narrow permission (or, for warehouse, the broad
`inventory.adjust` most warehouse accounts already have) and the app hides/blocks
everything outside that one job. A single person can hold more than one role (rare,
but the app supports it) — in that case they'd see the union of the screens below.

---

## 2. Shared app shell (every role sees this)

Kept brief per scope — the deep detail below is the per-role task screens.

- **Login screen** — username/password, single "Sign in" button.
- **Top bar** — back button (context-sensitive), a context line (**role · location ·
  online/offline dot**), a screen title, an inbox icon (unread badge), and a sync-queue
  icon (shows a count when offline writes are queued, tapping it opens the queue).
- **Bottom tab bar**, up to 5 tabs depending on role:
  - **Work** — role-scoped task list (see each role's section below).
  - **Production** — only visible to accounts with any production permission
    (hidden entirely for e.g. a releasing-only account).
  - **Action** (center-left) — context-aware: **Scan** for warehouse/production
    accounts, **Clock** (time clock) for everyone else.
  - **Home** (center, raised FAB) — role-aware dashboard; for warehouse/production
    accounts this includes a segmented control: **Me / Approvals / People /
    Warehouse** (segments hidden unless the account has the matching permission).
  - **Inbox** — messages, unread badge.
  - **Profile** — account/settings.
- **Offline queue screen** — list of writes waiting to send, with a status per item
  and a manual "retry now."

**Design note:** the role context line ("QC Inspector · Main · Online") is the only
persistent on-screen indicator of *which* narrow role is signed in — worth
considering whether a designer wants a stronger visual identity per role (a color
accent, an icon) given six different people may share one physical device pool.

---

## 3. Roles & permissions

| Role | Permission | Sees Production tab | Primary screen(s) |
|---|---|---|---|
| Warehouse (broad) | `inventory.adjust` (shared with admin/admin_staff/releasing/warehouse roles) | Yes | Job Orders (release action) |
| Production Lead | `production.record` | Yes | Job Orders (accept + record) |
| QC Inspector | `production.inspect_qc` | Yes | QC / QA |
| QA Inspector | `production.inspect_qa` | Yes | QC / QA |
| Parts Clerk | `production.repairs` | Yes | Repairs |
| Product/Receiving Clerk | `production.receive` | Yes | Products In |
| Releasing Clerk | `orders.release` | **No** | Release SOs (on Work tab) |

A narrow-role account only ever sees **its own row/screen** — e.g. a QC-inspector
account's Production tab shows just "QC / QA," not Job Orders/Repairs/Products In.
Badge counts on every tile are already scoped to what that specific account can act
on (a QC inspector's badge never includes units waiting on QA).

---

## 4. Role: Warehouse — release parts to production

**Mission:** hand the exact BOM kit for a job order to the production line, and have
the system record that handover.

**Entry point:** Production tab → **Job Orders** → tap a `draft` job order.

### Screen: Job Order detail (release view)

| Element | Detail |
|---|---|
| Header | Product name, job order number, status badge, team (if scheduled), due date |
| Components list | One row per BOM component: name, `consumed / planned` quantity, a **⚠** warning icon if stock on hand is short |
| Primary action | **Release to production** button |
| Result (success) | Status flips to `released`; "Released from warehouse by **name**, **time**" appears on the header for every downstream role to see |
| Result (failure) | The whole action is refused (never partial) — an error lists every short component, e.g. `Bolt M8: need 40, have 25` |

**States:**
- **Loading** — job order list/detail fetch.
- **Short-stock error** — inline error banner listing every short line; button stays
  enabled to retry after stock is topped up.
- **Already released** — button disappears once tapped; screen shows the release
  timestamp/name instead.

**Design note:** this is a single-tap, no-photo, no-form action — the whole UX
surface is "read the components list, physically pick the parts, tap one button."
The interesting design problem here is the **short-stock error state**: it's the one
place a warehouse worker gets blocked and has to go tell someone else (a planner) —
worth designing a clear hand-off/escalation affordance rather than a plain error
banner.

---

## 5. Role: Production Lead — accept, build, record

**Mission:** receive the kit, build the units, and record each finished unit with
proof (identifier + photo) so it can enter inspection.

**Entry point:** Production tab → **Job Orders** → job orders show a **"to accept"**
status chip when released-but-not-yet-accepted.

### Screen 5a: Job Order detail — Accept parts kit

Shown only while the job order is released and unaccepted (blocks recording until
resolved).

| Element | Detail |
|---|---|
| Header | Product, job order number, team, due date |
| Provenance line | "Released from warehouse by **name**, **time**" |
| Components list | Same BOM list the warehouse saw, for the lead to count against |
| Confirmation control | Checkbox/tick: "I counted the kit and it matches the list" |
| Note field | Optional free text (e.g. "bolts swapped for an equivalent") |
| Primary action | **Accept job order** |
| Secondary action | **Report a kit problem** → opens the shared "Report a problem" screen with this job order pre-filled (text-only, no photo) |

**States:** blocked/disabled Record-production form until accepted; once accepted,
"Accepted by production: **name**, **time**" is added to the header permanently.

### Screen 5b: Job Order detail — Record production (serialized products)

Shown once accepted, for any job order with 1+ QC stages.

| Element | Detail |
|---|---|
| Section title | "Record production (N left)" — N = remaining ordered qty |
| Count stepper | **−/+** buttons, or type a number directly, to set how many unit rows to fill in at once |
| Per-unit row (repeats N times) | **Identifier*** text field + **scan button** (opens camera scanner, fills the field on a good read); **"📷 Take photo*"** button, becomes **"✓ Photo attached (retake)"** once one exists |
| Batch/lot field | Optional text label applied to every unit in this submission |
| Primary action | **Record unit(s)** |
| Progress indicator | "Recording unit 2 of 5…" while submitting sequentially |
| Secondary (collapsed) | **"⋯ Report scrap instead"** toggle reveals a scrap-quantity field + **Record scrap** button |

**Validation:** every row needs both identifier and photo before submit is allowed
("Every unit needs an identifier" / "…a photo").

**Offline behavior:** this screen does **not** queue offline — each unit needs a
server-assigned id before its photo can attach. A dropped connection mid-batch keeps
whatever succeeded (removed from the form) and only re-submits the rows still
pending on retry.

### Screen 5c: Job Order detail — Record production (non-serialized products)

Simpler alternate form for 0-QC-stage products: **Finished** count field,
**Scrapped** count field, optional **Batch/lot** label, **Save progress** button.
Output here skips inspection entirely and goes straight to Products In.

**Design note:** this is the most form-heavy, highest-photo-volume screen in the
whole pipeline — a lead may fill 5–20 rows per session. Worth designing specifically
for **rapid repeat entry**: fast camera re-open, a clear per-row completion
indicator, and a way to review/edit an already-filled row before the final submit
without losing the others.

### Screen 5d: Job Order detail — supervisor-only actions (broad accounts only)

**"⋯ More actions" → Pause / Close out early**, and **Resume**. A production-lead
account does not see these at all (they need `inventory.adjust`).

---

## 6. Role: QC Inspector — first pass (technical/performance)

**Mission:** verify each unit actually works before it's allowed toward final
appearance QA.

**Entry point:** Production tab → **QC / QA**.

### Screen 6a: QC/QA worklist

List of job orders with units waiting on **this account's own pass** — a two-stage
job order's QA-only units are filtered out entirely, with a count note ("N more
unit(s) are waiting on the other inspection pass") rather than shown greyed out.

### Screen 6b: Job Order inspection view

| Element | Detail |
|---|---|
| Header | Job order, product, current pipeline step, running "passed / scrapped" counts |
| Checklist assignment (config-permission accounts only) | "QC: **name** · Change" row |
| Bulk pass card | "Pass completed units" — quantity field, optional batch/lot id (+ scan), **"Pass this stage"** button |
| Per-unit list | "Or inspect each unit" — one row per unit: unit #, identifier, current stage badge, **Pass** / **Fail** buttons |
| Rework section | "Back from repair (N)" — same Pass/Fail, plus **Request part**; Pass is disabled with a note while any parts request is still open |
| History | "Inspection history" table: when, unit, result, inspector, remarks — tap a row to open the unit's full dossier |

### Screen 6c: Checklist sheet (opens on Pass or Fail)

**On Pass:**
- One row per checklist item, checkbox, a **\*** marks required items; a **(QC)**/**(QA)**
  tag when both checklists apply on a combined pass.
- Remarks field (optional).
- Optional photo attachment (e.g. test-reading gauges).
- **Confirm pass** — blocked until every required item is ticked.

**On Fail:**
- Required "What failed?" text field.
- Disposition choice: **Scrap / Dispose / Recycle** (terminal) vs **Repair** (rework
  loop).
- Checklist items can be unticked to record which specifically failed.
- Photo attachment (not app-enforced, but procedure requires a defect close-up).
- **Confirm fail**.

### Screen 6d: Request a repair part (on a rework unit)

Kind (**Replace** / **Add**), component picker (search), quantity, fault reason
(dropdown: Assembler/Production/Supplier/Wear/Other), a "return old part to damage
record" toggle (defaulted on for replacements), optional note, **Send request**. Works
offline (queues).

**Design note:** this screen carries real weight — pass/fail is the actual quality
gate — but visually it's currently a plain checklist form. A designer could
meaningfully differentiate **Pass** vs **Fail** through color/weight (the Fail path
already forks into three sub-choices, which could be clearer as a segmented choice
rather than a dropdown), and the "waiting on parts, can't re-inspect" disabled state
deserves a stronger visual treatment since it's a common hold state, not an error.

---

## 7. Role: QA Inspector — final pass (appearance)

**Identical screens to QC** (Section 6) — same worklist, same inspection view, same
checklist sheet, same fail/repair flow. The only differences are:

- The worklist only shows units that have **already passed QC**.
- The checklist shown is the product's **QA** checklist (appearance/finish items)
  instead of QC's (technical/performance).
- On Pass, the unit becomes **"Awaiting RTS Recording"** rather than moving to
  another inspector's queue — it's the last quality gate.

**Design note:** since QC and QA are literally the same screen/components with a
different data scope and a different checklist, any redesign of Section 6 should be
built as one reusable inspection-screen component, not two.

---

## 8. Role: Parts Clerk — accept/reject repair requests

**Mission:** the warehouse-side half of the rework loop — physically issue (or
decline) the part a repair needs.

**Entry point:** Production tab → **Repairs**, or Work tab → **Accept Parts
Request**.

### Screen: Repairs worklist

One card per open request:

| Element | Detail |
|---|---|
| Header | Request number, **Replace** or **Add** kind badge |
| Detail line | Component name × quantity, fault reason |
| Origin line | Job order number, unit # (+ identifier), requested by (inspector name) |
| Note | The inspector's optional note, if any |
| Location picker | **"Issue from"** — which stock location to draw the part from |
| Remarks field | Free text, e.g. "handed over 3 pcs to Line 2" |
| Primary action | **Accept & issue** |
| Secondary action | **Reject** — remarks become the required reason |

**Result:** accepting deducts the part from the chosen location immediately; for a
*replace*, the removed part is booked to a damage record rather than back to good
stock. Works offline (queues).

**Design note:** this is a short, high-frequency, single-screen role — the whole job
is "read the card, pick the part, tap one of two buttons." The main design
opportunity is making the **origin context** (which job order/unit this is for)
scannable at a glance when several cards are queued at once.

---

## 9. Role: Product/Receiving Clerk — Products In

**Mission:** physically receive finished units off the floor and post them into real
stock — the moment a unit actually becomes sellable.

**Entry point:** Production tab → **Products In**, or Work tab → **Products In**.

### Screen 9a: Products In worklist

List of job orders with units/batches waiting, each row showing counts like "4
unit(s) · 1 batch(es)."

### Screen 9b: Job Order receive view

| Element | Detail |
|---|---|
| Location picker | **"Received into"** — defaults to the job order's output location, changeable (this is how a floor-to-warehouse transfer is recorded in the same step) |
| Note field | Optional (count discrepancy, condition) |
| Scan action | **"📷 Scan to receive"** — continuous scanner, ticks each matched unit, rejects a code that isn't on this job order, auto-closes when everything's ticked |
| Unit list | All units, pre-ticked by default; a **View** button per row opens that unit's dossier (photo + record) for comparison; untick anything not physically present |
| Batch rows (non-serialized) | Per-batch **"Receive now"** quantity field — short counts allowed |
| Print action | **"Print selected"** — prints a QR label per ticked unit |
| Primary action | **Receive selected** |

**Result:** posts stock at the chosen location, logs a receipt number, units become
"Ready to Sell." Works offline (queues).

**Design note:** the **scan-to-receive** flow and the **print-label** flow are both
one tap each but serve very different physical moments (receiving vs. re-labeling a
lost tag) — worth keeping them visually distinct so they're not confused under time
pressure. The "View" per-unit dossier link is the clerk's only way to sanity-check a
unit against its build photo before accepting it — that comparison view is doing a
lot of trust-building work for a screen that otherwise has no photo requirement of
its own.

---

## 10. Role: Releasing Clerk — release units to a sale order

**Mission:** pull the exact physical units a customer ordered and tie each one to
that order.

**Entry point:** Work tab → **Release SOs** (not on the Production tab — this
account has no production permission at all).

### Screen 10a: Release SOs worklist

List of sale orders that are `approved` or partly `released`, each showing customer
name and status badge.

### Screen 10b: Sale order release view

| Element | Detail |
|---|---|
| Header | Customer, order number, status |
| Line list | Per line: `released / ordered` progress |
| Serialized-line action | **"📷 Scan units to release"** — continuous scanner; each good scan increments a session tally and updates line progress; a bad scan (not Ready-to-Sell, wrong order, over-quantity) is rejected with a specific reason |
| Non-serialized-line action | Quantity input + **Release** button per line |
| Completion state | "Order fully released" banner + scanner auto-closes |

**Result:** scanning **reserves** the unit for this order (no stock movement yet —
that happens later, on delivery/completion). Works offline (queues; re-check counts
once back online).

**Design note:** this is a single-purpose, scanner-first screen for an account that
by design sees nothing else in Production — the whole UX should read as "one job,
one screen, one big scan button," with the rejected-scan reason being the most
important piece of feedback on the screen (it's the only thing telling the clerk
*why* a unit they're holding in their hand won't go through).

---

## 11. Cross-cutting design considerations

- **Environment:** every one of these screens is used on a factory/warehouse floor —
  assume gloved hands, variable lighting (for photo capture), and one-handed
  operation while holding a physical part or unit. Touch targets should be generous;
  camera/scan buttons in particular are used constantly and under time pressure.
- **Offline resilience:** most write actions across these roles already queue
  offline and show a **"Queued (offline)"** confirmation instead of a hard success —
  the one deliberate exception is Production Lead's unit-recording step (identifier
  + photo must be saved together, can't be queued). A consistent, unmistakable visual
  language for "this succeeded," "this is queued for later," and "this failed" would
  help across every role, since right now it's mostly a toast message.
  Sale-order release scans get one more nuance: they queue offline too, but a queued
  scan's tally/line-progress isn't confirmed until the sync actually lands — worth
  a distinct "pending confirmation" state rather than treating it as done.
- **Camera reliance:** photos are required (not optional) at unit recording, and
  required by *procedure* though not by the app at QC/QA fail — the app runs over
  HTTPS specifically so the in-app camera/scanner work reliably; a designer should
  assume every role except Releasing Clerk and Parts Clerk is regularly taking
  photos.
- **Status/badge vocabulary is already shared app-wide** — pass/fail/pending/rework
  states use consistent badge colors across every screen listed above (see
  `production-steps.js` for the canonical step labels: Job Order Created → Parts
  Released → Accepted by Production → In Production → In QC → In QA → Awaiting RTS
  Recording → Ready to Sell → Sold, plus In Rework / Failed-Scrapped branches). Any
  redesign should keep one canonical set of status colors/icons rather than
  reinventing them per screen.
- **Role identity:** as noted in Section 2, the only current indicator of which
  narrow role is signed in is a text line in the top bar — worth deciding whether
  redesigned screens need a stronger per-role visual identity, given several
  different people may share a pool of devices.
- **Badge counts are already permission-scoped**, not just role-scoped — e.g. two
  different QC inspectors on the same job order type would each see counts specific
  to what they personally can act on. Don't design a single "global" badge count per
  screen type; it's already computed per signed-in account.

---

## 12. Out of scope for this document

- **Driver/delivery crew** (Stage 7 of the full pipeline) — release is the last
  stage covered here. See `shop-floor-to-delivery-sop.md` Stage 7 if that role gets
  picked up for redesign later.
- **Desktop equivalents** — every screen above also has a desktop version reachable
  by a broad-permission account; this document is phone-app-only per the stated
  scope.
- **Planner/manager screens** (job-order creation, BOM setup, checklist
  configuration, scheduling) — see `production-sop.md`.
