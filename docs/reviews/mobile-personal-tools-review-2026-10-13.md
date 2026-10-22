# Web-to-phone personal tools review — 2026-10-13

This is the first completed item in the owner’s staged web/phone review. It fixes the personal-tool and guide gaps identified before checking Timekeeping and the remaining operational features individually.

## Findings and fixes

The earlier chat described phone Tasks as a different task system. Source inspection corrected that: both clients already use the same `/api/tasks` records. The phone Work hub called an incorrect `/personal/tasks` endpoint and discarded the selected task ID, while phone Tasks lacked a linked-note editor.

- Work now reads `/tasks` and opens the selected task by ID. Missing or deleted task links explain that the record is unavailable.
- Notes / checklists is available in Work → My tools. It uses the webapp’s owner-scoped `/notes` records, including body text, editable checklist items and scheduling.
- A linked task opens its actual note. Task scheduling does not overwrite the linked title or checklist summary; those are edited through the note.
- Completing or reopening a task updates checklist progress through the shared backend. Saving a note updates its linked task; rescheduling reuses one task.
- Unscheduling deletes the linked task while preserving the note. Deleting a note retains the task and its captured context, as on the webapp. Destructive actions require confirmation.
- Failed scheduling retains the saved note ID so retry does not create a duplicate. Save-in-progress blocks navigation and repeated submission; unsaved edits require confirmation before navigation and browser unload.
- Late list responses do not overwrite a screen the user has already left. Failed loads offer Retry.
- Reminder links include the task ID. Reminder timestamps retain UTC storage while due fields display local times; task date grouping uses the device’s local date.
- Task-opening controls are keyboard accessible and completion controls have 44px touch targets.

## Phone guides

The phone header’s Guide button starts a highlighted walkthrough without navigation or writes. Notes and task editors have tailored instructions, numbered highlights, Back/Next/Skip, minimize and exit. Empty checklist sections are excluded from highlights.

Work → My tools → Guides provides a searchable library from the shared 14 workflow definitions, filtered by enabled modules. The personal-note recipe uses phone paths. Other references name required webapp screens; they do not pretend every administrative action is available on the phone. General phone screens have contextual starting guidance; their detailed operational walkthroughs will be checked with each subsequent feature audit.

The shared tour engine resolves platform dependencies lazily, preserving desktop startup order. Phone guide text uses touch instructions. Draft values are never copied into guide text. Service-worker cache version advances to `v79` and includes the new assets.

## Validation

- Nine targeted test files passed: 108 tests covering desktop and phone bootstrap, mobile personal-tool interactions, web guides, notes/task persistence, ownership isolation, scheduling, reminders and notification links.
- Final phone-guide and personal-tool frontend checks also passed after touch and empty-highlight refinements. TypeScript, JavaScript syntax and whitespace checks passed.
- Sandbox candidate UI used local frontend assets against the real sandbox API. A disposable web-created scheduled checklist was opened and edited on the phone, then reread in the actual web Notes drawer.
- Sandbox verified exact task links, linked-note opening, checklist editing, complete/reopen synchronization, rescheduling without duplicates, Manila reminder conversion, draft preservation, shared guide search, empty-result recovery and unscheduling without note deletion.
- Light/dark screenshots were inspected at a 390px phone viewport; no horizontal overflow or runtime exceptions were observed in the clean final run.
- Only the test’s own newly created notes and tasks were cleaned up. The real tenant was untouched. No payroll or attendance records were changed.

Actual push delivery to a locked physical phone was not tested. Notification creation, reminder rearming and exact-task URLs were verified in local integration tests; future reminders used in the sandbox were removed with the disposable task.

## Next check

Start with Timekeeping: web cutoff setup → phone clock punches → web attendance and Daily Report → missed-punch correction → approval → payroll inputs. Finish and report that review before advancing to employee requests and approvals.

Remaining sequence: employee requests/approvals, payroll/payslips, work schedules, inventory, production, sales/releases/deliveries, messages/announcements, reports/notifications, and account/permission boundaries. Notes/Scheduler is completed here; each remaining feature still needs its own end-to-end audit.
