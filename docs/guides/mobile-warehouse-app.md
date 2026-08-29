# The Mobile Warehouse App

A stripped-down phone version of the system for the people on the floor: scan an item,
move stock, count, receive, or report a problem — and it keeps working when the Wi-Fi
drops.

## What it's for

- Stock **in / out** and **transfers between locations**, by scanning
- **Cycle counts** (spot counts) with variance shown
- **Fulfilling orders** from the shelf
- **Reporting damaged stock** and other problems with a photo
- Everything queues and syncs automatically if you're offline

## Before you start

- On the phone's browser, open the same address staff use for the system. Phones are
  sent to the mobile app (`/m`) automatically. You can also type `.../m` directly.
- Log in with your normal account. You need the **mobile warehouse** permission — ask
  your admin if the app says you're not allowed.
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

- If you lose signal, submissions go into a **queue** (you'll see a counter).
- Keep working — scanning and entering data all work offline.
- When the connection returns, the queue **sends itself**. You don't need to do anything.
- Each queued action is tagged so it can't be applied twice, even if you retry.
- Check the **queue view** to see what's pending or if anything failed to send.

## Reporting damage / a problem

1. Pick **Report problem** or **Damage**.
2. Scan or type the item.
3. Enter how many units are affected and a short note.
4. Add a **photo** if you can — it helps the office.
5. Submit. Damaged units are moved out of normal stock into a "damage" record; the total
   on hand is preserved, so nothing goes missing.

## Tips & gotchas

- **Good light + steady hands** make the scanner fast. If it struggles, use manual entry.
- The app shows **your** allowed actions only; if a tile is missing, it's a permission.
- Don't clear your browser data for the site while the queue has unsent items — they live
  on the phone until they sync.
- One phone, one logged-in user. Log out at the end of a shift on shared devices.

## If something goes wrong

| What you see | Fix |
|---|---|
| "Not allowed" / app won't load | You lack the mobile warehouse permission — ask an admin. |
| Camera does nothing | Site isn't HTTPS, or the browser blocked the camera — allow it in the browser's site settings, or use manual entry. |
| Queue count won't go down | No connection yet, or a queued item errored — open the queue view to see which one and why. |
| "Item not found" on scan | The code isn't a known SKU or barcode — check it's the right label, or add the barcode to the item on the desktop. |
