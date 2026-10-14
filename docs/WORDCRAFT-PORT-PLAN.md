# Wordcraft port into the existing document studio

## Objective and scope

Port useful Wordcraft behavior into our vanilla JavaScript editor and TypeScript/Express
system, incrementally. Keep SQLite, existing template HTML, form/default assignments,
permissions, revision checks, offline behavior, field tokens and grid printing. This is a
multi-phase implementation, not a claim of full Word or Canva parity or a Rust/WASM embed.

Source reference: https://github.com/storytold/wordcraft at
`d8940cb317aee9ee9d8921d878c1c2f2329baf42` (reviewed 2026-10-12).
`crates/engine/src/lib.rs` supplies the command registry reference;
`crates/engine/src/session.rs` supplies the reference behavior for selection-aware undo,
typing groups and command boundaries. Its document, layout and format crates are references
for later phases. Upstream is alpha: validate behavior ourselves, especially DOCX and layout.
Use MIT licensing for any translated/copied source and retain its copyright/license notice.
Do not import upstream branding or bundled assets without their individual license review.
The initial browser-history adaptation is independently implemented against our DOM model.

## Delivery rules

- Work in phase order. Record delivered slices and unresolved items here on every handoff.
- Finish and verify a slice before adding controls for the next capability.
- Keep existing HTML readable and reversible; new document models need lossless adapters
  and fixture-based migration checks before replacing the current saved representation.
- Keep UI in our existing components/tokens; no React, Tailwind or Rust runtime conversion.
- Multipage designs must never enable grid/continuous printing, in UI or backend.
- Verify keyboard, caret, undo/redo, save/reopen and print behavior with real browser input.
- Shared publication must still use current permissions and revision/conflict protection.
- A shipped slice is not completion of its entire phase. No full-parity claims.

## Phases and acceptance gates

| Phase | Work | Acceptance gate | Status |
|---|---|---|---|
| 1. Editing foundation | Selection bookmarks, input transactions, composition safety, command dispatch, shortcuts, reliable clipboard and list editing | Undo/redo restores content and selection; unrelated edits are separate; IME creates one edit; chips survive; browser and regression checks pass | Editing foundation verified; model work underway |
| 2. Document model and formatting | Typed blocks/runs, styles and inheritance, semantic positions, HTML adapters, progressively replace execCommand | Existing template corpus round-trips without lost fields/styles; commands work without DOM-dependent state | In progress: selected text ranges and inline formatting |
| 3. Tables and page layout | Word-style cell/row/column commands, split/merge, repeat headers, sizing, section/page flow, wrapping and running content | Table and section fixtures match preview/print; no lost rows, extra blank sheets or multipage grids | Planned |
| 4. Review and references | Structural/format revisions, comments anchored to model positions, footnotes/endnotes, references and contents | Accept/reject and undo preserve structure; references survive save/reopen and print | Planned |
| 5. Document interoperability | DOCX model mapping and round-trip corpus; explicit unsupported-feature preservation/reporting | Real Word/Docs/LibreOffice fixtures inspected for content and page fidelity; originals recoverable | Planned |
| 6. Design tools and hardening | Model-backed objects/layers, accessible keyboard workflows, performance, mobile input and release audit | Representative long docs and mixed designs pass save/print/device checks with documented limits | Planned |

## Phase 1 slices

1. Selection-aware history and explicit edit boundaries; native undo input routing;
   defer DOM normalization during composition. **Completed and verified.**
2. Central command registry (enabled/active state, keyboard and toolbar dispatch), migrate
   formatting commands incrementally; predictable focus after dialogs. **Completed slice.**
3. Clipboard transactions and model-ready text/list commands; cover Enter/Tab, deletion at
   boundaries, atomic tokens, selection direction and accessible navigation. **Implemented.**
4. Consolidate acceptance fixtures and hand off to phase 2. Composition with tracked
   revisions remains unsupported until the tracking implementation can preserve it safely.

## Current verification and handoff

