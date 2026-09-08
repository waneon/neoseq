# Outliner Design Architecture

## Document and Writing Hierarchy

The outliner is the primary writing surface. A document header establishes the
place with a small Page or Journal label, persistent actions, and a large title.
A fine divider separates document identity from its content. Titles wrap across
the full measure; journal navigation lives above the date on desktop and below it
on mobile so controls never compete with it for writing space. Compact titles use a smaller scale and preserve
word boundaries. An empty metadata strip exposes a quiet Properties action in the
toolbar; existing properties provide their own direct editing controls below.

The document is a comfortable reading column with enough width for nested work.
Page metadata and managed queries use the page edge; block text sits inside a
hanging bullet gutter. The title remains larger than every Markdown heading.
Body writing uses the shared 16px type and 28px line rhythm.

Journal navigation provides previous day, calendar, next day, and a visible Today
cue. On another date, Today returns to the current journal. Calendar text is a
draft until submitted; selecting a day navigates directly. Cancellation preserves
the current day. Navigation restores the initiating control after its destination
arrives, including newly created journal pages.

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
undoable intent. Drag shows a destination seam before committing; keyboard
movement follows the same ordering rules.
Touch swipes retain native scrolling and text selection; structural range and
bullet dragging belong to mouse or pen gestures.

Compact outlines use one touch target in the gutter: a visible fold control for
parents and a block-actions mark for leaves. While writing, an accessory above
the keyboard provides Outdent, Indent, Block actions, and Done. Structural actions
preserve the native caret; Done saves the draft and returns to reading and global
navigation. These controls use the same outline actions and editing session as
keyboard input. Narrower indentation preserves room for nested writing.

## Beginning and Continuing

An empty document offers a visible writing action and a small command and page
link hint on the same text axis as the first block. Both disappear when writing
begins. The region below the final block remains a generous, clickable append
surface with a bullet revealed by pointer or keyboard intent.

Standing queries follow that append reach on today's journal. Linked references
follow the writing and queries as a collapsible section with source navigation.
Empty references add no chrome. A scroll reserve lets the last content sit at a
comfortable reading height and limits jumps when trailing sections collapse.

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
