# SOP — From parts release to delivery (shop-floor roles)

**For:** warehouse staff, production team leads, QC inspectors, QA inspectors, product
(receiving) clerks, releasing clerks, drivers/delivery crew, and their supervisors.
**Where:** mostly the **phone app** (`/m`). Every step can also be done on desktop by an
account with broad warehouse rights.

This is the step-by-step, role-by-role version of the production and sale-order
pipelines. For planners and managers who set up products, BOMs, checklists, and job
orders, see `production-sop.md`.

---

## The whole pipeline at a glance

```
 [Planner]            [Warehouse]            [Production Lead]        [QC Inspector]
 Job order    ──►   1. Release parts   ──►  2. ACCEPT job order, ──►  3. QC pass
 created (draft)       to production           build + record units      (technical /
                       (stock leaves           (serial no. + PHOTO        performance)
                        warehouse)              per unit)                  │
                                                                           │ fail → repair?
                                                                           ▼
                                           [Parts Clerk]  ◄── parts request ── 3b. Rework
                                           accepts / rejects
                                           (issues the part)

 [QA Inspector]          [Product Clerk]            [CSR / Sales]     [Releasing Clerk]      [Driver]
 4. QA pass     ──►   5. Products In /       ──►   Sale order   ──►  6. Release SO     ──►  7. Deliver +
   (appearance,          RTS recording              approved          (scan each unit's       proof of
    final)               (units become                                QR label)               delivery
                          "Ready to Sell")                                                    (signature,
                                                                                               PHOTOS, GPS)
```

The status label you see on a unit follows this same order:

**Job Order Created → Parts Released → Accepted by Production → In Production → In QC → In QA → Awaiting RTS
Recording → Ready to Sell → Sold** (side branches: *In Rework*, *Failed / Scrapped*).

### Who does what

| # | Stage | Person | App role | Phone app location |
|---|-------|--------|----------|--------------------|
| 1 | Release parts to production | Warehouseman | `warehouse` (or any account with broad stock rights) | Production → **Job Orders** → open the job order → **Release to production** |
| 2 | Accept the job order (sign for the kit), then build and record finished units | Production team lead / manager | `production_lead` | Production → **Job Orders** → open the job order → **Accept job order**, then **Record production** |
| 3 | QC inspection (first pass) | QC inspector | `qc_inspector` | Production → **QC / QA** |
| 3b | Repair parts handoff | Warehouse parts clerk | `parts_clerk` | Work → **Parts requests** |
| 4 | QA inspection (final pass) | QA inspector | `qa_inspector` | Work → **QA appearance inspection** |
| 4h | Decide a unit QA held for review | Any QA inspector, or anyone granted **Decide QA holds** (Production Manager by default) | `qa_inspector` / `production.qa_review` | QA desk → **On hold** tab, or Work → **QA holds** |
| 5 | Products In / RTS recording | Product clerk | `receiving_clerk` | Work → **RTS recording** |
| 5→6 | Approve the sale order and issue its release authorization | Sales / CSR | an account with `orders.edit` | Desktop: Sales Orders → the order → key icon |
| 6 | Release units to a sale order (warehouse-out) | Releasing clerk | `releasing_clerk` | Work → **Release orders** |
| 7 | Deliver to the customer | Driver / delivery crew | an account with `delivery.run` | Work → **Deliveries** |

Each narrow role sees **only its own tile**, and the server blocks it from doing any other
step. A QC inspector cannot sign off QA, and a QA inspector cannot sign off QC. Accounts with
broad warehouse rights (`warehouse`, `admin`, `admin_staff`, `releasing`) can do any step.

> **Before you start, every phone needs:** a signed-in account with the right role, a
> working camera (the app runs over HTTPS so the camera and scanner work), and good light
> for photos. Photos are taken **inside the app**. Pictures in your phone gallery don't
> count.

---

## Stage 1 — Warehouseman: release parts to production

