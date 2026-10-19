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

- **Receive PR** receives purchased supplier goods against a purchase request/order.
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
