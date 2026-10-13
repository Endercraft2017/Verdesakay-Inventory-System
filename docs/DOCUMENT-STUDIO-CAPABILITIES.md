# Document studio: balanced Word and Canva implementation

The product direction is a balanced document and visual-design editor. Full Word/Canva
parity is not implemented. This inventory separates delivered tools from remaining work.

## Delivered

- Theme-consistent editor chrome, light/dark modes and responsive tools.
- Inline text formatting, headings, lists, paragraph spacing/indentation, find/replace,
  browser spellcheck, document outline and word count.
- Table insertion, row/column editing, merge/split, drag column sizing, equal columns,
  styles, borders, padding, alignment, header rows and row print settings.
- Images, text boxes, basic shapes, object positioning/sizing, rotation, opacity, corner
  radius, snap guides, page alignment, distribution, grouping, layers, locks/visibility.
- Page setup, page breaks, running headers/footers, page numbers, measured pagination,
  print previews, PDF via the browser and configurable grid printing.
- Data fields, repeating rows, conditional content, formulas and real-record preview.
- Local/server recovery, undo/redo, saved history, shared editing, conflict resolution,
  comments and reusable company assets/styles.
- Multiple layouts per form and explicit form/built-in defaults.
- DOCX content import with a conversion preview, append/replace, original-file download,
  undo and conversion notes; DOCX export with supported document formatting and embedded
  raster images. Word layouts are not a lossless representation of freeform HTML designs;
  repeating/conditional template logic requires HTML export for reuse.
- HTML document export and a File-menu shortcut to print/PDF preview.
- Heading-linked contents lists with live title updates, measured print page numbers and
  grid-copy-specific anchors; genuine Word contents fields that refresh in Word.
- Picture crop-to-fill, focal points, circle/ellipse/diamond masks, corner radius,
  brightness/contrast/saturation/grayscale, alternative text and image replacement.

- Explicit visual design pages: add, duplicate, rename, reorder, delete and independent
  backgrounds. Objects move and resize relative to their own page. Multipage designs and
  forced page boundaries disable grids in the editor, validation and legacy print paths.
- Named document styles with shared updates and direct-format overrides, plus hierarchical
  numbered lists. Definitions travel with the template and become Word paragraph styles.
- Sections with columns, gaps, backgrounds, page dimensions, margins and page starts.
  Single-column sections use measured sheets; column sections use native browser pagination.
- Linked numbered notes in the editor; genuine footnotes in Word export.
- Paragraph text revisions with reviewer attribution, accept/reject (individual/all), undo
  and session-opening text comparison. Prints use proposed final text; editable DOCX retains
  revision markup. Structural edits still use undo/history, not tracked revisions.
- Word export includes running headers, footers, page fields and section properties.

## Remaining document capabilities

1. Broader DOCX layout/style fidelity, including running fields, custom CSS, linked images
   and freeform graphics. Current conversion reports its limitations and retains originals.
2. User-created style families, advanced numbering schemas and language-aware typography.
   Named styles, hierarchical lists and measured/Word contents are implemented.
3. Bottom-of-page browser footnotes, endnotes, citations and bibliographies. Editor notes
   are linked at the document end; Word export uses actual footnotes.
4. Structural/formatting revisions, composition-input tracking and detailed saved-version
   comparison. Paragraph text review and block-anchored comments are implemented.
5. Accessible keyboard navigation and richer language-specific spelling tools.

## Remaining design capabilities

1. Mixed-size visual design pages and animation. Explicit pages/backgrounds are implemented.
2. Advanced image-editing handles, additional masks/filters and visible figure captions.
   Basic crop, masks, focal points, replacement, filters and alt text are implemented.
3. Richer shape/vector tools, gradients, shadows and reusable grouped components.
4. Managed image/font uploads with search, licensing metadata and brand governance.
5. Direct PNG/JPEG/SVG/PDF export with selectable resolution and predictable layout.
6. Template collections and locked brand layouts.

## Verification required for each capability

A tool must round-trip through saved templates, copied layouts, undo/redo, drafts, shared
sessions and version history. Design content must match record previews and exported
output. Exercise empty/long content, merged tables, images, narrow screens and both
themes. Larger model changes require migration tests and preservation of existing HTML
templates. Existing basic controls do not establish full compatibility with Word/Canva.

## Wordcraft port: editing foundation

The phased implementation is tracked in `WORDCRAFT-PORT-PLAN.md`. The first slice adds
selection-aware undo/redo (including backwards selections), explicit typing boundaries,
immediate Undo availability and native browser history-input routing. Composition input
is kept in one history transaction with DOM refresh and shared-room replacement deferred
until completion. Normal composition is supported; composition with tracked revisions
remains a documented limitation. This slice retains the HTML model and execCommand;
the model migration remains in phase 2.