**Goal:** Take the parts for a job order out of the warehouse and hand them to the
production line. This is where parts officially leave warehouse stock.

**You'll see it when:** A planner has created a job order and it is in **draft**.

### Steps

1. Open **Production → Job Orders** and tap the job order. Draft orders are listed with the
   other open orders.
2. Check the **Components** list. Each line shows `consumed / planned`. A **⚠** means there
   isn't enough of that part on hand.
3. **Physically pick** every component and its planned quantity from the job order's
   **source location**.
4. Tap **Release to production**.
   - **Success:** The job order becomes **released**, and every planned component is
     deducted from the source location in one step. The app records **your name and the
     time** as "Released from warehouse by …", and the production lead sees this.
   - **If a part is short:** The release is **refused as a whole**. It is never partly
     released. The error lists every short part, for example `Bolt M8: need 40, have 25`.
     On desktop, you can then create **draft purchase orders** for the missing parts.
     Tell the planner/supervisor. Don't hand over a partial kit as if it were complete.
5. Hand the kit to the production team lead. Wait while they count it and tap **Accept job
   order** (Stage 2.1). Their acceptance is your proof of handover.

### Rules

- **Release only what you actually pick.** The system deducts the full planned quantity
  when you tap Release.
- The release **cannot be undone from the phone**. If you released the wrong job order,
  tell your supervisor right away. They cancel it on desktop, and that returns unused
  components.
- There's **no photo** at this step. The record of who released the parts and when is the
  audit trail.

---

## Stage 2 — Production team lead / manager: accept the job order, build, and record units

**Goal:** Receive the parts kit, build the units, and record each finished unit so it goes
into QC.

### Step 2.1 — Accept the job order (sign for the parts kit)

**You can't record any production until you accept.** The recording form stays hidden, and
the system refuses recording until this step is done.

1. Open **Production → Job Orders**. Job orders waiting for you show **to accept** in the
   list. Tap one.
2. Check the header: **team**, **due date**, and "Released from warehouse by …" (who
   released it and when).
