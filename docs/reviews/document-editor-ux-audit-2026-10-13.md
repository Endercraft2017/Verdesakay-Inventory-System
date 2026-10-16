# Document editor UX audit — 13 October 2026

Reviewed the real authenticated app in Playwright with an isolated database: 40 screen
states covering Text, Insert and Page & print, ten side panels, File, Settings and Linked
forms; desktop 1440, tablet 1024/768, phone 390, light and dark. Reviewed screenshots and
control bounds/names. This is a focused browser/accessibility review, not a WCAG certification.

## Findings and fixes

- At 1024px Save was partly clipped and Close was off-screen; at 768px more header actions
  were unreachable. Responsive icon buttons now preserve their accessible names and fit.
- The phone header grew to 141px and Page & print left only 268.5px of workspace on an
  844px screen. Header actions now occupy two compact rows; phone ribbon height is bounded,
  with a visible More controls below action. Width/swap/height stays one group.
- Insert tools overflowed horizontally without good cues. Groups now wrap at tablet/phone
  sizes; overflow containers are keyboard-focusable, with explicit scrolling assistance.
- Width, Height and Margin lacked screen-reader names. Explicit names now match mm units.
- Field management was hard to find from Variables. Manage fields now opens the existing
  variable manager and refreshes the variable bank/preview after catalog updates.
- Linking long form lists required browsing a plain dropdown. Find a form now searches
  name/section within permitted forms, preserving matching selection and clearing stale
  selection. Empty results explain the user's management scope.

## Validation

20 Playwright workflows passed with no runtime page errors: responsive header/actions,
overflow scrolling, field management, form linking/default/unlink, real typing/history,
variables, tables, images, review, export/import, proportional grid PDF, save/reopen and
multipage grid restrictions. The follow-up screen inventory found no viewport overflows
or unnamed visible fields in the inspected editor states. Typecheck and 114 focused command, studio and reliability tests passed.

A further eight table-toolbar states and eight table-properties dialogs were checked across
the same widths/themes. Toolbars stayed within the viewport. The dialog color swatches were
too thin because generic text-input padding consumed their interior; table and named-style
pickers now use explicit 36px height and 3px padding.

## Remaining priorities

- The intermittent shared-save conflict recorded in the previous audit remains unresolved;
  this pass did not reproduce it and does not change collaboration overwrite behavior.
- Further design work can consolidate the long Pages/Review panels into contextual groups,
  and use the app's existing design tokens to document reusable editor controls in Figma.
- Rich DOCX/Word layout fidelity and full Word/Canva parity remain separate engine work.

Figma is appropriate for reusable screens/components and design review, MagicPath for
interactive prototypes, and Canva for branded document/template references. Their tools
are available in this session; no new plugin or external design artifact was installed
or created for this audit. Playwright validates the actual app rather than a mockup.
