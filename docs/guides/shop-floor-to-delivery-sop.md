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
| 3b | Repair parts handoff | Warehouse parts clerk | `parts_clerk` | Production → **Repairs** (or Work → **Accept Parts Request**) |
| 4 | QA inspection (final pass) | QA inspector | `qa_inspector` | Production → **QC / QA** |
| 5 | Products In / RTS recording | Product clerk | `receiving_clerk` | Production → **Products In** (or Work → **Products In**) |
| 6 | Release units to a sale order | Releasing clerk | `releasing_clerk` | Work → **Release SOs** |
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
   - **📷 Photos (e.g. where the defect is): take at least one close-up of the defect.**
     This is **strongly required by procedure**, even though the app doesn't block you
     without it. The repair team and management rely on it.
   - Tap **Confirm fail**.

Every pass and fail is stamped with **your name and the time**, and you can see it in
**Inspection history**. Tap **View record** there to open the unit's full dossier.

### Step 3b — Units in rework (repair loop)

Units sent to repair appear under **Back from repair (N)** on the same screen.

1. **Request the part(s)** the repair needs. Tap **Request part** on the unit:
   - **Kind**: *Replace a fitted part* or *Add a missing part*.
   - **Component**: search for and pick the part.
   - **Qty** and **Fault**: *Assembler / Production / Supplier / Wear / Other*.
   - **Old part goes to the damage record**: ticked by default for replacements. Leave it
     ticked unless the old part is thrown away.
   - **Note** (optional). Then tap **Send request**. This works offline: it queues and
     sends when the signal returns.