3. **Count the kit** against the **Components** list: part names and planned quantities.
4. **If the kit is complete:** in the **Accept parts kit** card, tick **I counted the kit
   and it matches the list**, add a **Note** if needed (for example *"bolts swapped for an
   equivalent"*), and tap **Accept job order**.
   - The app records **your name and the time** ("Accepted by production: …"). It appears on
     the job order and on every unit's production record.
   - The job order's step changes to **Accepted by Production**, and the **Record
     production** form appears.
5. **If anything is missing or damaged, don't accept.** Tap **Report a kit problem**. It
   opens *Report a problem* with the job order already filled in. List exactly which part
   and how many are missing or damaged (it is a text message, no photo), and send it to the
   warehouse or your supervisor. Only they can fix a release. Accept once the kit is put
   right.

Nothing moves in stock when you accept. The parts already left the warehouse at Stage 1.
Accepting is your signature that you received them.

### Step 2.2 — Build

Build to the product's standard. The job order doesn't track work-in-progress. It only
counts units when you record them.

### Step 2.3 — Record each finished unit (serialized products, i.e. products with QC/QA)

This is what most finished products use: any job order with 1 or 2 inspection stages.

1. On the job order, go to **Record production (N left)**.
2. Set **how many units** you are recording now with the **− / +** buttons. One row appears
   per unit.
3. For **each unit row**:
   - **Identifier \*** (required): the unit's **motor number / serial number**. Type it, or
     tap the **scan button** and scan the part's serial/motor tag.
   - **📷 Take photo \*** (required): a photo of **this finished unit**. The button changes
     to **✓ Photo attached (retake)** once a photo is taken.
4. **Batch / lot** (optional): a label that groups this set of units, for example
   `LOT-0924-A`.
5. Tap **Record unit(s)**. The app records the units one at a time and shows
   "Recording unit 2 of 5…".

**Photo standard (company rule):** Take the whole unit, front view, in good light, with the
serial/motor tag readable if possible. This photo is kept on the unit's permanent
record, so the QC/QA inspectors and anyone who scans the unit later can see it.

**The app will refuse to save if:**

- Any row has no identifier: "Every unit needs an identifier."
- Any row has no photo: "Every unit needs a photo."

**If the signal drops mid-way:** The toast shows "Recorded 3 of 5 — …". The units that went
through are **removed from the form** automatically. Tap **Record unit(s)** again once
you're back online, and only the missing ones are sent. **This step does not work
offline**, because the identifier and photo must be saved together. Don't re-type units
that already went through.

**Scrap during the build:** Tap **⋯ Report scrap instead**, enter the **Scrapped now**
quantity, and tap **Record scrap**. Scrap is recorded as a count only. It never goes to QC.

### Step 2.3 (alternative) — Non-serialized products (0 inspection stages)

These job orders show **Finished / Scrapped / Batch** instead of per-unit rows.

1. Enter the **Finished** count and/or the **Scrapped** count.
2. **Batch / lot** is optional. Leave it blank and the app generates `BATCH-#####`.
3. Tap **Save progress**. The batch goes straight to **Products In** (Stage 5), skipping
   QC/QA.

### What happens next

The job order moves to **in progress**. Recorded units show **In QC** (or **In QC/QA** on a
single-stage job order) and appear in the inspectors' queue. **Nothing is sellable yet.**

### Supervisor-only actions

**⋯ More actions → Pause / Close out early**, and **Resume**. These need broad warehouse
rights. A production-lead account doesn't see them.

---

## Stage 3 — QC inspector: first pass (technical / performance)

**Goal:** Check that each unit **works**: function, performance, and technical specs. Pass
it on to QA, or fail it.

**Where:** **Production → QC / QA**. The badge shows only the units **you** can act on.
Units waiting on QA are hidden from you, with a note like "N more unit(s) are waiting on
the other inspection pass."

> On a **single-stage** job order there is only one combined pass, and it runs the QC and
> QA checklists together. Either inspector can do it.

### Steps

1. Tap the job order. The header shows the job order, the product, the current step, and
   how many units have passed or been scrapped.
2. Choose how to inspect:

   **A. Inspect each unit (recommended for serialized units)**
   - Under **Or inspect each unit**, find the unit by its number and serial/motor number.
   - Tap **Pass** or **Fail**.

   **B. Pass a group by count** (only when every unit in the group truly passed)
   - Under **Pass completed units**, enter **how many passed**.
   - Optional: enter or scan a **Batch / lot ID** that applies to all of them.
   - Tap **Pass this stage**.

3. **On Pass**, the **checklist sheet** opens:
   - Tick every check you verified. Items marked **\*** are **required**. The app won't
     let you confirm until every required check is ticked ("Tick the required checks: …").
     A tag like **(QC)** shows which checklist each item comes from.
   - **Remarks**: overall notes (optional).
   - **Photos** (per-unit pass only): add photos of test readings or gauges if your
     procedure calls for them. Optional in the app. Your supervisor sets the house rule.
   - Tap **Confirm pass**. The unit moves to **In QA** (on a single-stage job order it goes
     to **Awaiting RTS Recording**).

4. **On Fail**, the fail sheet opens:
   - **What failed?** is required. Be specific: *"No output on terminal B, tested 3×"*.
   - **What to do with it**:
     - **Scrap / Dispose / Recycle**: **final**. The unit is written off and never goes
       into stock.
     - **Repair (send to rework)**: the unit goes to **In Rework** and stays on the job
       order.
   - Untick any checklist items that failed.
   - **📷 Evidence photo: required.** Take at least one close-up of the defect, of this
     unit. **The app refuses the fail without it** — on the phone and on the desktop QC
     form alike — and nothing is recorded.
   - Tap **Confirm fail**.

Every pass and fail is stamped with **your name and the time**, and you can see it in
**Inspection history**. Tap **View record** there to open the unit's full dossier.

### Step 3b — Units in rework (repair loop)

Units sent to repair appear under **Reinspect** on your desk.

1. **Request the part(s)** the repair needs. Tap **Request part** on the unit:
   - **Kind**: *Replace a fitted part* or *Add a missing part*.
   - **Component**: search for and pick the part.
   - **Qty** and **Fault**: *Assembler / Production / Supplier / Wear / Other*.
   - **Old part goes to the damage record**: ticked by default for replacements. Leave it
     ticked unless the old part is thrown away.
   - **Note** (optional). Then tap **Send request**.
2. **The part is held for you** the moment you send the request: the system sets it aside
   at a parts location that has it, so nobody else (another repair, a production kit, a
   sale) can take it. If no location has enough, the request is a **shortage** and holds
   nothing until stock arrives.
3. **You are notified** (push and in **Notifications**) when the part is **issued**,
   **rejected** (with the reason), **short**, or when the parts clerk proposes a
   **revision** — another part or quantity. A revision waits for **your** approval: open the
   notification, check the proposal, and tap **Approve revision** or **Reject revision**.
   The parts clerk can't approve their own proposal.
4. While any request is still waiting on the warehouse, **you can't re-inspect the unit**.
5. After the warehouse issues or rejects every request, and the unit is repaired,
   **re-inspect** it: **Pass** (with the checklist) or **Fail** again, exactly as above.

---

## Stage 3b (warehouse side) — Parts clerk: issue or reject parts requests

**Where:** Work → **Parts requests** (Pending / Shortage / Issued today).

1. Open a request. Check the **context**: the unit, the inspection that sent it to repair,
   and any **duplicate** open request for the same unit and part.
2. **Select the stock source.** Only **approved parts locations** can be used — never a
   truck. Each location shows what's **free**: stock there minus what is held for other
   requests or picked for kits. The location holding this request's part comes first.
3. **Pick and scan.** Scan the part label: it must be **exactly the requested part (SKU)**,
   and the picked quantity **exactly the requested quantity**. A different part or quantity
   is refused — use **Request revision** instead.
4. **Review**, tick **I picked and verified the exact requested item**, and tap **Confirm
   issue**. The part leaves stock now; for a *replace*, the removed part goes to the damage
   record.
5. **Shortage:** if no approved location has enough free stock, tap **Escalate shortage**.
   The requester and the warehouse supervisors are notified. The request stays open.
6. **Reject:** choose a reason and add details. No stock moves; the requester is notified.

**Needs a signal.** Issuing and rejecting never queue offline — nothing is shown as issued
until the server has done it.

---

## Stage 4 — QA inspector: final pass (appearance)

**Goal:** A final check of how the unit **looks and is finished**: paint, scratches, decals,
fit and finish, packaging. This is the last quality gate before the unit can be sold.

**Where:** Work → **QA appearance inspection**. You only see units that have already
**passed QC**.

The steps are the same screens as Stage 3:

1. Open the unit, then **Pass** or **Fail**, or pass a group by count if every unit truly
   passed.
2. **Pass**: tick the **QA checklist** (required items \*), add remarks and optional photos,
   then tap **Confirm pass**.
   - The unit becomes **Awaiting RTS Recording**. It has passed quality but **is still not
     in stock**. The product clerk puts it into stock in Stage 5.
3. **Fail**: say what failed, **take a close-up photo of the defect (required)**, and choose:
   - **Return for rectification** — back through the rework loop, then rechecked;
   - **Reject** — scrap / dispose / recycle (final);
   - **Hold for review** — when you are not sure: the unit goes **On hold**. It stays out of
     stock and the job order can't complete. Every QA inspector and everyone who can decide
     QA holds is notified.

### Step 4h — Decide a held unit

**Who:** any QA inspector, or anyone granted **Decide QA holds** (the Production Manager by
default). **Where:** the QA desk's **On hold** tab, Work → **QA holds**, or the desktop job
order (**Held by QA for review → Decide…**).

1. Open the held unit. Read the reason, the checklist issues and the evidence photo.
2. Choose **Pass** (accept as is — on to RTS), **Rectify** (choose where it goes for the
   correction) or **Fail** (scrap / dispose / recycle).
3. Give the **reason** (required) and record the decision. The inspector who held it is
   notified. **Needs a signal.**

---

## Stage 5 — Product clerk: Products In / RTS (Ready-to-Sell) recording

**Goal:** Physically receive the passed units off the production floor and **post them
into stock** at a real location. **Only from this moment is a unit "Ready to Sell."** This
works the same way as the Goods Receipt in Purchasing.

**Where:** Work → **RTS recording** (Ready / Issues / Recorded).

### Steps

1. Scan or pick the unit. Check it against its record (product, serial, final QA sign-off).
2. **Stock details:** choose the **location**. Only storage locations can take ready-to-sell
   stock (not a truck), and a location with a **capacity** shows the room it has left — a
   location without room for what you're posting is greyed out.
3. **Group** other units of the same product going to the same location, if you like.
4. **Review**, tick that you physically checked them, and **Confirm**. The units become
   **Ready to Sell**, stock goes up at that location, and a receipt `PI-#####` is logged.
5. **Print labels** from the result screen and **stick a QR label on every unit.** The
   releasing clerk scans these labels in Stage 6.

### Rules

- **Never twice:** a unit already in stock, or a serial already in stock on another unit,
  is refused — the app shows the existing receipt. Nothing moves.
- **Location full:** a location with a capacity refuses what won't fit (the message says how
  many still fit). Pick another location. Capacities are set on the desktop under
  **Inventory → Locations**.
