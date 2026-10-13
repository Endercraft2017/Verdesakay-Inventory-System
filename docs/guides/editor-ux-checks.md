# Editor UX checks

Read `.agents/skills/editor-ux/SKILL.md` for the project review procedure and its references.
The skill preserves our existing design convention and vanilla JS stack. UI UX Pro Max was
evaluated as a reference; its complete package is not installed into the product.

## Run

Install development dependencies normally. If no Chromium is installed, run
`npx playwright install chromium` once. The audit uses Playwright's browser by default,
or detects standard Linux Chromium paths. `PLAYWRIGHT_CHROMIUM_EXECUTABLE` can choose a
specific local executable; it never accepts an external app/server URL.

```sh
npm run test:editor:ux
```

The runner creates and removes temporary SQLite/platform/upload directories, starts the
actual app on loopback with an ephemeral port, and authenticates only to that local app.
It never writes production data or sends a message to an external AI model. The assistant
check opens/closes the existing UI and reads local conversation state.

The complete run scans editor Text/Insert/Page & print, ten panels in both desktop themes,
phone ribbons in both themes, modal dialogs and the contextual table toolbar. Task checks
cover reachable Save/Close, assistant access, ribbon overflow, variable copy/field management,
keyboard dialog focus/Escape return, Payroll/default layout preservation, page size swap,
real dragging/undo and multipage grid restrictions.

The default command fails for any automated WCAG A/AA violation, failed task, or runtime
page error. It records axe incomplete results for manual review rather than claiming them
passed. Reports, screenshots and the Playwright trace are in `work/editor-ux/` (git-ignored).
Review JSON with `results.summary`, each scan's violations/incomplete, and task checks.

For an initial baseline only: `npm run test:editor:ux -- --report-only`. This allows axe
violations to be collected, but still fails task/runtime errors. Do not use it for delivery.
`EDITOR_UX_CASE=phone` filters accessibility scans for diagnosis; all task checks still run.
Run the full, unfiltered strict gate after fixes. No rules/exclusions or blanket baseline
allowances are installed to hide failures.

## Manual follow-up

Axe cannot fully evaluate gradient contrast, non-text glyph contrast, selection/IME stability,
all keyboard patterns, screen-reader experience, or whether people understand workflows.
Inspect screenshots/focus and check relevant WCAG/APG requirements manually. The reference
contains realistic participant tasks and records that no user research sessions have yet
been conducted. An automated pass is not WCAG certification or proof of universal usability.
