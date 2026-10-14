# Common document ribbon — 14 October 2026 (Asia/Manila)

Reference: https://github.com/storytold/wordcraft, ribbon.rs at
`159b84f54c74e9e82fb3109b758ae7dd6f4e3ab0`. The chosen controls are practical everyday
Word-style editing tools, not an empirical ranking of Microsoft Word feature usage.
No upstream code/assets were imported.

Home now groups Clipboard, Font, Paragraph, Styles and Editing. New controls are Paste,
Cut, Copy, Paste text, grow/shrink font, direct Clear formatting, Replace and Select all.
Insert exposes Header, Footer and Page number through the existing Pages actions. Template
fields, form links and print grids remain in their sidebar groups. Custom arrows keep select
hover surfaces themed and preserve native selection and keyboard operation.

Clipboard uses canonical token serialization and the existing sanitized paste handler.
Cut deletes only after a successful write and unchanged document/selection. Paste likewise
checks its destination after asynchronous reads. Denied clipboard access leaves writing intact
and offers native keyboard shortcuts. Ribbon Cut is disabled during text tracking; image paste
still uses the native keyboard route. Header/footer insertion preserves body writing, reuses
existing running elements and participates in Undo and existing print counters.

Validation: TypeScript check; 206 focused editor/studio/print regression tests; Playwright
checks for formatting and Undo, clipboard with field tokens, Replace focus, running elements,
themed select hover, linking/defaults, proportional print grids and delayed save/reopen.
The browser gate passed 92 state scans with zero axe A/AA violations, 12 task checks and
zero runtime errors in both themes at desktop/phone sizes; manual
visual review supplements automated rules. Full Word feature parity is not claimed.

## Follow-up from the live UI screenshots

The sidebar background shorthand reset arrow repeat/position even though the dark arrow
image remained. Protect the arrow longhands, including the image in both themes, so
Empty cells, zoom and other editor/dialog selects show one arrow at the right edge.
Wide desktop Home now has one horizontal command row, with labeled group separators and
accessible stroke icons for clipboard and editing actions. Swatches no longer inherit
form-label margins. Text styles and sidebar guidance explain body text, heading levels
and updating paragraphs that share a named style. Smaller screens retain bounded wrapping.
Validation includes 95 command/studio tests and an actual Empty cells hover check, plus a
wide desktop ribbon height limit of 76px in the full Playwright gate.