- **Doesn't match its record?** Report a **product-data mismatch**: the unit goes under
  **Issues** and can't be recorded until QA or inventory control resolve it.
- **Needs a signal.** Recording never queues offline.
- Passing QA does **not** put a unit in stock. Until this step, reports show it as
  built but **not on hand**.

---

## Between Stage 5 and 6 — Sales: approve the order and authorize its release

(Office/CSR step, desktop.) The releasing clerk only sees a sale order after sales moves it
to **approved**. On approval the system checks availability. If there's a shortfall, sales
chooses to trim the order, raise job orders or purchase orders for the gap, or approve it
as a backorder. Approving **locks the order's line items**.

**Release authorization — required for every sale order** (unless the company turns the
policy off). On the sale order, tap the **key icon** and issue it:

- **Pickup or delivery**, the **approved recipient's name**, and an **ID reference** (only
  the last 4 characters are kept).
- How long it is **valid**, the **handoff area**, and whether a **partial release** is
  allowed.
- The app shows a **release token** (e.g. `PICKUP-7F3Q`). **Give it to the recipient** —
  the releasing clerk never sees it; the recipient presents it at handoff.
- Issuing a new authorization revokes the previous one. You can also revoke it with a reason.

Release reports from the warehouse (wrong unit, missing item, identity problem, partial
request) **notify you** and appear on the same screen to resolve.

