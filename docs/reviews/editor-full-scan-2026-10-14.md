# Editor full scan — 14 October 2026 (Asia/Manila)

The earlier “shared-save warning is still unresolved” referred to an intermittent
“Resolve overlapping edits in Shared before saving” message in a single-editor browser
session. It was a recorded test finding, not a statement that all saves failed.

## Diagnosed and fixed

Two deterministic single-session cases reproduced the same warning:

1. Save read the room outside the background queue; a heartbeat could publish a newer
   version while that read was pending. A later local edit made the stale response look
   like an overlapping peer edit. Save, background polling and explicit Shared actions
   now share a queue, and older room versions cannot roll back client state.
2. A successful shared write response was discarded if composition or a page resize
   began while it was in flight. The next room read mistook our own write for a peer.
   The response is now retained and reconciled after the interaction, using its sent
   snapshot as the merge base. This preserves newer local input and independent peer blocks.

Regression tests failed before the relevant fixes and pass afterward. Real overlapping
peer edits still block publication and preserve local text. Existing server version/revision
checks remain unchanged. The exact historic intermittent occurrence was not captured;
these are reproduced causes of the same warning, not proof of every possible network case.

Further scan findings fixed:

- Empty-document/page-size validation now releases the shared-sync pause after Save rejection.
- Opening Picture settings no longer dispatches a synthetic edit that falsely prompts to
  discard changes on Cancel. Actual changes remain protected and cancel does not apply them.
- Image URL/upload, link and column-width controls have associated visible labels.
- Variable/formula search has an explicit accessible name; formula entry uses a real label.
- Formula examples use shared surface/success tokens for sufficient contrast and dark theme.
- Section background uses the full color-swatch sizing already used by other editor pickers.
- Transient “Make movable” chrome dismisses when focus leaves the canvas, preventing a
  stale toolbar from intercepting image selection after a narrow-viewport/tool transition.
  Focusing its own action keeps it available; saved content and undo are unchanged.

## Validation

The final unfiltered strict browser gate passed **79 WCAG A/AA scans with zero automated
violations, nine task checks, and zero runtime/task errors**. Its Save test repeats three
real saves under delayed room polling, verifies backend text and reopens the saved template.
The separate browser workflow audit passed all **20 workflows** after the sync-race fixes.

Typecheck passed. The final focused editor regressions passed **115 tests**; backend/form
and rebased production payroll checks passed another **28 tests**. The wider suite completed
with **2,461 passed and one tenant-migration timeout** under concurrent browser load; that
unchanged test passed on an isolated rerun (14.38 seconds). Its timeout limit was not changed.
The release preserves the newer production HR/mobile commits; post-rebase gates passed.

Temporary artifacts, fake credentials and disposable app data stay in ignored work/;
no production records are edited.

The expanded permanent runner scans all ten desktop panels and ribbons in both themes,
phone ribbons, basic dialogs/table toolbar, advanced image/link/symbol/variable/formula,
picture/paragraph/style/section dialogs and Find at desktop/phone widths in both themes.
It also repeats real template saves with delayed shared polling and checks persisted content
and clean reopen. The separate actual-app workflow audit covers keyboard editing/undo,
variable deletion/copy/insertion, table/picture/shape editing, tracked edits, form linking,
HTML/Word export and conversion preview, proportional grid fitting/gaps/PDF, save/reopen,
multiple design pages and responsive light/dark UI.

## Remaining follow-up

Manual screenshots and existing focus/pointer workflows were reviewed. Axe incomplete
contrast results remain visible for manual judgment; no rules or violations are suppressed.
Axe does not establish screen-reader usability or universal usability of authored content.
Physical-device IME/touch and screen-reader task sessions are still worthwhile. A fuller
keyboard navigation model for the ribbon is a separate improvement; native Tab access
remains available. None of this claims full Word/Canva feature parity or WCAG certification.
