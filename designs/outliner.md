# Outliner Design Architecture

## Boundary

The outliner is Neoseq's primary writing and structural reading surface. It owns
the relationship between page material, block text, bullets, indentation,
branches, selection, Markdown projection, and the append target. Properties and
queries may appear within it but retain their own design boundaries.

## Page and Outline Hierarchy

A page is the root of its outline, not its first block. Page-owned material uses
the page edge; block writing uses an inset text edge, with bullets and branches
hanging between them. The page title, notes, and page properties therefore read
as context for the tree rather than unmarked outline rows.
Page and tag titles are larger than the first Markdown heading level.
An explicitly added page query sits between page metadata and the outline,
using the same managed answer surface as a tag query.

The content measure is wider than a prose column because each nested level spends
part of it on indentation. Page names wrap and remain fully readable; they are
not constrained to a single-line field. On compact journals the date owns the
full measure and navigation sits beneath it, avoiding fragments beside controls.
Journal date selection opens a visible field and the shared day calendar. Typing
a date is a draft until submitted; selecting a calendar day navigates directly.
Cancellation leaves the current day unchanged. Day navigation restores its
invoking control after the destination arrives, including newly created days.

## Blocks and Editing

The bullet is the block's handle: it focuses, exposes contextual actions, and
starts structural drag. Its hit area is larger than its resting mark and becomes
visible under intent. The native text editor is the row's single tab stop.
Bullets, collapse controls, and branch joins align with the first rendered line,
including headings that wrap or precede additional content.

Editing, structural selection, and the caret have separate state. A focused row
does not receive a decorative fill; the caret and branch already identify the
active writing position. Empty lines remain visible through a quiet bullet.

The region below the last block is an active append surface. No form or status
chrome may occupy it. Before the first block, a localized writing action is
visible on the same text axis as the block it creates. A quiet hint introduces
commands and page links, and disappears with that action when writing starts.
A second content body may follow only after the append surface has retained
enough reach to invite continued writing.

Incoming links appear in a collapsible Linked references section after the
writing and any standing queries. Each reference identifies its source place
and opens the source block or page. Empty reference sets add no chrome.

## Structural Thread

Quiet guides show indentation columns a row passes. A stronger accent branch
shows the path from the page root to the caret: it descends through ancestors,
turns toward each next block, and ends at the active row.

The branch appears only on rows and segments that participate in the live path.
Drawing an elbow beside every bullet or relighting completed columns would turn a
location signal into wallpaper. Bullets and collapse controls touched by the live
path inherit its emphasis; unrelated structure stays quiet.

The visual thread must survive row virtualization without adding structural DOM
that changes tree semantics. Collapsed blocks retain a distinct mark without
leaving a misleading descending line.

## Markdown Projection

Rendered Markdown is a projection of the block, never a second editable object.
Pressing prose returns to the corresponding source position; following a link is
an explicit link action. The projection owns the row's tab stop while visible and
hands it back to the editor during editing.

Markdown uses the product's type and depth language. Raw HTML and remote images
do not render. Headings express hierarchy without full-width rules, and query
cells use a compact phrasing projection rather than nesting block structures
inside an interactive cell.

## Selection and Structural Operations

Caret selection and block-range selection do not coexist. A block selection is a
continuous ribbon over visible row ranges; descendants moved with a selected
ancestor are passengers rather than independently selected roots.

Bulk operations resolve against the visible outline, preserve structural
invariants, and become one undoable intent. Copy produces portable Markdown.
Drag previews the destination with a seam and keeps the list fixed until commit;
keyboard movement offers the same reordering semantics.

## Virtualization and Stability

Virtualization is an implementation detail that must not change the perceived
tree. Focus, selection, branch continuity, and contextual targets are keyed by
stable block identity. Authoritative refreshes preserve the caret and scroll a
focused row only when it is no longer visible.
An ordinary writing row is fully revealed; a block taller than the viewport
retains its visible reading position. Navigation to an unmounted row uses the
outline's position, because the page may contain an append area or other material
after the tree.

Dynamic Markdown, property content, and available editor width may change row
height. Native inputs remeasure wrapping on width changes without replacing the
input node or its selection. Measurement may
update after render, but it must not align an already visible caret to a new
viewport position merely because its row grew. A visibility scroll belongs to
the focus arrival that requested it and cannot reassert itself after focus
leaves or the reader scrolls elsewhere.

Input and semantic requirements follow [Accessibility](accessibility.md), and
shared drag and control behavior follows [Interaction](interaction.md).