---

## Stage 6 — Releasing clerk: release units to the sale order (warehouse-out)

**Goal:** Hand the exact units of a customer's order to the approved recipient, with proof.
**Issuing the release slip is the moment stock leaves inventory.**

**Where:** Work → **Release orders** (Ready / Blocked / Completed). An order without a valid
authorization, or with an open release report, is under **Blocked**.

### Steps

1. **Verify release authority.** Check the mode (pickup / delivery), the approved recipient
   and the masked ID reference. Accept the order to start.
2. **Scan the units.** Scan each unit's QR label. Only Ready-to-Sell units of this order's
   products are accepted; a unit allocated to **another order** is blocked (put it back).
   Count out non-serialized lines by quantity.
3. **Package.** Confirm every required item that must leave with the unit (charger, keys,
   documents …) and note the seal / tag.
4. **Handoff.** Ask the recipient for the **token** and tap **Verify**.
   - **Recipient can't present the token?** Tap **Recipient can't present the token** and
     give the reason. A **warehouse supervisor** is notified and approves (or declines) it
     with a reason — or, if you are a supervisor, approve it yourself with a reason. It
     replaces only the token: the recipient must still match the approved name and ID
     reference, and the reason is printed on the release slip.
5. **Proof.** Take **at least one photo** of the unit at handoff (required) and have the
   recipient sign.
