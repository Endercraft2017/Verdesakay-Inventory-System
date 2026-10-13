# Editor settings follow-up — 13 October 2026

Fixed canvas resize controls painting above Advanced, refined the Page & print ribbon,
integrated the new header Linked forms workflow, and themed desktop native options and
editor settings checkboxes. Existing form-scoped backend authorization remains authoritative.

Playwright ran against the actual authenticated application and a disposable SQLite database:
19 workflows passed, including overlap hit-testing, 1440/1024/390px layout checks,
link/alternative/default/unlink persistence, editing/history, variables, tables, images,
review, export/import, proportional grid PDF, save/reopen and multipage grids. No runtime
page errors. Screenshots reviewed in dark mode; opened native font dropdown and option colors verified.
OS-owned dropdown decoration may vary by platform; this check uses Chromium on Linux.

TypeScript check passed. Focused form-linking, form-builder and editor regression results
passed: 156 tests after integration, plus 45 command tests after the Admin permission
regression and mock type corrections. Typecheck passed on the combined version.

After integrating the concurrent Guide Center changes, typecheck and 60 command/guide
regressions passed. The full 19-workflow audit passed again, including a delayed-room
response run. Two runs intermittently stopped at Save (one showed a shared-edit conflict);
the warning did not reproduce with synchronization diagnostics enabled. This shared-save
issue remains unresolved; no change to collaboration or overwrite behavior is included.
The tests do not establish that every app workflow is free of defects.
