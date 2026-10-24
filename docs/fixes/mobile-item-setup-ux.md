# Mobile item creation and QR setup

Chunk 27 implements the four approved views: New item, creation receipt, QR item selection and QR preview. The rounded surfaces, pill buttons, shared header/dock and existing search/scanner remain. The shared Quick Orbit now has a centered SVG plus without the dot grip; its drag, saved position, keyboard movement and action fan remain.

Approved reference: https://chatgpt.com/space/page_8fcf6232025081919185b95cc5c773a5

## Forms and authority

The phone retains Name, SKU, Unit, Category, starting quantity/location and reorder level. Category/reorder are explicitly optional details. Photo, supplier, price and custom fields remain on desktop. Blank, fractional and negative numeric inputs produce inline errors; explicit zero remains valid. Changing Unit updates the quantity label.

Creation still requires `inventory.create`. Nonzero starting stock separately requires `inventory.adjust`. A create-only account can create zero-stock metadata without waiting for an unauthorized location read; the backend uses its existing default location. Location loading is bounded, account/view scoped and recoverable. A failed permitted read keeps the draft and blocks submission until a valid location is available.

A confirmed receipt replaces the form and identifies the saved item, quantity and location. Next actions require their actual route/read permissions. Late reads and saves cannot append a receipt onto Home or another account's view.

The existing QR route still requires `inventory.adjust`; current item reads require `inventory.view`, and generating a barcode additionally requires `inventory.edit`. Picking an item no longer writes its barcode. The selected identity and code source precede explicit Show QR or Save barcode and show QR. Existing codes produce no mutation. The QR has a white quiet area, exact displayed code, copy fallback and the existing Home/another-item actions.

## Durable writes

Creation and generated barcodes use the existing account/server-scoped IndexedDB workflow attempt. The original JSON and idempotency key are saved before sending. Writes are single-flight and bounded; missing/incomplete responses stay unresolved. Explicit recovery reuses the original request. Access-changed replays require reconciliation instead of becoming a new editable creation.

Keyed item creation persists the item, initial stock and receipt in the same transaction. A repeated no-SKU creation therefore cannot create a second item or stock transaction, and a failed receipt write rolls everything back. Unkeyed API callers remain supported.

`PUT /api/inventory/:id/barcode` is a narrow, `inventory.edit`-guarded claim action. It merges the generated barcode into current attributes inside a transaction, preserves costs/stock/other metadata, rejects replacing an existing label or colliding with another item's code, and persists keyed receipts atomically. It does not change the existing general item-edit endpoint or grant any additional authority.

A site-PC acknowledgement is labeled pending. Its original receipt stays available until the command confirms or needs reconciliation; the UI does not advance to another creation or label from that pending receipt. Confirmation checks are bounded and stop on navigation. No automatic mutation retries are introduced.

## Verification

`node scripts/test-mobile-item-setup.mjs` uses a disposable backend/database and real mobile browser. It checks the centered plus, four views, input errors, saved records/stock history, existing-code decoding, attribute preservation, lost create/barcode responses across reload, late navigation, read retry, 320px content and independent account permissions. It performs nine light/dark scoped accessibility scans.

`node scripts/test-mobile-quick-orbit.mjs` covers the existing fan, touch dragging, saved position, focus/keyboard behavior, landscape/small-window geometry and personal shortcut persistence after removing the grip.

Frontend/backend regressions cover numeric validation, create-only access, malformed responses, immutable retry keys, changed-access recovery, site-PC confirmation, exact barcode updates and atomic receipt rollback. No database migration or new dependency is required. Physical phone cameras, printers and deployed-site acceptance are separate from these disposable browser checks.
