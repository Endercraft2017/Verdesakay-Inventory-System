# UX reference evaluation — 13 October 2026

UI UX Pro Max was evaluated at commit
`7246805992a42b7bba37d4cac83b01416f0c6c44` of
https://github.com/nextlevelbuilder/ui-ux-pro-max-skill.
Its skill, quick reference, local search code and UX data were inspected. Its search is a
local Python/BM25 reference lookup; it is not model retraining or evidence that a suggested
layout works for our users. Two focused UX searches were run after source review:

- `focus not obscured` returned the AA minimum and separate AAA enhanced/focus-appearance
  rules. Useful for checking overlays and distinguishing conformance levels accurately.
- `dragging movements` returned the need for a single-pointer alternative to drag operations.
  Applicable to canvas dimensions and page/object ordering, alongside keyboard operation.

Useful parts: prioritized accessibility/interaction review, semantic outcome searches,
platform applicability, visible feedback, focus, recoverability and compact-text guidance.
Limitations for this product: general style/product recommendations are not a validated
workflow design; there is no dedicated vanilla-JS stack entry. Generic 44px/16px defaults
and mobile-only navigation advice must be interpreted in context. No palette, typography,
framework or generated MASTER.md was applied to the app. Upstream software remains in
ignored local `work/ux-reference/`; the durable project skill is original, scoped guidance
with this provenance, not a bulk import of the upstream package.

## Primary references

- NN/g, complex-application usability heuristics:
  https://www.nngroup.com/articles/usability-heuristics-complex-applications/
  Review task language, status, recognition, recoverability, consistency and contextual help.
- Microsoft Fluent 2, toolbar:
  https://fluent2.microsoft.design/components/web/react/core/toolbar/usage/
  Use logical groups and separate destructive actions. Prioritize commands and provide
  labeled overflow. This is interaction guidance, not a requirement to adopt React.
- W3C APG, toolbar and keyboard:
  https://www.w3.org/WAI/ARIA/apg/patterns/toolbar/
  https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/
  Verify focus/navigation, native input keys and accessible names beyond automated checks.
- W3C WCAG 2.2, targets and dragging:
  https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html
  https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html
- axe-core:
  https://github.com/dequelabs/axe-core
  Automated findings are a regression aid; incomplete results require human judgment.
- GOV.UK, moderated usability testing:
  https://www.gov.uk/service-manual/user-research/using-moderated-usability-testing

## Task-based user review

Ask an actual or likely author to do these tasks without naming buttons or telling them
the path. Observe what they try, where they hesitate, mistakes and recovery; do not lead.

1. Create an employee payslip layout with company and employee data.
2. Find an unfamiliar pay field, insert it, then remove and undo it.
3. Set a custom paper size and swap its dimensions.
4. Make the layout Payroll's default while retaining the previous alternative.
5. Preview four records in a grid, then turn the design into two pages and inspect print.
6. Recover a draft and explain whether it is saved to this browser, shared, or published.

Record task completion, assistance needed, confusion, recovery and time to result. Prioritize
issues that block completion or threaten work before visual polish. Repeat tasks after fixes.
No participant sessions have been conducted as part of the automated audit; do not fabricate
user success rates or treat selector-driven Playwright tasks as participant observations.
