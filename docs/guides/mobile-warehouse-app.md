# The Mobile Warehouse App

A stripped-down phone version of the system for the people on the floor: scan an item,
move stock, count, receive, or report a problem. Supported actions can queue offline;
physical handoffs and photo-backed operations use their own confirmation/recovery flow.

## What it's for

- Stock **in / out** and **transfers between locations**, by scanning
- **Cycle counts** (spot counts) with variance shown
- **Fulfilling orders** from the shelf
- **Reporting damaged stock** and other problems with a photo
- Supported stock and shop-floor writes queue offline; some actions require a connection

## Before you start

- On the phone's browser, open the same address staff use for the system. Phones are
  sent to the mobile app (`/m`) automatically. You can also type `.../m` directly.
- Log in with your normal account. Mobile entry accepts mobile.access, legacy inventory.mobile
  or a linked employee account. Work queues and Inventory tools follow effective action
  permissions and enabled modules, including desktop per-person overrides. Linked employees
  can use personal HR tools without warehouse access.
- For the camera scanner to work the site must be **HTTPS**. If it isn't, you'll get a
  manual code-entry box instead — still fully usable.
- Add it to your home screen (browser menu → "Add to Home Screen") so it opens like an
  app.

## Steps — a typical stock move

1. Open the app and pick **Stock move** (or Transfer / Cycle count / etc.).
2. Tap the scan button and point the camera at the item's barcode/QR, **or** type the
   code.
3. The item and its current quantity appear. Enter the amount and, for a transfer, the
   destination location.
4. Tap **Submit**. You'll see a confirmation.
5. Repeat for the next item.

## Working offline

- If an action supports offline queuing, its submission enters **Pending sync**. Other
  actions remain saved attempts requiring an explicit confirmation/retry.
- Previously cached lists and item lookups can be used offline. New data may not be available.
- Supported stock moves, transfers, counts and eligible QC decisions can queue. They
  do not take effect on the server until accepted. Kit release, final warehouse-out and
  RTS receipts use online confirmation, not automatic background stock posting.
- Serialized output/photo, handoff and delivery/courier workflows preserve supported
  drafts and immutable saved attempts across restart. Review the original attempt after
  an unknown response; do not recreate the same physical action. Time punches need a connection.
- A local site-PC acknowledgement is pending until its sync command confirms. A refusal,
  conflict or expired request requires reconciliation before a corrected attempt.
- When the connection returns, the queue retries automatically. Check **Pending sync**
  for rejected or failed actions and retry after resolving the reported problem.
- Each queued action is tagged so it can't be applied twice, even if you retry.
- Check the **queue view** to see what's pending or if anything failed to send.

## Reporting damage / a problem

1. Pick **Damage**, then scan or type the item.
2. Enter the affected quantity, location and reason.
3. Submit to move those units from sellable stock to a damage record. After an online
   success, attach photos to that damage record if needed; photos are not queued with
   an offline stock submission.

**Report a problem** is different: choose a recipient, category and reference, then
write the problem and send it as an internal message. It is text-only and does not move
stock. For tracked production/kit or unit findings, use the job’s issue action or **Issues and photos**.
These reports keep their evidence and history; reporting alone does not advance inspection or pause work.

## Tips & gotchas

- **Good light + steady hands** make the scanner fast. If it struggles, use manual entry.
- The app shows **your** allowed actions only; if a tile is missing, it's a permission.
- Don't clear your browser data for the site while the queue has unsent items — they live
  on the phone until they sync.
- One phone, one logged-in user. Log out at the end of a shift on shared devices.

## If something goes wrong

| What you see | Fix |
|---|---|
| "Not allowed" / app won't load | For warehouse tools, ask about inventory.mobile and workspace inventory access; for employee HR tools, ask HR to link your account to your employee record. |
| Camera does nothing | Site isn't HTTPS, or the browser blocked the camera — allow it in the browser's site settings, or use manual entry. |
| Queue count won't go down | No connection yet, or a queued item errored — open the queue view to see which one and why. |
| "Item not found" on scan | The code isn't a known SKU or barcode — check it's the right label, or add the barcode to the item on the desktop. |

## Connected workflows on the phone

Open **Work → Guides → Workflows & Pipelines** to follow the same roadmaps as the
webapp. Each stage shows the responsible team, prerequisites and result handed on.
Screen names identify tasks that must be completed on the desktop.

