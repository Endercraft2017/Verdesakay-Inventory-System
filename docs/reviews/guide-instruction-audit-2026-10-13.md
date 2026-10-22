# Guide instruction audit — 2026-10-13

Reviewed all 14 authored workflows (83 steps), the four personal-tool playbooks, generated feature references, and the shared contextual guide fallback against the current frontend controls. This review addresses the owner’s report that instructions highlighted controls without explaining what they do.

## Changes

- Rewrote 58 steps across production, sales, purchasing, payroll, inventory, accounting and rework into actions with named screens, required inputs and observable results. Refined the newer navigation, request, approval, form-building, notes and document-editing workflows too.
- Added 157 authored control instructions covering HR, inventory, production, purchasing, accounting, documents, personal tools, messaging, settings and support. Entries are shown only where their controls are present and available.
- Expanded Email, Scheduler, Bookmarks and Bug-report playbooks into control-specific steps instead of telling the user to open another guide.
- Corrected the document-editing workflow to start in Templates, use the actual document canvas and preview controls, and distinguish uploaded files from editable templates.
- Corrected the linked-form workflow to point to Time Keeping. Payroll guidance explains advisory review warnings, scheduled working-day leave deductions, department decisions without a second HR approval, and attendance locking after payment.
- Removed unsupported instructions about adding 13th-month payouts manually to a specific tax return. The guide now asks users to reconcile those payouts against the worksheet rather than prescribing a potentially incorrect duplicate adjustment.
- Feature walkthroughs hand off to the target screen’s concrete control steps after explicit navigation and loading. They do not stop at a circular “open the guide” instruction.
- Shared fallback text uses labels and declared descriptions for custom fields, distinguishes screen search/filter controls from record entry, names the actual confirmation button, and skips unnamed, hidden or disabled controls. It does not copy entered field values into guide text.
- Existing contextual highlights now resolve controls by stable IDs when the screen rerenders. Closed sections are omitted until opened rather than highlighting inaccessible fields.

Custom forms and unregistered controls still use their own labels and descriptions; the app cannot infer an organization’s custom business policy from a field name. Authors can provide `data-guide-help` or `aria-description` for precise instructions. This review does not claim a tailored recipe for every possible user-defined form.

## Validation

- Ten targeted frontend test files: 70 tests passed, including explicit feature navigation, payroll highlights, employee numbering instructions, concrete cross-module and personal-tool guidance, custom-field descriptions, hidden-control exclusion and preservation of entered values.
- TypeScript, changed JavaScript syntax and whitespace checks passed. The guide runtime tests also passed after the final availability refinement.
- All 157 instruction selectors were checked against actual frontend control declarations.
- Candidate scripts were checked against live sandbox screens: Employees (7 highlights), Approvals (3), Timekeeping (3), Payroll (6), uploaded files (3) and Templates (4). Every tested step highlighted a visible target; no browser exceptions occurred.
- Sandbox verification used read-only navigation and walkthroughs. No business records were created, approved, paid, sent or deleted. The real tenant was untouched.

Inventory, production, purchasing and accounting content was reviewed in source and covered by frontend tests; their complete business workflows were not executed in the sandbox for this content audit.
