# Notes and Tasks UX pass — 2026-10-13

Implemented the owner’s requested UX improvements for Notes, personal scheduling and guides. Timekeeping and the remaining feature audits are paused.

## Changes

- Both clients use **Tasks & reminders**. Internal task routes and exported functions stay compatible. Guide searches still find the old Scheduler name through existing workflow IDs.
- Note cards display checklist progress, deadlines and reminder times. Phone cards show up to three checklist items that save immediately, matching web cards. Editors explicitly say that Save applies their changes.
- Phone note and task editors keep Save/Cancel and a live save-status indicator above the navigation dock. They adapt to the visible keyboard viewport and hide the floating quick-action button while editing. Status distinguishes new/unsaved, saving, saved and failed operations.
- Date controls offer Today, Tomorrow and Pick date. Reminder shortcuts include no reminder, at the deadline, 30 minutes / one hour / one day before, and custom date/time.
- Relative shortcuts adjust while editing. Reminders are stored as exact timestamps; existing reminders reopen as Custom, with a prompt to recheck them if the deadline changes. This pass does not add recurring reminders or a persistent relative-reminder rule.
- Date-only deadlines survive opening and saving an editor unless the date/time is explicitly changed. Unchanged reminders retain their original timestamp, including seconds and timezone offset, to avoid accidental reminder rearming.
- Delete actions live under More actions rather than beside the primary Save button. Removing a schedule explains that the note remains and requires confirmation. Linked-task buttons are available near the note’s scheduling controls and on phone cards.
- Web editor fields are inert during saving; phone editors retain their save-in-progress and draft-navigation protection.
- Contextual guides offer Brief overview and Detailed walkthrough. The selected depth is remembered per user, tenant and guide. The coach is more compact and reacts to the visible viewport when the phone keyboard changes.
- Phone cache version advances to `v80`, including the shared personal-UX helper. Native controls use the dark color scheme inside personal tools.

No plugin installation or external design-file changes were needed. The running UI and sandbox screenshots served as the reviewable prototype.

## Verification

- Seven targeted frontend test files: 92 tests passed, including shared scheduling presets, late-night Today behavior, save-state feedback, immediate card completion, guide-depth changes, keyboard footer handling, date-only preservation, reminder timestamp preservation and declined schedule removal.
- TypeScript, changed JavaScript syntax and whitespace checks passed.
- Sandbox candidate UI checked against the real sandbox API: web preset scheduling, phone exact-task links, visible action bar, unsaved state, three-step brief mode, draft preservation, cross-device edits, completion/reopening, nonduplicating rescheduling, Manila timestamps, guide search and unscheduling without note deletion.
- Light/dark phone screenshots were inspected at 390px. Visual review found and fixed stacked Save/Cancel buttons and the floating-action overlap. The final clean browser run had no runtime exceptions or horizontal overflow.
- Test records were disposable and only those records were removed. The real tenant was untouched.

Keyboard adjustment was exercised through viewport tests, not a physical-phone keyboard. Actual push delivery to a locked device remains outside this UX pass. These results do not certify the remaining operational modules, which will be reviewed separately after the owner checks this update.
