# Data Forms and payroll acceptance walkthrough

Use a test workspace and representative HR accounts. Record the reviewer, date, result,
and any issue for each task. Automated browser checks supplement this review.

1. Find a form from Documents → Data Forms and its section shortcut. Favorite it,
   reopen it from Favorites and Recent forms, choose columns, and save a filtered view.
   Confirm these preferences belong only to the signed-in user.
2. Create an entry with missing required fields. Follow an error-summary link, correct
   the inline error, and check required consent. Confirm closing a changed editor warns
   before discarding. Editing an existing entry must preserve its status.
3. Change a form's labels and add a required field. Existing entries must retain their
   original labels and requirements; new entries use the latest version. Open Versions.
4. Archive the form. Confirm new entry/import actions are unavailable and existing
   records and printing layouts remain. Correct a record: saving requires a reason.
   Open Change history and verify old values, new values, actor, date and reason.
   Restore the form and confirm new entries become available again.
5. Open an unpaid payslip as HR. Enter SSS, PhilHealth, Pag-IBIG and withholding tax
   amounts, including zero. Verify preview totals and net pay. A blank amount restores
   automatic calculation. Payroll adjustment reasons are optional on active forms.
   Preview and printing must not save. Save must show its success or error clearly.
6. Reopen and regenerate the payslip. Manual values must remain. Open Deduction history
   and verify amounts, automatic/manual/off modes, actor, date and optional reason.
   Print the final amounts with the usual deduction labels. Employer contributions
   must remain independent of these employee deduction adjustments.
7. Adjust an earlier cutoff with a later cutoff in the same month. Follow the review
   notice and regenerate unpaid later cutoffs in chronological order. Check automatic
   monthly reconciliation and retained manual overrides. Paid slips remain locked.
8. Open the same entry in two sessions. Save one, then attempt to save the other.
   The stale save must fail and explain that the editor needs to reopen.
9. Import a CSV containing valid and invalid rows, including split-rate employees.
   Review rejected rows and download their file. Partial import requires an explicit
   choice. If any rate row is invalid, all rows for that employee are excluded.
   Correct the downloaded file and reimport; verify no missing or duplicated pay.
10. Use a 50-field form with long labels. Test keyboard-only entry, visible focus,
    dialog focus containment/return, scrolling and reachable Save/Close. Review both
    themes at 1440, 1024, 768 and 390 CSS pixels, actual browser zoom at 200%, and a
    screen reader. Employees should see their own drafts clearly labeled as drafts.

## Migration and recovery limits

Existing records receive the form definition available at migration as a legacy baseline.
Definitions that changed before version tracking cannot be reconstructed. Future schema
versions and record revisions are retained. Archiving is the normal retirement action;
the API refuses permanent deletion of forms containing records.

After network/server errors, keep the editor open and retry. A conflict requires reopening
the latest record and reviewing the correction. Rejected imports never silently commit.
