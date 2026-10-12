# Notes automation and page layout review — 12 October 2026

## Notes and Scheduler

Notes now support plain text, a checklist, or both. Checklist items have stable IDs, editable labels, completion state, and removable rows. Enter adds an item; Save also includes any item currently being typed. Notes can be searched by title, body, or checklist text.

Scheduling a note creates one linked personal task with a due date/time and an optional reminder. Rescheduling updates that task rather than duplicating it. Edits refresh the task's title and captured note/checklist context. Completing every checklist item completes the task; marking the task complete checks all items. Reopening a completed task leaves the final checklist item unfinished and preserves earlier completed items. Scheduler opens the linked note directly and supports due/reminder editing.

Pending checklist saves disable that card's controls to prevent rapid clicks from overwriting progress. Failed scheduling can be retried without creating another note. Deleting a note preserves the task and its captured context; deleting the task removes the schedule without deleting the note.

Notes and tasks remain private to their owner. Schema v64 adds a checklist JSON column and a nullable, unique task-to-note reference; existing plain notes and tasks remain valid. The schedule endpoint and linked updates work with offline synchronization. New reminder times use UTC instants, while the editor displays local time; existing local-time reminders remain supported. Saving an unchanged reminder does not re-arm a notification that already fired. Desktop reminder notifications open Scheduler; mobile reminders open My Tasks.

## Layout corrections

- Timekeeping warnings are now a compact header button with a count. Clicking it opens readable details and an approvals action. Warnings still do not block generation, and generation dialogs retain their review notes.
- Cutoff actions stay in a grouped row instead of leaving Generate Payslips stranded when the title wraps.
- Shared page cards now use a consistent spacing rhythm, panel padding, and filter-bar alignment, with smaller spacing on phone widths.
- Editors opened from side panels render above their parent panel. Headers and Save/Cancel actions remain visible while editor content scrolls.

## Verification

129 tests passed across 12 focused suites, and TypeScript checking passed. Coverage includes persisted checklists, ownership, invalid schedule dates, duplicate prevention, completion in both directions, reminder deduplication/time handling, retrying a failed schedule, rapid-click protection, compact HR warnings, migrations/backups, and linked-note synchronization from an offline desk PC to the cloud.

Live browser/API checks in `/sandbox` confirmed checklist-only creation, two saved items, a linked task, Manila-local reminder conversion, checklist-to-task completion, task reopening, direct navigation back to the note, and on-demand Timekeeping warning details. A future-dated `NOTES-UAT-` note/task was retained for review; no immediate live reminder was sent.

Screenshots were inspected for Notes and Timekeeping at desktop and 390px widths in light/dark modes. Home, HR Employees, Approvals, Timekeeping, Forms, Account, and Admin passed the desktop layout checks in both themes without horizontal page overflow or browser exceptions. The sandbox does not expose Inventory, so that screen was not included in the live review. Actual push delivery on a physical device was not tested; reminder creation/deduplication was tested against disposable databases.

No real-tenant records were accessed or modified. Concurrent document-editor changes on the branch were preserved.