- **Release orders** allocates exact sale lines/build states. **Kit releases** prepares
  manufacturing components; the retired Pick route performs no stock action.
- **Deliveries** belongs to a particular trip slip. Several trips retain the same SO.
  Courier pickup means the carrier collected the goods, not customer receipt.
- **Returns** starts from a shipped slip and photo-backed receipt. Receipt alone does
  not restock/refund. Inspection, rejected-goods repair and finance credit are separate.
- **Semi-finishing** consumes one eligible complete semi-built package and creates
  one inspection unit. Do not repeat BOM picking or Add unit; QC/QA and RTS still follow.
- **RTS recording** confirms passed output at an exact storage location, checking
  capacity and duplicate receipts. Keep saved receipts until confirmation/reconciliation.

## Understanding your Work tasks

On **Work**, press the header's **Guide** button. It highlights and explains each
queue and tool currently displayed for your account: what it is, when to use it,
and its result or next handoff. It follows the actual permission-filtered rows,
not a fixed role template. A task with no current waiting records can still be
available and explained; the guide does not enable unavailable tasks.

Important distinctions:

- **Receive supplier delivery** receives goods against an existing supplier purchase order; it does not approve an internal spending request.
  A confirmed goods receipt adds purchased stock; vendor bill approval/payment are later steps.
- **RTS recording** receives eligible production output after required quality checks.
- **Kit releases** issues components to Production. **Release orders** handles customer goods.
- **Allocate units** can directly remove finished stock for sale, whereas ordinary
  Release orders picking reserves goods until the trip slip records stock-out.
- **My planned checks** opens assigned counts; **Physical stock counts** captures
  observations. Submission alone does not complete the reconciliation task.

The introductory step explains WAITING / CLEAR / OPEN queue labels. Next and Back
only move through explanations; they do not open tasks, save or submit work. Every
visible task is included without a shortened overview that silently skips entries.
If access changes while help is open, the old guide closes; reopen Guide to read
explanations for the refreshed Work screen. **My tools → Guides** remains the
separate library for broader workflows across modules.

### Find an explanation quickly

Inside the Work guide, use **Jump to a task** instead of pressing Next through the
whole list. The selector contains only the overview and the entries currently
visible on your Work screen. Back and Next continue from the selected explanation.
Stock-related entries start with a **Stock effect** callout, distinguishing reads,
reservations, physical stock-in/out, location moves and separate reconciliation.
Selecting an explanation only changes help; it does not open or submit that task.


### Job-order selection and units from before the system

QC, QA and RTS receiving start with job-order cards showing eligible-unit counts.
Choose the job order, then its unit. With no eligible work, the desk says there
are no ongoing job orders for that stage. Unit links still open the exact record.

For a physical unit that predates the system, the RTS clerk opens **Enter or
resume pre-system unit**, selects its finished product and location, and records
a distinct physically marked identifier, photo, intake reason and unit cost.
This creates an `LI` legacy inspection intake, not a production kit or available
stock. QC and then QA must inspect the unit. Match its identifier and intake
number against the physical unit; stop if identity is unclear. Resolve repairs,
holds or failures through the usual inspection process.

After both passes, the RTS clerk opens its eligible intake, prints and attaches
the unit QR sticker, scans that sticker, and confirms Products In. Only that
receipt adds available RTS stock. Recover an interrupted intake through the same
entry; retry the original saved attempt rather than entering the unit again.

## Latest inspection, receiving and personal tools

- **QC / QA / RTS** first groups eligible work by job or legacy intake. Pick the
  group, then the unit card. Empty means no work currently eligible for that stage.
- Before inspection, match the physical identifier and job/intake. QR stickers are
  not required yet. At RTS, print, attach and scan the sticker before confirming stock-in.
