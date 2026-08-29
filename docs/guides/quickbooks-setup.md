# QuickBooks Online integration

Push your **sale orders** to QuickBooks as **Invoices** and **purchase requests** as
**Bills**, with their customers, vendors and amounts. One-way, on demand (or automatic).

> **Beta.** It covers the common case. QuickBooks may need a **default income/expense
> account** set for line items to post; and de-minimis line detail (tax accounts, item
> mapping) is left for your accountant to tidy on the QuickBooks side.

## One-time server setup (developer / operator)

The app connects with **one Intuit app** that serves every workspace. Set these env vars:

| Var | What |
|---|---|
| `QBO_CLIENT_ID` / `QBO_CLIENT_SECRET` | From your app at [developer.intuit.com](https://developer.intuit.com) |
| `QBO_REDIRECT_URI` | `https://<your-domain>/api/quickbooks/callback` — must be registered on the Intuit app **exactly** |
| `QBO_ENV` | `sandbox` (default) or `production` |

Until these are set, the QuickBooks button doesn't appear.

## Connecting a workspace

1. **Inventory → Sale Orders** (or Purchase Requests) → **QuickBooks** button (needs the
   Admin permission).
2. **Connect QuickBooks** → a popup opens Intuit's sign-in → choose the company → approve.
3. The popup closes and the button shows a ✓. That's it — the tokens are stored
   encrypted and refresh themselves.

## Pushing orders

- Each order row gets a **QuickBooks** icon. Click it to create (or, if already pushed,
  update) the Invoice / Bill in QuickBooks. A toast confirms with the document number.
- Turn on **"Auto-push orders when saved"** in the QuickBooks window to have every
  created/edited order pushed in the background.
- Re-pushing an order **updates** the same QuickBooks document — it never duplicates.

## Notes

- Sale and Job orders → **Invoices**; Purchase Requests → **Bills**.
- The order's customer/supplier name is matched to (or created as) a QuickBooks
  Customer / Vendor.
- **Disconnect** in the QuickBooks window clears the link (existing QuickBooks documents
  stay).
- It's per-workspace: connecting one company doesn't touch another.

## If a push fails

| Message | Fix |
|---|---|
| "QuickBooks is not connected" | Connect it first (or it was disconnected / the token was revoked in Intuit). |
| A QuickBooks API error about an account | In QuickBooks, set a default income account (for invoices) / expense account (for bills), or add the item there, then push again. |
| Nothing happens / button missing | The server env vars aren't set, or you lack the Admin permission. |
