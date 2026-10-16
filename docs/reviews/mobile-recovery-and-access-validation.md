# Mobile recovery and access validation — 2026-10-16

## Implementation

- Final releasing retains handoff photos, signature, package/recipient/token context
  in scoped IndexedDB. A unique immutable attempt is saved before upload. Photos
  and signature upload under separate stable keys as order evidence, then transfer
  atomically to the release slip. A lost response is explicitly retried with the
  original body/key; no post-shipment signature upload is required.
- Delivery drafts retain optional photo/signature/GPS/recipient/note state; start
  and complete requests have durable recovery. Authority-local acknowledgements
  remain pending through their original sync command. Conflicts and expired attempts
  require reconciliation; definitive refusals require refreshed-context review.
- Saved attempts appear independently of live queues and cannot be silently replaced.
  Account/server changes and revision checks guard shared phones and stale tabs.
- Owner decisions retained: delivery evidence stays optional, and delivery may start
  before warehouse-out. Recording a delivery does not force-complete a sale or
  deduct stock a second time. Delivery managers and assigned runners retain their
  proper API access; ordinary employees cannot use either permission implicitly.
- `MApp.canOpen` combines effective permissions and workspace modules. Operational
  routes, Work/production queues and Quick Orbit follow it. Inventory movement
  history is operational, not a universal employee activity feed. Personal tools
  remain available for baseline accounts. Permission updates refresh on foreground,
  focus and reconnect, bound to the original account/server/token.

## Automated evidence

`npm run test:mobile:qr` uses the real disposable Express/SQLite backend, actual
printed QR images through Chromium's virtual camera and a persistent Chromium user
profile. It does not restore photo bytes from Playwright storage-state JSON, mock
successful stock transactions or replace scanner callbacks. Deliberate response
loss happens only after real API commits. It covers final releasing upload/slip
recovery, delivery start/POD recovery, optional evidence/pre-slip starts, basic
account UI/direct-link/API restrictions and desktop permission revocation.

Focused tests cover file bytes, original JSON/key recovery, signature-before-stock
ordering, scope isolation, unavailable storage, pending site-PC results, existing
mobile roles, delivery permissions and batch/stock invariants. TypeScript and the
full regression suite are required; exact final results are in the main handoff.

## Visual and physical limits

Existing role/photo/signature components remain; Figma 78:281 and 78:401 context and
screenshots were inspected. Recovery states extend the existing role UI. Delivery
retains its existing mobile form; this is not a new Figma delivery redesign. Browser
screenshots are generated at 390×844. These checks do not certify actual printed
sticker sizing, phone-camera optics or every device-specific browser lifecycle.

See `mobile-handoff-6185481-review.md` for separate unfinished mobile integration.

## Final integrated results

TypeScript passed. All 235 focused tests passed. All 24 real-backend Chromium
checks passed at 390×844 with no page errors. The frozen full suite passed all
2,796 tests across 273 files (493.85 seconds), including upstream `0a53a32` and the
reconfirmed backend policy. Physical phone/printer acceptance remains open.