Baseline: production commit `37e6dea`, HTML snapshot history, browser execCommand formatting,
paragraph-only tracked changes. This foundation release is being integrated into the
production branch; record the commit and deployment result at release.
Tests/results and exact remaining next action are recorded here after the slice is verified.

### Phase 1, slice 1 — implementation record

Implemented locally:
- Selection bookmarks preserve anchor/focus direction, adjacent text-node normalization,
  empty cells and positions around field chips across HTML snapshot restoration.
- Input kinds and caret movement delimit undo groups; toolbar activation and paste create
  boundaries. Native history input and keyboard shortcuts use editor history. Undo is
  available immediately after the first edit and redo clears after branching edits.
- Composition defers normalization, autocomplete and shared snapshot reconciliation;
  committed text forms one undo step. In-flight room responses are reconciled later.
- Undo refreshes word count and schedules shared recovery, preserving the publication path.
- Mobile shell cache bumped for the shared editor asset changes; no mobile visual redesign.

Verified: real Chromium replacement typing, backwards selection restoration, redo caret,
Japanese IME via the browser composition API, and saving through the shared form/template
API. Existing browser checks also verify two-page preview/PDF, section sizes, contents
page numbers, tracked text, disabled multipage grids and Save at a narrow viewport.
Focused regression tests include composition-time server responses and immediate Undo.
Full-suite result: 2,203 tests passed across 213 files; typecheck passed.

Follow-on action at the slice-1 checkpoint: phase 1, slice 2, command and dialog dispatch
(now implemented below). Do not begin the block/run model migration until phase 1's
clipboard/list behavior is verified. No WASM runtime, schema changes or production
rollout are part of this slice. Upstream source is a pinned behavioral reference; no
upstream assets or translated Rust code have been bundled in this slice.

### Phase 1, slice 2 — completed and verified

Current task: central command dispatch for toolbar/keyboard formatting, enabled/active
state and selection preservation across controls/dialogs. Retain the browser formatting
adapter until phase 2 replaces commands incrementally with the document model.


Slice-2 implementation:
- Stable command identifiers wrap the current browser formatting adapter: inline styles,
  paragraph/list formatting, font/size/color, link/HTML insertion and undo/redo.
- Toolbar and Ctrl/Cmd+B/I/U share command dispatch. Browser undo input and Ctrl/Cmd+Z/Y
  use registered history commands; availability follows the actual history stack.
- Commands capture/restore backwards selections across focus changes and refuse locked
  selections. Editable text islands inside floating objects remain format-capable.
- Toolbar formatting buttons publish active state through `aria-pressed`.
- Insert/link/paragraph dialogs restore document focus on confirmation/cancellation.
  Failed browser commands do not report successful edits.

Verification: seven focused command tests; existing editor regression tests; real Chromium
Ctrl+B with undo/redo, font changes, link selection/focus and immediate typing after the
dialog, shared save, plus the unchanged multipage print/grid/browser checks.
Full-suite result: 2,210 tests passed across 214 files; typecheck passed.

Next action: **phase 1, slice 3**, clipboard and list transactions (Enter/Tab, boundary
deletion, atomic field tokens and accessible navigation). Document-model migration is
still phase 2 and must preserve existing template HTML and bindings.


### Phase 1, slice 3 — clipboard and keyboard editing

- Copy writes canonical template HTML and plain `{{field}}` tokens; paste rebuilds atomic
  field chips, sanitizes rich HTML and treats ordinary plain text as text.
- Cut uses the command transaction and refuses selections crossing locked content.
  Tracked text cut/paste remains owned by the existing review input handlers.
- Tab/Shift+Tab changes list nesting. Native Enter continues lists and exits empty items;
  paragraph input creates its own undo boundary. Composition and review guards remain.
- Table Tab traverses physical cells once (including merged spans), skips locked cells,
  and adds a data row at the end with the logical column width. Header-only tables gain
  a body row. Row creation and its resulting caret are undoable together.
