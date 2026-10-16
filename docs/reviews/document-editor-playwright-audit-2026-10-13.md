# Document editor Playwright audit — 2026-10-13

Audited the actual application and template route with Playwright and system Chromium,
using an isolated temporary database. No production records were edited by the audit.
Desktop viewport: 1440 × 1000. Phone viewport: 390 × 844. Both light and dark themes.

## Findings resolved

- Chromium inserted a single noneditable variable chip outside a paragraph when the
  selection ended at its element boundary. Single-chip insertion now uses the saved DOM
  range inside the existing command/history transaction. Added a regression test.
- Undo and Redo were available only on the Text tab. They now remain in the ribbon bar
  while using Insert, Page & print, Table or a collapsed ribbon.
- Phone font controls could shrink beside paragraph controls and extend past the left
  viewport edge. The font group now has its own full-width wrapping row. The guide button
  remains accessible as a compact icon and the header fits in two rows.
- The floating assistant could cover inspector actions. It now follows the app's drawer
  convention while an inspector is open.
- Sidebar selection memory also captures a structural bookmark for DOM refreshes and
  preserves selection before mouse focus leaves the page.

## Verified flows

16 Playwright workflow checks passed: authenticated editing/shared connection; starter
variable deletion with undo/redo; typing and font formatting; variable-bank search/copy/
insertion; Find/replace; custom dimensions and zoom-aware dragging; table insertion and
properties; image upload and picture settings; shapes and visibility/locking; tracked typing
and accepting changes; tooltips and panel/ribbon collapse; HTML/DOCX export and DOCX conversion
preview; proportional grids and a one-page PDF; save/API persistence/reopening; multipage
grid restrictions and two-sheet preview; light/dark desktop and phone layout.

A final targeted visual pass checked settled theme colors, compact checkbox sizing,
visible Save, contained font controls and the two-row phone header. No application page
errors occurred in the completed Playwright run. Scratch screenshots and Playwright traces
were retained under work/playwright-audit/ and are not application assets.

The full regression suite passed 227 files / 2,400 tests. One stale unit assertion was
aligned with the existing attachment-only messaging feature; route tests still reject a
message with neither text nor attachments. Typecheck and focused editor checks passed.
After integrating concurrent message-storage updates, the full Playwright audit and
focused message, validation, editor, template and document-conversion checks passed again.

## Scope limits

This audit used Chromium desktop and an emulated phone viewport. It does not establish
Safari/Firefox or physical printer-driver behavior. DOCX export still reports conversion
notes for floating positioning and image crops/masks/filters; review those effects in Word.
Pixel-identical Word layout is not claimed. Browser preview/PDF proportional grid output
was checked independently of DOCX conversion.
