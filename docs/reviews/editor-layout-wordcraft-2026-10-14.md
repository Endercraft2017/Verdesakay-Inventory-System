# Editor layout familiarization — 14 October 2026 (Asia/Manila)

Compared Wordcraft's actual hero screenshot and `crates/ui-egui/src/ribbon.rs` at
`159b84f54c74e9e82fb3109b758ae7dd6f4e3ab0`. Its Home ribbon separates Font, Paragraph,
Styles and Editing; Insert groups document elements; Layout concerns the page. This pass
adapts that hierarchy to our existing vanilla-JS editor and app theme tokens. No upstream
Rust/egui code, font assets or new palette/framework were imported.

## Resulting organization

- **Home:** Font, Paragraph, Styles and Editing, with visible group captions/dividers.
- **Insert:** Tables, Illustrations, Text & links, Symbols & breaks. Line shape and
  Horizontal rule have distinct labels. Template fields/formulas are in Variables instead.
- **Layout:** paper size/orientation/dimensions/margin and a Print grid shortcut.
- **Document sidebar group:** Pages, Outline, Styles.
- **Design sidebar group:** Inspect, Layers, Library.
- **Template sidebar group:** Variables (including insertion/formulas/management), Form links
  (metadata and existing scoped link/default dialog), Print grid (copies/cells/gaps/preview).
- **Review sidebar group:** Review, History, Shared where enabled.
- **Footer:** zoom; **More:** preferences, guide and advanced source editing. The More popup
  anchors to its actual launcher at every width, and dialogs return focus to that launcher.

The rail has readable inline names/group separators on desktop, compact named controls on
phones, and an icon-only collapse option. The settings pane starts closed. Print grid remains
available beside measured preview; other editing panels are hidden in that preview mode.
Multi-design-page grid restrictions and uniform scaling remain unchanged. Sidebar descriptions,
short grid-flow wording and a live arrangement summary explain the distinction between rows,
columns and independent copies without requiring a separate guide.

Persistent live control nodes are moved after their existing handlers are wired; they are
never cloned or rebuilt during panel navigation. This retains field insertion selection,
metadata/print state, undo, recovery/shared syncing, publication and form-permission checks.
Opening panels and menus does not mark the template dirty. New-template starter/help wording
matches the new locations; existing authored document content is untouched.

## Validation

- Strict actual-app Playwright/axe gate: **92 WCAG A/AA scans, zero automated violations,
  ten passed task checks, zero task/runtime errors**. Desktop/phone themes, twelve panels,
  More menus, advanced dialogs and contextual table controls are covered.
- Task checks include More/settings keyboard focus trap/return, field-bank copy/management,
  Payroll alternative/default preservation, dimension swap/50% pointer resizing with undo,
  repeated delayed-poll saves with backend persistence/reopen, and multipage grid guards.
- Measured-preview check edits grid controls in place, verifies a changed physical column
  gap and four uniformly scaled cells while the settings remain usable beside the sheets.
- Separate actual-app browser audit: **20 workflows passed**, covering real typing/undo,
  remembered-caret variable insertion, find/replace, table/picture/shape/review operations,
  HTML/Word export and import preview, proportional grid/PDF and saved content reopening.
- Typecheck and **209 focused regressions** passed. The 49 command/workspace checks were
  repeated after the last menu refinement and passed. Artifacts stay in ignored work/.
- Post-rebase checks preserve the newer production changes: typecheck, 83 focused
  workspace/help/guide tests and the current-app task/menu checks pass. Phone menu action
  labels are asserted visible, fixing legacy header styles that hid Settings in the popup.
- The fixture now sets an explicit disposable-test admin password for the newer secure seed;
  production bootstrap/auth behavior is unchanged. Production records are never used for tests.

## Limits

Axe incomplete contrast cases remain recorded for manual judgment; no exclusions or rule
suppressions were added. Screenshots were reviewed in both themes, and task layouts exercised
1440/1024/768/390px widths. This does not claim screen-reader certification, physical-device
IME/touch coverage, real-user research or full Wordcraft/Word/Canva feature parity. The engine
work remains at its existing incremental phase; this release changes the UI organization.