- Arrow movement and Backspace/Delete treat adjacent field chips and checkboxes atomically.
  Tracked structural/token edits remain blocked until the revision-model phase.

Verified in Chromium: canonical copy/paste and whole-token cut/undo, native list Enter and
empty-item exit, Tab nesting/outdent, merged-cell table navigation/new row, shared save.
Previously verified command, IME and print checks were rerun on the latest production code.
Newer production security patches and side-panel changes are retained. Browser fixtures and
collaboration fixtures use valid test passwords under the stronger password policy.
Release checks: full run passed 2,223 tests with one stale password-minimum assertion
from production. The assertion now matches the eight-character policy; all 38 tests in
the affected unit/editor/collaboration files pass on rerun, including the additional
atomic-token caret regression. Typecheck and all four browser checks pass. Mobile
shared-asset cache version: v75. Delivery target: restructure/module-architecture.

Next: phase 1 acceptance consolidation, then phase 2's typed block/run model and lossless
HTML adapters. Keep existing design pages, tables and template bindings covered by fixtures.
Do not describe this release as a full Wordcraft engine conversion.

Final integration also preserves the newer personal checklist/scheduling and HR-warning
changes on production; the editor model and storage schema are unchanged by this port.

Final integration check: typecheck passes and all 74 tests across the seven affected
editor/collaboration, notes, HR, sync and unit files pass.


### Phase 1 acceptance handoff

Existing acceptance fixtures now cover selection-aware history, composition, command and
modal focus, clipboard tokens, list/table keyboard editing, locking, shared save and print.
Phase 1's browser foundation is verified. Composition with tracked changes and structural
tracking remain explicitly deferred to the review/model phases.

### Phase 2, slice 1 — model and HTML preservation foundation

New module: `public/js/doc-model.js`, loaded before the editor on desktop.
- Versioned document nodes classify paragraphs, runs, fields, lists, tables/cells, pages,
  sections and images. Unknown elements/attributes and non-HTML namespaces remain present;
  SVG is opaque until supported object commands arrive.
- Canonical HTML import/export preserves field/control tokens, row loops, image bindings,
  styles, sections, design pages, revisions and notes. Temporary field markers avoid HTML
  table foster-parenting and are never retained in model data or output.
- Editor capture converts chips/repeat rows to bindings and excludes editor-only controls.
  DOM references/path maps are ephemeral and never enter the saved document representation.
- Pure paragraph alignment produces a new model plus changed attributes; the live adapter
  patches those attributes in place, preserving text nodes, chips and selection direction.
  Left/center/right/justify commands and their active state use this model for supported
  paragraph blocks. Existing history, shared save and publication remain the same pipeline.
- A selection ending at the next paragraph's first text position does not format that
  otherwise unselected paragraph. Locked ancestors are rejected before any live patch.

Verification: all seeded template field/control sequences survive the adapters; conversions
are idempotent. Fixtures cover quotes in attributes, CSS URL semicolons, opaque SVG fields,
unknown comments/attributes, repeat rows, revisions, merged cells, sections and design pages.
Chromium runs alignment with native alignment deliberately disabled, preserving backwards
selection/fields and undo/redo, then saves through the real API. Existing print checks pass.
Full regression: 2,240 tests passed; one stale generated-type ordering mismatch from
the checklist schema was corrected with db:types. All 24 affected model/editor/corpus
and database-type tests pass on rerun. Typecheck and model/print browser checks pass.

Limits: preservation is after standard HTML parsing/serialization, not byte-for-byte source
formatting. HTML remains the persistence and history contract. The model is captured at
command boundaries; it does not yet own typing, layout, or the full editing session. Other
formatting commands still use the isolated browser adapter, and freeform text without a
paragraph block retains that adapter. No database migration or Rust/WASM runtime is added.

Next: phase 2, slice 2 — explicit text positions/ranges, run formatting and inheritance,
then move inline-formatting commands onto model operations without dropping existing markup.


### Phase 2, slice 2 — selected text ranges and inline formatting

