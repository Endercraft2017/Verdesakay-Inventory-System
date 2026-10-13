# Guide Center review — 2026-10-13

The Guide Center adds searchable task guides, references for accessible navigation features, contextual screen and dialog help, and highlighted walkthroughs. It includes 14 authored workflows and four tool playbooks; the available catalog depends on the user's permissions and enabled modules.

## Using the guides

- Open **Guide Center** from Home to browse. The **Guide** button in a screen or dialog header, or **Alt+Shift+G**, starts its highlighted walkthrough directly.
- Search by task or feature, or narrow the catalog by module.
- Start a walkthrough to highlight relevant controls. Use Back, Next, Skip, or minimize the coach while working.
- Exit preserves progress for that tenant and user. Resume returns to the saved step; Start over resets it. Finish clears completed progress.
- Opening a guide from a dialog preserves its unsaved draft. References open within the dialog context; navigation requires an explicit action.

Guides do not automatically save, approve, pay, delete, or send anything. Missing or unavailable controls are explained rather than silently triggering an action. Detailed task walkthroughs cover common workflows; other accessible features receive contextual references and control guidance.

## Shortcut tips

Tips describe existing contextual shortcuts: Tab/Shift+Tab for focus, Escape for dismissing help, Enter in menu search and note checklists, and document editor Ctrl/Cmd+S, Z, and Y. The keyboard guide also explains browser Find and zoom. Alt+Shift+G is the new contextual guide shortcut. Walkthrough arrow handling does not interfere with typing or selecting field values.

## Verification

- Relevant frontend suite: 10 files, 51 tests passed after integration and rebase.
- TypeScript checks, JavaScript syntax checks, and whitespace checks passed.
- Live sandbox verified catalog search, module filtering, no-result recovery, feature references, header entries, keyboard opening, actual highlights, draft preservation, resume/start-over, and advancing only after the expected dialog appears.
- Screen entries checked on Dashboard, Employees, HR Approvals, Timekeeping, Forms, Account, and Admin.
- Light and dark desktop views and a 390px phone viewport checked; no horizontal page overflow or browser runtime exceptions observed.

Live testing used only the sandbox. A local unsaved Form Builder draft was discarded without saving; no business records were changed and the real tenant was untouched. Inventory and manufacturing workflows were reviewed in source and tests, but were not exercised as business workflows in the sandbox because those modules were unavailable there. Mobile checks used a browser viewport, not a physical device.

The subsequent [instruction audit](guide-instruction-audit-2026-10-13.md) documents refined wording, authored control guidance and updated verification.