2. While any request is still waiting on the warehouse, **Pass is disabled** ("Waiting on
   the warehouse for parts — can't re-inspect yet").
3. After the warehouse accepts or rejects every request, and the unit is repaired,
   **re-inspect** it: **Pass** (with the checklist) or **Fail** again, exactly as above.

---

## Stage 3b (warehouse side) — Parts clerk: accept or reject parts requests

**Where:** **Production → Repairs**, or **Work → Accept Parts Request**.

Each card shows the request number, *Replace* or *Add*, the part and quantity, the fault,
the job order and unit (with serial), who asked, and their note.

1. Pick the part physically.
2. **Issue from**: choose the location you are taking it from.
3. **Remarks**: for example *"handed over 3 pcs to Line 2"*.
4. Tap **Accept & issue**. This deducts the part from that location. For a *replace*, the
   removed part is booked into the damage record, not thrown back into good stock.
5. Or tap **Reject**. **Remarks are required as the reason**, for example *"not in stock —
   PO raised"*.
6. Hand the part to the repair tech or production.

Works offline: it queues and sends when you're back online.

---

## Stage 4 — QA inspector: final pass (appearance)

**Goal:** A final check of how the unit **looks and is finished**: paint, scratches, decals,
fit and finish, packaging. This is the last quality gate before the unit can be sold.

**Where:** **Production → QC / QA**. You only see units that have already **passed QC**.

The steps are the same screens as Stage 3:

1. Open the job order, then **Pass** or **Fail** each unit, or pass a group by count if
   every unit truly passed.
2. **Pass**: tick the **QA checklist** (required items \*), add remarks and optional photos,
   then tap **Confirm pass**.
   - The unit becomes **Awaiting RTS Recording**. It has passed quality but **is still not
     in stock**. The product clerk puts it into stock in Stage 5.
3. **Fail**: say what failed, **take close-up photos of the cosmetic defect**, and choose
   scrap/dispose/recycle (final) or **repair** (goes back through the rework loop and parts
   requests, then gets re-inspected).

---

## Stage 5 — Product clerk: Products In / RTS (Ready-to-Sell) recording

**Goal:** Physically receive the passed units off the production floor and **post them
into stock** at a real location. **Only from this moment is a unit "Ready to Sell."** This
works the same way as the Goods Receipt in Purchasing.

**Where:** **Production → Products In**, or **Work → Products In**. The list shows every job
order with units or batches waiting.

### Steps

1. Tap the job order.
2. **Received into**: this defaults to the job order's output location. **Change it if the
   units are going somewhere else**, such as the finished-goods warehouse or a showroom.
   This is how a transfer off the shop floor is recorded, in the same step.
3. **Note** (optional): count differences or condition, for example *"1 carton dented"*.
4. **Units**: all are ticked by default. Two ways to confirm:
   - Tap **Scan to receive** and scan each unit's label or serial one after another. Each
     match is ticked. A code that doesn't belong to this job order is rejected ("not on
     this job order"). The scanner closes automatically when every unit is ticked.
   - Or untick any unit that **is not physically in front of you**. Don't receive what you
     can't see.
   - Tap **View** on a unit to see its dossier and photo, so you can compare it with the
     unit in hand.
5. **Batches** (non-serialized output): enter the counted **Receive now** quantity. **Short
   counts are allowed**. Enter what you actually counted, not what was recorded as built.
6. **Print labels:** tap **Print selected** to print the **QR label** for each ticked unit.
   **Stick a label on every unit.** The releasing clerk scans these labels in Stage 6. A
   unit without a label is very hard to release.
7. Tap **Receive selected**. The units become **Ready to Sell**, stock goes up at the chosen
   location, and a receipt `PI-#####` is logged (desktop: Production → Products In →
   Receipt History). Works offline: it queues and sends later.

### Rules

- The app does not require a photo here. The unit's production photo is already on its
  record. If a unit arrives damaged, **don't receive it**. Report it to the production lead
  or QA (Report a problem — describe the damage).
- Passing QA does **not** put a unit in stock. Until this step, reports show it as
  built but **not on hand**.

---

## Between Stage 5 and 6 — Sales: approve the sale order

(Office/CSR step, desktop.) The releasing clerk only sees a sale order after sales moves it
to **approved**. On approval the system checks availability. If there's a shortfall, sales
chooses to trim the order, raise job orders or purchase orders for the gap, or approve it
as a backorder. Approving **locks the order's line items**.

---

## Stage 6 — Releasing clerk: release units to the sale order

**Goal:** Pull the exact physical units for a customer's order and tie each one to that
order by scanning its QR label.

**Where:** **Work → Release SOs**. The list shows sale orders that are **approved** or
partly **released**.

### Steps

1. Tap the sale order. You'll see the customer, the order number, and each line with
   `released / ordered`.
2. **Serialized units (with QR labels):**
   - Tap **📷 Scan units to release**. The scanner stays open.
   - Physically pull each unit, then **scan its QR label**. Each good scan counts up ("N
     unit(s) scanned this session") and the line progress updates.
   - The scan is **rejected** if the unit isn't **Ready to Sell** (not yet received in
     Stage 5, or already reserved or sold), isn't a product on this order, or would go
     over the ordered quantity. Read the red message and put that unit aside.
   - When every line is covered, "**Order fully released**" appears and the scanner closes.
3. **Non-serialized lines (no labels):** type the quantity on the line and tap
   **Release**.
4. The order status becomes **released**, and the screen shows "Fully released — hand off to
   delivery." Stage the goods for the driver.

### Rules

- Scanning **reserves** the units for this customer. No other order can take them. **Stock
  isn't deducted yet.** It leaves inventory when the sale order is **completed** after
  delivery.
- Scanning works offline: scans queue and send later. Re-check the line counts once you're
  back online.
- To un-release a wrong unit, ask a supervisor. It's done on desktop, where the unit goes
  back to Ready to Sell.

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
   are allowed to. **This is the moment stock actually leaves inventory**, and the reserved
   units become **Sold**. If you don't see the button, the office completes the order.

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
| 3 QC fail | QC inspector | **Close-up of the defect** | — | "What failed" required; photo by procedure |
| 3b Parts request | QC/QA inspector | — | — | Component required |
| 3b Accept / reject part | Parts clerk | — | — | Reason required to reject |
| 4 QA pass / fail | QA inspector | **Close-up of any cosmetic defect** | Batch/lot ID (optional) | Same as QC |
| 5 Products In | Product clerk | — (unit photo already on file) | **Scan each unit** to confirm it's physically there | Location required; **print and stick QR labels** |
| 6 Release SO | Releasing clerk | — | **Scan every unit's QR label** | Yes: only Ready-to-Sell units on this order are accepted |
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
| Pass is greyed out on a rework unit | A parts request is still waiting on the warehouse. | Ask the parts clerk to accept or reject it. |
| Unit passed QA but isn't in stock / can't be released | It hasn't been through **Products In**. | Product clerk receives it (Stage 5). |
| Release scan rejected | The unit isn't Ready to Sell, is on another order, or isn't on this order. | Check its record (scan → record). Set it aside. |
| Sale order not in Release SOs | It isn't **approved** yet. | Ask sales/CSR. |
| Stock didn't drop after release | By design. Stock drops when the SO is **completed**. | Complete the order after delivery. |

## Related

- `production-sop.md`: the planner/manager view (product setup, BOM, checklists, job-order
  creation, completion, costing).
- `mobile-warehouse-app.md`: the phone app in general (install, scanner, offline queue).
- `docs/modules/pipelines.md`: the system's pipeline map (Production run, Sales order
  fulfillment).
