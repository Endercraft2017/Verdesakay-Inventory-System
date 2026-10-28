# Editor rulers — 28 October 2026 (Asia/Manila)

The core document studio now mounts top/left rulers in a grid around its existing canvas.
The page remains the contenteditable surface. New measurement DOM is outside serialization,
shared snapshots and Undo. Print preview is a sibling of the ruler workspace; source mode
hides the whole document workspace as before. No database or API change is needed.

Layout → View provides Show rulers and Ruler settings. The unit corner opens the same
settings, and general Editor settings includes the options. Browser-local preferences
choose visibility, mm/cm/in, page-edge/text-area zero and pointer/caret indicators. Old
settings receive defaults and invalid stored units/origins are ignored. Preference changes
do not edit the template; unavailable storage retains the existing session-only notice.

Ticks adapt to zoom/available space and render only the visible range, including the far
end of large custom pages. Margins are shaded. Geometry follows scrolling, manual/fit zoom,
canvas resizing, sidebar width and active design pages. When the caret is offscreen, the
most visible page supplies the ruler origin. Static ticks are cached; moving
indicators update on animation frames. Carets between owned inline runs use adjacent native
text rectangles; empty paragraphs have a CSS box fallback. Measurement adds no marker nodes
inside authored content. Closing cancels pending frames and releases listeners/observers.

Verification: 205 focused ruler/editor/studio/float/reliability/print tests and TypeScript.
Playwright exercises real pointer measurements, text typing/arrow caret positions and Undo,
unit/origin changes, persisted preferences/reopen, hidden rulers, zoom/scroll, source mode,
custom dimensions/resizing, print-preview exclusion, multipage origin, save/reopen and Layers.
The full gate passed 113 state scans with zero axe violations, 19 task checks and zero
runtime errors. Screenshots were reviewed in both themes and at desktop/phone sizes.
Automated results do not establish full accessibility conformance or replace user testing.

This is a measurement/view feature; existing Layout controls continue to own page geometry.
It does not change the Wordcraft engine port phase or claim full Word ruler parity.