- **Enter or resume pre-system unit** captures existing goods for mandatory QC then
  QA without issuing BOM parts or adding stock. See the [intake roadmap](workflow-roadmaps.md#pre-system-physical-units).
- **Tasks & reminders** groups Overdue, Today, Upcoming, No date and Done. Wait for
  Updating task to finish; Try again repeats the intended failed update. Relative
  reminders need a due date; custom reminders need their own time. More actions →
  Delete task asks for confirmation and retains any linked note.
- **Messages** provides reply/reaction actions and eligible own-message editing/removal.
  Check upload, reaction and send feedback before retrying an uncertain action.
- **Internal Purchase Requests** currently uses the desktop request screen. Do not
  confuse spending budget/receipts/liquidation with the phone's Receive supplier delivery.

Notes-list checklist ticks now save immediately. Wait for Saving checklist; Try again
repeats a failed tick. Opening the note editor and changing its content still needs
Save. Shared checklist/task updates are personal work tracking, not inventory actions.


### Internal purchase requests

Use **Make PR** in Work to request a budget for parts, tools or supplies. Enter
any item names, quantities and expected prices; no inventory SKU or supplier is
required. Open **My requests** from the form to follow status. A request and its
approval do not move stock.

Designated authorities use **Review PRs**. Approve a positive overall budget and
choose cash to the requester or a separate assigned buyer. Record cash only once
it is physically issued. Supplier-order management permission does not authorize
internal PR approvals. An approval leaves the purchase and liquidation open.

The buyer uses **My assigned purchases**, opens the PR and adds camera photos or
JPG/PNG/WebP/PDF receipts, one at a time. Prepared files must fit the 8 MB limit.
Open **Enter actual purchases** to record what was bought. Add or substitute items
as necessary, while keeping total spending within the approved overall budget.
Receipts are required; cash-to-requester purchases also need cash issuance
recorded before liquidation. Submitted evidence is locked until authority returns
the liquidation for correction.

The authority downloads/reviews receipts and actual items, returns liquidation
with a reason if correction is needed, or closes it after recording the exact
change returned or reimbursement physically paid. Approvers cannot upload or
liquidate for another buyer. Stocked purchases still need normal item setup and
supplier receiving; there is no automatic purchase-order conversion.

Drafts and receipt files survive browser restart under the same account/server.
Use **Saved PR work** to resume or recover. If a response is lost, retry the
original action; do not record the cash or purchase a second time. A site-local
acknowledgement remains pending until its command is confirmed.


### Live attention, Sales and inspection desks

Work combines live records and unread updates in **Needs my attention**. Open a
record for read-only details, then **Open workflow** for permitted actions.
Access and live queue membership are checked again before opening. Refresh is
available manually and runs every 30 seconds while this Work view remains open.
Unavailable queues show unknown counts. **Notifications & history** retains older
updates; an old notice does not authorize a completed or reassigned action.

**Sales pipeline** and **Customers** are separate from warehouse releasing.
CSR staff can search real stages and customer records; each change needs its
own create/edit/approve/authorize permission. New sale orders start open, without
stock-out. Sales can explicitly authorize partial trips; a warehouse report does
not grant that approval. **Order tracking** shows warehouse progress read-only,
with commercial pricing removed by the API for operational viewers. A customer
job order is a sales document; a production job order remains in Production.

QC and QA may inspect in either order on two-inspection jobs. Each desk uses its
own checklist and draft answers. A single pass does not permit RTS receiving;
both required passes and cleared holds are needed. Legacy intake shows which
approvals remain. Existing single-inspection jobs keep their combined checklist.

Draft production job reviews offer **Review subassembly build suggestions**.
Only an authorized planner can explicitly create a linked child draft, within
the current buildable quantity. The child must complete its normal workflow and
RTS receipt before it supplies the parent. Stock browsing filters parts/supplies
and finished products using the existing product flag and one SKU.

PR approval, physical cash issuance and liquidation settlement are separate
grants. **Review PRs** shows only the decision buttons granted to that employee;
requester/buyer separation is also enforced by the backend.


### Pending work on Home

Home shows a quick preview above Quick access for your assigned parts/kit release,
QC, QA, hold-review and RTS receiving duties. Each desk shows its pending count
and up to two records. Tap a record for details, then open its authorized workflow,
or use the queue button for the full list. The preview updates every 30 seconds
and has a Refresh button. Unknown means the live queue could not be checked.
Employee-only accounts do not see these operational desks.

Pending counts distinguish units, jobs, requests and batches with remaining pieces.
Parts-blocked inspection is labelled “Waiting for parts”; it remains in the queue
but cannot proceed until the warehouse resolves the request. RTS mismatch holds
have a separate issues link and do not inflate the ready count. Each desk loads
independently; failed or timed-out reads show Unknown. Operational queues remain
available when attendance/employee-summary loading fails. Refresh also rechecks
updated access.
