---
name: editor-ux
description: Review or improve Otom's document editor using task-based UX reasoning, existing design tokens, accessible interactions, and reproducible browser checks. Use for editor toolbars, canvas/selection, variables, form linking, dialogs, responsive layouts, print preview, and error/recovery flows.
---

# Document editor UX

Use this guidance for changes to the document editor. User instructions and repository
architecture take precedence. Preserve the existing vanilla JS/HTML/CSS stack and app
convention; do not introduce React, Tailwind, another palette, or an upstream design-system
reset just to apply this skill. Read the relevant module catalog/pipeline records first.

## Start with the task

Identify who performs the task, the desired result, and what they need to recognize.
Describe the sequence in ordinary user language before choosing a layout. For example:
create a payslip layout → insert employee/pay fields → preview → save → link to Payroll →
choose default → print several employees. Test a realistic completed result, not just clicks.
Use familiar document/design terminology. Keep variables searchable so authors can recognize
fields instead of remembering their token spelling.

## Review in this order

1. **Safety and state:** preserve drafts, selection and undo. Save states must distinguish
   local edits, recovery, shared synchronization and published template content. Show errors
   with a recovery action; do not label a conflict as saved. Do not silently overwrite.
2. **Discoverability:** keep Save and Close reachable at all sizes. Group controls by what
   they affect, with dividers/space. Width → Swap → Height belongs together; Margin is separate.
   Preserve a visible path to variables and form links. Do not rely on an unexplained icon
   or hover-only tooltip for unfamiliar concepts.
3. **Accessibility:** native semantics and associated labels first. Icon buttons need names.
   Dialogs contain focus and return it to their invoker. Focus must remain visible when tools
   open. Retain native input editing keys. If implementing ARIA toolbars, use the W3C keyboard
   contract and test arrow navigation/Tab explicitly; an axe pass alone does not verify it.
4. **Efficiency and density:** keep the canvas useful. Fluent's toolbar pattern prioritizes
   frequent commands and uses a labeled overflow menu. Choose overflow, bounded scrolling,
   or grouped rows based on the control types/task; document the tradeoff. Do not endlessly
   shrink unfamiliar icons. Retain labels inside overflow menus and a clear overflow cue.
5. **Visual consistency:** use the app's surface/text/accent/border/radius tokens, stroke
   icons, spacing and control states. Review both themes. Color swatches must look like
   pickers. Editing chrome is themed; actual printed paper retains its document colors.

## Interaction checks

- Typing, IME composition and selection stay stable while using ribbon/sidebar controls.
- Focus or pointer movement between controls must not introduce an undo step. Real edits do.
- Switches/checkboxes toggle their setting; their labels are clickable and describe the effect.
- Resizing/reordering has visible non-drag alternatives. Page dimensions are editable in mm;
  Shift constrains proportions and Escape cancels a drag. Test the same result through controls.
- Use WCAG 2.2 AA's 24 CSS pixel target criterion with its defined spacing/equivalent-control
  exceptions; prefer larger targets, particularly important touch controls, where practical.
  The 44px enhanced target criterion is not a blanket AA requirement. Compact visual handles
  can have larger transparent hit areas. Do not excuse clipped/obscured targets using size alone.
- Advanced features can be disclosed progressively, but labels must make the path obvious.
- Form links respect form-management permissions. Multiple layouts remain available; one is
  default. Unlink removes the relationship, not template content. Search must not retain a
  selected form that is no longer a matching option.
- A grid scales the original design proportionally. Design pages >1 disable grids. Preview,
  print and saved dimensions must agree. User paper content must not inherit chrome scaling.
- Reduced motion, keyboard focus, narrow viewports, browser/text zoom, and long names are
  separate checks. Passing a viewport screenshot does not establish all of these.

## Evidence before delivery

Run `npm run test:editor:ux`: isolated app + Playwright task checks + axe WCAG A/AA scans.
Use `EDITOR_UX_CASE=...` to reproduce a scan, then run the complete gate for delivery.
Review `work/editor-ux/results.json`, screenshots and trace. Never hide axe violations using
broad exclusions, disabled rules, or a permanent baseline allowance. Investigate incomplete
results manually and record limits. Scan dialogs when open and contextual controls when active.

Also run typecheck and focused unit/integration regressions appropriate to changed behavior.
Inspect screenshots at 1440, 1024, 768 and 390px in both themes. For keyboard work, use actual
keyboard input and inspect focus/selection. For save/link work, verify persisted backend state.
Report scope, findings/fixes and remaining limitations. Automated checks do not replace real
user testing or establish WCAG conformance. Use the task protocol in the reference document.

## References

See [references/evaluation.md](references/evaluation.md) for the evaluated upstream skill,
primary UX/accessibility sources, adaptation decisions and a usability task protocol.