Implemented:
- Explicit structural text positions/ranges with UTF-16 offsets, ordering and validation.
  Invalid positions, values and surrogate-splitting endpoints are refused before changes.
- Pure immutable range formatting creates selected runs and retains surrounding elements,
  links, review metadata, field/control tokens and opaque content. Locks are enforced.
- Live formatting uses temporary boundary bookmarks, then restores selection direction
  and removes every bookmark. Only selected text is split/wrapped; unrelated DOM stays.
- Selected bold, italic, font family, point size, text color and highlight commands use
  the model. Fully selected owned runs are reused across successive formats/toggles.
  Active bold/italic state resolves inherited browser CSS.
- Hidden/deleted review text, derived contents/note numbers, field chips, checkboxes and
  opaque SVG remain untouched. The selectable text around these atoms is formatted.
- Existing undo, drafts, shared publication, clipboard and conversion remain HTML-backed.
  Run metadata survives sanitized paste, and typing after formatting uses the restored range.
- Word export now respects explicit normal bold/italic overrides and text highlights.
  Formatted revision text is emitted as attributed Word runs; rejecting a deletion does
  not leave a permanent strikethrough from the revision's HTML del tag.

Verification: immutable/model tests cover partial/backwards ranges, inherited overrides,
links/revisions/fields, repeated formatting, locks, hidden/opaque content and Unicode.
Chromium disables the corresponding native commands and verifies bold/italic/font/size/
color, selection, subsequent typing, shared save, clipboard and the existing print/grid
checks. Full suite: 2,253 tests passed. Export follow-up checks: 43 tests passed; typecheck
passed. Seeded-template adapters and existing editor/conversion fixtures remain covered.

Limits and next slice:
- The model currently owns noncollapsed selected-text formatting. Collapsed-caret pending
  formatting remains on the browser adapter until explicit pending marks and model-backed
  typing are implemented.
- Underline/strike, super/subscript and Clear Formatting remain on the browser adapter;
  inherited decoration removal needs structural/run handling, not a misleading CSS reset.
- Field/derived-object formatting is atomic/preserved; applying marks to those atoms is a
  later operation. This slice does not claim full inline-formatting or document-engine parity.

Next: phase 2, slice 3 — pending marks and selected-run normalization, atomic-field marks,
then inherited decoration handling and model-owned insertion/deletion commands.

### Phase 2, slice 3 — caret marks, atomic fields and inline decorations

Implemented:
- Bold/italic, font family, point size, text color and highlight choices at a caret are
  explicit, ephemeral editor marks. Choosing them changes toolbar state without changing
  saved HTML, dirty status or undo history. Moving the caret/selection, restoring history,
  changing editor modes and replacing the document clear these marks.
- Ordinary marked typing uses an owned text-insertion operation, rather than browser
  pending formatting. Identical adjacent/nested owned runs are coalesced without losing
  the caret, attributes or field nodes. Marked runs preserve typed spacing through saved
  white-space styling. The inserted text and formatting undo together.
- Composition stays native until commit. Committed text is resolved backwards from the
  final caret across inline boundaries, then marked once. Intermediate composition
  selections do not clear the marks. Existing revision-aware typing retains its handler
  and attribution; only the newly inserted text receives pending marks.
- Field positions use atomic offsets 0/1. Whole selected field/formula chips receive a
  surrounding owned run, retaining their actual DOM node and canonical raw binding.
  Mixed text/field selections format both. Control tokens, derived objects, hidden content,
  review deletions and opaque SVG remain protected. Styled chips display inherited marks.
- Selected underline/strike use owned runs. Removing inherited inline decorations splits
  the affected wrappers and removes their own paint only around selected content, rather
  than trying to cancel an ancestor with a child CSS reset. Other decorations, surrounding
  text, link attributes, review attribution and field identity remain; split clones do not
  duplicate element ids or block ids. Default hyperlink underlines are supported.
- Paste retains text-decoration-line; Word export recognizes that property, including
  formatted field bindings and revisions. No schema/runtime/dependency change is added.

