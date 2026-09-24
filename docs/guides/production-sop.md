# SOP — Production, end to end

**For:** production planners, shop floor, QA/QC, warehouse
**In the app:** Home → **Help / SOP** → *Production — end to end* (browsable, printable).
This file is the trainer's copy of the same playbook.

---

## The flow

Production's tabs are ordered to match this list left to right: **Overview → Product Setup →
Job Orders → Scheduling → QA / QC → Repairs & Parts Requests → Products In → Batches / Lots →
Finished Goods.** Steps 1–2 are one-time setup, not part of the day-to-day flow.

0. **Overview** — *Production → Overview*, the tab's home screen (`inventory.view`). Not a
   working screen of its own — a summary of where things stand: overdue job orders, units
   stuck in rework, what's waiting on someone (QA/QC queue, Products In, repair requests to
   accept), and a short production report (WIP, scrap rate, recently completed) pulled from
   the same feed as Home → Reports. Every row links straight to the screen that handles it —
   start here to see what needs doing before diving into a specific tab.

1. **Define the finished product & BOM** — *Production → Product Setup* (`inventory.edit`).
   List the parts to build one unit. A component that is itself a finished product with its
   own BOM is a **sub-assembly** and is exploded automatically. **Copy BOM from another
   product** seeds a new variant's BOM from a similar one (build the blue unit from the red
   one, then swap the fairings). Optional **standard Labor** / **Overhead** per unit are
   added on top of the rolled-up material cost and used to value finished units into stock.
   A product may be saved with **no BOM** — it is still buildable, it just reserves/consumes
   nothing until components are added.

2. **Attach a QA/QC checklist (optional)** — build it from **Manage Checklists**
   (`qc.configure`), reachable from either *Production → QA / QC* screen or *Product
   Setup*. Named, reusable; each check scoped to *every* inspection, the *QA* pass, or
   the *QC* pass. Required checks must be ticked before a unit/batch can pass. Attach the
   checklist to a product on its BOM editor in Product Setup.

3. **Schedule / start the job order** — *Production → Job Orders* (`inventory.adjust`).
   Product + quantity; **team**, **work centre**, **planned start**, **due date**,
   **priority**; **inspection stages** (0 / 1 / 2); **source** location and a default
   **output** location (Products In can still send finished units elsewhere at receiving
   time). Starts as a **draft** — ad-hoc components and planned-quantity overrides are
   allowed on a draft. A job-type sales order's **Start production** action creates a linked
   one. *Production → Scheduling* is the supporting calendar/roster view across every job
   order, for monitoring at a glance — schedule/team fields live on the job order itself,
   Scheduling isn't where you set them, just where you watch them.

4. **Release (parts out)** — reserves + deducts the planned components from the source
   location (fails with a shortfall list, no partial release). With the GL on, material
   value moves Inventory → Work in Process. Records who released it.

4a. **Accept the parts kit (production lead)** — on the job order (desktop or phone), the
   production lead counts the released kit against the **Components** list, ticks *I
   counted the kit*, adds an optional handover note, and taps **Accept job order**. Records
   who accepted and when (shown on the job order and the production record). **Output can't
   be recorded until this is done.** A short or damaged kit isn't accepted — report it
   (phone: **Report a kit problem**) and the warehouse/supervisor fixes the release.

5. **Build (record production progress)** — units **finished** / **scrapped**; every unit
   off the line consumes its components. Either way this does **not** post to stock yet:
   **0 stages** → one **batch/lot** recorded per entry, awaiting Products In. **1–2 stages**
   → units queue for inspection instead; add a **batch label** to group the entry.

6. **Inspect (QA/QC)** — *Production → QA / QC → Inspection Queue* lists every unit waiting on
   inspection across all job orders; open one to work the checklist and **Pass** / **Fail**.
   Pass advances the stage; the final pass queues the unit for **Products In** (step 8) — it
   is not stock yet. A **fail** needs a **disposition**: *scrap / dispose / recycle*
   (terminal, counts as scrapped) or *repair*. Non-serialized job orders can get an optional
   **batch-level sign-off** from Production → Batches / Lots — a quality record, independent
   of receiving. Every pass/fail ever recorded is queryable at *Production → QA / QC →
   Findings & Reports* — filter by result / date / job order or product, export to CSV, open
   one for its full checklist snapshot.

7. **Repair / rework (branch)** — a *repair* unit → **rework**, holding the job order open.
   From the repair panel raise **parts requests** to the warehouse — *add* (missing) or
   *replace* (swap; old part → its damage record) — with a fault reason (assembler /
   production / supplier / wear / other). Nothing moves until the warehouse **accepts** on
   *Production → Repairs & Parts Requests* (issues the replacement, with remarks). The unit
   is **re-inspectable** only once every request is accepted / rejected / cancelled — a pass
   then rejoins the flow at Products In.

8. **Products In** — *Production → Products In* (`inventory.adjust`). The checkpoint that
   mirrors Purchasing's **Goods Receipt**: nothing posts to stock — and the GL's
   material-only "DR Inventory / CR WIP" entry doesn't post — until it's confirmed here,
   whether QC applied or not. **Ready to Receive** lists every job order with output
   waiting; tick units, or enter a batch's counted quantity (short counts allowed — a
   physical count can come in under what was recorded as built), pick the **destination
   location**, and post. Choosing a location other than the job order's default output is
   how a *warehouse transfer* away from the shop floor happens, in the same step. **Receipt
   History** is the log of every past receipt (`PI-#####`). A unit only becomes
   sellable/reservable once received here.

9. **Completion & returns** — production completion tracks the *build*, not receiving: once
   every ordered unit is accounted for (built + scrapped) and nothing is pending or in
   rework, the job order **completes** and unused reserved components return to the source
   location — even if some output is still awaiting Products In. **Close (finish early)** /
   **Cancel** do the return manually; either way, whatever was already built still needs to
   be received.

10. **Labels & QR** — print QR labels per unit (identifier) or per batch (`BATCH-#####`).
    Edit the layout under **Label design** (model, variant, code, batch fields, QR). Scanning
    a label resolves it to the unit / batch **Production record**.

11. **Production record (dossier)** — read-only, printable, per unit or batch: identity
    (model / variant), job order + team + who built it, every QA/QC sign-off with checklist
    ticks and disposition, repair history, and the stock movements it drove (including its
    Products In receipt).

12. **Sell / move (Finished Goods)** — *Production → Finished Goods* is the cross-product
    view of what Products In has actually received — everything on hand, ready to sell or
    move. Only received (in-stock) units can be sold or moved; the same Sell / Move action
    used at receiving handles a later transfer too. Allocate to a sales order from the order
    screen or from Finished Goods — removes them from stock and stamps the order.

## Watch out

- A job order can't auto-complete while a unit is in **rework**.
- A QC pass (or, with no QC stages, recorded progress) does not post stock on its own —
  **Products In** does. "Built" and "on hand" are different states; don't assume one implies
  the other when reading a report or reconciling counts.
- Repair-issued parts are a direct stock movement (component out, old part → damage); they
  don't roll into the job order's standard per-unit cost or the GL.
- Deleting a **production team** is blocked while a job order points at it — deactivate.
- The schedule's per-day capacity is **advisory** only.

## Related

- `docs/guides/multi-level-bom.md` — BOM explosion, costing, where-used.
- `docs/guides/purchasing.md` — PO → goods receipt → vendor bill (feeds component stock).
- `docs/guides/reports.md` — the Production section of Home → Reports (WIP, overdue, scrap).
