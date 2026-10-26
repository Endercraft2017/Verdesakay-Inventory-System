# Shared mobile action alignment

2026-10-26. Candidate working-tree changes; no application deployment or push.

The screenshot's actions inherited RoleUI's explicit left alignment. The same
mobile app also had page-specific font sizes, padding and minimum heights for
legacy, HR, stock and item buttons. Shared color/radius tokens alone did not
establish a complete control contract.

`public/mobile/controls.css`, loaded after component styles, now owns action
alignment, typography, padding, minimum hit size and radius for rk-btn, m-btn,
m-v2-primary and m-v2-secondary. The migration removed 22 competing rules from
legacy/role/page styles. Layout and semantic colors remain in their components.
The contract includes body-mounted dialogs, centered wrapping text, equal-height
paired actions and symmetric space around labels with trailing RoleUI icons.
List rows, dropdown options and icon-only navigation retain their own layouts.
Shared press, focus and reduced-motion behavior is preserved. PWA cache v166
includes the new shared stylesheet.

Before evidence reproduced horizontal label offsets of 29.625px (Review BOM)
and 15.90625px (Back to products). After correction, the largest measured horizontal
offset was 0.0078125 CSS pixels across 12 width/theme/motion combinations. The
actual BOM editor, review actions and discard dialog passed for normal and long
labels, disabled controls, trailing icons, focus containment and Keep editing.
Ten representative production, inventory, notes and HR route/theme checks also
passed with matching action typography. No dialog axe violations were found.

`npm run test:ui:scratch`: 49 checks passed; 146 source/image hashes match current
working code; zero uncaught preview errors and zero external preview requests.
The broader suite includes native BOM/API/SQLite recovery checks, navigation,
shared themes, guides, focus, dropdowns and Quick Actions geometry. Focused Vitest
suites passed 26 tests, and TypeScript passed. The delivery test separately checks
root, topic and preparation Work-tab entry at two app canvas widths.

The real-code preview's change notes contain the four deeper-work points and
rewritten brief. Taste Skill's app-screen guidance informed equal-height controls
and the phone type/hit-size floor. UI UX Pro Max's mobile checklist informed touch,
focus and accessibility checks; its two focused searches did not provide verified
centering guidance. PostCSS traced the conflicting declarations; Playwright used
actual text and control bounds rather than treating declarations as proof.

Reproduce with `npm run ui:scratch`, `npm run test:ui:scratch`, and
`node scripts/test-ui-scratch-delivery.mjs` after opening/preparing Site source.
The before screenshot is optional retained evidence, not required by future runs.
Evidence is in ignored work/ui-scratch and work/button-alignment. No physical
phone, screen-reader session or employee usability study was performed. Automated
coverage is for the named components and routes, not every mobile screen.

Private preview publication succeeded. Live authenticated HTTPS responses for the
main launcher, Work review and preserved preparation review returned 200 and
matched the tested files byte-for-byte. Application changes remain uncommitted.