Verification: model/command/composition/template-corpus/Word-export tests cover partial and
backwards ranges, atomic identity, locks, combined decorations, unchanged content/history
when choosing caret marks, committed composition, and formatting with undo/redo. Chromium
checks disable native inline commands, then verify marked typing/run normalization, IME,
tracked typing, whole fields, partial inherited decorations and real shared API saves.
Existing measured multipage/grid printing remains in the release acceptance set.

Limits: HTML snapshots remain authoritative. Structural decoration removal is a bounded
live adapter, not yet an immutable full-tree rewrite. Block-level decoration removal,
collapsed-caret underline/strike, superscript/subscript and Clear Formatting retain the
browser adapter. Unmarked typing, paragraph structure, general deletion and replacement
are not yet owned by the document model. Composition with tracking remains unsupported.

Next: phase 2, slice 4 — model-owned general text insertion/deletion and selection
replacement, caret decorations/clear formatting, and broader run normalization. Complete
phase 2 acceptance before starting the table/page-layout phase.

Release verification: TypeScript passes. The integrated full suite passed 2,280 tests;
its only failure was the newly added cloud owner-password route missing its documented
sync-audit exception. That exception is corrected, and all 31 sync-audit/owner-console/MFA
checks pass on rerun. Final model/editor/reliability checks: 71 tests pass. Chromium editor
and measured-print checks pass with the incoming password-change policy enabled.

### Phase 2, slice 4 — paragraph text transactions and remaining caret formats

Implemented:
- A bounded text-edit operation replaces selections within a paragraph/text island,
  including backwards selections across inline wrappers and whole field chips. It retains
  unaffected live nodes, attributes, bindings and review metadata. Plain-text insertion
  and selected Cut share this path. Paragraph/cell/page transitions delegate structurally.
- Untracked insertText/insertReplacementText and normal backward/forward deletion route
  through that operation at beforeinput, using the existing history boundaries. Deletion
  uses Unicode grapheme segmentation across inline boundaries, including emoji sequences;
  fields remain one atom. Protected/control/derived/hidden/deleted-review/opaque content
  cannot be skipped or removed accidentally. Locked selections are checked before native
  structural delegation too. IME remains native until commit; tracked edits keep their
  revision handler and attribution.
- Caret underline/strike, superscript/subscript and Clear Formatting are ephemeral choices.
  New text receives them in its insertion transaction. Switching scripts or removing them
  isolates the affected inline wrappers, preserving the other text and marks. Clearing
  character formatting restores the containing paragraph's font defaults, keeps paragraph
  layout, links and revision attribution, and updates pending toolbar state.
- Selected script toggles and within-paragraph Clear Formatting use the same isolated-run
  helpers. Endpoint bookmarks capture the start before inserting the end marker, fixing
  element-boundary selection drift during successive formatting commands.
- Run normalization unwraps before merging, coalesces matching span/sup/sub runs, preserves
  attributes/atoms/caret, and limits typing-time scans to the containing text block.
- Word export makes super/sub mutually exclusive and recognizes explicit baseline resets.
  Transparent character defaults do not become Word highlights. No schema/dependency change.

Limits: these are bounded live model adapters; HTML still owns persistence/history, not a
fully immutable authoritative editing session. Paragraph breaks/joins, multiline insertion,
selection edits across structural boundaries and multi-paragraph Clear Formatting retain
native handling. Multi-paragraph clearing deliberately avoids flattening each paragraph's
font/heading defaults. Block-level decoration removal remains outside inline projection.
Composition with tracked changes remains unsupported. Tables/pages and review continue
through their existing specialized commands.

Next: phase 2, slice 5 — paragraph breaks/joins, multi-paragraph replacement and per-paragraph
character resets, followed by broader model acceptance before the table/page-layout phase.