6. **Review**, tick **Physical handoff is complete**, and **Confirm warehouse-out**. The
   slip `RS-#####` is issued and stock leaves inventory.

**Partial release:** if Sales allowed it, an incomplete order can go out with what is ready;
the rest moves to a **new backorder sale order** automatically. Without that permission the
app refuses — ask Sales with **Request partial release**.

### Rules

- **Needs a signal.** Warehouse-out never queues offline. If your phone is connected to the
  site's PC during an internet outage, the result says **"on the site PC — not final yet"**
  until the site syncs with the cloud; the screen updates itself.
- A refusal (wrong unit, missing package item, bad token, no photo) **moves no stock**.
- Report problems with **Report issue** — Sales is notified.

---

## Stage 7 — Driver / delivery crew: deliver with proof of delivery

**Prerequisite:** Someone with `delivery.manage` (dispatcher/office) creates a **delivery
(`DEL-#####`)** linked to the sale order and assigns it to a driver. The driver gets a push
notification.

**Where:** **Work → Deliveries**. The list is grouped into *Out for delivery*, *To do*, and
*Done*.

### Steps

1. Open the delivery and tap **Start delivery**. The status
   becomes *Out for delivery*.
2. At the customer, tap **Complete delivery** and fill in the proof of delivery (POD):
   - **Received by**: the name of the person who accepted the goods.
   - **Signature**: have the recipient sign on the phone screen.
   - **📷 Photos of the delivery**: take photos of the **delivered units at the drop
     point**. Show the items and, where possible, the unit labels or serials and the
     customer's premises.
   - **📍 Capture location**: tap it to record the GPS point of the drop.
   - **Note**: anything unusual.
3. Tap **Delivered**, or **Couldn't deliver**. For a failed delivery, a **note of at least a
   few words saying why is required**.
4. After a successful drop, the app may offer **"Mark SO-xxxx completed."** Tap it if you
   are allowed to; otherwise the office completes the order. (Stock already left at the
   release slip in Stage 6.)

