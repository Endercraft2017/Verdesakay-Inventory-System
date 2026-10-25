# Circular movable quick actions

The shared Quick Orbit is now a 56 px circle. Its centered SVG plus replaces the dot grip. The drag threshold, nearest-edge snapping and normalized saved position remain. Dragging does not open the actions, and Alt plus arrow keys provides keyboard positioning.

Tapping opens the existing labelled actions on an inward semicircle over a blurred backdrop. Portrait fans face away from the nearest edge. Landscape fans rotate horizontally; exceptionally small windows use a compact, scrollable arrangement to keep every action reachable. When needed, the open control shifts temporarily to keep labels in view and returns to its resting position on dismissal.

The common actions stay fixed: New request, Report issue, and New message (when messaging is permitted). Users can choose one or two work shortcuts through Edit shortcuts. QC inspection and QA inspection have distinct IDs and explicit desk parameters, so someone with both permissions reaches the intended desk. Options include the existing production, parts, receiving, warehouse, purchasing and delivery destinations, filtered by route/module and task permissions. There is no change to those workflows or their authorization.

Before a user saves preferences, the fan recommends one permitted work shortcut. Saved choices are retained if access is revoked, but unavailable actions disappear rather than being replaced by another desk. Activation checks current access again.

GET/PUT `/api/mobile/quick-actions` reads and saves the authenticated account's preferences in its tenant database. PUT validates one or two unique permitted IDs and rejects owner fields. The existing settings replication uses a merge command on site PCs; the editor explicitly identifies pending device sync there. A workspace/account-scoped browser cache supports offline reads, and borrowed-phone sessions use session storage. Saves require a server response, prevent repeated submissions, retain input on failure, and ignore stale responses from another account. Reads and writes have bounded requests. The editor uses the same rounded surfaces, selects and buttons as the app. The shared modal helper traps focus and handles Escape; tapping outside or the circle also closes the fan. Opening disables the underlying app and locks background scrolling. Closing restores focus, scroll behavior and the prior inert state. Navigation, sign-out, editors, typing and page hiding dismiss or hide the control so a backdrop cannot outlive its owner.

Styles are scoped to the orbit and its backdrop, with opaque label surfaces for contrast, 44 px or larger targets, and reduced-motion support. The shell cache is version 158.

Verification includes the mobile bootstrap and focused orbit tests, TypeScript, and real-app browser cases over a disposable backend. Browser coverage includes native touch dragging, saved position after reload, all corners at 320/390 px, landscape and compact layouts, larger labels, keyboard focus, backdrop dismissal, route parameters, light/dark accessibility, the shortcut picker, two selected work actions, cross-session/device persistence and reduced motion. API tests cover authentication, owner isolation, invalid selection sizes, duplicate IDs, desk-specific permissions, permission revocation and disabled modules. No production data or hardware camera is used by these checks.

Closing now runs a roughly 180 ms ease-out: actions fade/shrink, backdrop blur and
dimming clear, the close glyph rotates back, and the circle returns to its resting
position before the overlay is removed. Shortcuts are disabled during departure;
the background remains inert until removal. Escape, outside press and the circle
share this lifecycle. A selected shortcut navigates after closing and rechecks its
original account and current access. Tapping the circle during departure reverses
the transition without a stale timer closing the reopened menu. Navigation,
refresh, page hiding and hidden app/editor states force immediate cleanup; reduced
motion also closes immediately. The shared overlay helper is unchanged.

Validation: all 18 real-app Quick Orbit Playwright scenarios pass, including
controlled browser-timeline sampling of intermediate action/backdrop opacity and blur at 390×780, 1440×900 and
320×320, rapid reversal, repeated dismissal, route replacement and reduced motion.
Trace and measured frames are in ignored `work/mobile-orbit-exit-final/`. This is
local Chromium verification, not a physical-device or deployed-site result.
