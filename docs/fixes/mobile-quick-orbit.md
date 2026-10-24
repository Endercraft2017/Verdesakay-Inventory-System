# Circular movable quick actions

The shared Quick Orbit is now a 56 px circle. Its grip hint, drag threshold, nearest-edge snapping and normalized saved position remain. Dragging does not open the actions, and Alt plus arrow keys provides keyboard positioning.

Tapping opens the existing labelled actions on an inward semicircle over a blurred backdrop. Portrait fans face away from the nearest edge. Landscape fans rotate horizontally; exceptionally small windows use a compact, scrollable arrangement to keep every action reachable. When needed, the open control shifts temporarily to keep labels in view and returns to its resting position on dismissal.

The original universal and role-specific action order and route parameters remain. Action activation rechecks current access. The shared modal helper traps focus and handles Escape; tapping outside or the circle also closes the fan. Opening disables the underlying app and locks background scrolling. Closing restores focus, scroll behavior and the prior inert state. Navigation, sign-out, editors, typing and page hiding dismiss or hide the control so a backdrop cannot outlive its owner.

Styles are scoped to the orbit and its backdrop, with opaque label surfaces for contrast, 44 px or larger targets, and reduced-motion support. The shell cache is version 153.

Verification includes the mobile bootstrap and focused orbit tests, TypeScript, and real-app browser cases over a disposable backend. Browser coverage includes native touch dragging, saved position after reload, all corners at 320/390 px, landscape and compact layouts, larger labels, keyboard focus, backdrop dismissal, route parameters, light/dark accessibility and reduced motion. No production data or hardware camera is used by these checks.
