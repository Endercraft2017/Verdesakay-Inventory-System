# Production recording audit

**Branch:** `restructure/module-architecture`. **Scope:** accepted parts kit → bulk or serialized output → scrap, line issues, pause/resume and early close. Mobile code is owned separately; the actionable phone findings are at the top of `MOBILE-INVENTORY-HANDOFF.md`.

## Workflow and stock boundaries

The warehouse parts slip deducts components before production begins. The line lead must accept that kit before new output. Recording bulk output or an individual serialized unit consumes the kit's allocated component quantities and marks the job in progress; it does **not** add finished inventory. Serialized output needs an identifier and photo in one transaction and waits for QC/QA. Bulk output waits for Products In. Pausing changes the job state but moves no stock. Early close returns unused allocated components and closes unresolved work.

## Findings fixed

| Risk | Change |
|---|---|
| A desktop upload of several units stopped halfway, then a retry sent previously saved rows again. A lost response could create a second unit. | Each row now carries a stable retry key, confirmed rows lock immediately, and retries send only unconfirmed rows. An uncertain row retains its exact input and retry key. The shared desktop API accepts upload options so multipart requests can send that key. Integration coverage proves same-key replay creates one unit, one photo and one component consumption; a browser test covers partial success followed by retry. |
| Bulk and scrap quantity fields silently truncated fractional input. | Desktop now rejects non-whole or negative input instead of posting a smaller quantity. The unit counter is bounded to the current unrecorded quantity and a safe per-attempt maximum. |
| Desktop lacked a visible production issue workflow inside the job order. A production manager could pause a line but could not manage a worker's issue through the API. | The job detail now shows issue status, severity, description, reporter and resolution, and offers report/edit/resolve/reopen actions. `production.manage` can file issues and manage another worker's issue. Copy explains that an issue is a record, while pause is the action that stops work. |
| A job could show remaining quantity without subtracting units still awaiting inspection, in repair or on hold. | Desktop labels and computes **Still to record** from ordered quantity minus done, scrap and unresolved units, matching the server's overage check. |
| A successful local PC save could be labeled simply “Done.” | Production actions and unit rows now state **Saved on this PC — confirmation pending** when the shared API reports a local sync command. |

## Follow-up and decisions

- The mobile production board still has uncertain-outcome and retry gaps, truncated quantities, a misleading remaining count, and no full issue-management path. Its owner has concrete API and UI acceptance cases in `MOBILE-INVENTORY-HANDOFF.md`; no mobile source changed here.
- An open kit or line issue currently does not automatically block acceptance or recording. If a blocking hold is desired, define who can clear it and how the warehouse corrects the physical kit before adding a gate. The UI now states the actual rule.
- A manually overridden component total can diverge from per-unit consumption after the job quantity changes. The planning contract still needs a product decision: proportional scaling, a fixed total, or mandatory re-entry. Changing it without a migration and review risks altering existing jobs.
- The desktop issue panel records and resolves issues, but it does not yet attach issue photos. The separate attachment API supports `production_issue` photos; a later evidence-focused UI pass should add camera/file capture and a clear partial-upload result. QC evidence rules remain separate.

## Verification

Focused tests cover replay of multipart unit creation and bulk output, production-manager issue authority, and desktop partial-upload retry behavior. TypeScript and JavaScript syntax checks passed. The pre-rebase full `npm run check` passed with 242 files and 2,530 tests. After rebasing onto six incoming commits, the full run passed 245 files and 2,546 tests, with one unrelated HR payslip assertion failing. The identical assertion fails on the incoming branch without this commit (`tests/payslip-owner-rename.test.ts:75`: two payslips returned where the test expects one). A browser-level narrow-screen review of the new desktop issue dialog remains for the next visual pass.
