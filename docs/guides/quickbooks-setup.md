# QuickBooks Online integration

Push your **sale orders** to QuickBooks as **Invoices** and **purchase orders** as
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

1. **Inventory → Orders → Sale Orders** (or Purchase Orders) → **QuickBooks** button (needs the
   users.manage permission).
2. **Connect QuickBooks** → a popup opens Intuit's sign-in → choose the company → approve.
3. The popup closes and the button shows a ✓. That's it — the tokens are stored
   encrypted and refresh themselves.

## Pushing orders

- The QuickBooks row action requires **orders.edit** and an available connection. Each order row gets a **QuickBooks** icon. Click it to create (or, if already pushed,
  update) the Invoice / Bill in QuickBooks. A toast confirms with the document number.
- **"Auto-push orders when saved"** attempts export in the background. Saving the order does
  not confirm its QuickBooks export. Failures are logged; interrupted or overlapping exports need
  review. Durable automatic retry/coalescing and user-visible failure status remain unfinished.
- Re-pushing a linked order updates its document in the same connected company. If an earlier write has an unknown outcome, export is blocked for engineering reconciliation; do not retry blindly.

## Notes

- Sale and Job orders → **Invoices**; Purchase Orders → **Bills**.
- The order's customer/supplier name is matched to (or created as) a QuickBooks
  Customer / Vendor.
- **Disconnect** stops local use and clears local credentials. Existing QuickBooks documents,
  company-scoped record links and write receipts stay for reconciliation.
- It's per-workspace: connecting one company doesn't touch another.

## Upgrade and interrupted exports

Older connections must reconnect to record their environment. Legacy record links without company
provenance need engineering reconciliation before affected exports can resume; they are preserved.
Company changes use separate record links. Interrupted or uncertain exports stay blocked across
restart/reconnect until reviewed. See the [engineering runbook](../operations/quickbooks-lifecycle.md).
No passwords, tokens or accounting exports should be sent through chat.

## If a push fails

| Message | Fix |
|---|---|
| "QuickBooks is not connected" | Connect it first (or it was disconnected / the token was revoked in Intuit). |
| A QuickBooks API error about an account | In QuickBooks, set a default income account (for invoices) / expense account (for bills), or add the item there, then push again. |
| Nothing happens / button missing | The server env vars aren't set, or you lack the users.manage permission. |