Slice-4 release verification: TypeScript and the complete integrated suite pass — 2,309
tests across 224 files. Chromium verifies paragraph replacement/deletion with native text
commands disabled, caret underline/script/clear choices, repeated-script run coalescing,
undo/redo, IME, tracked attribution and shared saves. Clipboard fields, atomic deletion,
list Enter/Tab, merged-table Tab/row insertion and ordinary composition also pass. Measured
print checks preserve independent design pages/backgrounds, exact page counts, section
sizes, contents-page references, multipage grid guards and mobile Save visibility.

### UI usability pass after slice 4

User priority temporarily moves to editor clarity before paragraph-engine work resumes.
The header now holds the editable document name and primary actions, with secondary metadata
under Settings and source/other advanced actions grouped. Text, Insert and Page & print
replace ambiguous ribbon naming. The labelled tool rail opens one inspector panel on demand;
it starts closed, rather than presenting ten panel tabs beside the document. Print preview
uses a focused view. Common text tools stay visible, with character effects in a menu.
Font/style/point-size readouts follow the selection (including mixed/custom values), field
labels do not masquerade as their document font, and inspector sizes use points too.
Fit-to-width and footer zoom make the initial page visible on phones; phone controls wrap.
Keyboard navigation, menu Escape, source-mode access and direct Help remain accessible.
Find/replace now mounts before the workspace instead of attempting to insert beside a
nested canvas. Its Advanced entry and responsive bar preserve phone access.
The next engine step remains slice 5; this pass does not advance that phase.

UI release verification: TypeScript and the integrated full suite pass — 2,322 tests across
224 files. Final command/reliability checks pass (57 tests). Chromium covers desktop/phone
layout, on-demand inspector, settings, native-menu Escape, actual CodeMirror source access,
repaired Find, footer zoom, visible Save/common formatting and measured preview navigation.
Existing editing/IME/field/shared-save and measured multipage/grid/section/mobile-print
checks pass. UI visibility/navigation remain separate from saved document content.

### Wordcraft layout familiarization — 14 October 2026

Reviewed Wordcraft's current hero screenshot and ribbon source at
`159b84f54c74e9e82fb3109b758ae7dd6f4e3ab0`. Adapted its familiar Home/Insert/Layout hierarchy,
with distinct Font/Paragraph/Styles/Editing groups, rather than importing Rust/egui code or
changing our design tokens. Document/design tools and template automation have labeled
sidebar groups; fields/formulas, form links and print grids no longer compete with normal
writing controls in the header/ribbon. Grid settings remain usable in measured preview.
This is UI organization; the engine's next step remains phase 2 slice 5. See the layout
review under `docs/reviews/editor-layout-wordcraft-2026-10-14.md` for validation and limits.

### Common Word ribbon commands — 14 October 2026

Using the same Wordcraft ribbon reference, Home adds Clipboard, font-size steps, direct Clear
formatting, Replace and Select all; Insert adds Header/Footer/Page number entry points.
Commands reuse our selection/model/history/paste/print pipelines. Clipboard errors and async
selection changes preserve content. Header/footer insertion no longer replaces selected writing.
Compact groups and themed custom select arrows retain the app design convention.
This is a ribbon usability slice; phase 2 slice 5 and broader Word feature parity remain pending.
See `docs/reviews/editor-common-ribbon-2026-10-14.md` for checks and browser clipboard limits.


### Ribbon density correction — 14 October 2026
Wide desktop Home uses one horizontal command row with accessible clipboard/editing icons. Sidebar dropdown arrows survive later background resets; Text styles and heading descriptions explain their purpose. This remains UI refinement; engine phase 2 slice 5 is unchanged.

### Heading/style discoverability — 14 October 2026
The compact ribbon uses role-based heading labels; Style gallery provides previews, purpose descriptions and separate edit actions. Existing paragraph/style commands, outline semantics and stored templates are preserved. This is UI guidance; phase 2 slice 5 is unchanged.

### Company header divider — 14 October 2026
Direct header-edge selection and Inspect controls expose border removal, width, style and color while preserving company fields. Locked ancestors, Undo and saved/reopened border properties are verified. Existing templates keep their letterhead layout; phase 2 slice 5 remains pending.
