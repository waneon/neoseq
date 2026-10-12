# Outliner Design Architecture

## Document and Writing Hierarchy

The outliner is the primary writing surface. A document begins with its title,
which wraps across the full measure and is larger than every Markdown heading.
The document's controls live in the top bar, so nothing stands above the title.
Properties appear under the title only when the page has them; otherwise they
are reached from the page menu, the command layer, or `Mod+P`.

A journal day's title is its date. Beside it sit Previous day, the calendar, and
Next day, with Today only while another day is shown; below it a caption states
the day's distance from today. On phones the date leads, then its distance, then
the day controls. The calendar accepts a typed date and a picked day; either
navigates, and cancellation keeps the current day. Navigation restores the
initiating control once its destination arrives.

The document is one reading column with room for nested work. Page metadata and
queries use the page edge; block text sits inside a hanging bullet gutter. Body
writing uses the shared 16px type and line rhythm.

## Editing and Structure

The native text editor owns each row's tab stop. Its bullet is a larger hit target
than its resting mark, supporting focus, contextual actions, and structural drag.
Bullets, fold controls, and branches align with the first rendered line, including
wrapped Markdown headings. A collapsed block retains a quiet halo.

Writing and tags share the vertical center of their content row, including when
the writing wraps. Tags derive their minimum frame from the writing line metric;
task marks follow the first-line center. Metadata beneath writing owns a separate
strip rather than changing either alignment reference.

Indentation is expressed with faint neutral guides. A thinner accent branch traces
the path from ancestors to the caret and ends at its row. Only live path arrivals
get an elbow; unrelated columns remain quiet. This treatment survives
virtualization without structural DOM that would change tree semantics.

Caret position, editing, and structural selection are separate states. Focus does
not add a row fill. Block selection forms a continuous ribbon over the visible
range; descendants traveling with an ancestor are passengers, not extra selected
roots. Copy produces portable Markdown, and structural operations remain one
undoable intent. Outdenting a block keeps the run it introduced: the siblings
that followed it become its last children. Backspace at the start of a block
joins it to the line above, which may be a descendant of the previous sibling. Drag shows a destination seam before
committing; keyboard movement follows the same ordering rules.
Touch swipes retain native scrolling and text selection; structural range and
bullet dragging belong to mouse or pen gestures.

Compact outlines use one touch target in the gutter: a visible fold control for
parents and a block-actions mark for leaves. While writing, an accessory above
the keyboard provides Outdent, Indent, Block actions, and Done. Structural actions
preserve the native caret; Done saves the draft and returns to reading and global
navigation. These controls use the same outline actions and editing session as
keyboard input. Narrower indentation preserves room for nested writing.

## Beginning and Continuing

An empty document offers a visible writing action and a short command and link
hint on the first block's text axis. Both disappear when writing begins. The
region below the final block remains a generous, clickable append surface with a
bullet revealed by pointer or keyboard intent.

Today's journal is followed by its standing answers. Linked references follow
the writing and answers as a collapsible section with source navigation; empty
references add no chrome.

The journal is continuous: below the day on screen, every earlier day that has
writing follows as its own editable outline, newest first, under a date title
at the same scale and its distance from today. Days load as the reader scrolls
toward them; empty days are skipped. A day's title opens it as the day on
screen. A scroll reserve lets the last content sit at a
comfortable height and limits jumps when trailing sections collapse.

## Markdown and Stable Interaction

Markdown is a reading projection of its source, never a second editable object.
Pressing prose restores the corresponding source position; links have an explicit
navigation action. The projection holds the row's tab stop until editing begins.
Headings use type hierarchy, code uses a quiet inset surface, and wide tables scroll
inside their block. Raw HTML and remote images do not render. Query cells retain
phrasing-only content within their own edit or open control.

Stable block identity preserves focus, selection, contextual targets, and branches
through refreshes and virtualization. Native editors remeasure wrapping without
replacing their input node or selection. Only focus arrival may request a
visibility scroll; later measurements cannot pull the reader back. Ordinary rows
are fully revealed, while rows taller than the viewport retain their visible
reading position. History uses this same visibility policy. Offscreen arrivals
scroll smoothly unless reduced motion is requested. A pointer press retains the
outgoing source's layout until its click is resolved, so wrapping cannot move the
destination out from under the pointer.

Shared semantics follow [Accessibility](accessibility.md), and control behavior
follows [Interaction](interaction.md).