**Needs a signal:** Recording the delivery does not queue offline ("Connect to record the
delivery"). Stay on the screen and retry once you have a signal. Don't leave without
saving the POD.

**POD standard (company rule):** In the app, signature, photos, and GPS are optional, but
by procedure **all three are required for every delivered drop**. Without them the
company has no proof if the customer disputes the delivery.

---

## Photos and scans checklist (quick reference)

| Stage | Person | Photo | Scan | Enforced by the app? |
|-------|--------|-------|------|----------------------|
| 1 Release parts | Warehouseman | — | — | Name and time recorded automatically |
| 2 Accept job order | Production lead | — | — | **Yes**: recording is blocked until accepted; "counted the kit" tick required |
| 2 Record unit | Production lead | **1 photo per finished unit** | Serial/motor tag (optional, or type it) | **Yes**: identifier + photo both required |
| 2 Kit problem | Production lead | — (Report a problem is text-only: list the part + qty) | — | No (procedure) |
| 3 QC pass | QC inspector | Test readings (optional) | Batch/lot ID (optional) | Required checklist items enforced |
| 3 QC fail | QC inspector | **Close-up of the defect** | — | **Yes**: reason + photo required (phone and desktop) |
| 3b Parts request | QC/QA inspector | — | — | Component required; the part is held for you |
| 3b Issue / reject part | Parts clerk | — | **Scan the exact requested part** | **Yes**: approved location, exact part and quantity; reason to reject |
| 4 QA pass / fail / hold | QA inspector | **Close-up of any defect** | Batch/lot ID (optional) | Same as QC; a hold needs a reason and a decider |
| 5 RTS recording | Product clerk | — (unit photo already on file) | **Scan each unit** | **Yes**: storage location with room; never twice |
| 6 Release (warehouse-out) | Releasing clerk | **Handoff photo + recipient signature** | **Scan every unit's QR label** | **Yes**: authorization token (or supervisor override), package, photo |
| 7 Deliver | Driver | **Photos of delivered goods** | — | Reason required on a failed drop; signature/photos/GPS by procedure |

---

## Looking anything up

- **Scan any unit label** (Scan on the phone, then **Open production record**) to see its record: product
  and variant, job order, team, who built it, the build photo, every QC/QA sign-off with
  checklist ticks, repairs, stock movements, and the sale order it's reserved or sold to.
  **Print label** there re-prints a lost label.
- The **current step** badge on a unit, batch, or job order tells you which stage it is
  sitting at and who needs to act next.
- If you're stuck, use **Report a problem** to send a text message to a
  supervisor.

## Common "why can't I…" answers

| Message / situation | Reason | What to do |
|---------------------|--------|------------|
| "Production has to accept the parts kit…" / no Record production form | The job order hasn't been accepted. | The production lead counts the kit and taps **Accept job order**. |
| Release refused: "Not enough stock at …" | A component is short. Release is all-or-nothing. | Tell the planner. Draft POs from desktop. |
| "Every unit needs a photo" / "an identifier" | Required at recording. | Fill in every row. |
| I can't see a unit in QC/QA | It's on the other inspector's pass. | Wait for QC (if you're QA), or ask the other inspector. |
| Pass is greyed out on a rework unit | A parts request is still waiting on the warehouse. | Ask the parts clerk to issue or reject it. |
| "Attach at least one evidence photo…" | A fail or hold needs a photo of this unit. | Take the photo in the app, then record the result. |
| Parts clerk: "only N … is free" | The rest is held for other repair requests or kits. | Use another approved location, or escalate the shortage. |
| A unit is "On hold" | QA held it for review. | A QA inspector or the Production Manager decides it (Step 4h). |
| RTS: location "is full" / "has room for only N" | The location's capacity is reached. | Pick another location (or ask to raise its capacity). |
| Release blocked: "no release authorization" | Sales hasn't issued one (required for every order). | Ask Sales to issue it on the sale order. |
| Recipient has no token | They lost or didn't get it. | **Recipient can't present the token** → a supervisor approves with a reason. |
| "On the site PC — not final yet" | The internet is down; the site's PC saved it. | Nothing to do — it becomes final when the site syncs. |
| Unit passed QA but isn't in stock / can't be released | It hasn't been through **Products In**. | Product clerk receives it (Stage 5). |
| Release scan rejected | The unit isn't Ready to Sell, is on another order, or isn't on this order. | Check its record (scan → record). Set it aside. |
| Sale order not in Release orders | It isn't **approved** yet. | Ask sales/CSR. |
| Stock didn't drop after scanning | By design. Scanning only allocates; stock drops when the **release slip** is issued. | Finish the warehouse-out (Stage 6). |

## Related

- `production-sop.md`: the planner/manager view (product setup, BOM, checklists, job-order
  creation, completion, costing).
- `mobile-warehouse-app.md`: the phone app in general (install, scanner, offline queue).
- `docs/modules/pipelines.md`: the system's pipeline map (Production run, Sales order
  fulfillment).