The second slice introduces shared command dispatch for inline/paragraph/list formatting,
font/size/color, links/HTML insertion and history. Toolbar and keyboard formatting share
enabled/active state, backwards selections survive control/dialog focus changes, and
insert dialogs return focus to the document. Locked selections refuse commands; editable
text islands within floating objects remain supported. Browser formatting is still the
adapter behind these commands; typed model-backed editing is a later phase.

Clipboard copy preserves canonical field bindings; paste sanitizes rich HTML and rebuilds
atomic field chips. Plain text uses a text command. Cut and adjacent-token deletion use
undoable transactions and respect locked selections. Tab changes list nesting or navigates
table cells (including merged cells), adding a data row at the table's end. Native Enter
continues/exits lists. Tracked structural/token edits remain outside the review scope.

## Document model foundation

A versioned browser model and canonical HTML adapters preserve fields, repeat rows,
unknown HTML, SVG, sections/design pages and review/notes markup. Paragraph alignment
uses immutable model changes and patches live attributes without replacing text/chip nodes.
Existing HTML remains the saved representation. Model-backed typing, inline formatting,
semantic ranges and layout are subsequent slices; this is not a full engine replacement.

Selected bold/italic/font/point size/text color/highlight formatting now uses explicit
model ranges and immutable runs. Selection direction, links, review metadata and atomic
fields are preserved; undo/redo and shared save use the existing HTML contract. Word export
respects normal bold/italic overrides, highlights and formatting within text revisions.
Collapsed-caret pending formats and decoration/structural run commands remain on the
browser adapter until their planned model operations are implemented.

### Caret and field formatting

Choose bold/italic, font, size, color or highlight at the caret, then type: the choice
applies to new text without changing existing content or creating an empty undo step.
Moving the caret clears pending choices. Marked typing and committed composition undo
with their formatting; tracked typing retains its reviewer attribution. Whole selected
field tokens can be formatted without changing their bindings. Selected underline/strike
can be removed from inherited inline wrappers while retaining surrounding formatting.
Block-level and caret underline/strike still use the browser adapter; composition with
tracking, general model-owned deletion and complete Word layout fidelity remain pending.

### Paragraph text commands and caret character tools

Normal typing, replacement and Backspace/Delete within a paragraph use shared text commands.
Unicode graphemes (including combined emoji across formatting) delete as a unit; field tokens
remain atomic and protected/derived content cannot be skipped. Plain-text paste and Cut
use the same selection transaction. Underline, strike, superscript/subscript and Clear
Formatting can be chosen at a caret without changing current content or undo history.
Clear restores paragraph character defaults while retaining its layout and linked fields.
Selected script toggles and paragraph-scoped character clearing preserve other text.
Paragraph breaks/joins, multiline/cross-structure editing, multi-paragraph clearing and
block decoration removal still use existing handlers or remain outside inline projection.

### Simplified editor workspace

Grid tiles preserve the original page layout: each copy lays out at the source paper size
and margins, then scales uniformly into the cell. Fonts, text wrapping, table columns and
floating-object proportions are preserved. Extra space stays blank; the design is never
stretched to fill a differently shaped cell. Grid gaps and multipage restrictions still apply.

The document name lives in the header beside Save. Settings opens document type/period;
advanced source editing, Find and replace and the guide sit under Advanced. Edit and
Print preview are separate modes; Preview data remains the filled-record preview.
The Text, Insert and Page & print tabs organize the ribbon. Less-used character effects
are in More text formatting. Font/style/size readouts follow the selection and show Mixed
when necessary; inspector sizes use points consistently.
Header, tab and toolbar spacing is compact to reserve more height for the document.
Hide ribbon leaves the tabs visible; Show ribbon or selecting a tab restores its controls.
The tool sidebar collapses to icons with accessible labels, and the inspector has a
labelled Collapse button. These controls resize the workspace without changing the template.
Inspector text/background colors use swatch pickers, with No fill for backgrounds. Text
size, line height, padding and spacing use preset dropdowns that preserve existing custom
values; Custom opens an optional precise-value dialog. Opening these controls preserves
existing color transparency and creates no document change.
Clicking a variable chip selects the whole token; Delete/Backspace removes it through
the undo/save pipeline. Starter company/date fields remain optional. Variables opens a
searchable bank of available catalog/custom fields and fields already in the document,
with category filters, Insert at the remembered caret, and Copy of the full {{token}}.
Data blocks and preview tools remain available beneath the bank. Clipboard denial offers
a selected readonly token for manual copy; locked content and review restrictions remain.
A labelled rail opens Inspect, Pages, Layers, Outline, Styles, Variables, Library, Review,
History and Shared on demand. The inspector starts closed and can be dismissed without
losing selection. The page fits available width initially; footer Fit/zoom controls are
always available while editing. Phone formatting wraps without horizontal overflow, and
Save remains visible. Keyboard tab navigation and Escape dismiss menus without closing
the document. The guide and existing form/field, recovery and print tools remain available.
